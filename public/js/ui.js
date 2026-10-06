// UI-Helfer: Elemente bauen, Sheets, Dialoge, Toasts, Rücktaste-Verwaltung
import { icon } from './icons.js';

export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'html') el.innerHTML = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'value') el.value = v;
      else if (v === true) el.setAttribute(k, '');
      else el.setAttribute(k, v);
    }
  }
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return el;
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
export function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); return el; }
export function esc(s) { return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

export function debounce(fn, ms) {
  let t;
  const d = (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
  d.flush = (...a) => { clearTimeout(t); fn(...a); };
  d.cancel = () => clearTimeout(t);
  return d;
}

// ---------- Datum ----------
const MONTHS = ['Jan.', 'Feb.', 'März', 'Apr.', 'Mai', 'Juni', 'Juli', 'Aug.', 'Sept.', 'Okt.', 'Nov.', 'Dez.'];
const WEEKDAYS = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];
export function parseDay(s) {
  if (!s) return null;
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}
export function fmtDay(s, { weekday = false } = {}) {
  const d = parseDay(s);
  if (!d) return '';
  return `${weekday ? WEEKDAYS[d.getDay()] + ', ' : ''}${d.getDate()}. ${MONTHS[d.getMonth()]}`;
}
export function fmtRange(a, b) {
  if (!a && !b) return 'Ohne Datum';
  if (a && !b) return `ab ${fmtDay(a)} ${parseDay(a).getFullYear()}`;
  if (!a && b) return `bis ${fmtDay(b)} ${parseDay(b).getFullYear()}`;
  const da = parseDay(a), db = parseDay(b);
  if (a === b) return `${fmtDay(a)} ${da.getFullYear()}`;
  if (da.getFullYear() === db.getFullYear()) {
    if (da.getMonth() === db.getMonth()) return `${da.getDate()}.–${db.getDate()}. ${MONTHS[da.getMonth()]} ${da.getFullYear()}`;
    return `${fmtDay(a)} – ${fmtDay(b)} ${db.getFullYear()}`;
  }
  return `${fmtDay(a)} ${da.getFullYear()} – ${fmtDay(b)} ${db.getFullYear()}`;
}
export function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
export function fmtKm(m) {
  const km = m / 1000;
  if (km < 10) return km.toFixed(1).replace('.', ',') + ' km';
  return Math.round(km).toLocaleString('de-DE') + ' km';
}
export function fmtDur(sec) {
  const min = Math.round(sec / 60);
  if (min < 1) return '1 Min';
  const hh = Math.floor(min / 60), mm = min % 60;
  if (!hh) return `${mm} Min`;
  return mm ? `${hh} Std ${mm} Min` : `${hh} Std`;
}

// ---------- Avatare ----------
export function initials(name) {
  const parts = String(name || '?').trim().split(/\s+/);
  return ((parts[0]?.[0] || '?') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
}
export function avatar(user, cls = '', online = false) {
  return h('span', { class: `avatar ${cls} ${online ? 'online' : ''}`, style: { background: user.color || '#888' }, title: user.name }, initials(user.name));
}
export function avatarStack(users, max = 4) {
  const wrap = h('span', { class: 'avatars' });
  users.slice(0, max).forEach((u) => wrap.append(avatar(u)));
  if (users.length > max) wrap.append(h('span', { class: 'avatar more' }, '+' + (users.length - max)));
  return wrap;
}

// ---------- Toasts ----------
export function toast(message, { error = false, action, actionLabel, ms = 3800 } = {}) {
  const root = $('#toasts');
  const el = h('div', { class: `toast ${error ? 'error' : ''}` }, h('span', null, message));
  if (action) {
    el.append(h('button', { onclick: () => { action(); el.remove(); } }, actionLabel || 'OK'));
  }
  root.append(el);
  setTimeout(() => { el.style.transition = 'opacity .25s'; el.style.opacity = '0'; setTimeout(() => el.remove(), 260); }, ms);
  while (root.children.length > 3) root.firstChild.remove();
  return el;
}

// ---------- Ebenen (Sheets/Dialoge) mit Zurück-Taste ----------
const stack = [];

export function layerDepth() { return stack.length; }

function removeLayer(layer, fromPop) {
  const i = stack.indexOf(layer);
  if (i < 0) return;
  stack.splice(i, 1);
  layer.closing = true;
  for (const el of layer.els) el.classList.add('closing');
  setTimeout(() => { layer.els.forEach((e) => e.remove()); }, 210);
  try { layer.onClose?.(); } catch (e) { console.error(e); }
  layer.resolveClosed?.();
  if (!fromPop) { /* History-Eintrag wurde bereits über history.back() entfernt */ }
}

// Wird vom Router bei jedem popstate aufgerufen: Zurück-Taste schließt die oberste Ebene
export function handleLayerPop() {
  if (!stack.length) return false;
  const top = stack[stack.length - 1];
  if (top.dismissible === false && !top.programmatic) {
    history.pushState({ layer: stack.length }, ''); // Zurück-Taste ignorieren
    return true;
  }
  removeLayer(top, true);
  return true;
}

export function openLayer(els, { onClose, dismissible = true } = {}) {
  const root = $('#layers');
  const layer = { els, onClose, dismissible };
  layer.closed = new Promise((r) => { layer.resolveClosed = r; });
  layer.close = () => {
    if (layer.closing) return layer.closed;
    layer.programmatic = true;
    const idx = stack.indexOf(layer);
    if (idx === stack.length - 1) {
      history.back(); // popstate entfernt die Ebene
    } else {
      removeLayer(layer, false);
    }
    return layer.closed;
  };
  els.forEach((e) => root.append(e));
  history.pushState({ layer: stack.length + 1 }, '');
  stack.push(layer);
  return layer;
}

export async function closeAllLayers() {
  while (stack.length) await stack[stack.length - 1].close();
}

export function sheet({ title, body, footer, onClose, dismissible = true, tall = false }) {
  const backdrop = h('div', { class: 'backdrop' });
  const grab = h('div', { class: 'grab' }, h('i'));
  const bodyEl = h('div', { class: 'sheet-body' }, body);
  const headEl = title ? h('div', { class: 'sheet-head' }, h('h2', null, title), dismissible ? iconBtn('close', { label: 'Schließen', cls: 'flat', onclick: () => layer.close() }) : null) : null;
  const el = h('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true', style: tall ? { height: '92dvh' } : null }, grab, headEl, bodyEl, footer || null);
  const layer = openLayer([backdrop, el], { onClose, dismissible });
  if (dismissible) backdrop.addEventListener('click', () => layer.close());

  // Wegwischen am Griff
  let startY = null;
  grab.addEventListener('pointerdown', (e) => { startY = e.clientY; grab.setPointerCapture(e.pointerId); el.style.animation = 'none'; el.style.transition = 'none'; });
  grab.addEventListener('pointermove', (e) => {
    if (startY === null) return;
    el.style.transform = `translateY(${Math.max(0, e.clientY - startY)}px)`;
  });
  const end = (e) => {
    if (startY === null) return;
    const dy = e.clientY - startY;
    startY = null;
    el.style.transition = 'transform .2s';
    if (dy > 90 && dismissible) { layer.close(); } else { el.style.transform = ''; }
  };
  grab.addEventListener('pointerup', end);
  grab.addEventListener('pointercancel', end);
  layer.body = bodyEl;
  layer.el = el;
  return layer;
}

export function confirmDialog({ title, text, confirmLabel = 'OK', cancelLabel = 'Abbrechen', danger = false }) {
  return new Promise((resolve) => {
    let result = false;
    const backdrop = h('div', { class: 'backdrop' });
    const el = h('div', { class: 'dialog', role: 'alertdialog', 'aria-modal': 'true' },
      h('h3', null, title),
      text ? h('p', null, text) : null,
      h('div', { class: 'btns' },
        h('button', { class: 'btn ghost', onclick: () => layer.close() }, cancelLabel),
        h('button', { class: `btn ${danger ? 'danger' : ''}`, onclick: () => { result = true; layer.close(); } }, confirmLabel),
      ));
    const layer = openLayer([backdrop, el], { onClose: () => resolve(result) });
    backdrop.addEventListener('click', () => layer.close());
  });
}

// ---------- Kleinkram ----------
export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = h('textarea', { style: { position: 'fixed', opacity: 0 } });
    ta.value = text;
    document.body.append(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch {}
    ta.remove();
    return ok;
  }
}

export function iconEl(name, cls = '') {
  const span = document.createElement('span');
  span.style.display = 'contents';
  span.innerHTML = icon(name, cls);
  return span.firstChild;
}

export function iconBtn(name, { label, onclick, cls = '' } = {}) {
  const b = h('button', { class: `icon-btn ${cls}`, 'aria-label': label, onclick });
  b.append(iconEl(name));
  return b;
}
