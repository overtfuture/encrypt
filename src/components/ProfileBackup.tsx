import { Show, createSignal } from 'solid-js';
import {
  backupText,
  configureRecovery,
  recoverVault,
  type Session,
  type Vault,
} from '../lib/identity/vault';
import { saveVault } from '../lib/identity/storage';

export type Action = (
  active: () => boolean,
  signal: AbortSignal,
) => Promise<void>;

export async function readTextFile(file: File | undefined, limit: number) {
  if (!file) return;
  if (file.size > limit) throw new Error('File is too large.');
  return file.text();
}

export function downloadText(value: string, filename: string) {
  const url = URL.createObjectURL(
    new Blob([value], { type: 'text/plain;charset=utf-8' }),
  );
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export default function ProfileBackup(props: {
  record: Vault | undefined;
  session?: Session;
  busy: boolean;
  unavailable?: boolean;
  run: (action: Action) => void;
  restore: (backup: string, code?: string) => void;
  updateRecord: (vault: Vault) => void;
  announce: (status: string) => void;
}) {
  const [backup, setBackup] = createSignal('');
  const [code, setCode] = createSignal('');
  const [recovery, setRecovery] = createSignal<{
    record: Vault;
    code: string;
  }>();

  return (
    <div class="backup-tools view-stack">
      <p>
        Backups restore your profile. Contacts and chats live in this browser.
        Clearing its site data removes them.
      </p>
      <Show when={props.record}>
        {(record) => (
          <button
            class="secondary-button"
            onClick={() =>
              downloadText(backupText(record()), 'encrypt-identity-backup.txt')
            }
          >
            Export encrypted backup
          </button>
        )}
      </Show>
      <Show
        when={props.session}
        fallback={
          <>
            <Show when={!props.record}>
              <label for="backup-input">Encrypted identity backup</label>
              <textarea
                id="backup-input"
                rows="2"
                maxlength="12000"
                value={backup()}
                onInput={(event) => setBackup(event.currentTarget.value)}
              />
              <label for="backup-file">Import backup file</label>
              <input
                id="backup-file"
                type="file"
                onChange={(event) => {
                  const file = event.currentTarget.files?.[0];
                  props.run(async (active) => {
                    const value = await readTextFile(file, 12000);
                    if (active() && value !== undefined) setBackup(value);
                  });
                }}
              />
              <button
                class="secondary-button"
                disabled={props.busy || props.unavailable || !backup()}
                onClick={() => props.restore(backup())}
              >
                Restore with passkey
              </button>
            </Show>
            <label for="recovery-code">Recovery code</label>
            <input
              id="recovery-code"
              type="password"
              autocomplete="off"
              value={code()}
              onInput={(event) => setCode(event.currentTarget.value)}
            />
            <button
              class="secondary-button"
              disabled={
                props.busy ||
                props.unavailable ||
                !code() ||
                (!props.record && !backup())
              }
              onClick={() => props.restore(backup(), code())}
            >
              Recover with new passkey
            </button>
          </>
        }
      >
        {(session) => (
          <>
            <button
              class="secondary-button"
              disabled={props.busy}
              onClick={() =>
                props.run(async (active) => {
                  const next = await configureRecovery(
                    props.record!,
                    session(),
                  );
                  if (active()) {
                    setRecovery(next);
                    setCode('');
                  }
                })
              }
            >
              Set up recovery code
            </button>
            <Show when={recovery()}>
              {(pending) => (
                <>
                  <p>
                    Save this code separately from your backup. It stays visible
                    here until you finish or leave this screen.
                  </p>
                  <code class="fingerprint">{pending().code}</code>
                  <label for="recovery-confirm">
                    Re-enter saved recovery code
                  </label>
                  <input
                    id="recovery-confirm"
                    type="password"
                    autocomplete="off"
                    value={code()}
                    onInput={(event) => setCode(event.currentTarget.value)}
                  />
                  <button
                    class="secondary-button"
                    disabled={props.busy}
                    onClick={() =>
                      props.run(async (active) => {
                        const next = pending();
                        if (code().trim() !== next.code)
                          throw new Error('The recovery code does not match.');
                        const check = await recoverVault(next.record, code());
                        check.lock();
                        if (!active()) return;
                        await saveVault(next.record, props.record);
                        props.updateRecord(next.record);
                        if (!active()) return;
                        setRecovery(undefined);
                        setCode('');
                        props.announce(
                          'Recovery configured. Export a new encrypted backup.',
                        );
                      })
                    }
                  >
                    Confirm saved recovery code
                  </button>
                </>
              )}
            </Show>
          </>
        )}
      </Show>
    </div>
  );
}
