import { createSignal, onMount, onCleanup, Show } from 'solid-js';
import CreateMessage from './components/CreateMessage';
import OpenMessage from './components/OpenMessage';
import { Icon } from './components/Icon';

export default function App() {
  const [mode, setMode] = createSignal<'create' | 'open'>(
    window.location.hash ? 'open' : 'create',
  );
  const [incoming, setIncoming] = createSignal(window.location.hash);
  const [about, setAbout] = createSignal(false);

  onMount(() => {
    const changed = () => {
      setIncoming(window.location.hash);
      if (window.location.hash) setMode('open');
    };
    window.addEventListener('hashchange', changed);
    onCleanup(() => window.removeEventListener('hashchange', changed));
  });

  function clearIncoming() {
    setIncoming('');
    history.replaceState(
      null,
      '',
      window.location.pathname + window.location.search,
    );
  }

  function navigate(next: 'create' | 'open') {
    if (next === mode()) return;
    clearIncoming();
    setMode(next);
  }

  return (
    <div class="site-shell">
      <header class="site-header">
        <a
          class="wordmark"
          href={window.location.pathname}
          aria-label="encrypt this home"
        >
          encrypt this<span>✳</span>
        </a>
        <div class="header-right">
          <span class="header-note">CLIENT-SIDE ENCRYPTION</span>
          <button
            class="about-button"
            type="button"
            aria-expanded={about()}
            aria-controls="about-panel"
            onClick={() => setAbout(!about())}
          >
            How it works <span>{about() ? '−' : '+'}</span>
          </button>
        </div>
      </header>
      <Show when={about()}>
        <aside class="about-panel animate-arrive" id="about-panel">
          <div>
            <h2>Encrypted text sharing</h2>
            <p>
              Encrypt text in your browser and share it as a link or QR code. An
              unlock time and PIN are optional.
            </p>
          </div>
          <div>
            <p>
              The link contains the encrypted message. Without a PIN, anyone
              with the link can read it once unlocked. Short PINs can be
              guessed.
            </p>
            <p>
              Timed messages use drand and need internet access to unlock. Your
              text and PIN stay in your browser.
            </p>
          </div>
        </aside>
      </Show>
      <nav class="mode-nav" aria-label="Message tools">
        <button
          type="button"
          classList={{ active: mode() === 'create' }}
          aria-current={mode() === 'create' ? 'page' : undefined}
          onClick={() => navigate('create')}
        >
          <Icon name="mail" class="h-4 w-4" /> Create a message
        </button>
        <button
          type="button"
          classList={{ active: mode() === 'open' }}
          aria-current={mode() === 'open' ? 'page' : undefined}
          onClick={() => navigate('open')}
        >
          <Icon name="scan" class="h-4 w-4" /> Open a message
        </button>
      </nav>
      <main>
        <Show
          when={mode() === 'create'}
          fallback={
            <OpenMessage incoming={incoming()} onReset={clearIncoming} />
          }
        >
          <CreateMessage />
        </Show>
      </main>
      <footer class="site-footer">
        <div class="flex items-center gap-2">
          <span class="footer-flower">✳</span>
          <span>No accounts or message uploads.</span>
        </div>
        <span class="footer-fineprint">
          Encrypted locally. Shared by link or QR.
        </span>
      </footer>
    </div>
  );
}
