// Medien-Speicher: Cloudflare R2 (S3-kompatibel, Upload per vorsigniertem Link direkt vom Handy)
// und ein kleiner Speicher im Arbeitsspeicher für Entwicklung und Tests (MEDIA_DEV=1).
import crypto from 'node:crypto';

const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();
const hex = (buf) => buf.toString('hex');
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const enc = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());

export const MIME_EXT = {
  'image/jpeg': 'jpg', 'image/webp': 'webp', 'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov',
};

// AWS Signature V4 für Query-Strings (vorsignierte Links)
export function presign({ method, host, path, region, service = 's3', accessKey, secretKey, now = new Date(), expires = 3600, headers = {} }) {
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
  return { url: `https://${host}${canonPath}?${qs}&X-Amz-Signature=${signature}`, signature };
}

export class S3Storage {
  // Läuft mit Backblaze B2, Cloudflare R2 und anderen S3-kompatiblen Diensten (Pfad-Stil)
  constructor({ endpoint, region, bucket, accessKey, secretKey, publicUrl, fetchFn = fetch }) {
    this.kind = 's3';
    this.host = endpoint.replace(/^https?:\/\//, '').replace(/\/+$/, '');
    this.region = region || (this.host.match(/^s3\.([^.]+)\.backblazeb2\.com$/)?.[1]) || 'auto';
    this.bucket = bucket;
    this.accessKey = accessKey;
    this.secretKey = secretKey;
    this.base = publicUrl ? publicUrl.replace(/\/+$/, '') : null; // ohne öffentliche Adresse: private Ablage mit signierten Links
    this.fetch = fetchFn;
  }

  _sign(method, key, headers = {}, expires = 3600) {
    return presign({ method, host: this.host, path: `/${this.bucket}/${key}`, region: this.region, accessKey: this.accessKey, secretKey: this.secretKey, expires, headers }).url;
  }

  presignPut(key, contentType) {
    return { url: this._sign('PUT', key, { 'content-type': contentType }, 3600), headers: { 'Content-Type': contentType } };
  }

  // Private Ablage: Lese-Links gelten 7 Tage und ändern sich nur einmal täglich, damit der Browser Bilder zwischenspeichern kann
  publicUrl(key) {
    if (this.base) return `${this.base}/${key}`;
    const day = new Date(); day.setUTCHours(0, 0, 0, 0);
    return presign({ method: 'GET', host: this.host, path: `/${this.bucket}/${key}`, region: this.region, accessKey: this.accessKey, secretKey: this.secretKey, expires: 604800, now: day }).url;
  }

  async head(key) {
    const res = await this.fetch(this._sign('HEAD', key, {}, 120), { method: 'HEAD' });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`Speicher HEAD ${res.status}`);
    return { size: Number(res.headers.get('content-length') || 0), type: res.headers.get('content-type') || '' };
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
    return new S3Storage({ endpoint, region: env.S3_REGION, bucket, accessKey, secretKey, publicUrl });
  }
  if (env.MEDIA_DEV === '1') return new DevStorage();
  return null;
}
