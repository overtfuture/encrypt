import { random, text, utf8 } from './encoding';
import type { Contact } from './messages';
import { deriveVaultKey, type Session } from './vault';

export const CONTACT_LIMIT = 200;
const CONTEXT = 'encrypt-this/contacts/v1';
// Allow for JSON escaping in display names as well as contact metadata and tags.
const MAX_BOOK_BYTES = CONTACT_LIMIT * 900 + 16;

export type SavedContact = { contact: Contact; verified: boolean };
export type ContactAccess = { owner: string; key: CryptoKey };
export type SealedContactBook = {
  iv: Uint8Array<ArrayBuffer>;
  ciphertext: ArrayBuffer;
};

export async function contactAccess(session: Session): Promise<ContactAccess> {
  return {
    owner: session.identity.contact.id,
    key: await deriveVaultKey(session, CONTEXT),
  };
}

function parameters(access: ContactAccess, iv: Uint8Array<ArrayBuffer>) {
  return {
    name: 'AES-GCM',
    iv,
    additionalData: utf8.encode(`${CONTEXT}/${access.owner}`),
  };
}

export async function sealContactBook(
  access: ContactAccess,
  contacts: SavedContact[],
): Promise<SealedContactBook> {
  const iv = random(12);
  const bytes = utf8.encode(JSON.stringify(contacts));
  try {
    const ciphertext = await crypto.subtle.encrypt(
      parameters(access, iv),
      access.key,
      bytes,
    );
    return { iv, ciphertext };
  } finally {
    bytes.fill(0);
  }
}

export function isContactBook(value: unknown): value is SealedContactBook {
  if (!value || typeof value !== 'object') return false;
  const { iv, ciphertext } = value as Partial<SealedContactBook>;
  return (
    iv instanceof Uint8Array &&
    iv.length === 12 &&
    ciphertext instanceof ArrayBuffer &&
    ciphertext.byteLength >= 18 &&
    ciphertext.byteLength <= MAX_BOOK_BYTES
  );
}

export async function openContactBook(
  access: ContactAccess,
  book: SealedContactBook,
): Promise<SavedContact[]> {
  const bytes = new Uint8Array(
    await crypto.subtle.decrypt(
      parameters(access, book.iv),
      access.key,
      book.ciphertext,
    ),
  );
  try {
    return JSON.parse(text.decode(bytes));
  } finally {
    bytes.fill(0);
  }
}
