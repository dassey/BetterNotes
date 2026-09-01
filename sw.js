/* BetterNotes — service worker. Precache the whole app so it runs fully
   offline; cache-first for app files, no runtime requests to anywhere else. */
'use strict';

const VERSION = 'bn-v0.5.0';
const ASSETS = [
  './',
  './index.html',
  './css/app.css',
  './js/util.js',
  './js/ink.js',
  './js/store.js',
  './js/settings.js',
  './js/canvas.js',
  './js/editor.js',
  './js/home.js',
  './js/app.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png'
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(VERSION).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;

  if (req.mode === 'navigate') {
    e.respondWith(
      caches.match('./index.html').then((r) => r || fetch(req))
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
    }))
  );
});
