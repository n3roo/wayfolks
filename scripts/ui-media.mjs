// Oberflächen-Test: Unterwegs-Modus, Fotos und Videos, Warteschlange offline, Rückblick
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { puppeteer, chromePath, startServer, newPhone, sharp } from './ui-lib.mjs';

const OUT = 'shots';
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ok = (n) => console.log('  ✓', n);
async function waitFor(page, fn, arg, { timeout = 10000, label = '' } = {}) {
  try { await page.waitForFunction(fn, { timeout, polling: 100 }, arg); } catch { throw new Error(`Zeitüberschreitung: ${label || fn.toString().slice(0, 80)}`); }
}
const click = (page, sel) => page.$eval(sel, (el) => el.click());
const clickText = (page, sel, text) => page.evaluate((s, t) => {
  const el = [...document.querySelectorAll(s)].find((e) => e.textContent.includes(t));
  if (!el) throw new Error('Element nicht gefunden: ' + s + ' / ' + t);
  el.click();
}, sel, text);
const shot = (page, name) => page.screenshot({ path: `${OUT}/${name}.png` });
const typeInto = async (page, sel, text) => { await page.focus(sel); await page.keyboard.type(text, { delay: 8 }); };

async function makePhoto(file, hue) {
  const svg = `<svg width="3000" height="2000"><defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="hsl(${hue},80%,70%)"/><stop offset="1" stop-color="hsl(${hue + 40},60%,35%)"/></linearGradient></defs><rect width="3000" height="2000" fill="url(#g)"/><circle cx="2200" cy="600" r="260" fill="#fff6d6"/><path d="M0 1400 Q700 1000 1500 1400 T3000 1300 V2000 H0Z" fill="#1d2f4d"/></svg>`;
  await sharp(Buffer.from(svg)).jpeg({ quality: 88 }).toFile(file);
  return file;
}

const srv = await startServer();
const browser = await puppeteer.launch({ executablePath: chromePath(), headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
let failed = null;
const errors = [];
try {
  const P = await newPhone(browser, srv.base, { name: 'Mia' });
  const a = P.page;
  await P.context.overridePermissions(srv.base, ['geolocation']);
  await a.setGeolocation({ latitude: 48.2085, longitude: 16.3735, accuracy: 20 });
  await a.goto(srv.base + '/', { waitUntil: 'networkidle2' });
  await waitFor(a, () => document.querySelector('.welcome .panel input'), null, { label: 'Willkommen' });
  await typeInto(a, '.welcome .panel input', 'Mia');
  await click(a, '.welcome .panel .btn');
  await waitFor(a, () => document.querySelector('.sheet .code-box'), null, { label: 'Code' });
  await sleep(300);
  await click(a, '.sheet .check-row'); await click(a, '.sheet .btn.block');
  await waitFor(a, () => document.querySelector('.hello') && !document.querySelector('.sheet'), null, { label: 'Start' });
  await waitFor(a, () => window.__wf.state.conn === 'online' && window.__wf.state.config.media === true, null, { label: 'online + Speicher aktiv' });
  ok('Profil, Server meldet aktiven Foto-Speicher');

  // Reise und Stopps direkt über den Zustand anlegen
  const tripId = await a.evaluate(async () => {
    const { net, state } = window.__wf;
    const id = 'tripMediaUi01';
    net.mutate('trip.create', { id, title: 'Alpen-Tour', start_date: '2026-10-05', end_date: '2026-10-09' });
    const pts = [['Wien', 48.2082, 16.3738], ['Hallstatt', 47.5622, 13.6493], ['Salzburg', 47.8095, 13.055], ['München', 48.1351, 11.582]];
    pts.forEach(([name, lat, lon], i) => net.mutate('stop.create', { tripId: id, stop: { id: 'stopMediaUi0' + i, name, lat, lon, description: i === 1 ? 'Seeblick und Salzbergwerk.' : '', planned_date: `2026-10-0${5 + i}` } }));
    await net.flush();
    return id;
  });
  await waitFor(a, () => window.__wf.state.pending === 0, null, { label: 'Änderungen gesendet' });
  await a.evaluate((id) => window.__wf.navigate('/t/' + id + '/live'), tripId);
  await waitFor(a, () => document.querySelector('.live .live-card'), null, { label: 'Unterwegs-Karte' });
  await waitFor(a, () => document.querySelector('.live .map-el .leaflet-tile-loaded'), null, { label: 'Karte' });
  await sleep(800);
  await shot(a, 'm01-unterwegs');
  assert.equal(await a.$eval('.live .lc-head b', (e) => e.textContent), 'Wien');
  ok('Unterwegs: aktueller Stopp ist der erste offene');

  // Standort nur auf Wunsch
  assert.equal(await a.evaluate(() => !!document.querySelector('.live .me-dot')), false, 'ohne Wunsch kein Standort');
  await a.evaluate(() => document.querySelector('.live .map-fabs .icon-btn').click());
  await sleep(200);
  assert.equal(await a.$$eval('.dialog', (n) => n.length), 1, 'nur ein Dialog');
  await waitFor(a, () => document.querySelector('.dialog'), null, { label: 'Standort-Frage' });
  await shot(a, 'm02-standort-frage');
  await clickText(a, '.dialog .btn', 'Standort einschalten');
  await waitFor(a, () => document.querySelector('.live .me-dot') && !document.querySelector('.dialog'), null, { label: 'Standortpunkt, Dialog zu' });
  await waitFor(a, () => /von dir|du bist hier/.test(document.querySelector('.live .lc-head')?.textContent || ''), null, { label: 'Entfernung' });
  ok('Standort erst nach Rückfrage, zeigt Punkt und Entfernung');
  await sleep(500);
  await shot(a, 'm03-mit-standort');

  // Foto aufnehmen (Dateiauswahl)
  const jpg1 = await makePhoto(`${OUT}/_p1.jpg`, 20);
  let [chooser] = await Promise.all([a.waitForFileChooser(), clickText(a, '.live .lc-actions .btn', 'Foto')]);
  await chooser.accept([jpg1]);
  await waitFor(a, () => window.__wf.state.tripData.tripMediaUi01.media.length === 1 && !(window.__wf.state.uploads.tripMediaUi01 || []).length, null, { label: 'Foto hochgeladen' });
  const m1 = await a.evaluate(() => window.__wf.state.tripData.tripMediaUi01.media[0]);
  assert.equal(m1.stop_id, 'stopMediaUi00');
  assert.ok(m1.bytes < 900_000, 'Bild wurde verkleinert (' + m1.bytes + ' Bytes)');
  assert.ok(Math.max(m1.width, m1.height) <= 2048);
  assert.ok(m1.thumb, 'Vorschaubild vorhanden');
  assert.ok(m1.lat && m1.lon, 'Ort wurde angehängt, weil der Standort an ist');
  await waitFor(a, () => document.querySelector('.live .media-grid .thumb img'), null, { label: 'Vorschau im Dock' });
  ok(`Foto: verkleinert auf ${m1.width}×${m1.height} (${Math.round(m1.bytes / 1024)} KB), beim Stopp gespeichert`);

  // Vollbild
  await click(a, '.live .media-grid .thumb');
  await waitFor(a, () => document.querySelector('.lightbox .lb-slide img'), null, { label: 'Vollbild' });
  await sleep(400);
  await shot(a, 'm04-vollbild');
  await a.tap('.lightbox .icon-btn[aria-label="Bildunterschrift bearbeiten"]'); // echte Berührung statt Programm-Klick
  await waitFor(a, () => document.querySelector('.sheet textarea'), null, { label: 'Unterschrift' });
  await sleep(300);
  await typeInto(a, '.sheet textarea', 'Los geht die Fahrt!');
  await clickText(a, '.sheet .btn', 'Speichern');
  await waitFor(a, () => document.querySelector('.lb-cap')?.textContent === 'Los geht die Fahrt!', null, { label: 'Unterschrift sichtbar' });
  await waitFor(a, () => window.__wf.state.pending === 0, null, { label: 'Unterschrift gesendet' });
  await a.tap('.lightbox .icon-btn[aria-label="Schließen"]');
  await waitFor(a, () => !document.querySelector('.lightbox'), null, { label: 'Vollbild zu' });
  ok('Vollbild, Bildunterschrift speichern, schließen');

  // Abhaken, danach ist der nächste Stopp aktuell
  await clickText(a, '.live .lc-actions .btn', 'Abhaken');
  await waitFor(a, () => document.querySelector('.live .lc-head b')?.textContent === 'Hallstatt', null, { label: 'nächster Stopp' });
  ok('Abhaken schaltet zum nächsten Stopp');

  // Video (WebM im Browser erzeugen)
  const b64 = await a.evaluate(async () => {
    const c = document.createElement('canvas'); c.width = 320; c.height = 240; const ctx = c.getContext('2d');
    if (!window.MediaRecorder) return null;
    const rec = new MediaRecorder(c.captureStream(15), { mimeType: 'video/webm' });
    const chunks = []; rec.ondataavailable = (e) => chunks.push(e.data);
    const stopped = new Promise((r) => { rec.onstop = r; });
    rec.start();
    for (let i = 0; i < 20; i++) { ctx.fillStyle = `hsl(${i * 18},70%,50%)`; ctx.fillRect(0, 0, 320, 240); ctx.fillStyle = '#fff'; ctx.fillText('Hallstatt ' + i, 20, 120); await new Promise((r) => setTimeout(r, 70)); }
    rec.stop(); await stopped;
    const buf = new Uint8Array(await new Blob(chunks, { type: 'video/webm' }).arrayBuffer());
    let s = ''; for (const x of buf) s += String.fromCharCode(x); return btoa(s);
  });
  if (b64) {
    fs.writeFileSync(`${OUT}/_v1.webm`, Buffer.from(b64, 'base64'));
    [chooser] = await Promise.all([a.waitForFileChooser(), clickText(a, '.live .lc-actions .btn', 'Video')]);
    await chooser.accept([`${OUT}/_v1.webm`]);
    await waitFor(a, () => window.__wf.state.tripData.tripMediaUi01.media.some((m) => m.kind === 'video') && !(window.__wf.state.uploads.tripMediaUi01 || []).length, null, { label: 'Video hochgeladen' });
    const v = await a.evaluate(() => window.__wf.state.tripData.tripMediaUi01.media.find((m) => m.kind === 'video'));
    assert.equal(v.mime, 'video/webm');
    ok(`Video hochgeladen (${v.duration ? v.duration.toFixed(1) + ' s' : 'ohne Länge'}, Vorschaubild: ${v.thumb ? 'ja' : 'nein'})`);
  } else console.log('  – Video-Test übersprungen (kein MediaRecorder)');

  // Zu groß: Video über dem Limit wird freundlich abgelehnt
  await a.evaluate(() => { window.__wf.state.config.maxVideoBytes = 1000; });
  fs.writeFileSync(`${OUT}/_big.webm`, Buffer.alloc(5000, 1));
  [chooser] = await Promise.all([a.waitForFileChooser(), clickText(a, '.live .lc-actions .btn', 'Video')]);
  await chooser.accept([`${OUT}/_big.webm`]);
  await waitFor(a, () => /zu groß/.test(document.querySelector('.toast.error')?.textContent || ''), null, { label: 'Hinweis „zu groß“' });
  await a.evaluate(() => { window.__wf.state.config.maxVideoBytes = 100 * 1048576; });
  ok('Zu großes Video wird mit Hinweis abgelehnt');

  // Offline fotografieren: Warteschlange, danach automatisch hochladen
  await a.setOfflineMode(true);
  await a.evaluate(() => window.dispatchEvent(new Event('offline')));
  await waitFor(a, () => window.__wf.state.conn === 'offline', null, { label: 'offline' });
  const jpg2 = await makePhoto(`${OUT}/_p2.jpg`, 200);
  [chooser] = await Promise.all([a.waitForFileChooser(), clickText(a, '.live .lc-actions .btn', 'Foto')]);
  await chooser.accept([jpg2]);
  await waitFor(a, () => (window.__wf.state.uploads.tripMediaUi01 || []).length === 1, null, { label: 'Upload wartet' });
  await waitFor(a, () => document.querySelector('.live .thumb.pending .up'), null, { label: 'wartende Vorschau' });
  const kept = await a.evaluate(async () => (await import('/js/idb.js')).idbKeys('blobs'));
  assert.ok(kept.some((k) => String(k).startsWith('up:')), 'Datei liegt in IndexedDB');
  await sleep(300);
  await shot(a, 'm05-offline-warteschlange');
  await a.setOfflineMode(false);
  await a.evaluate(() => window.dispatchEvent(new Event('online')));
  await waitFor(a, () => window.__wf.state.tripData.tripMediaUi01.media.length >= 3 && !(window.__wf.state.uploads.tripMediaUi01 || []).length, null, { label: 'Warteschlange abgearbeitet', timeout: 20000 });
  assert.equal(await a.evaluate(async () => (await (await import('/js/idb.js')).idbKeys('blobs')).filter((k) => String(k).startsWith('up:')).length), 0);
  ok('Offline aufgenommen, in der Warteschlange gesichert, nach Netz automatisch hochgeladen');

  // Stopp-Details zeigen die Medien
  await clickText(a, '.live .lc-head', 'Hallstatt');
  await waitFor(a, () => document.querySelector('.sheet .stop-media'), null, { label: 'Stopp-Details' });
  await sleep(400);
  await shot(a, 'm06-stopp-medien');
  await a.evaluate(() => history.back());
  await waitFor(a, () => !document.querySelector('.sheet'), null, { label: 'Sheet zu' });

  // Rückblick
  await a.evaluate((id) => window.__wf.navigate('/t/' + id + '/story'), tripId);
  await waitFor(a, () => document.querySelector('.story .tl-item'), null, { label: 'Zeitleiste' });
  await sleep(600);
  await shot(a, 'm07-rueckblick');
  const sections = await a.$$eval('.story .tl-item', (n) => n.length);
  assert.ok(sections >= 2);
  await clickText(a, '.story-seg .seg button', 'Galerie');
  await waitFor(a, () => document.querySelector('.story .gallery .thumb'), null, { label: 'Galerie' });
  await sleep(400);
  await shot(a, 'm08-galerie');
  await click(a, '.story .gallery .thumb');
  await waitFor(a, () => document.querySelector('.lightbox .lb-count')?.textContent.startsWith('1 /'), null, { label: 'Vollbild aus Galerie' });
  await a.tap('.lightbox .icon-btn[aria-label="Schließen"]');
  ok('Rückblick: Zeitleiste und Galerie, Vollbild');

  // Dunkelmodus
  await a.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);
  await sleep(500);
  await clickText(a, '.story-seg .seg button', 'Zeitleiste');
  await sleep(400);
  await shot(a, 'm09-rueckblick-dunkel');
  await a.evaluate((id) => window.__wf.navigate('/t/' + id + '/live'), tripId);
  await sleep(900);
  await shot(a, 'm10-unterwegs-dunkel');
  ok('Dunkelmodus');

  errors.push(...P.errors);
} catch (e) {
  failed = e;
  console.error('FEHLER:', e.message);
  for (const p of await browser.pages()) { try { await p.screenshot({ path: `${OUT}/zz-fehler-${Math.random().toString(36).slice(2, 6)}.png` }); } catch {} }
} finally {
  await browser.close();
  await srv.app.close();
}
if (errors.length) { console.log('Konsolenfehler im Browser:'); errors.forEach((e) => console.log('  -', e)); }
process.exit(failed ? 1 : errors.length ? 2 : 0);
