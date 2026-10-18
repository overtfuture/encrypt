import { expect, it } from 'vitest';
import { sealMessage, parsePayload, openMessage } from './payload';

it.skipIf(process.env.LIVE_DRAND !== '1')(
  'opens only after a real future Quicknet beacon is published',
  async () => {
    const target = Date.now() + 8000;
    const payload = parsePayload(
      await sealMessage('A real moment, reached securely.', {
        unlockAt: target,
        pin: '024680',
      }),
    );
    expect(payload.v).toBe(2);
    expect(payload.u).toBeGreaterThanOrEqual(target);
    await expect(openMessage(payload, '024680')).rejects.toThrow(/ready/i);
    await new Promise((resolve) =>
      setTimeout(resolve, payload.u! - Date.now() + 1500),
    );
    expect(await openMessage(payload, '024680')).toBe(
      'A real moment, reached securely.',
    );
  },
  45_000,
);
