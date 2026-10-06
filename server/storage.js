// Medien-Speicher: Cloudflare R2 (S3-kompatibel, Upload per vorsigniertem Link direkt vom Handy)
// und ein kleiner Speicher im Arbeitsspeicher für Entwicklung und Tests (MEDIA_DEV=1).
import crypto from 'node:crypto';
import http from 'node:http';
import https from 'node:https';

const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();
const hex = (buf) => buf.toString('hex');
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const enc = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());

export const MIME_EXT = {
  'image/jpeg': 'jpg', 'image/webp': 'webp', 'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov',
};

// AWS Signature V4 für Query-Strings (vorsignierte Links)
export function presign({ method, host, path, region, service = 's3', accessKey, secretKey, now = new Date(), expires = 3600, headers = {}, scheme = 'https' }) {
  const amz = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const date = amz.slice(0, 8);
  const scope = `${date}/${region}/${service}/aws4_request`;
  const hdrs = { host, ...headers };
  const names = Object.keys(hdrs).map((k) => k.toLowerCase()).sort();
  const lower = Object.fromEntries(Object.entries(hdrs).map(([k, v]) => [k.toLowerCase(), String(v).trim()]));
  const query = {
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': `${accessKey}/${scope}`,
    'X-Amz-Date': amz,
    'X-Amz-Expires': String(expires),
    'X-Amz-SignedHeaders': names.join(';'),
  };
  const qs = Object.keys(query).sort().map((k) => `${enc(k)}=${enc(query[k])}`).join('&');
  const canonPath = path.split('/').map((seg) => enc(decodeURIComponent(seg))).join('/');
  const canonical = [method, canonPath, qs, names.map((n) => `${n}:${lower[n]}\n`).join(''), names.join(';'), 'UNSIGNED-PAYLOAD'].join('\n');
  const toSign = ['AWS4-HMAC-SHA256', amz, scope, sha(canonical)].join('\n');
  const key = hmac(hmac(hmac(hmac('AWS4' + secretKey, date), region), service), 'aws4_request');
  const signature = hex(hmac(key, toSign));
  return { url: `${scheme}://${host}${canonPath}?${qs}&X-Amz-Signature=${signature}`, signature };
}

export class S3Storage {
  // Läuft mit Backblaze B2, Cloudflare R2 und anderen S3-kompatiblen Diensten (Pfad-Stil).
  // Standard: Uploads laufen über den eigenen Server (kein CORS nötig). mode 'direct': Handy lädt per vorsigniertem Link hoch.
  constructor({ endpoint, region, bucket, accessKey, secretKey, publicUrl, mode = 'proxy', fetchFn = fetch }) {
    this.kind = 's3';
    this.scheme = /^http:\/\//.test(endpoint) ? 'http' : 'https';
    this.host = endpoint.replace(/^https?:\/\//, '').replace(/\/+$/, '');
    this.region = region || (this.host.match(/^s3\.([^.]+)\.backblazeb2\.com$/)?.[1]) || 'auto';
    this.bucket = bucket;
    this.accessKey = accessKey;
    this.secretKey = secretKey;
    this.base = publicUrl ? publicUrl.replace(/\/+$/, '') : null; // ohne öffentliche Adresse: private Ablage mit signierten Links
    this.mode = mode === 'direct' ? 'direct' : 'proxy';
    this.uploadSecret = crypto.createHash('sha256').update('wayfolk-upload:' + secretKey).digest();
    this.fetch = fetchFn;
  }

  _sign(method, key, headers = {}, expires = 3600) {
    return presign({ method, host: this.host, path: `/${this.bucket}/${key}`, region: this.region, accessKey: this.accessKey, secretKey: this.secretKey, expires, headers, scheme: this.scheme }).url;
  }

  // Upload-Ziel für den Client. Im Proxy-Modus ein kurzlebiges, signiertes Token für den eigenen Server.
  presignPut(key, contentType, maxBytes = 0) {
    if (this.mode === 'direct') return { url: this._sign('PUT', key, { 'content-type': contentType }, 3600), headers: { 'Content-Type': contentType } };
    const payload = Buffer.from(JSON.stringify({ k: key, t: contentType, m: maxBytes, e: Date.now() + 3600_000 })).toString('base64url');
    const sig = crypto.createHmac('sha256', this.uploadSecret).update(payload).digest('base64url');
    return { url: `/api/upload/${payload}.${sig}`, headers: { 'Content-Type': contentType } };
  }

  verifyUpload(token) {
    const [payload, sig] = String(token).split('.');
    if (!payload || !sig) return null;
    const expect = crypto.createHmac('sha256', this.uploadSecret).update(payload).digest('base64url');
    if (sig.length !== expect.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) return null;
    try {
      const d = JSON.parse(Buffer.from(payload, 'base64url').toString());
      return d.e > Date.now() && typeof d.k === 'string' ? d : null;
    } catch { return null; }
  }

  // Reicht den Upload eines Handys direkt an den Speicher durch (ohne Zwischenspeicherung)
  proxyUpload(token, req, res) {
    const reply = (code, msg) => { if (!res.headersSent) res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end(msg); };
    const d = this.verifyUpload(token);
    if (!d) return reply(403, 'Upload-Link ungültig oder abgelaufen');
    const len = Number(req.headers['content-length']);
    if (!Number.isFinite(len) || len <= 0) return reply(411, 'Dateigröße fehlt');
    if (d.m && len > d.m) return reply(413, 'Datei zu groß');
    if ((req.headers['content-type'] || '') !== d.t) return reply(415, 'Falscher Dateityp');
    const url = new URL(this._sign('PUT', d.k, { 'content-type': d.t }, 600));
    const lib = this.scheme === 'http' ? http : https;
    let sent = 0; let done = false;
    const up = lib.request(url, { method: 'PUT', headers: { 'Content-Type': d.t, 'Content-Length': len } }, (r) => {
      const chunks = [];
      r.on('data', (c) => chunks.push(c));
      r.on('end', () => {
        done = true;
        if (r.statusCode >= 200 && r.statusCode < 300) reply(200, 'ok');
        else reply(502, `Speicher meldet ${r.statusCode}: ${Buffer.concat(chunks).toString().replace(/\s+/g, ' ').slice(0, 200)}`);
      });
    });
    up.on('error', (e) => { if (!done) { done = true; reply(502, 'Speicher nicht erreichbar: ' + e.message); } });
    req.on('data', (c) => { sent += c.length; if (sent > len) { up.destroy(); req.destroy(); } });
    req.on('aborted', () => up.destroy());
    req.pipe(up);
  }

  publicUrl(key) {
    if (this.base) return `${this.base}/${key}`;
    // Private Ablage: Lese-Links gelten 7 Tage und ändern sich nur einmal täglich, damit der Browser Bilder zwischenspeichern kann
    const day = new Date(); day.setUTCHours(0, 0, 0, 0);
    return presign({ method: 'GET', host: this.host, path: `/${this.bucket}/${key}`, region: this.region, accessKey: this.accessKey, secretKey: this.secretKey, expires: 604800, now: day, scheme: this.scheme }).url;
  }

  async head(key) {
    const res = await this.fetch(this._sign('HEAD', key, {}, 120), { method: 'HEAD' });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`Speicher HEAD ${res.status}`);
    return { size: Number(res.headers.get('content-length') || 0), type: res.headers.get('content-type') || '' };
  }

  // Selbstprüfung für /api/health?storage=1
  async diagnose(origin) {
    const out = { kind: this.kind, endpoint: this.host, bucket: this.bucket, region: this.region, private: !this.base, uploadModus: this.mode === 'proxy' ? 'über den Server (kein CORS nötig)' : 'direkt vom Handy (CORS nötig)' };
    try {
      const res = await this.fetch(this._sign('HEAD', '_wayfolk-check', {}, 120), { method: 'HEAD' });
      out.credentials = res.status === 404 || res.ok ? 'ok' : res.status === 403 || res.status === 401 ? 'abgelehnt (Key oder Bucket-Name falsch?)' : `Status ${res.status}`;
    } catch (e) { out.credentials = 'nicht erreichbar: ' + e.message; }
    // Schreibtest: kleine Datei anlegen und wieder löschen
    try {
      const put = await this.fetch(this._sign('PUT', '_wayfolk-check', { 'content-type': 'text/plain' }, 120), { method: 'PUT', headers: { 'Content-Type': 'text/plain' }, body: 'ok' });
      out.schreiben = put.ok ? 'ok' : `abgelehnt (${put.status}): Hat der App Key „Read and Write“ für diesen Bucket?`;
      if (put.ok) { const back = await this.fetch(this.publicUrl('_wayfolk-check'), { method: 'GET' }); out.lesen = back.ok ? 'ok' : `Status ${back.status}`; }
      await this.remove('_wayfolk-check');
    } catch (e) { out.schreiben = 'nicht prüfbar: ' + e.message; }
    if (this.mode === 'direct') {
      const pre = async (url, method, reqHeaders) => {
        const headers = { Origin: origin, 'Access-Control-Request-Method': method };
        if (reqHeaders) headers['Access-Control-Request-Headers'] = reqHeaders;
        const res = await this.fetch(url, { method: 'OPTIONS', headers });
        const allow = res.headers.get('access-control-allow-origin');
        return res.ok && (allow === '*' || allow === origin);
      };
      try { out.cors = (await pre(this._sign('PUT', '_wayfolk-check', { 'content-type': 'image/jpeg' }, 120), 'PUT', 'content-type')) ? 'ok' : `fehlt für ${origin}`; } catch (e) { out.cors = 'nicht prüfbar: ' + e.message; }
    }
    out.ok = out.credentials === 'ok' && out.schreiben === 'ok' && (this.mode === 'proxy' || out.cors === 'ok');
    return out;
  }

  async remove(key) {
    try { await this.fetch(this._sign('DELETE', key, {}, 120), { method: 'DELETE' }); } catch { /* best effort */ }
  }
}

export class DevStorage {
  constructor() { this.kind = 'dev'; this.files = new Map(); }
  presignPut(key, contentType) { return { url: `/dev-media/${key}`, headers: { 'Content-Type': contentType } }; }
  publicUrl(key) { return `/dev-media/${key}`; }
  async head(key) { const f = this.files.get(key); return f ? { size: f.data.length, type: f.type } : null; }
  async remove(key) { this.files.delete(key); }

  // HTTP-Handler für PUT/GET/HEAD auf /dev-media/<key>
  async handle(req, res, key) {
    if (req.method === 'PUT') {
      const chunks = []; let n = 0;
      for await (const c of req) { n += c.length; if (n > 120 * 1024 * 1024) { res.writeHead(413); return res.end(); } chunks.push(c); }
      this.files.set(key, { data: Buffer.concat(chunks), type: req.headers['content-type'] || 'application/octet-stream' });
      res.writeHead(200); return res.end();
    }
    const f = this.files.get(key);
    if (!f) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': f.type, 'Content-Length': f.data.length, 'Cache-Control': 'private, max-age=3600' });
    return res.end(req.method === 'HEAD' ? undefined : f.data);
  }
}

export function createStorage(env = process.env) {
  const endpoint = env.S3_ENDPOINT;
  const accessKey = env.S3_KEY_ID;
  const secretKey = env.S3_APP_KEY;
  const bucket = env.S3_BUCKET;
  const publicUrl = env.MEDIA_PUBLIC_URL;
  if (endpoint && accessKey && secretKey && bucket) {
    return new S3Storage({ endpoint, region: env.S3_REGION, bucket, accessKey, secretKey, publicUrl, mode: env.UPLOAD_MODE });
  }
  if (env.MEDIA_DEV === '1') return new DevStorage();
  return null;
}
