// Einstieg: Routing, Verbindungs-Hinweis, Service Worker
import { $, h, toast, handleLayerPop, closeAllLayers } from './ui.js';
import { state, on, loadCreds, loadCache, clearCreds } from './state.js';
import { net } from './net.js';
import { welcomeView } from './views/welcome.js';
import { homeView } from './views/home.js';
import { joinView, acceptInvite } from './views/join.js';
import { tripView } from './views/trip.js';

const stage = $('#stage');
const banner = $('#banner');
let view = null;
let authProblem = null;

function parse(path) {
  let m;
  if ((m = path.match(/^\/t\/([A-Za-z0-9_-]+)(?:\/(plan|team))?\/?$/))) return { name: 'trip', tripId: m[1], tab: m[2] || 'plan' };
  if ((m = path.match(/^\/j\/([A-Za-z0-9_-]+)\/?$/))) return { name: 'join', token: m[1] };
  return { name: 'home' };
}

export function navigate(path, { replace = false } = {}) {
  history[replace ? 'replaceState' : 'pushState'](null, '', path);
  render();
}

function mount(v) {
  try { view?.destroy?.(); } catch (e) { console.error(e); }
  view = v;
  stage.replaceChildren(v.el);
}

function render() {
  const route = parse(location.pathname);
  if (!state.user) {
    const inviteToken = route.name === 'join' ? route.token : null;
    mount(welcomeView({
      inviteToken,
      message: authProblem,
      startMode: authProblem ? 'recover' : 'new',
      onRegistered: async () => {
        authProblem = null;
        if (inviteToken) {
          try {
            const r = await acceptInvite(inviteToken);
            toast(r.joined ? 'Du bist dabei!' : 'Du bist schon dabei.');
            navigate('/t/' + r.tripId, { replace: true });
          } catch (e) {
            toast(e.message || 'Beitreten hat nicht geklappt.', { error: true });
            navigate('/', { replace: true });
          }
        } else navigate('/', { replace: true });
      },
    }));
    return;
  }
  if (view?.update?.(route)) return;
  if (route.name === 'trip') mount(tripView({ tripId: route.tripId, tab: route.tab, navigate }));
  else if (route.name === 'join') mount(joinView({ token: route.token, navigate }));
  else mount(homeView({ navigate }));
}

window.addEventListener('popstate', () => {
  if (handleLayerPop()) return;
  render();
});

// ---------- Hinweisleiste: offline / Server wacht auf / Änderungen werden gesendet ----------
function drawBanner() {
  banner.replaceChildren();
  const c = state.conn;
  if (c === 'offline') {
    banner.append(h('div', { class: 'banner offline' }, h('span', null, state.pending ? `Offline · ${state.pending} Änderung${state.pending === 1 ? '' : 'en'} wartet auf Empfang` : 'Offline · Änderungen werden gespeichert und später gesendet')));
  } else if (c === 'connecting' && Date.now() - state.connectingSince > 4000) {
    banner.append(h('div', { class: 'banner' }, h('i', { class: 'spin' }), h('span', null, 'Verbinde mit dem Server … Nach einer Pause wacht er erst auf, das kann bis zu einer Minute dauern.')));
  } else if (c === 'online' && state.pending > 0) {
    banner.append(h('div', { class: 'banner offline' }, h('i', { class: 'spin' }), h('span', null, `Sende ${state.pending} Änderung${state.pending === 1 ? '' : 'en'} …`)));
  }
}
on('conn', drawBanner);
on('pending', drawBanner);
setInterval(drawBanner, 1500);

on('auth_failed', () => {
  if (!loadCreds()) return;
  authProblem = 'Dein Profil wurde auf dem Server nicht gefunden. Gib deinen Wiederherstellungs-Code ein, um weiterzumachen.';
  clearCreds();
  closeAllLayers().then(render);
});

// ---------- Service Worker ----------
if ('serviceWorker' in navigator) {
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.register('/sw.js').catch((e) => console.warn('Service Worker nicht aktiv', e));
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (hadController) toast('Neue Version bereit', { actionLabel: 'Neu laden', action: () => location.reload(), ms: 12000 });
  });
}

// ---------- Start ----------
(async function boot() {
  const creds = loadCreds();
  if (creds) {
    state.user = { id: creds.id, name: creds.name, color: creds.color };
    await loadCache();
  }
  render();
  net.start();
})();

window.__wf = { state, net, navigate };
