import { WebSocket } from 'ws';

// Kleiner Test-Client, der wie die App per WebSocket spricht
export class TestClient {
  constructor(url) {
    this.url = url;
    this.queue = [];
    this.waiters = [];
    this.nextId = 1;
    this.events = [];
  }
  async connect() {
    this.ws = new WebSocket(this.url);
    await new Promise((res, rej) => { this.ws.once('open', res); this.ws.once('error', rej); });
    this.ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      const w = this.waiters.findIndex((x) => x.match(msg));
      if (w >= 0) { const [waiter] = this.waiters.splice(w, 1); waiter.resolve(msg); } else this.queue.push(msg);
    });
    return this;
  }
  send(obj) { this.ws.send(JSON.stringify(obj)); }
  wait(match, ms = 3000) {
    const i = this.queue.findIndex(match);
    if (i >= 0) return Promise.resolve(this.queue.splice(i, 1)[0]);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('Timeout beim Warten auf Nachricht')), ms);
      this.waiters.push({ match, resolve: (m) => { clearTimeout(t); resolve(m); } });
    });
  }
  async register(name) {
    this.send({ t: 'register', name });
    const reg = await this.wait((m) => m.t === 'registered' || m.t === 'auth_error');
    if (reg.t !== 'registered') throw new Error(reg.message);
    this.creds = { userId: reg.user.id, secret: reg.secret };
    this.user = reg.user;
    this.recoveryCode = reg.recoveryCode;
    this.send({ t: 'hello', ...this.creds });
    await this.wait((m) => m.t === 'welcome');
    return this;
  }
  async op(op, p) {
    const id = String(this.nextId++);
    this.send({ t: 'op', id, op, p });
    const ack = await this.wait((m) => m.t === 'ack' && m.id === id);
    return ack;
  }
  async ok(op, p) {
    const ack = await this.op(op, p);
    if (!ack.ok) throw new Error(`${op} fehlgeschlagen: ${ack.code} ${ack.message}`);
    return ack.result;
  }
  event(kind, ms) { return this.wait((m) => m.t === 'ev' && m.k === kind, ms); }
  close() { try { this.ws.close(); } catch {} }
}
