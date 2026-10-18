import {
  createSignal,
  createEffect,
  createMemo,
  onCleanup,
  onMount,
  Show,
  For,
  untrack,
} from 'solid-js';
import {
  countdown,
  openMessage,
  parsePayload,
  type Payload,
} from '../lib/payload';
import { Envelope } from './Envelope';
import { Icon } from './Icon';
import ScanInput from './ScanInput';
import { TimelockUnavailableError } from '../lib/timelock';
import { redirectUrl, renderMessage } from '../lib/message-content';

export default function OpenMessage(props: {
  incoming: string;
  onReset: () => void;
}) {
  const [source, setSource] = createSignal('');
  const [payload, setPayload] = createSignal<Payload | null>(null);
  const [pin, setPin] = createSignal('');
  const [error, setError] = createSignal('');
  const [revealed, setRevealed] = createSignal<string | null>(null);
  const [now, setNow] = createSignal(Date.now());
  const [busy, setBusy] = createSignal(false);
  const [autoAttempted, setAutoAttempted] = createSignal(false);
  const [copied, setCopied] = createSignal(false);
  const [waitingBeacon, setWaitingBeacon] = createSignal('');
  let generation = 0;
  let copyTimer: ReturnType<typeof setTimeout> | undefined;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let request: AbortController | undefined;
  let retryCount = 0;
  const ready = createMemo(
    () => payload()?.u == null || now() >= payload()!.u!,
  );
  const remaining = createMemo(() => countdown(payload()?.u ?? now(), now()));
  const destination = createMemo(() => {
    const text = revealed();
    return text === null ? null : redirectUrl(text);
  });
  const renderedMessage = createMemo(() => {
    const text = revealed();
    return text === null ? '' : renderMessage(text);
  });

  createEffect(() => {
    const url = destination();
    if (url) {
      try {
        window.location.replace(url);
      } catch {
        // A browser can block navigation; keep the explicit link available.
      }
    }
  });

  function cancelPending() {
    generation++;
    request?.abort();
    request = undefined;
    clearTimeout(retryTimer);
    retryCount = 0;
    setWaitingBeacon('');
  }

  function load(value: string) {
    cancelPending();
    setBusy(false);
    setError('');
    setRevealed(null);
    setPin('');
    setPayload(null);
    setAutoAttempted(false);
    setNow(Date.now());
    try {
      const parsed = parsePayload(value);
      setPayload(parsed);
      setSource('');
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'This is not a valid message.',
      );
    }
  }

  createEffect(() => {
    const incoming = props.incoming;
    if (incoming) untrack(() => load(incoming));
    else untrack(clearReader);
  });
  onMount(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    const refresh = () => setNow(Date.now());
    document.addEventListener('visibilitychange', refresh);
    onCleanup(() => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', refresh);
    });
  });
  onCleanup(() => {
    cancelPending();
    clearTimeout(copyTimer);
  });

  async function reveal(event?: SubmitEvent) {
    event?.preventDefault();
    const current = payload();
    if (!current || !ready() || busy()) return;
    const attempt = generation;
    clearTimeout(retryTimer);
    const controller = new AbortController();
    request = controller;
    setBusy(true);
    setError('');
    setWaitingBeacon('');
    try {
      const message = await openMessage(current, pin(), Date.now(), {
        signal: controller.signal,
      });
      if (attempt === generation) {
        setRevealed(message);
        setPin('');
        retryCount = 0;
      }
    } catch (err) {
      if (attempt !== generation || controller.signal.aborted) return;
      if (err instanceof TimelockUnavailableError) {
        setWaitingBeacon(err.message);
        const delay = [10_000, 30_000, 60_000][Math.min(retryCount++, 2)];
        retryTimer = setTimeout(() => {
          if (attempt === generation) void reveal();
        }, delay);
      } else {
        setError(
          err instanceof Error ? err.message : 'Could not open this message.',
        );
      }
    } finally {
      if (attempt === generation) setBusy(false);
      if (request === controller) request = undefined;
    }
  }

  createEffect(() => {
    const current = payload();
    if (current && !ready()) {
      untrack(() => {
        if (revealed() === null) {
          cancelPending();
          setBusy(false);
          setAutoAttempted(false);
        }
      });
      return;
    }
    if (current && !current.p && ready() && !autoAttempted()) {
      setAutoAttempted(true);
      untrack(() => void reveal());
    }
  });

  function clearReader() {
    cancelPending();
    setPayload(null);
    setRevealed(null);
    setSource('');
    setPin('');
    setError('');
    setBusy(false);
    setAutoAttempted(false);
  }

  function reset() {
    clearReader();
    props.onReset();
  }

  async function copyMessage() {
    try {
      await navigator.clipboard.writeText(revealed()!);
      setCopied(true);
      clearTimeout(copyTimer);
      copyTimer = setTimeout(() => setCopied(false), 2500);
    } catch {
      setError('Copy is unavailable. You can select and copy the message.');
    }
  }

  const title = () =>
    revealed() !== null
      ? destination()
        ? 'Redirecting…'
        : 'Message decrypted'
      : payload()
        ? ready()
          ? waitingBeacon()
            ? 'Waiting to unlock'
            : 'Unlock message'
          : 'Message locked'
        : 'Open a message';

  return (
    <>
      <section class="intro flex flex-col justify-between gap-5 md:flex-row md:items-end">
        <div>
          <p class="eyebrow mb-4">
            <span class="tiny-line" /> TEXT DECRYPTION
          </p>
          <h1 class="open-title">{title()}</h1>
        </div>
        <p class="intro-description">
          {revealed() !== null
            ? destination()
              ? 'Opening the URL from this message.'
              : 'Your decrypted message is shown below.'
            : payload()
              ? 'Available after the unlock time, with a PIN if required.'
              : 'Paste a link or payload, upload a QR image, or scan with your camera.'}
        </p>
      </section>
      <Show
        when={payload()}
        fallback={
          <div class="workspace grid lg:grid-cols-[1.05fr_1fr]">
            <form
              class="composer open-composer"
              onSubmit={(e) => {
                e.preventDefault();
                load(source());
              }}
            >
              <label for="payload-input" class="section-label">
                <span class="step">01</span> Message source
              </label>
              <p class="mt-4 text-sm leading-6 text-muted">
                Decryption happens in your browser.
              </p>
              <label for="payload-input" class="field-label mt-7">
                Link or payload
              </label>
              <textarea
                id="payload-input"
                class="payload-input"
                placeholder="Paste a link or message payload…"
                value={source()}
                onInput={(e) => setSource(e.currentTarget.value)}
                required
                spellcheck={false}
              />
              <Show when={error()}>
                <p class="error-message mt-4" role="alert">
                  {error()}
                </p>
              </Show>
              <button
                type="submit"
                class="primary-button mt-4 w-full"
                disabled={!source().trim()}
              >
                <span>Open message</span>
                <Icon name="arrow" />
              </button>
              <ScanInput onRead={load} />
            </form>
            <div class="preview-panel">
              <div class="preview-empty">
                <div class="preview-topline">
                  <span>QR INPUT</span>
                  <Icon name="scan" class="h-4 w-4" />
                </div>
                <Envelope />
                <div class="preview-caption">
                  <h2>Open from a QR code</h2>
                  <p>Upload an image or use your camera.</p>
                </div>
                <div class="preview-bottomline">
                  <span>DECRYPTED LOCALLY</span>
                  <Icon name="lock" class="h-4 w-4" />
                  <span>NO MESSAGE UPLOADS</span>
                </div>
              </div>
            </div>
          </div>
        }
      >
        {(current) => (
          <div class="received-layout">
            <div class="received-card animate-arrive">
              <div class="preview-topline">
                <span class="flex items-center gap-2">
                  <span class="status-dot" />{' '}
                  {revealed() !== null ? 'DECRYPTED' : 'ENCRYPTED MESSAGE'}
                </span>
                <Icon
                  name={revealed() !== null ? 'mail' : 'clock'}
                  class="h-4 w-4"
                />
              </div>
              <Show when={current().v === 1 && current().u !== null}>
                <p class="field-help mt-5">
                  Legacy message: its countdown can be bypassed.
                </p>
              </Show>
              <Show
                when={revealed() !== null}
                fallback={
                  <>
                    <Show
                      when={!ready()}
                      fallback={
                        <div class="ready-symbol">
                          <Icon
                            name={current().p ? 'lock' : 'mail'}
                            class="h-12 w-12"
                          />
                        </div>
                      }
                    >
                      <div class="countdown-header">
                        <span class="eyebrow">SCHEDULED UNLOCK</span>
                        <h2>Time remaining</h2>
                        <p>
                          Unlocks on
                          <br />
                          <strong>
                            {new Date(current().u!).toLocaleString([], {
                              dateStyle: 'long',
                              timeStyle: 'short',
                            })}
                          </strong>
                        </p>
                      </div>
                      <div
                        class="countdown"
                        role="timer"
                        aria-label="Time until message opens"
                      >
                        <For
                          each={
                            ['days', 'hours', 'minutes', 'seconds'] as const
                          }
                        >
                          {(unit) => (
                            <div>
                              <span>{remaining()[unit]}</span>
                              <small>{unit}</small>
                            </div>
                          )}
                        </For>
                      </div>
                      <p class="countdown-note">
                        Keep this page open or return after the unlock time.
                        <Show when={current().p}> A PIN is also required.</Show>
                      </p>
                    </Show>
                    <Show when={ready()}>
                      <Show
                        when={current().p}
                        fallback={
                          <p class="text-center text-muted">
                            {busy()
                              ? current().v === 2
                                ? 'Requesting the unlock beacon…'
                                : 'Decrypting message…'
                              : waitingBeacon()
                                ? 'Your message is still locked.'
                                : 'Your message is ready.'}
                          </p>
                        }
                      >
                        <form class="pin-form" onSubmit={reveal}>
                          <h2>PIN required</h2>
                          <p>Enter the sender’s PIN to decrypt this message.</p>
                          <label for="enter-pin" class="field-label text-left">
                            Enter PIN
                          </label>
                          <input
                            id="enter-pin"
                            type="password"
                            inputmode="numeric"
                            autocomplete="off"
                            pattern="[0-9]{4,12}"
                            minlength="4"
                            maxlength="12"
                            required
                            placeholder="4–12 digits"
                            value={pin()}
                            disabled={busy()}
                            onInput={(e) => setPin(e.currentTarget.value)}
                          />
                          <button
                            class="primary-button mt-4 w-full"
                            disabled={busy() || !pin()}
                            type="submit"
                          >
                            <span>
                              {busy() ? 'Decrypting…' : 'Decrypt message'}
                            </span>
                            <Icon name="arrow" />
                          </button>
                        </form>
                      </Show>
                    </Show>
                    <Show when={waitingBeacon()}>
                      <div class="beacon-status">
                        <p role="status">
                          {waitingBeacon()} We’ll retry automatically.
                        </p>
                        <button
                          type="button"
                          class="secondary-button mt-4"
                          disabled={busy()}
                          onClick={() => void reveal()}
                        >
                          <Icon name="clock" /> Check again
                        </button>
                      </div>
                    </Show>
                  </>
                }
              >
                <div class="revealed-heading">
                  <span class="eyebrow">MESSAGE</span>
                  <Icon name="check" class="h-6 w-6" />
                </div>
                <Show
                  when={destination()}
                  fallback={
                    <div
                      class="revealed-message"
                      data-testid="revealed-message"
                      innerHTML={renderedMessage()}
                    />
                  }
                >
                  {(url) => (
                    <div class="redirect-status" role="status">
                      <p>Redirecting to the message URL.</p>
                      <a
                        href={url()}
                        rel="noopener noreferrer"
                        class="text-button mt-3"
                      >
                        Open link <Icon name="arrow" class="h-4 w-4" />
                      </a>
                    </div>
                  )}
                </Show>
                <div class="message-signoff">
                  <span>Decrypted locally</span>
                  <button
                    type="button"
                    class="text-button"
                    onClick={copyMessage}
                  >
                    <Icon name={copied() ? 'check' : 'copy'} class="h-4 w-4" />
                    {copied() ? 'Copied' : 'Copy text'}
                  </button>
                </div>
              </Show>
              <Show when={error()}>
                <p class="error-message mt-5" role="alert">
                  {error()}
                </p>
              </Show>
              <div class="received-bottom">
                <span>
                  {current().v === 2
                    ? current().p
                      ? 'PIN + DRAND TIME LOCK'
                      : 'DRAND TIME LOCK'
                    : current().p
                      ? 'PIN PROTECTED'
                      : 'NO PIN REQUIRED'}
                </span>
                <span>ENCRYPT THIS ✳</span>
              </div>
            </div>
            <button
              class="text-button mx-auto mt-6"
              type="button"
              onClick={reset}
            >
              <Icon name="scan" class="h-4 w-4" /> Open another message
            </button>
          </div>
        )}
      </Show>
    </>
  );
}
