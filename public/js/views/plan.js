// Plan: Karte mit Stopps, Route, Ortssuche und Stopp-Liste
import { h, clear, toast, iconEl, iconBtn, openLayer, debounce, fmtDay, fmtKm, fmtDur, avatarStack, esc } from '../ui.js';
import { state, on, canEdit } from '../state.js';
import { net } from '../net.js';
import { TripMap } from '../map.js';
import { createDock } from '../dock.js';
import { searchPlaces, reverseGeocode, computeRoute } from '../geo.js';
import { newId } from '../util.js';
import { enableReorder } from './reorder.js';
import { openStopSheet } from './stopSheet.js';

export function createPlan({ tripId, navigate, goTeam }) {
  const data = () => state.tripData[tripId];
  const el = h('div', { class: 'plan', style: { position: 'absolute', inset: '0' } });
  const mapWrap = h('div', { class: 'map-wrap' });
  const mapEl = h('div', { id: 'map' });
  mapWrap.append(mapEl);

  let selectedId = null;
  let mode = 'browse';           // browse | search | draft | move
  let draft = null;
  let modeLayer = null;
  let route = null;
  let routeKey = '';
  let routeLoading = false;
  let routeAbort = null;
  let didFit = false;
  let lastDrag = 0;
  let destroyed = false;

  const map = new TripMap(mapEl, {
    onTap: (ll) => {
      if (mode === 'search' || mode === 'draft') { if (canEdit(tripId)) placeDraft(ll.lat, ll.lng); }
      else if (mode === 'browse' && selectedId) { selectedId = null; syncMap(); renderList(); }
    },
    onLongPress: (ll) => { if (mode === 'browse' && canEdit(tripId)) { enterMode('draft'); placeDraft(ll.lat, ll.lng); } },
    onMarkerTap: (id) => { if (mode !== 'browse') return false; selectStop(id, { open: true }); return true; },
    onDraftMove: (ll) => { if (draft) { draft.lat = ll.lat; draft.lon = ll.lng; if (!draft.stopId && !draft.touched) lookupName(); } },
  });
  const ro = new ResizeObserver(() => map.invalidate());
  ro.observe(mapEl);

  // ---------- Oben: Zurück, Titel, Suche ----------
  const pillTitle = h('b', null, '');
  const pillAvatars = h('span');
  const pill = h('button', { class: 'title-pill', onclick: () => goTeam(), 'aria-label': 'Reise-Details und Mitreisende' }, pillTitle, pillAvatars);
  const searchBtn = iconBtn('search', { label: 'Stopp suchen und hinzufügen', onclick: () => enterSearch() });
  const top = h('div', { class: 'map-top' }, iconBtn('back', { label: 'Zurück zu meinen Reisen', onclick: () => navigate('/') }), pill, searchBtn);

  // ---------- Rechts: Kartenknöpfe ----------
  const fabs = h('div', { class: 'map-fabs' },
    iconBtn('route', { label: 'Ganze Route zeigen', onclick: () => fitAll() }));

  // ---------- Dock mit Liste ----------
  const dockTitle = h('h2', null, 'Route');
  const dockSub = h('span', { class: 'sub' }, '');
  const addBtn = h('button', { class: 'btn small', onclick: () => enterSearch() }, iconEl('plus', 'sm'), 'Stopp');
  const listEl = h('div', { class: 'stops' });
  const dock = createDock({
    header: [h('div', { style: { flex: 1, minWidth: 0 } }, dockTitle, dockSub), addBtn],
    body: listEl,
    onChange: () => {},
  });
  const stopReorder = enableReorder(listEl, dock.body, {
    onDrop: (ids) => { lastDrag = Date.now(); net.mutate('stop.reorder', { tripId, ids }); },
  });

  el.append(mapWrap, top, fabs, dock.el);

  // ---------- Darstellung ----------
  function updateTop() {
    const d = data();
    if (!d) return;
    pillTitle.textContent = d.trip.title;
    pillAvatars.replaceChildren(d.members.length > 1 ? avatarStack(d.members, 3) : iconEl('users', 'sm'));
    const editor = canEdit(tripId);
    searchBtn.style.display = editor ? '' : 'none';
    addBtn.style.display = editor ? '' : 'none';
  }

  function summaryText() {
    const d = data();
    const n = d?.stops.length || 0;
    const parts = [`${n} ${n === 1 ? 'Stopp' : 'Stopps'}`];
    if (n >= 2) {
      if (route) parts.push(`${route.approx ? '~' : ''}${fmtKm(route.total.distance)}`, `${route.approx ? '~' : ''}${fmtDur(route.total.duration)}`);
      else if (routeLoading) parts.push('Route wird berechnet …');
    }
    const visited = d?.stops.filter((s) => s.visited_at).length || 0;
    if (visited) parts.push(`${visited} besucht`);
    return parts.join(' · ');
  }

  function subline(s) {
    const bits = [];
    if (s.planned_date) bits.push(fmtDay(s.planned_date, { weekday: true }));
    if (s.visited_at) bits.push('besucht');
    const first = (s.description || '').split('\n')[0].trim();
    if (first) bits.push(first);
    return bits.join(' · ') || 'Tippen für Details';
  }

  function renderList() {
    const d = data();
    if (!d) return;
    dockSub.textContent = summaryText();
    if (listEl.classList.contains('sorting')) return;
    clear(listEl);
    const editor = canEdit(tripId);
    if (!d.stops.length) {
      listEl.append(h('div', { class: 'empty', style: { margin: '4px 4px 0', boxShadow: 'none', background: 'var(--card)' } },
        h('h2', { class: 'display', style: { fontSize: '20px' } }, 'Noch keine Stopps'),
        h('p', { style: { marginBottom: editor ? '16px' : '0' } }, editor ? 'Suche einen Ort oder tippe auf die Karte. Mit gedrückter Karte setzt du auch direkt einen Pin.' : 'Hier erscheinen die Stopps, sobald jemand welche hinzufügt.'),
        editor ? h('button', { class: 'btn', onclick: () => enterSearch() }, 'Ersten Stopp hinzufügen') : null));
      return;
    }
    d.stops.forEach((s, i) => {
      const row = h('div', {
        class: `stop ${s.visited_at ? 'visited' : ''} ${s.id === selectedId ? 'sel' : ''}`, 'data-id': s.id, role: 'button', tabindex: '0',
        onclick: (e) => { if (e.target.closest('.handle') || Date.now() - lastDrag < 350) return; selectStop(s.id, { open: true }); },
        onkeydown: (e) => { if (e.key === 'Enter') selectStop(s.id, { open: true }); },
      },
        h('span', { class: 'num' }, s.visited_at ? iconEl('check', 'sm') : String(i + 1)),
        h('div', { class: 'txt' }, h('b', null, s.name), h('span', null, subline(s))),
        editor && d.stops.length > 1 ? h('span', { class: 'handle', 'aria-label': 'Zum Umsortieren ziehen', title: 'Ziehen zum Umsortieren' }, iconEl('drag')) : null);
      listEl.append(row);
      if (i < d.stops.length - 1) {
        const leg = route?.legs[i];
        listEl.append(h('div', { class: 'leg' }, leg ? `${route.approx ? '~ ' : ''}${fmtKm(leg.distance)} · ${fmtDur(leg.duration)}` : (routeLoading ? 'Strecke wird berechnet …' : '—')));
      }
    });
    if (editor) listEl.append(h('button', { class: 'btn soft block add-row', onclick: () => enterSearch() }, iconEl('plus', 'sm'), 'Stopp hinzufügen'));
  }

  function syncMap() {
    const d = data();
    if (!d) return;
    map.setStops(d.stops, { selectedId });
  }

  function fitAll(animate = true) {
    const d = data();
    if (!d?.stops.length) return;
    map.fit(d.stops, { bottomPad: dock.height() + 10, topPad: 80, animate });
  }

  async function refreshRoute() {
    const d = data();
    if (!d || destroyed) return;
    const pts = d.stops.map((s) => ({ lat: s.lat, lon: s.lon }));
    const key = pts.map((p) => `${p.lat},${p.lon}`).join('|');
    if (key === routeKey) return;
    routeKey = key;
    routeAbort?.abort();
    if (pts.length < 2) { route = null; routeLoading = false; map.setRoute([]); renderList(); return; }
    routeLoading = true;
    renderList();
    routeAbort = new AbortController();
    try {
      const r = await computeRoute(pts, { signal: routeAbort.signal });
      if (key !== routeKey || destroyed) return;
      route = r; routeLoading = false;
      map.setRoute(r.line);
      renderList();
    } catch (e) {
      if (e.name === 'AbortError') return;
      routeLoading = false;
      renderList();
    }
  }
  const refreshRouteSoon = debounce(refreshRoute, 450);

  let raf = 0;
  function onData() {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => {
      if (destroyed || !data()) return;
      if (selectedId && !data().stops.some((s) => s.id === selectedId)) selectedId = null;
      updateTop(); syncMap(); renderList(); refreshRouteSoon();
      if (!didFit && data().stops.length) { didFit = true; fitAll(false); }
    });
  }
  const offData = on('trip:' + tripId, onData);

  // ---------- Auswahl ----------
  function selectStop(id, { open = false } = {}) {
    const s = data()?.stops.find((x) => x.id === id);
    if (!s) return;
    selectedId = id;
    syncMap(); renderList();
    map.flyTo(s.lat, s.lon, { zoom: Math.max(map.zoom(), 11), bottomPad: window.innerHeight * 0.5 });
    if (open) {
      openStopSheet({
        tripId, stopId: id,
        onMove: (stop) => startMove(stop),
        onDeleted: () => { selectedId = null; },
      });
    }
  }

  // ---------- Modi (Suche, Entwurf, Verschieben) ----------
  const searchUi = { bar: null, input: null, results: null, hint: null };
  const draftUi = { card: null, name: null, addr: null };

  function enterMode(m) {
    if (!modeLayer) {
      modeLayer = openLayer([], { onClose: () => { modeLayer = null; cleanupMode(); } });
    }
    mode = m;
    dock.el.style.display = 'none';
    fabs.style.display = 'none';
    top.style.display = m === 'search' ? 'none' : '';
  }

  function cleanupMode() {
    mode = 'browse';
    draft = null;
    map.setDraft(null);
    searchUi.bar?.remove(); searchUi.hint?.remove(); draftUi.card?.remove();
    searchUi.bar = searchUi.hint = draftUi.card = null;
    dock.el.style.display = '';
    fabs.style.display = '';
    top.style.display = '';
    syncMap();
  }

  function exitMode() { if (modeLayer) modeLayer.close(); else cleanupMode(); }

  function enterSearch() {
    if (!canEdit(tripId) || mode !== 'browse') return;
    enterMode('search');
    const input = h('input', { type: 'search', placeholder: 'Ort, Adresse oder Sehenswürdigkeit', enterkeyhint: 'search', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', 'aria-label': 'Ort suchen' });
    const results = h('div', { class: 'results hidden' });
    const bar = h('div', { class: 'searchbar' },
      h('div', { class: 'searchbox' }, iconBtn('back', { label: 'Suche beenden', cls: 'flat sm', onclick: () => exitMode() }), input),
      results);
    const hint = h('div', { class: 'hint-pill' }, 'Oder tippe direkt auf die Karte');
    Object.assign(searchUi, { bar, input, results, hint });
    el.append(bar, hint);
    setTimeout(() => input.focus(), 120);

    let ctl = null;
    const run = async (q) => {
      ctl?.abort();
      q = q.trim();
      if (q.length < 2) { results.classList.add('hidden'); hint.classList.remove('hidden'); return; }
      ctl = new AbortController();
      results.classList.remove('hidden');
      results.replaceChildren(h('div', { class: 'result-note pulse' }, 'Suche …'));
      try {
        const list = await searchPlaces(q, map.center(), ctl.signal);
        results.replaceChildren();
        if (!list.length) { results.append(h('div', { class: 'result-note' }, 'Nichts gefunden. Probiere einen anderen Namen oder tippe auf die Karte.')); return; }
        hint.classList.add('hidden');
        for (const r of list) {
          results.append(h('button', { class: 'result', onclick: () => {
            input.blur();
            enterMode('draft');
            setDraft({ lat: r.lat, lon: r.lon, title: r.title, subtitle: r.subtitle, touched: true });
            map.flyTo(r.lat, r.lon, { zoom: 13, bottomPad: 300 });
          } }, h('span', { class: 'ic' }, iconEl('pin', 'sm')), h('div', null, h('b', null, r.title), r.subtitle ? h('span', null, r.subtitle) : null)));
        }
      } catch (e) {
        if (e.name === 'AbortError') return;
        results.replaceChildren(h('div', { class: 'result-note' }, navigator.onLine ? 'Die Suche ist gerade nicht erreichbar. Tippe stattdessen auf die Karte.' : 'Ohne Internet geht die Suche nicht. Tippe auf die Karte, um einen Pin zu setzen.'));
      }
    };
    const runSoon = debounce(run, 420);
    input.addEventListener('input', () => runSoon(input.value));
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { runSoon.cancel(); run(input.value); input.blur(); } });
  }

  function placeDraft(lat, lon) {
    if (mode === 'search') { searchUi.bar?.remove(); searchUi.hint?.remove(); searchUi.bar = searchUi.hint = null; enterMode('draft'); }
    setDraft({ lat, lon, title: '', subtitle: '', touched: false });
    lookupName();
  }

  async function lookupName() {
    if (!draft) return;
    const mine = draft;
    draftUi.addr && (draftUi.addr.textContent = 'Ortsname wird gesucht …');
    const r = await reverseGeocode(mine.lat, mine.lon, map.zoom());
    if (draft !== mine) return;
    if (r) {
      mine.subtitle = r.subtitle;
      if (!mine.touched && draftUi.name) { mine.title = r.title; draftUi.name.value = r.title; }
    }
    if (draftUi.addr) draftUi.addr.textContent = mine.subtitle || 'Du kannst den Namen selbst eintragen.';
  }

  function setDraft(d) {
    draft = { ...draft, ...d, stopId: d.stopId || null };
    map.setDraft([draft.lat, draft.lon]);
    drawDraftCard();
  }

  function drawDraftCard() {
    draftUi.card?.remove();
    const moving = mode === 'move';
    const name = moving ? null : h('input', { class: 'input title', placeholder: 'Name des Stopps', maxlength: '120', value: draft.title || '', enterkeyhint: 'done', 'aria-label': 'Name des Stopps', style: { fontSize: '19px' } });
    const addr = h('div', { class: 'addr' }, moving ? 'Ziehe den Pin an die richtige Stelle oder tippe auf die Karte.' : (draft.subtitle || ''));
    const save = h('button', { class: 'btn', onclick: () => commitDraft() }, moving ? 'Position speichern' : 'Hinzufügen');
    const card = h('div', { class: 'draft-card' },
      name, addr,
      h('div', { class: 'btns' }, h('button', { class: 'btn ghost', onclick: () => exitMode() }, 'Abbrechen'), save));
    if (name) {
      name.addEventListener('input', () => { draft.title = name.value; draft.touched = true; });
      name.addEventListener('keydown', (e) => { if (e.key === 'Enter') commitDraft(); });
    }
    Object.assign(draftUi, { card, name, addr });
    el.append(card);
  }

  function commitDraft() {
    if (!draft) return;
    const { lat, lon } = draft;
    if (mode === 'move') {
      net.mutate('stop.update', { tripId, stopId: draft.stopId, patch: { lat, lon } });
      const id = draft.stopId;
      exitMode();
      setTimeout(() => selectStop(id), 80);
      return;
    }
    const name = (draft.title || '').trim() || draft.subtitle.split(',')[0] || 'Neuer Stopp';
    const id = newId();
    net.mutate('stop.create', { tripId, stop: { id, name: name.slice(0, 120), lat, lon } });
    exitMode();
    selectedId = id;
    setTimeout(() => {
      syncMap(); renderList();
      if ((data()?.stops.length || 0) >= 2) fitAll(); else map.flyTo(lat, lon, { zoom: 10, bottomPad: dock.height() + 20 });
    }, 60);
    toast('Stopp hinzugefügt');
  }

  function startMove(stop) {
    if (!stop || mode !== 'browse') return;
    enterMode('move');
    setDraft({ lat: stop.lat, lon: stop.lon, title: stop.name, subtitle: '', stopId: stop.id, touched: true });
    map.flyTo(stop.lat, stop.lon, { zoom: Math.max(map.zoom(), 12), bottomPad: 240 });
  }

  // ---------- Start ----------
  updateTop();
  syncMap();
  renderList();
  refreshRoute();
  dock.set(data()?.stops.length > 6 ? 'peek' : 'half', false);
  if (data()?.stops.length) { didFit = true; setTimeout(() => fitAll(false), 50); }

  return {
    el,
    show() { map.invalidate(); dock.set(dock.state, false); if (!didFit && data()?.stops.length) { didFit = true; fitAll(false); } },
    hide() {},
    focusStop(id) { selectStop(id, { open: false }); },
    map,
    destroy() {
      destroyed = true;
      offData(); ro.disconnect(); stopReorder(); routeAbort?.abort(); dock.destroy();
      if (modeLayer) modeLayer.close();
      map.destroy();
    },
  };
}
void esc;
