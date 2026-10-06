import test from 'node:test';
import assert from 'node:assert/strict';
import { TursoHttp, migrate } from '../server/db.js';
import { Store } from '../server/store.js';
import { startFakeTurso } from './helpers/fake-turso.js';

test('Turso-Client: Werte, Blobs, Transaktionen und Rollback', async () => {
  const fake = await startFakeTurso();
  try {
    const db = new TursoHttp({ url: fake.url.replace('http://', 'libsql://'), token: fake.token, fetchImpl: (u, o) => fetch(u.replace('https://', 'http://'), o) });
    await db.execute('CREATE TABLE t (id TEXT PRIMARY KEY, n INTEGER, f REAL, b BLOB, s TEXT)');
    await db.execute('INSERT INTO t VALUES(?,?,?,?,?)', ['a', 42, 1.5, Buffer.from([1, 2, 3]), null]);
    const r = await db.execute('SELECT * FROM t WHERE id = ?', ['a']);
    assert.equal(r.rows[0].n, 42);
    assert.equal(r.rows[0].f, 1.5);
    assert.deepEqual([...r.rows[0].b], [1, 2, 3]);
    assert.equal(r.rows[0].s, null);

    await assert.rejects(() => db.batch([
      ['INSERT INTO t(id, n) VALUES(?,?)', ['b', 1]],
      ['INSERT INTO t(id, n) VALUES(?,?)', ['a', 2]], // Duplikat → ganze Transaktion zurückrollen
    ]), /SQL-Fehler/);
    const after = await db.execute('SELECT COUNT(*) AS n FROM t');
    assert.equal(after.rows[0].n, 1, 'Rollback hat funktioniert');

    const ok = await db.batch([
      ['INSERT INTO t(id, n) VALUES(?,?)', ['c', 3]],
      ['UPDATE t SET n = n + 1 WHERE id = ?', ['c']],
    ]);
    assert.equal(ok.length, 2);
    assert.equal(ok[1].changes, 1);

    const bad = new TursoHttp({ url: fake.url, token: 'falsch', fetchImpl: fetch });
    await assert.rejects(() => bad.execute('SELECT 1'), /401/);
    const down = new TursoHttp({ url: 'http://127.0.0.1:1', token: 'x', fetchImpl: fetch });
    await assert.rejects(() => down.execute('SELECT 1'), /nicht erreichbar/);
  } finally { await fake.close(); }
});

test('Die ganze Fachlogik läuft auch über den Turso-Client', async () => {
  const fake = await startFakeTurso();
  try {
    const db = new TursoHttp({ url: fake.url, token: fake.token });
    assert.equal(await migrate(db), 1);
    assert.equal(await migrate(db), 1, 'zweiter Lauf ändert nichts');
    const store = new Store(db);
    const { user, secret } = await store.registerUser('Turso-Tina');
    assert.ok(await store.authDevice(user.id, secret));
    const { trip } = await store.createTrip(user.id, { title: 'Über HTTP', start_date: '2026-09-01' });
    const jpeg = Buffer.from([0xff, 0xd8, 1, 2, 3, 0xff, 0xd9]);
    await store.setCover(user.id, trip.id, jpeg.toString('base64'), 'image/jpeg');
    assert.deepEqual([...(await store.getCover(trip.id)).data], [...jpeg]);
    const a = await store.createStop(user.id, trip.id, { name: 'A', lat: 48.1, lon: 11.5 });
    const b = await store.createStop(user.id, trip.id, { name: 'B', lat: 47.9, lon: 12.1 });
    await store.reorderStops(user.id, trip.id, [b.id, a.id]);
    const snap = await store.openTrip(user.id, trip.id);
    assert.deepEqual(snap.stops.map((s) => s.name), ['B', 'A']);
    const list = await store.listTrips(user.id);
    assert.equal(list[0].stop_count, 2);
    assert.equal(list[0].has_cover, true);
  } finally { await fake.close(); }
});
