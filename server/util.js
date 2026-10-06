// Kleine Helfer: IDs, Hashes, Validierung
import crypto from 'node:crypto';

const ID_RE = /^[A-Za-z0-9_-]{8,40}$/;

export function newId(bytes = 12) {
  return crypto.randomBytes(bytes).toString('base64url');
}

export function newSecret() {
  return crypto.randomBytes(32).toString('hex');
}

export function sha256(text) {
  return crypto.createHash('sha256').update(String(text)).digest('hex');
}

// Wiederherstellungs-Code: 16 Zeichen ohne verwechselbare Buchstaben (80 Bit)
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export function newRecoveryCode() {
  const bytes = crypto.randomBytes(16);
  let out = '';
  for (let i = 0; i < 16; i++) {
    out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
    if (i % 4 === 3 && i < 15) out += '-';
  }
  return out;
}
export function hashRecoveryCode(code) {
  const raw = String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return sha256('recovery:' + raw);
}

export function isId(v) {
  return typeof v === 'string' && ID_RE.test(v);
}

export class AppError extends Error {
  constructor(code, message) {
    super(message || code);
    this.code = code;
  }
}

export function str(v, max, { required = false, field = 'Feld' } = {}) {
  if (v === undefined || v === null) {
    if (required) throw new AppError('invalid', `${field} fehlt`);
    return '';
  }
  if (typeof v !== 'string') throw new AppError('invalid', `${field} ist ungültig`);
  const t = v.trim();
  if (required && !t) throw new AppError('invalid', `${field} fehlt`);
  if (t.length > max) throw new AppError('invalid', `${field} ist zu lang`);
  return t;
}

export function longText(v, max, field) {
  if (v === undefined || v === null) return '';
  if (typeof v !== 'string') throw new AppError('invalid', `${field} ist ungültig`);
  if (v.length > max) throw new AppError('invalid', `${field} ist zu lang`);
  return v.replace(/\r\n/g, '\n');
}

export function dateOrNull(v, field = 'Datum') {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new AppError('invalid', `${field} ist ungültig`);
  const d = new Date(v + 'T00:00:00Z');
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v) throw new AppError('invalid', `${field} ist ungültig`);
  return v;
}

export function coord(lat, lon) {
  const a = Number(lat), o = Number(lon);
  if (!Number.isFinite(a) || !Number.isFinite(o) || a < -90 || a > 90 || o < -180 || o > 180) {
    throw new AppError('invalid', 'Ungültige Koordinaten');
  }
  return [Math.round(a * 1e6) / 1e6, Math.round(o * 1e6) / 1e6];
}

export const USER_COLORS = ['#E8590C', '#0B7285', '#7048E8', '#2F9E44', '#D6336C', '#1C7ED6', '#F08C00', '#5F3DC4'];
export function colorFor(seed) {
  let h = 0;
  for (const c of String(seed)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return USER_COLORS[h % USER_COLORS.length];
}

export function nowIso() {
  return new Date().toISOString();
}
