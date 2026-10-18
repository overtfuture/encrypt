import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import beacons from '../../tests/fixtures/quicknet.json';

const RELEASE = 1_692_806_364_000; // Quicknet round 1000: 2023-08-23T15:59:24Z.

beforeEach(() => vi.resetModules());
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('drand timelock integration', () => {
  it('rounds up to the first beacon at or after the requested time', async () => {
    const { roundForTime, timeForRound } = await import('./timelock');
    expect(roundForTime(RELEASE)).toBe(1000);
    expect(roundForTime(RELEASE + 1)).toBe(1001);
    expect(roundForTime(RELEASE - 1)).toBe(1000);
    expect(timeForRound(1000)).toBe(RELEASE);
    expect(timeForRound(1001)).toBe(RELEASE + 3000);
    expect(() => roundForTime(0)).toThrow();
    expect(() => timeForRound(NaN)).toThrow();
  });

  it('encrypts locally and decrypts with a real, verified historical beacon', async () => {
    const { encryptTimedKey, decryptTimedKey } = await import('./timelock');
    const transport = vi.fn(async () => Response.json(beacons['1000']));
    vi.stubGlobal('fetch', transport);
    const key = crypto.getRandomValues(new Uint8Array(32));
    const encrypted = await encryptTimedKey(key, 1000);
    expect(transport).not.toHaveBeenCalled();
    expect(encrypted).toContain('BEGIN AGE ENCRYPTED FILE');
    expect(Array.from(await decryptTimedKey(encrypted, 1000))).toEqual(
      Array.from(key),
    );
    expect(transport).toHaveBeenCalledTimes(1);
    await decryptTimedKey(encrypted, 1000);
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it('cannot decrypt a future round even when the local clock is moved forward', async () => {
    const {
      encryptTimedKey,
      decryptTimedKey,
      roundForTime,
      timeForRound,
      TimelockUnavailableError,
    } = await import('./timelock');
    const round = roundForTime(Date.now() + 86_400_000);
    const encrypted = await encryptTimedKey(new Uint8Array(32).fill(42), round);
    vi.spyOn(Date, 'now').mockReturnValue(timeForRound(round) + 1000);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('', { status: 404 })),
    );
    await expect(decryptTimedKey(encrypted, round)).rejects.toBeInstanceOf(
      TimelockUnavailableError,
    );
  });

  it('rejects forged beacons and falls back to another relay', async () => {
    const { encryptTimedKey, decryptTimedKey } = await import('./timelock');
    const encrypted = await encryptTimedKey(new Uint8Array(32).fill(7), 1001);
    const transport = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          ...beacons['1001'],
          signature: beacons['1000'].signature,
          randomness: beacons['1000'].randomness,
        }),
      )
      .mockResolvedValueOnce(Response.json(beacons['1001']));
    vi.stubGlobal('fetch', transport);
    expect(Array.from(await decryptTimedKey(encrypted, 1001))).toEqual(
      Array(32).fill(7),
    );
    expect(transport).toHaveBeenCalledTimes(2);
    expect(String(transport.mock.calls[0][0])).toContain(
      'https://api.drand.sh/',
    );
    expect(String(transport.mock.calls[1][0])).toContain(
      'https://api2.drand.sh/',
    );
  });

  it('does not accept a beacon for the wrong round or cache a failed response', async () => {
    const { encryptTimedKey, decryptTimedKey, TimelockUnavailableError } =
      await import('./timelock');
    const encrypted = await encryptTimedKey(new Uint8Array(32).fill(9), 1000);
    const transport = vi.fn(async () => Response.json(beacons['1001']));
    vi.stubGlobal('fetch', transport);
    await expect(decryptTimedKey(encrypted, 1000)).rejects.toBeInstanceOf(
      TimelockUnavailableError,
    );
    transport.mockImplementation(async () => Response.json(beacons['1000']));
    expect(Array.from(await decryptTimedKey(encrypted, 1000))).toEqual(
      Array(32).fill(9),
    );
  });

  it('cancels an in-flight request instead of trying further relays', async () => {
    const { encryptTimedKey, decryptTimedKey } = await import('./timelock');
    const encrypted = await encryptTimedKey(new Uint8Array(32).fill(3), 1000);
    const controller = new AbortController();
    let requested!: () => void;
    const started = new Promise<void>((resolve) => {
      requested = resolve;
    });
    const transport = vi.fn(
      (_url: string, options: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          options.signal!.addEventListener(
            'abort',
            () => reject(new DOMException('Aborted', 'AbortError')),
            { once: true },
          );
          requested();
        }),
    );
    vi.stubGlobal('fetch', transport);
    const result = decryptTimedKey(encrypted, 1000, controller.signal);
    await started;
    controller.abort();
    await expect(result).rejects.toMatchObject({ name: 'AbortError' });
    expect(transport).toHaveBeenCalledTimes(1);
  });
});
