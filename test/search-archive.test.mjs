import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { Store } from '../lib/store.mjs';
import { Mesh } from '../lib/mesh.mjs';
import { searchRuns, parseQuery } from '../lib/search.mjs';
import { expiring } from '../public/meeting-state.js';
import { createApp, validateHistoryLimit } from '../server.mjs';

const members = ['Alpha', 'Beta'].map((name, i) => ({ id: String(i), name, type: 'codex-cli', role: name }));
const options = { prompt: 'A new meeting', participants: members, drafterId: '0', cycles: 1, maxTokens: 4096, timeoutSeconds: 10, maxRevisions: 0 };
const block = fields => '\n```json\n' + JSON.stringify(fields) + '\n```';
const phaseOf = prompt => /Write your OPENING POSITION/.test(prompt) ? 'opening' : /RATIFICATION BALLOT/.test(prompt) ? 'ratify' : /You are the drafter/.test(prompt) ? 'draft' : 'floor';
const reply = phase => phase === 'opening' ? 'Opening.' + block({ assumptions: [], risk: 'r', criteria: ['c'] }) : phase === 'draft' ? 'Drafted.' + block({ version: 1, unresolved: [] }) : phase === 'ratify' ? 'Approved.' + block({ vote: 'approve', objections: [], reason: 'ok' }) : 'Agreed.' + block({ stance: 'agree', concedes: [], objections: [], resolves: [], nominates: null });
const call = async (provider, request) => ({ text: reply(phaseOf(request.prompt)), usage: { input: 1, output: 1 } });
async function finished(mesh, run) { for (let i = 0; i < 1000 && mesh.controllers.has(run.id); i++) await delay(10); assert.equal(mesh.controllers.has(run.id), false); }
const past = (n, prefix = '0') => Array.from({ length: n }, (_, i) => ({ id: `${prefix.repeat(8)}-0000-4000-8000-${String(i).padStart(12, '0')}`, kind: 'meeting', prompt: `Meeting ${i}`, status: 'complete', createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, n - i)).toISOString(), participants: members, entries: [], issues: [] }));
async function setup(t) { const dir = await mkdtemp(join(tmpdir(), 'overrule-search-')); t.after(() => rm(dir, { recursive: true, force: true })); return new Store(dir); }

// ---------- search ----------
const sample = () => [
  { id: 'aaaa1111', status: 'complete', title: 'Queue decision', prompt: 'Choose a message queue for billing events', pin: { tags: ['Architecture', 'q3'], project: 'Billing' }, participants: [{ name: 'Codex' }], final: 'Use Postgres with SKIP LOCKED for now.', entries: [{ name: 'Codex', text: 'Kafka is overkill; the CONNECTION POOL is the real limit.' }] },
  { id: 'bbbb2222', status: 'complete', prompt: 'Plan the Ärger-free launch of the mobile app', workspace: { name: 'mobile-app' }, attachments: [{ name: 'roadmap.pdf' }], entries: [] },
  { id: 'cccc3333', status: 'running', demo: true, prompt: 'Show me how Overrule works', entries: [{ name: 'Demo', text: 'Small is right.' }] },
];

test('queries are words and quoted phrases, compared without case', () => {
  assert.deepEqual(parseQuery('  Postgres "connection  pool"  postgres "unclosed '), ['postgres', 'connection pool', 'unclosed']);
  assert.deepEqual(parseQuery(''), []); assert.deepEqual(parseQuery('""'), []);
  assert.equal(parseQuery(Array.from({ length: 20 }, (_, i) => `w${i}`).join(' ')).length, 12);
});

test('search finds meetings by name, tags, brief, details, answer, and transcript, requires every term, and says where it matched', () => {
  const runs = sample();
  assert.equal(searchRuns(runs, '   '), null, 'no terms, no filtering');
  const where = query => Object.fromEntries([...searchRuns(runs, query)].map(([id, m]) => [id, m.field]));
  assert.deepEqual(where('queue'), { aaaa1111: 'name' }, 'the name is found first, and needs no excerpt');
  assert.equal(searchRuns(runs, 'queue').get('aaaa1111').snippet, null);
  assert.deepEqual(where('architecture'), { aaaa1111: 'tags' });
  assert.deepEqual(where('billing'), { aaaa1111: 'tags' }, 'a project is searched with the tags');
  assert.deepEqual(where('mobile'), { bbbb2222: 'brief' });
  assert.deepEqual(where('roadmap.pdf'), { bbbb2222: 'details' });
  assert.deepEqual(where('skip locked'), { aaaa1111: 'answer' });
  assert.deepEqual(where('"connection pool"'), { aaaa1111: 'transcript' });
  assert.deepEqual(where('kafka postgres'), { aaaa1111: 'answer' }, 'terms may be found in different places');
  assert.deepEqual(where('kafka mobile'), {}, 'every term must be found');
  assert.deepEqual(where('"pool connection"'), {}, 'a phrase keeps its order');
  assert.deepEqual(where('ärger'), { bbbb2222: 'brief' }, 'case is ignored beyond ASCII');
  assert.deepEqual(where('bbbb22'), { bbbb2222: 'details' }, 'an id prefix finds its meeting');
  assert.deepEqual(where('scripted'), { cccc3333: 'brief' }, 'a demo is found as one');
  assert.deepEqual(where('small'), { cccc3333: 'transcript' }, 'a meeting in session is searched as it stands');
  // The excerpt is cut from the original text, keeping its case, around the match.
  assert.equal(searchRuns(runs, 'pool').get('aaaa1111').snippet, 'Codex: Kafka is overkill; the CONNECTION POOL is the real limit.');
  const long = [{ id: 'x', status: 'complete', prompt: 'intro '.repeat(40) + 'NEEDLE ' + 'outro '.repeat(40), entries: [] }];
  const cut = searchRuns(long, 'needle').get('x').snippet;
  assert.match(cut, /^….*NEEDLE.*…$/); assert.ok(cut.length < 200);
});

test('search sees a rename, pin, or new text at once, despite remembering stopped meetings between searches', () => {
  const runs = sample();
  assert.equal(searchRuns(runs, 'ledger').size, 0); // this search also fills the cache the rest must see past
  runs[1].title = 'Ledger launch'; assert.deepEqual([...searchRuns(runs, 'ledger').keys()], ['bbbb2222']);
  runs[1].pin = { tags: ['finance'], project: '' }; assert.deepEqual([...searchRuns(runs, 'finance').keys()], ['bbbb2222']);
  runs[1].final = 'Ship on Tuesday.'; assert.deepEqual([...searchRuns(runs, 'tuesday').keys()], ['bbbb2222']);
  runs[2].entries.push({ name: 'Demo', text: 'A brand new turn' }); assert.deepEqual([...searchRuns(runs, 'brand new').keys()], ['cccc3333']);
});

// ---------- retention, archive, and the configurable limit ----------
test('the history limit is configurable, Infinity removes nothing, and archived meetings never count', () => {
  const runs = past(6);
  assert.deepEqual([...expiring(runs, 4)], [runs[4].id, runs[5].id]);
  assert.equal(expiring(runs, Infinity).size, 0); assert.equal(expiring(runs, null).size, 0);
  runs[5].archived = { at: 'x' }; runs[4].pin = { tags: [] };
  assert.equal(expiring(runs, 4).size, 0, 'pinned and archived meetings are not counted');
  // A number, at least one; no fixed ceiling, only the room the disk has when that is known. "max" follows the disk; an older
  // file's null ("keep every meeting") is read as "max".
  assert.equal(validateHistoryLimit('max'), 'max'); assert.equal(validateHistoryLimit(null), 'max');
  assert.equal(validateHistoryLimit('25'), 25); assert.equal(validateHistoryLimit(5_000_000), 5_000_000);
  for (const bad of [0, -1, 2.5, 'many', '', Infinity, 2 ** 60]) assert.throws(() => validateHistoryLimit(bad), /at least one meeting/);
  assert.equal(validateHistoryLimit(100, 100), 100);
  assert.throws(() => validateHistoryLimit(101, 100), /safe room for about 100 meetings/);
});

test('archived meetings are kept in full however low the limit, cannot be resumed, and rejoin the queue when unarchived', async t => {
  const store = await setup(t);
  store.write('runs.json', past(5));
  const mesh = new Mesh(store, call); mesh.historyLimit = 2;
  const [a, b, c, d, e] = mesh.runs;
  mesh.rename(e, 'Oldest, archived'); mesh.pin(e, { tags: ['keep'] });
  assert.deepEqual(mesh.archive(e).archived.at.length > 0, true);
  mesh.archive(d);
  assert.deepEqual([...expiring(mesh.runs, 2)], [c.id]);
  const run = mesh.create(options); await mesh.pruning; await finished(mesh, run);
  assert.deepEqual(mesh.runs.map(r => r.id).sort(), [run.id, a.id, b.id, d.id, e.id].sort(), 'only the unarchived meeting past the limit went');
  // Everything about the archived meetings survives, including a restart.
  const again = new Mesh(store, call); again.historyLimit = 2;
  const kept = again.runs.find(r => r.id === e.id);
  assert.deepEqual([kept.title, kept.pin.tags, Boolean(kept.archived)], ['Oldest, archived', ['keep'], true]);
  assert.throws(() => again.resume(kept, members), /archived\. Unarchive it before resuming/);
  await assert.rejects(again.reconvene(kept, members, { text: 'more', cycles: 1 }), /archived\. Unarchive it before reconvening/);
  // Unarchived and unpinned, an old meeting is next to go; unarchived but pinned, it is safe.
  assert.deepEqual(again.unarchive(again.runs.find(r => r.id === d.id)), { archived: null, expiring: true });
  assert.deepEqual(again.unarchive(kept), { archived: null, expiring: false });
  // A meeting in session cannot be archived.
  let release; const hold = new Promise(resolve => { release = resolve; });
  const slow = new Mesh(await setup(t), async (p, r) => { await hold; return call(p, r); });
  const live = slow.create(options);
  assert.throws(() => slow.archive(live), /in session\. Stop it before archiving it/);
  release(); await finished(slow, live);
  slow.archive(live); assert.ok(live.archived);
});

test('with no limit and room to spare nothing is pruned, and a lower limit prunes down to it at the next start', async t => {
  const store = await setup(t);
  store.write('runs.json', past(8));
  const mesh = new Mesh(store, call); mesh.historyLimit = Infinity;
  for (let i = 0; i < 3; i++) { const run = mesh.create(options); await mesh.pruning; await finished(mesh, run); }
  assert.equal(mesh.runs.length, 11, 'nothing removed');
  mesh.historyLimit = 3;
  const run = mesh.create(options); await mesh.pruning; await finished(mesh, run);
  assert.equal(mesh.runs.length, 4, 'three kept, plus the one that was starting');
});

// ---------- HTTP ----------
async function serve(t, directory, extra = {}) {
  const app = createApp({ directory, addresses: [], providerCall: call, ...extra, detect: async () => ({ codex: { installed: true, signedIn: true }, claude: { installed: true, signedIn: true } }) });
  await new Promise((resolve, reject) => { app.server.once('error', reject); app.server.listen(0, '127.0.0.1', resolve); });
  const close = async () => { app.server.closeAllConnections(); await new Promise(resolve => app.server.close(resolve)); };
  t.after(close);
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const bootstrap = await (await fetch(base + '/api/bootstrap')).json();
  const headers = { 'Content-Type': 'application/json', 'X-Mesh-Token': bootstrap.token };
  return { ...app, base, bootstrap, close, headers, put: (path, data) => fetch(base + path, { method: 'PUT', headers, body: JSON.stringify(data) }) };
}

test('settings are saved on the host, survive a restart, report storage and room, and say what a lower limit will remove', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'overrule-settings-')); t.after(() => rm(directory, { recursive: true, force: true }));
  new Store(directory).write('runs.json', past(5));
  // A disk of 100 GB with 80 GB free: meetings may grow by 40 GB, which at 256 KB a meeting is 163,840 more.
  const disk = async () => ({ bsize: 1024, blocks: 100 * 1024 ** 2, bavail: 80 * 1024 ** 2 });
  const first = await serve(t, directory, { statfs: disk });
  assert.deepEqual(first.bootstrap.settings, { historyLimit: 30, effectiveLimit: 30, room: 163845 });
  const shown = await (await fetch(first.base + '/api/settings')).json();
  assert.equal(shown.historyLimit, 30); assert.ok(shown.storage.meetingsBytes > 0); assert.equal(shown.storage.freeBytes, 80 * 1024 ** 3);
  assert.deepEqual([shown.capacity.more, shown.capacity.room, shown.capacity.low], [163840, 163845, false]);
  assert.equal(shown.policy.shareOfFree, 0.5);
  assert.equal((await fetch(first.base + '/api/settings', { method: 'PUT', body: '{"historyLimit":3}' })).status, 403, 'no token, no change');
  for (const bad of [0, 'x', 1.5]) assert.match((await (await first.put('/api/settings', { historyLimit: bad })).json()).error, /at least one meeting/);
  assert.match((await (await first.put('/api/settings', { historyLimit: 163846 })).json()).error, /safe room for about 163,845 meetings/);
  assert.equal((await (await first.put('/api/settings', { historyLimit: 163845 })).json()).historyLimit, 163845, 'the whole room may be used');
  assert.deepEqual(await (await first.put('/api/settings', { historyLimit: 3 })).json(), { historyLimit: 3, effectiveLimit: 3, room: 163845, expiring: 2 });
  assert.equal((await (await fetch(first.base + '/api/runs')).json()).filter(r => r.expiring).length, 2, 'the history marks them');
  await first.close();
  const second = await serve(t, directory, { statfs: disk });
  assert.deepEqual(second.bootstrap.settings, { historyLimit: 3, effectiveLimit: 3, room: 163845 }, 'kept across a restart');
  assert.deepEqual(JSON.parse(await readFile(join(directory, 'settings.json'), 'utf8')), { historyLimit: 3 });
  const ids = second.bootstrap.providers.map(p => p.id);
  await fetch(second.base + '/api/runs', { method: 'POST', headers: second.headers, body: JSON.stringify({ prompt: 'Next', participantIds: ids, drafterId: ids[0], cycles: 1 }) });
  assert.equal((await (await fetch(second.base + '/api/runs')).json()).length, 4, 'the next start applied the saved limit');
  await finished(second.mesh, second.mesh.runs[0]);
  const max = await (await second.put('/api/settings', { historyLimit: 'max' })).json();
  assert.equal(max.historyLimit, 'max'); assert.equal(max.room, 163844, 'the four meetings the list holds now, plus 163,840 more'); assert.equal(max.effectiveLimit, max.room - 1, 'one slot goes to the next meeting to start'); assert.equal(max.expiring, 0);
  assert.equal((await (await fetch(second.base + '/api/runs')).json()).filter(r => r.expiring).length, 0);
});

test('an older settings file that kept every meeting is read as "as many as the disk safely holds"', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'overrule-settings-old-')); t.after(() => rm(directory, { recursive: true, force: true }));
  new Store(directory).write('settings.json', { historyLimit: null });
  const app = await serve(t, directory, { statfs: async () => ({ bsize: 1024, blocks: 100 * 1024 ** 2, bavail: 80 * 1024 ** 2 }) });
  assert.equal(app.bootstrap.settings.historyLimit, 'max');
});

test('search and archive over HTTP: matches say where they were found, archived meetings are flagged and kept across restarts', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'overrule-archive-api-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const runs = past(3); runs[0].prompt = 'Pick a database for the side project'; runs[1].final = 'Postgres wins on operations.'; runs[2].title = 'Launch plan';
  new Store(directory).write('runs.json', runs);
  const first = await serve(t, directory);
  const found = await (await fetch(first.base + '/api/runs?q=' + encodeURIComponent('postgres'))).json();
  assert.deepEqual(found.map(r => [r.id, r.match.field, r.match.snippet]), [[runs[1].id, 'answer', 'Postgres wins on operations.']]);
  assert.equal((await (await fetch(first.base + '/api/runs?q=')).json()).length, 3, 'an empty query lists everything');
  assert.equal((await (await fetch(first.base + '/api/runs')).json())[0].match, undefined);
  assert.equal((await fetch(`${first.base}/api/runs/${runs[0].id}/archive`, { method: 'PUT' })).status, 403);
  const archived = await (await first.put(`/api/runs/${runs[0].id}/archive`, {})).json();
  assert.match(archived.archived.at, /^\d{4}-/);
  const listed = await (await fetch(first.base + '/api/runs?q=database')).json();
  assert.deepEqual(listed.map(r => [r.id, Boolean(r.archived)]), [[runs[0].id, true]], 'search reaches the archive, flagged');
  const refusal = await fetch(`${first.base}/api/runs/${runs[0].id}/resume`, { method: 'POST', headers: first.headers, body: '{}' });
  assert.match((await refusal.json()).error, /archived/);
  await first.close();
  const second = await serve(t, directory);
  assert.ok((await (await fetch(second.base + '/api/runs')).json()).find(r => r.id === runs[0].id).archived, 'still archived after a restart');
  assert.deepEqual(await (await fetch(`${second.base}/api/runs/${runs[0].id}/archive`, { method: 'DELETE', headers: second.headers })).json(), { archived: null, expiring: false });
});

// ---------- the command line ----------
const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'overrule.mjs');
const cli = (url, args) => promisify(execFile)(process.execPath, [CLI, ...args], { env: { ...process.env, OVERRULE_URL: url } })
  .then(result => ({ code: 0, ...result })).catch(error => ({ code: error.code, stdout: error.stdout || '', stderr: error.stderr || '' }));

test('overrule list searches and filters, archive and unarchive move meetings, and settings changes the limit', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'overrule-archive-cli-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const runs = past(3); runs[0].prompt = 'Pick a queue'; runs[1].prompt = 'Review the auth flow'; runs[1].pin = { pinnedAt: '2026-01-01T00:00:00Z', tags: ['security'], project: 'Platform' }; runs[2].prompt = 'Queue retries';
  new Store(directory).write('runs.json', runs);
  const { base } = await serve(t, directory);
  const searched = (await cli(base, ['list', '--search', 'queue'])).stdout;
  assert.match(searched, /Pick a queue/); assert.match(searched, /Queue retries/); assert.doesNotMatch(searched, /auth flow/);
  assert.match(searched, /brief: Queue retries/, 'where it matched');
  const tagged = (await cli(base, ['list', '--tag', 'SECURITY'])).stdout;
  assert.match(tagged, /Review the auth flow/); assert.doesNotMatch(tagged, /queue/i);
  assert.match((await cli(base, ['list', '--project', 'platform'])).stdout, /auth flow/);
  assert.match((await cli(base, ['list', '--search', 'nothing-like-this'])).stdout, /No meetings match/);
  const archived = await cli(base, ['archive', runs[0].id]);
  assert.equal(archived.code, 0, archived.stderr); assert.match(archived.stdout, /Archived/);
  assert.doesNotMatch((await cli(base, ['list'])).stdout, /Pick a queue/);
  assert.match((await cli(base, ['list', '--archived'])).stdout, /Pick a queue.*\(archived /);
  assert.match((await cli(base, ['list', '--archived', '--search', 'auth'])).stdout, /The Archive is empty for that search/);
  assert.match((await cli(base, ['unarchive', runs[0].id])).stdout, /Unarchived/);
  assert.match((await cli(base, ['settings'])).stdout, /keeps the 30 most recent meetings/);
  const lowered = await cli(base, ['settings', '--keep', '1']);
  assert.equal(lowered.code, 0, lowered.stderr); assert.match(lowered.stdout, /keeps the 1 most recent[\s\S]*1 meeting is past that limit/);
  assert.match((await cli(base, ['settings', '--keep', 'max'])).stdout, /keeps as many meetings as the disk safely holds/);
  assert.match((await cli(base, ['settings', '--keep', 'all'])).stdout, /as many meetings as the disk safely holds/, '"all" still works, meaning the same');
  assert.match((await cli(base, ['settings'])).stdout, /Room: meetings may use [\d.]+ [KMG]B more \(half the free space, keeping [\d.]+ GB free\)\. At about 256 KB a meeting, that is [\d,]+ more: up to [\d,]+ in all\./);
  assert.match((await cli(base, ['settings', '--keep', 'lots'])).stderr, /--keep takes a number/);
});
