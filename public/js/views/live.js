// Unterwegs: Route und eigener Standort (nur auf Wunsch), Stopps abhaken, Fotos und Videos aufnehmen
import { h, clear, iconEl, iconBtn, toast, confirmDialog, fmtDay, fmtKm } from '../ui.js';
import { state, on, canEdit, mediaOf } from '../state.js';
import { net } from '../net.js';
import { TripMap } from '../map.js';
import { createDock } from '../dock.js';
import { computeRoute, haversine } from '../geo.js';
import { pickFiles } from '../img.js';
import { addFiles } from '../media.js';
import { openAddMedia, mediaGrid } from './mediaUi.js';
import { openItem } from './lightbox.js';
import { openStopSheet } from './stopSheet.js';

let askedAboutLocation = false;

export function createLive({ tripId, navigate }) {
  const data = () => state.tripData[tripId];
  const el = h('div', { class: 'plan live', style: { position: 'absolute', inset: '0' } });
  const mapWrap = h('div', { class: 'map-wrap' });
  const mapEl = h('div', { class: 'map-el' });
  mapWrap.append(mapEl);

  let currentId = null;      // vom Nutzer gewählter Stopp; sonst automatisch der nächste offene
  let destroyed = false;
  let didFit = false;
  let route = null;
  let routeKey = '';
  let locOn = false;
  let watchId = null;
  let firstFix = true;
  let arrivalAsked = new Set();
  let visible = false;

  const map = new TripMap(mapEl, {
    onTap: () => {},
    onMarkerTap: (id) => { setCurrent(id, { fly: false }); return true; },
  });
  const ro = new ResizeObserver(() => map.invalidate());
  ro.observe(mapEl);

  // ---------- Oben ----------
  const titleB = h('b', null, '');
  const pill = h('div', { class: 'title-pill static' }, titleB);
  const top = h('div', { class: 'map-top' }, iconBtn('back', { label: 'Zurück zu meinen Reisen', onclick: () => navigate('/') }), pill);

  // ---------- Kartenknöpfe ----------
  const locBtn = iconBtn('locate', { label: 'Meinen Standort anzeigen', onclick: () => onLocClick() });
  const fabs = h('div', { class: 'map-fabs' },
    locBtn,
    iconBtn('route', { label: 'Ganze Route zeigen', onclick: () => fitAll() }));

  // ---------- Dock ----------
  const dockTitle = h('h2', null, 'Unterwegs');
  const dockSub = h('span', { class: 'sub' }, '');
  const bar = h('div', { class: 'progress' }, h('i'));
  const body = h('div', { class: 'live-body' });
  const dock = createDock({
    header: [h('div', { style: { flex: 1, minWidth: 0 } }, dockTitle, dockSub, bar)],
    body,
  });
  el.append(mapWrap, top, fabs, dock.el);

  // ---------- Hilfen ----------
  function stops() { return data()?.stops || []; }
  function autoCurrent() {
    const list = stops();
    return list.find((s) => !s.visited_at)?.id || list[list.length - 1]?.id || null;
  }
  function current() {
    const list = stops();
    return list.find((s) => s.id === currentId) || list.find((s) => s.id === autoCurrent()) || null;
  }
  function distanceToMe(s) {
    if (!locOn || !state.lastFix || !s) return null;
    return haversine(state.lastFix, { lat: s.lat, lon: s.lon });
  }

  function setCurrent(id, { fly = true } = {}) {
    currentId = id;
    const s = current();
    draw();
    if (s && fly) map.flyTo(s.lat, s.lon, { zoom: Math.max(map.zoom(), 11), bottomPad: dock.height() + 20 });
  }

  function fitAll(animate = true) {
    const pts = stops().slice();
    if (locOn && state.lastFix) pts.push({ lat: state.lastFix.lat, lon: state.lastFix.lon });
    if (!pts.length) return;
    map.fit(pts, { bottomPad: dock.height() + 10, topPad: 80, animate });
  }

  async function refreshRoute() {
    const pts = stops().map((s) => ({ lat: s.lat, lon: s.lon }));
    const key = pts.map((p) => `${p.lat},${p.lon}`).join('|');
    if (key === routeKey) return;
    routeKey = key;
    if (pts.length < 2) { route = null; map.setRoute([]); return; }
    try {
      const r = await computeRoute(pts);
      if (key !== routeKey || destroyed) return;
      route = r; map.setRoute(r.line); draw();
    } catch { /* Karte zeigt dann nur die Pins */ }
  }

  // ---------- Standort (nur auf Wunsch) ----------
  async function toggleLoc() {
    if (locOn) { stopLoc(); toast('Standort ausgeschaltet'); return; }
    if (!navigator.geolocation) { toast('Dieses Gerät kann den Standort nicht bestimmen.', { error: true }); return; }
    if (!askedAboutLocation) {
      const ok = await confirmDialog({
        title: 'Standort anzeigen?',
        text: 'Dein Standort erscheint nur auf deiner eigenen Karte. Er wird nicht gespeichert und nicht mit den anderen geteilt. Brave fragt dich gleich noch einmal um Erlaubnis.',
        confirmLabel: 'Standort einschalten',
      });
      if (!ok) return;
      askedAboutLocation = true;
    }
    startLoc();
  }

  function startLoc() {
    locOn = true; firstFix = true;
    paintLoc();
    watchGeo();
  }

  function watchGeo() {
    if (watchId !== null) return;
    watchId = navigator.geolocation.watchPosition((pos) => {
      const { latitude: lat, longitude: lon, accuracy: acc } = pos.coords;
      state.lastFix = { lat, lon, acc, at: Date.now() };
      map.setMe([lat, lon]);
      if (firstFix) { firstFix = false; fitAll(); }
      paintLoc();
      draw();
      checkArrival();
    }, (err) => {
      stopLoc();
      toast(err.code === 1
        ? 'Der Standort ist nicht erlaubt. Du kannst das in den Seiteneinstellungen von Brave ändern (Schloss-Symbol).'
        : 'Dein Standort ist gerade nicht verfügbar.', { error: true, ms: 6000 });
    }, { enableHighAccuracy: true, maximumAge: 10000, timeout: 30000 });
  }

  function unwatchGeo() {
    if (watchId !== null) { navigator.geolocation.clearWatch(watchId); watchId = null; }
  }

  function stopLoc() {
    unwatchGeo();
    locOn = false;
    state.lastFix = null;
    map.setMe(null);
    paintLoc(); draw();
  }

  let recentTap = 0;
  function onLocClick() {
    // Ist der Standort an, springt der erste Tipp zu mir; ein zweiter Tipp kurz danach schaltet ihn aus
    if (locOn && state.lastFix && Date.now() - recentTap > 2500) {
      recentTap = Date.now();
      map.flyTo(state.lastFix.lat, state.lastFix.lon, { zoom: Math.max(map.zoom(), 13), bottomPad: dock.height() });
      return;
    }
    toggleLoc();
  }

  function paintLoc() {
    locBtn.classList.toggle('accent', locOn);
    locBtn.setAttribute('aria-label', locOn ? 'Zu meinem Standort springen (nochmal tippen: ausschalten)' : 'Meinen Standort anzeigen');
  }

  function checkArrival() {
    const s = current();
    if (!s || s.visited_at || !canEdit(tripId) || arrivalAsked.has(s.id)) return;
    const d = distanceToMe(s);
    if (d !== null && d < 150) {
      arrivalAsked.add(s.id);
      toast(`Du bist bei „${s.name}“ angekommen.`, { actionLabel: 'Abhaken', action: () => visit(s, true), ms: 9000 });
    }
  }

  // ---------- Aktionen ----------
  function visit(s, value) {
    net.mutate('stop.visit', { tripId, stopId: s.id, visited: value });
    if (value && currentId === s.id) currentId = null; // springt zum nächsten offenen Stopp
    setTimeout(() => { draw(); const n = current(); if (n && value) map.flyTo(n.lat, n.lon, { zoom: Math.max(map.zoom(), 10), bottomPad: dock.height() + 20 }); }, 30);
  }

  async function capture(s, accept) {
    const files = await pickFiles(accept, { capture: 'environment' });
    if (!files.length) return;
    if (!state.config.media) { toast('Der Foto-Speicher ist noch nicht eingerichtet.', { error: true }); return; }
    await addFiles(tripId, s?.id || null, files);
  }

  // ---------- Darstellung ----------
  function draw() {
    if (destroyed) return;
    const d = data();
    if (!d) return;
    titleB.textContent = d.trip.title;
    const list = d.stops;
    const done = list.filter((s) => s.visited_at).length;
    dockSub.textContent = list.length ? `${done} von ${list.length} Stopps besucht` : 'Noch keine Stopps';
    bar.firstChild.style.width = list.length ? `${Math.round((done / list.length) * 100)}%` : '0%';
    map.setStops(list, { selectedId: current()?.id });
    clear(body);
    const editor = canEdit(tripId);
    const cur = current();
    if (!cur) {
      body.append(h('div', { class: 'empty', style: { margin: '4px 4px 0', boxShadow: 'none', background: 'var(--card)' } },
        h('h2', { class: 'display', style: { fontSize: '20px' } }, 'Noch keine Stopps'),
        h('p', { style: { marginBottom: 0 } }, 'Lege im Tab „Plan“ zuerst die Stopps an. Hier kannst du sie dann unterwegs abhaken und Fotos machen.')));
      return;
    }
    const idx = list.indexOf(cur);
    const dist = distanceToMe(cur);
    const sub = [];
    if (cur.planned_date) sub.push(fmtDay(cur.planned_date, { weekday: true }));
    if (dist !== null) sub.push(dist < 150 ? 'du bist hier' : `${fmtKm(dist)} von dir`);
    if (cur.visited_at) sub.push('besucht');
    const items = mediaOf(tripId).filter((m) => m.stop_id === cur.id);
    const getItems = () => mediaOf(tripId).filter((m) => m.stop_id === cur.id);

    const card = h('div', { class: 'live-card' },
      h('button', { class: 'lc-head', onclick: () => openStopSheet({ tripId, stopId: cur.id }) },
        h('span', { class: `num ${cur.visited_at ? 'ok' : ''}` }, cur.visited_at ? iconEl('check', 'sm') : String(idx + 1)),
        h('span', { class: 'txt' }, h('small', null, cur.visited_at ? 'Zuletzt gewählt' : 'Aktueller Stopp'), h('b', null, cur.name), sub.length ? h('span', null, sub.join(' · ')) : null),
        iconEl('chevron')),
      editor ? h('div', { class: 'lc-actions' },
        h('button', { class: `btn ${cur.visited_at ? 'soft' : ''}`, onclick: () => visit(cur, !cur.visited_at) }, iconEl('check', 'sm'), cur.visited_at ? 'Besucht' : 'Abhaken'),
        h('button', { class: 'btn soft', onclick: () => capture(cur, 'image/*') }, iconEl('camera', 'sm'), 'Foto'),
        h('button', { class: 'btn soft', onclick: () => capture(cur, 'video/*') }, iconEl('video', 'sm'), 'Video'),
        h('button', { class: 'icon-btn flat', 'aria-label': 'Aus Galerie hinzufügen', onclick: () => openAddMedia({ tripId, stopId: cur.id, stopName: cur.name }) }, iconEl('image'))) : null,
      items.length ? mediaGrid(items.slice(-8), { tripId, cls: 'compact', onOpen: (m) => openItem({ tripId, m, getItems }) }) : null);
    body.append(card);

    const next = list.filter((s) => s.id !== cur.id && !s.visited_at);
    if (next.length) {
      body.append(h('div', { class: 'section-title tight' }, 'Als Nächstes'));
      const wrap = h('div', { class: 'stops' });
      next.forEach((s) => {
        const n = list.indexOf(s) + 1;
        const dd = distanceToMe(s);
        wrap.append(h('div', { class: 'stop mini', role: 'button', tabindex: '0', onclick: () => setCurrent(s.id) },
          h('span', { class: 'num' }, String(n)),
          h('div', { class: 'txt' }, h('b', null, s.name), h('span', null, [s.planned_date ? fmtDay(s.planned_date, { weekday: true }) : null, dd !== null ? `${fmtKm(dd)} von dir` : null].filter(Boolean).join(' · ') || 'Tippen zum Anzeigen'))));
      });
      body.append(wrap);
    }
    const doneList = list.filter((s) => s.visited_at && s.id !== cur.id);
    if (doneList.length) {
      body.append(h('div', { class: 'section-title tight' }, 'Schon besucht'));
      const wrap = h('div', { class: 'stops' });
      doneList.forEach((s) => {
        wrap.append(h('div', { class: 'stop mini visited', role: 'button', tabindex: '0', onclick: () => setCurrent(s.id) },
          h('span', { class: 'num' }, iconEl('check', 'sm')),
          h('div', { class: 'txt' }, h('b', null, s.name), h('span', null, `${mediaOf(tripId).filter((m) => m.stop_id === s.id).length} Fotos und Videos`))));
      });
      body.append(wrap);
    }
    if (!editor) body.append(h('p', { class: 'hint center', style: { margin: '14px 0 0' } }, 'Du kannst diese Reise nur ansehen.'));
  }

  let raf = 0;
  const offData = on('trip:' + tripId, () => {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => {
      if (destroyed || !data()) return;
      if (currentId && !stops().some((s) => s.id === currentId)) currentId = null;
      draw(); refreshRoute();
      if (!didFit && visible && stops().length) { didFit = true; fitAll(false); }
    });
  });

  paintLoc();
  dock.set('half', false);
  if (data()) { draw(); refreshRoute(); }

  return {
    el,
    show() {
      visible = true;
      map.invalidate(); dock.set(dock.state, false);
      if (!didFit && stops().length) { didFit = true; setTimeout(() => fitAll(false), 60); }
      if (locOn) watchGeo();
      draw();
    },
    hide() { visible = false; unwatchGeo(); }, // spart Akku, solange der Tab nicht offen ist
    destroy() {
      destroyed = true;
      offData(); ro.disconnect(); unwatchGeo(); state.lastFix = null; dock.destroy(); map.destroy();
    },
  };
}
