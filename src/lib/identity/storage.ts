import { contactText, parseContact, type Contact } from './messages';
import { backupText, parseBackup, type Vault } from './vault';
import type { ArchivedMessage } from './history';
export type SavedContact = { contact: Contact; verified: boolean };
export type PendingMessage = {
  owner: string;
  source: string;
  payload: string;
  savedAt: number;
};
export const PENDING_LIMIT = 20;
export const STAGED_LINKS_KEY = 'encrypt-this/staged-links';
const DB = 'encrypt-this-identities-v1';

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

async function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB, 2);
    let blocked = false;
    request.onupgradeneeded = (event) => {
      const db = request.result;
      if (event.oldVersion === 0) {
        db.createObjectStore('vault');
        db.createObjectStore('contacts');
      }
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
    request.onerror = () =>
      reject(new Error('Local storage is unavailable. No identity was saved.'));
  });
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
export async function readContacts(): Promise<SavedContact[]> {
  const rows = await transaction<SavedContact[]>(
    'contacts',
    'readonly',
    (s, done) => {
      const r = s.getAll(undefined, 201);
      r.onsuccess = () => done(r.result);
    },
  );
  if (rows.length > 200) throw new Error('Contact limit exceeded.');
  return Promise.all(
    rows.map(async (row) => ({
      contact: await parseContact(contactText(row.contact)),
      verified: row.verified === true,
    })),
  );
}
export async function saveContact(
  contact: Contact,
  verified = false,
): Promise<void> {
  const valid = await parseContact(contactText(contact));
  return transaction<void>('contacts', 'readwrite', (s, done) => {
    const existing = s.getKey(valid.id);
    existing.onsuccess = () => {
      if (existing.result !== undefined) return done();
      const count = s.count();
      count.onsuccess = () => {
        if (count.result >= 200) {
          s.transaction.abort();
          return;
        }
        s.add({ contact: valid, verified }, valid.id);
        done();
      };
    };
  });
}
export function deleteContact(id: string): Promise<void> {
  return transaction('contacts', 'readwrite', (s, done) => {
    s.delete(id);
    done();
  });
}
export async function verifyContact(id: string): Promise<void> {
  return transaction<void>('contacts', 'readwrite', (s, done) => {
    const r = s.get(id);
    r.onsuccess = () => {
      if (!r.result) {
        s.transaction.abort();
        return;
      }
      s.put({ ...r.result, verified: true }, id);
      done();
    };
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
