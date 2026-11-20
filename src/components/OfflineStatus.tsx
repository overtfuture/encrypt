import { createSignal, onCleanup, onMount, Show } from 'solid-js';

export default function OfflineStatus() {
  const [state, setState] = createSignal<'saving' | 'ready' | 'unavailable'>(
    'saving',
  );
  const [offline, setOffline] = createSignal(!navigator.onLine);
  const [waiting, setWaiting] = createSignal(false);

  onMount(() => {
    const workers = navigator.serviceWorker;
    if (!workers) {
      setState('unavailable');
      return;
    }

    const script = new URL(`${import.meta.env.BASE_URL}sw.js`, location.href);
    const isControlled = () => workers.controller?.scriptURL === script.href;
    if (isControlled()) setState('ready');
    const lifetime = new AbortController();
    const { signal } = lifetime;
    onCleanup(() => lifetime.abort());

    const updateConnectivity = () => setOffline(!navigator.onLine);
    window.addEventListener('online', updateConnectivity, { signal });
    window.addEventListener('offline', updateConnectivity, { signal });

    async function register() {
      try {
        const registration = await workers.register(script, {
          updateViaCache: 'none',
        });
        if (signal.aborted) return;

        function readRegistration() {
          if (isControlled()) setState('ready');
          setWaiting(Boolean(registration.waiting && registration.active));
        }

        function watchInstall() {
          const installing = registration.installing;
          installing?.addEventListener(
            'statechange',
            () => {
              if (installing.state === 'redundant' && !registration.active)
                setState('unavailable');
              readRegistration();
            },
            { signal },
          );
        }

        registration.addEventListener('updatefound', watchInstall, { signal });
        workers.addEventListener('controllerchange', readRegistration, {
          signal,
        });
        window.addEventListener(
          'online',
          () => void registration.update().catch(() => {}),
          { signal },
        );
        watchInstall();
        readRegistration();
      } catch {
        if (!signal.aborted && !isControlled()) setState('unavailable');
      }
    }

    void register();
  });

  const label = () => {
    switch (state()) {
      case 'saving':
        return 'Saving app for offline use…';
      case 'ready':
        return offline() ? 'Offline · using saved app' : 'Ready offline';
      case 'unavailable':
        return 'Offline access unavailable. Reopen while connected to try again.';
    }
  };

  return (
    <div class="offline-status" aria-live="polite">
      <span classList={{ 'offline-active': state() === 'ready' && offline() }}>
        {label()}
      </span>
      <Show when={waiting()}>
        <span>
          Update ready. Close all encrypt tabs and windows, then reopen.
        </span>
      </Show>
    </div>
  );
}
