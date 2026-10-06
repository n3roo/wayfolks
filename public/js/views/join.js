// Einladung annehmen
import { h, toast } from '../ui.js';
import { net } from '../net.js';
import { state } from '../state.js';
import { ROLE_LABEL } from '../config.js';
import { tripCoverUrl } from '../util.js';
import { fmtRange } from '../ui.js';

export async function acceptInvite(token) {
  await net.ready();
  return net.request('invite.accept', { token });
}

export function joinView({ token, navigate }) {
  const root = h('div', { class: 'view welcome' });
  const panel = h('div', { class: 'panel', style: { marginTop: 'auto' } });
  const stage = h('div', { class: 'hero' }, h('img', { src: '/icons/icon-192.png', alt: '', width: 92, height: 92 }), h('h1', null, 'Einladung'));
  root.append(stage, panel);
  panel.append(h('p', { class: 'center muted pulse' }, 'Einladung wird geprüft …'));

  (async () => {
    let info;
    try { info = await net.peek(token); }
    catch (e) {
      panel.replaceChildren(
        h('h3', { class: 'display', style: { fontSize: '22px', marginBottom: '8px' } }, 'Link nicht mehr gültig'),
        h('p', { class: 'muted' }, e.message || 'Bitte frag nach einem neuen Einladungslink.'),
        h('button', { class: 'btn block', onclick: () => navigate('/', { replace: true }) }, 'Zu meinen Reisen'));
      return;
    }
    const url = tripCoverUrl({ id: info.trip_id, has_cover: info.has_cover, cover_version: info.cover_version });
    stage.append(h('div', { class: 'invite', style: { marginTop: '22px' } },
      h('div', { class: 'thumb', style: url ? { backgroundImage: `url(${url})` } : null }),
      h('div', null, h('span', null, `${info.owner_name} lädt dich ein zu`), h('b', null, info.title), h('span', null, fmtRange(info.start_date, info.end_date)))));
    const mine = state.trips?.find((t) => t.id === info.trip_id);
    const btn = h('button', { class: 'btn block', onclick: async () => {
      btn.disabled = true; btn.textContent = 'Einen Moment …';
      try {
        const r = await acceptInvite(token);
        toast(r.joined ? 'Du bist dabei!' : 'Du bist schon dabei.');
        navigate('/t/' + r.tripId, { replace: true });
      } catch (e) {
        toast(e.message || 'Beitreten hat nicht geklappt.', { error: true });
        btn.disabled = false; btn.textContent = 'Beitreten';
      }
    } }, mine ? 'Reise öffnen' : 'Beitreten');
    panel.replaceChildren(
      h('p', { style: { marginTop: 0 } }, mine ? 'Du bist bei dieser Reise schon dabei.' : `Du kannst als „${ROLE_LABEL[info.role]}“ mitmachen. ${info.role === 'editor' ? 'Du darfst Stopps ändern und Fotos hinzufügen.' : 'Du kannst die Reise ansehen, aber nichts ändern.'}`),
      btn,
      h('button', { class: 'link-btn', onclick: () => navigate('/', { replace: true }) }, 'Nicht jetzt'));
  })();
  return { el: root, destroy() {} };
}
