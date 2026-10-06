/* Service Worker: App-Shell offline, Kartenkacheln zwischenspeichern. Version wird vom Server eingesetzt. */
const BUILD = '__BUILD__';
const SHELL = `wf-shell-${BUILD}`;
const TILES = 'wf-tiles-v2';
const MEDIA = 'wf-media-v1';
const PRECACHE = __PRECACHE__;
const TILE_LIMIT = 600;
const MEDIA_LIMIT = 150;

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL);
    // einzeln laden: eine fehlende Datei soll die Installation nicht verhindern
    await Promise.all(PRECACHE.map((url) => cache.add(new Request(url, { cache: 'reload' })).catch(() => {})));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => (k.startsWith('wf-shell-') && k !== SHELL) || k === 'wf-tiles-v1').map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

async function trim(name, limit) {
  const cache = await caches.open(name);
  const keys = await cache.keys();
  if (keys.length > limit) {
    for (const k of keys.slice(0, keys.length - limit)) await cache.delete(k);
  }
}

function isTile(url) {
  return /basemaps\.cartocdn\.com|(^|\.)tile\.openstreetmap\.org/.test(url.hostname);
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Kartenkacheln: erst Cache, im Hintergrund auffrischen
  if (isTile(url)) {
    event.respondWith((async () => {
      const cache = await caches.open(TILES);
      const hit = await cache.match(req);
      const fetching = fetch(req).then((res) => {
        if (res.ok || res.type === 'opaque') { cache.put(req, res.clone()).then(() => trim(TILES, TILE_LIMIT)); }
        return res;
      }).catch(() => null);
      return hit || (await fetching) || Response.error();
    })());
    return;
  }

  // Medien (Fotos/Videos vom Speicher): Cache-first, begrenzt
  if (url.origin !== self.location.origin && /\.(jpe?g|png|webp|mp4|webm|mov)(\?|$)/i.test(url.pathname) && !req.headers.has('range')) {
    event.respondWith((async () => {
      const cache = await caches.open(MEDIA);
      const hit = await cache.match(req);
      if (hit) return hit;
      try {
        const res = await fetch(req);
        if (res.ok) { cache.put(req, res.clone()).then(() => trim(MEDIA, MEDIA_LIMIT)); }
        return res;
      } catch { return Response.error(); }
    })());
    return;
  }

  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/health') || url.pathname === '/ws') return;

  // Titelbilder: Cache-first (URL enthält Versionsnummer)
  if (url.pathname.startsWith('/api/cover/')) {
    event.respondWith((async () => {
      const cache = await caches.open(MEDIA);
      const hit = await cache.match(req);
      if (hit) return hit;
      try {
        const res = await fetch(req);
        if (res.ok) cache.put(req, res.clone());
        return res;
      } catch { return Response.error(); }
    })());
    return;
  }

  // Seiten-Aufrufe: Netz zuerst (kurzes Timeout), sonst die gespeicherte App-Hülle
  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      const cache = await caches.open(SHELL);
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 4000);
        const res = await fetch(req, { signal: ctrl.signal });
        clearTimeout(timer);
        if (res.ok && url.pathname === '/') cache.put('/', res.clone());
        return res;
      } catch {
        return (await cache.match('/')) || (await cache.match('/index.html')) || Response.error();
      }
    })());
    return;
  }

  // Alles andere der App: Cache zuerst, sonst Netz
  event.respondWith((async () => {
    const cache = await caches.open(SHELL);
    const hit = await cache.match(req, { ignoreSearch: true });
    if (hit) return hit;
    try {
      const res = await fetch(req);
      if (res.ok) cache.put(req, res.clone());
      return res;
    } catch { return Response.error(); }
  })());
});

self.addEventListener('message', (event) => {
  if (event.data === 'skipWaiting') self.skipWaiting();
});
