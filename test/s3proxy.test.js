import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { LocalSqlite } from '../server/db.js';
import { createApp } from '../server/app.js';
import { S3Storage } from '../server/storage.js';
import { TestClient } from './helpers/ws-client.js';

// Kleiner Nachbau eines S3-Dienstes (Pfad-Stil, prüft nur, dass der Link signiert ist)
async function fakeS3() {
  const files = new Map();
  const log = [];
  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    log.push(`${req.method} ${u.pathname}`);
    if (!u.searchParams.get('X-Amz-Signature')) { res.writeHead(403); return res.end('unsigned'); }
    const key = decodeURIComponent(u.pathname);
    if (req.method === 'PUT') {
      const chunks = []; for await (const c of req) chunks.push(c);
      files.set(key, { data: Buffer.concat(chunks), type: req.headers['content-type'] });
      res.writeHead(200); return res.end();
    }
    const f = files.get(key);
    if (req.method === 'DELETE') { files.delete(key); res.writeHead(204); return res.end(); }
    if (!f) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Length': f.data.length, 'Content-Type': f.type });
    return res.end(req.method === 'HEAD' ? undefined : f.data);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, files, log, endpoint: `http://127.0.0.1:${server.address().port}` };
}

test('Upload über den eigenen Server: Rechte, Token, Größe, Durchreichen an den Speicher', async () => {
  const s3 = await fakeS3();
  const storage = new S3Storage({ endpoint: s3.endpoint, bucket: 'bkt', accessKey: 'AK', secretKey: 'SK', region: 'eu-central-003' });
  const app = await createApp({ db: new LocalSqlite(':memory:'), storage, log: () => {} });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const c = await new TestClient(base.replace('http', 'ws') + '/ws').connect();
  try {
    await c.register('Olli');
    const { trip } = await c.ok('trip.create', { id: 'tripProxy0001', title: 'Proxy' });
    const body = Buffer.from('jpeg-bytes-123');
    const m = { id: 'mediaProxy001', kind: 'image', mime: 'image/jpeg', bytes: body.length };
    const prep = await c.ok('media.prepare', { tripId: trip.id, media: m });
    assert.match(prep.put.url, /^\/api\/upload\//);

    // falscher Typ, manipuliertes Token, zu große Datei
    const put = (url, data, type = 'image/jpeg') => fetch(base + url, { method: 'PUT', headers: { 'Content-Type': type }, body: data });
    assert.equal((await put(prep.put.url, body, 'video/mp4')).status, 415);
    assert.equal((await put(prep.put.url.slice(0, -3) + 'xyz', body)).status, 403);
    const tiny = await c.ok('media.prepare', { tripId: trip.id, media: { ...m, id: 'mediaProxy002', bytes: 3 } });
    assert.ok(tiny.put.url);
    assert.equal(s3.files.size, 0, 'bisher nichts im Speicher');

    // erfolgreicher Upload landet im (nachgebauten) Speicher
    assert.equal((await put(prep.put.url, body)).status, 200);
    assert.equal(s3.files.get('/bkt/tripProxy0001/mediaProxy001.jpg').data.toString(), 'jpeg-bytes-123');
    const { media } = await c.ok('media.add', { tripId: trip.id, media: m });
    assert.match(media.url, /^http:\/\/127\.0\.0\.1:\d+\/bkt\/tripProxy0001\/mediaProxy001\.jpg\?.*X-Amz-Signature=/);
    const got = await fetch(media.url);
    assert.equal(await got.text(), 'jpeg-bytes-123');

    // Selbstprüfung und Löschen
    const diag = await storage.diagnose('x');
    assert.equal(diag.ok, true, JSON.stringify(diag));
    await c.ok('media.delete', { tripId: trip.id, mediaId: m.id });
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(s3.files.has('/bkt/tripProxy0001/mediaProxy001.jpg'), false);
  } finally {
    c.ws.close(); await app.close(); s3.server.close();
  }
});
