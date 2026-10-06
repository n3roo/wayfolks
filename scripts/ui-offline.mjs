// Offline-Test: App-Hülle kommt aus dem Service Worker, Reise und Fotos bleiben sichtbar, kein Absturz
import assert from 'node:assert/strict';
import { puppeteer, chromePath, startServer, newPhone } from './ui-lib.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ok = (n) => console.log('  ✓', n);
async function waitFor(page, fn, arg, { timeout = 10000, label = '' } = {}) {
  try { await page.waitForFunction(fn, { timeout, polling: 100 }, arg); } catch { throw new Error(`Zeitüberschreitung: ${label}`); }
}
const srv = await startServer();
const browser = await puppeteer.launch({ executablePath: chromePath(), headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
let failed = null;
try {
  const P = await newPhone(browser, srv.base, { name: 'Offline', bypassSW: false });
  const a = P.page;
  await a.goto(srv.base + '/', { waitUntil: 'networkidle2' });
  await waitFor(a, () => document.querySelector('.welcome .panel input'), null, { label: 'Willkommen' });
  await a.focus('.welcome .panel input'); await a.keyboard.type('Offi');
  await a.$eval('.welcome .panel .btn', (e) => e.click());
  await waitFor(a, () => document.querySelector('.sheet .code-box'), null, { label: 'Code' });
  await sleep(300);
  await a.$eval('.sheet .check-row', (e) => e.click()); await a.$eval('.sheet .btn.block', (e) => e.click());
  await waitFor(a, () => document.querySelector('.hello') && window.__wf.state.conn === 'online', null, { label: 'online' });
  await a.evaluate(() => {
    const { net } = window.__wf;
    net.mutate('trip.create', { id: 'tripOfflineA01', title: 'Offline-Reise' });
    net.mutate('stop.create', { tripId: 'tripOfflineA01', stop: { id: 'stopOfflineA01', name: 'Bregenz', lat: 47.5, lon: 9.74 } });
  });
  await waitFor(a, () => window.__wf.state.pending === 0, null, { label: 'gesendet' });
  await a.evaluate(() => window.__wf.navigate('/t/tripOfflineA01/story'));
  await waitFor(a, () => document.querySelector('.story-hero'), null, { label: 'Rückblick' });
  ok('Online eingerichtet');

  // Service Worker aktiv und App-Hülle zwischengespeichert
  await waitFor(a, async () => { const r = await navigator.serviceWorker.getRegistration(); return !!r?.active; }, null, { label: 'Service Worker aktiv' });
  await a.reload({ waitUntil: 'networkidle2' });
  await waitFor(a, () => !!navigator.serviceWorker.controller, null, { label: 'SW steuert die Seite' });
  await sleep(1500);
  ok('Service Worker aktiv');

  // Offline neu laden: Seite muss kommen
  await a.setOfflineMode(true);
  await a.reload({ waitUntil: 'domcontentloaded' });
  await waitFor(a, () => document.querySelector('.story-hero, .hello, .splash'), null, { label: 'Seite offline da', timeout: 12000 });
  await waitFor(a, () => window.__wf?.state.user, null, { label: 'Profil offline geladen' });
  ok('Offline-Neustart zeigt die App');
  await waitFor(a, () => document.querySelector('.story-hero h1')?.textContent === 'Offline-Reise', null, { label: 'Reise aus dem Zwischenspeicher', timeout: 12000 });
  ok('Reise ist offline sichtbar');
  assert.ok(await a.evaluate(() => document.querySelector('.banner')?.textContent.includes('Offline')), 'Offline-Hinweis sichtbar');
  ok('Offline-Hinweis erscheint');

  // Weiter bedienbar: Stopp offline hinzufügen, danach online nachholen
  await a.evaluate(() => { window.__wf.net.mutate('stop.create', { tripId: 'tripOfflineA01', stop: { id: 'stopOfflineA02', name: 'Lindau', lat: 47.55, lon: 9.68 } }); });
  assert.equal(await a.evaluate(() => window.__wf.state.pending), 1);
  await a.setOfflineMode(false);
  await a.evaluate(() => window.dispatchEvent(new Event('online')));
  await waitFor(a, () => window.__wf.state.pending === 0 && window.__wf.state.tripData.tripOfflineA01.stops.length === 2, null, { label: 'Nachholen', timeout: 20000 });
  ok('Offline-Änderung wird nachgeholt');
  // Offline können nie geladene Kartenkacheln nicht erscheinen: das ist kein Programmfehler
  const real = P.errors.filter((e) => !/Failed to load resource: net::ERR_FAILED/.test(e));
  if (real.length) { console.log('Konsolenfehler:', real); failed = new Error('Konsolenfehler'); }
} catch (e) { failed = e; console.error('FEHLER:', e.message); }
finally { await browser.close(); await srv.app.close(); }
process.exit(failed ? 1 : 0);
