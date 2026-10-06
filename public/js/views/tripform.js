// Reise anlegen oder bearbeiten (Name, Titelbild, Zeitraum)
import { h, sheet, toast, iconEl } from '../ui.js';
import { net } from '../net.js';
import { newId, tripCoverUrl } from '../util.js';
import { pickFile, resizeImage } from '../img.js';
import { LIMITS } from '../config.js';

export function openTripForm({ trip = null, onSaved } = {}) {
  const editing = !!trip;
  let cover = null;           // { dataUrl, blob } neu gewählt
  let removeCover = false;
  const hadCover = !!trip?.has_cover;

  const title = h('input', { class: 'input title', placeholder: 'z. B. Sommer an der Adria', maxlength: '80', value: trip?.title || '', enterkeyhint: 'next', 'aria-label': 'Name der Reise' });
  const start = h('input', { class: 'input', type: 'date', value: trip?.start_date || '', 'aria-label': 'Von' });
  const end = h('input', { class: 'input', type: 'date', value: trip?.end_date || '', 'aria-label': 'Bis' });
  start.addEventListener('change', () => { if (start.value && (!end.value || end.value < start.value)) end.value = start.value; });
  end.addEventListener('change', () => { if (end.value && start.value && end.value < start.value) start.value = end.value; });

  const pick = h('button', { class: 'cover-pick', type: 'button' });
  function drawCover() {
    pick.replaceChildren();
    const url = cover ? cover.dataUrl : (!removeCover && hadCover ? tripCoverUrl(trip) : null);
    pick.classList.toggle('has', !!url);
    pick.style.backgroundImage = url ? `url(${url})` : '';
    pick.append(iconEl('image', 'lg'), h('span', null, url ? 'Titelbild ändern' : 'Titelbild hinzufügen'));
  }
  pick.addEventListener('click', async () => {
    const file = await pickFile('image/*');
    if (!file) return;
    try {
      const r = await resizeImage(file, { maxSide: 1280, quality: 0.8, maxBytes: LIMITS.coverBytes });
      cover = r; removeCover = false;
      drawCover();
    } catch { toast('Dieses Bild konnte nicht geladen werden.', { error: true }); }
  });
  drawCover();

  const removeBtn = editing && hadCover ? h('button', { class: 'link-btn', type: 'button', onclick: () => { cover = null; removeCover = true; drawCover(); removeBtn.remove(); } }, 'Titelbild entfernen') : null;

  const save = h('button', { class: 'btn block', onclick: submit }, editing ? 'Speichern' : 'Reise anlegen');
  async function submit() {
    const t = title.value.trim();
    if (!t) { title.focus(); toast('Gib deiner Reise einen Namen.'); return; }
    if (start.value && end.value && end.value < start.value) { toast('Das Ende liegt vor dem Start.', { error: true }); return; }
    save.disabled = true;
    let tripId = trip?.id;
    if (!editing) {
      tripId = newId();
      net.mutate('trip.create', { id: tripId, title: t, start_date: start.value || null, end_date: end.value || null });
    } else {
      const patch = {};
      if (t !== trip.title) patch.title = t;
      if ((start.value || null) !== (trip.start_date || null)) patch.start_date = start.value || null;
      if ((end.value || null) !== (trip.end_date || null)) patch.end_date = end.value || null;
      if (removeCover) patch.remove_cover = true;
      if (Object.keys(patch).length) net.mutate('trip.update', { tripId, patch });
    }
    if (cover) {
      const base64 = cover.dataUrl.split(',')[1];
      net.mutate('trip.cover', { tripId, data: base64, type: 'image/jpeg', local: cover.dataUrl });
    }
    await layer.close();
    onSaved?.(tripId, !editing);
  }
  title.addEventListener('keydown', (e) => { if (e.key === 'Enter') start.focus(); });

  const body = h('div', null,
    pick, removeBtn,
    h('label', { class: 'field' }, h('span', null, 'Name der Reise'), title),
    h('div', { class: 'row' },
      h('label', { class: 'field' }, h('span', null, 'Von'), start),
      h('label', { class: 'field' }, h('span', null, 'Bis'), end)),
    h('p', { class: 'hint' }, 'Den Zeitraum kannst du auch später noch ändern.'),
    save);
  const layer = sheet({ title: editing ? 'Reise bearbeiten' : 'Neue Reise', body });
  if (!editing) setTimeout(() => title.focus(), 350);
  return layer;
}
