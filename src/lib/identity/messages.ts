import {
  Aes128Gcm,
  CipherSuite,
  DhkemP256HkdfSha256,
  HkdfSha256,
} from '@hpke/core';
import {
  decode,
  digest,
  encode,
  fields,
  parse,
  portable,
  random,
  text,
  utf8,
} from './encoding';
import {
  encryptTimedKey,
  decryptTimedKey,
  roundForTime,
  timeForRound,
  validateTimedKey,
} from '../timelock';

export const suite = new CipherSuite({
  kem: new DhkemP256HkdfSha256(),
  kdf: new HkdfSha256(),
  aead: new Aes128Gcm(),
});
export const ALGORITHM = 'P256-SHA256-A128GCM-Auth';
export type Contact = {
  v: 1;
  a: typeof ALGORITHM;
  n: string;
  k: string;
  id: string;
};
export type Identity = { contact: Contact; privateKey: CryptoKey | null };
export type Message = {
  v: 1;
  a: typeof ALGORITHM;
  r: string;
  s: string;
  m: string;
  t: number | null;
  e: string;
  c: string;
};
export async function generateIdentity(name: string): Promise<Identity> {
  if (utf8.encode(name).length > 80)
    throw new Error('Display name must be at most 80 UTF-8 bytes.');
  const pair = await suite.kem.generateKeyPair();
  const raw = new Uint8Array(
    await suite.kem.serializePublicKey(pair.publicKey),
  );
  return {
    contact: {
      v: 1,
      a: ALGORITHM,
      n: name,
      k: encode(raw),
      id: await digest(raw),
    },
    privateKey: pair.privateKey,
  };
}
export const contactText = (contact: Contact) => portable('ec1.', contact);
export const CONTACT_CARD_LIMIT = 800;
export async function parseContact(input: string): Promise<Contact> {
  const v = parse('ec1.', input, CONTACT_CARD_LIMIT);
  fields(v, ['v', 'a', 'n', 'k', 'id']);
  if (
    v.v !== 1 ||
    v.a !== ALGORITHM ||
    typeof v.n !== 'string' ||
    utf8.encode(v.n).length > 80
  )
    throw new Error('Unsupported contact.');
  const key = decode(v.k, 65);
  decode(v.id, 32);
  if ((await digest(key)) !== v.id)
    throw new Error('Contact fingerprint mismatch.');
  await suite.kem.deserializePublicKey(key);
  return v as Contact;
}
export function parseMessage(input: string): Message {
  return parseEnvelope(input, 'message');
}

const envelopePrefix = { message: 'em1.', 'live-signal': 'el1.' } as const;
type EnvelopePurpose = keyof typeof envelopePrefix;

function parseEnvelope(input: string, purpose: EnvelopePurpose): Message {
  const v = parse(envelopePrefix[purpose], input, 31000);
  fields(v, ['v', 'a', 'r', 's', 'm', 't', 'e', 'c']);
  if (v.v !== 1 || v.a !== ALGORITHM) throw new Error('Unsupported message.');
  decode(v.r, 32);
  decode(v.s, 32);
  decode(v.m, 16);
  decode(v.e, 65);
  if (purpose === 'live-signal' && v.t !== null)
    throw new Error('Invalid live chat code.');
  if (v.t !== null) timeForRound(v.t);
  const c = decode(v.c);
  if (c.length < 17 || c.length > 16016)
    throw new Error('Invalid message size.');
  return v as Message;
}
function header(m: Omit<Message, 'c' | 'e'>, purpose: EnvelopePurpose) {
  return utf8.encode(
    JSON.stringify([`encrypt-this/${purpose}`, m.v, m.a, m.r, m.s, m.m, m.t]),
  );
}
export async function encryptMessage(
  identity: Identity,
  recipient: Contact,
  content: string,
  openingTime?: number,
): Promise<string> {
  return (await createMessage(identity, recipient, content, openingTime))
    .payload;
}

export async function createMessage(
  identity: Identity,
  recipient: Contact,
  content: string,
  openingTime?: number,
): Promise<{ id: string; round: number | null; payload: string }> {
  return sealEnvelope(identity, recipient, content, 'message', openingTime);
}

export async function sealLiveSignal(
  identity: Identity,
  contact: Contact,
  content: string,
): Promise<string> {
  return (await sealEnvelope(identity, contact, content, 'live-signal'))
    .payload;
}

async function sealEnvelope(
  identity: Identity,
  recipient: Contact,
  content: string,
  purpose: EnvelopePurpose,
  openingTime?: number,
): Promise<{ id: string; round: number | null; payload: string }> {
  const privateKey = identity.privateKey;
  if (!privateKey) throw new Error('Identity is locked.');
  const bytes = utf8.encode(content);
  if (!content.trim() || bytes.length > 16000)
    throw new Error('Write a message of at most 16 KB.');
  const m: Omit<Message, 'c' | 'e'> = {
    v: 1,
    a: ALGORITHM,
    r: recipient.id,
    s: identity.contact.id,
    m: encode(random(16)),
    t: openingTime === undefined ? null : roundForTime(openingTime),
  };
  try {
    const aad = header(m, purpose);
    const ctx = await suite.createSenderContext({
      recipientPublicKey: await suite.kem.deserializePublicKey(
        decode(recipient.k, 65),
      ),
      senderKey: privateKey,
      info: aad,
    });
    const encrypted = portable(envelopePrefix[purpose], {
      ...m,
      e: encode(ctx.enc),
      c: encode(await ctx.seal(bytes, aad)),
    });
    const payload =
      m.t === null
        ? encrypted
        : portable('et1.', {
            v: 1,
            t: m.t,
            k: await encryptTimedKey(utf8.encode(encrypted), m.t),
          });
    return { id: m.m, round: m.t, payload };
  } finally {
    bytes.fill(0);
  }
}
export function timedEnvelope(input: string): { v: 1; t: number; k: string } {
  const value = parse('et1.', input, 85000);
  fields(value, ['v', 't', 'k']);
  if (value.v !== 1 || typeof value.k !== 'string')
    throw new Error('Unsupported timed message.');
  timeForRound(value.t);
  validateTimedKey(value.k, value.t, 62000);
  return value as { v: 1; t: number; k: string };
}
export async function unwrapMessage(input: string): Promise<string> {
  if (!input.trim().split('#').at(-1)!.startsWith('et1.')) {
    parseMessage(input);
    return input;
  }
  const envelope = timedEnvelope(input);
  const bytes = await decryptTimedKey(envelope.k, envelope.t, undefined, 62000);
  try {
    const inner = text.decode(bytes);
    if (parseMessage(inner).t !== envelope.t)
      throw new Error('Opening date mismatch.');
    return inner;
  } finally {
    bytes.fill(0);
  }
}
export async function decryptMessage(
  identity: Identity,
  sender: Contact,
  input: string,
): Promise<string> {
  return openEnvelope(
    identity,
    sender,
    parseMessage(await unwrapMessage(input)),
    'message',
  );
}

export function openLiveSignal(
  identity: Identity,
  sender: Contact,
  input: string,
): Promise<string> {
  const value = input.trim();
  if (value.includes('#'))
    throw new Error('Paste the live chat code from your contact.');
  return openEnvelope(
    identity,
    sender,
    parseEnvelope(value, 'live-signal'),
    'live-signal',
  );
}

async function openEnvelope(
  identity: Identity,
  sender: Contact,
  m: Message,
  purpose: EnvelopePurpose,
): Promise<string> {
  const privateKey = identity.privateKey;
  if (!privateKey) throw new Error('Identity is locked.');
  if (m.r !== identity.contact.id || m.s !== sender.id)
    throw new Error(
      'Wrong recipient or unknown sender. Import and review the sender contact separately.',
    );
  try {
    const aad = header(m, purpose);
    const ctx = await suite.createRecipientContext({
      recipientKey: privateKey,
      senderPublicKey: await suite.kem.deserializePublicKey(
        decode(sender.k, 65),
      ),
      enc: decode(m.e, 65),
      info: aad,
    });
    const bytes = new Uint8Array(await ctx.open(decode(m.c), aad));
    try {
      return text.decode(bytes);
    } finally {
      bytes.fill(0);
    }
  } catch {
    throw new Error('Message authentication failed. No message was opened.');
  }
}
