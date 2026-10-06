// Fotos und Videos: verkleinern, in eine Warteschlange legen (bleibt auch ohne Netz erhalten) und hochladen
import { state, emit, on, applyEvent } from './state.js';
import { net } from './net.js';
import { idbGet, idbSet, idbDel, idbKeys } from './idb.js';
import { resizeImage } from './img.js';
import { newId } from './util.js';
import { toast } from './ui.js';

const STORE = 'blobs';
const PREFIX = 'up:';
const VIDEO_MIMES = { mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime' };

const blobs = new Map();   // id -> { blob, thumb } (Arbeitsspeicher-Kopie der gespeicherten Dateien)
let pumping = false;
let pumpTimer = null;

export const MB = 1024 * 1024;

function list(tripId) { return (state.uploads[tripId] ||= []); }
function changed(tripId) { emit('trip:' + tripId); emit('uploads'); }

// ---------- Aufbereiten ----------
async function processImage(file) {
  const main = await resizeImage(file, { maxSide: 2048, quality: 0.82, withDataUrl: false });
  const th = await resizeImage(main.blob, { maxSide: 480, quality: 0.72, withDataUrl: false });
  return { blob: main.blob, thumb: th.blob, mime: 'image/jpeg', width: main.width, height: main.height, duration: null };
}

function videoMime(file) {
  const t = (file.type || '').toLowerCase();
  if (t === 'video/mp4' || t === 'video/webm' || t === 'video/quicktime') return t;
  if (t === 'video/x-m4v') return 'video/mp4';
  const ext = (file.name || '').split('.').pop().toLowerCase();
  return VIDEO_MIMES[ext] || null;
}

// Vorschaubild und Länge eines Videos holen (klappt nicht bei jedem Codec, dann gibt es nur einen Platzhalter)
function inspectVideo(blob) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(blob);
    const v = document.createElement('video');
    v.muted = true; v.playsInline = true; v.preload = 'metadata';
    let done = false;
    const finish = (out) => { if (done) return; done = true; URL.revokeObjectURL(url); v.removeAttribute('src'); v.load(); resolve(out); };
    const timer = setTimeout(() => finish({ thumb: null, width: v.videoWidth || null, height: v.videoHeight || null, duration: Number.isFinite(v.duration) ? v.duration : null }), 7000);
    v.onerror = () => { clearTimeout(timer); finish({ thumb: null, width: null, height: null, duration: null }); };
    v.onloadedmetadata = () => { try { v.currentTime = Math.min(1, (v.duration || 2) / 2); } catch { /* weiter ohne Vorschau */ } };
    v.onseeked = () => {
      clearTimeout(timer);
      try {
        const scale = Math.min(1, 480 / Math.max(v.videoWidth, v.videoHeight));
        const c = document.createElement('canvas');
        c.width = Math.max(1, Math.round(v.videoWidth * scale)); c.height = Math.max(1, Math.round(v.videoHeight * scale));
        c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
        c.toBlob((thumb) => finish({ thumb, width: v.videoWidth, height: v.videoHeight, duration: v.duration }), 'image/jpeg', 0.72);
      } catch { finish({ thumb: null, width: v.videoWidth, height: v.videoHeight, duration: v.duration }); }
    };
    v.src = url;
  });
}

async function processVideo(file) {
  const mime = videoMime(file);
  if (!mime) throw new Error('Dieses Videoformat wird nicht unterstützt.');
  if (file.size > state.config.maxVideoBytes) {
    throw new Error(`Das Video ist zu groß (${Math.round(file.size / MB)} MB, erlaubt sind ${Math.round(state.config.maxVideoBytes / MB)} MB). Tipp: in der Kamera-App eine niedrigere Auflösung wählen oder das Video kürzen.`);
  }
  const info = await inspectVideo(file);
  return { blob: file, thumb: info.thumb, mime, width: info.width, height: info.height, duration: info.duration };
}

// ---------- Warteschlange ----------
// Legt Dateien in die Warteschlange. Gibt die Zahl der angenommenen Dateien zurück.
export async function addFiles(tripId, stopId, files) {
  if (!state.config.media) { toast('Der Foto-Speicher ist noch nicht eingerichtet.', { error: true }); return 0; }
  let ok = 0;
  for (const file of files) {
    try {
      const kind = file.type.startsWith('video/') || videoMime(file) ? 'video' : file.type.startsWith('image/') ? 'image' : null;
      if (!kind) throw new Error('Das ist weder ein Foto noch ein Video.');
      const p = kind === 'image' ? await processImage(file) : await processVideo(file);
      const fix = state.lastFix && Date.now() - state.lastFix.at < 10 * 60 * 1000 ? state.lastFix : null;
      const item = {
        id: newId(), userId: state.user.id, tripId, stopId: stopId || null, kind, mime: p.mime,
        width: p.width, height: p.height, duration: p.duration, bytes: p.blob.size,
        taken_at: new Date(file.lastModified > 0 ? file.lastModified : Date.now()).toISOString(),
        lat: fix?.lat ?? null, lon: fix?.lon ?? null, caption: '', createdAt: new Date().toISOString(), tries: 0,
      };
      blobs.set(item.id, { blob: p.blob, thumb: p.thumb });
      await idbSet(PREFIX + item.id, { ...item, blob: p.blob, thumb: p.thumb }, STORE);
      register(item);
      ok++;
    } catch (e) {
      console.warn('Datei übersprungen:', e.message);
      toast(e.message || 'Diese Datei konnte nicht verarbeitet werden.', { error: true, ms: 6500 });
    }
  }
  if (ok && state.conn !== 'online') toast('Gespeichert. Wird hochgeladen, sobald du wieder Netz hast.', { ms: 5000 });
  if (ok) pump();
  return ok;
}

function register(item) {
  const b = blobs.get(item.id);
  const previewBlob = b?.thumb || (item.kind === 'image' ? b?.blob : null);
  const u = { ...item, status: 'queued', progress: 0, error: null, previewUrl: previewBlob ? URL.createObjectURL(previewBlob) : null };
  list(item.tripId).push(u);
  changed(item.tripId);
  return u;
}

// Nach dem Start: noch nicht hochgeladene Dateien wiederherstellen
export async function restoreUploads() {
  if (!state.user) return;
  const keys = (await idbKeys(STORE)).filter((k) => String(k).startsWith(PREFIX));
  for (const key of keys) {
    const rec = await idbGet(key, STORE);
    if (!rec || rec.userId !== state.user.id || !rec.blob) continue;
    if (Object.values(state.uploads).some((l) => l.some((u) => u.id === rec.id))) continue;
    blobs.set(rec.id, { blob: rec.blob, thumb: rec.thumb || null });
    const { blob, thumb, ...item } = rec;
    register(item);
  }
  pump();
}

export function pendingCount() {
  return Object.values(state.uploads).reduce((n, l) => n + l.filter((u) => u.status !== 'failed').length, 0);
}

async function finish(u) {
  list(u.tripId).splice(list(u.tripId).indexOf(u), 1);
  blobs.delete(u.id);
  await idbDel(PREFIX + u.id, STORE);
  if (u.previewUrl) setTimeout(() => URL.revokeObjectURL(u.previewUrl), 4000);
}

function put(target, blob, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', target.url);
    for (const [k, v] of Object.entries(target.headers || {})) xhr.setRequestHeader(k, v);
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress?.(e.loaded / e.total); };
    xhr.onload = () => (xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(Object.assign(new Error(`Upload-Status ${xhr.status}`), { code: 'http', status: xhr.status })));
    xhr.onerror = () => reject(Object.assign(new Error('Upload unterbrochen'), { code: 'network' }));
    xhr.ontimeout = () => reject(Object.assign(new Error('Upload zu langsam'), { code: 'network' }));
    xhr.timeout = 10 * 60 * 1000;
    xhr.send(blob);
  });
}

async function uploadOne(u) {
  const b = blobs.get(u.id);
  if (!b) throw Object.assign(new Error('Datei nicht mehr vorhanden'), { code: 'invalid' });
  const meta = { id: u.id, kind: u.kind, mime: u.mime, bytes: b.blob.size, thumb: !!b.thumb };
  u.status = 'uploading'; u.progress = 0; u.error = null;
  emit('uprog:' + u.id, u);
  const prep = await net.request('media.prepare', { tripId: u.tripId, media: meta }, 25000);
  if (!prep.done) {
    const share = b.thumb ? 0.92 : 1;
    await put(prep.put, b.blob, (p) => { u.progress = p * share; emit('uprog:' + u.id, u); });
    if (b.thumb && prep.thumb) { try { await put(prep.thumb, b.thumb); } catch { /* Vorschau ist optional */ } }
  }
  u.progress = 1; emit('uprog:' + u.id, u);
  const full = { ...meta, stop_id: u.stopId, width: u.width, height: u.height, duration: u.duration, taken_at: u.taken_at, lat: u.lat, lon: u.lon, caption: u.caption || '' };
  let res;
  try {
    res = await net.request('media.add', { tripId: u.tripId, media: full }, 40000);
  } catch (e) {
    if (e.code === 'not_found' && u.stopId) { u.stopId = null; res = await net.request('media.add', { tripId: u.tripId, media: { ...full, stop_id: null } }, 40000); }
    else throw e;
  }
  return res.media;
}

const PERMANENT = new Set(['too_large', 'invalid', 'forbidden', 'no_storage', 'limit', 'not_found', 'auth']);

export async function pump() {
  if (pumping) return;
  pumping = true;
  clearTimeout(pumpTimer);
  try {
    for (;;) {
      if (state.conn !== 'online') break;
      const u = Object.values(state.uploads).flat().find((x) => x.status === 'queued');
      if (!u) break;
      try {
        const media = await uploadOne(u);
        await finish(u);
        applyEvent(u.tripId, 'media', { media });
        changed(u.tripId);
      } catch (e) {
        u.status = 'queued';
        if (PERMANENT.has(e.code)) {
          u.status = 'failed'; u.error = e.message || 'Hochladen nicht möglich';
        } else if (e.code === 'http' || e.code === 'network') {
          u.tries = (u.tries || 0) + 1;
          if (u.tries >= 4) {
            u.status = 'failed';
            u.error = e.status === 403 || e.code === 'network'
              ? 'Der Foto-Speicher hat den Upload abgelehnt. Ist die CORS-Regel für diese Adresse eingetragen?'
              : e.message;
          }
        } else if (e.code === 'upload_missing') {
          u.tries = (u.tries || 0) + 1;
          if (u.tries >= 3) { u.status = 'failed'; u.error = e.message; }
        }
        emit('uprog:' + u.id, u);
        changed(u.tripId);
        if (u.status === 'queued') break; // später erneut versuchen
      }
    }
  } finally {
    pumping = false;
    if (Object.values(state.uploads).flat().some((x) => x.status === 'queued')) {
      pumpTimer = setTimeout(pump, 15000);
    }
  }
}

export function retryUpload(tripId, id) {
  const u = list(tripId).find((x) => x.id === id);
  if (!u) return;
  u.status = 'queued'; u.tries = 0; u.error = null;
  changed(tripId);
  pump();
}

export async function discardUpload(tripId, id) {
  const u = list(tripId).find((x) => x.id === id);
  if (u) await finish(u);
  changed(tripId);
}

on('conn', () => { if (state.conn === 'online') pump(); });
window.addEventListener('online', () => setTimeout(pump, 500));

// Bei einem noch laufenden Upload nicht aus Versehen die Seite schließen lassen
window.addEventListener('beforeunload', (e) => {
  if (Object.values(state.uploads).flat().some((u) => u.status === 'uploading')) { e.preventDefault(); e.returnValue = ''; }
});
