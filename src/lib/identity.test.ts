import { expect, it, vi } from 'vitest';
import {
  generateIdentity,
  contactText,
  parseContact,
  encryptMessage,
  decryptMessage,
  parseMessage,
  sealLiveSignal,
  openLiveSignal,
  suite,
} from './identity/messages';
import {
  createVault,
  unlockVault,
  configureRecovery,
  recoverVault,
  parseBackup,
  backupText,
} from './identity/vault';
import { rewrapVault } from './identity/vault';
import { unwrapMessage, timedEnvelope } from './identity/messages';
import { importBeacon } from './timelock';
import beacons from '../../tests/fixtures/quicknet.json';
import { portable } from './identity/encoding';

it('authenticates live signaling to the selected contact in a separate envelope context', async () => {
  const [sender, receiver, other] = await Promise.all([
    generateIdentity('Sender'),
    generateIdentity('Receiver'),
    generateIdentity('Other'),
  ]);
  const code = await sealLiveSignal(
    sender,
    receiver.contact,
    'test signaling data',
  );
  await expect(openLiveSignal(receiver, sender.contact, code)).resolves.toBe(
    'test signaling data',
  );
  await expect(openLiveSignal(other, sender.contact, code)).rejects.toThrow(
    /recipient/,
  );
  await expect(
    decryptMessage(receiver, sender.contact, code.replace(/^el1\./, 'em1.')),
  ).rejects.toThrow(/authentication/);
});

it('rejects an authenticated bundle whose scalar does not match its contact even with a permissive JWK importer', async () => {
  const a = await suite.kem.generateKeyPair(),
    b = await suite.kem.generateKeyPair();
  // Produce a valid encrypted bundle with A's scalar and B's public contact.
  const generation = vi
    .spyOn(suite.kem, 'generateKeyPair')
    .mockResolvedValueOnce({
      privateKey: a.privateKey,
      publicKey: b.publicKey,
    });
  // Simulate an engine that accepts inconsistent JWK coordinates. The independent
  // ECDH agreement check must still reject instead of trusting exported x/y.
  const importing = vi
    .spyOn(suite.kem, 'importKey')
    .mockResolvedValueOnce(a.privateKey);
  try {
    await expect(
      createVault(
        'Mismatch',
        {
          id: 'AQ',
          rp: 'localhost',
          input: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        },
        new Uint8Array(32).fill(3),
      ),
    ).rejects.toThrow(/key-pair verification/);
  } finally {
    generation.mockRestore();
    importing.mockRestore();
  }
});

it('exchanges authenticated messages out of order and rejects outsiders and substituted keys', async () => {
  const a = await generateIdentity('Alice'),
    b = await generateIdentity('Bob'),
    c = await generateIdentity('Alice');
  const contact = await parseContact(contactText(a.contact));
  expect(contact).toEqual(a.contact);
  const one = await encryptMessage(a, b.contact, 'hello 🌿');
  const two = await encryptMessage(a, b.contact, 'second');
  expect(await decryptMessage(b, contact, two)).toBe('second');
  expect(await decryptMessage(b, contact, one)).toBe('hello 🌿');
  expect(
    await decryptMessage(
      a,
      b.contact,
      await encryptMessage(b, a.contact, 'reply'),
    ),
  ).toBe('reply');
  await expect(decryptMessage(c, contact, one)).rejects.toThrow();
  await expect(decryptMessage(b, c.contact, one)).rejects.toThrow();
  const m = parseMessage(one);
  m.c = (m.c[0] === 'A' ? 'B' : 'A') + m.c.slice(1);
  const altered =
    'em1.' +
    btoa(JSON.stringify(m))
      .replaceAll('+', '-')
      .replaceAll('/', '_')
      .replace(/=+$/, '');
  await expect(decryptMessage(b, contact, altered)).rejects.toThrow();
  await expect(
    encryptMessage(a, b.contact, 'x'.repeat(16001)),
  ).rejects.toThrow();
  expect(() => parseMessage('em2.e30')).toThrow();
  expect(() => parseMessage('x'.repeat(40001))).toThrow();
});

it('preserves identity through encrypted backup and recovery', async () => {
  const prf = crypto.getRandomValues(new Uint8Array(32));
  const binding = {
    id: 'AQ',
    rp: 'localhost',
    input: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  };
  const { record, session } = await createVault('Alice', binding, prf);
  const encoded = backupText(record);
  expect(encoded).not.toContain('privateKey');
  const restored = await unlockVault(parseBackup(encoded), prf);
  const other = await generateIdentity('Sender');
  const beforeRecovery = await encryptMessage(
    other,
    session.identity.contact,
    'addressed before recovery',
  );
  expect(restored.identity.contact).toEqual(session.identity.contact);
  await expect(unlockVault(record, new Uint8Array(32))).rejects.toThrow();
  const { record: recoveryRecord, code } = await configureRecovery(
    record,
    session,
  );
  const recovered = await recoverVault(
    parseBackup(backupText(recoveryRecord)),
    code,
  );
  expect(recovered.identity.contact).toEqual(session.identity.contact);
  const newPrf = new Uint8Array(32).fill(9);
  const rewrapped = await rewrapVault(
    recoveryRecord,
    recovered,
    { ...binding, id: 'Ag' },
    newPrf,
  );
  const newSession = await unlockVault(rewrapped, newPrf);
  expect(newSession.identity.contact).toEqual(session.identity.contact);
  expect(
    await decryptMessage(newSession.identity, other.contact, beforeRecovery),
  ).toBe('addressed before recovery');
  await expect(unlockVault(rewrapped, prf)).rejects.toThrow();
  newSession.lock();
  await expect(recoverVault(recoveryRecord, 'wrong')).rejects.toThrow();
  const damaged = structuredClone(record);
  damaged.bundle.c = damaged.bundle.c.slice(0, -4) + 'AAAA';
  await expect(unlockVault(damaged, prf)).rejects.toThrow();
  session.lock();
  restored.lock();
  recovered.lock();
  expect(session.vaultKey.every((x) => x === 0)).toBe(true);
  await expect(
    encryptMessage(session.identity, session.identity.contact, 'locked'),
  ).rejects.toThrow();
});

it('time-locks passkey messages with a verified manual beacon and authenticates the opening round', async () => {
  const a = await generateIdentity('Alice'),
    b = await generateIdentity('Bob'),
    c = await generateIdentity('Carol');
  const timed = await encryptMessage(
    a,
    b.contact,
    'after the date',
    1692806367000,
  );
  expect(timed.startsWith('et1.')).toBe(true);
  await expect(unwrapMessage(timed)).rejects.toThrow(/Import/);
  await importBeacon(JSON.stringify(beacons['1001']));
  expect(await decryptMessage(b, a.contact, timed)).toBe('after the date');
  await expect(decryptMessage(c, a.contact, timed)).rejects.toThrow();
  const outer = timedEnvelope(timed);
  expect(() =>
    timedEnvelope(portable('et1.', { ...outer, t: 1000 })),
  ).toThrow();
  const inner = await unwrapMessage(timed),
    message = parseMessage(inner);
  await expect(
    decryptMessage(b, a.contact, portable('em1.', { ...message, t: null })),
  ).rejects.toThrow();
  // Largest supported message stays within every serialization/tlock bound.
  const large = await encryptMessage(
    a,
    b.contact,
    'x'.repeat(16000),
    1692806367000,
  );
  expect(await decryptMessage(b, a.contact, large)).toHaveLength(16000);
});

it('rejects malformed contacts, extra fields, unsupported algorithms and oversized backups', async () => {
  const a = await generateIdentity('<script>not HTML</script>');
  await expect(
    parseContact(portable('ec1.', { ...a.contact, a: 'other' })),
  ).rejects.toThrow();
  await expect(
    parseContact(portable('ec1.', { ...a.contact, extra: 1 })),
  ).rejects.toThrow();
  await expect(
    parseContact(portable('ec1.', { ...a.contact, k: 'AA' })),
  ).rejects.toThrow();
  expect(() => parseBackup('ev1.' + 'A'.repeat(12001))).toThrow();
});
