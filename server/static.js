// Statische Dateien ausliefern (PWA-Shell), mit ETag, gzip und Service-Worker-Vorlage
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.txt': 'text/plain; charset=utf-8',
};
const COMPRESSIBLE = new Set(['.html', '.js', '.mjs', '.css', '.json', '.webmanifest', '.svg', '.txt']);
const LONG_CACHE_DIRS = ['/vendor/', '/fonts/', '/icons/'];

export class StaticFiles {
  constructor(publicDir) {
    this.dir = path.resolve(publicDir);
    this.cache = new Map(); // abs path -> {mtimeMs,size,etag,raw,gzip}
    this._build = null;
  }

  listFiles(dir = this.dir, base = '') {
    const out = [];
    if (!fs.existsSync(dir)) return out;
    for (const name of fs.readdirSync(dir)) {
      const abs = path.join(dir, name);
      const rel = base + '/' + name;
      const st = fs.statSync(abs);
      if (st.isDirectory()) out.push(...this.listFiles(abs, rel));
      else out.push({ rel, abs, size: st.size, mtimeMs: st.mtimeMs });
    }
    return out;
  }

  // Version der App-Dateien: ändert sich, sobald sich irgendeine Datei ändert
  buildInfo() {
    if (this._build && Date.now() - this._build.at < 5000) return this._build;
    const files = this.listFiles().filter((f) => f.rel !== '/sw.js').sort((a, b) => a.rel.localeCompare(b.rel));
    const h = crypto.createHash('sha1');
    for (const f of files) h.update(`${f.rel}:${f.size}:${Math.round(f.mtimeMs)};`);
    const precache = files
      .filter((f) => !/\.(map|txt)$/.test(f.rel) && !f.rel.startsWith('/icons/shot-'))
      .map((f) => f.rel);
    this._build = { at: Date.now(), version: h.digest('hex').slice(0, 10), precache };
    return this._build;
  }

  resolve(urlPath) {
    let p;
    try { p = decodeURIComponent(urlPath); } catch { return null; }
    if (p.includes('\0')) return null;
    const abs = path.resolve(this.dir, '.' + path.posix.normalize('/' + p));
    if (!abs.startsWith(this.dir + path.sep) && abs !== this.dir) return null;
    return abs;
  }

  load(abs) {
    let st;
    try { st = fs.statSync(abs); } catch { return null; }
    if (!st.isFile()) return null;
    const cached = this.cache.get(abs);
    if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) return cached;
    const raw = fs.readFileSync(abs);
    const ext = path.extname(abs).toLowerCase();
    const entry = {
      mtimeMs: st.mtimeMs,
      size: st.size,
      raw,
      etag: '"' + crypto.createHash('sha1').update(raw).digest('hex').slice(0, 16) + '"',
      gzip: COMPRESSIBLE.has(ext) && raw.length > 800 ? zlib.gzipSync(raw, { level: 9 }) : null,
      type: MIME[ext] || 'application/octet-stream',
      ext,
    };
    this.cache.set(abs, entry);
    return entry;
  }

  swSource() {
    const abs = path.join(this.dir, 'sw.js');
    const entry = this.load(abs);
    if (!entry) return null;
    const { version, precache } = this.buildInfo();
    const body = entry.raw.toString('utf8')
      .replace(/__BUILD__/g, version)
      .replace(/__PRECACHE__/g, JSON.stringify(['/', ...precache.filter((r) => r !== '/index.html')]));
    return Buffer.from(body, 'utf8');
  }

  send(req, res, urlPath, { transform } = {}) {
    let abs = this.resolve(urlPath);
    if (!abs) { res.writeHead(400); return res.end('Bad request'); }
    if (urlPath === '/sw.js') {
      const body = this.swSource();
      if (!body) { res.writeHead(404); return res.end('Not found'); }
      res.writeHead(200, {
        'Content-Type': MIME['.js'],
        'Cache-Control': 'no-cache',
        'Service-Worker-Allowed': '/',
      });
      return res.end(body);
    }
    let entry = this.load(abs);
    if (!entry) return false;
    let body = entry.raw;
    let etag = entry.etag;
    let gz = entry.gzip;
    if (transform && entry.ext === '.html') {
      body = Buffer.from(transform(body.toString('utf8')), 'utf8');
      etag = null;
      gz = body.length > 800 ? zlib.gzipSync(body) : null;
    }
    const long = LONG_CACHE_DIRS.some((d) => urlPath.startsWith(d));
    const headers = {
      'Content-Type': entry.type,
      'Cache-Control': long ? 'public, max-age=604800' : 'no-cache',
      'X-Content-Type-Options': 'nosniff',
    };
    if (etag) {
      headers.ETag = etag;
      if (req.headers['if-none-match'] === etag) { res.writeHead(304, headers); return res.end(); }
    }
    const accepts = String(req.headers['accept-encoding'] || '');
    if (gz && /\bgzip\b/.test(accepts)) {
      headers['Content-Encoding'] = 'gzip';
      headers.Vary = 'Accept-Encoding';
      res.writeHead(200, headers);
      return res.end(req.method === 'HEAD' ? undefined : gz);
    }
    res.writeHead(200, headers);
    return res.end(req.method === 'HEAD' ? undefined : body);
  }
}
