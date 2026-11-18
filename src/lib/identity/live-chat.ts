import { decode, encode, fields, random, utf8 } from './encoding';
import {
  openLiveSignal,
  sealLiveSignal,
  type Contact,
  type Identity,
} from './messages';

const CHANNEL = 'encrypt-this/chat/v1';
const INVITE_TTL = 5 * 60 * 1000;
const CLOCK_SKEW = 60 * 1000;
const CONNECT_TIMEOUT = 30 * 1000;
const ICE_TIMEOUT = 12 * 1000;
const MAX_CODE_LENGTH = 31000;
const MAX_BUFFERED_BYTES = 512 * 1024;
const MAX_QUEUED_MESSAGES = 32;

type Signal = {
  v: 1;
  id: string;
  type: 'offer' | 'answer';
  expires: number;
  sdp: string;
};

export type LiveState = {
  contact: string;
  phase:
    | 'preparing'
    | 'invite'
    | 'reply'
    | 'connecting'
    | 'connected'
    | 'reconnecting';
  code?: string;
};

type Connection = {
  peer: RTCPeerConnection;
  contact: Contact;
  id: string;
  expires: number;
  cancel: AbortController;
  channel?: RTCDataChannel;
  timer?: ReturnType<typeof setTimeout>;
  phase: LiveState['phase'];
  sessionToken: number;
  incoming: string[];
  receiving: boolean;
  drainOnClose: boolean;
};

function requireDataSdp(sdp: string) {
  const media = sdp.split(/\r?\n/).filter((line) => line.startsWith('m='));
  if (media.length !== 1 || !media[0].startsWith('m=application '))
    throw new Error('The code must describe a text-only live chat.');
}

function checkExpiry(expires: number) {
  const now = Date.now();
  if (!Number.isSafeInteger(expires) || expires > now + INVITE_TTL + CLOCK_SKEW)
    throw new Error('The code has an invalid time. Check the device clocks.');
  if (expires <= now)
    throw new Error('This live chat invite expired. Create a fresh invite.');
}

async function readSignal(
  identity: Identity,
  contact: Contact,
  code: string,
): Promise<Signal> {
  const body = await openLiveSignal(identity, contact, code);
  const value: unknown = JSON.parse(body);
  fields(value, ['v', 'id', 'type', 'expires', 'sdp']);
  if (
    value.v !== 1 ||
    (value.type !== 'offer' && value.type !== 'answer') ||
    typeof value.sdp !== 'string'
  )
    throw new Error('Invalid live chat code.');
  decode(value.id, 16);
  checkExpiry(value.expires);
  requireDataSdp(value.sdp);
  return value as Signal;
}

function waitForIce(
  peer: RTCPeerConnection,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted();
  if (peer.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      peer.removeEventListener('icegatheringstatechange', check);
    };
    const check = () => {
      if (peer.iceGatheringState !== 'complete') return;
      cleanup();
      resolve();
    };
    const abort = () => {
      cleanup();
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(
        new Error(
          'The browser took too long to gather direct network addresses. Try creating a new invite.',
        ),
      );
    }, ICE_TIMEOUT);
    peer.addEventListener('icegatheringstatechange', check);
    signal.addEventListener('abort', abort, { once: true });
    check();
  });
}

export function createLiveChat(options: {
  sessionToken: () => number;
  state: (value: LiveState | undefined) => void;
  status: (message: string) => void;
  issue: (message: string) => void;
  receive: (
    contact: Contact,
    payload: string,
    active: () => boolean,
  ) => Promise<void>;
}) {
  let current: Connection | undefined;
  const usedInvites = new Map<string, number>();

  function update(
    connection: Connection,
    phase: LiveState['phase'],
    code?: string,
  ) {
    if (current !== connection) return;
    connection.phase = phase;
    options.state({ contact: connection.contact.id, phase, code });
  }

  function stop(drainReceived = false) {
    const connection = current;
    if (!connection) return;
    current = undefined;
    clearTimeout(connection.timer);
    connection.cancel.abort();
    connection.drainOnClose = drainReceived;
    if (!drainReceived) connection.incoming.length = 0;
    connection.channel?.close();
    connection.peer.close();
    options.state(undefined);
  }

  function fail(connection: Connection, message: string) {
    if (current !== connection) return;
    stop();
    options.issue(message);
  }

  function arm(connection: Connection, delay: number, message: string) {
    clearTimeout(connection.timer);
    connection.timer = setTimeout(
      () => fail(connection, message),
      Math.max(0, delay),
    );
  }

  async function drain(connection: Connection) {
    if (connection.receiving) return;
    connection.receiving = true;
    const active = () =>
      options.sessionToken() === connection.sessionToken &&
      (current === connection || connection.drainOnClose);
    try {
      while (active() && connection.incoming.length) {
        await options.receive(
          connection.contact,
          connection.incoming.shift()!,
          active,
        );
      }
    } catch (cause) {
      if (active())
        options.issue(
          cause instanceof Error
            ? cause.message
            : 'A live message could not be opened.',
        );
      // Continue processing subsequent frames after a single failed message.
    } finally {
      connection.receiving = false;
      if (!active()) connection.incoming.length = 0;
      else if (connection.incoming.length) void drain(connection);
    }
  }

  function bind(connection: Connection, channel: RTCDataChannel) {
    if (
      current !== connection ||
      connection.channel ||
      channel.label !== CHANNEL
    ) {
      channel.close();
      return;
    }
    connection.channel = channel;
    const opened = () => {
      if (current !== connection) return;
      clearTimeout(connection.timer);
      update(connection, 'connected');
    };
    channel.addEventListener('open', opened);
    if (channel.readyState === 'open') opened();
    channel.addEventListener('close', () => {
      if (current !== connection) return;
      stop(true);
      options.status('Live chat ended.');
    });
    channel.addEventListener('error', () =>
      fail(
        connection,
        'The live connection stopped. You can share an encrypted link instead.',
      ),
    );
    channel.addEventListener('message', (event: MessageEvent<unknown>) => {
      if (current !== connection) return;
      const value = event.data;
      if (
        typeof value !== 'string' ||
        value.length > MAX_CODE_LENGTH ||
        !/^em1\.[\w-]+$/.test(value) ||
        connection.incoming.length >= MAX_QUEUED_MESSAGES
      ) {
        fail(
          connection,
          'The live chat received unsupported data and was closed.',
        );
        return;
      }
      connection.incoming.push(value);
      void drain(connection);
    });
  }

  function begin(contact: Contact, id: string, expires: number): Connection {
    if (current)
      throw new Error('End the current live chat before starting another.');
    if (typeof RTCPeerConnection !== 'function')
      throw new Error('This browser does not support live chat.');
    const peer = new RTCPeerConnection({ iceServers: [] });
    const connection: Connection = {
      peer,
      contact,
      id,
      expires,
      cancel: new AbortController(),
      phase: 'preparing',
      sessionToken: options.sessionToken(),
      incoming: [],
      receiving: false,
      drainOnClose: false,
    };
    current = connection;
    update(connection, 'preparing');
    arm(
      connection,
      expires - Date.now(),
      'This live chat invite expired. Create a fresh invite.',
    );
    peer.addEventListener('connectionstatechange', () => {
      if (current !== connection) return;
      if (
        peer.connectionState === 'disconnected' &&
        connection.phase === 'connected'
      ) {
        update(connection, 'reconnecting');
        arm(
          connection,
          CONNECT_TIMEOUT,
          'The direct connection was lost. You can share an encrypted link instead.',
        );
      } else if (
        peer.connectionState === 'connected' &&
        connection.phase === 'reconnecting'
      ) {
        clearTimeout(connection.timer);
        update(connection, 'connected');
      } else if (peer.connectionState === 'failed')
        fail(
          connection,
          'A direct connection could not be made. Try the same network or share an encrypted link.',
        );
      else if (peer.connectionState === 'closed' && current === connection) {
        stop(true);
        options.status('Live chat ended.');
      }
    });
    return connection;
  }

  async function localCode(
    connection: Connection,
    identity: Identity,
    type: Signal['type'],
  ) {
    const { peer, contact, id, expires, cancel } = connection;
    const description =
      type === 'offer' ? await peer.createOffer() : await peer.createAnswer();
    cancel.signal.throwIfAborted();
    await peer.setLocalDescription(description);
    await waitForIce(peer, cancel.signal);
    const sdp = peer.localDescription?.sdp;
    if (!sdp || !/^a=candidate:/m.test(sdp))
      throw new Error(
        'This browser did not find a direct network address. Try a regular browser window on the same network.',
      );
    const data: Signal = { v: 1, id, type, expires, sdp };
    const body = JSON.stringify(data);
    if (utf8.encode(body).length > 16000)
      throw new Error(
        'The browser generated a live chat code that is too large.',
      );
    return sealLiveSignal(identity, contact, body);
  }

  return {
    async invite(identity: Identity, contact: Contact, signal: AbortSignal) {
      signal.throwIfAborted();
      const connection = begin(
        contact,
        encode(random(16)),
        Date.now() + INVITE_TTL,
      );
      try {
        bind(
          connection,
          connection.peer.createDataChannel(CHANNEL, { ordered: true }),
        );
        const code = await localCode(connection, identity, 'offer');
        if (connection.phase !== 'connected')
          update(connection, 'invite', code);
      } catch (error) {
        if (current === connection) stop();
        throw error;
      }
    },
    async join(
      identity: Identity,
      contact: Contact,
      input: string,
      signal: AbortSignal,
    ) {
      const offer = await readSignal(identity, contact, input);
      if (offer.type !== 'offer')
        throw new Error('Paste the invite code from your contact.');
      signal.throwIfAborted();
      const now = Date.now();
      for (const [key, expiry] of usedInvites) {
        if (expiry <= now) usedInvites.delete(key);
      }
      const inviteKey = [identity.contact.id, contact.id, offer.id].join('.');
      if (usedInvites.has(inviteKey))
        throw new Error(
          'This invite was already used in this tab. Ask for a fresh invite.',
        );
      const connection = begin(contact, offer.id, offer.expires);
      try {
        connection.peer.addEventListener('datachannel', (event) =>
          bind(connection, event.channel),
        );
        await connection.peer.setRemoteDescription({
          type: 'offer',
          sdp: offer.sdp,
        });
        connection.cancel.signal.throwIfAborted();
        const code = await localCode(connection, identity, 'answer');
        if (current === connection) usedInvites.set(inviteKey, offer.expires);
        if (connection.phase !== 'connected') update(connection, 'reply', code);
      } catch (error) {
        if (current === connection) stop();
        throw error;
      }
    },
    async connect(identity: Identity, input: string) {
      const connection = current;
      if (!connection || connection.phase !== 'invite')
        throw new Error('Create an invite before pasting a reply code.');
      const answer = await readSignal(identity, connection.contact, input);
      if (
        answer.type !== 'answer' ||
        answer.id !== connection.id ||
        answer.expires !== connection.expires
      )
        throw new Error('This reply does not match the open invite.');
      connection.cancel.signal.throwIfAborted();
      await connection.peer.setRemoteDescription({
        type: 'answer',
        sdp: answer.sdp,
      });
      if (current === connection && connection.phase === 'invite') {
        update(connection, 'connecting');
        arm(
          connection,
          CONNECT_TIMEOUT,
          'A direct connection could not be made. Try the same network or share an encrypted link.',
        );
      }
    },
    send(contact: string, value: string): boolean {
      const channel =
        current?.contact.id === contact && current.phase === 'connected'
          ? current.channel
          : undefined;
      if (
        !channel ||
        channel.readyState !== 'open' ||
        channel.bufferedAmount >= MAX_BUFFERED_BYTES
      )
        return false;
      try {
        channel.send(value);
        return true;
      } catch {
        return false;
      }
    },
    stop,
  };
}
