import { networkInterfaces } from 'node:os';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export function lanAddresses() {
  return [...new Set(Object.values(networkInterfaces()).flat().filter(a => a && a.family === 'IPv4' && !a.internal).map(a => a.address))];
}

function equal(a, b) {
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export class Access {
  constructor(store, addresses = lanAddresses()) {
    this.addresses = addresses; this.store = store; this.attempts = new Map();
    // The code is the key to sandboxed code execution on this host, so it is new on every start and can be rotated on demand.
    this.rotate();
  }
  rotate() {
    this.code = randomBytes(24).toString('base64url');
    this.sessionKey = randomBytes(32);
    this.rotatedAt = new Date().toISOString();
    this.store.write('lan.json', { pairingCode: this.code, rotatedAt: this.rotatedAt });
    return this.code;
  }
  urls(port) { return this.addresses.map(address => `http://${address}:${port}`); }
  allowedHost(host, port) { return ['localhost', '127.0.0.1', ...this.addresses].some(address => host === `${address}:${port}`); }
  local(req, port) {
    return ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress) && [`localhost:${port}`, `127.0.0.1:${port}`].includes(req.headers.host);
  }
  sign(expiry) { return createHmac('sha256', this.sessionKey).update(expiry).digest('base64url'); }
  authenticated(req) {
    const token = (req.headers.cookie || '').split(';').map(c => c.trim()).find(c => c.startsWith('mesh_session='))?.slice(13);
    if (!token) return false;
    const [expiry, signature, extra] = token.split('.');
    if (extra || !/^\d+$/.test(expiry) || !signature || Number(expiry) <= Date.now()) return false;
    return equal(signature, this.sign(expiry));
  }
  unlock(req, code) {
    const now = Date.now(), address = req.socket.remoteAddress;
    for (const [ip, record] of this.attempts) if (now - record.since > 60_000) this.attempts.delete(ip);
    const record = this.attempts.get(address) || { since: now, count: 0 };
    if (record.count >= 6 || this.attempts.size > 500) return { status: 429, error: 'Too many attempts. Wait a minute and try again.' };
    record.count++; this.attempts.set(address, record);
    if (typeof code !== 'string' || !equal(code.trim(), this.code)) return { status: 401, error: 'That pairing code is incorrect.' };
    this.attempts.delete(address);
    const expiry = String(now + 24 * 60 * 60 * 1000);
    return { status: 200, cookie: `mesh_session=${expiry}.${this.sign(expiry)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400` };
  }
}
