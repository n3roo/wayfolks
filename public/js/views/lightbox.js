// Vollbild-Ansicht für Fotos und Videos: seitlich wischen, Bildunterschrift, löschen, speichern
import { h, openLayer, sheet, confirmDialog, toast, iconEl, iconBtn, fmtDay } from '../ui.js';
import { state, on, canEdit, myRole } from '../state.js';
import { net } from '../net.js';
import { discardUpload } from '../media.js';
import { openFailedUpload, localDay } from './mediaUi.js';

export function openLightbox({ tripId, items, index = 0, getItems }) {
  let list = items.slice();
  let cur = Math.max(0, Math.min(index, list.length - 1));
  const track = h('div', { class: 'lb-track' });
  const counter = h('span', { class: 'lb-count' });
  const capEl = h('p', { class: 'lb-cap' });
  const metaEl = h('p', { class: 'lb-meta' });
  const actions = h('div', { class: 'lb-actions' });
  const layerRoot = h('div', { class: 'lightbox', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Foto- und Videoansicht' });
  let layer = null;
  let off = () => {};

  const stopName = (m) => state.tripData[tripId]?.stops.find((s) => s.id === m.stop_id)?.name || '';
  const who = (m) => state.tripData[tripId]?.members.find((x) => x.id === m.created_by)?.name || '';
  const canDelete = (m) => m.pending || myRole(tripId) === 'owner' || (canEdit(tripId) && m.created_by === state.user.id);

  function slide(m) {
    const s = h('div', { class: 'lb-slide', 'data-id': m.id });
    s._m = m;
    return s;
  }
  function fill(s) {
    if (s._filled) return;
    s._filled = true;
    const m = s._m;
    if (m.kind === 'video' && m.url && !m.pending) {
      s.append(h('video', { controls: '', playsinline: '', preload: 'metadata', poster: m.thumb || null, src: m.url }));
    } else if (m.kind === 'video') {
      s.append(h('div', { class: 'lb-wait' }, iconEl('video'), h('span', null, 'Video wird hochgeladen …')));
    } else {
      const src = m.url || m.thumb;
      if (src) s.append(h('img', { src, alt: m.caption || '', draggable: 'false' }));
    }
  }
  function unfill(s) {
    if (!s._filled) return;
    s.querySelector('video')?.pause();
  }

  function build() {
    track.replaceChildren(...list.map(slide));
    const slides = [...track.children];
    for (const i of [cur - 1, cur, cur + 1]) if (slides[i]) fill(slides[i]);
    requestAnimationFrame(() => { track.scrollLeft = cur * track.clientWidth; });
  }

  function paint() {
    const m = list[cur];
    if (!m) return;
    counter.textContent = `${cur + 1} / ${list.length}`;
    capEl.textContent = m.caption || '';
    capEl.style.display = m.caption ? '' : 'none';
    const bits = [];
    const sn = stopName(m);
    if (sn) bits.push(sn);
    if (m.taken_at) bits.push(fmtDay(localDay(m.taken_at)));
    const w = who(m);
    if (w && state.tripData[tripId]?.members.length > 1) bits.push(w);
    metaEl.textContent = bits.join(' · ');
    actions.replaceChildren(
      m.pending ? null : h('a', { class: 'icon-btn flat light', href: m.url, download: '', target: '_blank', rel: 'noopener', 'aria-label': 'Original speichern' }, iconEl('download')),
      canEdit(tripId) && !m.pending ? iconBtn('pencil', { label: 'Bildunterschrift bearbeiten', cls: 'flat light', onclick: () => editCaption(m) }) : null,
      canDelete(m) ? iconBtn('trash', { label: m.pending ? 'Upload verwerfen' : 'Löschen', cls: 'flat light', onclick: () => remove(m) }) : null);
    if (m.pending && m.status === 'failed') { /* Hinweis über den Löschen-Knopf und das Vorschaubild im Raster */ }
  }

  function editCaption(m) {
    const ta = h('textarea', { class: 'textarea', maxlength: '500', placeholder: 'Was war hier los?' });
    ta.value = m.caption || '';
    const body = h('div', null, h('label', { class: 'field' }, h('span', null, 'Bildunterschrift'), ta),
      h('button', { class: 'btn block', onclick: async () => {
        const caption = ta.value.trim();
        await l2.close();
        if (caption !== (m.caption || '')) { net.mutate('media.update', { tripId, mediaId: m.id, patch: { caption } }); m.caption = caption; paint(); }
      } }, 'Speichern'));
    const l2 = sheet({ title: 'Bildunterschrift', body });
    setTimeout(() => ta.focus(), 250);
  }

  async function remove(m) {
    const ok = await confirmDialog({ title: m.kind === 'video' ? 'Video löschen?' : 'Foto löschen?', text: m.pending ? 'Der Upload wird abgebrochen.' : 'Es wird für alle aus der Reise entfernt.', confirmLabel: 'Löschen', danger: true });
    if (!ok) return;
    if (m.pending) await discardUpload(tripId, m.id);
    else net.mutate('media.delete', { tripId, mediaId: m.id });
    list = list.filter((x) => x.id !== m.id);
    if (!list.length) { layer.close(); return; }
    cur = Math.min(cur, list.length - 1);
    build(); paint();
    toast('Gelöscht');
  }

  let ticking = false;
  track.addEventListener('scroll', () => {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(() => {
      ticking = false;
      const i = Math.round(track.scrollLeft / Math.max(1, track.clientWidth));
      if (i === cur || i < 0 || i >= list.length) return;
      track.children[cur] && unfill(track.children[cur]);
      cur = i;
      for (const j of [cur - 1, cur, cur + 1]) if (track.children[j]) fill(track.children[j]);
      paint();
    });
  }, { passive: true });

  const top = h('div', { class: 'lb-top' }, iconBtn('close', { label: 'Schließen', cls: 'flat light', onclick: () => layer.close() }), counter, actions);
  const bottom = h('div', { class: 'lb-bottom' }, capEl, metaEl);
  layerRoot.append(track, top, bottom);
  layer = openLayer([layerRoot], { onClose: () => { off(); track.querySelectorAll('video').forEach((v) => v.pause()); } });

  // Änderungen von anderen live übernehmen (Titel, Löschen, fertige Uploads)
  off = on('trip:' + tripId, () => {
    if (!getItems) return;
    const id = list[cur]?.id;
    const next = getItems();
    const sameIds = next.length === list.length && next.every((m, i) => m.id === list[i].id);
    if (sameIds) { list = next; paint(); return; }
    list = next;
    if (!list.length) { layer.close(); return; }
    const i = list.findIndex((m) => m.id === id);
    cur = i >= 0 ? i : Math.min(cur, list.length - 1);
    build(); paint();
  });

  build(); paint();
  return layer;
}

// Öffnet ein Element: wartende/fehlgeschlagene Uploads zeigen ihren Status, alles andere die Vollbild-Ansicht
export function openItem({ tripId, m, getItems }) {
  if (m.pending && m.status === 'failed') return openFailedUpload(tripId, m);
  const items = getItems();
  const i = items.findIndex((x) => x.id === m.id);
  return openLightbox({ tripId, items, index: Math.max(0, i), getItems });
}
