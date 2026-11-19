import { Show, createEffect, createSignal, onCleanup, onMount } from 'solid-js';
import QRCode from 'qrcode';
import {
  GUEST_MESSAGE_LIMIT,
  openGuestMessage,
  parseGuestMessage,
  sealGuestMessage,
  validateGuestUnlockCode,
} from '../lib/guest-message';
import { fingerprint, link } from '../lib/identity/encoding';
import { contactText, type Contact } from '../lib/identity/messages';
import { renderMessage } from '../lib/message-content';
import { Avatar, contactName } from './Conversation';
import { Icon } from './Icon';
import type { Action } from './ProfileBackup';
import ScanInput from './ScanInput';

const qrOptions = {
  message: {
    alt: 'Guest message QR code',
    class: 'contact-qr guest-qr',
    filename: 'guest-message.png',
    download: 'Download message QR',
    unavailable: 'This message is too large for a QR code. Share the link.',
  },
  unlockCode: {
    alt: 'Guest unlock code QR',
    class: 'contact-qr',
    filename: 'guest-unlock-code.png',
    download: 'Download unlock code QR',
    unavailable: 'Could not create the QR code. Copy the unlock code instead.',
  },
};

function GuestQr(props: { value: string; kind: keyof typeof qrOptions }) {
  const options = qrOptions[props.kind];
  const [qr, setQr] = createSignal<{ value: string; image?: string }>();
  const currentQr = () => (qr()?.value === props.value ? qr() : undefined);

  createEffect(() => {
    const value = props.value;
    let current = true;
    onCleanup(() => {
      current = false;
    });
    void QRCode.toDataURL(value, {
      errorCorrectionLevel: 'M',
      margin: 4,
      scale: 5,
    }).then(
      (image) => {
        if (current) setQr({ value, image });
      },
      () => {
        if (current) setQr({ value });
      },
    );
  });

  return (
    <Show when={currentQr()}>
      {(ready) => (
        <Show
          when={ready().image}
          fallback={<p class="field-help">{options.unavailable}</p>}
        >
          {(image) => (
            <>
              <img class={options.class} src={image()} alt={options.alt} />
              <a
                class="secondary-button"
                href={image()}
                download={options.filename}
              >
                <Icon name="download" /> {options.download}
              </a>
            </>
          )}
        </Show>
      )}
    </Show>
  );
}

export function GuestMessageComposer(props: {
  contact: Contact;
  asContact: boolean;
  busy: boolean;
  run: (action: Action) => void;
  copy: (value: string) => void;
}) {
  const [message, setMessage] = createSignal('');
  const [includeContact, setIncludeContact] = createSignal(props.asContact);
  const [sealed, setSealed] =
    createSignal<Awaited<ReturnType<typeof sealGuestMessage>>>();
  const [includeCode, setIncludeCode] = createSignal(false);
  const [showCodeQr, setShowCodeQr] = createSignal(false);
  const shareLink = () => {
    const result = sealed();
    if (!result) return '';
    const fragment = includeCode()
      ? `${result.fragment}.${result.code}`
      : result.fragment;
    return link(fragment);
  };
  let mounted = true;
  onCleanup(() => {
    mounted = false;
  });

  return (
    <Show
      when={sealed()}
      fallback={
        <form
          class="view-stack"
          onSubmit={(event) => {
            event.preventDefault();
            props.run(async (active) => {
              const result = await sealGuestMessage(
                message(),
                includeContact() ? props.contact : undefined,
              );
              if (active() && mounted) {
                setMessage('');
                setSealed(result);
              }
            });
          }}
        >
          <p>
            Share an encrypted message or your public contact with someone who
            doesn’t have a profile.
          </p>
          <label class="guest-share-option">
            <input
              type="checkbox"
              checked={includeContact()}
              onChange={(event) =>
                setIncludeContact(event.currentTarget.checked)
              }
            />
            Include my contact
          </label>
          <label for="guest-compose">
            Message for guest
            <Show when={includeContact()}>
              {' '}
              <span class="optional">Optional</span>
            </Show>
          </label>
          <textarea
            id="guest-compose"
            rows="5"
            maxlength={GUEST_MESSAGE_LIMIT}
            autocomplete="off"
            value={message()}
            onInput={(event) => setMessage(event.currentTarget.value)}
          />
          <button
            class="primary-button"
            type="submit"
            disabled={props.busy || (!includeContact() && !message().trim())}
          >
            <Icon name="lock" />
            {includeContact() && !message().trim()
              ? 'Encrypt contact card'
              : 'Encrypt guest message'}
          </button>
        </form>
      }
    >
      {(result) => (
        <div class="view-stack guest-share">
          <label class="guest-share-option">
            <input
              type="checkbox"
              checked={includeCode()}
              onChange={(event) => {
                setIncludeCode(event.currentTarget.checked);
                setShowCodeQr(false);
              }}
            />
            Include unlock code with link and QR
          </label>
          <section
            class="view-stack guest-share-section"
            aria-labelledby="guest-share-message-heading"
          >
            <h3 id="guest-share-message-heading">Guest message</h3>
            <Show when={includeCode()}>
              <p class="field-help">
                Anyone with this link or QR code can open the message.
              </p>
            </Show>
            <label for="guest-share-link">Guest message link</label>
            <input
              id="guest-share-link"
              type="url"
              readonly
              value={shareLink()}
              onFocus={(event) => event.currentTarget.select()}
            />
            <button
              class="primary-button"
              disabled={props.busy}
              onClick={() => props.copy(shareLink())}
            >
              <Icon name="copy" /> Copy guest link
            </button>
            <GuestQr value={shareLink()} kind="message" />
          </section>
          <Show when={!includeCode()}>
            <section
              class="view-stack guest-share-section"
              aria-labelledby="guest-share-unlock-heading"
            >
              <h3 id="guest-share-unlock-heading">Separate unlock code</h3>
              <p class="field-help">
                Share this code separately from the guest message link or QR.
              </p>
              <label for="guest-share-code">Guest unlock code</label>
              <input
                id="guest-share-code"
                class="guest-code"
                readonly
                value={result().code}
                onFocus={(event) => event.currentTarget.select()}
              />
              <button
                class="secondary-button"
                disabled={props.busy}
                onClick={() => props.copy(result().code)}
              >
                Copy unlock code
              </button>
              <label class="guest-share-option">
                <input
                  type="checkbox"
                  checked={showCodeQr()}
                  onChange={(event) =>
                    setShowCodeQr(event.currentTarget.checked)
                  }
                />
                Show unlock code QR
              </label>
              <Show when={showCodeQr()}>
                <GuestQr value={result().code} kind="unlockCode" />
              </Show>
            </section>
          </Show>
          <button
            class="quiet-button"
            disabled={props.busy}
            onClick={() => {
              setSealed(undefined);
              setIncludeContact(props.asContact);
              setIncludeCode(false);
              setShowCodeQr(false);
            }}
          >
            Write another message
          </button>
        </div>
      )}
    </Show>
  );
}

export function GuestMessageOpener(props: {
  input: string;
  close: () => void;
}) {
  const [input, setInput] = createSignal('');
  const [envelope, setEnvelope] =
    createSignal<ReturnType<typeof parseGuestMessage>>();
  const [code, setCode] = createSignal('');
  const [codeScanned, setCodeScanned] = createSignal(false);
  const [contents, setContents] =
    createSignal<Awaited<ReturnType<typeof openGuestMessage>>>();
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal('');
  let mounted = true;
  onCleanup(() => {
    mounted = false;
  });

  async function unlock(
    current: ReturnType<typeof parseGuestMessage>,
    value: string,
  ) {
    if (busy()) return;
    setBusy(true);
    setError('');
    setCodeScanned(false);
    try {
      const result = await openGuestMessage(current, value);
      if (!mounted) return;
      setContents(result);
      setCode('');
      setEnvelope(undefined);
    } catch {
      if (mounted)
        setError(
          'That unlock code couldn’t open this message. Check the code and try again.',
        );
    } finally {
      if (mounted) setBusy(false);
    }
  }

  function load(value: string) {
    if (busy()) return;
    setError('');
    try {
      const { code, ...envelope } = parseGuestMessage(value);
      setInput('');
      setEnvelope(envelope);
      if (code) void unlock(envelope, code);
    } catch {
      setError('This guest message link is invalid or incomplete.');
    }
  }

  function scanCode(value: string) {
    const scanned = value.trim();
    try {
      validateGuestUnlockCode(scanned);
      setCode(scanned);
      setCodeScanned(true);
      setError('');
    } catch {
      setCodeScanned(false);
      setError('Scan the unlock code QR shared by the sender.');
    }
  }

  onMount(() => {
    if (props.input) load(props.input);
  });

  return (
    <main class="app-content">
      <section class="gate guest-gate" aria-labelledby="guest-heading">
        <div class="gate-card">
          <div class="empty-icon" aria-hidden="true">
            <Icon name="lock" />
          </div>
          <h1 id="guest-heading">
            {contents()?.contact && !contents()?.message
              ? 'Guest contact'
              : 'Guest message'}
          </h1>
          <Show
            when={contents()}
            fallback={
              <Show
                when={!busy()}
                fallback={<p role="status">Opening guest message…</p>}
              >
                <Show
                  when={envelope()}
                  fallback={
                    <form
                      class="view-stack"
                      onSubmit={(event) => {
                        event.preventDefault();
                        load(input());
                      }}
                    >
                      <label for="guest-open-link">
                        Paste a guest message link
                      </label>
                      <textarea
                        id="guest-open-link"
                        rows="3"
                        maxlength="92000"
                        autocomplete="off"
                        value={input()}
                        onInput={(event) => setInput(event.currentTarget.value)}
                      />
                      <button
                        class="primary-button"
                        type="submit"
                        disabled={!input().trim()}
                      >
                        Open link
                      </button>
                      <ScanInput onRead={load} />
                    </form>
                  }
                >
                  {(current) => (
                    <form
                      class="view-stack"
                      onSubmit={(event) => {
                        event.preventDefault();
                        void unlock(current(), code());
                      }}
                    >
                      <p>
                        Enter or scan the unlock code the sender shared
                        separately.
                      </p>
                      <label for="guest-open-code">Unlock code</label>
                      <input
                        id="guest-open-code"
                        class="guest-code"
                        type="password"
                        maxlength="100"
                        autocomplete="off"
                        autocapitalize="off"
                        spellcheck={false}
                        value={code()}
                        onInput={(event) => {
                          setCodeScanned(false);
                          setCode(event.currentTarget.value);
                        }}
                      />
                      <Show when={codeScanned()}>
                        <p class="field-help" role="status">
                          Unlock code filled in.
                        </p>
                      </Show>
                      <button
                        class="primary-button"
                        type="submit"
                        disabled={!code().trim()}
                      >
                        Unlock message
                      </button>
                      <ScanInput unlockCode onRead={scanCode} />
                    </form>
                  )}
                </Show>
              </Show>
            }
          >
            {(opened) => (
              <>
                <Show when={opened().message}>
                  {(message) => (
                    <div
                      class="bubble guest-plaintext message-markdown"
                      data-testid="guest-plaintext"
                      innerHTML={renderMessage(message())}
                    />
                  )}
                </Show>
                <Show when={opened().contact}>
                  {(contact) => (
                    <section
                      class="view-stack guest-share-section"
                      aria-labelledby="guest-contact-heading"
                    >
                      <h2 id="guest-contact-heading">Shared contact</h2>
                      <div class="flex items-center gap-3">
                        <Avatar name={contactName(contact())} />
                        <h3>{contactName(contact())}</h3>
                      </div>
                      <p class="fingerprint">{fingerprint(contact().id)}</p>
                      <a
                        class="secondary-button"
                        href={link(contactText(contact()))}
                      >
                        Review and add contact
                      </a>
                    </section>
                  )}
                </Show>
              </>
            )}
          </Show>
          <Show when={error()}>
            <p class="error-message" role="alert">
              {error()}
            </p>
          </Show>
          <button class="quiet-button" onClick={props.close}>
            Close guest message
          </button>
        </div>
      </section>
    </main>
  );
}
