import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Store } from '../lib/store.mjs';
import { Mesh, latestCandidate } from '../lib/mesh.mjs';
import { activeMembers, plan, latestStance } from '../lib/meeting.mjs';
import { git, runChecks, removeWorktree, commitCandidate } from '../lib/workspace.mjs';

const members = ['Alpha', 'Beta', 'Gamma'].map((name, i) => ({ id: String(i), name, type: 'codex-cli', role: name }));
const options = { prompt: 'Implement the requested change', participants: members.slice(0, 2), drafterId: '0', cycles: 1, maxTokens: 4096, timeoutSeconds: 10, maxRevisions: 0 };
const block = fields => '\n```json\n' + JSON.stringify(fields) + '\n```';
const turn = fields => 'A floor contribution.' + block({ stance: 'agree', concedes: [], objections: [], resolves: [], nominates: null, ...fields });
const phaseOf = prompt => /Write your OPENING POSITION/.test(prompt) ? 'opening' : /RATIFICATION BALLOT/.test(prompt) ? 'ratify' : /You are the drafter|You are the IMPLEMENTER/.test(prompt) ? 'draft' : 'floor';
const reply = phase => phase === 'opening' ? 'Opening.' + block({ assumptions: [], risk: 'Unverified', criteria: ['correct'] }) : phase === 'draft' ? 'Implemented.' + block({ version: 1, unresolved: [] }) : phase === 'ratify' ? 'Approved.' + block({ vote: 'approve', objections: [], reason: 'Reviewed' }) : turn();
const result = command => ({ command, code: 0, output: 'passed', seconds: 0 });

async function finished(mesh, run) {
  for (let i = 0; i < 1000 && mesh.controllers.has(run.id); i++) await delay(10);
  assert.equal(mesh.controllers.has(run.id), false, 'meeting did not stop');
  assert.notEqual(run.status, 'running');
}
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'mesh-reliability-'));
  const store = new Store(join(root, 'data')), project = join(root, 'project');
  await mkdir(project); await git(project, ['init', '-q', '-b', 'main']);
  await writeFile(join(project, 'README.md'), 'base\n');
  await commit(project, 'base');
  t.after(async () => {
    // Retained implementation checkouts live outside the fixture root.
    for (const run of store.read('runs.json', [])) for (const key of ['impl', 'review', 'checkWorktree']) if (run.workspace?.[key]) await removeWorktree(project, run.workspace[key]);
    await rm(root, { recursive: true, force: true });
  });
  return { store, project, workspace: { path: project, level: 'workspace-write', checks: ['verify'] } };
}
async function commit(path, message) {
  await git(path, ['add', '-A']);
  await git(path, ['-c', 'user.name=Test', '-c', 'user.email=test@localhost', 'commit', '-q', '-m', message]);
  return (await git(path, ['rev-parse', 'HEAD'])).trim();
}
const implementation = async (provider, request) => {
  const phase = phaseOf(request.prompt);
  if (phase === 'draft') await writeFile(join(request.cwd, 'result.txt'), 'reviewed content\n');
  return { text: reply(phase) };
};

test('Apply merges the recorded commit even when the candidate branch advances', async t => {
  const { store, project, workspace } = await fixture(t);
  const mesh = new Mesh(store, implementation, { runChecks: async commands => commands.map(result) });
  const run = mesh.create({ ...options, workspace }); await finished(mesh, run);
  assert.equal(run.status, 'complete', run.error);
  const candidate = latestCandidate(run);
  await git(project, ['checkout', '-q', run.workspace.branch]);
  await writeFile(join(project, 'unreviewed.txt'), 'must not be applied\n');
  const later = await commit(project, 'unreviewed change');
  await git(project, ['checkout', '-q', 'main']);
  const applied = await mesh.applyCandidate(run);
  assert.equal(applied.hash, candidate.hash);
  assert.equal(await readFile(join(project, 'result.txt'), 'utf8'), 'reviewed content\n');
  assert.equal(existsSync(join(project, 'unreviewed.txt')), false);
  assert.equal((await git(project, ['rev-parse', 'HEAD^2'])).trim(), candidate.hash);
  assert.equal((await git(project, ['rev-parse', run.workspace.branch])).trim(), later);
});

test('checks may change files, but voters inspect a clean checkout of the recorded commit', async t => {
  const { store, workspace } = await fixture(t);
  let checkPath, reviewPath, votedHash;
  const mesh = new Mesh(store, async (provider, request) => {
    if (phaseOf(request.prompt) === 'ratify') {
      reviewPath = request.cwd;
      votedHash = (await git(reviewPath, ['rev-parse', 'HEAD'])).trim();
      assert.equal(await readFile(join(reviewPath, 'result.txt'), 'utf8'), 'reviewed content\n');
      assert.equal(existsSync(join(reviewPath, 'generated.txt')), false);
      assert.equal((await git(reviewPath, ['status', '--porcelain'])).trim(), '');
    }
    return implementation(provider, request);
  }, { runChecks: async (commands, cwd) => {
    checkPath = cwd;
    await writeFile(join(cwd, 'result.txt'), 'changed by a check\n');
    await writeFile(join(cwd, 'generated.txt'), 'generated by a check\n');
    return commands.map(result);
  } });
  const run = mesh.create({ ...options, workspace }); await finished(mesh, run);
  assert.equal(run.status, 'complete', run.error);
  assert.notEqual(checkPath, reviewPath);
  assert.equal(votedHash, latestCandidate(run).hash);
  assert.equal(run.entries.find(e => e.phase === 'ratify').candidateHash, votedHash);
  assert.equal(existsSync(checkPath), false); assert.equal(existsSync(reviewPath), false);
});

test('cancelled verification resumes on the same commit without repeating the draft or floor', async t => {
  const { store, workspace } = await fixture(t);
  let entered, checkCalls = 0;
  const checking = new Promise(resolve => { entered = resolve; });
  const calls = [];
  const mesh = new Mesh(store, async (p, r) => { calls.push(phaseOf(r.prompt)); return implementation(p, r); }, { runChecks: async (commands, cwd, { signal }) => {
    checkCalls++;
    if (checkCalls === 1) { entered(); await delay(30_000, null, { signal }); }
    return commands.map(result);
  } });
  const run = mesh.create({ ...options, workspace }); await checking;
  const hash = latestCandidate(run).hash;
  mesh.cancel(run.id);
  assert.throws(() => mesh.resume(run, options.participants), /finish stopping/);
  await finished(mesh, run);
  assert.equal(run.status, 'cancelled'); assert.equal(run.phase, 'check');
  assert.equal(latestCandidate(run).checkStatus, 'pending');
  assert.equal(calls.includes('ratify'), false);
  await assert.rejects(mesh.applyCandidate(run), /verification is unfinished/);
  assert.equal(run.workspace.impl, null); assert.equal(run.workspace.checkWorktree, null);
  mesh.resume(run, options.participants); await finished(mesh, run);
  assert.equal(run.status, 'complete', run.error); assert.equal(checkCalls, 2);
  assert.equal(latestCandidate(run).hash, hash); assert.equal(latestCandidate(run).checkStatus, 'complete');
  assert.deepEqual(calls, ['opening', 'opening', 'floor', 'floor', 'draft', 'ratify']);
});

test('the session deadline cancels verification and a higher limit resumes checks on the same commit', async t => {
  const { store, workspace } = await fixture(t);
  let checks = 0, aborted = false, drafts = 0;
  const mesh = new Mesh(store, async (p, r) => {
    if (phaseOf(r.prompt) === 'draft') drafts++;
    return implementation(p, r);
  }, { runChecks: async (commands, cwd, { signal }) => {
    if (++checks === 1) {
      try { await delay(30_000, null, { signal }); }
      catch (error) { aborted = signal.aborted; throw error; }
    }
    return commands.map(result);
  } });
  // The session must outlast the implementer (the server refuses otherwise), so the implementer gets the same one-minute allowance the resume grants.
  const run = mesh.create({ ...options, workspace: { ...workspace, implementTimeout: 60 }, maxDurationSeconds: 2 }); await finished(mesh, run);
  assert.equal(run.status, 'limited'); assert.equal(run.limitReason, 'time'); assert.equal(aborted, true);
  const hash = latestCandidate(run).hash;
  assert.equal(latestCandidate(run).checkStatus, 'pending'); assert.equal(run.entries.some(e => e.phase === 'ratify'), false);
  assert.equal(run.workspace.checkWorktree, null);
  mesh.resume(run, options.participants, { maxDurationSeconds: 60 }); await finished(mesh, run);
  assert.equal(run.status, 'complete', run.error); assert.equal(checks, 2); assert.equal(drafts, 1);
  assert.equal(latestCandidate(run).hash, hash); assert.equal(run.record.verdict.label, 'Approved');
});

test('a restart after the draft response recovers uncaptured files without another model call', async t => {
  const { store, workspace } = await fixture(t);
  const calls = [];
  const provider = async (p, r) => { calls.push(phaseOf(r.prompt)); return implementation(p, r); };
  const mesh = new Mesh(store, provider, { runChecks: async commands => commands.map(result) });
  mesh.captureCandidate = async () => { throw new Error('Interrupted before capture'); };
  const run = mesh.create({ ...options, workspace }); await finished(mesh, run);
  assert.equal(run.status, 'failed'); assert.ok(existsSync(run.workspace.impl));
  assert.equal(run.entries.find(e => e.phase === 'draft').status, 'complete');
  assert.equal(latestCandidate(run), null);
  const restarted = new Mesh(store, provider, { runChecks: async commands => commands.map(result) });
  const recovered = restarted.runs[0]; restarted.resume(recovered, options.participants); await finished(restarted, recovered);
  assert.equal(recovered.status, 'complete', recovered.error);
  assert.deepEqual(calls, ['opening', 'opening', 'floor', 'floor', 'draft', 'ratify']);
  assert.equal(latestCandidate(recovered).checks[0].code, 0);
  assert.equal(recovered.workspace.impl, null);
});

test('a lost uncaptured checkout causes a replacement draft, never a vote on missing code', async t => {
  const { store, workspace, project } = await fixture(t);
  let drafts = 0;
  const provider = async (p, r) => { if (phaseOf(r.prompt) === 'draft') drafts++; return implementation(p, r); };
  const mesh = new Mesh(store, provider, { runChecks: async commands => commands.map(result) });
  mesh.captureCandidate = async () => { throw new Error('Interrupted before capture'); };
  const run = mesh.create({ ...options, workspace }); await finished(mesh, run);
  await removeWorktree(project, run.workspace.impl);
  const restarted = new Mesh(store, provider, { runChecks: async commands => commands.map(result) });
  const recovered = restarted.runs[0]; restarted.resume(recovered, options.participants); await finished(restarted, recovered);
  assert.equal(recovered.status, 'complete', recovered.error); assert.equal(drafts, 2);
  assert.equal(recovered.entries.find(e => e.phase === 'draft').superseded, true);
  assert.ok(latestCandidate(recovered).hash);
});

test('a saved commit checkpoint rebuilds its candidate after the implementation checkout is removed', async t => {
  const { store, workspace } = await fixture(t);
  let drafts = 0;
  const provider = async (p, r) => { if (phaseOf(r.prompt) === 'draft') drafts++; return implementation(p, r); };
  const mesh = new Mesh(store, provider, { runChecks: async commands => commands.map(result) });
  mesh.captureCandidate = async (run, draft) => {
    draft.capture = await commitCandidate(run.workspace.impl, 'checkpoint');
    mesh.publish(run);
    throw new Error('Interrupted before diff capture');
  };
  const run = mesh.create({ ...options, workspace }); await finished(mesh, run);
  assert.equal(run.status, 'failed'); assert.equal(run.workspace.impl, null);
  const hash = run.entries.find(e => e.phase === 'draft').capture.hash;
  const restarted = new Mesh(store, provider, { runChecks: async commands => commands.map(result) });
  const recovered = restarted.runs[0]; restarted.resume(recovered, options.participants); await finished(restarted, recovered);
  assert.equal(recovered.status, 'complete', recovered.error); assert.equal(drafts, 1);
  assert.equal(latestCandidate(recovered).hash, hash);
  assert.match(latestCandidate(recovered).patch, /reviewed content/);
});

test('an interrupted persisted check is rerun after restart and prior ballots are replaced', async t => {
  const { store, workspace } = await fixture(t);
  const mesh = new Mesh(store, implementation, { runChecks: async commands => commands.map(result) });
  const run = mesh.create({ ...options, workspace }); await finished(mesh, run);
  const oldVote = run.entries.find(e => e.phase === 'ratify'), candidate = latestCandidate(run);
  candidate.checkStatus = 'running'; candidate.checks = [];
  run.status = 'running'; run.phase = 'check'; run.final = '';
  store.write('runs.json', [run]);
  const calls = []; let checks = 0;
  const restarted = new Mesh(store, async (p, r) => { calls.push(phaseOf(r.prompt)); return implementation(p, r); }, { runChecks: async commands => { checks++; return commands.map(result); } });
  const recovered = restarted.runs[0]; assert.equal(recovered.status, 'interrupted');
  restarted.resume(recovered, options.participants); await finished(restarted, recovered);
  assert.equal(recovered.status, 'complete', recovered.error);
  assert.equal(checks, 1); assert.deepEqual(calls, ['ratify']);
  assert.equal(recovered.entries.find(e => e.id === oldVote.id).superseded, true);
  assert.equal(recovered.record.votes.approve, 1);
});

test('a failed test remains reviewable, while a check that could not run requires retry', async t => {
  const { store, workspace } = await fixture(t);
  let checks = 0;
  const mesh = new Mesh(store, implementation, { runChecks: async commands => commands.map(command => ({ command, code: ++checks === 1 ? null : 1, output: 'failure details', seconds: 0 })) });
  const run = mesh.create({ ...options, workspace }); await finished(mesh, run);
  assert.equal(run.status, 'failed'); assert.equal(run.entries.some(e => e.phase === 'ratify'), false);
  mesh.resume(run, options.participants); await finished(mesh, run);
  assert.equal(run.status, 'complete', run.error); assert.equal(checks, 2);
  assert.equal(latestCandidate(run).checks[0].code, 1); assert.match(run.final, /exit 1/);
});

test('check deadlines still work with a parent signal, and cancellation stops the batch', async () => {
  let calls = 0;
  const fakeProcess = async (command, args, { signal }) => { calls++; await delay(10_000, null, { signal }); return { code: 0, stdout: 'ok', stderr: '' }; };
  const results = await runChecks(['first', 'second'], tmpdir(), { timeoutSeconds: 0.02, signal: new AbortController().signal, run: fakeProcess });
  assert.equal(calls, 1); assert.equal(results.length, 1); assert.equal(results[0].code, null); assert.match(results[0].output, /timed out/);
  const controller = new AbortController();
  const pending = runChecks(['first', 'second'], tmpdir(), { signal: controller.signal, run: fakeProcess });
  controller.abort(); await assert.rejects(pending, /abort/i); assert.equal(calls, 2);
});

test('nominations and objections cannot exclude the third member from a cycle', async t => {
  const { store } = await fixture(t);
  const mesh = new Mesh(store, async (p, r) => {
    const phase = phaseOf(r.prompt);
    return { text: phase === 'floor' ? turn({ stance: 'disagree', nominates: p.id === '0' ? '1' : '0', objections: [{ against: p.id === '0' ? 'Beta' : 'Alpha', claim: 'A claim', condition: 'Evidence' }] }) : reply(phase) };
  });
  const run = mesh.create({ ...options, participants: members, cycles: 2 }); await finished(mesh, run);
  assert.equal(run.status, 'complete', run.error); assert.equal(run.stopReason, 'budget');
  const floor = run.entries.filter(e => e.phase === 'floor');
  assert.equal(floor.length, 6);
  for (const cycle of [1, 2]) assert.deepEqual(floor.filter(e => e.cycle === cycle).map(e => e.speaker).sort(), ['0', '1', '2']);
});

test('reconvening requires new stances and legacy repeated speakers do not complete a cycle', async t => {
  const { store } = await fixture(t);
  const mesh = new Mesh(store, async (p, r) => ({ text: reply(phaseOf(r.prompt)) }));
  const run = mesh.create({ ...options, participants: members }); await finished(mesh, run);
  const old = structuredClone(run); old.session = 2; old.stopReason = null;
  const add = (speaker, stance) => old.entries.push({ id: `e${++old.seq}`, seq: old.seq, speaker, session: 2, phase: 'floor', status: 'complete', text: 'New position', fields: { stance, concedes: [], objections: [], resolves: [] } });
  add('0', 'agree'); add('1', 'agree'); add('0', 'agree');
  assert.equal(latestStance(old, '2'), null);
  let action = plan(old, activeMembers(old));
  assert.equal(action.type, 'turn'); assert.equal(action.speaker.id, '2'); assert.equal(action.cycle, 1);
  add('2', 'disagree'); action = plan(old, activeMembers(old));
  assert.equal(action.type, 'stop'); assert.equal(action.reason, 'budget');
});
