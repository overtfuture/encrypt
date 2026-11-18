import { beforeEach, expect, it, vi } from 'vitest';
import beacons from '../../tests/fixtures/quicknet.json';
beforeEach(() => vi.resetModules());
it('verifies manually imported beacons, rejects forged/oversized data and never fetches', async () => {
  const t = await import('./timelock');
  const fetch = vi
    .spyOn(globalThis, 'fetch')
    .mockRejectedValue(new Error('No network'));
  const key = new Uint8Array(32).fill(7);
  const encrypted = await t.encryptTimedKey(key, 1000);
  await expect(t.decryptTimedKey(encrypted, 1000)).rejects.toThrow(/Import/);
  await expect(
    t.importBeacon(
      JSON.stringify({
        ...beacons['1000'],
        signature: beacons['1001'].signature,
      }),
    ),
  ).rejects.toThrow();
  await expect(t.importBeacon('x'.repeat(2049))).rejects.toThrow();
  await t.importBeacon(JSON.stringify(beacons['1000']));
  expect(await t.decryptTimedKey(encrypted, 1000)).toEqual(key);
  expect(fetch).not.toHaveBeenCalled();
  fetch.mockRestore();
});
it('rounds dates up and rejects invalid rounds', async () => {
  const t = await import('./timelock');
  expect(t.roundForTime(1692806364000)).toBe(1000);
  expect(t.roundForTime(1692806364001)).toBe(1001);
  expect(() => t.timeForRound(NaN)).toThrow();
});
