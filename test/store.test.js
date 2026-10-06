import test from 'node:test';
import assert from 'node:assert/strict';
import { LocalSqlite, migrate } from '../server/db.js';
import { Store } from '../server/store.js';

async function setup() {
  const db = new LocalSqlite(':memory:');
  await migrate(db);
  return { db, store: new Store(db) };
}

test('Benutzer registrieren, anmelden und per Code wiederherstellen', async () => {
  const { store } = await setup();
  const { user, secret, recoveryCode } = await store.registerUser('  Mia  ');
  assert.equal(user.name, 'Mia');
  assert.match(recoveryCode, /^[A-Z2-9]{4}(-[A-Z2-9]{4}){3}$/);
  assert.ok(await store.authDevice(user.id, secret));
  assert.equal(await store.authDevice(user.id, 'x'.repeat(64)), null);
  const rec = await store.recover(recoveryCode.toLowerCase().replace(/-/g, ' '));
  assert.equal(rec.user.id, user.id);
  assert.notEqual(rec.secret, secret);
  assert.ok(await store.authDevice(user.id, rec.secret));
  assert.ok(await store.authDevice(user.id, secret), 'altes Gerät bleibt gültig');
  await assert.rejects(() => store.recover('AAAA-AAAA-AAAA-AAAA'), /nicht bekannt/);
  await assert.rejects(() => store.registerUser('   '), /Name fehlt/);
});

test('neuer Wiederherstellungs-Code macht den alten ungültig', async () => {
  const { store } = await setup();
  const { user, recoveryCode } = await store.registerUser('Ben');
  const fresh = await store.regenerateRecoveryCode(user.id);
  await assert.rejects(() => store.recover(recoveryCode));
  assert.equal((await store.recover(fresh)).user.id, user.id);
});

test('Reise anlegen ist idempotent und prüft Daten', async () => {
  const { store } = await setup();
  const { user } = await store.registerUser('Mia');
  const a = await store.createTrip(user.id, { id: 'trip-aaaa1111', title: 'Alpen', start_date: '2026-07-01', end_date: '2026-07-10' });
  assert.equal(a.created, true);
  const b = await store.createTrip(user.id, { id: 'trip-aaaa1111', title: 'Doppelt' });
  assert.equal(b.created, false);
  assert.equal(b.trip.title, 'Alpen');
  await assert.rejects(() => store.createTrip(user.id, { title: 'X', start_date: '2026-07-10', end_date: '2026-07-01' }), /Ende liegt vor/);
  await assert.rejects(() => store.createTrip(user.id, { title: 'X', start_date: '2026-02-31' }), /Startdatum/);
  await assert.rejects(() => store.createTrip(user.id, { title: '' }), /Reisename/);
  const list = await store.listTrips(user.id);
  assert.equal(list.length, 1);
  assert.equal(list[0].role, 'owner');
  assert.equal(list[0].members[0].name, 'Mia');
});

test('Stopps: anlegen, ändern, umsortieren, löschen, abhaken', async () => {
  const { store } = await setup();
  const { user } = await store.registerUser('Mia');
  const { trip } = await store.createTrip(user.id, { title: 'Küste' });
  const mk = (name, lat, lon) => store.createStop(user.id, trip.id, { name, lat, lon });
  const a = await mk('Hamburg', 53.55, 10);
  const b = await mk('Kiel', 54.32, 10.13);
  const c = await mk('Flensburg', 54.78, 9.43);
  assert.deepEqual([a.position, b.position, c.position], [0, 1, 2]);

  const again = await store.createStop(user.id, trip.id, { id: a.id, name: 'Egal', lat: 1, lon: 1 });
  assert.equal(again.name, 'Hamburg');

  const upd = await store.updateStop(user.id, trip.id, b.id, { description: 'Hafen', notes: 'Fischbrötchen', planned_date: '2026-08-02' });
  assert.equal(upd.description, 'Hafen');
  assert.equal(upd.planned_date, '2026-08-02');
  assert.equal(upd.name, 'Kiel');

  const moved = await store.updateStop(user.id, trip.id, b.id, { lat: 54.4, lon: 10.2 });
  assert.equal(moved.lat, 54.4);
  await assert.rejects(() => store.updateStop(user.id, trip.id, b.id, { lat: 200, lon: 0 }), /Koordinaten/);

  const order = await store.reorderStops(user.id, trip.id, [c.id, a.id, 'unbekannt1', c.id]);
  assert.deepEqual(order.ids, [c.id, a.id, b.id]);
  let snap = await store.openTrip(user.id, trip.id);
  assert.deepEqual(snap.stops.map((s) => s.name), ['Flensburg', 'Hamburg', 'Kiel']);

  const v = await store.setVisited(user.id, trip.id, a.id, true);
  assert.ok(v.visited_at);
  assert.equal(v.visited_by, user.id);
  const v2 = await store.setVisited(user.id, trip.id, a.id, false);
  assert.equal(v2.visited_at, null);

  await store.deleteStop(user.id, trip.id, b.id);
  snap = await store.openTrip(user.id, trip.id);
  assert.equal(snap.stops.length, 2);
});

test('Rollen: Mitbearbeiter dürfen Stopps, Ansehende nicht, Fremde gar nichts', async () => {
  const { store } = await setup();
  const owner = (await store.registerUser('Olli')).user;
  const editor = (await store.registerUser('Edda')).user;
  const viewer = (await store.registerUser('Vera')).user;
  const stranger = (await store.registerUser('Fritz')).user;
  const { trip } = await store.createTrip(owner.id, { title: 'Gemeinsam' });

  const invites = await store.ensureInvite(owner.id, trip.id, 'editor');
  const vInvites = await store.ensureInvite(owner.id, trip.id, 'viewer');
  assert.equal(invites.length, 1);
  assert.equal(vInvites.length, 2);
  const again = await store.ensureInvite(owner.id, trip.id, 'editor');
  assert.equal(again.find((i) => i.role === 'editor').token, invites[0].token, 'gleicher Link bleibt bestehen');

  const eTok = invites[0].token;
  const vTok = vInvites.find((i) => i.role === 'viewer').token;
  assert.equal((await store.peekInvite(eTok)).title, 'Gemeinsam');
  assert.equal((await store.acceptInvite(editor.id, eTok)).role, 'editor');
  assert.equal((await store.acceptInvite(viewer.id, vTok)).role, 'viewer');
  assert.equal((await store.acceptInvite(viewer.id, eTok)).role, 'viewer', 'bestehende Rolle bleibt');

  const stop = await store.createStop(editor.id, trip.id, { name: 'Start', lat: 50, lon: 8 });
  await assert.rejects(() => store.createStop(viewer.id, trip.id, { name: 'Nein', lat: 50, lon: 8 }), /Berechtigung/);
  await assert.rejects(() => store.updateStop(viewer.id, trip.id, stop.id, { name: 'Nein' }), /Berechtigung/);
  await assert.rejects(() => store.deleteStop(viewer.id, trip.id, stop.id), /Berechtigung/);
  await assert.rejects(() => store.openTrip(stranger.id, trip.id), /Zugriff/);
  await assert.rejects(() => store.createStop(stranger.id, trip.id, { name: 'Nein', lat: 50, lon: 8 }), /Zugriff/);
  await assert.rejects(() => store.updateTrip(editor.id, trip.id, { title: 'Neu' }), /Berechtigung/);
  await assert.rejects(() => store.ensureInvite(editor.id, trip.id, 'editor'), /Berechtigung/);
  await assert.rejects(() => store.deleteTrip(editor.id, trip.id), /Berechtigung/);

  const snapViewer = await store.openTrip(viewer.id, trip.id);
  assert.equal(snapViewer.role, 'viewer');
  assert.equal(snapViewer.invites, undefined, 'Ansehende sehen keine Links');
  const snapOwner = await store.openTrip(owner.id, trip.id);
  assert.equal(snapOwner.invites.length, 2);

  // Rollen ändern und Personen entfernen
  const res = await store.setMemberRole(owner.id, trip.id, viewer.id, 'editor');
  assert.equal(res.members.find((m) => m.id === viewer.id).role, 'editor');
  await store.createStop(viewer.id, trip.id, { name: 'Jetzt darf ich', lat: 51, lon: 9 });
  await assert.rejects(() => store.setMemberRole(owner.id, trip.id, owner.id, 'viewer'), /Besitzers/);
  await assert.rejects(() => store.removeMember(owner.id, trip.id, owner.id), /Besitzer/);
  await store.removeMember(owner.id, trip.id, editor.id);
  await assert.rejects(() => store.openTrip(editor.id, trip.id), /Zugriff/);
  await assert.rejects(() => store.leaveTrip(owner.id, trip.id), /Besitzer/);
  await store.leaveTrip(viewer.id, trip.id);
  assert.equal((await store.listTrips(viewer.id)).length, 0);
});

test('Einladungslink zurücksetzen macht den alten ungültig', async () => {
  const { store } = await setup();
  const owner = (await store.registerUser('Olli')).user;
  const guest = (await store.registerUser('Gast')).user;
  const { trip } = await store.createTrip(owner.id, { title: 'Rund' });
  const [first] = await store.ensureInvite(owner.id, trip.id, 'viewer');
  const fresh = await store.ensureInvite(owner.id, trip.id, 'viewer', { reset: true });
  assert.equal(fresh.length, 1);
  assert.notEqual(fresh[0].token, first.token);
  await assert.rejects(() => store.acceptInvite(guest.id, first.token), /nicht mehr gültig/);
  await assert.rejects(() => store.peekInvite('kurz'), /nicht mehr gültig/);
  assert.equal((await store.acceptInvite(guest.id, fresh[0].token)).joined, true);
  const left = await store.revokeInvite(owner.id, trip.id, 'viewer');
  assert.equal(left.length, 0);
});

test('Titelbild speichern, lesen, entfernen; Größenlimit', async () => {
  const { store } = await setup();
  const owner = (await store.registerUser('Olli')).user;
  const { trip } = await store.createTrip(owner.id, { title: 'Bild' });
  assert.equal(await store.getCover(trip.id), null);
  const bytes = Buffer.from('fake-jpeg-data');
  const t = await store.setCover(owner.id, trip.id, bytes.toString('base64'), 'image/jpeg');
  assert.equal(t.has_cover, true);
  assert.equal(t.cover_version, 1);
  const c = await store.getCover(trip.id);
  assert.equal(c.data.toString(), 'fake-jpeg-data');
  assert.equal(c.type, 'image/jpeg');
  await assert.rejects(() => store.setCover(owner.id, trip.id, Buffer.alloc(500 * 1024).toString('base64'), 'image/jpeg'), /zu groß/);
  await assert.rejects(() => store.setCover(owner.id, trip.id, bytes.toString('base64'), 'text/html'), /Bildformat/);
  const removed = await store.updateTrip(owner.id, trip.id, { remove_cover: true });
  assert.equal(removed.has_cover, false);
  assert.equal(await store.getCover(trip.id), null);
});

test('Reise löschen entfernt alles', async () => {
  const { store, db } = await setup();
  const owner = (await store.registerUser('Olli')).user;
  const { trip } = await store.createTrip(owner.id, { title: 'Weg' });
  await store.createStop(owner.id, trip.id, { name: 'A', lat: 1, lon: 1 });
  await store.ensureInvite(owner.id, trip.id, 'editor');
  await store.deleteTrip(owner.id, trip.id);
  for (const table of ['trips', 'stops', 'members', 'invites']) {
    const r = await db.execute(`SELECT COUNT(*) AS n FROM ${table}`);
    assert.equal(r.rows[0].n, 0, table);
  }
});

test('Limits: zu viele Stopps und ungültige Eingaben', async () => {
  const { store } = await setup();
  const owner = (await store.registerUser('Olli')).user;
  const { trip } = await store.createTrip(owner.id, { title: 'Viel' });
  await assert.rejects(() => store.createStop(owner.id, trip.id, { name: 'x'.repeat(200), lat: 1, lon: 1 }), /zu lang/);
  await assert.rejects(() => store.createStop(owner.id, trip.id, { name: 'A', lat: 'abc', lon: 1 }), /Koordinaten/);
  await assert.rejects(() => store.createStop(owner.id, trip.id, { id: 'a b', name: 'A', lat: 1, lon: 1 }), /Stopp-ID/);
  await assert.rejects(() => store.createStop(owner.id, trip.id, { name: 'A', lat: 1, lon: 1, planned_date: 'morgen' }), /Datum/);
});
