// HTTP-Server + WebSocket zusammenbauen (auch für Tests nutzbar)
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { Store } from './store.js';
import { Hub } from './hub.js';
import { StaticFiles } from './static.js';
import { migrate } from './db.js';
import { isId } from './util.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const APP_NAME = process.env.APP_NAME || 'Wayfolk';

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function clientIp(req) {
  const xf = req.headers['x-forwarded-for'];
  if (xf) return String(xf).split(',')[0].trim();
  return req.socket.remoteAddress || 'unknown';
}

function origin(req) {
  const proto = req.headers['x-forwarded-proto'] || (req.socket.encrypted ? 'https' : 'http');
  return `${String(proto).split(',')[0]}://${req.headers.host}`;
}

function csp(env) {
  const media = env.MEDIA_PUBLIC_URL ? new URL(env.MEDIA_PUBLIC_URL).origin : '';
  const upload = env.R2_ENDPOINT_HOST ? `https://${env.R2_ENDPOINT_HOST}` : 'https://*.r2.cloudflarestorage.com';
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    `img-src 'self' data: blob: https://*.basemaps.cartocdn.com https://*.tile.openstreetmap.org ${media}`.trim(),
    `media-src 'self' blob: ${media}`.trim(),
    `connect-src 'self' ws: wss: https://photon.komoot.io https://nominatim.openstreetmap.org https://router.project-osrm.org https://routing.openstreetmap.de ${media} ${upload}`.replace(/\s+/g, ' ').trim(),
    "font-src 'self'",
    "worker-src 'self'",
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
}

export async function createApp({ db, publicDir = path.join(__dirname, '..', 'public'), env = process.env, log = console.error }) {
  const version = await migrate(db);
  const store = new Store(db);
  const hub = new Hub(store, { log });
  const files = new StaticFiles(publicDir);
  const startedAt = Date.now();
  const policy = csp(env);

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://x');
      const pathname = url.pathname;
      res.setHeader('Content-Security-Policy', policy);
      res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
      res.setHeader('Permissions-Policy', 'geolocation=(self), camera=(self), microphone=()');
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, { Allow: 'GET, HEAD' });
        return res.end();
      }

      if (pathname === '/api/health') {
        try {
          await db.execute('SELECT 1 AS ok');
          res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
          return res.end(JSON.stringify({ ok: true, app: APP_NAME, db: db.kind, schema: version, uptime: Math.round((Date.now() - startedAt) / 1000), build: files.buildInfo().version }));
        } catch (e) {
          res.writeHead(500, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
          return res.end(JSON.stringify({ ok: false, db: db.kind, error: String(e.message).slice(0, 300) }));
        }
      }

      const cover = pathname.match(/^\/api\/cover\/([A-Za-z0-9_-]{8,40})$/);
      if (cover) {
        const c = await store.getCover(cover[1]);
        if (!c) { res.writeHead(404); return res.end(); }
        res.writeHead(200, {
          'Content-Type': c.type,
          'Cache-Control': 'public, max-age=31536000, immutable',
          'Content-Length': c.data.length,
        });
        return res.end(req.method === 'HEAD' ? undefined : c.data);
      }

      // Einladungslink: Seite mit Vorschau-Daten für Messenger ausliefern
      const invite = pathname.match(/^\/j\/([A-Za-z0-9_-]+)$/);
      if (invite) {
        let info = null;
        if (isId(invite[1])) { try { info = await store.peekInvite(invite[1]); } catch {} }
        const sent = files.send(req, res, '/index.html', {
          transform: (html) => {
            const title = info ? `Du bist zu „${info.title}“ eingeladen` : `Einladung zu ${APP_NAME}`;
            const desc = info
              ? `${info.owner_name} plant einen Roadtrip mit dir. Öffne den Link, um mitzumachen.`
              : 'Plane Roadtrips gemeinsam mit deinen Freunden.';
            const img = info?.has_cover ? `<meta property="og:image" content="${esc(origin(req))}/api/cover/${esc(info.trip_id)}?v=${info.cover_version}">` : '';
            const tags = `<meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(desc)}"><meta property="og:type" content="website">${img}`;
            return html.replace('<!--OG-->', tags);
          },
        });
        if (sent === false) { res.writeHead(404); return res.end('Not found'); }
        return undefined;
      }

      const handled = files.send(req, res, pathname === '/' ? '/index.html' : pathname);
      if (handled !== false) return undefined;
      if (path.extname(pathname)) { res.writeHead(404); return res.end('Not found'); }
      if (files.send(req, res, '/index.html') === false) { res.writeHead(404); return res.end('Not found'); }
      return undefined;
    } catch (e) {
      log('http error', e);
      if (!res.headersSent) res.writeHead(500);
      return res.end('Server error');
    }
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
  server.on('upgrade', (req, socket, head) => {
    const { pathname } = new URL(req.url, 'http://x');
    if (pathname !== '/ws') { socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, (ws) => hub.attach(ws, clientIp(req)));
  });

  const beat = setInterval(() => hub.heartbeat(), 25_000);
  beat.unref();

  async function close() {
    clearInterval(beat);
    for (const c of hub.conns) { try { c.ws.terminate(); } catch {} }
    const wsClosed = new Promise((r) => wss.close(r));
    const httpClosed = new Promise((r) => server.close(r));
    server.closeAllConnections?.();
    await Promise.all([wsClosed, httpClosed]);
    await db.close();
  }

  return { server, hub, store, close };
}
