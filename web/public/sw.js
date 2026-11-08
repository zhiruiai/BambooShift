// Cache only the public offline notice. Private API responses and chats are never cached here.
const CACHE = 'openbot-offline-v3';
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(['/offline.html', '/offline.js']))
      .then(() => self.skipWaiting()),
  );
});
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key.startsWith('openbot-offline-') && key !== CACHE)
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (
    event.request.method === 'GET' &&
    url.origin === self.location.origin &&
    url.pathname === '/offline.js'
  ) {
    event.respondWith(fetch(event.request).catch(() => caches.match('/offline.js')));
    return;
  }
  if (
    event.request.method !== 'GET' ||
    event.request.mode !== 'navigate' ||
    url.origin !== self.location.origin ||
    url.pathname.startsWith('/api/')
  )
    return;
  event.respondWith(
    fetch(event.request).catch(
      async () =>
        (await caches.match('/offline.html')) ||
        new Response(
          'PandaMate 暂时无法连接，请联网后重试。 / PandaMate is unavailable. Reconnect and try again.',
          {
            status: 503,
            headers: { 'Content-Type': 'text/plain; charset=utf-8' },
          },
        ),
    ),
  );
});
