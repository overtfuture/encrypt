import { expect, it } from 'vitest';
import vector from '../../../tests/fixtures/hpke-auth-p256.json';
import { suite } from './messages';
const hex = (s: string) =>
  Uint8Array.from(s.match(/../g)!, (b) => parseInt(b, 16));
const output = (b: ArrayBuffer) => Buffer.from(b).toString('hex');
it('matches RFC 9180 Auth P-256/HKDF-SHA256/AES128-GCM encapsulation and ciphertext vectors', async () => {
  const sender = await suite.kem.deriveKeyPair(hex(vector.ikmS));
  const recipient = await suite.kem.deriveKeyPair(hex(vector.ikmR));
  expect(output(await suite.kem.serializePublicKey(sender.publicKey))).toBe(
    vector.pkSm,
  );
  const tx = await suite.createSenderContext({
    senderKey: sender,
    recipientPublicKey: recipient.publicKey,
    info: hex(vector.info),
    ekm: hex(vector.ikmE),
  });
  expect(output(tx.enc)).toBe(vector.enc);
  const rx = await suite.createRecipientContext({
    senderPublicKey: sender.publicKey,
    recipientKey: recipient,
    enc: tx.enc,
    info: hex(vector.info),
  });
  for (const v of vector.encryptions) {
    const ct = await tx.seal(hex(v.pt), hex(v.aad));
    expect(output(ct)).toBe(v.ct);
    expect(output(await rx.open(ct, hex(v.aad)))).toBe(v.pt);
  }
});
