// WebSocket-Hub: Anmeldung, Operationen, Live-Verteilung an alle Mitreisenden
import { AppError, isId } from './util.js';

const MAX_MSG_PER_WINDOW = 400;
const WINDOW_MS = 10_000;

class Limiter {
  constructor(max, windowMs) {
    this.max = max;
    this.windowMs = windowMs;
    this.hits = new Map();
  }
  hit(key) {
    const now = Date.now();
    const arr = (this.hits.get(key) || []).filter((t) => now - t < this.windowMs);
    arr.push(now);
    this.hits.set(key, arr);
    if (this.hits.size > 5000) this.sweep(now);
    return arr.length <= this.max;
  }
  sweep(now) {
    for (const [k, arr] of this.hits) {
      if (!arr.length || now - arr[arr.length - 1] > this.windowMs) this.hits.delete(k);
    }
  }
}

export class Hub {
  constructor(store, { log = () => {} } = {}) {
    this.store = store;
    this.log = log;
    this.conns = new Set();
    this.tripSubs = new Map(); // tripId -> Set(conn)
    this.pushTimers = new Map(); // userId -> timer
    this.registerLimiter = new Limiter(15, 60 * 60 * 1000);
    this.recoverLimiter = new Limiter(10, 10 * 60 * 1000);
    this.peekLimiter = new Limiter(60, 60 * 1000);
    this.ops = this._buildOps();
  }

  // ---------- Verbindung ----------

  attach(ws, ip = 'unknown') {
    const conn = { ws, ip, user: null, secret: null, subs: new Set(), alive: true, window: [] };
    this.conns.add(conn);
    ws.on('pong', () => { conn.alive = true; });
    ws.on('message', (raw) => {
      this._onMessage(conn, raw).catch((e) => {
        this.log('message error', e);
        this._send(conn, { t: 'error', message: 'Interner Fehler' });
      });
    });
    ws.on('close', () => this._onClose(conn));
    ws.on('error', () => {});
    return conn;
  }

  heartbeat() {
    for (const c of this.conns) {
      if (!c.alive) { try { c.ws.terminate(); } catch {} continue; }
      c.alive = false;
      try { c.ws.ping(); } catch {}
    }
  }

  _send(conn, obj) {
    if (conn.ws.readyState === 1) {
      try { conn.ws.send(JSON.stringify(obj)); } catch {}
    }
  }

  _onClose(conn) {
    this.conns.delete(conn);
    for (const tripId of conn.subs) this._unsubscribe(conn, tripId);
  }

  async _onMessage(conn, raw) {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (!msg || typeof msg !== 'object') return;

    const now = Date.now();
    conn.window = conn.window.filter((t) => now - t < WINDOW_MS);
    conn.window.push(now);
    if (conn.window.length > MAX_MSG_PER_WINDOW) {
      if (msg.id) this._send(conn, { t: 'ack', id: msg.id, ok: false, code: 'rate', message: 'Zu viele Anfragen. Bitte kurz warten.' });
      return;
    }

    switch (msg.t) {
      case 'ping': return this._send(conn, { t: 'pong' });
      case 'register': return this._register(conn, msg);
      case 'recover': return this._recover(conn, msg);
      case 'hello': return this._hello(conn, msg);
      case 'peek': return this._peek(conn, msg);
      case 'op': return this._op(conn, msg);
      default: return undefined;
    }
  }

  async _register(conn, msg) {
    if (!this.registerLimiter.hit(conn.ip)) {
      return this._send(conn, { t: 'auth_error', code: 'rate', message: 'Zu viele Versuche. Bitte versuche es später noch einmal.' });
    }
    try {
      const { user, secret, recoveryCode } = await this.store.registerUser(msg.name);
      this._send(conn, { t: 'registered', user, secret, recoveryCode });
    } catch (e) {
      this._send(conn, { t: 'auth_error', code: e.code || 'error', message: e.message });
    }
  }

  async _recover(conn, msg) {
    if (!this.recoverLimiter.hit(conn.ip)) {
      return this._send(conn, { t: 'auth_error', code: 'rate', message: 'Zu viele Versuche. Bitte warte einige Minuten.' });
    }
    try {
      const { user, secret } = await this.store.recover(msg.code);
      this._send(conn, { t: 'recovered', user, secret });
    } catch (e) {
      this._send(conn, { t: 'auth_error', code: e.code || 'error', message: e.message });
    }
  }

  async _hello(conn, msg) {
    const user = await this.store.authDevice(msg.userId, msg.secret);
    if (!user) return this._send(conn, { t: 'auth_failed' });
    conn.user = user;
    conn.secret = msg.secret;
    this.store.touchDevice(msg.secret).catch(() => {});
    const trips = await this.store.listTrips(user.id);
    this._send(conn, { t: 'welcome', user, trips, config: this.store.clientConfig() });
  }

  async _peek(conn, msg) {
    if (!this.peekLimiter.hit(conn.ip)) {
      return this._send(conn, { t: 'ack', id: msg.id, ok: false, code: 'rate', message: 'Zu viele Anfragen.' });
    }
    try {
      const info = await this.store.peekInvite(msg.token);
      this._send(conn, { t: 'ack', id: msg.id, ok: true, result: info });
    } catch (e) {
      this._send(conn, { t: 'ack', id: msg.id, ok: false, code: e.code || 'error', message: e.message });
    }
  }

  async _op(conn, msg) {
    const id = msg.id;
    if (!conn.user) {
      return this._send(conn, { t: 'ack', id, ok: false, code: 'auth', message: 'Nicht angemeldet' });
    }
    const handler = this.ops[msg.op];
    if (!handler) {
      return this._send(conn, { t: 'ack', id, ok: false, code: 'unknown_op', message: 'Unbekannte Aktion' });
    }
    try {
      const result = await handler(conn, msg.p || {});
      this._send(conn, { t: 'ack', id, ok: true, result: result ?? null });
    } catch (e) {
      if (!(e instanceof AppError)) this.log('op error', msg.op, e);
      this._send(conn, {
        t: 'ack', id, ok: false,
        code: e instanceof AppError ? e.code : 'server_error',
        message: e instanceof AppError ? e.message : 'Es ist ein Serverfehler aufgetreten. Bitte versuche es gleich noch einmal.',
      });
    }
  }

  // ---------- Abos & Verteilung ----------

  _subscribe(conn, tripId) {
    if (!this.tripSubs.has(tripId)) this.tripSubs.set(tripId, new Set());
    this.tripSubs.get(tripId).add(conn);
    conn.subs.add(tripId);
    this._broadcastPresence(tripId);
  }

  _unsubscribe(conn, tripId) {
    conn.subs.delete(tripId);
    const set = this.tripSubs.get(tripId);
    if (set) {
      set.delete(conn);
      if (!set.size) this.tripSubs.delete(tripId);
      else this._broadcastPresence(tripId);
    }
  }

  online(tripId) {
    const ids = new Set();
    for (const c of this.tripSubs.get(tripId) || []) if (c.user) ids.add(c.user.id);
    return [...ids];
  }

  _broadcastPresence(tripId) {
    this.broadcast(tripId, 'presence', { online: this.online(tripId) });
  }

  broadcast(tripId, k, v, except = null) {
    const set = this.tripSubs.get(tripId);
    if (!set) return;
    const payload = JSON.stringify({ t: 'ev', trip: tripId, k, v });
    for (const c of set) {
      if (c !== except && c.ws.readyState === 1) {
        try { c.ws.send(payload); } catch {}
      }
    }
  }

  // Reiseliste bei den betroffenen Personen aktualisieren (entprellt)
  scheduleTripsPush(userIds) {
    for (const uid of userIds) {
      if (this.pushTimers.has(uid)) continue;
      const timer = setTimeout(async () => {
        this.pushTimers.delete(uid);
        const targets = [...this.conns].filter((c) => c.user?.id === uid);
        if (!targets.length) return;
        try {
          const trips = await this.store.listTrips(uid);
          for (const c of targets) this._send(c, { t: 'trips', trips });
        } catch (e) { this.log('push error', e); }
      }, 800);
      timer.unref?.();
      this.pushTimers.set(uid, timer);
    }
  }

  _kick(userId, tripId, reason) {
    for (const c of [...(this.tripSubs.get(tripId) || [])]) {
      if (c.user?.id === userId) {
        this._send(c, { t: 'ev', trip: tripId, k: 'gone', v: { reason } });
        this._unsubscribe(c, tripId);
      }
    }
  }

  // ---------- Operationen ----------

  _buildOps() {
    const s = this.store;
    const need = (p, key) => {
      if (!isId(p[key])) throw new AppError('invalid', 'Ungültige Anfrage');
      return p[key];
    };
    const touchList = async (tripId) => this.scheduleTripsPush(await s.memberIds(tripId));

    return {
      'profile.update': async (c, p) => {
        const user = await s.updateProfile(c.user.id, p);
        for (const conn of this.conns) if (conn.user?.id === user.id) conn.user = user;
        for (const tripId of await s.tripIdsOfUser(user.id)) {
          this.broadcast(tripId, 'members', { members: await s.members(tripId) });
        }
        return user;
      },
      'profile.newCode': async (c) => ({ code: await s.regenerateRecoveryCode(c.user.id) }),

      'trips.list': async (c) => ({ trips: await s.listTrips(c.user.id) }),

      'trip.create': async (c, p) => {
        const { trip, created } = await s.createTrip(c.user.id, p);
        if (created) this.scheduleTripsPush([c.user.id]);
        return { trip };
      },
      'trip.update': async (c, p) => {
        const tripId = need(p, 'tripId');
        const trip = await s.updateTrip(c.user.id, tripId, p.patch || {});
        this.broadcast(tripId, 'trip', { trip }, c);
        await touchList(tripId);
        return { trip };
      },
      'trip.cover': async (c, p) => {
        const tripId = need(p, 'tripId');
        const trip = await s.setCover(c.user.id, tripId, p.data, p.type);
        this.broadcast(tripId, 'trip', { trip }, c);
        await touchList(tripId);
        return { trip };
      },
      'trip.delete': async (c, p) => {
        const tripId = need(p, 'tripId');
        const { members } = await s.deleteTrip(c.user.id, tripId);
        for (const uid of members) this._kick(uid, tripId, 'deleted');
        this.scheduleTripsPush(members);
        return {};
      },
      'trip.leave': async (c, p) => {
        const tripId = need(p, 'tripId');
        const { members } = await s.leaveTrip(c.user.id, tripId);
        this._kick(c.user.id, tripId, 'left');
        this.broadcast(tripId, 'members', { members });
        this.scheduleTripsPush([c.user.id]);
        return {};
      },
      'trip.open': async (c, p) => {
        const tripId = need(p, 'tripId');
        const snap = await s.openTrip(c.user.id, tripId);
        this._subscribe(c, tripId);
        snap.online = this.online(tripId);
        return snap;
      },
      'trip.close': async (c, p) => {
        if (isId(p.tripId)) this._unsubscribe(c, p.tripId);
        return {};
      },

      'stop.create': async (c, p) => {
        const tripId = need(p, 'tripId');
        const stop = await s.createStop(c.user.id, tripId, p.stop || {});
        this.broadcast(tripId, 'stop', { stop }, c);
        await touchList(tripId);
        return { stop };
      },
      'stop.update': async (c, p) => {
        const tripId = need(p, 'tripId');
        const stop = await s.updateStop(c.user.id, tripId, need(p, 'stopId'), p.patch || {});
        this.broadcast(tripId, 'stop', { stop }, c);
        return { stop };
      },
      'stop.visit': async (c, p) => {
        const tripId = need(p, 'tripId');
        const stop = await s.setVisited(c.user.id, tripId, need(p, 'stopId'), !!p.visited);
        this.broadcast(tripId, 'stop', { stop }, c);
        await touchList(tripId);
        return { stop };
      },
      'stop.delete': async (c, p) => {
        const tripId = need(p, 'tripId');
        const stopId = need(p, 'stopId');
        await s.deleteStop(c.user.id, tripId, stopId);
        this.broadcast(tripId, 'stop.del', { id: stopId }, c);
        await touchList(tripId);
        return {};
      },
      'stop.reorder': async (c, p) => {
        const tripId = need(p, 'tripId');
        const { ids } = await s.reorderStops(c.user.id, tripId, p.ids);
        this.broadcast(tripId, 'stops.order', { ids }, c);
        return { ids };
      },

      'media.prepare': async (c, p) => s.prepareMedia(c.user.id, need(p, 'tripId'), p.media || {}),
      'media.add': async (c, p) => {
        const tripId = need(p, 'tripId');
        const media = await s.addMedia(c.user.id, tripId, p.media || {});
        this.broadcast(tripId, 'media', { media }, c);
        await touchList(tripId);
        return { media };
      },
      'media.update': async (c, p) => {
        const tripId = need(p, 'tripId');
        const media = await s.updateMedia(c.user.id, tripId, need(p, 'mediaId'), p.patch || {});
        this.broadcast(tripId, 'media', { media }, c);
        return { media };
      },
      'media.delete': async (c, p) => {
        const tripId = need(p, 'tripId');
        const mediaId = need(p, 'mediaId');
        await s.deleteMedia(c.user.id, tripId, mediaId);
        this.broadcast(tripId, 'media.del', { id: mediaId }, c);
        return {};
      },

      'invite.ensure': async (c, p) => {
        const invites = await s.ensureInvite(c.user.id, need(p, 'tripId'), p.role, { reset: !!p.reset });
        return { invites };
      },
      'invite.revoke': async (c, p) => {
        const invites = await s.revokeInvite(c.user.id, need(p, 'tripId'), p.role);
        return { invites };
      },
      'invite.accept': async (c, p) => {
        const res = await s.acceptInvite(c.user.id, p.token);
        if (res.joined) {
          this.broadcast(res.tripId, 'members', { members: res.members });
          this.scheduleTripsPush([c.user.id]);
        }
        return { tripId: res.tripId, role: res.role, joined: res.joined };
      },

      'member.role': async (c, p) => {
        const tripId = need(p, 'tripId');
        const { members } = await s.setMemberRole(c.user.id, tripId, need(p, 'userId'), p.role);
        this.broadcast(tripId, 'members', { members });
        // Betroffene Person bekommt eine frische Ansicht
        for (const conn of this.tripSubs.get(tripId) || []) {
          if (conn.user?.id === p.userId) this._send(conn, { t: 'ev', trip: tripId, k: 'resync', v: {} });
        }
        this.scheduleTripsPush([p.userId]);
        return { members };
      },
      'member.remove': async (c, p) => {
        const tripId = need(p, 'tripId');
        const { members } = await s.removeMember(c.user.id, tripId, need(p, 'userId'));
        this._kick(p.userId, tripId, 'removed');
        this.broadcast(tripId, 'members', { members });
        this.scheduleTripsPush([p.userId]);
        return { members };
      },
    };
  }
}
