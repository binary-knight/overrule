import { mkdirSync, readFileSync, writeFileSync, renameSync, chmodSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';

export class Store {
  constructor(directory) {
    this.directory = directory;
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
    const keyPath = join(directory, 'vault.key');
    if (!existsSync(keyPath)) writeFileSync(keyPath, randomBytes(32), { mode: 0o600, flag: 'wx' });
    this.key = readFileSync(keyPath);
    if (this.key.length !== 32) throw new Error('Invalid vault key. Restore data/vault.key from your backup.');
  }
  read(name, fallback) {
    try { return JSON.parse(readFileSync(join(this.directory, name), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
  }
  write(name, value) {
    const file = join(this.directory, name);
    writeFileSync(file + '.tmp', JSON.stringify(value, null, 2), { mode: 0o600 });
    renameSync(file + '.tmp', file);
  }
  encrypt(secret) {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const data = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64');
  }
  decrypt(value) {
    if (!value) return '';
    const bytes = Buffer.from(value, 'base64');
    const cipher = createDecipheriv('aes-256-gcm', this.key, bytes.subarray(0, 12));
    cipher.setAuthTag(bytes.subarray(12, 28));
    return Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString('utf8');
  }
}
