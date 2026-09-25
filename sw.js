/* Keeps the app shell available offline. Trip data is cached by the app itself, never here. */
const CACHE = 'sdtrip-v2';
const SHELL = ['./', 'index.html', 'styles.css?v=9', 'app.js?v=9', 'config.js?v=9', 'manifest.webmanifest',
  'icons/icon-192.png', 'icons/apple-touch-icon.png',
  'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.js',
  'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.css'];
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  const shell = u.origin === location.origin || u.host === 'cdnjs.cloudflare.com' || u.host === 'fonts.googleapis.com' || u.host === 'fonts.gstatic.com';
  if (!shell) return; // map tiles and the trip script go straight to the network
  e.respondWith(
    fetch(e.request).then((res) => {
      if (res.ok || res.type === 'opaque') { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
      return res;
    }).catch(() => caches.match(e.request).then((r) => r || caches.match('index.html')))
  );
});
