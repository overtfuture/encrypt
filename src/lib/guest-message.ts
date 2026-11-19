import {
  decode,
  encode,
  payload,
  random,
  text,
  utf8,
} from './identity/encoding';
import {
  CONTACT_CARD_LIMIT,
  contactText,
  parseContact,
  type Contact,
} from './identity/messages';

const MESSAGE_PREFIX = 'eg1.';
const CONTACT_PREFIX = 'eg2.';
export const GUEST_MESSAGE_LIMIT = 5_000;
const KEY_BYTES = 16;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const FRAGMENT_OVERHEAD =
  MESSAGE_PREFIX.length +
  2 +
  Math.ceil((IV_BYTES * 4) / 3) +
  Math.ceil((KEY_BYTES * 4) / 3);
const formats = {
  [MESSAGE_PREFIX]: {
    context: utf8.encode('encrypt-this/guest-message/v1'),
    maxBytes: GUEST_MESSAGE_LIMIT,
  },
  [CONTACT_PREFIX]: {
    context: utf8.encode('encrypt-this/guest-message/v2'),
    maxBytes: CONTACT_CARD_LIMIT + 1 + GUEST_MESSAGE_LIMIT,
  },
};
type GuestPrefix = keyof typeof formats;

type GuestEnvelope = {
  prefix: GuestPrefix;
  iv: Uint8Array<ArrayBuffer>;
  ciphertext: Uint8Array<ArrayBuffer>;
  code?: string;
};
type GuestContents = { message: string; contact?: Contact };

export function guestPrefix(fragment: string): GuestPrefix | undefined {
  const prefix = fragment.slice(0, MESSAGE_PREFIX.length);
  if (prefix === MESSAGE_PREFIX || prefix === CONTACT_PREFIX) return prefix;
}

export function validateGuestUnlockCode(value: string): void {
  decode(value, KEY_BYTES).fill(0);
}

export async function sealGuestMessage(message: string, contact?: Contact) {
  const note = message.trim() ? message : '';
  if (!note && !contact)
    throw new Error('Write a message or include your contact.');
  const prefix = contact ? CONTACT_PREFIX : MESSAGE_PREFIX;
  const card = contact ? contactText(contact) + '\n' : '';
  const body = utf8.encode(card + note);
  if (body.length - card.length > GUEST_MESSAGE_LIMIT)
    throw new Error('Write a message of at most 5,000 UTF-8 bytes.');
  if (card.length > CONTACT_CARD_LIMIT + 1)
    throw new Error('Contact card is too large to share.');

  const rawKey = random(KEY_BYTES);
  try {
    const iv = random(IV_BYTES);
    const key = await crypto.subtle.importKey('raw', rawKey, 'AES-GCM', false, [
      'encrypt',
    ]);
    const ciphertext = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: formats[prefix].context },
      key,
      body,
    );
    return {
      fragment: `${prefix}${encode(iv)}.${encode(ciphertext)}`,
      code: encode(rawKey),
    };
  } finally {
    rawKey.fill(0);
    body.fill(0);
  }
}

export function parseGuestMessage(input: string): GuestEnvelope {
  const value = payload(input);
  const prefix = guestPrefix(value);
  if (!prefix) throw new Error('Invalid guest message link.');
  const maxCiphertext = formats[prefix].maxBytes + TAG_BYTES;
  if (value.length > Math.ceil((maxCiphertext * 4) / 3) + FRAGMENT_OVERHEAD)
    throw new Error('Invalid guest message link.');
  const [encodedIv, encodedBody, code, extra] = value
    .slice(prefix.length)
    .split('.');
  if (extra !== undefined) throw new Error('Invalid guest message link.');
  const iv = decode(encodedIv, IV_BYTES);
  const ciphertext = decode(encodedBody);
  if (ciphertext.length <= TAG_BYTES || ciphertext.length > maxCiphertext)
    throw new Error('Invalid guest message length.');
  if (code !== undefined) validateGuestUnlockCode(code);
  return { prefix, iv, ciphertext, code };
}

export async function openGuestMessage(
  envelope: GuestEnvelope,
  code: string,
): Promise<GuestContents> {
  const rawKey = decode(code.trim(), KEY_BYTES);
  try {
    const key = await crypto.subtle.importKey('raw', rawKey, 'AES-GCM', false, [
      'decrypt',
    ]);
    const body = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: envelope.iv,
        additionalData: formats[envelope.prefix].context,
      },
      key,
      envelope.ciphertext,
    );
    try {
      const contents = text.decode(body);
      if (envelope.prefix === MESSAGE_PREFIX) return { message: contents };
      // The first line is an ASCII contact card. The rest is the optional note.
      const separator = contents.indexOf('\n');
      const card = contents.slice(0, separator);
      if (
        separator < 0 ||
        !/^ec1\.[\w-]+$/.test(card) ||
        body.byteLength - separator - 1 > GUEST_MESSAGE_LIMIT
      )
        throw new Error('Invalid guest contact.');
      return {
        contact: await parseContact(card),
        message: contents.slice(separator + 1),
      };
    } finally {
      new Uint8Array(body).fill(0);
    }
  } finally {
    rawKey.fill(0);
  }
}
