// Oberflächen-Test in Handy-Größe (Galaxy S23 Ultra): Ablauf von Profil bis Zusammenarbeit, mit Screenshots
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { puppeteer, chromePath, startServer, newPhone, sharp } from './ui-lib.mjs';

const OUT = 'shots';
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
function ok(name) { results.push(name); console.log('  ✓', name); }

async function waitFor(page, fn, arg, { timeout = 8000, label = '' } = {}) {
  try { await page.waitForFunction(fn, { timeout, polling: 100 }, arg); }
  catch (e) { throw new Error(`Zeitüberschreitung: ${label || fn.toString().slice(0, 80)}`); }
}
const click = (page, sel) => page.$eval(sel, (el) => el.click());
const clickText = (page, sel, text) => page.evaluate((s, t) => {
  const el = [...document.querySelectorAll(s)].find((e) => e.textContent.includes(t));
  if (!el) throw new Error('Element nicht gefunden: ' + s + ' / ' + t);
  el.click();
}, sel, text);
const shot = (page, name) => page.screenshot({ path: `${OUT}/${name}.png` });
const typeInto = async (page, sel, text) => { await page.focus(sel); await page.$eval(sel, (e) => { e.value = ''; }); await page.keyboard.type(text, { delay: 8 }); };
const setValue = (page, sel, v) => page.$eval(sel, (el, val) => { el.value = val; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); }, v);
const wf = (page, fn, ...a) => page.evaluate(fn, ...a);

async function addStopBySearch(page, query, expectName) {
  await clickText(page, '.dock-head .btn, .add-row, .empty .btn', 'Stopp');
  await waitFor(page, () => document.querySelector('.searchbar input'), null, { label: 'Suchfeld' });
  await typeInto(page, '.searchbar input', query);
  await waitFor(page, () => document.querySelector('.result'), null, { label: 'Suchergebnis für ' + query });
  await sleep(150);
  await click(page, '.result');
  await waitFor(page, () => document.querySelector('.draft-card'), null, { label: 'Entwurfskarte' });
  const name = await page.$eval('.draft-card input', (e) => e.value);
  assert.equal(name, expectName);
  await sleep(200);
  return name;
}
async function confirmDraft(page) {
  await clickText(page, '.draft-card .btn', 'Hinzufügen');
  await waitFor(page, () => !document.querySelector('.draft-card'), null, { label: 'Entwurfskarte weg' });
  await sleep(250);
}

const srv = await startServer();
const browser = await puppeteer.launch({ executablePath: chromePath(), headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
let failed = null;
const allErrors = [];
try {
  // ---------- Besitzerin ----------
  const A = await newPhone(browser, srv.base, { name: 'Anna' });
  const a = A.page;
  await a.goto(srv.base + '/', { waitUntil: 'networkidle2' });
  await waitFor(a, () => document.querySelector('.welcome .panel input'), null, { label: 'Willkommensseite' });
  await shot(a, '01-welcome');
  await typeInto(a, '.welcome .panel input', 'Anna Beispiel');
  await click(a, '.welcome .panel .btn');
  await waitFor(a, () => document.querySelector('.sheet .code-box'), null, { label: 'Wiederherstellungs-Code' });
  const code = await a.$eval('.sheet .code-box', (e) => e.textContent);
  assert.match(code, /^[A-Z2-9]{4}(-[A-Z2-9]{4}){3}$/);
  await sleep(400);
  await shot(a, '02-recovery-code');
  const weiter = await a.$eval('.sheet .btn.block', (e) => e.disabled);
  assert.equal(weiter, true, 'Weiter ist erst nach Bestätigung aktiv');
  await click(a, '.sheet .check-row');
  await click(a, '.sheet .btn.block');
  await waitFor(a, () => document.querySelector('.hello') && !document.querySelector('.sheet'), null, { label: 'Startseite' });
  await waitFor(a, () => document.querySelector('.empty'), null, { label: 'Leerer Zustand' });
  await sleep(300);
  await shot(a, '03-home-empty');
  ok('Profil anlegen mit Wiederherstellungs-Code');

  // Reise anlegen
  await click(a, '.empty .btn');
  await waitFor(a, () => document.querySelector('.sheet input.title'), null, { label: 'Reise-Formular' });
  await sleep(450);
  await typeInto(a, '.sheet input.title', 'Sommer an der Adria');
  await setValue(a, '.sheet input[aria-label="Von"]', '2026-10-05');
  await setValue(a, '.sheet input[aria-label="Bis"]', '2026-10-18');
  const coverJpg = await sharp({ create: { width: 1600, height: 1000, channels: 3, background: '#2b6cb0' } })
    .composite([{ input: Buffer.from('<svg width="1600" height="1000"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#f6ad55"/><stop offset="1" stop-color="#2c5282"/></linearGradient></defs><rect width="1600" height="1000" fill="url(#g)"/><circle cx="1150" cy="300" r="140" fill="#fbd38d"/><path d="M0 700 Q400 560 800 700 T1600 660 V1000 H0Z" fill="#2a4365"/></svg>') }]).jpeg().toBuffer();
  fs.writeFileSync(`${OUT}/_cover.jpg`, coverJpg);
  const [chooser] = await Promise.all([a.waitForFileChooser(), click(a, '.sheet .cover-pick')]);
  await chooser.accept([`${OUT}/_cover.jpg`]);
  await waitFor(a, () => document.querySelector('.cover-pick.has'), null, { label: 'Titelbild-Vorschau' });
  await sleep(300);
  await shot(a, '04-trip-form');
  await clickText(a, '.sheet .btn', 'Reise anlegen');
  await waitFor(a, () => document.querySelector('#map .leaflet-tile-loaded'), null, { label: 'Karte mit Kacheln', timeout: 12000 });
  await sleep(500);
  await shot(a, '05-trip-empty');
  const tripId = await wf(a, () => location.pathname.split('/')[2]);
  assert.ok(tripId && tripId.length >= 8);
  ok('Reise anlegen mit Titelbild, Karte öffnet');

  // Stopps per Suche
  const first = await addStopBySearch(a, 'Wien', 'Wien');
  await shot(a, '06-draft');
  await confirmDraft(a);
  await addStopBySearch(a, 'Ljubljana', 'Ljubljana'); await confirmDraft(a);
  await addStopBySearch(a, 'Triest', 'Triest'); await confirmDraft(a);
  await addStopBySearch(a, 'Venedig', 'Venedig'); await confirmDraft(a);
  assert.equal(first, 'Wien');
  await waitFor(a, () => /km/.test(document.querySelector('.dock-head .sub')?.textContent || ''), null, { label: 'Route mit Kilometern', timeout: 10000 });
  await sleep(600);
  await shot(a, '07-plan-with-route');
  const sub = await a.$eval('.dock-head .sub', (e) => e.textContent);
  assert.match(sub, /^4 Stopps · \d[\d.,]* km · /);
  const legs = await a.$$eval('.leg', (els) => els.map((e) => e.textContent));
  assert.equal(legs.length, 3);
  assert.ok(legs.every((l) => /km · /.test(l)), 'Strecken pro Etappe: ' + legs.join(' | '));
  ok('4 Stopps per Suche hinzugefügt, Route mit Entfernung und Fahrzeit: ' + sub);

  // Server hat alles gespeichert
  const snap = await srv.app.store.openTrip((await srv.app.store.db.execute('SELECT id FROM users')).rows[0].id, tripId);
  assert.deepEqual(snap.stops.map((s) => s.name), ['Wien', 'Ljubljana', 'Triest', 'Venedig']);
  ok('Stopps liegen in der Datenbank');

  // Karte tippen → Pin
  await clickText(a, '.dock-head .btn', 'Stopp');
  await waitFor(a, () => document.querySelector('.searchbar input'), null);
  await a.mouse.click(206, 300);
  await waitFor(a, () => document.querySelector('.draft-card'), null, { label: 'Entwurf per Kartentipp' });
  await waitFor(a, () => document.querySelector('.draft-card input').value.length > 0, null, { label: 'Ortsname per Rückwärtssuche' });
  const tapName = await a.$eval('.draft-card input', (e) => e.value);
  await shot(a, '08-draft-from-tap');
  await clickText(a, '.draft-card .btn', 'Abbrechen');
  await waitFor(a, () => !document.querySelector('.draft-card'), null);
  await sleep(300);
  assert.equal(await wf(a, () => window.__wf.state.tripData[location.pathname.split('/')[2]].stops.length), 4);
  ok('Kartentipp setzt Pin mit Ortsname („' + tapName + '“), Abbrechen verwirft ihn');

  // Dock aufziehen
  const grab = await a.$eval('.dock .grab', (e) => { const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
  await a.mouse.move(grab.x, grab.y); await a.mouse.down();
  for (let i = 1; i <= 12; i++) { await a.mouse.move(grab.x, grab.y - i * 40); await sleep(16); }
  await a.mouse.up();
  await sleep(500);
  const state1 = await a.evaluate(() => document.body.dataset.dock);
  assert.equal(state1, 'full');
  await shot(a, '09-plan-full');
  ok('Dock lässt sich bis auf volle Höhe ziehen');

  // Umsortieren: Venedig (4.) vor Ljubljana (2.)
  const handles = await a.$$eval('.stop .handle', (els) => els.map((e) => { const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; }));
  assert.equal(handles.length, 4);
  const from = handles[3], to = handles[1];
  await a.mouse.move(from.x, from.y); await a.mouse.down();
  for (let i = 1; i <= 14; i++) { await a.mouse.move(from.x, from.y + (to.y - from.y - 10) * (i / 14)); await sleep(20); }
  await shot(a, '10-reorder-dragging');
  await a.mouse.up();
  await sleep(500);
  const order = await a.$$eval('.stop .txt b', (els) => els.map((e) => e.textContent));
  assert.deepEqual(order, ['Wien', 'Venedig', 'Ljubljana', 'Triest']);
  await waitFor(a, () => window.__wf.net.outbox.length === 0, null, { label: 'Warteschlange leer' });
  const snap2 = await srv.app.store.openTrip(snap.members[0].id, tripId);
  assert.deepEqual(snap2.stops.map((s) => s.name), ['Wien', 'Venedig', 'Ljubljana', 'Triest']);
  ok('Stopp per Griff umsortiert und auf dem Server gespeichert');

  // Details
  await click(a, '.stop:nth-of-type(1)');
  await waitFor(a, () => document.querySelector('.sheet textarea'), null, { label: 'Stopp-Details' });
  await sleep(450);
  await shot(a, '11-stop-sheet');
  await typeInto(a, '.sheet textarea:nth-of-type(1)', 'Kaffeehaus und Schloss Schönbrunn');
  await setValue(a, '.sheet input[type=date]', '2026-10-06');
  await sleep(1100);
  const s0 = (await srv.app.store.openTrip(snap.members[0].id, tripId)).stops[0];
  assert.equal(s0.description, 'Kaffeehaus und Schloss Schönbrunn');
  assert.equal(s0.planned_date, '2026-10-06');
  await click(a, '.sheet .check-row');
  await sleep(500);
  assert.ok(await wf(a, () => window.__wf.state.tripData[location.pathname.split('/')[2]].stops[0].visited_at));
  await shot(a, '12-stop-visited');
  ok('Stopp-Details bearbeiten, Datum setzen, als besucht abhaken');
  await a.mouse.click(206, 40); // Hintergrund schließt das Sheet
  await waitFor(a, () => !document.querySelector('.sheet'), null);
  await sleep(300);

  // Gruppe + Einladung
  await clickText(a, '.tabbar button', 'Gruppe');
  await sleep(500);
  await shot(a, '13-team');
  await clickText(a, '.list-btn', 'Freunde per Link einladen');
  await waitFor(a, () => /\/j\//.test(document.querySelector('.linkbox')?.textContent || ''), null, { label: 'Einladungslink' });
  await sleep(300);
  await shot(a, '14-invite-sheet');
  const inviteLink = await a.$eval('.linkbox', (e) => e.textContent);
  assert.match(inviteLink, /\/j\/[A-Za-z0-9_-]{16,}$/);
  ok('Einladungslink erstellt');
  await a.mouse.click(206, 40);
  await waitFor(a, () => !document.querySelector('.sheet'), null);

  // ---------- Gast ----------
  const B = await newPhone(browser, srv.base, { name: 'Ben' });
  const b = B.page;
  await b.goto(inviteLink, { waitUntil: 'networkidle2' });
  await waitFor(b, () => document.querySelector('.invite b')?.textContent.includes('Adria'), null, { label: 'Einladung mit Reisename' });
  await sleep(400);
  await shot(b, '15-guest-invite');
  const ogImg = await (await fetch(inviteLink)).text();
  assert.match(ogImg, /og:image/);
  await typeInto(b, '.welcome .panel input', 'Ben Gast');
  await click(b, '.welcome .panel .btn');
  await waitFor(b, () => document.querySelector('.sheet .code-box'), null);
  await click(b, '.sheet .check-row'); await click(b, '.sheet .btn.block');
  await waitFor(b, () => location.pathname.startsWith('/t/') && document.querySelector('.dock'), null, { label: 'Gast sieht die Reise', timeout: 12000 });
  await waitFor(b, () => /4 Stopps/.test(document.querySelector('.dock-head .sub')?.textContent || ''), null, { label: 'Gast sieht 4 Stopps' });
  await sleep(700);
  await shot(b, '16-guest-trip');
  ok('Gast tritt per Link bei und sieht Reise mit 4 Stopps');

  // Live: Anna fügt hinzu → Ben sieht es
  await clickText(a, '.tabbar button', 'Plan');
  await sleep(300);
  await addStopBySearch(a, 'Rovinj', 'Rovinj'); await confirmDraft(a);
  await waitFor(b, () => /5 Stopps/.test(document.querySelector('.dock-head .sub')?.textContent || ''), null, { label: 'Live: Ben sieht 5 Stopps', timeout: 6000 });
  ok('Live-Sync: neuer Stopp erscheint sofort beim Gast');

  // Ben (Mitbearbeiter) benennt um → Anna sieht es
  await click(b, '.stop:nth-of-type(1)');
  await waitFor(b, () => document.querySelector('.sheet input.title'), null);
  await sleep(450);
  await typeInto(b, '.sheet input.title', 'Wien Zentrum');
  await sleep(1100);
  await waitFor(a, () => [...document.querySelectorAll('.stop .txt b')].some((e) => e.textContent === 'Wien Zentrum'), null, { label: 'Live: Anna sieht neuen Namen', timeout: 6000 });
  ok('Live-Sync: Umbenennen durch Mitbearbeiter erscheint bei der Besitzerin');
  await b.mouse.click(206, 40);
  await waitFor(b, () => !document.querySelector('.sheet'), null);

  // Rolle ändern → nur ansehen
  await clickText(a, '.tabbar button', 'Gruppe');
  await waitFor(a, () => document.querySelectorAll('.person').length === 2, null);
  await sleep(300);
  await shot(a, '17-team-two');
  await clickText(a, '.person', 'Ben Gast');
  await waitFor(a, () => document.querySelector('.sheet .seg'), null);
  await sleep(400);
  await clickText(a, '.sheet .seg button', 'Nur ansehen');
  await waitFor(b, () => document.querySelector('.dock-head .btn')?.style.display === 'none', null, { label: 'Gast verliert Bearbeiten-Rechte', timeout: 6000 });
  await sleep(500);
  await shot(b, '18-guest-viewer');
  ok('Rolle auf „Nur ansehen“ gesetzt: Bearbeiten-Knöpfe verschwinden beim Gast');
  await a.mouse.click(206, 40);
  await waitFor(a, () => !document.querySelector('.sheet'), null);

  // ---------- Offline ----------
  await clickText(a, '.tabbar button', 'Plan');
  await sleep(300);
  await A.context.setOffline?.(true);
  await a.setOfflineMode(true);
  await waitFor(a, () => window.__wf.state.conn !== 'online', null, { label: 'Offline erkannt', timeout: 15000 });
  await sleep(300);
  await click(a, '.stop:nth-of-type(1)');
  await waitFor(a, () => document.querySelector('.sheet input.title'), null);
  await sleep(450);
  await typeInto(a, '.sheet input.title', 'Wien offline');
  await sleep(1000);
  assert.ok(await wf(a, () => window.__wf.net.outbox.length > 0), 'Änderung wartet in der Schlange');
  await shot(a, '19-offline-edit');
  await a.mouse.click(206, 40);
  await waitFor(a, () => !document.querySelector('.sheet'), null);
  await sleep(500);
  await shot(a, '20-offline-banner');
  await a.setOfflineMode(false);
  await waitFor(a, () => window.__wf.state.conn === 'online' && window.__wf.net.outbox.length === 0, null, { label: 'Wieder online, Warteschlange abgearbeitet', timeout: 30000 });
  const stops = (await srv.app.store.openTrip(snap.members[0].id, tripId)).stops.map((s) => s.name);
  assert.ok(stops.includes('Wien offline'), 'Offline-Änderung ist angekommen: ' + stops.join(', '));
  await waitFor(b, () => [...document.querySelectorAll('.stop .txt b')].some((e) => e.textContent === 'Wien offline'), null, { label: 'Gast sieht nachgeholte Änderung', timeout: 8000 });
  ok('Offline bearbeiten: Änderung wartet, wird nach Verbindung nachgeholt und erreicht den Gast');

  allErrors.push(...A.errors, ...B.errors);
} catch (e) {
  failed = e;
  console.error('\nFEHLER:', e.message);
  for (const p of await browser.pages()) { try { await p.screenshot({ path: `${OUT}/zz-fehler-${Math.random().toString(36).slice(2, 6)}.png` }); } catch {} }
} finally {
  await browser.close();
  await srv.app.close();
}
console.log(`\n${results.length} Prüfungen bestanden.`);
if (allErrors.length) { console.log('Konsolenfehler im Browser:'); allErrors.forEach((e) => console.log('  -', e)); }
if (failed) process.exit(1);
process.exit(allErrors.length ? 2 : 0);
