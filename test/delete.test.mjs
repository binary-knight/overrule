import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Readable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { Store } from '../lib/store.mjs';
import { Mesh, latestCandidate } from '../lib/mesh.mjs';
import { Attachments } from '../lib/attachments.mjs';
import { git, removeWorktree } from '../lib/workspace.mjs';
import { createApp } from '../server.mjs';
import { main } from '../bin/overrule.mjs';

const members = ['Alpha', 'Beta'].map((name, i) => ({ id: String(i), name, type: 'codex-cli', role: name }));
const options = { prompt: 'Implement the requested change', participants: members, drafterId: '0', cycles: 1, maxTokens: 4096, timeoutSeconds: 10, maxRevisions: 0 };
const block = fields => '\n```json\n' + JSON.stringify(fields) + '\n```';
const phaseOf = prompt => /Write your OPENING POSITION/.test(prompt) ? 'opening' : /RATIFICATION BALLOT/.test(prompt) ? 'ratify' : /You are the drafter|You are the IMPLEMENTER/.test(prompt) ? 'draft' : 'floor';
const reply = phase => phase === 'opening' ? 'Opening.' + block({ assumptions: [], risk: 'r', criteria: ['c'] }) : phase === 'draft' ? 'Implemented.' + block({ version: 1, unresolved: [] }) : phase === 'ratify' ? 'Approved.' + block({ vote: 'approve', objections: [], reason: 'ok' }) : 'Agreed.' + block({ stance: 'agree', concedes: [], objections: [], resolves: [], nominates: null });
let drafts = 0;
const implementation = async (provider, request) => {
  const phase = phaseOf(request.prompt);
  if (phase === 'draft' && request.cwd) await writeFile(join(request.cwd, 'result.txt'), `implementation ${++drafts}\n`); // every candidate differs, so each leaves a patch
  return { text: reply(phase) };
};
const checks = async commands => commands.map(command => ({ command, code: 0, output: 'passed', seconds: 0 }));

async function finished(mesh, run) {
  for (let i = 0; i < 1000 && mesh.controllers.has(run.id); i++) await delay(10);
  assert.equal(mesh.controllers.has(run.id), false, 'meeting did not stop');
}
async function commit(path, message) {
  await git(path, ['add', '-A']);
  await git(path, ['-c', 'user.name=Test', '-c', 'user.email=test@localhost', 'commit', '-q', '-m', message]);
}
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'overrule-delete-'));
  const store = new Store(join(root, 'data')), project = join(root, 'project');
  await mkdir(project); await git(project, ['init', '-q', '-b', 'main']);
  await writeFile(join(project, 'README.md'), 'base\n'); await commit(project, 'base');
  const attachments = new Attachments(store.directory);
  t.after(async () => {
    for (const run of store.read('runs.json', [])) for (const key of ['impl', 'review', 'checkWorktree']) if (run.workspace?.[key]) await removeWorktree(project, run.workspace[key]);
    await rm(root, { recursive: true, force: true });
  });
  return { root, store, project, attachments, workspace: { path: project, level: 'workspace-write', checks: ['verify'] } };
}
const branches = async project => (await git(project, ['branch', '--list', '--format=%(refname:short)'])).trim().split('\n').filter(Boolean);
const artifacts = async store => { try { return await readdir(join(store.directory, 'artifacts')); } catch { return []; } };
async function withDocument(attachments, runId, text) {
  const meta = await attachments.stage('notes.txt', Readable.from([Buffer.from(text)]));
  return attachments.claim([meta.id], runId);
}

test('deleting a meeting removes its record, documents, patch, and candidate branch, and leaves other meetings alone', async t => {
  const { store, project, attachments, workspace } = await fixture(t);
  const mesh = new Mesh(store, implementation, { runChecks: checks, attachments });
  const keepId = '11111111-1111-4111-8111-111111111111', goneId = '22222222-2222-4222-8222-222222222222';
  const keep = mesh.create({ ...options, id: keepId, prompt: 'Keep me', workspace, attachments: await withDocument(attachments, keepId, 'kept text') }); await finished(mesh, keep);
  const gone = mesh.create({ ...options, id: goneId, prompt: 'Delete me', workspace, attachments: await withDocument(attachments, goneId, 'secret text') }); await finished(mesh, gone);
  assert.equal(keep.status, 'complete', keep.error); assert.equal(gone.status, 'complete', gone.error);
  // Everything the meeting left on the host before deletion.
  assert.ok(existsSync(join(store.directory, 'attachments', goneId)));
  assert.ok((await artifacts(store)).some(name => name.startsWith(goneId)));
  assert.ok((await branches(project)).includes(gone.workspace.branch));
  assert.match(await readFile(join(store.directory, 'runs.json'), 'utf8'), /Delete me/);

  const result = await mesh.remove(gone);
  assert.deepEqual(result, { id: goneId, deleted: true, removed: { branch: gone.workspace.branch, checkouts: 0, documents: 1, patches: 1 } });
  assert.ok(!existsSync(join(store.directory, 'attachments', goneId)));
  assert.ok(!(await artifacts(store)).some(name => name.startsWith(goneId)));
  assert.ok(!(await branches(project)).includes(gone.workspace.branch));
  const saved = await readFile(join(store.directory, 'runs.json'), 'utf8');
  assert.doesNotMatch(saved, /Delete me/); assert.doesNotMatch(saved, new RegExp(goneId));
  assert.deepEqual(mesh.runs.map(r => r.id), [keepId]);
  assert.deepEqual(new Mesh(store).runs.map(r => r.id), [keepId], 'a restart does not bring it back');
  // The other meeting is untouched, and the owner's tree never changed.
  assert.ok(existsSync(join(store.directory, 'attachments', keepId)));
  assert.ok((await artifacts(store)).some(name => name.startsWith(keepId)));
  assert.ok((await branches(project)).includes(keep.workspace.branch));
  assert.deepEqual(await branches(project), ['main', keep.workspace.branch].sort());
  assert.equal(existsSync(join(project, 'result.txt')), false);
  // Nothing can act on it afterwards.
  await assert.rejects(mesh.remove(gone), /was deleted/);
  assert.throws(() => mesh.resume(gone, members), /was deleted/);
  await assert.rejects(mesh.reconvene(gone, members, { text: 'again', cycles: 1 }), /was deleted/);
  await assert.rejects(mesh.applyCandidate(gone), /was deleted/);
});

test('a meeting in session cannot be deleted until it is stopped, and an interrupted implementation checkout goes with it', async t => {
  const { store, project, workspace } = await fixture(t);
  let drafting; const inDraft = new Promise(resolve => { drafting = resolve; });
  const mesh = new Mesh(store, async (provider, request) => {
    if (phaseOf(request.prompt) === 'draft') { await writeFile(join(request.cwd, 'partial.txt'), 'half done\n'); drafting(); await delay(30_000, null, { signal: request.signal }); }
    return implementation(provider, request);
  }, { runChecks: checks });
  const run = mesh.create({ ...options, workspace }); await inDraft;
  await assert.rejects(mesh.remove(run), /in session\. Stop it before deleting it/);
  mesh.cancel(run.id);
  await assert.rejects(mesh.remove(run), /in session|still stopping/);
  await finished(mesh, run);
  assert.equal(run.status, 'cancelled');
  const impl = run.workspace.impl; assert.ok(impl && existsSync(join(impl, 'partial.txt')), 'the partial implementation was kept for resume');
  const result = await mesh.remove(run);
  assert.equal(result.removed.checkouts, 1); assert.equal(result.removed.branch, run.workspace.branch);
  assert.ok(!existsSync(impl));
  assert.deepEqual(await branches(project), ['main']);
  assert.doesNotMatch(await git(project, ['worktree', 'list']), new RegExp(impl));
  assert.deepEqual(mesh.runs, []);
});

test('deleting refuses, and removes nothing, while the candidate branch is checked out in the owner’s tree', async t => {
  const { store, project, workspace } = await fixture(t);
  const mesh = new Mesh(store, implementation, { runChecks: checks });
  const run = mesh.create({ ...options, workspace }); await finished(mesh, run);
  assert.equal(run.status, 'complete', run.error);
  await git(project, ['checkout', '-q', run.workspace.branch]);
  await assert.rejects(mesh.remove(run), new RegExp(`${run.workspace.branch} is checked out in ${project}`));
  assert.equal(mesh.runs.length, 1); assert.ok((await artifacts(store)).length);
  assert.ok((await branches(project)).includes(run.workspace.branch));
  await git(project, ['checkout', '-q', 'main']);
  assert.equal((await mesh.remove(run)).removed.branch, run.workspace.branch);
  assert.deepEqual(await branches(project), ['main']); assert.deepEqual(await artifacts(store), []);
});

test('an applied candidate keeps its merge when the meeting is deleted; a vanished workspace does not block deletion', async t => {
  const { store, project, workspace, root } = await fixture(t);
  const mesh = new Mesh(store, implementation, { runChecks: checks });
  const applied = mesh.create({ ...options, workspace }); await finished(mesh, applied);
  const candidate = latestCandidate(applied);
  await mesh.applyCandidate(applied);
  await mesh.remove(applied);
  assert.deepEqual(await branches(project), ['main']);
  assert.equal((await git(project, ['rev-parse', 'HEAD^2'])).trim(), candidate.hash, 'the applied merge stays in main');
  assert.ok(existsSync(join(project, 'result.txt')));
  // A discarded candidate has no branch left, and a workspace folder that was moved away has nothing to clean.
  const discarded = mesh.create({ ...options, workspace }); await finished(mesh, discarded);
  await mesh.discardCandidate(discarded);
  assert.equal((await mesh.remove(discarded)).removed.branch, null);
  const orphan = mesh.create({ ...options, workspace }); await finished(mesh, orphan);
  await rm(project, { recursive: true, force: true });
  const result = await mesh.remove(orphan);
  assert.equal(result.removed.branch, null); assert.equal(result.removed.patches, 1);
  assert.deepEqual(mesh.runs, []); assert.deepEqual(await artifacts(store), []);
  assert.ok(existsSync(root));
});

test('a delete is refused while another action holds the meeting, and no action can start while it is being deleted', async t => {
  const { store, workspace } = await fixture(t);
  const mesh = new Mesh(store, implementation, { runChecks: checks });
  const run = mesh.create({ ...options, workspace }); await finished(mesh, run);
  const applying = mesh.applyCandidate(run);
  await assert.rejects(mesh.remove(run), /still in progress/);
  await applying;
  const deleting = mesh.remove(run);
  await assert.rejects(mesh.applyCandidate(run), /being deleted/);
  assert.throws(() => mesh.resume(run, members), /being deleted/);
  await deleting;
  assert.deepEqual(mesh.runs, []);
});

// ---------- meetings pushed out of the history ----------
// Thirty newer stopped meetings in front of the ones given, so the next meeting to start pushes the given ones out.
const filler = i => ({ id: `f0000000-0000-4000-8000-${String(i).padStart(12, '0')}`, kind: 'meeting', prompt: `Newer ${i}`, status: 'complete', createdAt: new Date().toISOString(), participants: members, entries: [], issues: [] });
function bury(mesh) { mesh.runs.unshift(...Array.from({ length: 30 }, (_, i) => filler(i))); mesh.save(); }

test('a meeting pushed past the history limit is removed as completely as Delete removes it', async t => {
  const { store, project, attachments, workspace } = await fixture(t);
  const mesh = new Mesh(store, implementation, { runChecks: checks, attachments });
  const oldId = '33333333-3333-4333-8333-333333333333';
  const old = mesh.create({ ...options, id: oldId, prompt: 'Aged out', workspace, attachments: await withDocument(attachments, oldId, 'old text') }); await finished(mesh, old);
  assert.equal(old.status, 'complete', old.error);
  const branch = old.workspace.branch;
  assert.ok(existsSync(join(store.directory, 'attachments', oldId)) && (await artifacts(store)).length === 1 && (await branches(project)).includes(branch));
  bury(mesh);
  const next = mesh.create({ ...options, prompt: 'The meeting that pushes it out' });
  assert.deepEqual(await mesh.pruning, [true]);
  await finished(mesh, next);
  assert.ok(!mesh.runs.some(r => r.id === oldId));
  assert.ok(!existsSync(join(store.directory, 'attachments', oldId)), 'documents and extracted text removed');
  assert.deepEqual(await artifacts(store), [], 'patch removed');
  assert.deepEqual(await branches(project), ['main'], 'candidate branch removed');
  assert.doesNotMatch(await readFile(join(store.directory, 'runs.json'), 'utf8'), /Aged out/);
  assert.ok(!new Mesh(store).runs.some(r => r.id === oldId), 'and it stays gone after a restart');
});

test('a meeting that cannot be removed completely stays in the history with the reason, and goes at a later start', async t => {
  const { store, project, workspace } = await fixture(t);
  const mesh = new Mesh(store, implementation, { runChecks: checks });
  const old = mesh.create({ ...options, prompt: 'Branch in use', workspace }); await finished(mesh, old);
  await git(project, ['checkout', '-q', old.workspace.branch]); // the owner is looking at the candidate
  bury(mesh);
  const first = mesh.create(options);
  assert.deepEqual(await mesh.pruning, [false]); await finished(mesh, first);
  const kept = mesh.runs.find(r => r.id === old.id);
  assert.ok(kept, 'nothing is half-removed: the meeting is still listed');
  assert.match(kept.pruneBlocked, new RegExp(`${old.workspace.branch} is checked out in ${project}`));
  assert.ok((await artifacts(store)).length && (await branches(project)).includes(old.workspace.branch));
  assert.equal(new Mesh(store).runs.find(r => r.id === old.id).pruneBlocked, kept.pruneBlocked, 'the reason is saved');
  await git(project, ['checkout', '-q', 'main']);
  const second = mesh.create(options);
  // The meeting that finished first is now over the limit as well, so both go.
  assert.deepEqual(await mesh.pruning, [true, true]); await finished(mesh, second);
  assert.ok(!mesh.runs.some(r => r.id === old.id));
  assert.deepEqual(await branches(project), ['main']); assert.deepEqual(await artifacts(store), []);
});

// ---------- the HTTP API and the command line ----------
async function serve(t, providerCall) {
  const directory = await mkdtemp(join(tmpdir(), 'overrule-delete-api-'));
  const app = createApp({ directory, addresses: [], providerCall, detect: async () => ({ codex: { installed: true, signedIn: true }, claude: { installed: true, signedIn: true } }) });
  await new Promise((resolve, reject) => { app.server.once('error', reject); app.server.listen(0, '127.0.0.1', resolve); });
  t.after(async () => { app.server.closeAllConnections(); await new Promise(resolve => app.server.close(resolve)); await rm(directory, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const bootstrap = await (await fetch(base + '/api/bootstrap')).json();
  const headers = { 'Content-Type': 'application/json', 'X-Mesh-Token': bootstrap.token };
  return { ...app, directory, base, bootstrap, headers };
}

test('DELETE /api/runs/:id needs the page token, refuses a meeting in session, and removes the meeting for every client', async t => {
  let release; const hold = new Promise(resolve => { release = resolve; });
  const { base, headers, bootstrap, mesh, directory } = await serve(t, async (provider, request) => {
    if (/Write your OPENING POSITION/.test(request.prompt)) await Promise.race([hold, delay(30_000, null, { signal: request.signal })]);
    return { text: reply(phaseOf(request.prompt)), usage: { input: 1, output: 1 } };
  });
  const ids = bootstrap.providers.map(p => p.id);
  const created = await (await fetch(base + '/api/runs', { method: 'POST', headers, body: JSON.stringify({ prompt: 'A meeting to delete', participantIds: ids, drafterId: ids[0], cycles: 1 }) })).json();
  const path = `${base}/api/runs/${created.id}`;
  // Follow it the way the browser does, to see the stream told and closed.
  const stream = await fetch(path + '/events'); const reader = stream.body.getReader(); const decoder = new TextDecoder(); let streamed = '';
  const drained = (async () => { for (;;) { const { value, done } = await reader.read(); if (done) return; streamed += decoder.decode(value); } })();

  assert.equal((await fetch(path, { method: 'DELETE' })).status, 403, 'no token, no delete');
  const refused = await fetch(path, { method: 'DELETE', headers });
  assert.equal(refused.status, 400); assert.match((await refused.json()).error, /in session\. Stop it before deleting it/);
  assert.equal((await fetch(`${base}/api/runs/${created.id}/cancel`, { method: 'POST', headers })).status, 200);
  release(); await finished(mesh, mesh.runs[0]);
  assert.equal((await (await fetch(path)).json()).status, 'cancelled');
  // A stream still open on a stopped meeting hears about the delete and ends.
  const listeners = mesh.listeners.get(created.id); assert.ok(listeners?.size);

  const deleted = await fetch(path, { method: 'DELETE', headers });
  assert.equal(deleted.status, 200); assert.deepEqual((await deleted.json()).deleted, true);
  await drained; assert.match(streamed, /"deleted":true/);
  assert.equal((await fetch(path)).status, 404);
  assert.deepEqual(await (await fetch(base + '/api/runs')).json(), []);
  assert.deepEqual((await (await fetch(base + '/api/bootstrap')).json()).runs, []);
  assert.equal((await fetch(path, { method: 'DELETE', headers })).status, 404);
  assert.equal((await fetch(`${path}/resume`, { method: 'POST', headers, body: '{}' })).status, 404);
  assert.doesNotMatch(await readFile(join(directory, 'runs.json'), 'utf8'), /A meeting to delete/);
});

test('starting a meeting over HTTP answers once the meetings it pushed out are gone, documents and patches included', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'overrule-prune-api-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const oldId = '44444444-4444-4444-8444-444444444444';
  const store = new Store(directory);
  store.write('runs.json', [...Array.from({ length: 30 }, (_, i) => filler(i)), { ...filler(99), id: oldId, prompt: 'Old one', attachments: [{ id: '55555555-5555-4555-8555-555555555555', name: 'a.txt', size: 1, sha256: 'x', chars: 1 }], documents: { state: 'text-kept' } }]);
  await mkdir(join(directory, 'attachments', oldId, '55555555-5555-4555-8555-555555555555'), { recursive: true });
  await writeFile(join(directory, 'attachments', oldId, '55555555-5555-4555-8555-555555555555', 'text.txt'), 'kept text');
  await mkdir(join(directory, 'artifacts')); await writeFile(join(directory, 'artifacts', `${oldId}-v1.patch`), 'diff');
  const app = createApp({ directory, addresses: [], providerCall: async (p, r) => ({ text: reply(phaseOf(r.prompt)) }), detect: async () => ({ codex: { installed: true, signedIn: true }, claude: { installed: true, signedIn: true } }) });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { app.server.closeAllConnections(); await new Promise(resolve => app.server.close(resolve)); });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const bootstrap = await (await fetch(base + '/api/bootstrap')).json();
  const listed = bootstrap.runs.find(r => r.id === oldId);
  assert.equal(listed.expiring, true, 'the history says it goes next');
  const ids = bootstrap.providers.map(p => p.id);
  const created = await fetch(base + '/api/runs', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Mesh-Token': bootstrap.token }, body: JSON.stringify({ prompt: 'New', participantIds: ids, drafterId: ids[0], cycles: 1 }) });
  assert.equal(created.status, 201);
  assert.ok(!(await (await fetch(base + '/api/runs')).json()).some(r => r.id === oldId), 'gone from the very next listing');
  assert.ok(!existsSync(join(directory, 'attachments', oldId))); assert.ok(!existsSync(join(directory, 'artifacts', `${oldId}-v1.patch`)));
  await finished(app.mesh, app.mesh.runs[0]);
});

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'overrule.mjs');
const cli = (url, args) => promisify(execFile)(process.execPath, [CLI, ...args], { env: { ...process.env, OVERRULE_URL: url } })
  .then(result => ({ code: 0, ...result })).catch(error => ({ code: error.code, stdout: error.stdout || '', stderr: error.stderr || '' }));

test('overrule delete confirms first, needs --yes without a terminal, and refuses an ambiguous id', async t => {
  const { base, headers, bootstrap, mesh } = await serve(t, async (provider, request) => ({ text: reply(phaseOf(request.prompt)), usage: { input: 1, output: 1 } }));
  const ids = bootstrap.providers.map(p => p.id);
  const start = async prompt => { const run = await (await fetch(base + '/api/runs', { method: 'POST', headers, body: JSON.stringify({ prompt, participantIds: ids, drafterId: ids[0], cycles: 1 }) })).json(); await finished(mesh, mesh.runs.find(r => r.id === run.id)); return run.id; };
  const first = await start('First meeting'), second = await start('Second meeting');

  const unconfirmed = await cli(base, ['delete', first.slice(0, 8)]);
  assert.equal(unconfirmed.code, 1); assert.match(unconfirmed.stderr, /Pass --yes/);
  assert.equal(mesh.runs.length, 2);
  const noId = await cli(base, ['delete', '', '--yes']);
  assert.equal(noId.code, 1); assert.match(noId.stderr, /needs a meeting id/);
  // Two meetings whose ids share a prefix: a prefix that names both deletes neither.
  const twin = id => ({ id, prompt: 'Twin', status: 'complete', createdAt: new Date().toISOString(), kind: 'meeting', participants: [], entries: [], issues: [] });
  mesh.runs.push(twin('abcdef01-0000-4000-8000-000000000001'), twin('abcdef02-0000-4000-8000-000000000002'));
  const both = await cli(base, ['delete', 'abcdef0', '--yes']);
  assert.equal(both.code, 1); assert.match(both.stderr, /abcdef0 matches 2 meetings/); assert.equal(mesh.runs.length, 4);
  assert.equal((await cli(base, ['delete', 'abcdef01', '--yes'])).code, 0);
  assert.equal((await cli(base, ['delete', 'abcdef02', '--yes'])).code, 0);

  // Asked on a terminal: "no" keeps it, "yes" deletes it.
  const lines = [];
  await assert.rejects(main(['delete', first, '--url', base], { out: line => lines.push(line), err: () => {}, confirm: async question => { assert.match(question, /First meeting[\s\S]*permanently\?[\s\S]*candidate branch/); return false; } }), /Not deleted/);
  assert.equal(mesh.runs.length, 2);
  assert.equal(await main(['delete', first, '--url', base], { out: line => lines.push(line), err: () => {}, confirm: async () => true }), 0);
  assert.match(lines.at(-1), new RegExp(`Deleted ${first.slice(0, 8)}`));
  const confirmed = await cli(base, ['delete', second, '--yes', '--json']);
  assert.equal(confirmed.code, 0, confirmed.stderr); assert.equal(JSON.parse(confirmed.stdout).deleted, true);
  assert.deepEqual(mesh.runs, []);
  const missing = await cli(base, ['delete', second, '--yes']);
  assert.equal(missing.code, 1); assert.match(missing.stderr, /No meeting starts with/);
});
