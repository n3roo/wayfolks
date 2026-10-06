import test from 'node:test';
import assert from 'node:assert/strict';
import { LocalSqlite } from '../server/db.js';
import { createApp } from '../server/app.js';
import { DevStorage } from '../server/storage.js';
import { TestClient } from './helpers/ws-client.js';

async function boot(storage = new DevStorage()) {
  const app = await createApp({ db: new LocalSqlite(':memory:'), storage, log: () => {} });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const clients = [];
  const client = async (name) => {
    const c = await new TestClient(base.replace('http', 'ws') + '/ws').connect();
    clients.push(c); await c.register(name); return c;
  };
  return { app, base, client, done: async () => { clients.forEach((c) => c.close()); await app.close(); } };
}

const JPEG = Buffer.from('ffd8ffe000104a46494600010100000100010000ffd9', 'hex');
async function upload(base, url, body, type) {
  const r = await fetch(base + url, { method: 'PUT', headers: { 'Content-Type': type }, body });
  assert.equal(r.status, 200);
}

test('Medien: hochladen, live verteilen, Rechte, Stopp löschen behält Foto, Reise löschen räumt auf', async () => {
  const t = await boot();
  try {
    const owner = await t.client('Olli');
    const editor = await t.client('Edi');
    const viewer = await t.client('Vera');
    const { trip } = await owner.ok('trip.create', { id: 'tripMedia001', title: 'Foto-Reise' });
    await owner.ok('trip.open', { tripId: trip.id });
    const { stop } = await owner.ok('stop.create', { tripId: trip.id, stop: { id: 'stopMedia001', name: 'Hallstatt', lat: 47.56, lon: 13.65 } });
    const ei = (await owner.ok('invite.ensure', { tripId: trip.id, role: 'editor' })).invites.find((i) => i.role === 'editor');
    const vi = (await owner.ok('invite.ensure', { tripId: trip.id, role: 'viewer' })).invites.find((i) => i.role === 'viewer');
    await editor.ok('invite.accept', { token: ei.token });
    await viewer.ok('invite.accept', { token: vi.token });
    await editor.ok('trip.open', { tripId: trip.id });
    await viewer.ok('trip.open', { tripId: trip.id });

    // Konfiguration kommt mit dem Willkommen
    assert.equal(t.app.store.clientConfig().media, true);

    // Vorbereiten + Hochladen + Eintragen
    const m = { id: 'mediaAAAAAA01', kind: 'image', mime: 'image/jpeg', bytes: JPEG.length, thumb: true };
    const prep = await editor.ok('media.prepare', { tripId: trip.id, media: m });
    assert.ok(prep.put.url.startsWith('/dev-media/tripMedia001/mediaAAAAAA01.jpg'));
    // Vor dem Hochladen darf nichts eingetragen werden
    const early = await editor.op('media.add', { tripId: trip.id, media: { ...m, stop_id: stop.id } });
    assert.equal(early.ok, false); assert.equal(early.code, 'upload_missing');
    await upload(t.base, prep.put.url, JPEG, 'image/jpeg');
    await upload(t.base, prep.thumb.url, JPEG, 'image/jpeg');
    const { media } = await editor.ok('media.add', { tripId: trip.id, media: { ...m, stop_id: stop.id, width: 800, height: 600, taken_at: '2026-10-01T10:00:00Z' } });
    assert.equal(media.stop_id, stop.id);
    assert.ok(media.thumb);
    // Wiederholung ist unschädlich
    const again = await editor.ok('media.add', { tripId: trip.id, media: { ...m, stop_id: stop.id } });
    assert.equal(again.media.id, media.id);
    // Datei ist abrufbar
    const got = await fetch(t.base + media.url);
    assert.equal(got.status, 200);
    assert.equal(Buffer.compare(Buffer.from(await got.arrayBuffer()), JPEG), 0);

    // Andere sehen es live
    const ev = await viewer.wait((x) => x.t === 'ev' && x.k === 'media');
    assert.equal(ev.v.media.id, media.id);
    const snap = await viewer.ok('trip.open', { tripId: trip.id });
    assert.equal(snap.media.length, 1);

    // Rechte: Betrachter darf nichts hinzufügen oder löschen
    assert.equal((await viewer.op('media.prepare', { tripId: trip.id, media: m })).code, 'forbidden');
    assert.equal((await viewer.op('media.delete', { tripId: trip.id, mediaId: media.id })).ok, false);
    // Format- und Größenprüfung
    assert.equal((await editor.op('media.prepare', { tripId: trip.id, media: { id: 'mediaBBBBBB02', kind: 'video', mime: 'video/mp4', bytes: 101 * 1024 * 1024 } })).code, 'too_large');
    assert.equal((await editor.op('media.prepare', { tripId: trip.id, media: { id: 'mediaBBBBBB02', kind: 'image', mime: 'text/html', bytes: 10 } })).code, 'invalid');

    // Bildunterschrift ändern
    const upd = await editor.ok('media.update', { tripId: trip.id, mediaId: media.id, patch: { caption: 'Seeblick' } });
    assert.equal(upd.media.caption, 'Seeblick');

    // Fremdes Foto kann ein Mitbearbeiter nicht löschen, die Besitzerin schon
    const m2 = { id: 'mediaCCCCCC03', kind: 'video', mime: 'video/mp4', bytes: 4 };
    const p2 = await owner.ok('media.prepare', { tripId: trip.id, media: m2 });
    await upload(t.base, p2.put.url, Buffer.from('mp4!'), 'video/mp4');
    await owner.ok('media.add', { tripId: trip.id, media: m2, duration: 12.5 });
    assert.equal((await editor.op('media.delete', { tripId: trip.id, mediaId: m2.id })).code, 'forbidden');

    // Stopp löschen: Foto bleibt, ohne Stopp
    await owner.ok('stop.delete', { tripId: trip.id, stopId: stop.id });
    const after = await owner.ok('trip.open', { tripId: trip.id });
    assert.equal(after.media.find((x) => x.id === media.id).stop_id, null);

    // Löschen entfernt auch die Datei
    await owner.ok('media.delete', { tripId: trip.id, mediaId: m2.id });
    assert.equal((await fetch(t.base + `/dev-media/tripMedia001/${m2.id}.mp4`)).status, 404);
    await owner.ok('trip.delete', { tripId: trip.id });
    assert.equal((await fetch(t.base + media.url)).status, 404);
  } finally { await t.done(); }
});

test('Ohne Speicher: Hochladen wird freundlich abgelehnt, App läuft weiter', async () => {
  const t = await boot(null);
  try {
    const o = await t.client('Olli');
    const { trip } = await o.ok('trip.create', { id: 'tripNoStore01', title: 'Ohne' });
    const r = await o.op('media.prepare', { tripId: trip.id, media: { id: 'mediaDDDDDD04', kind: 'image', mime: 'image/jpeg', bytes: 10 } });
    assert.equal(r.code, 'no_storage');
    const snap = await o.ok('trip.open', { tripId: trip.id });
    assert.deepEqual(snap.media, []);
  } finally { await t.done(); }
});
