const APP_CACHE = 'retro-ds-pwa-v3';
const CORE_CACHE = 'retro-ds-core-v2';

const ASSETS = [
  './',
  './index.html',
  './ejs-host.html',
  './css/style.css',
  './js/storage.js',
  './js/gamepad.js',
  './js/emulator.js',
  './js/app.js',
  './manifest.json',
  './icons/icon.svg'
];

// CDN hosts used by EmulatorJS and DS WASM cores (DeSmuME 2015 / DeSmuME / melonDS)
const CORE_CDN_HOSTS = [
  'cdn.emulatorjs.org',
  'esm.run',
  'cdn.jsdelivr.net',
  'unpkg.com'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(APP_CACHE).then((cache) => cache.addAll(ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== APP_CACHE && key !== CORE_CACHE)
          .map((key) => caches.delete(key))
      )
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;

  const url = new URL(event.request.url);

  // 1. Same-origin app assets: stale-while-revalidate
  if (url.origin === self.location.origin) {
    event.respondWith(
      caches.open(APP_CACHE).then((cache) =>
        cache.match(event.request).then((cached) => {
          const fetched = fetch(event.request)
            .then((response) => {
              if (response && response.status === 200) {
                cache.put(event.request, response.clone());
              }
              return response;
            })
            .catch(() => cached);
          return cached || fetched;
        })
      )
    );
    return;
  }

  // 2. Emulator cores & WASM files from CDN: cache-first for full offline play
  if (CORE_CDN_HOSTS.includes(url.hostname)) {
    event.respondWith(
      caches.open(CORE_CACHE).then((cache) =>
        cache.match(event.request).then((cached) => {
          if (cached) return cached;
          return fetch(event.request).then((response) => {
            if (response && (response.status === 200 || response.type === 'opaque')) {
              cache.put(event.request, response.clone());
            }
            return response;
          });
        })
      )
    );
  }
});

