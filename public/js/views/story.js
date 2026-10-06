// Rückblick: die Reise als Zeitleiste oder Galerie mit Fotos, Videos und Notizen
import { h, iconEl, iconBtn, toast, fmtDay, fmtRange } from '../ui.js';
import { state, on, canEdit, myRole, mediaOf } from '../state.js';
import { net } from '../net.js';
import { shareLink, inviteUrl, tripCoverUrl } from '../util.js';
import { mediaGrid, localDay } from './mediaUi.js';
import { openItem } from './lightbox.js';

let mode = 'timeline';

export function createStory({ tripId, goLive }) {
  const data = () => state.tripData[tripId];
  const el = h('div', { class: 'tab-page story' });
  let shown = false;

  const getAll = () => mediaOf(tripId);
  const open = (m) => openItem({ tripId, m, getItems: getAll });

  async function share() {
    try {
      const { invites } = await net.request('invite.ensure', { tripId, role: 'viewer' });
      const token = invites.find((i) => i.role === 'viewer')?.token;
      if (!token) throw new Error('Kein Link');
      await shareLink({ url: inviteUrl(token), title: data().trip.title, text: `Schau dir unseren Roadtrip „${data().trip.title}“ an.` });
    } catch (e) {
      toast(e.code === 'offline' ? 'Zum Teilen brauchst du Internet.' : 'Der Link konnte nicht erstellt werden.', { error: true });
    }
  }

  function hero(d, all) {
    const cover = tripCoverUrl(d.trip);
    const videos = all.filter((m) => m.kind === 'video').length;
    const photos = all.length - videos;
    const visited = d.stops.filter((s) => s.visited_at).length;
    const chips = [
      h('span', { class: 'chip' }, iconEl('pin', 'sm'), `${visited} von ${d.stops.length} Stopps`),
      photos ? h('span', { class: 'chip' }, iconEl('camera', 'sm'), `${photos} Foto${photos === 1 ? '' : 's'}`) : null,
      videos ? h('span', { class: 'chip' }, iconEl('video', 'sm'), `${videos} Video${videos === 1 ? '' : 's'}`) : null,
    ];
    return h('header', { class: `story-hero ${cover ? 'has-cover' : ''}`, style: cover ? { backgroundImage: `linear-gradient(180deg, rgba(10,16,30,.15), rgba(10,16,30,.78)), url("${cover}")` } : null },
      myRole(tripId) === 'owner' ? h('button', { class: 'icon-btn share', 'aria-label': 'Rückblick teilen', onclick: share }, iconEl('share')) : null,
      h('div', { class: 'in' }, h('h1', null, d.trip.title), h('p', null, fmtRange(d.trip.start_date, d.trip.end_date)), h('div', { class: 'chips' }, chips)));
  }

  function timeline(d, all) {
    const wrap = h('div', { class: 'timeline' });
    const byStop = new Map();
    const loose = [];
    for (const m of all) {
      if (m.stop_id && d.stops.some((s) => s.id === m.stop_id)) { if (!byStop.has(m.stop_id)) byStop.set(m.stop_id, []); byStop.get(m.stop_id).push(m); } else loose.push(m);
    }
    const later = [];
    d.stops.forEach((s, i) => {
      const items = byStop.get(s.id) || [];
      const hasText = (s.description || s.notes || '').trim();
      if (!s.visited_at && !items.length && !hasText) { later.push({ s, i }); return; }
      const when = [s.visited_at ? fmtDay(localDay(s.visited_at)) : (s.planned_date ? fmtDay(s.planned_date) : null), s.visited_at ? 'besucht' : 'geplant'].filter(Boolean).join(' · ');
      wrap.append(h('section', { class: `tl-item ${s.visited_at ? 'visited' : ''}` },
        h('span', { class: 'tl-dot' }, s.visited_at ? iconEl('check', 'sm') : String(i + 1)),
        h('div', { class: 'tl-card' },
          h('h3', null, s.name), h('span', { class: 'when' }, when),
          s.description?.trim() ? h('p', { class: 'tl-text' }, s.description.trim()) : null,
          s.notes?.trim() ? h('p', { class: 'tl-notes' }, s.notes.trim()) : null,
          items.length ? mediaGrid(items, { tripId, onOpen: open }) : null)));
    });
    if (loose.length) {
      wrap.append(h('section', { class: 'tl-item' },
        h('span', { class: 'tl-dot alt' }, iconEl('image', 'sm')),
        h('div', { class: 'tl-card' }, h('h3', null, 'Zwischendurch'), h('span', { class: 'when' }, 'Ohne bestimmten Stopp'), mediaGrid(loose, { tripId, onOpen: open }))));
    }
    if (later.length) {
      wrap.append(h('section', { class: 'tl-item later' },
        h('span', { class: 'tl-dot alt' }, iconEl('flag', 'sm')),
        h('div', { class: 'tl-card' }, h('h3', null, 'Noch geplant'), h('p', { class: 'tl-text' }, later.map(({ s }) => s.name).join(' · ')))));
    }
    return wrap;
  }

  function gallery(all) {
    const days = new Map();
    for (const m of all) {
      const k = localDay(m.taken_at || m.created_at);
      if (!days.has(k)) days.set(k, []);
      days.get(k).push(m);
    }
    const wrap = h('div', { class: 'gallery' });
    for (const [k, items] of days) {
      wrap.append(h('h3', { class: 'day' }, k ? fmtDay(k, { weekday: true }) : 'Ohne Datum'), mediaGrid(items, { tripId, onOpen: open, cls: 'bleed' }));
    }
    return wrap;
  }

  function draw() {
    const d = data();
    if (!d) return;
    const sc = el.scrollTop;
    const all = getAll();
    const parts = [hero(d, all)];
    if (!all.length && !d.stops.some((s) => s.visited_at)) {
      parts.push(h('div', { class: 'empty', style: { margin: '20px 16px' } },
        h('h2', { class: 'display' }, 'Hier entsteht euer Reisetagebuch'),
        h('p', null, canEdit(tripId) ? 'Sobald ihr unterwegs seid, sammeln sich hier Fotos, Videos und Notizen zu jedem Stopp.' : 'Sobald die Mitreisenden Fotos und Videos hinzufügen, erscheinen sie hier.'),
        canEdit(tripId) ? h('button', { class: 'btn', onclick: goLive }, iconEl('compass', 'sm'), 'Zum Unterwegs-Modus') : null));
    } else {
      parts.push(h('div', { class: 'story-seg' }, h('div', { class: 'seg' },
        h('button', { class: mode === 'timeline' ? 'on' : '', onclick: () => { mode = 'timeline'; draw(); } }, 'Zeitleiste'),
        h('button', { class: mode === 'gallery' ? 'on' : '', onclick: () => { mode = 'gallery'; draw(); } }, `Galerie${all.length ? ` (${all.length})` : ''}`))));
      parts.push(mode === 'gallery' ? (all.length ? gallery(all) : h('p', { class: 'hint center', style: { margin: '30px 20px' } }, 'Noch keine Fotos oder Videos.')) : timeline(d, all));
    }
    parts.push(h('div', { style: { height: '28px' } }));
    el.replaceChildren(...parts);
    el.scrollTop = sc;
  }

  draw();
  const redraw = () => { if (shown) draw(); else dirty = true; };
  let dirty = false;
  const off = on('trip:' + tripId, redraw);
  return {
    el,
    show() { shown = true; if (dirty) { dirty = false; } draw(); },
    hide() { shown = false; },
    destroy() { off(); },
  };
}
