import {
  decode,
  encode,
  fields,
  parse,
  portable,
  random,
  text,
  utf8,
} from './encoding';
import {
  contactText,
  generateIdentity,
  parseContact,
  suite,
  type Contact,
  type Identity,
} from './messages';

export type Binding = { id: string; rp: string; input: string };
type Box = { i: string; c: string };
type Wrap = { salt: string; box: Box };
export type Vault = {
  v: 1;
  contact: Contact;
  binding: Binding;
  bundle: Box;
  passkey: Wrap;
  recovery?: Wrap;
};
export type Session = {
  identity: Identity;
  vaultKey: Uint8Array<ArrayBuffer>;
  locked: boolean;
  lock(): void;
};
const context = (purpose: string, id: string) =>
  utf8.encode(`encrypt-this/vault/v1/${purpose}/${id}`);
async function aes(raw: Uint8Array<ArrayBuffer>) {
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, [
    'encrypt',
    'decrypt',
  ]);
}
async function wrapping(
  secret: Uint8Array<ArrayBuffer>,
  salt: string,
  purpose: string,
): Promise<CryptoKey> {
  if (secret.length !== 32) throw new Error('A 32-byte secret is required.');
  const key = await crypto.subtle.importKey('raw', secret, 'HKDF', false, [
    'deriveKey',
  ]);
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: decode(salt, 32),
      info: context(purpose, 'wrap'),
    },
    key,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}
async function seal(
  key: CryptoKey,
  bytes: Uint8Array<ArrayBuffer>,
  aad: Uint8Array<ArrayBuffer>,
): Promise<Box> {
  const iv = random(12);
  return {
    i: encode(iv),
    c: encode(
      await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv, additionalData: aad },
        key,
        bytes,
      ),
    ),
  };
}
async function open(key: CryptoKey, box: Box, aad: Uint8Array<ArrayBuffer>) {
  return new Uint8Array(
    await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: decode(box.i, 12), additionalData: aad },
      key,
      decode(box.c),
    ),
  );
}
function wrapAAD(record: Pick<Vault, 'contact' | 'binding'>, purpose: string) {
  return context(
    purpose,
    JSON.stringify([
      record.contact.id,
      ...(purpose === 'passkey'
        ? [record.binding.id, record.binding.rp, record.binding.input]
        : []),
    ]),
  );
}
async function wrap(
  record: Pick<Vault, 'contact' | 'binding'>,
  vaultKey: Uint8Array<ArrayBuffer>,
  secret: Uint8Array<ArrayBuffer>,
  purpose: string,
): Promise<Wrap> {
  const salt = encode(random(32));
  return {
    salt,
    box: await seal(
      await wrapping(secret, salt, purpose),
      vaultKey,
      wrapAAD(record, purpose),
    ),
  };
}
function session(
  identity: Identity,
  vaultKey: Uint8Array<ArrayBuffer>,
): Session {
  return {
    identity,
    vaultKey,
    locked: false,
    lock() {
      this.locked = true;
      this.identity.privateKey = null;
      this.vaultKey.fill(0);
    },
  };
}
export async function createVault(
  name: string,
  binding: Binding,
  prf: Uint8Array<ArrayBuffer>,
) {
  const identity = await generateIdentity(name),
    vaultKey = random(32);
  const raw = new Uint8Array(
    await suite.kem.serializePrivateKey(identity.privateKey!),
  );
  try {
    const record: Vault = {
      v: 1,
      contact: identity.contact,
      binding,
      bundle: await seal(
        await aes(vaultKey),
        raw,
        context('bundle', contactText(identity.contact)),
      ),
      passkey: await wrap(
        { contact: identity.contact, binding },
        vaultKey,
        prf,
        'passkey',
      ),
    };
    // Exercise the stored-bundle restore path before anything can be persisted.
    const restored = await openBundle(record, vaultKey);
    identity.privateKey = null;
    return { record, session: restored };
  } catch (err) {
    vaultKey.fill(0);
    identity.privateKey = null;
    throw err;
  } finally {
    raw.fill(0);
  }
}
async function openBundle(
  record: Vault,
  key: Uint8Array<ArrayBuffer>,
): Promise<Session> {
  let raw: Uint8Array<ArrayBuffer> | undefined;
  let stage = 'contact validation';
  try {
    const contact = await parseContact(contactText(record.contact));
    stage = 'bundle decryption';
    raw = await open(
      await aes(key),
      record.bundle,
      context('bundle', contactText(contact)),
    );
    stage = 'private-key import';
    if (raw.length !== 32) throw new Error('Invalid private key size.');
    // Safari rejects the library's scalar-only PKCS#8 import. Use the complete
    // JWK, reconstructed from the scalar and AEAD-bound public contact instead.
    const publicBytes = decode(contact.k, 65);
    const privateKey = await suite.kem.importKey(
      'jwk',
      {
        kty: 'EC',
        crv: 'P-256',
        d: encode(raw),
        x: encode(publicBytes.slice(1, 33)),
        y: encode(publicBytes.slice(33, 65)),
      },
      false,
    );
    stage = 'key-pair verification';
    // Do not trust re-exported JWK x/y as proof that d matches them: some engines
    // merely echo the supplied coordinates. Check ECDH agreement in both directions.
    const probe = await suite.kem.generateKeyPair();
    const publicKey = await suite.kem.deserializePublicKey(publicBytes);
    let left: Uint8Array<ArrayBuffer> | undefined,
      right: Uint8Array<ArrayBuffer> | undefined;
    try {
      left = new Uint8Array(
        await crypto.subtle.deriveBits(
          { name: 'ECDH', public: probe.publicKey },
          privateKey,
          256,
        ),
      );
      right = new Uint8Array(
        await crypto.subtle.deriveBits(
          { name: 'ECDH', public: publicKey },
          probe.privateKey,
          256,
        ),
      );
      let difference = 0;
      for (let i = 0; i < 32; i++) difference |= left[i] ^ right[i];
      if (difference !== 0) throw new Error('Identity key mismatch.');
    } finally {
      left?.fill(0);
      right?.fill(0);
    }
    return session({ contact, privateKey }, key);
  } catch {
    key.fill(0);
    throw new Error(
      `The vault key was recovered, but messaging identity restoration failed at ${stage}. Your saved identity is unchanged.`,
    );
  } finally {
    raw?.fill(0);
  }
}
export async function unlockVault(
  record: Vault,
  prf: Uint8Array<ArrayBuffer>,
): Promise<Session> {
  let key: Uint8Array<ArrayBuffer>;
  try {
    key = await open(
      await wrapping(prf, record.passkey.salt, 'passkey'),
      record.passkey.box,
      wrapAAD(record, 'passkey'),
    );
  } catch {
    throw new Error(
      'The passkey returned encryption data, but it could not unlock the saved identity. The provider may have returned a different PRF result, or the saved vault may be damaged. Your saved data is unchanged. Try the original browser and passkey provider, or use your configured recovery code.',
    );
  }
  return openBundle(record, key);
}
export async function configureRecovery(record: Vault, current: Session) {
  if (current.locked || current.identity.contact.id !== record.contact.id)
    throw new Error('Unlock this identity first.');
  const secret = random(32);
  try {
    const updated = {
      ...record,
      recovery: await wrap(record, current.vaultKey, secret, 'recovery'),
    };
    const code = encode(secret);
    const verified = await recoverVault(updated, code);
    verified.lock();
    return { record: updated, code };
  } finally {
    secret.fill(0);
  }
}
export async function recoverVault(record: Vault, code: string) {
  if (!record.recovery) throw new Error('This backup has no recovery method.');
  const secret = decode(code.trim(), 32);
  try {
    const key = await open(
      await wrapping(secret, record.recovery.salt, 'recovery'),
      record.recovery.box,
      wrapAAD(record, 'recovery'),
    );
    return await openBundle(record, key);
  } finally {
    secret.fill(0);
  }
}
export async function rewrapVault(
  record: Vault,
  current: Session,
  binding: Binding,
  prf: Uint8Array<ArrayBuffer>,
): Promise<Vault> {
  if (current.locked || current.identity.contact.id !== record.contact.id)
    throw new Error('Unlock this identity first.');
  const next = { ...record, binding };
  next.passkey = await wrap(next, current.vaultKey, prf, 'passkey');
  const verified = await unlockVault(next, prf);
  verified.lock();
  return next;
}
export const backupText = (record: Vault) => portable('ev1.', record);
export function parseBackup(input: string): Vault {
  const v = parse('ev1.', input, 12000);
  fields(v, [
    'v',
    'contact',
    'binding',
    'bundle',
    'passkey',
    ...(v && typeof v === 'object' && 'recovery' in v ? ['recovery'] : []),
  ]);
  if (v.v !== 1) throw new Error('Unsupported backup.');
  fields(v.contact, ['v', 'a', 'n', 'k', 'id']);
  fields(v.binding, ['id', 'rp', 'input']);
  const id = decode(v.binding.id);
  if (id.length > 1024) throw new Error('Invalid credential.');
  decode(v.binding.input, 32);
  if (
    typeof v.binding.rp !== 'string' ||
    !/^[a-z0-9.-]{1,253}$/.test(v.binding.rp)
  )
    throw new Error('Invalid RP.');
  const checkBox = (b: unknown, length?: number) => {
    fields(b, ['i', 'c']);
    decode(b.i, 12);
    const bytes = decode(b.c);
    if (
      bytes.length < 17 ||
      bytes.length > 1024 ||
      (length && bytes.length !== length)
    )
      throw new Error('Invalid encrypted vault.');
  };
  checkBox(v.bundle, 48);
  for (const w of [v.passkey, ...(v.recovery ? [v.recovery] : [])]) {
    fields(w, ['salt', 'box']);
    decode(w.salt, 32);
    checkBox(w.box, 48);
  }
  return v as Vault;
}
