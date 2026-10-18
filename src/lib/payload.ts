import {
  decryptTimedKey,
  encryptTimedKey,
  roundForTime,
  timeForRound,
  TimelockUnavailableError,
  validateTimedKey,
} from './timelock';

type CommonPayload = {
  p: 0 | 1;
  c: string;
  i: string;
  k: string;
  s?: string;
  w?: string;
};

export type LegacyPayload = CommonPayload & { v: 1; u: number | null };
export type TimedPayload = CommonPayload & { v: 2; u: number; r: number };
export type Payload = LegacyPayload | TimedPayload;
type Header =
  | { v: 1; u: number | null; p: 0 | 1 }
  | { v: 2; u: number; p: 0 | 1; r: number };

export const MAX_MESSAGE_BYTES = 16_000;
const MAX_PAYLOAD_LENGTH = 40_000;
const PIN_ITERATIONS = 600_000;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

function encode(bytes: Uint8Array): string {
  return btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(''))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '');
}

function decode(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('Invalid encoding');
  return Uint8Array.from(
    atob(value.replaceAll('-', '+').replaceAll('_', '/')),
    (char) => char.charCodeAt(0),
  );
}

function validDate(date: unknown): date is number | null {
  return (
    date === null ||
    (typeof date === 'number' &&
      Number.isSafeInteger(date) &&
      date >= 0 &&
      date <= 8_640_000_000_000_000)
  );
}

// Public countdown metadata is authenticated; version 2 also encrypts the key
// to the corresponding drand round. Preserve the original v1 AAD byte-for-byte.
function metadata(payload: Header): Uint8Array<ArrayBuffer> {
  return encoder.encode(
    JSON.stringify({
      v: payload.v,
      u: payload.u,
      p: payload.p,
      ...(payload.v === 2 ? { r: payload.r } : {}),
    }),
  );
}

async function pinKey(
  pin: string,
  salt: Uint8Array<ArrayBuffer>,
): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    'raw',
    encoder.encode(pin),
    'PBKDF2',
    false,
    ['deriveKey'],
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: PIN_ITERATIONS, hash: 'SHA-256' },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

export async function sealMessage(
  text: string,
  options: { pin?: string; unlockAt?: number | null } = {},
): Promise<string> {
  if (!crypto.subtle)
    throw new Error('Please open this site over HTTPS to create a message.');
  if (!text.trim()) throw new Error('Write a message first.');
  const content = encoder.encode(text);
  if (content.length > MAX_MESSAGE_BYTES)
    throw new Error('This message is too long. Keep it under 16 KB.');
  const requested = options.unlockAt ?? null;
  if (!validDate(requested)) throw new Error('Choose a valid opening date.');
  const pin = options.pin ?? '';
  if (pin && !/^\d{4,12}$/.test(pin))
    throw new Error('Choose a PIN with 4–12 digits.');

  const p = (pin ? 1 : 0) as 0 | 1;
  const round = requested === null ? null : roundForTime(requested);
  const header: Header =
    round === null
      ? { v: 1, u: null, p }
      : { v: 2, u: timeForRound(round), p, r: round };
  const rawKey = crypto.getRandomValues(new Uint8Array(32));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  let protectedKey = rawKey;
  try {
    const key = await crypto.subtle.importKey('raw', rawKey, 'AES-GCM', false, [
      'encrypt',
    ]);
    const ciphertext = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: metadata(header) },
      key,
      content,
    );
    const payload: Payload = {
      ...header,
      c: encode(new Uint8Array(ciphertext)),
      i: encode(iv),
      k: '',
    };
    if (pin) {
      const salt = crypto.getRandomValues(new Uint8Array(16));
      const wrapIv = crypto.getRandomValues(new Uint8Array(12));
      const wrappingKey = await pinKey(pin, salt);
      protectedKey = new Uint8Array(
        await crypto.subtle.encrypt(
          { name: 'AES-GCM', iv: wrapIv, additionalData: metadata(header) },
          wrappingKey,
          rawKey,
        ),
      );
      payload.s = encode(salt);
      payload.w = encode(wrapIv);
    }
    payload.k =
      header.v === 2
        ? await encryptTimedKey(protectedKey, header.r)
        : encode(protectedKey);
    return encode(encoder.encode(JSON.stringify(payload)));
  } finally {
    rawKey.fill(0);
    protectedKey.fill(0);
  }
}

export function parsePayload(input: string): Payload {
  try {
    const trimmed = input.trim();
    if (!trimmed || trimmed.length > MAX_PAYLOAD_LENGTH + 2_000)
      throw new Error();
    const hash = trimmed.indexOf('#');
    const encoded = hash >= 0 ? trimmed.slice(hash + 1) : trimmed;
    if (encoded.length > MAX_PAYLOAD_LENGTH) throw new Error();
    const value = JSON.parse(decoder.decode(decode(encoded)));
    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      ![1, 2].includes(value.v) ||
      !validDate(value.u) ||
      ![0, 1].includes(value.p)
    )
      throw new Error();
    for (const field of ['c', 'i', 'k'])
      if (typeof value[field] !== 'string') throw new Error();
    const contentLength = decode(value.c).length;
    if (
      contentLength < 17 ||
      contentLength > MAX_MESSAGE_BYTES + 16 ||
      decode(value.i).length !== 12
    )
      throw new Error();
    if (value.p === 1) {
      if (
        typeof value.s !== 'string' ||
        typeof value.w !== 'string' ||
        decode(value.s).length !== 16 ||
        decode(value.w).length !== 12
      )
        throw new Error();
    } else if (value.s !== undefined || value.w !== undefined)
      throw new Error();
    if (value.v === 2) {
      if (typeof value.u !== 'number' || timeForRound(value.r) !== value.u)
        throw new Error();
      validateTimedKey(value.k, value.r);
    } else if (
      value.r !== undefined ||
      decode(value.k).length !== (value.p ? 48 : 32)
    )
      throw new Error();
    return {
      v: value.v,
      u: value.u,
      p: value.p,
      c: value.c,
      i: value.i,
      k: value.k,
      ...(value.v === 2 ? { r: value.r } : {}),
      ...(value.p ? { s: value.s, w: value.w } : {}),
    };
  } catch {
    throw new Error(
      'This is not a valid Afterword message. Paste the complete link or payload.',
    );
  }
}

export async function openMessage(
  payload: Payload,
  pin = '',
  now = Date.now(),
  options: { signal?: AbortSignal } = {},
): Promise<string> {
  if (!crypto.subtle)
    throw new Error('Please open this site over HTTPS to reveal a message.');
  if (payload.u !== null && now < payload.u)
    throw new Error('This message is not ready. Wait for its opening time.');
  if (payload.p && !pin) throw new Error('Enter the PIN to open this message.');
  let rawKey: Uint8Array<ArrayBuffer> | undefined;
  try {
    options.signal?.throwIfAborted();
    rawKey =
      payload.v === 2
        ? await decryptTimedKey(payload.k, payload.r, options.signal)
        : decode(payload.k);
    if (rawKey.length !== (payload.p ? 48 : 32))
      throw new Error('Invalid message key.');
    if (payload.p) {
      const wrappingKey = await pinKey(pin, decode(payload.s!));
      rawKey = new Uint8Array(
        await crypto.subtle.decrypt(
          {
            name: 'AES-GCM',
            iv: decode(payload.w!),
            additionalData: metadata(payload),
          },
          wrappingKey,
          rawKey,
        ),
      );
    }
    const key = await crypto.subtle.importKey('raw', rawKey, 'AES-GCM', false, [
      'decrypt',
    ]);
    const text = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: decode(payload.i),
        additionalData: metadata(payload),
      },
      key,
      decode(payload.c),
    );
    options.signal?.throwIfAborted();
    return decoder.decode(text);
  } catch (err) {
    options.signal?.throwIfAborted();
    if (err instanceof TimelockUnavailableError) throw err;
    throw new Error(
      payload.p
        ? 'That PIN did not work, or the message is damaged. Try again.'
        : 'This message is damaged and could not be opened.',
    );
  } finally {
    rawKey?.fill(0);
  }
}

export function shareLink(encoded: string, base: string): string {
  const url = new URL(base);
  url.search = '';
  url.hash = encoded;
  return url.toString();
}

export function countdown(
  unlockAt: number,
  now: number,
): { days: string; hours: string; minutes: string; seconds: string } {
  const remaining = Math.max(0, Math.ceil((unlockAt - now) / 1_000));
  const pad = (value: number) => String(value).padStart(2, '0');
  return {
    days: pad(Math.floor(remaining / 86_400)),
    hours: pad(Math.floor(remaining / 3_600) % 24),
    minutes: pad(Math.floor(remaining / 60) % 60),
    seconds: pad(remaining % 60),
  };
}
