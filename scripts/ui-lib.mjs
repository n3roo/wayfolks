// Hilfen für die Oberflächen-Tests: Server starten, Handy simulieren, externe Dienste nachstellen
import { createRequire } from 'node:module';
import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import { LocalSqlite } from '../server/db.js';
import { createApp } from '../server/app.js';
import { DevStorage } from '../server/storage.js';

const require = createRequire('/opt/npm-tools/node_modules/');
export const puppeteer = require('puppeteer-core');
export const sharp = require('sharp');

export function chromePath() {
  const base = process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers';
  for (const d of fs.readdirSync(base)) {
    const p = path.join(base, d, 'chrome-linux', 'chrome');
    if (d.startsWith('chromium-') && fs.existsSync(p)) return p;
  }
  throw new Error('Kein Chromium gefunden');
}

export async function startServer() {
  const db = new LocalSqlite(':memory:');
  const app = await createApp({ db, storage: new DevStorage(), log: (...a) => console.error('[server]', ...a) });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  return { app, port: app.server.address().port, base: `http://127.0.0.1:${app.server.address().port}` };
}

// ---------- Nachgestellte Dienste ----------
function crc(buf) { return zlib.crc32(buf) >>> 0; }
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
  return Buffer.concat([len, td, c]);
}
export function tilePng(x, y, z, dark = false) {
  const size = 256;
  const raw = Buffer.alloc((size * 4 + 1) * size);
  const bg = dark ? [24, 33, 52] : [233, 228, 214];
  const grid = dark ? [40, 52, 78] : [214, 207, 190];
  const road = dark ? [70, 84, 116] : [250, 246, 236];
  const seed = (x * 73856093) ^ (y * 19349663) ^ (z * 83492791);
  for (let j = 0; j < size; j++) {
    const row = j * (size * 4 + 1);
    raw[row] = 0;
    for (let i = 0; i < size; i++) {
      let c = bg;
      if (i === 0 || j === 0) c = grid;
      const d1 = Math.abs(j - ((seed >>> 3) % 200) - 20 - i * 0.3);
      const d2 = Math.abs(i - ((seed >>> 7) % 180) - 30 + j * 0.2);
      if (d1 < 3 || d2 < 2) c = road;
      if (((i + j * 3 + seed) % 97) < 2 && (i % 5 === 0)) c = [196, 214, 190];
      const o = row + 1 + i * 4;
      raw[o] = c[0]; raw[o + 1] = c[1]; raw[o + 2] = c[2]; raw[o + 3] = 255;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

export const PLACES = [
  { name: 'Wien', lat: 48.2082, lon: 16.3738, state: 'Wien', country: 'Österreich' },
  { name: 'Ljubljana', lat: 46.0569, lon: 14.5058, state: 'Slowenien', country: 'Slowenien' },
  { name: 'Triest', lat: 45.6495, lon: 13.7768, state: 'Friaul-Julisch Venetien', country: 'Italien' },
  { name: 'Venedig', lat: 45.4408, lon: 12.3155, state: 'Venetien', country: 'Italien' },
  { name: 'Rovinj', lat: 45.0812, lon: 13.6387, state: 'Gespanschaft Istrien', country: 'Kroatien' },
  { name: 'München', lat: 48.1351, lon: 11.582, state: 'Bayern', country: 'Deutschland' },
];

function hav(a, b) {
  const R = 6371000, rad = (x) => (x * Math.PI) / 180;
  const dLat = rad(b[1] - a[1]), dLon = rad(b[0] - a[0]);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[1])) * Math.cos(rad(b[1])) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

export async function installMocks(page, { log = [], osrmFails = false } = {}) {
  await page.setRequestInterception(true);
  page.on('request', async (req) => {
    const url = new URL(req.url());
    const respond = (status, type, body, headers = {}) => req.respond({ status, contentType: type, body, headers: { 'access-control-allow-origin': '*', ...headers } });
    if (/basemaps\.cartocdn\.com|tile\.openstreetmap\.org/.test(url.hostname)) {
      const m = url.pathname.match(/\/(\d+)\/(\d+)\/(\d+)(?:@2x)?\.png/);
      const [z, x, y] = m ? m.slice(1).map(Number) : [0, 0, 0];
      log.push('tile');
      return respond(200, 'image/png', tilePng(x, y, z, /dark_all/.test(url.pathname)));
    }
    if (url.hostname === 'photon.komoot.io') {
      log.push('photon:' + url.searchParams.get('q'));
      const q = (url.searchParams.get('q') || '').toLowerCase();
      const hits = PLACES.filter((p) => p.name.toLowerCase().startsWith(q.slice(0, 3)) || p.name.toLowerCase().includes(q));
      return respond(200, 'application/json', JSON.stringify({ type: 'FeatureCollection', features: hits.map((p) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [p.lon, p.lat] }, properties: { name: p.name, state: p.state, country: p.country, osm_key: 'place', osm_value: 'city' } })) }));
    }
    if (url.hostname === 'nominatim.openstreetmap.org') {
      if (url.pathname === '/reverse') {
        log.push('reverse');
        const lat = Number(url.searchParams.get('lat')), lon = Number(url.searchParams.get('lon'));
        const near = PLACES.map((p) => ({ p, d: hav([lon, lat], [p.lon, p.lat]) })).sort((a, b) => a.d - b.d)[0];
        return respond(200, 'application/json', JSON.stringify({ name: near.d < 30000 ? near.p.name : '', display_name: `${near.p.name}, ${near.p.state}, ${near.p.country}`, address: { village: near.p.name, state: near.p.state, country: near.p.country } }));
      }
      return respond(200, 'application/json', '[]');
    }
    if (/router\.project-osrm\.org|routing\.openstreetmap\.de/.test(url.hostname)) {
      log.push('osrm');
      if (osrmFails) return respond(503, 'text/plain', 'down');
      const coords = decodeURIComponent(url.pathname).split('/driving/')[1].split(';').map((s) => s.split(',').map(Number));
      const line = [];
      const legs = [];
      for (let i = 0; i < coords.length - 1; i++) {
        const a = coords[i], b = coords[i + 1];
        const d = hav(a, b) * 1.2;
        legs.push({ distance: d, duration: d / 22, steps: [], summary: '', weight: 0 });
        for (let k = 0; k < 12; k++) {
          const t = k / 12, bend = Math.sin(t * Math.PI) * 0.12 * Math.hypot(b[0] - a[0], b[1] - a[1]);
          line.push([a[0] + (b[0] - a[0]) * t + bend * 0.3, a[1] + (b[1] - a[1]) * t - bend * 0.3]);
        }
      }
      line.push(coords[coords.length - 1]);
      return respond(200, 'application/json', JSON.stringify({ code: 'Ok', routes: [{ geometry: { type: 'LineString', coordinates: line }, legs, distance: legs.reduce((s, l) => s + l.distance, 0), duration: legs.reduce((s, l) => s + l.duration, 0) }], waypoints: [] }));
    }
    return req.continue();
  });
}

export const S23 = {
  viewport: { width: 412, height: 915, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  userAgent: 'Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36',
};

export async function newPhone(browser, base, { dark = false, name = 'phone', permissions = [], bypassSW = true } = {}) {
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  await page.setViewport(S23.viewport);
  await page.setUserAgent(S23.userAgent);
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: dark ? 'dark' : 'light' }]);
  const log = [];
  const errors = [];
  page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`${name} console: ${m.text()}`); });
  page.on('requestfailed', (r) => { if (!/cartocdn|osrm|photon|nominatim|openstreetmap/.test(r.url())) errors.push(`${name} requestfailed: ${r.url()} ${r.failure()?.errorText}`); });
  if (bypassSW) await page.setBypassServiceWorker(true); // sonst laufen die Kacheln am Mock vorbei
  await installMocks(page, { log });
  void permissions;
  return { context, page, log, errors, base };
}
