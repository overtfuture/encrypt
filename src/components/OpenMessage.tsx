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
      ? 'This moment is yours.'
      : payload()
        ? ready()
          ? waitingBeacon()
            ? 'A little patience.'
            : 'Just for you.'
          : 'A little patience.'
        : 'Something’s waiting.';

  return (
    <>
      <section class="intro flex flex-col justify-between gap-5 md:flex-row md:items-end">
        <div>
          <p class="eyebrow mb-4">
            <span class="tiny-line" /> SOMEONE LEFT YOU SOMETHING.
          </p>
          <h1 class="open-title">{title()}</h1>
        </div>
        <p class="intro-description">
          {revealed() !== null
            ? 'A little message. Right on time.'
            : payload()
              ? 'Some things are better when you wait.'
              : 'Have a link or a mysterious little square?\nYou’re in the right place.'}
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
                <span class="step">01</span> Find your message
              </label>
              <p class="mt-4 text-sm leading-6 text-muted">
                Paste a share link or payload below.
                <br />
                The surprise stays right here in your browser.
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
                  <span>SOMETHING WORTH OPENING</span>
                  <span>↗</span>
                </div>
                <Envelope />
                <div class="preview-caption">
                  <span class="eyebrow">A NOTE THAT FOUND ITS WAY TO YOU.</span>
                  <h2>
                    A small surprise.
                    <br />A lovely little pause.
                  </h2>
                  <p>
                    Scan, paste, or upload.
                    <br />
                    We’ll take care of the reveal.
                  </p>
                </div>
                <div class="preview-bottomline">
                  <span>FROM SOMEONE</span>
                  <Icon name="spark" class="h-4 w-4" />
                  <span>TO YOU</span>
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
                  {revealed() !== null
                    ? 'DELIVERED TO THIS MOMENT'
                    : 'A LITTLE SOMETHING FOR YOU'}
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
                        <span class="eyebrow">
                          GOOD THINGS TAKE A LITTLE TIME
                        </span>
                        <h2>Not quite yet.</h2>
                        <p>
                          Your message opens on
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
                        Leave this page open. We’ll reveal it when it’s time.
                        <Show when={current().p}>
                          {' '}
                          You’ll also need the PIN.
                        </Show>
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
                                : 'Opening your message…'
                              : waitingBeacon()
                                ? 'Your message is still sealed.'
                                : 'Your message is ready.'}
                          </p>
                        }
                      >
                        <form class="pin-form" onSubmit={reveal}>
                          <h2>One little secret.</h2>
                          <p>
                            This message needs a PIN.
                            <br />
                            Ask the sender if you don’t have it.
                          </p>
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
                            placeholder="Your secret code"
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
                              {busy() ? 'Opening…' : 'Reveal message'}
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
                  <span class="eyebrow">THE WAIT IS OVER.</span>
                  <Icon name="spark" class="h-6 w-6" />
                </div>
                <div class="revealed-message" data-testid="revealed-message">
                  {revealed()}
                </div>
                <div class="message-signoff">
                  <span>Some words were meant for this moment.</span>
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
                      : 'A LITTLE TRUST GOES A LONG WAY'}
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
