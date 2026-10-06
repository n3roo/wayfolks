import { copyText, toast } from './ui.js';
import { APP_NAME } from './config.js';

export function newId(bytes = 12) {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  let s = '';
  for (const b of a) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function shareLink({ url, title, text }) {
  if (navigator.share) {
    try { await navigator.share({ title, text, url }); return true; }
    catch (e) { if (e.name === 'AbortError') return false; }
  }
  const ok = await copyText(url);
  toast(ok ? 'Link kopiert' : 'Link konnte nicht kopiert werden', { error: !ok });
  return ok;
}

export function inviteUrl(token) { return `${location.origin}/j/${token}`; }
export function tripCoverUrl(trip) {
  if (!trip?.has_cover) return null;
  return trip.cover_local || `/api/cover/${trip.id}?v=${trip.cover_version || 0}`;
}
export const appName = APP_NAME;

export function hashHue(s) {
  let h = 7;
  for (const c of String(s)) h = (h * 33 + c.charCodeAt(0)) >>> 0;
  return h % 360;
}
