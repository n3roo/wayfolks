// Verbindung zum Server: WebSocket, automatisches Wiederverbinden, Warteschlange für Änderungen
import { state, emit, on, loadCreds, saveCreds, setUser, setTrips, setSnapshot, applyEvent, applyLocal, persistSoon } from './state.js';
import { idbGet, idbSet } from './idb.js';
import { toast } from './ui.js';

const OUTBOX_KEY = 'outbox';
// Bei diesen Aktionen ist "gibt es nicht mehr / keine Berechtigung" beim Wiederholen kein Fehler
const QUIET_ON_REPEAT = new Set(['trip.delete', 'trip.leave', 'stop.delete', 'member.remove', 'media.delete', 'media.update']);

class Net {
  constructor() {
    this.ws = null;
    this.tries = 0;
    this.outbox = [];
    this.inflight = null;
    this.waiters = [];
    this.pending = new Map();
    this.reqId = 1;
    this.watching = null;
    this.lastMsgAt = 0;
    this.reconnectTimer = null;
    this.wsUrl = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws';
  }

  async start() {
    this.outbox = (await idbGet(OUTBOX_KEY)) || [];
    state.pending = this.outbox.length;
    this.connect();
    setInterval(() => this.heartbeat(), 15000);
    window.addEventListener('online', () => { this.dropSocket(); this.tries = 0; this.connect(true); });
    window.addEventListener('offline', () => { this.dropSocket(); this.setConn('offline'); });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible') return;
      if (!this.ws || this.ws.readyState > 1) this.connect(true);
      else this.probe();
    });
  }

  setConn(c) {
    if (state.conn === c) return;
    if (c === 'connecting') state.connectingSince = Date.now();
    state.conn = c;
    emit('conn');
  }

  // ---------- Verbindung ----------
  connect(now = false) {
    clearTimeout(this.reconnectTimer);
    if (this.ws && this.ws.readyState <= 1) return;
    if (!navigator.onLine) { this.setConn('offline'); this.scheduleReconnect(); return; }
    this.setConn(state.conn === 'online' ? 'connecting' : state.conn === 'anon' ? 'connecting' : (state.conn === 'offline' ? 'connecting' : state.conn));
    let ws;
    try { ws = new WebSocket(this.wsUrl); } catch { this.scheduleReconnect(); return; }
    this.ws = ws;
    let opened = false;
    const failTimer = setTimeout(() => { if (!opened) { try { ws.close(); } catch {} } }, 25000);
    ws.onopen = () => {
      opened = true;
      clearTimeout(failTimer);
      this.lastMsgAt = Date.now();
      this.tries = 0;
      this.login();
    };
    ws.onmessage = (ev) => { this.lastMsgAt = Date.now(); this.onMessage(ev.data); };
    ws.onclose = () => { clearTimeout(failTimer); this.handleClosed(ws); };
    ws.onerror = () => {};
  }

  handleClosed(ws) {
    if (this.ws !== ws) return;
    this.ws = null;
    this.inflight = null;
    for (const [, p] of this.pending) p.reject(Object.assign(new Error('Verbindung unterbrochen'), { code: 'offline' }));
    this.pending.clear();
    this.setConn(navigator.onLine ? 'connecting' : 'offline');
    this.scheduleReconnect();
  }

  // Tote Verbindung sofort verwerfen (z. B. Flugmodus), ohne auf das Schließen zu warten
  dropSocket() {
    const ws = this.ws;
    if (!ws) return;
    ws.onclose = null; ws.onmessage = null;
    try { ws.close(); } catch {}
    this.ws = null;
    this.handleClosedWith(ws);
  }
  handleClosedWith(ws) {
    this.ws = ws; // kurz zurücksetzen, damit handleClosed greift
    this.handleClosed(ws);
  }

  scheduleReconnect() {
    clearTimeout(this.reconnectTimer);
    const delay = Math.min(15000, 800 * 2 ** Math.min(this.tries, 5)) + Math.random() * 400;
    this.tries++;
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  heartbeat() {
    if (!this.ws || this.ws.readyState !== 1) return;
    if (Date.now() - this.lastMsgAt > 50000) { try { this.ws.close(); } catch {} return; }
    this.send({ t: 'ping' });
  }

  probe() {
    // Nach dem Aufwachen prüfen, ob die Verbindung noch lebt
    const before = this.lastMsgAt;
    this.send({ t: 'ping' });
    setTimeout(() => { if (this.lastMsgAt === before && this.ws) { try { this.ws.close(); } catch {} } }, 4000);
  }

  send(obj) {
    if (this.ws && this.ws.readyState === 1) { this.ws.send(JSON.stringify(obj)); return true; }
    return false;
  }

  login() {
    const creds = loadCreds();
    if (!creds) { this.setConn('anon'); this.release(); return; }
    this.send({ t: 'hello', userId: creds.id, secret: creds.secret });
  }

  // ---------- Nachrichten ----------
  onMessage(raw) {
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    // Wartende Aufrufer (register/recover)
    for (let i = 0; i < this.waiters.length; i++) {
      if (this.waiters[i].types.includes(m.t)) { const [w] = this.waiters.splice(i, 1); w.resolve(m); return; }
    }
    switch (m.t) {
      case 'welcome': this.onWelcome(m); break;
      case 'auth_failed':
        this.setConn('anon');
        emit('auth_failed');
        break;
      case 'trips': setTrips(m.trips); break;
      case 'ev': this.onEvent(m); break;
      case 'ack': this.onAck(m); break;
      default: break;
    }
  }

  async onWelcome(m) {
    setUser(m.user);
    saveCreds({ user: m.user, secret: loadCreds().secret });
    if (m.config) state.config = { ...state.config, ...m.config };
    setTrips(m.trips);
    this.setConn('online');
    await this.flush();
    if (this.watching) this.watch(this.watching).catch(() => {});
    this.release();
  }

  onEvent(m) {
    if (m.k === 'gone') {
      const reason = m.v.reason;
      applyLocal('trip.leave', { tripId: m.trip });
      if (this.watching === m.trip) this.watching = null;
      emit('gone', { tripId: m.trip, reason });
      return;
    }
    if (m.k === 'resync') { if (this.watching === m.trip) this.watch(m.trip).catch(() => {}); return; }
    applyEvent(m.trip, m.k, m.v);
  }

  onAck(m) {
    const p = this.pending.get(m.id);
    if (!p) return;
    this.pending.delete(m.id);
    if (m.ok) p.resolve(m.result); else p.reject(Object.assign(new Error(m.message || 'Fehler'), { code: m.code }));
  }

  // ---------- Aufrufe ----------
  waitFor(types, ms = 15000) {
    return new Promise((resolve, reject) => {
      const w = { types, resolve: (m) => { clearTimeout(t); resolve(m); } };
      const t = setTimeout(() => { this.waiters = this.waiters.filter((x) => x !== w); reject(new Error('Keine Antwort vom Server')); }, ms);
      this.waiters.push(w);
    });
  }

  // Wartet, bis die Verbindung steht (auch ohne Anmeldung)
  async open(ms = 20000) {
    if (this.ws && this.ws.readyState === 1 && (state.conn === 'online' || state.conn === 'anon')) return;
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => { off(); reject(Object.assign(new Error('Keine Verbindung zum Server'), { code: 'offline' })); }, ms);
      const off = on('conn', () => { if (state.conn === 'online' || state.conn === 'anon') { clearTimeout(t); off(); resolve(); } });
      if (state.conn === 'online' || state.conn === 'anon') { clearTimeout(t); off(); resolve(); }
    });
  }
  release() { emit('conn'); }

  // Direkter Aufruf mit Antwort (braucht Verbindung)
  async request(op, p = {}, ms = 20000) {
    if (!this.ws || this.ws.readyState !== 1 || state.conn !== 'online') {
      throw Object.assign(new Error('Du bist gerade offline.'), { code: 'offline' });
    }
    const id = 'r' + this.reqId++;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { this.pending.delete(id); reject(Object.assign(new Error('Der Server antwortet nicht.'), { code: 'timeout' })); }, ms);
      this.pending.set(id, { resolve: (v) => { clearTimeout(t); resolve(v); }, reject: (e) => { clearTimeout(t); reject(e); } });
      this.send({ t: 'op', id, op, p });
    });
  }

  // Änderung: sofort lokal anwenden, in die Warteschlange legen, senden sobald möglich
  mutate(op, p, { local = true } = {}) {
    if (local) applyLocal(op, p);
    return new Promise((resolve, reject) => {
      const item = { qid: 'q' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), op, p: stripLocal(p), ts: Date.now() };
      this.outbox.push(item);
      this.waitersByQid = this.waitersByQid || new Map();
      this.waitersByQid.set(item.qid, { resolve, reject });
      this.saveOutbox();
      this.flush();
    });
  }

  saveOutbox() {
    state.pending = this.outbox.length;
    emit('pending');
    idbSet(OUTBOX_KEY, this.outbox).catch(() => {});
  }

  async flush() {
    if (this.flushing) return;
    this.flushing = true;
    try {
      while (this.outbox.length && this.ws && this.ws.readyState === 1 && state.conn === 'online') {
        const item = this.outbox[0];
        try {
          const result = await this.request(item.op, item.p, 25000);
          this.outbox.shift();
          this.saveOutbox();
          this.waitersByQid?.get(item.qid)?.resolve(result);
          this.waitersByQid?.delete(item.qid);
        } catch (e) {
          if (e.code === 'offline' || e.code === 'timeout') {
            if (e.code === 'timeout' && this.ws) { try { this.ws.close(); } catch {} }
            break;
          }
          if (e.code === 'rate') { await new Promise((r) => setTimeout(r, 3000)); continue; }
          // Dauerhafter Fehler: Eintrag verwerfen und Zustand neu vom Server holen
          this.outbox.shift();
          this.saveOutbox();
          const quiet = QUIET_ON_REPEAT.has(item.op) && (e.code === 'not_found' || e.code === 'forbidden');
          if (!quiet) toast(e.message || 'Änderung konnte nicht gespeichert werden.', { error: true });
          this.waitersByQid?.get(item.qid)?.reject(e);
          this.waitersByQid?.delete(item.qid);
          this.resync();
        }
      }
    } finally {
      this.flushing = false;
    }
  }

  async resync() {
    try {
      const { trips } = await this.request('trips.list');
      setTrips(trips);
      if (this.watching) await this.watch(this.watching);
    } catch {}
  }

  // ---------- Reise beobachten ----------
  async watch(tripId) {
    this.watching = tripId;
    if (state.conn !== 'online') return null;
    if (this.outbox.length) await this.flush();
    const snap = await this.request('trip.open', { tripId });
    if (this.watching === tripId) setSnapshot(tripId, snap);
    return snap;
  }
  unwatch(tripId) {
    if (this.watching === tripId) this.watching = null;
    if (state.conn === 'online') this.request('trip.close', { tripId }).catch(() => {});
  }

  // ---------- Konto ----------
  async register(name) {
    await this.open();
    this.send({ t: 'register', name });
    const m = await this.waitFor(['registered', 'auth_error']);
    if (m.t === 'auth_error') throw Object.assign(new Error(m.message), { code: m.code });
    saveCreds({ user: m.user, secret: m.secret, recovery: m.recoveryCode });
    setUser(m.user);
    this.setConn('connecting');
    this.send({ t: 'hello', userId: m.user.id, secret: m.secret });
    return { user: m.user, recoveryCode: m.recoveryCode };
  }

  async recover(code) {
    await this.open();
    this.send({ t: 'recover', code });
    const m = await this.waitFor(['recovered', 'auth_error']);
    if (m.t === 'auth_error') throw Object.assign(new Error(m.message), { code: m.code });
    saveCreds({ user: m.user, secret: m.secret, recovery: code.toUpperCase() });
    setUser(m.user);
    this.setConn('connecting');
    this.send({ t: 'hello', userId: m.user.id, secret: m.secret });
    return m.user;
  }

  async peek(token) {
    await this.open();
    const id = 'p' + this.reqId++;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { this.pending.delete(id); reject(new Error('Keine Antwort vom Server')); }, 15000);
      this.pending.set(id, { resolve: (v) => { clearTimeout(t); resolve(v); }, reject: (e) => { clearTimeout(t); reject(e); } });
      this.send({ t: 'peek', id, token });
    });
  }

  // Wartet, bis die Anmeldung abgeschlossen ist
  async ready(ms = 30000) {
    if (state.conn === 'online') return;
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => { off(); reject(Object.assign(new Error('Keine Verbindung zum Server'), { code: 'offline' })); }, ms);
      const off = on('conn', () => { if (state.conn === 'online') { clearTimeout(t); off(); resolve(); } });
    });
  }
}

function stripLocal(p) {
  const out = {};
  for (const [k, v] of Object.entries(p)) if (k !== 'local') out[k] = v;
  return out;
}

export const net = new Net();
export { persistSoon };
