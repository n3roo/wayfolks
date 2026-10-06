// Minimaler Nachbau der Turso-HTTP-Schnittstelle (/v2/pipeline) auf Basis von node:sqlite.
// Dient nur zum Testen unseres Clients, ohne echte Zugangsdaten.
import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';

function decodeArg(a) {
  switch (a.type) {
    case 'null': return null;
    case 'integer': return Number(a.value);
    case 'float': return Number(a.value);
    case 'blob': return Buffer.from(a.base64, 'base64');
    default: return a.value;
  }
}

function encodeCell(v) {
  if (v === null || v === undefined) return { type: 'null' };
  if (Buffer.isBuffer(v) || v instanceof Uint8Array) return { type: 'blob', base64: Buffer.from(v).toString('base64') };
  if (typeof v === 'number') return Number.isInteger(v) ? { type: 'integer', value: String(v) } : { type: 'float', value: v };
  if (typeof v === 'bigint') return { type: 'integer', value: String(v) };
  return { type: 'text', value: String(v) };
}

export async function startFakeTurso({ token = 'test-token' } = {}) {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  const seen = { requests: 0, last: null };

  function runStmt(stmt) {
    const args = (stmt.args || []).map(decodeArg);
    const prepared = db.prepare(stmt.sql);
    const isRead = /^\s*(select|pragma|with)/i.test(stmt.sql);
    if (isRead) {
      const rows = prepared.all(...args);
      const cols = prepared.columns().map((c) => ({ name: c.name, decltype: null }));
      return {
        cols,
        rows: rows.map((r) => cols.map((c) => encodeCell(r[c.name]))),
        affected_row_count: 0,
        last_insert_rowid: null,
      };
    }
    const info = prepared.run(...args);
    return { cols: [], rows: [], affected_row_count: Number(info.changes), last_insert_rowid: String(info.lastInsertRowid) };
  }

  function evalCond(c, results, errors) {
    if (!c) return true;
    if (c.type === 'ok') return results[c.step] != null && !errors[c.step];
    if (c.type === 'error') return !!errors[c.step];
    if (c.type === 'not') return !evalCond(c.cond, results, errors);
    if (c.type === 'and') return c.conds.every((x) => evalCond(x, results, errors));
    if (c.type === 'or') return c.conds.some((x) => evalCond(x, results, errors));
    if (c.type === 'is_autocommit') return !db.isTransaction;
    return false;
  }

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      seen.requests++;
      if (req.method !== 'POST' || req.url !== '/v2/pipeline') { res.writeHead(404); return res.end(); }
      if (req.headers.authorization !== `Bearer ${token}`) { res.writeHead(401); return res.end('unauthorized'); }
      const payload = JSON.parse(body);
      seen.last = payload;
      const results = [];
      for (const r of payload.requests) {
        if (r.type === 'close') { results.push({ type: 'ok', response: { type: 'close' } }); continue; }
        if (r.type === 'execute') {
          try { results.push({ type: 'ok', response: { type: 'execute', result: runStmt(r.stmt) } }); }
          catch (e) { results.push({ type: 'error', error: { message: e.message, code: 'SQLITE_ERROR' } }); }
          continue;
        }
        if (r.type === 'batch') {
          const stepResults = [];
          const stepErrors = [];
          r.batch.steps.forEach((step, i) => {
            if (!evalCond(step.condition, stepResults, stepErrors)) { stepResults[i] = null; stepErrors[i] = null; return; }
            try { stepResults[i] = runStmt(step.stmt); stepErrors[i] = null; }
            catch (e) { stepResults[i] = null; stepErrors[i] = { message: e.message, code: 'SQLITE_ERROR' }; }
          });
          results.push({ type: 'ok', response: { type: 'batch', result: { step_results: stepResults, step_errors: stepErrors } } });
          continue;
        }
        results.push({ type: 'error', error: { message: 'unsupported request ' + r.type } });
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ baton: null, base_url: null, results }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  return { url: `http://127.0.0.1:${port}`, token, seen, close: () => new Promise((r) => { server.close(r); server.closeAllConnections?.(); }) };
}
