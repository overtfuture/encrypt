import { Show, createSignal, onCleanup, onMount } from 'solid-js';
import { GuestMessageOpener } from './components/GuestMessage';
import IdentityMessages from './components/IdentityMessages';
import { guestPrefix } from './lib/guest-message';
import { STAGED_LINKS_KEY } from './lib/identity/storage';

function reloadAfterReset() {
  try {
    sessionStorage.removeItem(STAGED_LINKS_KEY);
  } catch {
    // Session storage can be unavailable in this browser.
  }
  if (location.hash) {
    history.replaceState(
      history.state,
      '',
      location.pathname + location.search,
    );
  }
  location.reload();
}

function takeGuestFragment() {
  const { hash, pathname, search } = location;
  if (!guestPrefix(hash.slice(1))) return;
  history.replaceState(history.state, '', pathname + search);
  return { input: hash.slice(1) };
}

export default function App() {
  const [guest, setGuest] = createSignal(takeGuestFragment());
  let resetChannel: BroadcastChannel | undefined;

  onMount(() => {
    const receiveFragment = () => {
      const incoming = takeGuestFragment();
      if (incoming || (guest() && location.hash)) setGuest(incoming);
    };
    const clearGuest = () => {
      if (guest()) setGuest({ input: '' });
    };
    if (typeof BroadcastChannel === 'function') {
      resetChannel = new BroadcastChannel('encrypt-this/site-data');
      resetChannel.onmessage = (event) => {
        if (event.data === 'reset') reloadAfterReset();
      };
    }
    window.addEventListener('hashchange', receiveFragment);
    window.addEventListener('pagehide', clearGuest);
    onCleanup(() => {
      resetChannel?.close();
      window.removeEventListener('hashchange', receiveFragment);
      window.removeEventListener('pagehide', clearGuest);
    });
  });

  return (
    <div class="site-shell">
      <header class="site-header">
        <span class="wordmark">
          encrypt this<span aria-hidden="true">✳</span>
        </span>
      </header>
      <Show
        when={guest()}
        keyed
        fallback={
          <IdentityMessages
            onOpenGuest={(input) => setGuest({ input })}
            onResetData={() => {
              resetChannel?.postMessage('reset');
              reloadAfterReset();
            }}
          />
        }
      >
        {(opened) => (
          <GuestMessageOpener
            input={opened.input}
            close={() => setGuest(undefined)}
          />
        )}
      </Show>
      <footer class="site-footer">
        Encrypted in this browser. Shared by you.
      </footer>
    </div>
  );
}
