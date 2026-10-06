// Fachlogik: Benutzer, Reisen, Stopps, Einladungen. Prüft alle Rechte.
import {
  AppError, newId, newSecret, sha256, newRecoveryCode, hashRecoveryCode,
  isId, str, longText, dateOrNull, coord, colorFor, USER_COLORS, nowIso,
} from './util.js';

export const LIMITS = {
  tripsPerUser: 60,
  stopsPerTrip: 250,
  coverBytes: 400 * 1024,
};

const EDIT_ROLES = ['owner', 'editor'];

export class Store {
  constructor(db) {
    this.db = db;
  }

  // ---------- Benutzer & Geräte ----------

  async registerUser(name) {
    const clean = str(name, 40, { required: true, field: 'Name' });
    const id = newId();
    const secret = newSecret();
    const recoveryCode = newRecoveryCode();
    const color = colorFor(id);
    const ts = nowIso();
    await this.db.batch([
      ['INSERT INTO users(id, name, color, recovery_hash, created_at) VALUES(?,?,?,?,?)',
        [id, clean, color, hashRecoveryCode(recoveryCode), ts]],
      ['INSERT INTO devices(secret_hash, user_id, created_at, last_seen) VALUES(?,?,?,?)',
        [sha256(secret), id, ts, ts]],
    ]);
    return { user: { id, name: clean, color }, secret, recoveryCode };
  }

  async authDevice(userId, secret) {
    if (!isId(userId) || typeof secret !== 'string' || secret.length < 32 || secret.length > 128) return null;
    const r = await this.db.execute(
      `SELECT u.id, u.name, u.color FROM devices d JOIN users u ON u.id = d.user_id
       WHERE d.secret_hash = ? AND d.user_id = ?`,
      [sha256(secret), userId],
    );
    if (!r.rows[0]) return null;
    return r.rows[0];
  }

  async touchDevice(secret) {
    await this.db.execute('UPDATE devices SET last_seen = ? WHERE secret_hash = ?', [nowIso(), sha256(secret)]);
  }

  async recover(code) {
    const hash = hashRecoveryCode(code);
    const r = await this.db.execute('SELECT id, name, color FROM users WHERE recovery_hash = ?', [hash]);
    const user = r.rows[0];
    if (!user) throw new AppError('bad_code', 'Dieser Code ist nicht bekannt. Bitte prüfe die Eingabe.');
    const secret = newSecret();
    await this.db.execute(
      'INSERT INTO devices(secret_hash, user_id, created_at, last_seen) VALUES(?,?,?,?)',
      [sha256(secret), user.id, nowIso(), nowIso()],
    );
    return { user, secret };
  }

  async regenerateRecoveryCode(userId) {
    const code = newRecoveryCode();
    await this.db.execute('UPDATE users SET recovery_hash = ? WHERE id = ?', [hashRecoveryCode(code), userId]);
    return code;
  }

  async updateProfile(userId, patch) {
    const sets = [];
    const args = [];
    if (patch.name !== undefined) {
      sets.push('name = ?');
      args.push(str(patch.name, 40, { required: true, field: 'Name' }));
    }
    if (patch.color !== undefined) {
      if (!USER_COLORS.includes(patch.color)) throw new AppError('invalid', 'Ungültige Farbe');
      sets.push('color = ?');
      args.push(patch.color);
    }
    if (!sets.length) throw new AppError('invalid', 'Nichts zu ändern');
    args.push(userId);
    await this.db.execute(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`, args);
    const r = await this.db.execute('SELECT id, name, color FROM users WHERE id = ?', [userId]);
    return r.rows[0];
  }

  async tripIdsOfUser(userId) {
    const r = await this.db.execute('SELECT trip_id FROM members WHERE user_id = ?', [userId]);
    return r.rows.map((x) => x.trip_id);
  }

  // ---------- Rechte ----------

  async roleOf(tripId, userId) {
    if (!isId(tripId)) return null;
    const r = await this.db.execute('SELECT role FROM members WHERE trip_id = ? AND user_id = ?', [tripId, userId]);
    return r.rows[0]?.role || null;
  }

  async requireRole(tripId, userId, roles) {
    const role = await this.roleOf(tripId, userId);
    if (!role) throw new AppError('not_found', 'Diese Reise gibt es nicht oder du hast keinen Zugriff.');
    if (!roles.includes(role)) throw new AppError('forbidden', 'Dafür fehlt dir die Berechtigung.');
    return role;
  }

  // ---------- Reisen ----------

  _tripDto(row) {
    return {
      id: row.id,
      title: row.title,
      start_date: row.start_date || null,
      end_date: row.end_date || null,
      has_cover: !!row.has_cover,
      cover_version: row.cover_version || 0,
      owner_id: row.owner_id,
      updated_at: row.updated_at,
    };
  }

  async listTrips(userId) {
    const r = await this.db.execute(
      `SELECT t.id, t.title, t.start_date, t.end_date, t.cover_version, (t.cover IS NOT NULL) AS has_cover,
              t.owner_id, t.updated_at, m.role,
              (SELECT COUNT(*) FROM stops s WHERE s.trip_id = t.id) AS stop_count,
              (SELECT COUNT(*) FROM stops s WHERE s.trip_id = t.id AND s.visited_at IS NOT NULL) AS visited_count
       FROM members m JOIN trips t ON t.id = m.trip_id
       WHERE m.user_id = ? ORDER BY t.updated_at DESC`,
      [userId],
    );
    if (!r.rows.length) return [];
    const ids = r.rows.map((x) => x.id);
    const marks = ids.map(() => '?').join(',');
    const mem = await this.db.execute(
      `SELECT m.trip_id, u.id, u.name, u.color, m.role FROM members m JOIN users u ON u.id = m.user_id
       WHERE m.trip_id IN (${marks}) ORDER BY m.joined_at`,
      ids,
    );
    const byTrip = new Map();
    for (const row of mem.rows) {
      if (!byTrip.has(row.trip_id)) byTrip.set(row.trip_id, []);
      byTrip.get(row.trip_id).push({ id: row.id, name: row.name, color: row.color, role: row.role });
    }
    return r.rows.map((row) => ({
      ...this._tripDto(row),
      role: row.role,
      stop_count: row.stop_count,
      visited_count: row.visited_count,
      members: byTrip.get(row.id) || [],
    }));
  }

  async createTrip(userId, data) {
    const id = data.id === undefined ? newId() : data.id;
    if (!isId(id)) throw new AppError('invalid', 'Ungültige Reise-ID');
    const existing = await this.db.execute('SELECT owner_id FROM trips WHERE id = ?', [id]);
    if (existing.rows[0]) {
      if (existing.rows[0].owner_id !== userId) throw new AppError('forbidden', 'ID bereits vergeben');
      return { trip: await this._loadTripDto(id), created: false };
    }
    const count = await this.db.execute('SELECT COUNT(*) AS n FROM members WHERE user_id = ? AND role = ?', [userId, 'owner']);
    if (count.rows[0].n >= LIMITS.tripsPerUser) throw new AppError('limit', 'Du hast die maximale Anzahl an Reisen erreicht.');
    const title = str(data.title, 80, { required: true, field: 'Reisename' });
    const start = dateOrNull(data.start_date, 'Startdatum');
    const end = dateOrNull(data.end_date, 'Enddatum');
    if (start && end && end < start) throw new AppError('invalid', 'Das Ende liegt vor dem Start.');
    const ts = nowIso();
    await this.db.batch([
      ['INSERT INTO trips(id, title, start_date, end_date, owner_id, created_at, updated_at) VALUES(?,?,?,?,?,?,?)',
        [id, title, start, end, userId, ts, ts]],
      ['INSERT INTO members(trip_id, user_id, role, joined_at) VALUES(?,?,?,?)', [id, userId, 'owner', ts]],
    ]);
    return { trip: await this._loadTripDto(id), created: true };
  }

  async _loadTripDto(id) {
    const r = await this.db.execute(
      `SELECT id, title, start_date, end_date, cover_version, (cover IS NOT NULL) AS has_cover, owner_id, updated_at
       FROM trips WHERE id = ?`,
      [id],
    );
    if (!r.rows[0]) throw new AppError('not_found', 'Reise nicht gefunden');
    return this._tripDto(r.rows[0]);
  }

  async updateTrip(userId, tripId, patch) {
    await this.requireRole(tripId, userId, ['owner']);
    const sets = [];
    const args = [];
    const cur = await this._loadTripDto(tripId);
    if (patch.title !== undefined) {
      sets.push('title = ?');
      args.push(str(patch.title, 80, { required: true, field: 'Reisename' }));
    }
    let start = cur.start_date;
    let end = cur.end_date;
    if (patch.start_date !== undefined) { start = dateOrNull(patch.start_date, 'Startdatum'); sets.push('start_date = ?'); args.push(start); }
    if (patch.end_date !== undefined) { end = dateOrNull(patch.end_date, 'Enddatum'); sets.push('end_date = ?'); args.push(end); }
    if (start && end && end < start) throw new AppError('invalid', 'Das Ende liegt vor dem Start.');
    if (patch.remove_cover) {
      sets.push('cover = NULL', 'cover_type = NULL', 'cover_version = cover_version + 1');
    }
    if (!sets.length) return cur;
    sets.push('updated_at = ?');
    args.push(nowIso(), tripId);
    await this.db.execute(`UPDATE trips SET ${sets.join(', ')} WHERE id = ?`, args);
    return this._loadTripDto(tripId);
  }

  async setCover(userId, tripId, base64, type) {
    await this.requireRole(tripId, userId, ['owner']);
    if (type !== 'image/jpeg' && type !== 'image/webp' && type !== 'image/png') throw new AppError('invalid', 'Bildformat nicht erlaubt');
    if (typeof base64 !== 'string') throw new AppError('invalid', 'Bild fehlt');
    const buf = Buffer.from(base64, 'base64');
    if (!buf.length) throw new AppError('invalid', 'Bild ist leer');
    if (buf.length > LIMITS.coverBytes) throw new AppError('too_big', 'Das Titelbild ist zu groß.');
    await this.db.execute(
      'UPDATE trips SET cover = ?, cover_type = ?, cover_version = cover_version + 1, updated_at = ? WHERE id = ?',
      [buf, type, nowIso(), tripId],
    );
    return this._loadTripDto(tripId);
  }

  async getCover(tripId) {
    if (!isId(tripId)) return null;
    const r = await this.db.execute('SELECT cover, cover_type FROM trips WHERE id = ? AND cover IS NOT NULL', [tripId]);
    if (!r.rows[0]) return null;
    const c = r.rows[0].cover;
    return { data: Buffer.isBuffer(c) ? c : Buffer.from(c), type: r.rows[0].cover_type || 'image/jpeg' };
  }

  async deleteTrip(userId, tripId) {
    await this.requireRole(tripId, userId, ['owner']);
    const members = await this.memberIds(tripId);
    // Kinder-Tabellen werden per ON DELETE CASCADE entfernt; zur Sicherheit explizit
    await this.db.batch([
      ['DELETE FROM stops WHERE trip_id = ?', [tripId]],
      ['DELETE FROM invites WHERE trip_id = ?', [tripId]],
      ['DELETE FROM members WHERE trip_id = ?', [tripId]],
      ['DELETE FROM trips WHERE id = ?', [tripId]],
    ]);
    return { members };
  }

  async memberIds(tripId) {
    const r = await this.db.execute('SELECT user_id FROM members WHERE trip_id = ?', [tripId]);
    return r.rows.map((x) => x.user_id);
  }

  async members(tripId) {
    const r = await this.db.execute(
      `SELECT u.id, u.name, u.color, m.role FROM members m JOIN users u ON u.id = m.user_id
       WHERE m.trip_id = ? ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'editor' THEN 1 ELSE 2 END, m.joined_at`,
      [tripId],
    );
    return r.rows.map((x) => ({ id: x.id, name: x.name, color: x.color, role: x.role }));
  }

  async leaveTrip(userId, tripId) {
    const role = await this.requireRole(tripId, userId, ['owner', 'editor', 'viewer']);
    if (role === 'owner') throw new AppError('forbidden', 'Als Besitzer kannst du die Reise nur löschen, nicht verlassen.');
    await this.db.execute('DELETE FROM members WHERE trip_id = ? AND user_id = ?', [tripId, userId]);
    return { members: await this.members(tripId) };
  }

  async setMemberRole(userId, tripId, targetId, role) {
    await this.requireRole(tripId, userId, ['owner']);
    if (role !== 'editor' && role !== 'viewer') throw new AppError('invalid', 'Ungültige Rolle');
    const cur = await this.roleOf(tripId, targetId);
    if (!cur) throw new AppError('not_found', 'Person nicht gefunden');
    if (cur === 'owner') throw new AppError('forbidden', 'Die Rolle des Besitzers lässt sich nicht ändern.');
    await this.db.execute('UPDATE members SET role = ? WHERE trip_id = ? AND user_id = ?', [role, tripId, targetId]);
    return { members: await this.members(tripId) };
  }

  async removeMember(userId, tripId, targetId) {
    await this.requireRole(tripId, userId, ['owner']);
    const cur = await this.roleOf(tripId, targetId);
    if (!cur) throw new AppError('not_found', 'Person nicht gefunden');
    if (cur === 'owner') throw new AppError('forbidden', 'Den Besitzer kannst du nicht entfernen.');
    await this.db.execute('DELETE FROM members WHERE trip_id = ? AND user_id = ?', [tripId, targetId]);
    return { members: await this.members(tripId) };
  }

  // ---------- Schnappschuss einer Reise ----------

  _stopDto(r) {
    return {
      id: r.id,
      trip_id: r.trip_id,
      position: r.position,
      name: r.name,
      description: r.description,
      notes: r.notes,
      lat: r.lat,
      lon: r.lon,
      planned_date: r.planned_date || null,
      visited_at: r.visited_at || null,
      visited_by: r.visited_by || null,
      created_by: r.created_by || null,
      updated_at: r.updated_at,
    };
  }

  async openTrip(userId, tripId) {
    const role = await this.requireRole(tripId, userId, ['owner', 'editor', 'viewer']);
    const trip = await this._loadTripDto(tripId);
    const stops = await this.db.execute('SELECT * FROM stops WHERE trip_id = ? ORDER BY position, created_at', [tripId]);
    const snapshot = {
      trip,
      role,
      members: await this.members(tripId),
      stops: stops.rows.map((s) => this._stopDto(s)),
    };
    if (role === 'owner') snapshot.invites = await this.listInvites(userId, tripId);
    return snapshot;
  }

  // ---------- Stopps ----------

  async createStop(userId, tripId, data) {
    await this.requireRole(tripId, userId, EDIT_ROLES);
    const id = data.id === undefined ? newId() : data.id;
    if (!isId(id)) throw new AppError('invalid', 'Ungültige Stopp-ID');
    const found = await this.db.execute('SELECT * FROM stops WHERE id = ?', [id]);
    if (found.rows[0]) {
      if (found.rows[0].trip_id !== tripId) throw new AppError('forbidden', 'ID bereits vergeben');
      return this._stopDto(found.rows[0]);
    }
    const n = await this.db.execute('SELECT COUNT(*) AS n, COALESCE(MAX(position), -1) AS mx FROM stops WHERE trip_id = ?', [tripId]);
    if (n.rows[0].n >= LIMITS.stopsPerTrip) throw new AppError('limit', 'Diese Reise hat die maximale Anzahl an Stopps erreicht.');
    const name = str(data.name, 120, { required: true, field: 'Name' });
    const [lat, lon] = coord(data.lat, data.lon);
    const ts = nowIso();
    await this.db.batch([
      [`INSERT INTO stops(id, trip_id, position, name, description, notes, lat, lon, planned_date, created_by, created_at, updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
        [id, tripId, n.rows[0].mx + 1, name, longText(data.description, 4000, 'Beschreibung'),
          longText(data.notes, 8000, 'Notizen'), lat, lon, dateOrNull(data.planned_date, 'Datum'), userId, ts, ts]],
      ['UPDATE trips SET updated_at = ? WHERE id = ?', [ts, tripId]],
    ]);
    const r = await this.db.execute('SELECT * FROM stops WHERE id = ?', [id]);
    return this._stopDto(r.rows[0]);
  }

  async updateStop(userId, tripId, stopId, patch) {
    await this.requireRole(tripId, userId, EDIT_ROLES);
    const cur = await this.db.execute('SELECT id FROM stops WHERE id = ? AND trip_id = ?', [stopId, tripId]);
    if (!cur.rows[0]) throw new AppError('not_found', 'Stopp nicht gefunden');
    const sets = [];
    const args = [];
    if (patch.name !== undefined) { sets.push('name = ?'); args.push(str(patch.name, 120, { required: true, field: 'Name' })); }
    if (patch.description !== undefined) { sets.push('description = ?'); args.push(longText(patch.description, 4000, 'Beschreibung')); }
    if (patch.notes !== undefined) { sets.push('notes = ?'); args.push(longText(patch.notes, 8000, 'Notizen')); }
    if (patch.planned_date !== undefined) { sets.push('planned_date = ?'); args.push(dateOrNull(patch.planned_date, 'Datum')); }
    if (patch.lat !== undefined || patch.lon !== undefined) {
      const [lat, lon] = coord(patch.lat, patch.lon);
      sets.push('lat = ?', 'lon = ?');
      args.push(lat, lon);
    }
    if (!sets.length) throw new AppError('invalid', 'Nichts zu ändern');
    const ts = nowIso();
    sets.push('updated_at = ?');
    args.push(ts, stopId, tripId);
    await this.db.batch([
      [`UPDATE stops SET ${sets.join(', ')} WHERE id = ? AND trip_id = ?`, args],
      ['UPDATE trips SET updated_at = ? WHERE id = ?', [ts, tripId]],
    ]);
    const r = await this.db.execute('SELECT * FROM stops WHERE id = ?', [stopId]);
    return this._stopDto(r.rows[0]);
  }

  async setVisited(userId, tripId, stopId, visited) {
    await this.requireRole(tripId, userId, EDIT_ROLES);
    const cur = await this.db.execute('SELECT id FROM stops WHERE id = ? AND trip_id = ?', [stopId, tripId]);
    if (!cur.rows[0]) throw new AppError('not_found', 'Stopp nicht gefunden');
    const ts = nowIso();
    await this.db.batch([
      ['UPDATE stops SET visited_at = ?, visited_by = ?, updated_at = ? WHERE id = ? AND trip_id = ?',
        [visited ? ts : null, visited ? userId : null, ts, stopId, tripId]],
      ['UPDATE trips SET updated_at = ? WHERE id = ?', [ts, tripId]],
    ]);
    const r = await this.db.execute('SELECT * FROM stops WHERE id = ?', [stopId]);
    return this._stopDto(r.rows[0]);
  }

  async deleteStop(userId, tripId, stopId) {
    await this.requireRole(tripId, userId, EDIT_ROLES);
    const ts = nowIso();
    await this.db.batch([
      ['DELETE FROM stops WHERE id = ? AND trip_id = ?', [stopId, tripId]],
      ['UPDATE trips SET updated_at = ? WHERE id = ?', [ts, tripId]],
    ]);
    return { id: stopId };
  }

  async reorderStops(userId, tripId, ids) {
    await this.requireRole(tripId, userId, EDIT_ROLES);
    if (!Array.isArray(ids) || ids.length > LIMITS.stopsPerTrip + 20) throw new AppError('invalid', 'Ungültige Reihenfolge');
    const cur = await this.db.execute('SELECT id FROM stops WHERE trip_id = ? ORDER BY position, created_at', [tripId]);
    const known = new Set(cur.rows.map((x) => x.id));
    const seen = new Set();
    const order = [];
    for (const id of ids) {
      if (known.has(id) && !seen.has(id)) { seen.add(id); order.push(id); }
    }
    for (const row of cur.rows) {
      if (!seen.has(row.id)) order.push(row.id);
    }
    const ts = nowIso();
    const stmts = order.map((id, i) => ['UPDATE stops SET position = ? WHERE id = ? AND trip_id = ?', [i, id, tripId]]);
    stmts.push(['UPDATE trips SET updated_at = ? WHERE id = ?', [ts, tripId]]);
    await this.db.batch(stmts);
    return { ids: order };
  }

  // ---------- Einladungen ----------

  async listInvites(userId, tripId) {
    await this.requireRole(tripId, userId, ['owner']);
    const r = await this.db.execute(
      'SELECT token, role FROM invites WHERE trip_id = ? AND revoked = 0 ORDER BY created_at',
      [tripId],
    );
    return r.rows.map((x) => ({ token: x.token, role: x.role }));
  }

  async ensureInvite(userId, tripId, role, { reset = false } = {}) {
    await this.requireRole(tripId, userId, ['owner']);
    if (role !== 'editor' && role !== 'viewer') throw new AppError('invalid', 'Ungültige Rolle');
    if (reset) {
      await this.db.execute('UPDATE invites SET revoked = 1 WHERE trip_id = ? AND role = ?', [tripId, role]);
    } else {
      const ex = await this.db.execute('SELECT token FROM invites WHERE trip_id = ? AND role = ? AND revoked = 0', [tripId, role]);
      if (ex.rows[0]) return this.listInvites(userId, tripId);
    }
    await this.db.execute(
      'INSERT INTO invites(token, trip_id, role, created_by, created_at) VALUES(?,?,?,?,?)',
      [newId(18), tripId, role, userId, nowIso()],
    );
    return this.listInvites(userId, tripId);
  }

  async revokeInvite(userId, tripId, role) {
    await this.requireRole(tripId, userId, ['owner']);
    await this.db.execute('UPDATE invites SET revoked = 1 WHERE trip_id = ? AND role = ?', [tripId, role]);
    return this.listInvites(userId, tripId);
  }

  async peekInvite(token) {
    if (!isId(token)) throw new AppError('invite_invalid', 'Dieser Einladungslink ist nicht mehr gültig.');
    const r = await this.db.execute(
      `SELECT i.role, t.id AS trip_id, t.title, t.start_date, t.end_date, t.cover_version, (t.cover IS NOT NULL) AS has_cover,
              u.name AS owner_name,
              (SELECT COUNT(*) FROM members m WHERE m.trip_id = t.id) AS member_count,
              (SELECT COUNT(*) FROM stops s WHERE s.trip_id = t.id) AS stop_count
       FROM invites i JOIN trips t ON t.id = i.trip_id JOIN users u ON u.id = t.owner_id
       WHERE i.token = ? AND i.revoked = 0`,
      [token],
    );
    const x = r.rows[0];
    if (!x) throw new AppError('invite_invalid', 'Dieser Einladungslink ist nicht mehr gültig.');
    return {
      trip_id: x.trip_id, title: x.title, start_date: x.start_date, end_date: x.end_date,
      has_cover: !!x.has_cover, cover_version: x.cover_version, owner_name: x.owner_name,
      role: x.role, member_count: x.member_count, stop_count: x.stop_count,
    };
  }

  async acceptInvite(userId, token) {
    const info = await this.peekInvite(token);
    const cur = await this.roleOf(info.trip_id, userId);
    if (cur) return { tripId: info.trip_id, role: cur, joined: false };
    await this.db.execute(
      'INSERT INTO members(trip_id, user_id, role, joined_at) VALUES(?,?,?,?)',
      [info.trip_id, userId, info.role, nowIso()],
    );
    return { tripId: info.trip_id, role: info.role, joined: true, members: await this.members(info.trip_id) };
  }
}
