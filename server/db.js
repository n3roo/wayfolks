// Datenbank-Zugriff: Turso (libsql über HTTP) oder lokales SQLite (node:sqlite)
// Beide sprechen dasselbe SQL (SQLite-Dialekt) und haben dieselbe asynchrone Schnittstelle:
//   db.execute(sql, args)  -> { rows: [{spalte: wert}], changes }
//   db.batch([[sql, args], ...]) -> atomar in einer Transaktion, Liste von Ergebnissen
import { MIGRATIONS } from './schema.js';

// ---------- Turso über HTTP (Hrana "pipeline") ----------
function encodeArg(v) {
  if (v === null || v === undefined) return { type: 'null' };
  if (typeof v === 'bigint') return { type: 'integer', value: String(v) };
  if (typeof v === 'number') {
    return Number.isInteger(v) ? { type: 'integer', value: String(v) } : { type: 'float', value: v };
  }
  if (typeof v === 'boolean') return { type: 'integer', value: v ? '1' : '0' };
  if (v instanceof Uint8Array) return { type: 'blob', base64: Buffer.from(v).toString('base64') };
  return { type: 'text', value: String(v) };
}

function decodeValue(cell) {
  if (!cell || cell.type === 'null') return null;
  switch (cell.type) {
    case 'integer': return Number(cell.value);
    case 'float': return Number(cell.value);
    case 'blob': return Buffer.from(cell.base64 || '', 'base64');
    default: return cell.value;
  }
}

function decodeResult(result) {
  const cols = (result.cols || []).map((c) => c.name);
  const rows = (result.rows || []).map((r) => {
    const o = {};
    cols.forEach((name, i) => { o[name] = decodeValue(r[i]); });
    return o;
  });
  return { rows, changes: result.affected_row_count || 0 };
}

export class TursoHttp {
  constructor({ url, token, fetchImpl = fetch }) {
    this.base = url.replace(/^libsql:\/\//, 'https://').replace(/\/+$/, '');
    this.token = token;
    this.fetch = fetchImpl;
    this.kind = 'turso';
  }

  async _pipeline(requests) {
    let res;
    try {
      res = await this.fetch(this.base + '/v2/pipeline', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
        },
        body: JSON.stringify({ requests: [...requests, { type: 'close' }] }),
      });
    } catch (e) {
      throw new Error('Datenbank nicht erreichbar: ' + (e.cause?.code || e.message));
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Datenbank-Fehler ${res.status}: ${text.slice(0, 200)}`);
    }
    const data = await res.json();
    return data.results || [];
  }

  async execute(sql, args = []) {
    const results = await this._pipeline([
      { type: 'execute', stmt: { sql, args: args.map(encodeArg) } },
    ]);
    const first = results[0];
    if (!first || first.type === 'error') {
      throw new Error('SQL-Fehler: ' + (first?.error?.message || 'unbekannt'));
    }
    return decodeResult(first.response.result);
  }

  async batch(statements) {
    const steps = [{ stmt: { sql: 'BEGIN' } }];
    statements.forEach(([sql, args = []], i) => {
      steps.push({
        stmt: { sql, args: args.map(encodeArg) },
        condition: { type: 'ok', step: i },
      });
    });
    const commitIdx = steps.length;
    steps.push({ stmt: { sql: 'COMMIT' }, condition: { type: 'ok', step: commitIdx - 1 } });
    steps.push({
      stmt: { sql: 'ROLLBACK' },
      condition: { type: 'not', cond: { type: 'ok', step: commitIdx } },
    });
    const results = await this._pipeline([{ type: 'batch', batch: { steps } }]);
    const first = results[0];
    if (!first || first.type === 'error') {
      throw new Error('SQL-Fehler: ' + (first?.error?.message || 'unbekannt'));
    }
    const { step_results: sr = [], step_errors: se = [] } = first.response.result;
    for (let i = 1; i <= statements.length; i++) {
      if (se[i]) throw new Error('SQL-Fehler: ' + se[i].message);
    }
    if (se[commitIdx]) throw new Error('SQL-Fehler: ' + se[commitIdx].message);
    return statements.map((_, i) => (sr[i + 1] ? decodeResult(sr[i + 1]) : { rows: [], changes: 0 }));
  }

  async close() {}
}

// ---------- Lokales SQLite (Entwicklung, Tests) ----------
export class LocalSqlite {
  constructor(file = ':memory:') {
    this.file = file;
    this.kind = 'sqlite';
    this._ready = null;
  }

  async _open() {
    if (!this.db) {
      const { DatabaseSync } = await import('node:sqlite');
      this.db = new DatabaseSync(this.file);
      this.db.exec('PRAGMA foreign_keys = ON');
    }
    return this.db;
  }

  _norm(args) {
    return args.map((v) => (typeof v === 'boolean' ? (v ? 1 : 0) : v === undefined ? null : v));
  }

  async execute(sql, args = []) {
    const db = await this._open();
    const stmt = db.prepare(sql);
    if (/^\s*(select|pragma|with)/i.test(sql) || /\breturning\b/i.test(sql)) {
      const rows = stmt.all(...this._norm(args)).map((r) => ({ ...r }));
      return { rows, changes: 0 };
    }
    const info = stmt.run(...this._norm(args));
    return { rows: [], changes: Number(info.changes) };
  }

  async batch(statements) {
    const db = await this._open();
    db.exec('BEGIN');
    try {
      const out = [];
      for (const [sql, args = []] of statements) {
        const stmt = db.prepare(sql);
        if (/^\s*(select|pragma|with)/i.test(sql)) {
          out.push({ rows: stmt.all(...this._norm(args)).map((r) => ({ ...r })), changes: 0 });
        } else {
          const info = stmt.run(...this._norm(args));
          out.push({ rows: [], changes: Number(info.changes) });
        }
      }
      db.exec('COMMIT');
      return out;
    } catch (e) {
      try { db.exec('ROLLBACK'); } catch {}
      throw e;
    }
  }

  async close() {
    this.db?.close();
    this.db = null;
  }
}

export async function migrate(db) {
  await db.execute('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)');
  const r = await db.execute("SELECT value FROM meta WHERE key = 'schema_version'");
  let version = r.rows[0] ? Number(r.rows[0].value) : 0;
  for (let i = version; i < MIGRATIONS.length; i++) {
    const stmts = MIGRATIONS[i].map((sql) => [sql, []]);
    stmts.push(["INSERT INTO meta(key, value) VALUES('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [String(i + 1)]]);
    await db.batch(stmts);
    version = i + 1;
  }
  return version;
}

export function createDb(env = process.env) {
  if (env.TURSO_DATABASE_URL || env.TURSO_URL) {
    return new TursoHttp({
      url: env.TURSO_DATABASE_URL || env.TURSO_URL,
      token: env.TURSO_AUTH_TOKEN || env.TURSO_TOKEN,
    });
  }
  return new LocalSqlite(env.LOCAL_DB_FILE || 'wayfolk-dev.db');
}
