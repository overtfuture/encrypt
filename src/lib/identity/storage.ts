import { contactText, parseContact, type Contact } from './messages';
import { backupText, parseBackup, type Vault } from './vault';
import type { ArchivedMessage } from './history';
import {
  CONTACT_LIMIT,
  isContactBook,
  openContactBook,
  sealContactBook,
  type ContactAccess,
  type SavedContact,
  type SealedContactBook,
} from './contact-book';

export type PendingMessage = {
  owner: string;
  source: string;
  payload: string;
  savedAt: number;
};
export const PENDING_LIMIT = 20;
export const STAGED_LINKS_KEY = 'encrypt-this/staged-links';
const DB = 'encrypt-this-identities-v1';
const CONTACT_BOOK_VERSION = 3;
const CONTACT_BOOK_KEY = 'book';
const CONTACT_WRITE_ATTEMPTS = 4;

export function deleteIdentityDatabase(onBlocked: () => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(DB);
    request.onblocked = onBlocked;
    request.onsuccess = () => resolve();
    request.onerror = () =>
      reject(
        new Error('Local data could not be deleted. Try resetting again.'),
      );
  });
}

function openDatabase(
  version?: number,
  upgradeContacts?: (tx: IDBTransaction) => void,
): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB, version);
    let blocked = false;
    request.onupgradeneeded = (event) => {
      const db = request.result;
      const tx = request.transaction!;
      if (blocked) return tx.abort();
      if (version === CONTACT_BOOK_VERSION) {
        if (event.oldVersion !== 2 || !upgradeContacts) return tx.abort();
        upgradeContacts(tx);
        return;
      }
      if (event.oldVersion === 0) {
        db.createObjectStore('vault');
        db.createObjectStore('contacts');
      }
      if (version !== 2) return;
      const messages = db.createObjectStore('messages', {
        keyPath: ['owner', 'contact', 'direction', 'id'],
      });
      messages.createIndex('conversation', ['owner', 'contact', 'savedAt']);
      messages.createIndex('source', ['owner', 'source']);
      db.createObjectStore('pending', {
        keyPath: ['owner', 'source'],
      }).createIndex('owner', 'owner');
    };
    request.onblocked = () => {
      blocked = true;
      reject(
        new Error(
          'Close other tabs using encrypt, then reload to finish upgrading local storage.',
        ),
      );
    };
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => db.close();
      if (blocked) db.close();
      else resolve(db);
    };
    request.onerror = () => reject(request.error);
  });
}

async function database(): Promise<IDBDatabase> {
  const db = await openDatabase();
  if (db.version >= 2) return db;
  db.close();
  try {
    return await openDatabase(2);
  } catch (cause) {
    // Another tab may have finished both upgrades since we observed version 1.
    if (cause instanceof DOMException && cause.name === 'VersionError')
      return openDatabase();
    throw cause;
  }
}
async function transaction<T>(
  store: string | string[],
  mode: IDBTransactionMode,
  operation: (s: IDBObjectStore, done: (v: T) => void) => void,
): Promise<T> {
  const db = await database();
  return new Promise((resolve, reject) => {
    const stores = typeof store === 'string' ? [store] : store;
    const requiresProfile = mode === 'readwrite' && stores[0] !== 'vault';
    const tx = db.transaction(
      requiresProfile ? [...stores, 'vault'] : stores,
      mode,
    );
    let value: T;
    tx.oncomplete = () => {
      db.close();
      resolve(value);
    };
    tx.onabort = tx.onerror = () => {
      db.close();
      reject(
        new Error(
          'Local storage could not complete this operation. Check available space and try again.',
        ),
      );
    };
    const apply = () => {
      try {
        operation(tx.objectStore(stores[0]), (result) => {
          value = result;
        });
      } catch (err) {
        tx.abort();
        reject(err);
      }
    };
    if (requiresProfile) {
      // An open tab can finish encrypting after the browser data was reset.
      const profile = tx.objectStore('vault').getKey('identity');
      profile.onsuccess = () => {
        if (profile.result === undefined) tx.abort();
        else apply();
      };
    } else {
      apply();
    }
  });
}
export async function readVault(): Promise<Vault | undefined> {
  const value = await transaction<string | undefined>(
    'vault',
    'readonly',
    (s, done) => {
      const r = s.get('identity');
      r.onsuccess = () => done(r.result);
    },
  );
  if (!value) return undefined;
  const record = parseBackup(value);
  await parseContact(contactText(record.contact));
  return record;
}
export async function saveVault(
  record: Vault,
  previous?: Vault,
): Promise<void> {
  const value = backupText(record);
  parseBackup(value);
  return transaction<void>('vault', 'readwrite', (s, done) => {
    const r = s.get('identity');
    r.onsuccess = () => {
      if (r.result !== (previous ? backupText(previous) : undefined)) {
        s.transaction.abort();
        return;
      }
      s.put(value, 'identity');
      done();
    };
  });
}
type LegacyContacts = { vault: string | undefined; rows: SavedContact[] };

export async function migrateContacts(access: ContactAccess): Promise<void> {
  for (let attempt = 0; attempt < CONTACT_WRITE_ATTEMPTS; attempt++) {
    const legacy = await transaction<LegacyContacts | undefined>(
      ['contacts', 'vault'],
      'readonly',
      (store, done) => {
        if (store.transaction.db.version >= CONTACT_BOOK_VERSION)
          return done(undefined);
        const vault = store.transaction.objectStore('vault').get('identity');
        const rows = store.getAll(undefined, CONTACT_LIMIT + 1);
        rows.onsuccess = () => done({ vault: vault.result, rows: rows.result });
      },
    );
    if (!legacy) return;
    if (!legacy.vault || parseBackup(legacy.vault).contact.id !== access.owner)
      throw new Error('The saved profile changed. Unlock it again.');
    if (legacy.rows.length > CONTACT_LIMIT)
      throw new Error('Contact limit exceeded.');

    const snapshot = JSON.stringify(legacy.rows);
    const contacts = await Promise.all(
      legacy.rows.map(async (row) => ({
        contact: await parseContact(contactText(row.contact)),
        verified: false,
      })),
    );
    const sealed = await sealContactBook(access, contacts);
    try {
      const db = await openDatabase(CONTACT_BOOK_VERSION, (tx) => {
        const store = tx.objectStore('contacts');
        const vault = tx.objectStore('vault').get('identity');
        const rows = store.getAll(undefined, CONTACT_LIMIT + 1);
        rows.onsuccess = () => {
          if (
            vault.result !== legacy.vault ||
            JSON.stringify(rows.result) !== snapshot
          )
            return tx.abort();
          store.clear();
          store.put(sealed, CONTACT_BOOK_KEY);
        };
      });
      db.close();
      return;
    } catch (cause) {
      // Retry if a concurrent write or reset invalidated the upgrade snapshot.
      if (!(cause instanceof DOMException && cause.name === 'AbortError'))
        throw cause;
    }
  }
  throw new Error(
    'Saved contacts changed during the upgrade. Unlock again to retry.',
  );
}

function readContactBook(): Promise<SealedContactBook> {
  return transaction('contacts', 'readonly', (store, done) => {
    if (store.transaction.db.version < CONTACT_BOOK_VERSION)
      throw new Error(
        'Saved contacts have not been upgraded. Unlock again to retry.',
      );
    const request = store.get(CONTACT_BOOK_KEY);
    request.onsuccess = () => {
      if (isContactBook(request.result)) done(request.result);
      else store.transaction.abort();
    };
  });
}

export async function readContacts(
  access: ContactAccess,
): Promise<SavedContact[]> {
  return openContactBook(access, await readContactBook());
}

function sameBytes(left: Uint8Array, right: Uint8Array) {
  return (
    left.length === right.length &&
    left.every((byte, index) => byte === right[index])
  );
}

async function changeContacts(
  access: ContactAccess,
  change: (contacts: SavedContact[]) => SavedContact[] | undefined,
): Promise<SavedContact[]> {
  for (let attempt = 0; attempt < CONTACT_WRITE_ATTEMPTS; attempt++) {
    const previous = await readContactBook();
    const contacts = await openContactBook(access, previous);
    const next = change(contacts);
    if (!next) return contacts;
    const sealed = await sealContactBook(access, next);
    const saved = await transaction<boolean>(
      'contacts',
      'readwrite',
      (store, done) => {
        if (store.transaction.db.version < CONTACT_BOOK_VERSION)
          return done(false);
        const request = store.get(CONTACT_BOOK_KEY);
        request.onsuccess = () => {
          const current = request.result;
          if (
            !isContactBook(current) ||
            !sameBytes(current.iv, previous.iv) ||
            !sameBytes(
              new Uint8Array(current.ciphertext),
              new Uint8Array(previous.ciphertext),
            )
          )
            return done(false);
          store.put(sealed, CONTACT_BOOK_KEY);
          done(true);
        };
      },
    );
    if (saved) return next;
  }
  throw new Error('Saved contacts changed in another tab. Try again.');
}

export async function saveContact(access: ContactAccess, contact: Contact) {
  const valid = await parseContact(contactText(contact));
  return changeContacts(access, (contacts) => {
    if (contacts.some((row) => row.contact.id === valid.id)) return;
    if (contacts.length >= CONTACT_LIMIT)
      throw new Error('Contact limit exceeded.');
    return [...contacts, { contact: valid, verified: false }];
  });
}

export function deleteContact(access: ContactAccess, id: string) {
  return changeContacts(access, (contacts) => {
    const kept = contacts.filter((row) => row.contact.id !== id);
    return kept.length < contacts.length ? kept : undefined;
  });
}

export function verifyContact(access: ContactAccess, id: string) {
  return changeContacts(access, (contacts) => {
    const row = contacts.find((entry) => entry.contact.id === id);
    if (!row) throw new Error('This contact is no longer saved.');
    row.verified = true;
    return contacts;
  });
}

export async function enqueueMessage(message: PendingMessage): Promise<void> {
  const full = await transaction<boolean>('pending', 'readwrite', (s, done) => {
    const existing = s.getKey([message.owner, message.source]);
    existing.onsuccess = () => {
      if (existing.result) return done(false);
      const count = s.index('owner').count(message.owner);
      count.onsuccess = () => {
        if (count.result >= PENDING_LIMIT) return done(true);
        s.add(message);
        done(false);
      };
    };
  });
  if (full)
    throw new Error('The pending list is full. Dismiss a link and try again.');
}

export function readPending(owner: string): Promise<PendingMessage[]> {
  return transaction('pending', 'readonly', (s, done) => {
    const request = s.index('owner').getAll(owner, PENDING_LIMIT);
    request.onsuccess = () =>
      done(request.result.sort((a, b) => a.savedAt - b.savedAt));
  });
}

export function dismissPending(owner: string, source: string): Promise<void> {
  return transaction('pending', 'readwrite', (s, done) => {
    s.delete([owner, source]);
    done();
  });
}

export function saveMessage(message: ArchivedMessage): Promise<boolean> {
  const { owner, contact, id, direction, source } = message;
  const stores = source ? ['messages', 'pending'] : 'messages';
  return transaction(stores, 'readwrite', (s, done) => {
    const existing = s.getKey([owner, contact, direction, id]);
    existing.onsuccess = () => {
      if (existing.result === undefined) s.add(message);
      if (source) s.transaction.objectStore('pending').delete([owner, source]);
      done(existing.result === undefined);
    };
  });
}

export function findImported(
  owner: string,
  source: string,
): Promise<ArchivedMessage | undefined> {
  return transaction('messages', 'readonly', (s, done) => {
    const request = s.index('source').get([owner, source]);
    request.onsuccess = () => done(request.result);
  });
}

export function clearHistory(owner: string, contact: string): Promise<void> {
  return transaction('messages', 'readwrite', (s, done) => {
    // The message key starts with the owner and contact, then a direction string.
    s.delete(IDBKeyRange.bound([owner, contact], [owner, contact, []]));
    done();
  });
}

export function readHistory(
  owner: string,
  contact: string,
  limit: number,
): Promise<ArchivedMessage[]> {
  return transaction('messages', 'readonly', (s, done) => {
    const entries: ArchivedMessage[] = [];
    const range = IDBKeyRange.bound(
      [owner, contact, 0],
      [owner, contact, Infinity],
    );
    const request = s.index('conversation').openCursor(range, 'prev');
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor || entries.length === limit) return done(entries.reverse());
      entries.push(cursor.value);
      cursor.continue();
    };
  });
}
