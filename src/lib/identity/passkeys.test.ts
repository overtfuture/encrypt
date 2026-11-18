import { afterEach, expect, it, vi } from 'vitest';
import { createPasskey, unlockPasskey } from './passkeys';
import { encode } from './encoding';
import { createVault, unlockVault, backupText, parseBackup } from './vault';
afterEach(() => vi.unstubAllGlobals());
function setup(create: unknown, get: unknown) {
  vi.stubGlobal('isSecureContext', true);
  vi.stubGlobal('location', { hostname: 'localhost' });
  vi.stubGlobal('navigator', { credentials: { create, get } });
}
const binding = {
  id: 'AQ',
  rp: 'localhost',
  input: encode(new Uint8Array(32)),
};
function credential(prf?: Uint8Array, id = 1) {
  return {
    rawId: new Uint8Array([id]).buffer,
    getClientExtensionResults: () => ({
      prf: {
        enabled: true,
        ...(prf ? { results: { first: prf.buffer } } : {}),
      },
    }),
  };
}
it('asserts after creation without PRF output, requires UV and uses fresh challenges', async () => {
  const create = vi.fn().mockResolvedValue(credential()),
    get = vi.fn().mockResolvedValue(credential(new Uint8Array(32).fill(4)));
  setup(create, get);
  const result = await createPasskey('Alice');
  expect(result.prf[0]).toBe(4);
  expect(get).toHaveBeenCalledOnce();
  expect(
    create.mock.calls[0][0].publicKey.authenticatorSelection.userVerification,
  ).toBe('required');
  expect(get.mock.calls[0][0].publicKey.userVerification).toBe('required');
  expect(create.mock.calls[0][0].publicKey.challenge).not.toEqual(
    get.mock.calls[0][0].publicKey.challenge,
  );
});
it('rejects missing PRF, wrong credentials, cancellation and wrong RP', async () => {
  const get = vi.fn().mockResolvedValue(credential());
  setup(vi.fn(), get);
  await expect(unlockPasskey(binding)).rejects.toThrow(/PRF/);
  get.mockResolvedValue(credential(new Uint8Array(32), 2));
  await expect(unlockPasskey(binding)).rejects.toThrow(/match/);
  get.mockRejectedValue(new DOMException('Cancelled', 'NotAllowedError'));
  await expect(unlockPasskey(binding)).rejects.toThrow();
  await expect(
    unlockPasskey({ ...binding, rp: 'elsewhere.test' }),
  ).rejects.toThrow(/hostname/);
});

it('uses assertion PRF for enrollment even when creation returns a different result', async () => {
  const create = vi
    .fn()
    .mockResolvedValue(credential(new Uint8Array(32).fill(1)));
  const get = vi
    .fn()
    .mockImplementation(async () => credential(new Uint8Array(32).fill(2)));
  setup(create, get);
  const enrolled = await createPasskey('Alice');
  expect(get).toHaveBeenCalledOnce();
  expect(enrolled.prf).toEqual(await unlockPasskey(enrolled.binding));
  expect(enrolled.prf).toEqual(new Uint8Array(32).fill(2));
  const created = await createVault('Alice', enrolled.binding, enrolled.prf);
  created.session.lock();
  enrolled.prf.fill(0);
  const restored = await unlockVault(
    parseBackup(backupText(created.record)),
    await unlockPasskey(enrolled.binding),
  );
  expect(restored.identity.contact).toEqual(created.record.contact);
  restored.lock();
});

it('does not accept creation success when a subsequent assertion has no PRF', async () => {
  setup(
    vi.fn().mockResolvedValue(credential(new Uint8Array(32).fill(1))),
    vi.fn().mockResolvedValue(credential()),
  );
  await expect(createPasskey('Alice')).rejects.toThrow(/PRF/);
});

it('owns its PRF buffer without mutating the provider response', async () => {
  const providerOutput = new Uint8Array(32).fill(5);
  setup(vi.fn(), vi.fn().mockResolvedValue(credential(providerOutput)));
  const prf = await unlockPasskey(binding);
  prf.fill(0);
  expect(providerOutput).toEqual(new Uint8Array(32).fill(5));
});
