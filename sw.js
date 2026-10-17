/* BetterNotes — service worker. Precache the whole app so it runs fully
   offline; cache-first for app files, no runtime requests to anywhere else. */
'use strict';

const VERSION = 'bn-v0.11.0';
const VENDOR = 'bn-vendor-v1'; // speech runtime from the CDN: versioned, immutable, kept across app updates
const ASSETS = [
  './',
  './index.html',
  './css/app.css',
  './js/util.js',
  './js/ink.js',
  './js/store.js',
  './js/settings.js',
  './js/canvas.js',
  './js/pdf.js',
  './js/transcribe.js',
  './js/capture-worklet.js',
  './js/editor.js',
  './js/home.js',
  './js/app.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png'
];

// Multithreaded WebAssembly (speech recognition) needs a cross-origin-isolated page.
// GitHub Pages cannot send these headers, so every response we serve carries them.
const ISOLATION = { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' };
function isolate(res) {
  if (!res || res.type === 'opaque' || res.status === 0) return res;
  const headers = new Headers(res.headers);
  for (const k in ISOLATION) headers.set(k, ISOLATION[k]);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(VERSION).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION && k.startsWith('bn-v') && !k.startsWith('bn-vendor')).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) {
    if (url.hostname === 'cdn.jsdelivr.net') {
      e.respondWith(
        caches.open(VENDOR).then((c) => c.match(req).then((r) => r || fetch(req).then((res) => {
          if (res && res.ok) c.put(req, res.clone());
          return res;
        })))
      );
    }
    return;
  }

  if (req.mode === 'navigate') {
    e.respondWith(
      caches.match('./index.html').then((r) => r || fetch(req)).then(isolate)
    );
    return;
  }
  e.respondWith(
    caches.match(req, { ignoreSearch: true }).then((r) => r || fetch(req).then((res) => {
      // Cache successful same-origin fetches so updates heal the cache.
      if (res && res.ok) {
        const copy = res.clone();
        caches.open(VERSION).then((c) => c.put(req, copy));
      }
      return res;
    })).then(isolate)
  );
});
