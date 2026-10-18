import { createSignal, Show, onCleanup } from 'solid-js';
import QRCode from 'qrcode';
import {
  MAX_MESSAGE_BYTES,
  parsePayload,
  sealMessage,
  shareLink,
} from '../lib/payload';
import { Icon } from './Icon';
import { Envelope } from './Envelope';

type Sealed = {
  link: string;
  qr: string | null;
  opens: number | null;
  protected: boolean;
};

function localDate(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export default function CreateMessage() {
  const [text, setText] = createSignal('');
  const [scheduled, setScheduled] = createSignal(false);
  const [date, setDate] = createSignal('');
  const [protectedByPin, setProtectedByPin] = createSignal(false);
  const [pin, setPin] = createSignal('');
  const [showPin, setShowPin] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal('');
  const [result, setResult] = createSignal<Sealed | null>(null);
  const [copyState, setCopyState] = createSignal('');
  let copyTimer: ReturnType<typeof setTimeout> | undefined;
  let active = true;
  let shareSection: HTMLDivElement | undefined;
  onCleanup(() => {
    active = false;
    clearTimeout(copyTimer);
  });
  const bytes = () => new TextEncoder().encode(text()).length;
  const edited = () => {
    setResult(null);
    setError('');
    setCopyState('');
  };

  async function create(event: SubmitEvent) {
    event.preventDefault();
    setError('');
    setBusy(true);
    try {
      const opens = scheduled() ? new Date(date()).getTime() : null;
      if (opens !== null && (!Number.isFinite(opens) || opens <= Date.now()))
        throw new Error('Choose an opening time in the future.');
      if (protectedByPin() && !/^\d{4,12}$/.test(pin()))
        throw new Error('Choose a PIN with 4–12 digits.');
      const encoded = await sealMessage(text(), {
        unlockAt: opens,
        pin: protectedByPin() ? pin() : '',
      });
      const link = shareLink(encoded, window.location.href);
      let qr: string | null = null;
      // A message can fit a link even when it exceeds the capacity of one QR.
      try {
        qr = await QRCode.toDataURL(link, {
          errorCorrectionLevel: 'M',
          margin: 4,
          width: 1000,
          color: { dark: '#000000', light: '#ffffff' },
        });
      } catch {
        /* Preserve the link when a QR cannot be generated. */
      }
      if (!active) return;
      setResult({
        link,
        qr,
        opens: parsePayload(encoded).u,
        protected: protectedByPin(),
      });
      if (window.matchMedia('(max-width: 900px)').matches)
        requestAnimationFrame(() =>
          shareSection?.scrollIntoView({ behavior: 'smooth', block: 'start' }),
        );
    } catch (err) {
      if (active)
        setError(
          err instanceof Error
            ? err.message
            : 'Could not create this message. Please try again.',
        );
    } finally {
      if (active) setBusy(false);
    }
  }

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(result()!.link);
      setCopyState('Link copied');
      clearTimeout(copyTimer);
      copyTimer = setTimeout(() => setCopyState(''), 2500);
    } catch {
      setCopyState('Select and copy the link below.');
    }
  }

  return (
    <>
      <section class="intro flex flex-col justify-between gap-5 md:flex-row md:items-end">
        <div>
          <p class="eyebrow mb-4">
            <span class="tiny-line" /> A MESSAGE. A MOMENT. A LITTLE MAGIC.
          </p>
          <h1>
            Good things
            <br />
            come <em>later.</em>
          </h1>
        </div>
        <p class="intro-description">
          A birthday wish. A secret plan. A note to your future self.
          <br class="hidden lg:block" /> Seal a little something. Let the moment
          open it.
        </p>
      </section>

      <div class="workspace grid lg:grid-cols-[1.05fr_1fr]">
        <form class="composer" onSubmit={create}>
          <fieldset disabled={busy()} class="min-w-0">
            <div class="flex items-center justify-between gap-3">
              <label class="section-label" for="message">
                <span class="step">01</span> Your message
              </label>
              <span class="small-note">Just between you & later.</span>
            </div>
            <div class="message-field">
              <textarea
                id="message"
                aria-label="Your message"
                placeholder={'Dear later,\nI have a little something for you…'}
                value={text()}
                onInput={(e) => {
                  setText(e.currentTarget.value);
                  edited();
                }}
                required
                spellcheck="true"
              />
              <div class="flex justify-between gap-3 px-4 pb-3 text-xs text-muted">
                <span>Make it a moment worth waiting for.</span>
                <span
                  classList={{ 'text-accent': bytes() > MAX_MESSAGE_BYTES }}
                >
                  {text().length.toLocaleString()} characters
                </span>
              </div>
            </div>
            <div class="settings-heading">
              <span class="section-label">
                <span class="step">02</span> Make it yours
              </span>
              <span class="small-note">Both optional</span>
            </div>
            <div class="option-block">
              <div class="flex items-center gap-3">
                <span class="option-icon">
                  <Icon name="clock" />
                </span>
                <div class="flex-1">
                  <span class="option-title" id="date-title">
                    Set an opening time
                  </span>
                  <p class="option-description">
                    Give them something to count down to.
                  </p>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={scheduled()}
                  aria-labelledby="date-title"
                  class="toggle"
                  onClick={() => {
                    setScheduled(!scheduled());
                    if (!date())
                      setDate(localDate(new Date(Date.now() + 86_400_000)));
                    edited();
                  }}
                >
                  <span />
                </button>
              </div>
              <Show when={scheduled()}>
                <div class="option-detail">
                  <label for="opening" class="field-label">
                    Opening date and time
                  </label>
                  <input
                    id="opening"
                    type="datetime-local"
                    value={date()}
                    required
                    onInput={(e) => {
                      setDate(e.currentTarget.value);
                      edited();
                    }}
                  />
                  <div class="mt-3 flex flex-wrap gap-2">
                    {[
                      { label: 'In a minute', ms: 60_000 },
                      { label: 'Tomorrow', ms: 86_400_000 },
                      { label: 'In a week', ms: 604_800_000 },
                    ].map((preset) => (
                      <button
                        type="button"
                        class="preset"
                        onClick={() => {
                          setDate(localDate(new Date(Date.now() + preset.ms)));
                          edited();
                        }}
                      >
                        {preset.label}
                      </button>
                    ))}
                  </div>
                  <p class="field-help">
                    Your local time:{' '}
                    {Intl.DateTimeFormat()
                      .resolvedOptions()
                      .timeZone.replaceAll('_', ' ')}
                    .
                  </p>
                  <p class="field-help">
                    Secured with drand. Opening needs an internet connection and
                    may take a few extra seconds.
                  </p>
                </div>
              </Show>
            </div>
            <div class="option-block">
              <div class="flex items-center gap-3">
                <span class="option-icon">
                  <Icon name="lock" />
                </span>
                <div class="flex-1">
                  <span class="option-title" id="pin-title">
                    Require a PIN
                  </span>
                  <p class="option-description">
                    For a secret that’s just a little more secret.
                  </p>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={protectedByPin()}
                  aria-labelledby="pin-title"
                  class="toggle"
                  onClick={() => {
                    setProtectedByPin(!protectedByPin());
                    setPin('');
                    edited();
                  }}
                >
                  <span />
                </button>
              </div>
              <Show when={protectedByPin()}>
                <div class="option-detail">
                  <label for="choose-pin" class="field-label">
                    Choose a PIN
                  </label>
                  <div class="relative">
                    <input
                      id="choose-pin"
                      class="pr-12!"
                      type={showPin() ? 'text' : 'password'}
                      inputmode="numeric"
                      pattern="[0-9]{4,12}"
                      minlength="4"
                      maxlength="12"
                      autocomplete="new-password"
                      value={pin()}
                      placeholder="4–12 digits"
                      required
                      onInput={(e) => {
                        setPin(e.currentTarget.value);
                        edited();
                      }}
                    />
                    <button
                      type="button"
                      class="input-icon"
                      aria-label={showPin() ? 'Hide PIN' : 'Show PIN'}
                      aria-pressed={showPin()}
                      onClick={() => setShowPin(!showPin())}
                    >
                      <Icon name="eye" />
                    </button>
                  </div>
                  <p class="field-help">
                    Longer PINs are stronger. Share yours separately; it isn’t
                    in the link.
                  </p>
                </div>
              </Show>
            </div>
            <Show when={error()}>
              <p class="error-message mt-4" role="alert">
                {error()}
              </p>
            </Show>
            <button
              class="primary-button mt-7 w-full"
              type="submit"
              disabled={busy() || !text().trim() || bytes() > MAX_MESSAGE_BYTES}
            >
              <span>{busy() ? 'Sealing your message…' : 'Seal & share'}</span>
              <Icon name={busy() ? 'clock' : 'arrow'} />
            </button>
            <Show when={bytes() > MAX_MESSAGE_BYTES}>
              <p class="error-message mt-3" role="alert">
                This message is too long. Keep it under 16 KB.
              </p>
            </Show>
            <p class="under-button">
              <Icon name="lock" class="h-3.5 w-3.5 shrink-0" /> Made in your
              browser. Stored in your link. Never on a server.
            </p>
          </fieldset>
        </form>

        <div class="preview-panel" ref={shareSection} aria-live="polite">
          <Show
            when={result()}
            fallback={
              <div class="preview-empty">
                <div class="preview-topline">
                  <span>YOUR LITTLE TIME CAPSULE</span>
                  <span>№ 001</span>
                </div>
                <Envelope />
                <div class="preview-caption">
                  <span class="eyebrow">
                    A SMALL GESTURE. A PERFECT MOMENT.
                  </span>
                  <h2>
                    Some words
                    <br />
                    are worth the wait.
                  </h2>
                  <p>
                    Your share link and QR code will appear here.
                    <br />
                    Send a link, leave a card, make someone’s day.
                  </p>
                </div>
                <div class="preview-bottomline">
                  <span>SEALED WITH INTENTION</span>
                  <Icon name="spark" class="h-4 w-4" />
                  <span>OPENED WITH A SMILE</span>
                </div>
              </div>
            }
          >
            {(sealed) => (
              <div class="share-result animate-arrive">
                <div class="preview-topline">
                  <span class="flex items-center gap-2">
                    <span class="status-dot" /> READY TO PASS ALONG
                  </span>
                  <Icon name="check" class="h-4 w-4" />
                </div>
                <div class="share-heading">
                  <h2>
                    A little magic,
                    <br />
                    <em>ready to share.</em>
                  </h2>
                  <p>Send the link. Or let the QR do the talking.</p>
                </div>
                <Show
                  when={sealed().qr}
                  fallback={
                    <div class="qr-too-large">
                      <Icon name="link" class="h-9 w-9" />
                      <p>
                        This message fits a link, but is too large for one QR
                        code.
                      </p>
                    </div>
                  }
                >
                  <div class="qr-frame">
                    <img
                      src={sealed().qr!}
                      alt="Message QR code"
                      width="240"
                      height="240"
                    />
                    <span>SCAN ME. SAVE THE MOMENT.</span>
                  </div>
                </Show>
                <div class="share-tags">
                  <span>
                    <Icon name="clock" class="h-3.5 w-3.5" />
                    {sealed().opens
                      ? new Date(sealed().opens!).toLocaleString([], {
                          month: 'short',
                          day: 'numeric',
                          hour: 'numeric',
                          minute: '2-digit',
                          year: 'numeric',
                        })
                      : 'Ready to open now'}
                  </span>
                  <Show when={sealed().protected}>
                    <span>
                      <Icon name="lock" class="h-3.5 w-3.5" /> PIN required
                    </span>
                  </Show>
                </div>
                <label for="share-link" class="field-label">
                  Share link
                </label>
                <input
                  id="share-link"
                  value={sealed().link}
                  readonly
                  onFocus={(e) => e.currentTarget.select()}
                  class="share-link-input"
                />
                <div class="mt-3 flex gap-2">
                  <button
                    type="button"
                    class="primary-button flex-1"
                    onClick={copyLink}
                  >
                    <Icon
                      name={copyState() === 'Link copied' ? 'check' : 'copy'}
                    />
                    <span>
                      {copyState() === 'Link copied'
                        ? 'Link copied'
                        : 'Copy link'}
                    </span>
                  </button>
                  <Show when={sealed().qr}>
                    <a
                      class="secondary-button"
                      href={sealed().qr!}
                      download="encrypt-this-message.png"
                    >
                      <Icon name="download" />
                      <span>Save QR code</span>
                    </a>
                  </Show>
                </div>
                <Show when={copyState() && copyState() !== 'Link copied'}>
                  <p class="field-help" role="status">
                    {copyState()}
                  </p>
                </Show>
                <p class="share-footnote">
                  {sealed().protected
                    ? 'Remember to send the PIN separately.'
                    : sealed().opens
                      ? 'Anyone with the link or QR can open it after the unlock time.'
                      : 'Anyone with the link or QR can open this message.'}
                </p>
              </div>
            )}
          </Show>
        </div>
      </div>
    </>
  );
}
