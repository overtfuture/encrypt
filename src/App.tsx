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
          <span class="header-note">FOR THE MOMENTS IN BETWEEN.</span>
          <button
            class="about-button"
            type="button"
            aria-expanded={about()}
            aria-controls="about-panel"
            onClick={() => setAbout(!about())}
          >
            A little about this <span>{about() ? '−' : '+'}</span>
          </button>
        </div>
      </header>
      <Show when={about()}>
        <aside class="about-panel animate-arrive" id="about-panel">
          <div>
            <h2>A little note, a little later.</h2>
            <p>
              encrypt this turns words into a shareable time capsule. Send a
              link or QR, set a countdown if you like, and add a PIN when the
              message is just for someone.
            </p>
          </div>
          <div>
            <p>
              Messages live in the link, with no accounts or uploads. Anyone
              with an unprotected link can read its message once it opens. PINs
              help with privacy, but short codes can be guessed.
            </p>
            <p>
              New dated messages use drand’s public unlock beacon to enforce
              their opening time. The countdown runs locally; opening needs an
              internet connection. Your message and PIN stay in your browser.
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
          <span>A little something. A little later.</span>
        </div>
        <span class="footer-fineprint">
          A little countdown. A real time lock. Encrypted in your browser.
        </span>
        <span class="footer-signature">MADE FOR THE MOMENT.</span>
      </footer>
    </div>
  );
}
