// Zentraler Zustand der App, Zugangsdaten und lokale Vorab-Änderungen (optimistisch)
import { idbGet, idbSet } from './idb.js';

export const state = {
  user: null,          // {id,name,color}
  trips: null,         // null = noch unbekannt, sonst Liste der Reisen
  tripData: {},        // id -> {trip, role, members, stops, online, invites}
  conn: 'connecting',  // connecting | online | offline | anon
  connectingSince: Date.now(),
  pending: 0,          // Anzahl noch nicht gesendeter Änderungen
  lastError: null,
  config: { media: false, maxVideoBytes: 100 * 1024 * 1024 },
  uploads: {},         // tripId -> wartende Uploads (Fotos/Videos, die noch nicht beim Server sind)
  lastFix: null,       // letzter Standort {lat, lon, acc, at}, nur wenn der Standort an ist
};

// ---------- Ereignisse ----------
const listeners = new Map();
export function on(topic, fn) {
  if (!listeners.has(topic)) listeners.set(topic, new Set());
  listeners.get(topic).add(fn);
  return () => listeners.get(topic)?.delete(fn);
}
export function emit(topic, payload) {
  for (const fn of [...(listeners.get(topic) || [])]) {
    try { fn(payload); } catch (e) { console.error(e); }
  }
}

// ---------- Zugangsdaten (Geräte-Geheimnis im localStorage) ----------
const K = { id: 'wf.userId', secret: 'wf.secret', name: 'wf.name', color: 'wf.color', recovery: 'wf.recovery' };

export function loadCreds() {
  try {
    const id = localStorage.getItem(K.id);
    const secret = localStorage.getItem(K.secret);
    if (!id || !secret) return null;
    return { id, secret, name: localStorage.getItem(K.name) || 'Ich', color: localStorage.getItem(K.color) || '#E8590C', recovery: localStorage.getItem(K.recovery) || '' };
  } catch { return null; }
}
export function saveCreds({ user, secret, recovery }) {
  try {
    localStorage.setItem(K.id, user.id);
    localStorage.setItem(K.secret, secret);
    localStorage.setItem(K.name, user.name);
    localStorage.setItem(K.color, user.color);
    if (recovery !== undefined) localStorage.setItem(K.recovery, recovery || '');
  } catch (e) { console.error('localStorage nicht verfügbar', e); }
}
export function saveRecovery(code) { try { localStorage.setItem(K.recovery, code); } catch {} }
export function clearCreds() {
  try { Object.values(K).forEach((k) => localStorage.removeItem(k)); } catch {}
  state.user = null;
}
export function setUser(user) {
  state.user = { id: user.id, name: user.name, color: user.color };
  try { localStorage.setItem(K.name, user.name); localStorage.setItem(K.color, user.color); } catch {}
  emit('user');
}

// ---------- Zwischenspeicher für Offline-Start ----------
let persistTimer = null;
export function persistSoon() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(async () => {
    if (!state.user) return;
    try {
      const slim = {};
      for (const [id, d] of Object.entries(state.tripData)) slim[id] = { trip: d.trip, role: d.role, members: d.members, stops: d.stops, media: d.media || [] };
      await idbSet('cache:' + state.user.id, { trips: state.trips, tripData: slim, at: Date.now() });
    } catch (e) { console.error(e); }
  }, 400);
}
export async function loadCache() {
  if (!state.user) return;
  const c = await idbGet('cache:' + state.user.id);
  if (c && state.trips === null) {
    state.trips = c.trips || [];
    for (const [id, d] of Object.entries(c.tripData || {})) {
      if (!state.tripData[id]) state.tripData[id] = { ...d, media: d.media || [], online: [], invites: null, fromCache: true };
    }
    emit('trips');
  }
}

// ---------- Hilfen ----------
export function tripSummary(id) { return state.trips?.find((t) => t.id === id) || null; }
export function myRole(tripId) { return state.tripData[tripId]?.role || tripSummary(tripId)?.role || null; }
export function canEdit(tripId) { const r = myRole(tripId); return r === 'owner' || r === 'editor'; }

function recount(tripId) {
  const d = state.tripData[tripId];
  const s = tripSummary(tripId);
  if (d && s) {
    s.stop_count = d.stops.length;
    s.visited_count = d.stops.filter((x) => x.visited_at).length;
  }
}

function sortedByPosition(stops) { return stops.sort((a, b) => a.position - b.position); }

// ---------- Lokale Vorab-Änderungen (werden später vom Server bestätigt) ----------
export function applyLocal(op, p) {
  const now = new Date().toISOString();
  const me = state.user;
  switch (op) {
    case 'trip.create': {
      const dto = { id: p.id, title: p.title, start_date: p.start_date || null, end_date: p.end_date || null, has_cover: false, cover_version: 0, owner_id: me.id, updated_at: now };
      state.trips = state.trips || [];
      if (!state.trips.some((t) => t.id === p.id)) {
        state.trips.unshift({ ...dto, role: 'owner', stop_count: 0, visited_count: 0, members: [{ ...me, role: 'owner' }] });
      }
      state.tripData[p.id] = { trip: dto, role: 'owner', members: [{ ...me, role: 'owner' }], stops: [], media: [], online: [], invites: [] };
      emit('trips');
      break;
    }
    case 'trip.update': {
      const d = state.tripData[p.tripId];
      const s = tripSummary(p.tripId);
      for (const k of ['title', 'start_date', 'end_date']) {
        if (p.patch[k] !== undefined) { if (d) d.trip[k] = p.patch[k] || (k === 'title' ? d.trip[k] : null); if (s) s[k] = p.patch[k] || (k === 'title' ? s[k] : null); }
      }
      if (p.patch.remove_cover) {
        if (d) { d.trip.has_cover = false; d.trip.cover_local = null; }
        if (s) { s.has_cover = false; s.cover_local = null; }
      }
      emit('trips'); emit('trip:' + p.tripId);
      break;
    }
    case 'trip.cover': {
      const d = state.tripData[p.tripId];
      const s = tripSummary(p.tripId);
      if (d) { d.trip.has_cover = true; d.trip.cover_local = p.local; }
      if (s) { s.has_cover = true; s.cover_local = p.local; }
      emit('trips'); emit('trip:' + p.tripId);
      break;
    }
    case 'trip.delete':
    case 'trip.leave': {
      state.trips = (state.trips || []).filter((t) => t.id !== p.tripId);
      delete state.tripData[p.tripId];
      emit('trips');
      break;
    }
    case 'stop.create': {
      const d = state.tripData[p.tripId];
      if (!d || d.stops.some((x) => x.id === p.stop.id)) break;
      const max = d.stops.reduce((m, x) => Math.max(m, x.position), -1);
      d.stops.push({
        id: p.stop.id, trip_id: p.tripId, position: max + 1, name: p.stop.name, description: p.stop.description || '', notes: p.stop.notes || '',
        lat: p.stop.lat, lon: p.stop.lon, planned_date: p.stop.planned_date || null, visited_at: null, visited_by: null, created_by: me.id, updated_at: now,
      });
      recount(p.tripId); emit('trip:' + p.tripId);
      break;
    }
    case 'stop.update': {
      const st = state.tripData[p.tripId]?.stops.find((x) => x.id === p.stopId);
      if (!st) break;
      Object.assign(st, p.patch, { updated_at: now });
      emit('trip:' + p.tripId);
      break;
    }
    case 'stop.visit': {
      const st = state.tripData[p.tripId]?.stops.find((x) => x.id === p.stopId);
      if (!st) break;
      st.visited_at = p.visited ? now : null;
      st.visited_by = p.visited ? me.id : null;
      recount(p.tripId); emit('trip:' + p.tripId);
      break;
    }
    case 'media.update': {
      const m = state.tripData[p.tripId]?.media.find((x) => x.id === p.mediaId);
      if (!m) break;
      Object.assign(m, p.patch);
      emit('trip:' + p.tripId);
      break;
    }
    case 'media.delete': {
      const d = state.tripData[p.tripId];
      if (!d) break;
      d.media = d.media.filter((x) => x.id !== p.mediaId);
      emit('trip:' + p.tripId);
      break;
    }
    case 'stop.delete': {
      const d = state.tripData[p.tripId];
      if (!d) break;
      d.media.forEach((m) => { if (m.stop_id === p.stopId) m.stop_id = null; });
      d.stops = d.stops.filter((x) => x.id !== p.stopId);
      recount(p.tripId); emit('trip:' + p.tripId);
      break;
    }
    case 'stop.reorder': {
      const d = state.tripData[p.tripId];
      if (!d) break;
      reorder(d, p.ids);
      emit('trip:' + p.tripId);
      break;
    }
    default: break;
  }
  persistSoon();
}

function reorder(d, ids) {
  const byId = new Map(d.stops.map((s) => [s.id, s]));
  const out = [];
  for (const id of ids) { const s = byId.get(id); if (s) { out.push(s); byId.delete(id); } }
  for (const s of d.stops) if (byId.has(s.id)) out.push(s);
  out.forEach((s, i) => { s.position = i; });
  d.stops = out;
}

// ---------- Daten vom Server ----------
export function setTrips(list) {
  const old = new Map((state.trips || []).map((t) => [t.id, t]));
  state.trips = list.map((t) => ({ ...t, cover_local: old.get(t.id)?.cover_local && t.has_cover ? old.get(t.id).cover_local : null }));
  emit('trips');
  persistSoon();
}

export function setSnapshot(tripId, snap) {
  const prev = state.tripData[tripId];
  state.tripData[tripId] = {
    trip: { ...snap.trip, cover_local: prev?.trip?.cover_local || null },
    role: snap.role,
    members: snap.members,
    stops: sortedByPosition(snap.stops),
    media: snap.media || [],
    online: snap.online || [],
    invites: snap.invites || (prev?.invites ?? null),
  };
  const s = tripSummary(tripId);
  if (s) { s.role = snap.role; s.members = snap.members; s.title = snap.trip.title; s.start_date = snap.trip.start_date; s.end_date = snap.trip.end_date; s.has_cover = snap.trip.has_cover; s.cover_version = snap.trip.cover_version; }
  recount(tripId);
  emit('trips'); emit('trip:' + tripId);
  persistSoon();
}

export function applyEvent(tripId, k, v) {
  const d = state.tripData[tripId];
  if (!d) return;
  switch (k) {
    case 'stop': {
      const i = d.stops.findIndex((s) => s.id === v.stop.id);
      if (i >= 0) d.stops[i] = v.stop; else d.stops.push(v.stop);
      sortedByPosition(d.stops);
      break;
    }
    case 'stop.del':
      d.stops = d.stops.filter((s) => s.id !== v.id);
      d.media.forEach((m) => { if (m.stop_id === v.id) m.stop_id = null; });
      break;
    case 'media': {
      const i = d.media.findIndex((m) => m.id === v.media.id);
      if (i >= 0) d.media[i] = v.media; else d.media.push(v.media);
      break;
    }
    case 'media.del': d.media = d.media.filter((m) => m.id !== v.id); break;
    case 'stops.order': reorder(d, v.ids); break;
    case 'trip': {
      d.trip = { ...v.trip, cover_local: v.trip.cover_version === d.trip.cover_version ? d.trip.cover_local : null };
      const s = tripSummary(tripId);
      if (s) Object.assign(s, { title: v.trip.title, start_date: v.trip.start_date, end_date: v.trip.end_date, has_cover: v.trip.has_cover, cover_version: v.trip.cover_version });
      break;
    }
    case 'members': {
      d.members = v.members;
      const me = v.members.find((m) => m.id === state.user?.id);
      if (me) d.role = me.role;
      const s = tripSummary(tripId);
      if (s) { s.members = v.members; if (me) s.role = me.role; }
      break;
    }
    case 'presence': d.online = v.online; break;
    default: break;
  }
  recount(tripId);
  emit('trip:' + tripId);
  if (k === 'trip' || k === 'members') emit('trips');
  persistSoon();
}

// Fotos und Videos einer Reise: fertige vom Server plus noch wartende Uploads (chronologisch)
export function mediaOf(tripId) {
  const d = state.tripData[tripId];
  const list = (d?.media || []).slice();
  for (const u of state.uploads[tripId] || []) {
    list.push({
      id: u.id, pending: true, status: u.status, error: u.error, kind: u.kind, stop_id: u.stopId, url: u.kind === 'image' ? u.previewUrl : null,
      thumb: u.previewUrl, width: u.width, height: u.height, duration: u.duration, caption: u.caption || '', taken_at: u.taken_at,
      created_by: u.userId, created_at: u.createdAt,
    });
  }
  const t = (m) => Date.parse(m.taken_at || m.created_at) || 0;
  return list.sort((a, b) => t(a) - t(b));
}
