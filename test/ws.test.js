import test from 'node:test';
import assert from 'node:assert/strict';
import { LocalSqlite } from '../server/db.js';
import { createApp } from '../server/app.js';
import { TestClient } from './helpers/ws-client.js';

async function boot() {
  const db = new LocalSqlite(':memory:');
  const app = await createApp({ db, log: () => {} });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const port = app.server.address().port;
  const clients = [];
  const client = async (name) => {
    const c = await new TestClient(`ws://127.0.0.1:${port}/ws`).connect();
    clients.push(c);
    if (name) await c.register(name);
    return c;
  };
  return { app, port, client, base: `http://127.0.0.1:${port}`, done: async () => { clients.forEach((c) => c.close()); await app.close(); } };
}

test('Live-Zusammenarbeit: Änderungen kommen bei allen an, Rechte gelten', async () => {
  const t = await boot();
  try {
    const owner = await t.client('Olli');
    const guest = await t.client('Gina');
    const { trip } = await owner.ok('trip.create', { id: 'tripLive0001', title: 'Live-Reise' });
    const snap = await owner.ok('trip.open', { tripId: trip.id });
    assert.equal(snap.role, 'owner');
    assert.deepEqual(snap.online, [owner.user.id]);

    const { invites } = await owner.ok('invite.ensure', { tripId: trip.id, role: 'editor' });
    const { invites: vinv } = await owner.ok('invite.ensure', { tripId: trip.id, role: 'viewer' });
    assert.equal(vinv.length, 2);

    // Vorschau ohne Anmeldung
    const anon = await t.client();
    anon.send({ t: 'peek', id: 'p1', token: invites[0].token });
    const peek = await anon.wait((m) => m.t === 'ack' && m.id === 'p1');
    assert.equal(peek.ok, true);
    assert.equal(peek.result.title, 'Live-Reise');
    assert.equal(peek.result.owner_name, 'Olli');

    const joined = await guest.ok('invite.accept', { token: invites[0].token });
    assert.equal(joined.tripId, trip.id);
    const ev = await owner.wait((m) => m.t === 'ev' && m.k === 'members');
    assert.equal(ev.v.members.length, 2);

    const gsnap = await guest.ok('trip.open', { tripId: trip.id });
    assert.equal(gsnap.role, 'editor');
    const pres = await owner.wait((m) => m.t === 'ev' && m.k === 'presence' && m.v.online.length === 2);
    assert.equal(pres.v.online.length, 2);

    // Gast legt Stopp an → Besitzer sieht ihn live
    const created = await guest.ok('stop.create', { tripId: trip.id, stop: { id: 'stopLive0001', name: 'Brenner', lat: 47.0, lon: 11.5 } });
    assert.equal(created.stop.name, 'Brenner');
    const e1 = await owner.event('stop');
    assert.equal(e1.v.stop.id, 'stopLive0001');

    // Besitzer ändert → Gast sieht
    await owner.ok('stop.update', { tripId: trip.id, stopId: 'stopLive0001', patch: { notes: 'Pass-Gebühr beachten' } });
    const e2 = await guest.event('stop');
    assert.equal(e2.v.stop.notes, 'Pass-Gebühr beachten');

    // Sortierung
    await owner.ok('stop.create', { tripId: trip.id, stop: { id: 'stopLive0002', name: 'Verona', lat: 45.4, lon: 10.99 } });
    await guest.event('stop');
    await owner.ok('stop.reorder', { tripId: trip.id, ids: ['stopLive0002', 'stopLive0001'] });
    const e3 = await guest.event('stops.order');
    assert.deepEqual(e3.v.ids, ['stopLive0002', 'stopLive0001']);

    // Rolle auf "nur ansehen" → Schreiben schlägt fehl
    await owner.ok('member.role', { tripId: trip.id, userId: guest.user.id, role: 'viewer' });
    await guest.event('resync');
    const denied = await guest.op('stop.create', { tripId: trip.id, stop: { name: 'Nein', lat: 1, lon: 1 } });
    assert.equal(denied.ok, false);
    assert.equal(denied.code, 'forbidden');

    // Entfernen → Gast wird informiert
    await owner.ok('member.remove', { tripId: trip.id, userId: guest.user.id });
    const gone = await guest.event('gone');
    assert.equal(gone.v.reason, 'removed');
    const nope = await guest.op('trip.open', { tripId: trip.id });
    assert.equal(nope.ok, false);
    assert.equal(nope.code, 'not_found');

    // Löschen
    await owner.ok('trip.delete', { tripId: trip.id });
    const list = await owner.ok('trips.list', {});
    assert.equal(list.trips.length, 0);
  } finally { await t.done(); }
});

test('Anmeldung: falsches Geheimnis, Wiederherstellung auf neuem Gerät', async () => {
  const t = await boot();
  try {
    const a = await t.client('Anna');
    await a.ok('trip.create', { id: 'tripAuth0001', title: 'Meine Reise' });

    const bad = await t.client();
    bad.send({ t: 'hello', userId: a.creds.userId, secret: 'f'.repeat(64) });
    await bad.wait((m) => m.t === 'auth_failed');
    const noauth = await bad.op('trips.list', {});
    assert.equal(noauth.ok, false);
    assert.equal(noauth.code, 'auth');

    const fresh = await t.client();
    fresh.send({ t: 'recover', code: 'AAAA-BBBB-CCCC-DDDD' });
    const err = await fresh.wait((m) => m.t === 'auth_error');
    assert.match(err.message, /nicht bekannt/);

    fresh.send({ t: 'recover', code: a.recoveryCode });
    const rec = await fresh.wait((m) => m.t === 'recovered');
    assert.equal(rec.user.id, a.user.id);
    fresh.send({ t: 'hello', userId: rec.user.id, secret: rec.secret });
    const welcome = await fresh.wait((m) => m.t === 'welcome');
    assert.equal(welcome.trips.length, 1);
    assert.equal(welcome.trips[0].title, 'Meine Reise');
  } finally { await t.done(); }
});

test('Profiländerung erreicht Mitreisende, Reiseliste wird nachgeschoben', async () => {
  const t = await boot();
  try {
    const o = await t.client('Olli');
    const g = await t.client('Gina');
    const { trip } = await o.ok('trip.create', { id: 'tripProf0001', title: 'Profil' });
    const { invites } = await o.ok('invite.ensure', { tripId: trip.id, role: 'viewer' });
    await g.ok('invite.accept', { token: invites[0].token });
    await o.ok('trip.open', { tripId: trip.id });
    await g.ok('profile.update', { name: 'Gina Neu', color: '#0B7285' });
    const ev = await o.event('members');
    assert.ok(ev.v.members.some((m) => m.name === 'Gina Neu' && m.color === '#0B7285'));
    const pushed = await g.wait((m) => m.t === 'trips', 4000);
    assert.equal(pushed.trips[0].title, 'Profil');
  } finally { await t.done(); }
});

test('HTTP: Health, Titelbild, Einladungsseite mit Vorschau, SPA-Fallback', async () => {
  const t = await boot();
  try {
    const health = await (await fetch(t.base + '/api/health')).json();
    assert.equal(health.ok, true);
    assert.equal(health.db, 'sqlite');

    const o = await t.client('Olli');
    const { trip } = await o.ok('trip.create', { id: 'tripHttp0001', title: 'Bunt & <Wild>' });
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
    await o.ok('trip.cover', { tripId: trip.id, data: jpeg.toString('base64'), type: 'image/jpeg' });
    const cover = await fetch(`${t.base}/api/cover/${trip.id}?v=1`);
    assert.equal(cover.status, 200);
    assert.equal(cover.headers.get('content-type'), 'image/jpeg');
    assert.deepEqual(Buffer.from(await cover.arrayBuffer()), jpeg);
    assert.equal((await fetch(`${t.base}/api/cover/doesnotexist1`)).status, 404);

    const { invites } = await o.ok('invite.ensure', { tripId: trip.id, role: 'editor' });
    const page = await (await fetch(`${t.base}/j/${invites[0].token}`)).text();
    assert.match(page, /og:title" content="Du bist zu „Bunt &amp; &lt;Wild&gt;“ eingeladen"/);
    assert.match(page, /og:image/);
    assert.doesNotMatch(page, /<!--OG-->/);

    const bad = await (await fetch(`${t.base}/j/ungueltig`)).text();
    assert.match(bad, /Einladung zu Wayfolk/);

    const spa = await fetch(`${t.base}/t/irgendwas/plan`);
    assert.equal(spa.status, 200);
    assert.match(spa.headers.get('content-type'), /text\/html/);
    assert.equal((await fetch(`${t.base}/nicht-da.js`)).status, 404);
    assert.equal((await fetch(`${t.base}/../server/db.js`)).status, 404); // Server-Code ist nie erreichbar
    const leak = await (await fetch(`${t.base}/..%2fserver%2fdb.js`)).text();
    assert.doesNotMatch(leak, /TursoHttp/);
    const sw = await (await fetch(t.base + '/sw.js')).text();
    assert.doesNotMatch(sw, /__BUILD__|__PRECACHE__/);
  } finally { await t.done(); }
});
