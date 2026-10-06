// Reise-Ansicht: Tabs (Plan, Gruppe, später mehr)
import { h, toast, iconEl } from '../ui.js';
import { state, on } from '../state.js';
import { net } from '../net.js';
import { createPlan } from './plan.js';
import { createTeam } from './team.js';

const TABS = [
  { id: 'plan', label: 'Plan', icon: 'route' },
  { id: 'team', label: 'Gruppe', icon: 'users' },
];

export function tripView({ tripId, tab = 'plan', navigate }) {
  const root = h('div', { class: 'view trip-view' });
  const offs = [];
  let pages = null;
  let current = null;
  let tabbar = null;

  function setTab(id, { push = false } = {}) {
    if (!pages || !pages[id]) id = 'plan';
    current = id;
    for (const [pid, p] of Object.entries(pages)) {
      p.el.style.display = pid === id ? '' : 'none';
      if (pid === id) p.show?.(); else p.hide?.();
    }
    tabbar.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.tab === id));
    const url = '/t/' + tripId + (id === 'plan' ? '' : '/' + id);
    if (location.pathname !== url) history[push ? 'pushState' : 'replaceState'](null, '', url);
  }

  function build() {
    root.replaceChildren();
    pages = {
      plan: createPlan({ tripId, navigate, goTeam: () => setTab('team') }),
      team: createTeam({ tripId, navigate }),
    };
    tabbar = h('nav', { class: 'tabbar', 'aria-label': 'Bereiche der Reise' },
      TABS.map((t) => h('button', { 'data-tab': t.id, onclick: () => setTab(t.id), 'aria-label': t.label }, iconEl(t.icon), h('span', null, t.label))));
    root.append(pages.plan.el, pages.team.el, tabbar);
    setTab(tab);
  }

  function showLoading(text, canGoBack) {
    root.replaceChildren(h('div', { class: 'splash', style: { flexDirection: 'column', gap: '18px', padding: '24px', textAlign: 'center' } },
      h('img', { src: '/icons/icon-192.png', alt: '' }), h('p', { class: 'muted' }, text),
      canGoBack ? h('button', { class: 'btn ghost', onclick: () => navigate('/') }, 'Zu meinen Reisen') : null));
  }

  if (state.tripData[tripId]) build();
  else {
    showLoading(state.conn === 'online' ? 'Reise wird geladen …' : 'Verbinde …', false);
    const off = on('trip:' + tripId, () => { if (!pages && state.tripData[tripId]) { build(); } });
    offs.push(off);
  }

  const loadFresh = () => {
    if (state.conn !== 'online') return;
    net.watch(tripId).catch((e) => {
      if (e.code === 'not_found') { toast('Diese Reise gibt es nicht oder du hast keinen Zugriff.', { error: true }); navigate('/', { replace: true }); }
    });
  };
  offs.push(on('conn', () => {
    if (state.conn === 'online') loadFresh();
    else if (!pages && state.conn === 'offline') showLoading('Diese Reise ist offline noch nicht gespeichert. Sobald du wieder Empfang hast, lädt sie automatisch.', true);
  }));
  net.watching = tripId;
  loadFresh();

  offs.push(on('gone', ({ tripId: id, reason }) => {
    if (id !== tripId) return;
    toast(reason === 'deleted' ? 'Diese Reise wurde gelöscht.' : reason === 'removed' ? 'Du wurdest aus der Reise entfernt.' : 'Du hast die Reise verlassen.');
    navigate('/', { replace: true });
  }));

  return {
    el: root,
    // Wechsel zwischen den Tabs derselben Reise ohne Neuaufbau
    update(route) {
      if (route.name === 'trip' && route.tripId === tripId) { if (pages) setTab(route.tab); return true; }
      return false;
    },
    destroy() { offs.forEach((o) => o()); Object.values(pages || {}).forEach((p) => p.destroy?.()); net.unwatch(tripId); },
  };
}
