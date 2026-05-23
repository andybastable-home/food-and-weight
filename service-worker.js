// Bump CACHE_VERSION whenever shell files change so updates roll cleanly.
const CACHE_VERSION = 'v0.17.1';
const CACHE_NAME = `fw-shell-${CACHE_VERSION}`;

const DEXIE_URL = 'https://unpkg.com/dexie@4.4.2/dist/dexie.min.js';
const UFUZZY_URL = 'https://unpkg.com/@leeoniya/ufuzzy@1.0.18/dist/uFuzzy.iife.min.js';

const SHELL = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './sync.js',
  './manifest.json',
  './icons/icon.svg',
  './assets/fonts/fraunces-latin.woff2',
  DEXIE_URL,
  UFUZZY_URL,
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

// Network-first with cache fallback. While developing this means updates land on
// the next online refresh instead of needing a double-refresh. When offline,
// requests fall back to the cache so the app stays usable.
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (response && response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        }
        return response;
      })
      .catch(() => caches.match(event.request).then((cached) => {
        if (cached) return cached;
        if (event.request.mode === 'navigate') return caches.match('./index.html');
        return Response.error();
      }))
  );
});
