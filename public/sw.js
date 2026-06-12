// Service Worker mínimo para habilitar instalación PWA
const CACHE = 'hiwifi-v1';

self.addEventListener('install', e => {
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(clients.claim());
});

// Sin cache offline — siempre red (el dispositivo necesita datos en tiempo real)
self.addEventListener('fetch', e => {
  e.respondWith(fetch(e.request).catch(() => caches.match(e.request)));
});
