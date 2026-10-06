// Gemeinsame Bausteine für Fotos und Videos: Vorschaubilder, Raster, „Hinzufügen“-Menü
import { h, sheet, toast, iconEl } from '../ui.js';
import { state, on, canEdit } from '../state.js';
import { pickFiles } from '../img.js';
import { addFiles, retryUpload, discardUpload } from '../media.js';

export function localDay(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function fmtDuration(sec) {
  if (!Number.isFinite(sec)) return '';
  const s = Math.round(sec);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

// Ein quadratisches Vorschaubild. Wartende Uploads zeigen Fortschritt oder Fehler.
export function thumbEl(m, { onOpen, tripId, ratio } = {}) {
  const btn = h('button', { class: `thumb ${m.kind} ${m.pending ? 'pending' : ''}`, 'aria-label': m.kind === 'video' ? 'Video öffnen' : 'Foto öffnen', onclick: () => onOpen?.(m) });
  if (ratio) btn.style.aspectRatio = ratio;
  const src = m.thumb || (m.kind === 'image' ? m.url : null);
  if (src) btn.append(h('img', { src, alt: m.caption || '', loading: 'lazy', decoding: 'async', draggable: 'false' }));
  else btn.append(h('span', { class: 'ph' }, iconEl(m.kind === 'video' ? 'video' : 'image')));
  if (m.kind === 'video') btn.append(h('span', { class: 'badge' }, iconEl('play', 'sm'), m.duration ? fmtDuration(m.duration) : ''));
  if (m.pending) {
    const over = h('span', { class: 'up' });
    const paint = (u) => {
      const failed = u?.status === 'failed';
      over.className = 'up' + (failed ? ' failed' : '');
      over.replaceChildren(failed
        ? h('b', null, '!')
        : h('i', { class: u?.status === 'uploading' ? 'spin' : 'wait' }),
      h('small', null, failed ? 'Fehler' : u?.status === 'uploading' ? `${Math.round((u.progress || 0) * 100)} %` : 'wartet'));
      over.dataset.status = u?.status || '';
    };
    const cur = (state.uploads[tripId || m.trip_id] || []).find((x) => x.id === m.id);
    paint(cur || m);
    btn.append(over);
    btn._off = on('uprog:' + m.id, (u) => {
      if (!btn.isConnected && btn._seen) { btn._off(); return; }
      btn._seen = btn.isConnected;
      paint(u);
    });
  }
  return btn;
}

export function mediaGrid(items, { onOpen, tripId, cls = '' } = {}) {
  const grid = h('div', { class: `media-grid ${cls}` });
  for (const m of items) grid.append(thumbEl(m, { onOpen, tripId }));
  return grid;
}

// Menü: Foto aufnehmen, Video aufnehmen oder aus der Galerie wählen
export function openAddMedia({ tripId, stopId, stopName }) {
  if (!canEdit(tripId)) return null;
  if (!state.config.media) { toast('Der Foto-Speicher ist noch nicht eingerichtet. Siehe README, Schritt „Backblaze B2“.', { error: true, ms: 6000 }); return null; }
  const run = async (accept, opts) => {
    await layer.close();
    const files = await pickFiles(accept, opts);
    if (!files.length) return;
    await addFiles(tripId, stopId, files);
  };
  const row = (icon, title, sub, fn) => h('button', { class: 'list-btn', onclick: fn },
    h('span', { class: 'ic' }, iconEl(icon)), h('span', { style: { flex: 1 } }, title, sub ? h('small', null, sub) : null));
  const body = h('div', null,
    stopName ? h('p', { class: 'hint', style: { margin: '0 4px 8px' } }, `Wird zu „${stopName}“ gespeichert.`) : h('p', { class: 'hint', style: { margin: '0 4px 8px' } }, 'Wird der Reise ohne bestimmten Stopp hinzugefügt.'),
    row('camera', 'Foto aufnehmen', 'Öffnet die Kamera', () => run('image/*', { capture: 'environment' })),
    row('video', 'Video aufnehmen', `Bis ${Math.round(state.config.maxVideoBytes / 1048576)} MB`, () => run('video/*', { capture: 'environment' })),
    row('image', 'Aus Galerie wählen', 'Fotos und Videos, auch mehrere', () => run('image/*,video/*', { multiple: true })));
  const layer = sheet({ title: 'Foto oder Video hinzufügen', body });
  return layer;
}

// Hinweis für fehlgeschlagene Uploads: erneut versuchen oder verwerfen
export function openFailedUpload(tripId, m) {
  const body = h('div', null,
    h('p', null, m.error || 'Das Hochladen hat nicht geklappt.'),
    h('button', { class: 'btn block', onclick: async () => { await layer.close(); retryUpload(tripId, m.id); } }, 'Erneut versuchen'),
    h('button', { class: 'btn danger block', style: { marginTop: '10px' }, onclick: async () => { await layer.close(); discardUpload(tripId, m.id); } }, 'Verwerfen'));
  const layer = sheet({ title: 'Upload fehlgeschlagen', body });
  return layer;
}
