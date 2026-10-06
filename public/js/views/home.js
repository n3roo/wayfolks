// Startseite: meine Reisen
import { h, clear, avatarStack, avatar, fmtRange, todayStr, iconEl, toast } from '../ui.js';
import { ROAD_ART } from '../icons.js';
import { state, on } from '../state.js';
import { APP_NAME, ROLE_LABEL } from '../config.js';
import { tripCoverUrl, hashHue } from '../util.js';
import { openTripForm } from './tripform.js';
import { openProfile, installer, isStandalone } from './profile.js';

function groupTrips(trips) {
  const today = todayStr();
  const now = [], upcoming = [], past = [];
  for (const t of trips) {
    if (t.start_date && t.end_date && t.start_date <= today && today <= t.end_date) now.push(t);
    else if (t.end_date && t.end_date < today) past.push(t);
    else if (!t.end_date && t.start_date && t.start_date < today) past.push(t);
    else upcoming.push(t);
  }
  upcoming.sort((a, b) => (a.start_date || '9999').localeCompare(b.start_date || '9999'));
  past.sort((a, b) => (b.end_date || b.start_date || '').localeCompare(a.end_date || a.start_date || ''));
  return { now, upcoming, past };
}

function tripCard(t, navigate) {
  const cover = tripCoverUrl(t);
  const hue = hashHue(t.id);
  const bg = h('div', { class: `bg ${cover ? '' : 'gen'}` });
  if (cover) bg.style.backgroundImage = `url("${cover}")`;
  else {
    bg.style.background = `linear-gradient(135deg, hsl(${hue} 55% 38%), hsl(${(hue + 40) % 360} 60% 24%))`;
    bg.innerHTML = '<svg viewBox="0 0 100 100" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-dasharray="1 8"><path d="M5 90C30 80 20 55 45 50S85 55 90 15"/></svg>';
  }
  const today = todayStr();
  const live = t.start_date && t.end_date && t.start_date <= today && today <= t.end_date;
  const pct = t.stop_count ? Math.round((t.visited_count / t.stop_count) * 100) : 0;
  const card = h('button', { class: 'trip-card', onclick: () => navigate('/t/' + t.id), 'aria-label': `Reise ${t.title} öffnen` },
    bg,
    h('div', { class: 'inner' },
      h('div', { class: 'top' },
        h('span', { class: `badge ${live ? 'live' : ''}`, style: { visibility: live || t.role !== 'owner' ? 'visible' : 'hidden' } }, live ? 'Unterwegs' : ROLE_LABEL[t.role]),
        t.members.length > 1 ? avatarStack(t.members, 4) : null),
      h('div', null,
        h('h3', null, t.title),
        h('div', { class: 'meta' },
          h('span', null, `${fmtRange(t.start_date, t.end_date)} · ${t.stop_count} ${t.stop_count === 1 ? 'Stopp' : 'Stopps'}`)),
        t.visited_count > 0 ? h('div', { class: 'progress', title: `${t.visited_count} von ${t.stop_count} besucht` }, h('i', { style: { width: pct + '%' } })) : null)));
  return card;
}

export function homeView({ navigate }) {
  const root = h('div', { class: 'view' });
  const list = h('div', { class: 'scroll' });
  const fab = h('button', { class: 'fab', onclick: () => openTripForm({ onSaved: (id, created) => created && navigate('/t/' + id) }) }, iconEl('plus'), 'Neue Reise');

  const head = h('div', { class: 'home-head' },
    h('div', { class: 'brand' }, h('img', { src: '/icons/icon-192.png', alt: '' }), h('b', null, APP_NAME)),
    h('button', { class: 'icon-btn flat', 'aria-label': 'Profil', style: { background: 'transparent', boxShadow: 'none' }, onclick: () => openProfile() }));
  const avatarSlot = head.lastChild;
  const drawAvatar = () => { avatarSlot.replaceChildren(avatar(state.user, 'lg')); };

  function draw() {
    drawAvatar();
    clear(list);
    const trips = state.trips;
    list.append(h('div', { class: 'hello' },
      h('h1', null, `Hallo ${state.user.name.split(' ')[0]}`),
      h('p', null, trips === null ? 'Deine Reisen werden geladen …' : trips.length ? 'Wohin geht es als Nächstes?' : 'Bereit für den ersten Roadtrip?')));

    if (trips === null) {
      list.append(h('div', { class: 'trip-list', style: { marginTop: '12px' } }, h('div', { class: 'skeleton' }), h('div', { class: 'skeleton' })));
      return;
    }
    if (!isStandalone() && installer.prompt && !localStorage.getItem('wf.installHint')) {
      list.append(h('div', { class: 'install-card' }, h('p', null, h('b', null, 'Als App installieren'), 'Schneller Start vom Homescreen, auch bei schlechtem Empfang.'),
        h('button', { class: 'btn small', onclick: async () => { installer.prompt.prompt(); await installer.prompt.userChoice.catch(() => {}); installer.prompt = null; draw(); } }, 'Installieren'),
        h('button', { class: 'icon-btn flat sm', 'aria-label': 'Hinweis ausblenden', onclick: () => { localStorage.setItem('wf.installHint', '1'); draw(); } }, iconEl('close', 'sm'))));
    }
    if (!trips.length) {
      list.append(h('div', { class: 'empty' },
        h('div', { html: ROAD_ART }),
        h('h2', { class: 'display' }, 'Noch keine Reise'),
        h('p', null, 'Lege eine Reise an, füge Stopps auf der Karte hinzu und lade deine Mitreisenden per Link ein.'),
        h('button', { class: 'btn', onclick: () => fab.click() }, 'Erste Reise anlegen')));
      return;
    }
    const g = groupTrips(trips);
    const section = (title, items) => {
      if (!items.length) return;
      list.append(h('div', { class: 'section-title' }, title), h('div', { class: 'trip-list' }, items.map((t) => tripCard(t, navigate))));
    };
    section('Unterwegs', g.now);
    section('Geplant', g.upcoming);
    section('Erinnerungen', g.past);
    list.append(h('div', { style: { height: '84px' } }));
  }

  draw();
  const offs = [on('trips', draw), on('user', drawAvatar), on('conn', () => {})];
  const onInstallable = () => { if (state.trips) draw(); };
  window.addEventListener('wf-installable', onInstallable);
  root.append(head, list, fab);
  if (new URLSearchParams(location.search).get('neu')) { history.replaceState(null, '', '/'); setTimeout(() => fab.click(), 300); }
  void toast;
  return { el: root, destroy() { offs.forEach((o) => o()); window.removeEventListener('wf-installable', onInstallable); } };
}
