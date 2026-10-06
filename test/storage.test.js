import test from 'node:test';
import assert from 'node:assert/strict';
import { presign, S3Storage } from '../server/storage.js';

test('SigV4: AWS-Referenzbeispiel (vorsignierte GET-URL) stimmt', () => {
  const { signature, url } = presign({
    method: 'GET', host: 'examplebucket.s3.amazonaws.com', path: '/test.txt', region: 'us-east-1',
    accessKey: 'AKIAIOSFODNN7EXAMPLE', secretKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    now: new Date('2013-05-24T00:00:00Z'), expires: 86400,
  });
  assert.equal(signature, 'aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404');
  assert.match(url, /X-Amz-SignedHeaders=host&/);
});

test('S3/B2: PUT-Link enthält Bucket-Pfad und signiert Content-Type', () => {
  const r2 = new S3Storage({ mode: 'direct', endpoint: 's3.eu-central-003.backblazeb2.com', bucket: 'wayfolk-media', accessKey: 'AK', secretKey: 'SK', publicUrl: 'https://pub-1.example.com/' });
  const { url, headers } = r2.presignPut('trip1/m1.jpg', 'image/jpeg');
  assert.match(url, /^https:\/\/s3\.eu-central-003\.backblazeb2\.com\/wayfolk-media\/trip1\/m1\.jpg\?/);
  assert.match(url, /X-Amz-SignedHeaders=content-type%3Bhost/);
  assert.match(url, /%2Feu-central-003%2Fs3%2Faws4_request/);
  assert.equal(headers['Content-Type'], 'image/jpeg');
  assert.equal(r2.publicUrl('trip1/m1.jpg'), 'https://pub-1.example.com/trip1/m1.jpg');
});

test('S3/B2 privat: Lese-Links sind signiert, 7 Tage gültig und am selben Tag identisch', () => {
  const st = new S3Storage({ endpoint: 's3.eu-central-003.backblazeb2.com', bucket: 'b', accessKey: 'AK', secretKey: 'SK' });
  const u1 = st.publicUrl('trip/m.jpg');
  assert.match(u1, /^https:\/\/s3\.eu-central-003\.backblazeb2\.com\/b\/trip\/m\.jpg\?.*X-Amz-Expires=604800.*X-Amz-Signature=/);
  assert.equal(st.publicUrl('trip/m.jpg'), u1);
});

test('Selbstprüfung (Proxy-Modus): Schreibtest und Zugangsdaten werden geprüft', async () => {
  const mk = (head, put) => new S3Storage({ endpoint: 's3.x.backblazeb2.com', bucket: 'b', accessKey: 'AK', secretKey: 'SK',
    fetchFn: async (u, o) => (o.method === 'HEAD' ? { ok: head === 200, status: head, headers: new Map() }
      : o.method === 'PUT' ? { ok: put === 200, status: put } : { ok: true, status: 200, headers: new Map() }) });
  const good = await mk(404, 200).diagnose('https://app.example');
  assert.equal(good.ok, true);
  assert.equal(good.cors, undefined, 'CORS ist im Proxy-Modus unnötig');
  const bad = await mk(403, 403).diagnose('https://app.example');
  assert.equal(bad.ok, false);
  assert.match(bad.credentials, /abgelehnt/);
  assert.match(bad.schreiben, /Read and Write/);
});
