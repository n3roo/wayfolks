// Stopp-Details: bearbeiten, abhaken, verschieben, löschen
import { h, sheet, toast, confirmDialog, debounce, fmtDay, iconEl } from '../ui.js';
import { net } from '../net.js';
import { state, canEdit, on, mediaOf } from '../state.js';
import { mediaGrid, openAddMedia } from './mediaUi.js';
import { openItem } from './lightbox.js';

export function openStopSheet({ tripId, stopId, onMove, onDeleted }) {
  const find = () => state.tripData[tripId]?.stops.find((s) => s.id === stopId);
  const initial = find();
  if (!initial) return null;
  const editable = canEdit(tripId);
  const idx = () => state.tripData[tripId].stops.findIndex((s) => s.id === stopId);

  const name = h('input', { class: 'input title', value: initial.name, maxlength: '120', 'aria-label': 'Name des Stopps', disabled: !editable });
  const date = h('input', { class: 'input', type: 'date', value: initial.planned_date || '', 'aria-label': 'Geplantes Datum', disabled: !editable });
  const desc = h('textarea', { class: 'textarea', placeholder: 'Was habt ihr hier vor?', maxlength: '4000', disabled: !editable }); desc.value = initial.description;
  const notes = h('textarea', { class: 'textarea', placeholder: 'Öffnungszeiten, Reservierung, Parkplatz …', maxlength: '8000', disabled: !editable }); notes.value = initial.notes;

  const meta = h('div', { class: 'detail-meta' });
  const visitedRow = h('button', { class: 'check-row', disabled: !editable });
  function drawMeta() {
    const s = find();
    if (!s) return;
    meta.replaceChildren(...[
      h('span', { class: 'chip accent' }, `Stopp ${idx() + 1} von ${state.tripData[tripId].stops.length}`),
      s.planned_date ? h('span', { class: 'chip' }, fmtDay(s.planned_date, { weekday: true })) : null,
      s.visited_at ? h('span', { class: 'chip teal' }, 'Besucht') : null].filter(Boolean));
    visitedRow.classList.toggle('on', !!s.visited_at);
    visitedRow.replaceChildren(h('span', { class: 'box' }, iconEl('check', 'sm')), h('span', null, s.visited_at ? 'Besucht – Haken wieder entfernen' : 'Als besucht abhaken'));
  }
  const mediaBox = h('div', { class: 'stop-media' });
  const stopItems = () => mediaOf(tripId).filter((m) => m.stop_id === stopId);
  function drawMedia() {
    const items = stopItems();
    mediaBox.replaceChildren(
      h('div', { class: 'section-row' },
        h('span', { class: 'lbl' }, items.length ? `Fotos & Videos (${items.length})` : 'Fotos & Videos'),
        editable ? h('button', { class: 'btn soft small', onclick: () => openAddMedia({ tripId, stopId, stopName: find()?.name }) }, iconEl('camera', 'sm'), 'Hinzufügen') : null),
      items.length
        ? mediaGrid(items, { tripId, onOpen: (m) => openItem({ tripId, m, getItems: stopItems }) })
        : h('p', { class: 'hint', style: { margin: '0 4px 12px' } }, editable ? 'Noch nichts hier. Halte Erinnerungen direkt am Ort fest.' : 'Noch keine Fotos oder Videos.'));
  }

  visitedRow.addEventListener('click', () => {
    const s = find();
    if (!s) return;
    net.mutate('stop.visit', { tripId, stopId, visited: !s.visited_at });
    drawMeta();
  });

  // Änderungen gesammelt und verzögert speichern
  const save = debounce(() => {
    const s = find();
    if (!s || !editable) return;
    const patch = {};
    const n = name.value.trim();
    if (n && n !== s.name) patch.name = n;
    if ((date.value || null) !== (s.planned_date || null)) patch.planned_date = date.value || null;
    if (desc.value !== s.description) patch.description = desc.value;
    if (notes.value !== s.notes) patch.notes = notes.value;
    if (Object.keys(patch).length) { net.mutate('stop.update', { tripId, stopId, patch }); drawMeta(); }
  }, 700);
  for (const el of [name, date, desc, notes]) el.addEventListener('input', save);
  date.addEventListener('change', save.flush);

  const pos = h('div', { class: 'list-btn', style: { padding: '12px 4px' } },
    h('span', { class: 'ic' }, iconEl('pin')),
    h('span', { style: { flex: 1 } }, 'Position', h('small', null, `${initial.lat.toFixed(4)}, ${initial.lon.toFixed(4)}`)),
    editable && onMove ? h('button', { class: 'btn soft small', onclick: async () => { await layer.close(); onMove(find()); } }, 'Verschieben') : null);

  const body = h('div', null,
    h('label', { class: 'field' }, h('span', null, 'Name'), name),
    meta,
    h('label', { class: 'field' }, h('span', null, 'Geplantes Datum'), date),
    editable ? visitedRow : (find().visited_at ? h('p', { class: 'chip teal' }, 'Besucht') : null),
    mediaBox,
    h('label', { class: 'field' }, h('span', null, 'Beschreibung'), desc),
    h('label', { class: 'field' }, h('span', null, 'Notizen'), notes),
    pos,
    editable ? h('button', { class: 'btn danger block', style: { marginTop: '12px' }, onclick: async () => {
      const ok = await confirmDialog({ title: 'Stopp löschen?', text: `„${find()?.name}“ wird für alle aus der Reise entfernt.`, confirmLabel: 'Löschen', danger: true });
      if (!ok) return;
      save.cancel();
      net.mutate('stop.delete', { tripId, stopId });
      await layer.close();
      onDeleted?.();
      toast('Stopp gelöscht');
    } }, 'Stopp löschen') : null,
    !editable ? h('p', { class: 'hint center' }, 'Du kannst diese Reise nur ansehen.') : null);

  const off = on('trip:' + tripId, () => {
    const s = find();
    if (!s) { layer.close(); return; }
    // Fremde Änderungen übernehmen, solange man das Feld nicht gerade selbst bearbeitet
    const active = document.activeElement;
    if (active !== name && s.name !== name.value && !save.pending) name.value = s.name;
    if (active !== desc && s.description !== desc.value) desc.value = s.description;
    if (active !== notes && s.notes !== notes.value) notes.value = s.notes;
    if (active !== date && (s.planned_date || '') !== date.value) date.value = s.planned_date || '';
    drawMeta();
    drawMedia();
  });

  const layer = sheet({
    title: editable ? null : initial.name, body, tall: false,
    onClose: () => { save.flush(); off(); },
  });
  drawMeta();
  drawMedia();
  return layer;
}
