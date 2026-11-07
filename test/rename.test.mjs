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
import { Mesh, cleanTitle, exportMarkdown, TITLE_LIMIT } from '../lib/mesh.mjs';
import { createApp } from '../server.mjs';

const members = ['Alpha', 'Beta'].map((name, i) => ({ id: String(i), name, type: 'codex-cli', role: name }));
const block = fields => '\n```json\n' + JSON.stringify(fields) + '\n```';
const phaseOf = prompt => /Write your OPENING POSITION/.test(prompt) ? 'opening' : /RATIFICATION BALLOT/.test(prompt) ? 'ratify' : /You are the drafter/.test(prompt) ? 'draft' : 'floor';
const reply = phase => phase === 'opening' ? 'Opening.' + block({ assumptions: [], risk: 'r', criteria: ['c'] }) : phase === 'draft' ? 'Drafted.' + block({ version: 1, unresolved: [] }) : phase === 'ratify' ? 'Approved.' + block({ vote: 'approve', objections: [], reason: 'ok' }) : 'Agreed.' + block({ stance: 'agree', concedes: [], objections: [], resolves: [], nominates: null });
async function finished(mesh, run) { for (let i = 0; i < 1000 && mesh.controllers.has(run.id); i++) await delay(10); assert.equal(mesh.controllers.has(run.id), false); }

test('a name is trimmed, spacing is normalized, and length and control characters are refused', () => {
  assert.equal(cleanTitle('  Queue   choice\nfor billing  '), 'Queue choice for billing');
  assert.equal(cleanTitle(''), ''); assert.equal(cleanTitle(undefined), ''); assert.equal(cleanTitle(null), '');
  assert.equal(cleanTitle('x'.repeat(TITLE_LIMIT)).length, TITLE_LIMIT);
  assert.throws(() => cleanTitle('x'.repeat(TITLE_LIMIT + 1)), /120 characters/);
  assert.throws(() => cleanTitle('bell\u0007'), /control character/);
  assert.throws(() => cleanTitle(42), /as text/);
});

test('a renamed meeting keeps its name across restarts, while every member still reads the original brief', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'overrule-rename-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new Store(dir), prompts = [];
  let failDraft = true;
  const mesh = new Mesh(store, async (provider, request) => {
    prompts.push(request.prompt);
    if (phaseOf(request.prompt) === 'draft' && failDraft) throw new Error('Rate limit');
    return { text: reply(phaseOf(request.prompt)) };
  });
  const run = mesh.create({ prompt: 'ORIGINAL BRIEF: choose a queue', participants: members, drafterId: '0', cycles: 1, maxTokens: 4096, timeoutSeconds: 10, maxRevisions: 0 });
  await finished(mesh, run); assert.equal(run.status, 'failed');
  assert.deepEqual(mesh.rename(run, '  Queue decision  '), { title: 'Queue decision' });
  assert.equal(run.prompt, 'ORIGINAL BRIEF: choose a queue', 'the brief is untouched');
  assert.match(exportMarkdown(run), /^# Overrule\n\n\*\*Queue decision\*\*\n\n/);
  // Restart, then resume: the name is still there, and the members are given the brief, never the name.
  const again = new Mesh(store, mesh.providerCall);
  const restored = again.runs.find(r => r.id === run.id);
  assert.equal(restored.title, 'Queue decision');
  failDraft = false; prompts.length = 0;
  again.resume(restored, members); await finished(again, restored);
  assert.equal(restored.status, 'complete', restored.error);
  assert.ok(prompts.length && prompts.every(p => p.includes('ORIGINAL BRIEF: choose a queue') && !p.includes('Queue decision')));
  assert.equal(new Mesh(store).runs[0].title, 'Queue decision', 'resuming kept the name');
  // An empty name clears it.
  assert.deepEqual(again.rename(restored, ''), { title: null });
  assert.equal(restored.title, undefined); assert.equal(new Mesh(store).runs[0].title, undefined);
  assert.doesNotMatch(exportMarkdown(restored), /\*\*Queue decision\*\*/);
});

async function serve(t, directory) {
  const app = createApp({ directory, addresses: [], providerCall: async (p, r) => ({ text: reply(phaseOf(r.prompt)) }), detect: async () => ({ codex: { installed: true, signedIn: true }, claude: { installed: true, signedIn: true } }) });
  await new Promise((resolve, reject) => { app.server.once('error', reject); app.server.listen(0, '127.0.0.1', resolve); });
  const close = async () => { app.server.closeAllConnections(); await new Promise(resolve => app.server.close(resolve)); };
  t.after(close);
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const bootstrap = await (await fetch(base + '/api/bootstrap')).json();
  return { ...app, base, bootstrap, close, headers: { 'Content-Type': 'application/json', 'X-Mesh-Token': bootstrap.token } };
}

test('renaming over HTTP needs the page token, validates the name, is listed, and survives a server restart', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'overrule-rename-api-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const first = await serve(t, directory);
  const ids = first.bootstrap.providers.map(p => p.id);
  const created = await (await fetch(first.base + '/api/runs', { method: 'POST', headers: first.headers, body: JSON.stringify({ prompt: 'The brief as written', participantIds: ids, drafterId: ids[0], cycles: 1 }) })).json();
  await finished(first.mesh, first.mesh.runs[0]);
  const path = `${first.base}/api/runs/${created.id}/title`;
  assert.equal((await fetch(path, { method: 'PUT', body: JSON.stringify({ title: 'x' }) })).status, 403, 'no token, no rename');
  const tooLong = await fetch(path, { method: 'PUT', headers: first.headers, body: JSON.stringify({ title: 'x'.repeat(121) }) });
  assert.equal(tooLong.status, 400); assert.match((await tooLong.json()).error, /120 characters/);
  assert.equal((await fetch(`${first.base}/api/runs/nope/title`, { method: 'PUT', headers: first.headers, body: '{}' })).status, 404);
  assert.deepEqual(await (await fetch(path, { method: 'PUT', headers: first.headers, body: JSON.stringify({ title: 'Launch plan' }) })).json(), { title: 'Launch plan' });
  const summary = (await (await fetch(first.base + '/api/runs')).json())[0];
  assert.deepEqual([summary.title, summary.prompt], ['Launch plan', 'The brief as written']);
  assert.match(await (await fetch(`${first.base}/api/runs/${created.id}/export`)).text(), /\*\*Launch plan\*\*/);
  assert.match(await readFile(join(directory, 'runs.json'), 'utf8'), /"title": "Launch plan"/);

  await first.close();
  const second = await serve(t, directory);
  assert.equal((await (await fetch(second.base + '/api/runs')).json())[0].title, 'Launch plan');
  assert.equal((await (await fetch(`${second.base}/api/runs/${created.id}`)).json()).title, 'Launch plan');
  assert.deepEqual(await (await fetch(`${second.base}/api/runs/${created.id}/title`, { method: 'PUT', headers: second.headers, body: JSON.stringify({ title: '' }) })).json(), { title: null });
  assert.equal((await (await fetch(second.base + '/api/runs')).json())[0].title, null);
});

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'overrule.mjs');
const cli = (url, args) => promisify(execFile)(process.execPath, [CLI, ...args], { env: { ...process.env, OVERRULE_URL: url } })
  .then(result => ({ code: 0, ...result })).catch(error => ({ code: error.code, stdout: error.stdout || '', stderr: error.stderr || '' }));

test('overrule rename sets and clears a name, and list shows the name in place of the brief', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'overrule-rename-cli-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const { base, headers, bootstrap, mesh } = await serve(t, directory);
  const ids = bootstrap.providers.map(p => p.id);
  const { id } = await (await fetch(base + '/api/runs', { method: 'POST', headers, body: JSON.stringify({ prompt: 'A long brief about queues', participantIds: ids, drafterId: ids[0], cycles: 1 }) })).json();
  await finished(mesh, mesh.runs[0]);
  assert.match((await cli(base, ['rename', id.slice(0, 8)])).stderr, /Give the new name/);
  const renamed = await cli(base, ['rename', id.slice(0, 8), 'Queue', 'decision']);
  assert.equal(renamed.code, 0, renamed.stderr); assert.match(renamed.stdout, /Renamed .* to "Queue decision"/);
  const listed = (await cli(base, ['list'])).stdout;
  assert.match(listed, /Queue decision/); assert.doesNotMatch(listed, /A long brief about queues/);
  assert.equal(JSON.parse((await cli(base, ['show', id, '--json'])).stdout).title, 'Queue decision');
  const cleared = await cli(base, ['rename', id, '']);
  assert.equal(cleared.code, 0, cleared.stderr); assert.match(cleared.stdout, /listed by its brief again/);
  assert.match((await cli(base, ['list'])).stdout, /A long brief about queues/);
});
