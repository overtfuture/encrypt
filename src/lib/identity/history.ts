import { digest, payload, random, text, utf8 } from './encoding';
import { parseMessage, timedEnvelope } from './messages';
import { deriveVaultKey, type Session } from './vault';

export type HistoryMetadata = {
  owner: string;
  contact: string;
  direction: 'incoming' | 'outgoing';
  id: string;
  savedAt: number;
  round: number | null;
  source?: string;
};
export type ArchivedMessage = HistoryMetadata & {
  iv: Uint8Array<ArrayBuffer>;
  ciphertext: ArrayBuffer;
};
export type ChatMessage = HistoryMetadata & {
  body: string;
  sharePayload?: string;
};

export function historyKey(session: Session): Promise<CryptoKey> {
  return deriveVaultKey(session, 'encrypt-this/history/v1');
}

function metadata(row: HistoryMetadata): HistoryMetadata {
  const { owner, contact, direction, id, savedAt, round, source } = row;
  return { owner, contact, direction, id, savedAt, round, source };
}

function aad(row: HistoryMetadata) {
  return utf8.encode(
    JSON.stringify([
      'encrypt-this/history/entry/v1',
      row.owner,
      row.contact,
      row.direction,
      row.id,
      row.savedAt,
      row.round,
      row.source ?? null,
    ]),
  );
}

export async function sealHistory(
  key: CryptoKey,
  message: ChatMessage,
): Promise<ArchivedMessage> {
  const iv = random(12);
  const bytes = utf8.encode(
    JSON.stringify([message.body, message.sharePayload ?? null]),
  );
  try {
    const ciphertext = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: aad(message) },
      key,
      bytes,
    );
    return { ...metadata(message), iv, ciphertext };
  } finally {
    bytes.fill(0);
  }
}

export async function openHistory(
  key: CryptoKey,
  row: ArchivedMessage,
): Promise<ChatMessage> {
  const bytes = new Uint8Array(
    await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: row.iv, additionalData: aad(row) },
      key,
      row.ciphertext,
    ),
  );
  try {
    const [body, sharePayload] = JSON.parse(text.decode(bytes));
    return { ...metadata(row), body, sharePayload: sharePayload ?? undefined };
  } finally {
    bytes.fill(0);
  }
}

export function validateMessagePayload(input: string): string {
  const value = payload(input);
  if (value.includes('#')) throw new Error('Malformed message link.');
  if (value.startsWith('et1.')) timedEnvelope(value);
  else parseMessage(value);
  return value;
}

export function messageSource(value: string): Promise<string> {
  return digest(utf8.encode(value));
}
