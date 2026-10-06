// Gruppe: Mitreisende, Einladungslinks, Reise-Einstellungen
import { h, clear, toast, sheet, confirmDialog, iconEl, iconBtn, avatar, fmtRange, copyText } from '../ui.js';
import { state, on } from '../state.js';
import { net } from '../net.js';
import { ROLE_LABEL } from '../config.js';
import { inviteUrl, shareLink, tripCoverUrl, hashHue } from '../util.js';
import { openTripForm } from './tripform.js';

export function createTeam({ tripId, navigate }) {
  const data = () => state.tripData[tripId];
  const el = h('div', { class: 'tab-page' });

  function openInvite() {
    let role = 'editor';
    const linkBox = h('div', { class: 'linkbox' }, 'Link wird erstellt …');
    const note = h('p', { class: 'hint', style: { margin: '0 4px 16px' } });
    let token = null;
    const seg = h('div', { class: 'seg' });

    async function load() {
      token = null;
      linkBox.textContent = 'Link wird erstellt …';
      shareBtn.disabled = copyBtn.disabled = true;
      try {
        const { invites } = await net.request('invite.ensure', { tripId, role });
        data().invites = invites;
        token = invites.find((i) => i.role === role)?.token;
        linkBox.textContent = inviteUrl(token);
        shareBtn.disabled = copyBtn.disabled = false;
      } catch (e) {
        linkBox.textContent = e.code === 'offline' ? 'Für den Einladungslink brauchst du Internet.' : (e.message || 'Der Link konnte nicht erstellt werden.');
      }
    }
    function drawSeg() {
      seg.replaceChildren(
        h('button', { class: role === 'editor' ? 'on' : '', onclick: () => { role = 'editor'; drawSeg(); load(); } }, 'Mitbearbeiten'),
        h('button', { class: role === 'viewer' ? 'on' : '', onclick: () => { role = 'viewer'; drawSeg(); load(); } }, 'Nur ansehen'));
      note.textContent = role === 'editor'
        ? 'Mitreisende dürfen Stopps ändern, abhaken und Fotos und Videos hinzufügen.'
        : 'Zum Mitverfolgen: Sie sehen Route, Stopps und Fotos, ändern aber nichts.';
    }
    const text = () => `Komm mit auf unseren Roadtrip „${data().trip.title}“!`;
    const shareBtn = h('button', { class: 'btn block', onclick: () => token && shareLink({ url: inviteUrl(token), title: data().trip.title, text: text() }) }, iconEl('share', 'sm'), 'Link teilen');
    const copyBtn = h('button', { class: 'btn soft block', style: { marginTop: '10px' }, onclick: async () => token && toast((await copyText(inviteUrl(token))) ? 'Link kopiert' : 'Kopieren nicht möglich') }, iconEl('copy', 'sm'), 'Link kopieren');
    const reset = h('button', { class: 'link-btn', onclick: async () => {
      const ok = await confirmDialog({ title: 'Neuen Link erzeugen?', text: 'Der bisherige Link funktioniert dann nicht mehr. Wer schon dabei ist, bleibt dabei.', confirmLabel: 'Neuer Link' });
      if (!ok) return;
      try {
        const { invites } = await net.request('invite.ensure', { tripId, role, reset: true });
        data().invites = invites;
        token = invites.find((i) => i.role === role)?.token;
        linkBox.textContent = inviteUrl(token);
        toast('Neuer Link erstellt');
      } catch (e) { toast(e.message, { error: true }); }
    } }, 'Link erneuern');
    drawSeg();
    sheet({ title: 'Freunde einladen', body: h('div', null, seg, note, linkBox, shareBtn, copyBtn, reset) });
    load();
  }

  function openMember(m) {
    let layer;
    const seg = h('div', { class: 'seg' });
    const draw = () => {
      seg.replaceChildren(...['editor', 'viewer'].map((r) => h('button', { class: m.role === r ? 'on' : '', onclick: async () => {
        if (m.role === r) return;
        try {
          const res = await net.request('member.role', { tripId, userId: m.id, role: r });
          m.role = r;
          const { applyEvent } = await import('../state.js');
          applyEvent(tripId, 'members', { members: res.members });
          draw();
        } catch (e) { toast(e.code === 'offline' ? 'Dafür brauchst du Internet.' : e.message, { error: true }); }
      } }, ROLE_LABEL[r])));
    };
    draw();
    layer = sheet({
      title: m.name,
      body: h('div', null,
        h('div', { style: { display: 'flex', justifyContent: 'center', margin: '0 0 16px' } }, avatar(m, 'xl')),
        h('div', { class: 'field' }, h('span', null, 'Rolle'), seg),
        h('button', { class: 'btn danger block', onclick: async () => {
          const ok = await confirmDialog({ title: `${m.name} entfernen?`, text: 'Die Person verliert den Zugriff auf diese Reise.', confirmLabel: 'Entfernen', danger: true });
          if (!ok) return;
          try {
            const res = await net.request('member.remove', { tripId, userId: m.id });
            const { applyEvent } = await import('../state.js');
            applyEvent(tripId, 'members', { members: res.members });
            layer.close();
            toast(`${m.name} wurde entfernt`);
          } catch (e) { toast(e.code === 'offline' ? 'Dafür brauchst du Internet.' : e.message, { error: true }); }
        } }, 'Aus der Reise entfernen')),
    });
  }

  function draw() {
    const d = data();
    if (!d) return;
    const owner = d.role === 'owner';
    const cover = tripCoverUrl(d.trip);
    const hero = h('div', { class: 'page-hero' },
      h('div', { class: 'back' }, iconBtn('back', { label: 'Zurück zu meinen Reisen', onclick: () => navigate('/') })),
      owner ? h('div', { class: 'edit' }, iconBtn('edit', { label: 'Reise bearbeiten', onclick: () => openTripForm({ trip: d.trip }) })) : null,
      h('h1', null, d.trip.title),
      h('p', null, `${fmtRange(d.trip.start_date, d.trip.end_date)} · ${d.stops.length} ${d.stops.length === 1 ? 'Stopp' : 'Stopps'}`));
    if (cover) hero.style.backgroundImage = `url("${cover}")`;
    else hero.style.background = `linear-gradient(135deg, hsl(${hashHue(tripId)} 55% 38%), hsl(${(hashHue(tripId) + 40) % 360} 60% 22%))`;
    const sc = el.scrollTop;
    clear(el);

    const people = h('div', { class: 'group' }, h('h3', null, `Mitreisende (${d.members.length})`),
      d.members.map((m) => {
        const self = m.id === state.user.id;
        const row = h(owner && !self && m.role !== 'owner' ? 'button' : 'div', { class: 'person', onclick: owner && !self && m.role !== 'owner' ? () => openMember(m) : null },
          avatar(m, 'lg', d.online.includes(m.id)),
          h('div', { class: 'info' }, h('b', null, m.name + (self ? ' (Du)' : '')), h('span', null, ROLE_LABEL[m.role] + (d.online.includes(m.id) ? ' · gerade online' : ''))),
          owner && !self && m.role !== 'owner' ? iconEl('chevron', 'sm') : null);
        return row;
      }));

    const invite = h('div', { class: 'group' }, h('h3', null, 'Einladen'),
      owner
        ? h('button', { class: 'list-btn', onclick: openInvite }, h('span', { class: 'ic' }, iconEl('link')), h('span', { style: { flex: 1 } }, 'Freunde per Link einladen', h('small', null, 'Mitbearbeiten oder nur ansehen')), iconEl('chevron', 'sm'))
        : h('p', { class: 'muted small', style: { padding: '4px 14px 14px', margin: 0 } }, 'Nur der Besitzer der Reise kann Einladungslinks erstellen.'));

    const actions = h('div', { class: 'group' }, h('h3', null, 'Reise'),
      owner ? h('button', { class: 'list-btn', onclick: () => openTripForm({ trip: d.trip }) }, h('span', { class: 'ic' }, iconEl('edit')), h('span', { style: { flex: 1 } }, 'Name, Titelbild und Zeitraum')) : null,
      owner
        ? h('button', { class: 'list-btn danger', onclick: async () => {
          const ok = await confirmDialog({ title: 'Reise löschen?', text: `„${d.trip.title}“ wird für alle Mitreisenden gelöscht, inklusive aller Stopps. Das lässt sich nicht rückgängig machen.`, confirmLabel: 'Endgültig löschen', danger: true });
          if (!ok) return;
          net.mutate('trip.delete', { tripId });
          navigate('/', { replace: true });
          toast('Reise gelöscht');
        } }, h('span', { class: 'ic' }, iconEl('trash')), h('span', null, 'Reise löschen'))
        : h('button', { class: 'list-btn danger', onclick: async () => {
          const ok = await confirmDialog({ title: 'Reise verlassen?', text: 'Du siehst diese Reise dann nicht mehr. Ein neuer Einladungslink bringt dich zurück.', confirmLabel: 'Verlassen', danger: true });
          if (!ok) return;
          net.mutate('trip.leave', { tripId });
          navigate('/', { replace: true });
          toast('Du hast die Reise verlassen');
        } }, h('span', { class: 'ic' }, iconEl('logout')), h('span', null, 'Reise verlassen')));

    el.append(hero, people, invite, actions, h('div', { style: { height: '24px' } }));
    el.scrollTop = sc;
  }

  draw();
  const off = on('trip:' + tripId, () => { if (el.offsetParent !== null || el.isConnected) draw(); });
  return { el, show() { draw(); }, hide() {}, destroy() { off(); } };
}
