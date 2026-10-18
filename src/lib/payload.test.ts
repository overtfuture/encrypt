import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import beacons from '../../tests/fixtures/quicknet.json';
import legacy from '../../tests/fixtures/legacy.json';
import {
  countdown,
  MAX_MESSAGE_BYTES,
  openMessage,
  parsePayload,
  sealMessage,
  shareLink,
} from './payload';

const RELEASE = 1_692_806_364_000;
beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const round = url.split('/').at(-1) as keyof typeof beacons;
      return beacons[round]
        ? Response.json(beacons[round])
        : new Response('', { status: 404 });
    }),
  );
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('message payload', () => {
  it('round trips Unicode and preserves whitespace without a PIN', async () => {
    const text = '  A little something\nfor later. 🌿 你好  ';
    const encoded = await sealMessage(text);
    expect(encoded).not.toContain('little');
    expect(await openMessage(parsePayload(encoded))).toBe(text);
  });
  it('requires the correct PIN and never embeds it in the package', async () => {
    const encoded = await sealMessage('surprise!', { pin: '024680' });
    expect(JSON.stringify(parsePayload(encoded))).not.toContain('024680');
    await expect(openMessage(parsePayload(encoded))).rejects.toThrow(/PIN/i);
    await expect(openMessage(parsePayload(encoded), '111111')).rejects.toThrow(
      /PIN|damaged/i,
    );
    expect(await openMessage(parsePayload(encoded), '024680')).toBe(
      'surprise!',
    );
  });
  it('uses a tlock-protected key and gates the message until the unlock round', async () => {
    const payload = parsePayload(
      await sealMessage('happy birthday', { unlockAt: RELEASE }),
    );
    expect(payload.v).toBe(2);
    expect(payload.k).toContain('BEGIN AGE ENCRYPTED FILE');
    await expect(openMessage(payload, '', RELEASE - 1)).rejects.toThrow(
      /ready|time/i,
    );
    expect(await openMessage(payload, '', RELEASE)).toBe('happy birthday');
  });
  it('requires both the unlock time and PIN when both are selected', async () => {
    const payload = parsePayload(
      await sealMessage('both', { pin: '123456', unlockAt: RELEASE }),
    );
    await expect(openMessage(payload, '123456', RELEASE - 1)).rejects.toThrow(
      /ready|time/i,
    );
    await expect(openMessage(payload, '654321', RELEASE)).rejects.toThrow(
      /PIN|damaged/i,
    );
    expect(await openMessage(payload, '123456', RELEASE)).toBe('both');
  });
  it('detects date and ciphertext changes', async () => {
    const payload = parsePayload(await sealMessage('unchanged'));
    await expect(
      openMessage({ ...payload, u: 1_000 }, '', 2_000),
    ).rejects.toThrow(/damaged/i);
    const c = (payload.c[0] === 'A' ? 'B' : 'A') + payload.c.slice(1);
    await expect(openMessage({ ...payload, c }, '', 2_000)).rejects.toThrow(
      /damaged/i,
    );
  });
  it('accepts raw payloads, fragments and complete share links', async () => {
    const encoded = await sealMessage('link message');
    const url = shareLink(
      encoded,
      'https://example.com/subpath/?tracking=1#old',
    );
    expect(url).toBe(`https://example.com/subpath/#${encoded}`);
    for (const input of [encoded, `#${encoded}`, url]) {
      expect(await openMessage(parsePayload(input))).toBe('link message');
    }
  });
  it('uses fresh random material for the same message', async () => {
    expect(await sealMessage('repeat')).not.toBe(await sealMessage('repeat'));
  });
  it('rejects malformed packages, unsupported versions and invalid key sizes', async () => {
    for (const input of ['', 'https://example.com', '#garbage', '%%%'])
      expect(() => parsePayload(input)).toThrow();
    const payload = parsePayload(await sealMessage('valid'));
    for (const changed of [
      { ...payload, v: 99 },
      { ...payload, k: 'AA' },
      { ...payload, u: -1 },
      { ...payload, p: 1 },
    ]) {
      const input = btoa(JSON.stringify(changed))
        .replace(/=+$/, '')
        .replaceAll('+', '-')
        .replaceAll('/', '_');
      expect(() => parsePayload(input)).toThrow();
    }
  });
  it('rejects blank messages, oversized messages and invalid dates', async () => {
    await expect(sealMessage(' \n ')).rejects.toThrow(/message/i);
    await expect(sealMessage('🌱'.repeat(MAX_MESSAGE_BYTES))).rejects.toThrow(
      /long|large/i,
    );
    await expect(sealMessage('hello', { unlockAt: NaN })).rejects.toThrow(
      /date/i,
    );
  });

  it('preserves version-1 links, PINs, and their original date behavior', async () => {
    expect(await openMessage(parsePayload(legacy.plain))).toBe(
      'A legacy note.',
    );
    const dated = parsePayload(legacy.dated);
    expect(dated.v).toBe(1);
    await expect(openMessage(dated, '', RELEASE - 1)).rejects.toThrow(/ready/i);
    expect(await openMessage(dated, '', RELEASE)).toBe('A legacy timed note.');
    await expect(
      openMessage(parsePayload(legacy.pin), '654321'),
    ).rejects.toThrow(/PIN/i);
    expect(await openMessage(parsePayload(legacy.pin), '024680')).toBe(
      'A legacy secret.',
    );
  });

  it('rejects modified public dates, rounds, raw-key replacements and version downgrades', async () => {
    const original = parsePayload(
      await sealMessage('timed', { unlockAt: RELEASE + 1 }),
    );
    expect(original.v).toBe(2);
    expect(original.u).toBe(RELEASE + 3000);
    const changes = [
      { ...original, u: RELEASE },
      { ...original, r: 1000 },
      { ...original, k: btoa('a'.repeat(32)) },
      { ...original, v: 1 },
    ];
    for (const changed of changes) {
      const encoded = btoa(JSON.stringify(changed))
        .replace(/=+$/, '')
        .replaceAll('+', '-')
        .replaceAll('/', '_');
      expect(() => parsePayload(encoded)).toThrow(/valid/i);
    }
  });

  it('keeps a future message sealed after a clock jump when its beacon is unavailable', async () => {
    const future = Date.now() + 86_400_000;
    const payload = parsePayload(
      await sealMessage('no early reveal', { unlockAt: future }),
    );
    vi.spyOn(Date, 'now').mockReturnValue(future + 5000);
    await expect(openMessage(payload, '', future + 5000)).rejects.toThrow(
      /drand|beacon/i,
    );
  });
});

describe('countdown', () => {
  it('splits the remaining time and never counts below zero', () => {
    expect(countdown(90_061_000, 0)).toEqual({
      days: '01',
      hours: '01',
      minutes: '01',
      seconds: '01',
    });
    expect(countdown(1_000, 1_001)).toEqual({
      days: '00',
      hours: '00',
      minutes: '00',
      seconds: '00',
    });
    expect(countdown(1_001, 1_000).seconds).toBe('01');
  });
});
