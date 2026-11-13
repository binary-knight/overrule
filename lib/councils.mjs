// Saved councils on the host, in data/councils.json, so the browser, paired devices and the command line share them. A council
// names its seats (connection ids) and keeps whichever setting groups its owner chose; the limits are the ones a meeting enforces.
import { randomUUID } from 'node:crypto';
import { GROUP_IDS, MAX_SEATS } from '../public/councils.js';

export const MAX_COUNCILS = 50;
const FILE = 'councils.json';
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const whole = (value, min, max, message) => {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(message);
  return n;
};

// The setting groups a council keeps, each checked as a meeting would check it. Returns them in a fixed order and shape, so two
// councils with the same settings compare equal.
export function validateSettings(settings, seats) {
  if (settings === undefined || settings === null) return {};
  if (!isObject(settings)) throw new Error('Council settings must be an object.');
  const unknown = Object.keys(settings).filter(id => !GROUP_IDS.includes(id));
  if (unknown.length) throw new Error(`A council cannot keep ${unknown.join(', ')}. It keeps ${GROUP_IDS.join(', ')}.`);
  const out = {};
  if ('drafter' in settings) {
    const d = settings.drafter;
    if (!isObject(d) || !seats.includes(d.drafterId)) throw new Error('The council’s drafter must be one of its seats.');
    const neutralDrafter = d.neutralDrafter === true;
    if (neutralDrafter && seats.length < 3) throw new Error('A neutral drafter needs at least three seats: two to argue and one to write.');
    out.drafter = { drafterId: d.drafterId, neutralDrafter };
  }
  if ('cycles' in settings) out.cycles = whole(settings.cycles, 1, 4, 'A council’s meeting length is 1 to 4 cycles.');
  if ('revisions' in settings) out.revisions = whole(settings.revisions, 0, 5, 'A council allows 0 to 5 revisions.');
  if ('research' in settings) {
    const r = settings.research;
    if (!isObject(r)) throw new Error('Research settings must be an object.');
    out.research = { research: r.research === true || r.deepResearch === true, deepResearch: r.deepResearch === true };
  }
  if ('limits' in settings) {
    const l = settings.limits;
    if (!isObject(l)) throw new Error('Limits must be an object.');
    out.limits = {
      maxCalls: l.maxCalls === null || l.maxCalls === undefined || l.maxCalls === '' ? null : whole(l.maxCalls, 1, 1000, 'Use a session call limit between 1 and 1,000, or leave it automatic.'),
      maxDurationSeconds: whole(l.maxDurationSeconds ?? 3600, 60, 86400, 'Use a session time limit between 1 minute and 24 hours.'),
      maxTokens: whole(l.maxTokens ?? 4096, 256, 32768, 'Use an output limit between 256 and 32,768 tokens.'),
      timeoutSeconds: whole(l.timeoutSeconds ?? 180, 10, 3600, 'Use a time limit per call between 10 and 3,600 seconds.'),
    };
  }
  return out;
}

export function validateCouncil(input, providers) {
  if (!isObject(input)) throw new Error('Expected a council.');
  const name = String(input.name ?? '').replace(/\s+/g, ' ').trim();
  if (!name || name.length > 60 || /[\x00-\x1f\x7f]/.test(name)) throw new Error('Give the council a name of 1 to 60 characters.');
  const purpose = String(input.purpose ?? '').replace(/\s+/g, ' ').trim();
  if (purpose.length > 200) throw new Error('Keep the purpose under 200 characters.');
  if (!Array.isArray(input.seats)) throw new Error('Choose the council’s seats.');
  const seats = [...new Set(input.seats.map(String))];
  if (seats.length < 2 || seats.length > MAX_SEATS) throw new Error(`A council seats 2 to ${MAX_SEATS} members.`);
  const missing = seats.filter(id => !providers.some(p => p.id === id));
  if (missing.length) throw new Error('One of the council’s seats is not a saved connection.');
  return { name, purpose, seats, settings: validateSettings(input.settings, seats) };
}

// A council as the browser and the command line see it: its seats with their names, and whether it still has enough of them.
export function publicCouncil(council, providers) {
  const names = Object.fromEntries(providers.map(p => [p.id, p.name]));
  return { ...council, seatNames: council.seats.map(id => names[id] || id), incomplete: council.seats.length < 2 };
}

export class Councils {
  constructor(store) {
    this.store = store;
    const saved = store.read(FILE, []);
    this.list = Array.isArray(saved) ? saved.filter(c => isObject(c) && typeof c.id === 'string' && typeof c.name === 'string' && Array.isArray(c.seats)) : [];
  }
  save() { this.store.write(FILE, this.list); }
  find(id) { return this.list.find(c => c.id === id) || null; }
  byName(name, except = null) { const wanted = String(name).trim().toLowerCase(); return this.list.find(c => c.name.toLowerCase() === wanted && c.id !== except) || null; }
  // Saving under a name in use replaces that council only when asked to; otherwise the answer says so, and the caller can ask.
  create(input, providers) {
    const council = validateCouncil(input, providers);
    const existing = this.byName(council.name);
    if (existing && input.replace !== true) throw Object.assign(new Error(`A council called “${existing.name}” already exists.`), { httpStatus: 409, code: 'exists' });
    const now = new Date().toISOString();
    if (existing) return this.replace(existing, council, now);
    if (this.list.length >= MAX_COUNCILS) throw new Error(`You can save up to ${MAX_COUNCILS} councils.`);
    const saved = { id: randomUUID(), ...council, createdAt: now, updatedAt: now };
    this.list.push(saved); this.save();
    return saved;
  }
  update(id, input, providers) {
    const existing = this.find(id);
    if (!existing) throw Object.assign(new Error('Council not found.'), { httpStatus: 404 });
    const council = validateCouncil(input, providers);
    if (this.byName(council.name, id)) throw Object.assign(new Error(`A council called “${council.name}” already exists. Choose another name.`), { httpStatus: 409, code: 'exists' });
    return this.replace(existing, council, new Date().toISOString());
  }
  replace(existing, council, now) {
    const saved = { id: existing.id, ...council, createdAt: existing.createdAt, updatedAt: now };
    this.list = this.list.map(c => c.id === existing.id ? saved : c); this.save();
    return saved;
  }
  remove(id) {
    const existing = this.find(id);
    if (!existing) throw Object.assign(new Error('Council not found.'), { httpStatus: 404 });
    this.list = this.list.filter(c => c.id !== id); this.save();
    return existing;
  }
  // A connection was deleted: it leaves every council that seated it. A drafter that was that connection is forgotten, and a
  // neutral drafter with fewer than three seats left is no longer neutral. Says what changed, so the owner can be told.
  withoutConnection(providerId) {
    const changes = [];
    this.list = this.list.map(council => {
      if (!council.seats.includes(providerId)) return council;
      const seats = council.seats.filter(id => id !== providerId);
      const settings = { ...council.settings };
      const notes = [];
      if (settings.drafter?.drafterId === providerId) { delete settings.drafter; notes.push('its drafter was that connection, so it no longer names one'); }
      else if (settings.drafter?.neutralDrafter && seats.length < 3) { settings.drafter = { ...settings.drafter, neutralDrafter: false }; notes.push('too few seats remain for a neutral drafter'); }
      changes.push({ id: council.id, name: council.name, seatsLeft: seats.length, notes });
      return { ...council, seats, settings, updatedAt: new Date().toISOString() };
    });
    if (changes.length) this.save();
    return changes;
  }
}
