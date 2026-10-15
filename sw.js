/* Network-first service worker: always fresh when online, works offline. */
const CACHE = 'reviseforfun-v2';
const SHELL = ['./', 'index.html', 'css/style.css', 'css/features.css', 'js/core.js', 'js/api.js', 'js/app.js',
    'js/cards.js', 'js/play.js', 'js/tools.js', 'js/community.js', 'js/boot.js', 'data/library.json', 'icons/icon.svg'];

self.addEventListener('install', (e) => {
    e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
    e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
    const req = e.request;
    const url = new URL(req.url);
    // Never cache API calls or cross-origin requests (fonts etc. are fine to fail offline).
    if (req.method !== 'GET' || url.origin !== location.origin || url.pathname.includes('/api/')) return;
    e.respondWith(
        fetch(req).then((res) => {
            if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
            return res;
        }).catch(() => caches.match(req).then((hit) => hit || caches.match('index.html')))
    );
});
