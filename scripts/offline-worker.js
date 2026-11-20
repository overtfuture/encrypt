const root = new URL(self.registration.scope);
const cachePrefix = `encrypt-app-shell:${root.pathname}:`;
const cacheName = cachePrefix + release;
const assets = new Map(
  files.map(([path, integrity]) => [new URL(path, root).href, integrity]),
);
const index = new URL('index.html', root);

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(cacheName);
      try {
        // Cache one complete release. A partial deployment or offline update must leave the current one usable.
        await cache.addAll(
          [...assets].map(
            ([url, integrity]) =>
              new Request(url, {
                integrity,
                cache: 'reload',
                redirect: 'error',
              }),
          ),
        );
      } catch (error) {
        await caches.delete(cacheName);
        throw error;
      }
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const obsolete = (await caches.keys()).filter(
        (name) => name.startsWith(cachePrefix) && name !== cacheName,
      );
      await Promise.all(obsolete.map((name) => caches.delete(name)));
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== root.origin) return;

  let key = url.href;
  if (request.mode === 'navigate') {
    if (url.pathname !== root.pathname && url.pathname !== index.pathname)
      return;
    key = root.href;
  } else if (!assets.has(key)) return;

  event.respondWith(
    (async () => {
      const cache = await caches.open(cacheName);
      return (await cache.match(key)) ?? fetch(request);
    })(),
  );
});
