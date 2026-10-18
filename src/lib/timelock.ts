import {
  fetchBeacon,
  type ChainClient,
  type ChainInfo,
  type RandomnessBeacon,
} from 'drand-client';
// Load cryptographic code before rendering a countdown. Waiting until opening
// time could strand an already-open page after a deployment or connection loss.
import { timelockEncrypt, timelockDecrypt, Buffer } from 'tlock-js';

// Version-2 payloads always use this exact Quicknet chain. Never take a public
// key, scheme, or relay URL from an untrusted payload or an /info response.
const QUICKNET: ChainInfo = Object.freeze({
  public_key:
    '83cf0f2896adee7eb8b5f01fcad3912212c437e0073e911fb90022d3e760183c8c4b450b6a0a6c3ac6a5776a2d1064510d1fec758c921cc22b0e17e63aaf4bcb5ed66304de9cf809bd274ca73bab4af5a6e9c76a4bc09e76eae8991ef5ece45a',
  period: 3,
  genesis_time: 1692803367,
  hash: '52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971',
  groupHash: 'f477d5c89f21a17c863a7f937c6a6d15859414d2be09cd448d4279af331c5d3e',
  schemeID: 'bls-unchained-g1-rfc9380',
  metadata: Object.freeze({ beaconID: 'quicknet' }),
});
const RELAYS = [
  'https://api.drand.sh',
  'https://api2.drand.sh',
  'https://api3.drand.sh',
  'https://drand.cloudflare.com',
];
const REQUEST_TIMEOUT = 5000;
const releasedBeacons = new Map<number, RandomnessBeacon>();

export class TimelockUnavailableError extends Error {
  constructor(public readonly reason: 'pending' | 'network') {
    super(
      reason === 'pending'
        ? 'Waiting for drand’s unlock beacon.'
        : 'The drand unlock beacon is unavailable. Your message stays locked.',
    );
    this.name = 'TimelockUnavailableError';
  }
}

export function roundForTime(time: number): number {
  if (
    !Number.isSafeInteger(time) ||
    time < QUICKNET.genesis_time * 1000 ||
    time > 8_640_000_000_000_000
  )
    throw new Error('Choose a valid opening date.');
  // roundAt() floors to an already-issued round. For an unlock date we must ceil.
  return (
    Math.ceil(
      (time - QUICKNET.genesis_time * 1000) / (QUICKNET.period * 1000),
    ) + 1
  );
}

export function timeForRound(round: number): number {
  if (!Number.isSafeInteger(round) || round < 1)
    throw new Error('Invalid unlock round.');
  const time = (QUICKNET.genesis_time + (round - 1) * QUICKNET.period) * 1000;
  if (!Number.isSafeInteger(time) || time > 8_640_000_000_000_000)
    throw new Error('Invalid unlock round.');
  return time;
}

function chainClient(get: ChainClient['get']): ChainClient {
  return {
    options: {
      disableBeaconVerification: false,
      noCache: false,
      chainVerificationParams: {
        chainHash: QUICKNET.hash,
        publicKey: QUICKNET.public_key,
      },
    },
    chain: () => ({
      baseUrl: `${RELAYS[0]}/${QUICKNET.hash}`,
      info: async () => QUICKNET,
    }),
    get,
    latest: async () => {
      throw new Error('Only explicit unlock rounds are supported.');
    },
  };
}

async function releasedBeacon(
  round: number,
  signal?: AbortSignal,
): Promise<RandomnessBeacon> {
  signal?.throwIfAborted();
  const cached = releasedBeacons.get(round);
  if (cached) return cached;
  let pending = false;
  for (const relay of RELAYS) {
    signal?.throwIfAborted();
    const request = new AbortController();
    const abort = () => request.abort(signal?.reason);
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => request.abort(), REQUEST_TIMEOUT);
    try {
      const client = chainClient(async () => {
        const response = await fetch(
          `${relay}/${QUICKNET.hash}/public/${round}`,
          {
            signal: request.signal,
            credentials: 'omit',
            referrerPolicy: 'no-referrer',
            redirect: 'error',
            headers: { Accept: 'application/json' },
          },
        );
        if (response.status === 404) pending = true;
        if (!response.ok) throw new Error('Beacon unavailable.');
        if (Number(response.headers.get('content-length')) > 2048)
          throw new Error('Invalid beacon response.');
        const text = await response.text();
        if (text.length > 2048) throw new Error('Invalid beacon response.');
        const beacon = JSON.parse(text);
        if (
          beacon?.round !== round ||
          typeof beacon.signature !== 'string' ||
          !/^[a-f0-9]{96}$/i.test(beacon.signature) ||
          typeof beacon.randomness !== 'string' ||
          !/^[a-f0-9]{64}$/i.test(beacon.randomness) ||
          beacon.previous_signature !== undefined
        )
          throw new Error('Invalid beacon response.');
        return beacon as RandomnessBeacon;
      });
      // Verify against the pinned public key, including before caching or trying
      // another relay. A plausible-looking JSON response is not a trusted beacon.
      const beacon = await fetchBeacon(client, round);
      signal?.throwIfAborted();
      releasedBeacons.set(round, Object.freeze(beacon));
      if (releasedBeacons.size > 32)
        releasedBeacons.delete(releasedBeacons.keys().next().value!);
      return beacon;
    } catch {
      signal?.throwIfAborted();
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    }
  }
  throw new TimelockUnavailableError(pending ? 'pending' : 'network');
}

export function validateTimedKey(ciphertext: string, round: number): void {
  timeForRound(round);
  const begin = '-----BEGIN AGE ENCRYPTED FILE-----\n';
  const end = '-----END AGE ENCRYPTED FILE-----';
  if (
    ciphertext.length > 1600 ||
    !ciphertext.startsWith(begin) ||
    !ciphertext.trimEnd().endsWith(end)
  )
    throw new Error('Invalid timelock envelope.');
  const body = ciphertext
    .slice(begin.length, ciphertext.lastIndexOf(end))
    .replace(/\s/g, '');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(body))
    throw new Error('Invalid timelock envelope.');
  const age = atob(body);
  const mac = age.indexOf('\n--- ');
  const expected = `age-encryption.org/v1\n-> tlock ${round} ${QUICKNET.hash}\n`;
  if (
    !age.startsWith(expected) ||
    mac < expected.length ||
    age.slice(0, mac).match(/\n-> /g)?.length !== 1
  )
    throw new Error('Invalid timelock envelope.');
}

export async function encryptTimedKey(
  key: Uint8Array,
  round: number,
): Promise<string> {
  timeForRound(round);
  const client = chainClient(async () => {
    throw new Error('Encryption does not fetch beacons.');
  });
  return timelockEncrypt(round, Buffer.from(key), client);
}

export async function decryptTimedKey(
  ciphertext: string,
  round: number,
  signal?: AbortSignal,
): Promise<Uint8Array<ArrayBuffer>> {
  validateTimedKey(ciphertext, round);
  signal?.throwIfAborted();
  const client = chainClient(async (requested) => {
    if (requested !== round) throw new Error('Mismatched unlock round.');
    return releasedBeacon(round, signal);
  });
  const result = await timelockDecrypt(ciphertext, client);
  signal?.throwIfAborted();
  return Uint8Array.from(result);
}
