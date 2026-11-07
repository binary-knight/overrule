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
import { Mesh, cleanPin } from '../lib/mesh.mjs';
import { expiring, HISTORY_LIMIT } from '../public/meeting-state.js';
import { createApp } from '../server.mjs';

const members = ['Alpha', 'Beta'].map((name, i) => ({ id: String(i), name, type: 'codex-cli', role: name }));
const options = { prompt: 'A new meeting', participants: members, drafterId: '0', cycles: 1, maxTokens: 4096, timeoutSeconds: 10, maxRevisions: 0 };
const block = fields => '\n```json\n' + JSON.stringify(fields) + '\n```';
const reply = prompt => /Write your OPENING POSITION/.test(prompt) ? 'Opening.' + block({ assumptions: [], risk: 'r', criteria: ['c'] })
  : /RATIFICATION BALLOT/.test(prompt) ? 'Approved.' + block({ vote: 'approve', objections: [], reason: 'ok' })
  : /You are the drafter/.test(prompt) ? 'Drafted.' + block({ version: 1, unresolved: [] })
  : 'Agreed.' + block({ stance: 'agree', concedes: [], objections: [], resolves: [], nominates: null });
const call = async (provider, request) => ({ text: reply(request.prompt), usage: { input: 1, output: 1 } });

async function setup(t) { const dir = await mkdtemp(join(tmpdir(), 'overrule-pin-')); t.after(() => rm(dir, { recursive: true, force: true })); return new Store(dir); }
async function finished(mesh, run) { for (let i = 0; i < 1000 && mesh.controllers.has(run.id); i++) await delay(10); assert.equal(mesh.controllers.has(run.id), false); }
// A history of stopped meetings, newest first, as runs.json holds it.
const past = n => Array.from({ length: n }, (_, i) => ({ id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, kind: 'meeting', prompt: `Meeting ${i}`, status: 'complete', createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, n - i)).toISOString(), participants: members, entries: [], issues: [] }));

test('tags and projects are cleaned, deduplicated, limited, and reuse the spelling already in use', () => {
  const others = [{ pin: { tags: ['Security', 'Q3'], project: 'Billing Rewrite' } }];
  assert.deepEqual(cleanPin({ tags: ['  security ', 'new   tag', 'NEW TAG', '', 'q3'], project: ' billing   rewrite ' }, others), { tags: ['Security', 'new tag', 'Q3'], project: 'Billing Rewrite' });
  assert.deepEqual(cleanPin({}, others), {}, 'nothing given, nothing changes');
  assert.deepEqual(cleanPin({ project: '  ' }), { project: '' });
  assert.throws(() => cleanPin({ tags: 'a,b' }), /Send tags as a list/);
  assert.throws(() => cleanPin({ tags: ['a,b'] }), /comma/);
  assert.throws(() => cleanPin({ tags: ['x'.repeat(33)] }), /32 characters/);
  assert.throws(() => cleanPin({ tags: Array.from({ length: 13 }, (_, i) => `t${i}`) }), /at most 12 tags/);
  assert.throws(() => cleanPin({ project: 'p'.repeat(61) }), /60 characters/);
  assert.throws(() => cleanPin({ project: 'bad\u0007name' }), /control character/);
  assert.deepEqual(cleanPin({ project: 'two\nlines' }), { project: 'two lines' }, 'line breaks are spacing');
});

test('pinned meetings are never pruned, however many meetings follow, and only unpinned ones count toward the limit', async t => {
  const store = await setup(t);
  const history = past(HISTORY_LIMIT + 3); // 33 stopped meetings, newest first
  const oldest = history.at(-1), middle = history[10];
  store.write('runs.json', history);
  const mesh = new Mesh(store, call);
  mesh.pin(mesh.runs.find(r => r.id === oldest.id), { project: 'Archive', tags: ['keep'] });
  mesh.pin(mesh.runs.find(r => r.id === middle.id));
  // 31 unpinned stopped meetings: exactly the oldest unpinned one is next to go, and nothing pinned is.
  const leaving = expiring(mesh.runs);
  assert.deepEqual([...leaving], [history.at(-2).id]);
  const run = mesh.create(options); await mesh.pruning; await finished(mesh, run);
  const ids = mesh.runs.map(r => r.id);
  assert.ok(ids.includes(oldest.id) && ids.includes(middle.id), 'pinned meetings survive');
  assert.ok(!ids.includes(history.at(-2).id), 'the oldest unpinned meeting was pruned');
  assert.equal(mesh.runs.filter(r => !r.pin && r.id !== run.id).length, HISTORY_LIMIT, 'the limit held when the new meeting started');
  // Many more meetings later, the pins are still there.
  for (let i = 0; i < 5; i++) { const next = mesh.create(options); await mesh.pruning; await finished(mesh, next); }
  // Pruning happens when a meeting starts, and the one starting does not count; once it finishes there is one over the limit,
  // and it is exactly the one flagged as leaving next.
  const unpinned = mesh.runs.filter(r => !r.pin);
  assert.equal(unpinned.length, HISTORY_LIMIT + 1);
  assert.deepEqual([...expiring(mesh.runs)], [unpinned.at(-1).id]);
  assert.deepEqual(mesh.runs.filter(r => r.pin).map(r => r.id).sort(), [oldest.id, middle.id].sort());
  assert.deepEqual(mesh.runs.find(r => r.id === oldest.id).pin.tags, ['keep']);
});

test('pins survive a restart with their tags and project; edits keep what is left out; unpinning clears them and warns when the meeting will go', async t => {
  const store = await setup(t);
  store.write('runs.json', past(HISTORY_LIMIT));
  let mesh = new Mesh(store, call);
  const target = mesh.runs.at(-1); // the oldest of exactly HISTORY_LIMIT meetings
  const pin = mesh.pin(target, { project: 'Billing', tags: ['decision', 'q3'] });
  assert.match(pin.pinnedAt, /^\d{4}-\d\d-\d\dT/);
  mesh = new Mesh(store, call); // restart
  const restored = mesh.runs.find(r => r.id === target.id);
  assert.deepEqual(restored.pin, pin);
  assert.deepEqual(mesh.pin(restored, { tags: ['decision'] }), { ...pin, tags: ['decision'] }, 'only the tags changed');
  assert.deepEqual(mesh.pin(restored, { project: '' }), { ...pin, tags: ['decision'], project: '' }, 'the project can be removed');
  assert.equal(mesh.pin(restored).pinnedAt, pin.pinnedAt, 'pinning again keeps its place');
  // A new meeting arrives while it is pinned; unpinned, it falls past the limit and is flagged.
  const run = mesh.create(options); await finished(mesh, run);
  assert.deepEqual(mesh.unpin(restored), { pin: null, expiring: true });
  assert.equal(restored.pin, undefined);
  assert.equal(new Mesh(store).runs.find(r => r.id === target.id).pin, undefined, 'the unpin is saved too');
  // Pinned meetings cannot be deleted until unpinned.
  mesh.pin(restored);
  await assert.rejects(mesh.remove(restored), /pinned\. Unpin it before deleting it/);
  mesh.unpin(restored);
  assert.equal((await mesh.remove(restored)).deleted, true);
  assert.throws(() => mesh.pin(restored), /was deleted/);
});

// ---------- HTTP and the command line ----------
async function serve(t, directory) {
  const app = createApp({ directory, addresses: [], providerCall: call, detect: async () => ({ codex: { installed: true, signedIn: true }, claude: { installed: true, signedIn: true } }) });
  await new Promise((resolve, reject) => { app.server.once('error', reject); app.server.listen(0, '127.0.0.1', resolve); });
  const close = async () => { app.server.closeAllConnections(); await new Promise(resolve => app.server.close(resolve)); };
  t.after(close);
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const bootstrap = await (await fetch(base + '/api/bootstrap')).json();
  return { ...app, base, bootstrap, close, headers: { 'Content-Type': 'application/json', 'X-Mesh-Token': bootstrap.token } };
}

test('the pin API needs the page token, validates its input, tells open streams, and its pins are there after the server restarts', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'overrule-pin-api-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const first = await serve(t, directory);
  const ids = first.bootstrap.providers.map(p => p.id);
  const created = await (await fetch(first.base + '/api/runs', { method: 'POST', headers: first.headers, body: JSON.stringify({ prompt: 'Keep this decision', participantIds: ids, drafterId: ids[0], cycles: 1 }) })).json();
  const path = `${first.base}/api/runs/${created.id}/pin`;
  // Pinned while still in session: whoever is watching sees it.
  const seen = []; first.mesh.listeners.set(created.id, new Set([value => seen.push(value.pin)]));
  assert.equal((await fetch(path, { method: 'PUT', body: '{}' })).status, 403, 'no token, no pin');
  const bad = await fetch(path, { method: 'PUT', headers: first.headers, body: JSON.stringify({ tags: ['a,b'] }) });
  assert.equal(bad.status, 400); assert.match((await bad.json()).error, /comma/);
  assert.equal((await fetch(`${first.base}/api/runs/nope/pin`, { method: 'PUT', headers: first.headers, body: '{}' })).status, 404);
  const pinned = await (await fetch(path, { method: 'PUT', headers: first.headers, body: JSON.stringify({ project: 'Platform', tags: ['arch'] }) })).json();
  assert.deepEqual([pinned.pin.project, pinned.pin.tags], ['Platform', ['arch']]);
  assert.ok(seen.some(pin => pin?.project === 'Platform'));
  first.mesh.listeners.delete(created.id);
  await finished(first.mesh, first.mesh.runs[0]);
  const summary = (await (await fetch(first.base + '/api/runs')).json())[0];
  assert.deepEqual(summary.pin, pinned.pin); assert.equal(summary.expiring, false);
  const refused = await fetch(`${first.base}/api/runs/${created.id}`, { method: 'DELETE', headers: first.headers });
  assert.equal(refused.status, 400); assert.match((await refused.json()).error, /pinned/);
  assert.match(await readFile(join(directory, 'runs.json'), 'utf8'), /"project": "Platform"/);

  // Restart the server on the same data directory.
  await first.close();
  const second = await serve(t, directory);
  const after = await (await fetch(second.base + '/api/runs')).json();
  assert.deepEqual(after.map(r => [r.id, r.pin]), [[created.id, pinned.pin]]);
  assert.deepEqual((await (await fetch(second.base + '/api/bootstrap')).json()).runs[0].pin, pinned.pin);
  const unpinned = await (await fetch(`${second.base}/api/runs/${created.id}/pin`, { method: 'DELETE', headers: second.headers })).json();
  assert.deepEqual(unpinned, { pin: null, expiring: false });
  assert.equal((await (await fetch(second.base + '/api/runs')).json())[0].pin, null);
});

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'overrule.mjs');
const cli = (url, args) => promisify(execFile)(process.execPath, [CLI, ...args], { env: { ...process.env, OVERRULE_URL: url } })
  .then(result => ({ code: 0, ...result })).catch(error => ({ code: error.code, stdout: error.stdout || '', stderr: error.stderr || '' }));

test('overrule pin, unpin, and list: pinned meetings are listed first with their project and tags', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'overrule-pin-cli-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const { base, headers, bootstrap, mesh } = await serve(t, directory);
  const ids = bootstrap.providers.map(p => p.id);
  const start = async prompt => { const run = await (await fetch(base + '/api/runs', { method: 'POST', headers, body: JSON.stringify({ prompt, participantIds: ids, drafterId: ids[0], cycles: 1 }) })).json(); await finished(mesh, mesh.runs.find(r => r.id === run.id)); return run.id; };
  const older = await start('Older meeting'), newer = await start('Newer meeting');

  const pinned = await cli(base, ['pin', older.slice(0, 8), '--project', 'Platform', '--tag', 'arch', '--tag', 'q3']);
  assert.equal(pinned.code, 0, pinned.stderr); assert.match(pinned.stdout, new RegExp(`Pinned ${older.slice(0, 8)} under Platform with #arch #q3`));
  const listed = (await cli(base, ['list'])).stdout;
  assert.match(listed, new RegExp(`^Pinned\\n${older.slice(0, 8)} .*Older meeting  \\[Platform\\]  #arch #q3\\n\\nRecent\\n${newer.slice(0, 8)} .*Newer meeting`));
  // Pinning again with only --tag keeps the project.
  const retagged = JSON.parse((await cli(base, ['pin', older, '--tag', 'final', '--json'])).stdout);
  assert.deepEqual([retagged.pin.project, retagged.pin.tags], ['Platform', ['final']]);
  const refused = await cli(base, ['delete', older, '--yes']);
  assert.equal(refused.code, 1); assert.match(refused.stderr, /is pinned\. Unpin it first/);
  assert.equal((await cli(base, ['unpin', newer])).code, 1, 'an unpinned meeting cannot be unpinned');
  const unpinned = await cli(base, ['unpin', older]);
  assert.equal(unpinned.code, 0, unpinned.stderr); assert.match(unpinned.stdout, /Unpinned/);
  assert.doesNotMatch((await cli(base, ['list'])).stdout, /Pinned/);
  assert.equal(mesh.runs.find(r => r.id === older).pin, undefined);
});
