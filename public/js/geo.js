// Ortssuche, Routen und Entfernungen – nur freie Dienste ohne Kreditkarte
import { idbGet, idbSet } from './idb.js';

export function haversine(a, b) {
  const R = 6371000;
  const rad = (x) => (x * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat), dLon = rad(b.lon - a.lon);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

async function fetchJson(url, { timeout = 9000, signal } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  signal?.addEventListener('abort', () => ctrl.abort());
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return await res.json();
  } finally { clearTimeout(t); }
}

// ---------- Suche ----------
function uniq(parts) {
  const out = [];
  for (const p of parts) if (p && !out.includes(p)) out.push(p);
  return out;
}

async function photon(q, bias, signal) {
  const params = new URLSearchParams({ q, lang: 'de', limit: '7' });
  if (bias) { params.set('lat', bias.lat.toFixed(3)); params.set('lon', bias.lon.toFixed(3)); }
  const data = await fetchJson('https://photon.komoot.io/api/?' + params, { signal });
  return (data.features || []).filter((f) => f.geometry?.coordinates).map((f) => {
    const p = f.properties || {};
    const street = [p.street, p.housenumber].filter(Boolean).join(' ');
    const title = p.name || street || p.city || p.state || p.country || 'Ort';
    const sub = uniq([p.name ? street : '', [p.postcode, p.city || p.district].filter(Boolean).join(' '), p.state, p.country]).filter((x) => x && x !== title).join(', ');
    return { title, subtitle: sub, lat: f.geometry.coordinates[1], lon: f.geometry.coordinates[0], kind: p.osm_value || p.type || '' };
  });
}

let lastNominatim = 0;
async function nominatimGate() {
  const wait = lastNominatim + 1100 - Date.now();
  lastNominatim = Date.now() + Math.max(0, wait);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
}

async function nominatim(q, bias, signal) {
  await nominatimGate();
  const params = new URLSearchParams({ q, format: 'jsonv2', limit: '7', 'accept-language': 'de', addressdetails: '1' });
  const data = await fetchJson('https://nominatim.openstreetmap.org/search?' + params, { signal });
  return data.map((r) => {
    const parts = String(r.display_name || '').split(', ');
    const title = r.name || parts[0] || 'Ort';
    return { title, subtitle: parts.filter((x) => x !== title).slice(0, 4).join(', '), lat: Number(r.lat), lon: Number(r.lon), kind: r.type || '' };
  });
}

// Tippen-Suche: erst Photon, dann Nominatim als Rückfall
export async function searchPlaces(q, bias, signal) {
  q = q.trim();
  if (q.length < 2) return [];
  try {
    const r = await photon(q, bias, signal);
    if (r.length) return r;
  } catch (e) { if (e.name === 'AbortError' && signal?.aborted) throw e; }
  return nominatim(q, bias, signal);
}

export async function reverseGeocode(lat, lon, zoom = 14) {
  try {
    await nominatimGate();
    const params = new URLSearchParams({ format: 'jsonv2', lat: String(lat), lon: String(lon), zoom: String(Math.max(5, Math.min(18, Math.round(zoom)))), 'accept-language': 'de', addressdetails: '1' });
    const r = await fetchJson('https://nominatim.openstreetmap.org/reverse?' + params, { timeout: 8000 });
    if (r.error) return null;
    const a = r.address || {};
    const place = a.city || a.town || a.village || a.hamlet || a.municipality || a.suburb || a.county || '';
    const title = r.name || a.tourism || a.amenity || (a.road ? a.road + (a.house_number ? ' ' + a.house_number : '') : '') || place || (r.display_name || '').split(', ')[0];
    const parts = String(r.display_name || '').split(', ');
    const subtitle = uniq([place !== title ? place : '', a.state, a.country]).join(', ') || parts.slice(1, 4).join(', ');
    return { title, subtitle };
  } catch { return null; }
}

// ---------- Route ----------
const OSRM_HOSTS = ['https://router.project-osrm.org', 'https://routing.openstreetmap.de/routed-car'];
const CHUNK = 20;

function simplify(points, tol) {
  if (points.length < 3) return points;
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  const sq = tol * tol;
  while (stack.length) {
    const [a, b] = stack.pop();
    let max = 0, idx = -1;
    const [ay, ax] = points[a], [by, bx] = points[b];
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    for (let i = a + 1; i < b; i++) {
      const [py, px] = points[i];
      let t = len2 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
      t = Math.max(0, Math.min(1, t));
      const ex = ax + t * dx - px, ey = ay + t * dy - py;
      const d = ex * ex + ey * ey;
      if (d > max) { max = d; idx = i; }
    }
    if (max > sq && idx > 0) { keep[idx] = 1; stack.push([a, idx], [idx, b]); }
  }
  return points.filter((_, i) => keep[i]);
}

async function osrmChunk(pts, signal) {
  const coords = pts.map((p) => `${p.lon.toFixed(6)},${p.lat.toFixed(6)}`).join(';');
  let lastErr;
  for (const host of OSRM_HOSTS) {
    try {
      const data = await fetchJson(`${host}/route/v1/driving/${coords}?overview=full&geometries=geojson&steps=false`, { timeout: 12000, signal });
      if (data.code !== 'Ok' || !data.routes?.[0]) throw new Error(data.code || 'Keine Route');
      const r = data.routes[0];
      return {
        line: r.geometry.coordinates.map(([lon, lat]) => [lat, lon]),
        legs: r.legs.map((l) => ({ distance: l.distance, duration: l.duration })),
      };
    } catch (e) { lastErr = e; if (signal?.aborted) throw e; }
  }
  throw lastErr || new Error('Route nicht verfügbar');
}

function fallbackRoute(pts) {
  const legs = [];
  const line = pts.map((p) => [p.lat, p.lon]);
  for (let i = 0; i < pts.length - 1; i++) {
    const d = haversine(pts[i], pts[i + 1]) * 1.28; // Straßen sind länger als Luftlinie
    legs.push({ distance: d, duration: d / (d > 80000 ? 22 : 13) });
  }
  return { line, legs };
}

const memo = new Map();
function keyFor(pts) { return pts.map((p) => p.lat.toFixed(5) + ',' + p.lon.toFixed(5)).join('|'); }
function hash(s) { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0; return (h >>> 0).toString(36); }

export async function computeRoute(points, { signal } = {}) {
  if (points.length < 2) return { line: points.map((p) => [p.lat, p.lon]), legs: [], total: { distance: 0, duration: 0 }, approx: false };
  const key = keyFor(points);
  if (memo.has(key)) return memo.get(key);
  const stored = await idbGet('route:' + hash(key));
  if (stored && stored.key === key) { memo.set(key, stored.value); return stored.value; }

  let line = [];
  const legs = [];
  let approx = false;
  for (let i = 0; i < points.length - 1; i += CHUNK - 1) {
    const part = points.slice(i, i + CHUNK);
    if (part.length < 2) break;
    let res;
    try { res = await osrmChunk(part, signal); }
    catch (e) { if (signal?.aborted) throw e; res = fallbackRoute(part); approx = true; }
    line = line.concat(line.length ? res.line.slice(1) : res.line);
    legs.push(...res.legs);
  }
  const value = {
    line: simplify(line, 0.00012),
    legs,
    total: legs.reduce((a, l) => ({ distance: a.distance + l.distance, duration: a.duration + l.duration }), { distance: 0, duration: 0 }),
    approx,
  };
  memo.set(key, value);
  if (memo.size > 40) memo.delete(memo.keys().next().value);
  if (!approx) idbSet('route:' + hash(key), { key, value }).catch(() => {});
  return value;
}
