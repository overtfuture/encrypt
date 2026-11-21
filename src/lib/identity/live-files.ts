import { decode, encode, random, text, utf8 } from './encoding';
import { suite, type Contact, type Identity } from './messages';

export const FILE_CHANNEL = 'encrypt-this/files/v1';
export const MAX_LIVE_FILE_BYTES = 10_000_000;
const CHUNK_BYTES = 12 * 1024;
const TRANSFER_TIMEOUT = 120_000;
const MAX_NAME_BYTES = 720;
const ENCAPSULATED_KEY_BYTES = 65;
const ENVELOPE_OVERHEAD = ENCAPSULATED_KEY_BYTES + 16 + 2;

export type LiveFile = { name: string; bytes: Uint8Array<ArrayBuffer> };

function safeName(name: string) {
  return (
    name
      .replace(/[\x00-\x1f\x7f/\\\u202a-\u202e\u2066-\u2069]/gu, '_')
      .trim()
      .slice(0, 180) || 'attachment'
  );
}

function fileContext(
  session: string,
  id: string,
  sender: Contact,
  recipient: Contact,
) {
  return utf8.encode(
    JSON.stringify([FILE_CHANNEL, session, id, sender.id, recipient.id]),
  );
}

async function sealFile(
  identity: Identity,
  recipient: Contact,
  info: Uint8Array<ArrayBuffer>,
  file: LiveFile,
) {
  if (!identity.privateKey) throw new Error('Profile is locked.');
  const name = utf8.encode(file.name);
  const plain = new Uint8Array(2 + name.length + file.bytes.length);
  new DataView(plain.buffer).setUint16(0, name.length);
  plain.set(name, 2);
  plain.set(file.bytes, 2 + name.length);
  try {
    const context = await suite.createSenderContext({
      recipientPublicKey: await suite.kem.deserializePublicKey(
        decode(recipient.k, 65),
      ),
      senderKey: identity.privateKey,
      info,
    });
    const ciphertext = new Uint8Array(await context.seal(plain, info));
    const envelope = new Uint8Array(ENCAPSULATED_KEY_BYTES + ciphertext.length);
    envelope.set(new Uint8Array(context.enc));
    envelope.set(ciphertext, ENCAPSULATED_KEY_BYTES);
    return envelope;
  } finally {
    plain.fill(0);
  }
}

async function openFile(
  identity: Identity,
  sender: Contact,
  info: Uint8Array<ArrayBuffer>,
  envelope: Uint8Array<ArrayBuffer>,
): Promise<LiveFile> {
  if (!identity.privateKey) throw new Error('Profile is locked.');
  const context = await suite.createRecipientContext({
    recipientKey: identity.privateKey,
    senderPublicKey: await suite.kem.deserializePublicKey(decode(sender.k, 65)),
    enc: envelope.subarray(0, ENCAPSULATED_KEY_BYTES),
    info,
  });
  const plain = new Uint8Array(
    await context.open(envelope.subarray(ENCAPSULATED_KEY_BYTES), info),
  );
  try {
    const nameLength = new DataView(plain.buffer).getUint16(0);
    const start = 2 + nameLength;
    if (
      nameLength === 0 ||
      nameLength > MAX_NAME_BYTES ||
      plain.length <= start ||
      plain.length - start > MAX_LIVE_FILE_BYTES
    )
      throw new Error('Invalid attachment.');
    return {
      name: safeName(text.decode(plain.subarray(2, start))),
      bytes: plain.slice(start),
    };
  } finally {
    plain.fill(0);
  }
}

function waitForBuffer(channel: RTCDataChannel, signal: AbortSignal) {
  signal.throwIfAborted();
  if (channel.bufferedAmount <= channel.bufferedAmountLowThreshold) return;
  return new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      channel.removeEventListener('bufferedamountlow', ready);
      signal.removeEventListener('abort', abort);
    };
    const ready = () => {
      cleanup();
      resolve();
    };
    const abort = () => {
      cleanup();
      reject(signal.reason);
    };
    channel.addEventListener('bufferedamountlow', ready);
    signal.addEventListener('abort', abort, { once: true });
    if (channel.bufferedAmount <= channel.bufferedAmountLowThreshold) ready();
  });
}

export function bindLiveFiles(
  channel: RTCDataChannel,
  options: {
    identity: Identity;
    contact: Contact;
    session: string;
    ready: (value: boolean) => void;
    receive: (file: LiveFile) => void;
    issue: (message: string) => void;
  },
) {
  const { identity, contact, session } = options;
  const lifetime = new AbortController();
  const { signal } = lifetime;
  let peerReady = false;
  let incoming:
    | {
        id: string;
        bytes: Uint8Array<ArrayBuffer>;
        offset: number;
        timer: ReturnType<typeof setTimeout>;
      }
    | undefined;
  let receipt: { id: string; resolve: (success: boolean) => void } | undefined;
  let sending = false;
  channel.binaryType = 'arraybuffer';
  channel.bufferedAmountLowThreshold = CHUNK_BYTES * 4;

  function stop(message?: string) {
    if (signal.aborted) return;
    lifetime.abort();
    clearTimeout(incoming?.timer);
    incoming = undefined;
    options.ready(false);
    channel.close();
    if (message) options.issue(message);
  }

  function sendControl(value: string) {
    try {
      channel.send(value);
    } catch {
      stop('The live file connection closed. Reconnect to send attachments.');
    }
  }

  function opened() {
    sendControl('file-ready-v1');
    if (peerReady && !signal.aborted) options.ready(true);
  }

  async function receiveFile(transfer: NonNullable<typeof incoming>) {
    try {
      const info = fileContext(session, transfer.id, contact, identity.contact);
      const file = await openFile(identity, contact, info, transfer.bytes);
      if (signal.aborted) {
        file.bytes.fill(0);
        return;
      }
      options.receive(file);
      sendControl(`file-ok.${transfer.id}`);
    } catch {
      if (!signal.aborted) {
        options.issue(
          'A live attachment could not be authenticated or opened.',
        );
        sendControl(`file-rejected.${transfer.id}`);
      }
    } finally {
      clearTimeout(transfer.timer);
      incoming = undefined;
    }
  }

  function receive(event: MessageEvent<unknown>) {
    const value = event.data;
    if (value === 'file-ready-v1') {
      peerReady = true;
      if (channel.readyState === 'open') options.ready(true);
      return;
    }
    if (peerReady && typeof value === 'string' && value.length <= 60) {
      const ack = /^file-(ok|rejected)\.([\w-]{22})$/.exec(value);
      if (ack && receipt?.id === ack[2]) {
        receipt.resolve(ack[1] === 'ok');
        return;
      }
      const start = /^file-start\.([\w-]{22})\.([0-9]{2,8})$/.exec(value);
      if (start && !incoming) {
        const size = Number(start[2]);
        if (
          size > ENVELOPE_OVERHEAD + 1 &&
          size <= MAX_LIVE_FILE_BYTES + MAX_NAME_BYTES + ENVELOPE_OVERHEAD
        ) {
          incoming = {
            id: start[1],
            bytes: new Uint8Array(size),
            offset: 0,
            timer: setTimeout(
              () =>
                stop('A live attachment timed out. Reconnect to try again.'),
              TRANSFER_TIMEOUT,
            ),
          };
          return;
        }
      }
    }
    if (incoming && value instanceof ArrayBuffer) {
      const remaining = incoming.bytes.length - incoming.offset;
      if (
        remaining > 0 &&
        value.byteLength === Math.min(CHUNK_BYTES, remaining)
      ) {
        incoming.bytes.set(new Uint8Array(value), incoming.offset);
        incoming.offset += value.byteLength;
        if (incoming.offset === incoming.bytes.length)
          void receiveFile(incoming);
        return;
      }
    }
    stop('The file connection received unsupported data and was closed.');
  }

  channel.addEventListener('open', opened, { signal });
  channel.addEventListener('message', receive, { signal });
  channel.addEventListener('close', () => stop(), { signal });
  channel.addEventListener(
    'error',
    () => stop('The live file connection stopped.'),
    { signal },
  );
  if (channel.readyState === 'open') opened();

  return {
    stop,
    async send(source: File): Promise<LiveFile> {
      if (!peerReady || signal.aborted || channel.readyState !== 'open')
        throw new Error('Connect to your contact to send a live attachment.');
      if (sending)
        throw new Error('Wait for the current attachment to finish.');
      if (!source.size || source.size > MAX_LIVE_FILE_BYTES)
        throw new Error('Choose a file between 1 byte and 10 MB.');

      sending = true;
      const id = encode(random(16));
      const deadline = AbortSignal.any([
        signal,
        AbortSignal.timeout(TRANSFER_TIMEOUT),
      ]);
      let started = false;
      let file: LiveFile | undefined;
      try {
        file = {
          name: safeName(source.name),
          bytes: new Uint8Array(await source.arrayBuffer()),
        };
        const envelope = await sealFile(
          identity,
          contact,
          fileContext(session, id, identity.contact, contact),
          file,
        );
        deadline.throwIfAborted();
        const acknowledged = new Promise<boolean>((resolve) => {
          receipt = { id, resolve };
          deadline.addEventListener('abort', () => resolve(false), {
            once: true,
          });
        });
        channel.send(`file-start.${id}.${envelope.length}`);
        started = true;
        for (let offset = 0; offset < envelope.length; offset += CHUNK_BYTES) {
          await waitForBuffer(channel, deadline);
          deadline.throwIfAborted();
          channel.send(envelope.subarray(offset, offset + CHUNK_BYTES));
        }
        if (!(await acknowledged))
          throw new Error(
            'Your contact did not confirm receiving the attachment.',
          );
        return file;
      } catch (error) {
        const interrupted = deadline.aborted;
        file?.bytes.fill(0);
        if (started) stop();
        if (interrupted)
          throw new Error(
            'The attachment was interrupted. Reconnect to try again.',
          );
        throw error;
      } finally {
        receipt = undefined;
        sending = false;
      }
    },
  };
}
