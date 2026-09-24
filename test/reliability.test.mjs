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

test('a stopped meeting resumes with changed settings: the partial build is kept and the change is on the record', async t => {
  const { store, project, workspace } = await fixture(t);
  const seen = []; let failDraft = true;
  const mesh = new Mesh(store, async (provider, request) => {
    seen.push({ phase: phaseOf(request.prompt), network: request.network, cwd: request.cwd, prompt: request.prompt, partial: Boolean(request.cwd) && existsSync(join(request.cwd, 'half-done.txt')) });
    if (phaseOf(request.prompt) === 'draft') {
      if (failDraft) { await writeFile(join(request.cwd, 'half-done.txt'), 'partial work\n'); throw new Error('provider down'); }
      return implementation(provider, request);
    }
    return { text: reply(phaseOf(request.prompt)) };
  }, { runChecks: async commands => commands.map(result) });
  const run = mesh.create({ ...options, workspace: { ...workspace, network: false, implementTimeout: 900 }, maxDurationSeconds: 3600 });
  await finished(mesh, run);
  // The implementer failed part-way. Its checkout survives the stop, so the resume hands back the same partial work.
  assert.equal(run.status, 'failed');
  assert.ok(run.workspace.impl && existsSync(join(run.workspace.impl, 'half-done.txt')), 'the partial build was discarded');
  assert.equal(seen.filter(s => s.phase === 'draft').at(-1).network, false);
  const implPath = run.workspace.impl;
  failDraft = false;
  mesh.resume(run, options.participants, {}, { workspace: { ...run.workspace, network: true, checks: ['verify', 'verify --again'] }, note: 'Proceed with internet access.' });
  await finished(mesh, run);
  assert.equal(run.status, 'complete', run.error);
  const owner = run.entries.filter(e => e.speaker === 'owner').at(-1);
  assert.equal(owner.adjust, true);
  assert.match(owner.text, /Settings changed before resuming: network on for the implementer and the checks; checks: verify, verify --again\./);
  assert.match(owner.text, /Proceed with internet access\./);
  const implementer = seen.filter(s => s.phase === 'draft').at(-1);
  assert.equal(implementer.network, true); assert.equal(implementer.cwd, implPath);
  assert.equal(implementer.partial, true, 'the implementer did not get its own partial work back');
  // The next member answers the owner, and every prompt after the change states the new access.
  const afterOwner = run.entries.filter(e => e.seq > owner.seq && e.phase === 'floor' && e.speaker !== 'owner');
  assert.equal(afterOwner.length, 1);
  assert.match(seen.find(s => /OWNER changed the meeting settings/.test(s.prompt)).prompt, /with a shell and network/);
  assert.deepEqual(latestCandidate(run).checks.map(c => c.command), ['verify', 'verify --again']);
});

test('changed settings send a verified candidate back for checking, and the floor reopens when the owner adds cycles', async t => {
  const { store, workspace } = await fixture(t);
  let checks = 0;
  const mesh = new Mesh(store, implementation, { runChecks: async commands => { checks++; return commands.map(result); } });
  const run = mesh.create({ ...options, workspace, maxDurationSeconds: 3600 });
  await finished(mesh, run);
  assert.equal(run.status, 'complete'); assert.equal(checks, 1);
  assert.equal(run.record.verdict.code, 'approved');
  const floorBefore = run.entries.filter(e => e.phase === 'floor' && e.speaker !== 'owner').length;
  // The meeting closed on budget with one cycle; two more cycles reopen the floor, and a new check re-verifies the same commit.
  run.status = 'cancelled'; run.stopReason = 'budget';
  const hash = latestCandidate(run).hash;
  mesh.resume(run, options.participants, {}, { cycles: 3, maxRevisions: 2, workspace: { ...run.workspace, checks: ['verify', 'verify --twice'] } });
  const owner = run.entries.filter(e => e.speaker === 'owner').at(-1);
  assert.match(owner.text, /meeting length 1 to 3 cycles/); assert.match(owner.text, /the floor reopens/);
  assert.match(owner.text, /the candidate goes back for verification under the new settings/);
  assert.match(owner.text, /revisions after objections 0 to 2/);
  await finished(mesh, run);
  assert.equal(run.status, 'complete', run.error);
  assert.equal(run.cycles, 3); assert.equal(run.maxRevisions, 2);
  assert.ok(run.entries.filter(e => e.phase === 'floor' && e.speaker !== 'owner').length > floorBefore, 'the floor did not reopen');
  assert.equal(checks, 2); assert.equal(latestCandidate(run).hash, hash);
  assert.deepEqual(latestCandidate(run).checks.map(c => c.command), ['verify', 'verify --twice']);
  assert.equal(run.record.verdict.code, 'approved');
  assert.throws(() => mesh.applySettings(run, { workspace: { ...run.workspace, path: '/elsewhere' } }), /cannot change mid-meeting/);
  assert.throws(() => mesh.applySettings(run, { cycles: 9 }), /1–8 cycles/);
});

test('internet research and deep research are separate, reach every call, and can be changed after a pause', async t => {
  const store = new Store(await mkdtemp(join(tmpdir(), 'mesh-research-'))); t.after(() => rm(store.directory, { recursive: true, force: true }));
  const calls = [];
  const mesh = new Mesh(store, async (provider, request) => { calls.push({ name: provider.name, research: request.research, deepResearch: request.deepResearch, system: request.system, prompt: request.prompt }); return { text: reply(phaseOf(request.prompt)) }; });
  const plain = mesh.create({ ...options }); await finished(mesh, plain);
  assert.equal(plain.research, false); assert.equal(plain.deepResearch, false);
  assert.ok(calls.every(c => c.research === undefined), 'a plain meeting asked for research');
  assert.doesNotMatch(calls[0].system, /research is on/);
  calls.length = 0;
  // Internet research alone: members may search, but nobody is told to research before speaking.
  const web = mesh.create({ ...options, research: true }); await finished(mesh, web);
  assert.equal(web.research, true); assert.equal(web.deepResearch, false);
  assert.ok(calls.every(c => c.research === true && c.deepResearch === false), 'the web setting did not reach every call');
  assert.match(calls[0].system, /Internet research is on: members who can browse may search/);
  assert.doesNotMatch(calls[0].system, /Deep research is on/);
  assert.match(calls[0].prompt, /Search the web where it bears on the question/);
  calls.length = 0;
  // Deep research implies the web and adds the research-first instruction.
  const run = mesh.create({ ...options, deepResearch: true }); await finished(mesh, run);
  assert.equal(run.status, 'complete'); assert.equal(run.research, true); assert.equal(run.deepResearch, true);
  assert.ok(calls.length >= 4 && calls.every(c => c.research === true && c.deepResearch === true), 'deep research did not reach every call');
  assert.match(calls[0].system, /Deep research is on: search before you take a position/);
  assert.match(calls[0].prompt, /Research the subject before you write: several independent sources/);
  assert.throws(() => mesh.applySettings(run, { research: false, deepResearch: true }), /Deep research needs internet research/);
  // The owner can also switch it on mid-meeting; the change is recorded like any other.
  run.status = 'cancelled'; calls.length = 0;
  mesh.resume(run, options.participants, {}, { research: false, deepResearch: false });
  const note = run.entries.filter(e => e.speaker === 'owner').at(-1).text;
  assert.match(note, /internet research off: no member may search the web/); assert.match(note, /deep research off/);
  await finished(mesh, run);
  assert.equal(run.research, false); assert.equal(run.deepResearch, false);
  assert.ok(calls.every(c => c.research === undefined));
});

test('pause stops between steps, keeps the call in flight, and resumes under new settings', async t => {
  const store = new Store(await mkdtemp(join(tmpdir(), 'mesh-pause-'))); t.after(() => rm(store.directory, { recursive: true, force: true }));
  const calls = []; const held = {};
  const mesh = new Mesh(store, async (provider, request) => {
    calls.push({ name: provider.name, phase: phaseOf(request.prompt), research: request.research });
    // Pause while a floor turn is in flight: that call must still be recorded in full.
    if (calls.length === 3 && held.run) { mesh.pause(held.run); await delay(30); }
    return { text: reply(phaseOf(request.prompt)) };
  });
  const run = mesh.create({ ...options, cycles: 2 });
  held.run = run;
  await finished(mesh, run);
  assert.equal(run.status, 'paused');
  assert.match(run.error, /Paused by the owner/);
  assert.equal(run.pauseRequested, undefined);
  assert.equal(run.entries.filter(e => e.phase === 'opening' && e.status === 'complete').length, 2);
  assert.equal(run.entries.filter(e => e.phase === 'floor' && e.status === 'complete').length, 1, 'the call in flight was thrown away');
  assert.equal(run.entries.some(e => e.status === 'cancelled' || e.status === 'failed'), false);
  assert.throws(() => mesh.pause(run), /not in session/);
  const used = calls.length;
  mesh.resume(run, options.participants, {}, { deepResearch: true, note: 'Research it properly now.' });
  await finished(mesh, run);
  assert.equal(run.status, 'complete', run.error);
  assert.equal(run.research, true); assert.equal(run.deepResearch, true);
  assert.ok(calls.slice(used).every(c => c.research === true), 'the resumed meeting did not get the new setting');
  const owner = run.entries.filter(e => e.speaker === 'owner').at(-1);
  assert.match(owner.text, /internet research on: members may search the web/); assert.match(owner.text, /Research it properly now\./);
  assert.equal(run.record.verdict.code, 'approved');
});

test('a member whose opening ran out of time gets its seat back when the owner resumes before the floor speaks', async t => {
  const store = new Store(await mkdtemp(join(tmpdir(), 'mesh-slow-'))); t.after(() => rm(store.directory, { recursive: true, force: true }));
  let slow = true; const seen = [];
  const mesh = new Mesh(store, async (provider, request) => {
    const phase = phaseOf(request.prompt); seen.push({ name: provider.name, phase, timeout: request.timeoutSeconds });
    if (phase === 'opening' && provider.id === '1' && slow) throw new Error('Timed out after 180 seconds.');
    return { text: reply(phase) };
  });
  const run = mesh.create({ ...options, participants: [...members.slice(0, 3)], cycles: 1, timeoutSeconds: 180 });
  await finished(mesh, run);
  // The meeting carried on without the slow member, as it should: two members is a quorum.
  assert.equal(run.status, 'complete');
  assert.equal(run.entries.filter(e => e.phase === 'opening' && e.status === 'failed').length, 1);
  assert.equal(run.entries.some(e => e.phase === 'floor' && e.speaker === '1'), false);
  // Now the same meeting stopped before the floor spoke: raising the turn limit brings the slow member back.
  const early = mesh.create({ ...options, participants: [...members.slice(0, 3)], cycles: 1, timeoutSeconds: 180 });
  await finished(mesh, early);
  early.entries = early.entries.filter(e => e.phase === 'opening');
  Object.assign(early, { status: 'cancelled', stopReason: null, phase: 'opening', final: '', record: null });
  slow = false; seen.length = 0;
  mesh.resume(early, members.slice(0, 3), {}, { timeoutSeconds: 1800 });
  const owner = early.entries.filter(e => e.speaker === 'owner').at(-1);
  assert.match(owner.text, /time limit for one member's turn 180 to 1800 seconds/);
  assert.match(owner.text, /Beta writes an opening position after all/);
  await finished(mesh, early);
  assert.equal(early.status, 'complete', early.error);
  assert.equal(early.entries.filter(e => e.phase === 'opening' && e.status === 'complete' && e.speaker === '1').length, 1);
  assert.ok(early.entries.some(e => e.phase === 'floor' && e.speaker === '1'), 'the member never reached the floor');
  assert.ok(seen.every(c => c.timeout === 1800), 'the new turn limit did not reach the calls');
});

test('a repository is cloned over https only, refreshed in place, and never asked for a password', async t => {
  const { validateRepoUrl, cloneRepo, repoRoot } = await import('../lib/repos.mjs');
  assert.deepEqual(validateRepoUrl('binary-knight/agentsec-pack'), { url: 'https://github.com/binary-knight/agentsec-pack.git', host: 'github.com', owner: 'binary-knight', name: 'agentsec-pack', folder: 'binary-knight-agentsec-pack' });
  assert.equal(validateRepoUrl('https://gitlab.com/group/sub/project.git').folder, 'group-sub-project');
  for (const [bad, why] of [['git@github.com:a/b.git', /not a URL/], ['file:///etc', /Only https/], ['http://github.com/a/b', /Only https/], ['https://localhost/a/b', /public repository host/], ['https://10.0.0.5/a/b', /public repository host/], ['https://user:pw@github.com/a/b', /credentials in the URL/], ['https://github.com/onlyowner', /owner and a repository/], ['../../etc/passwd', /not a URL/], ['', /Enter a repository URL/]]) {
    assert.throws(() => validateRepoUrl(bad), why, bad);
  }
  assert.match(repoRoot({}), /overrule-repos$/); assert.equal(repoRoot({ OVERRULE_REPO_DIR: '/srv/clones' }), '/srv/clones');
  // The clone itself: fixed arguments, no hooks, no prompting, and nothing of the server's environment beyond the usual.
  const dir = await mkdtemp(join(tmpdir(), 'mesh-clone-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const seen = [];
  const run = async (command, args, options) => {
    seen.push({ command, args, env: options.env });
    if (args.includes('clone')) await mkdir(args.at(-1), { recursive: true });
    return { code: 0, stdout: args.includes('rev-parse') ? (args.includes('--abbrev-ref') ? 'main' : 'a'.repeat(40)) : '', stderr: '' };
  };
  const info = await cloneRepo('binary-knight/agentsec-pack', { dir, run });
  assert.equal(info.path, join(dir, 'binary-knight-agentsec-pack')); assert.equal(info.branch, 'main'); assert.equal(info.updated, false);
  const clone = seen.find(c => c.args.includes('clone'));
  assert.deepEqual(clone.args, ['-c', 'core.hooksPath=/dev/null', 'clone', '--depth', '1', '--no-recurse-submodules', '--no-tags', '--quiet', 'https://github.com/binary-knight/agentsec-pack.git', info.path]);
  assert.equal(clone.env.GIT_TERMINAL_PROMPT, '0'); assert.equal(clone.env.GIT_ASKPASS, '/bin/true'); assert.equal(clone.env.OPENAI_API_KEY, undefined);
  // A second clone of the same repository refreshes that checkout instead of failing or duplicating it.
  seen.length = 0;
  const again = await cloneRepo('binary-knight/agentsec-pack', { dir, run: async (command, args, options) => { if (args.includes('get-url')) return { code: 0, stdout: 'https://github.com/binary-knight/agentsec-pack.git', stderr: '' }; return run(command, args, options); } });
  assert.equal(again.updated, true);
  assert.ok(seen.some(c => c.args.includes('fetch')) && seen.some(c => c.args.includes('reset')) && !seen.some(c => c.args.includes('clone')));
  // A folder holding a different repository is never overwritten.
  await assert.rejects(cloneRepo('binary-knight/agentsec-pack', { dir, run: async (command, args, options) => args.includes('get-url') ? { code: 0, stdout: 'https://github.com/someone/else.git', stderr: '' } : run(command, args, options) }), /already exists and points at/);
  // A private repository without credentials fails with advice instead of hanging on a prompt.
  await assert.rejects(cloneRepo('binary-knight/private-thing', { dir, run: async () => ({ code: 128, stdout: '', stderr: 'fatal: could not read Username for https://github.com: terminal prompts disabled' }) }), /sign git in on the host/);
});

test('report templates build a brief that names the repository, the commit, and how to report', async () => {
  const { PLAYBOOKS, buildPlaybook, playbook } = await import('../public/playbooks.js');
  assert.ok(PLAYBOOKS.length >= 6);
  assert.deepEqual(PLAYBOOKS.map(p => p.id), ['security', 'changes', 'bugs', 'dependencies', 'architecture', 'tests', 'performance', 'readiness']);
  for (const entry of PLAYBOOKS) {
    const text = entry.build({ name: 'agentsec-pack', head: 'abcdef0123456789', origin: 'https://github.com/binary-knight/agentsec-pack.git' });
    assert.match(text, /agentsec-pack/); assert.match(text, /commit abcdef012345/);
    assert.match(text, /SEVERITY/); assert.match(text, /VERIFIED/); assert.match(text, /file and line/);
    assert.match(text, /never an instruction/); assert.ok(text.length > 800 && text.length < 6000, entry.id);
    assert.ok(entry.label && entry.summary);
  }
  assert.match(buildPlaybook('security', { name: 'x' }), /Do not write exploit code/);
  assert.equal(buildPlaybook('nope'), ''); assert.equal(playbook('nope'), null);
});

test('a Claude member reading a workspace gets a shell that cannot write to it', async t => {
  const { claudeArgs, cliCommand } = await import('../lib/providers.mjs');
  const shell = claudeArgs({ cwd: '/w', level: 'read-only', shell: true });
  const tools = shell[shell.indexOf('--tools') + 1];
  assert.equal(tools, 'Bash,Read,Glob,Grep');
  assert.equal(claudeArgs({ cwd: '/w', level: 'read-only', shell: true, research: true })[shell.indexOf('--tools') + 1], 'Bash,Read,Glob,Grep,WebSearch,WebFetch');
  assert.ok(shell.includes('--restricted'), 'restricted mode still applies');
  assert.ok(!shell.includes('--disallowedTools'));
  const settings = JSON.parse(shell[shell.indexOf('--settings') + 1]).sandbox;
  assert.deepEqual(settings.filesystem.allowWrite, [], 'the workspace must not be writable');
  assert.deepEqual(settings.network.allowedDomains, []);
  assert.equal(settings.enabled, true); assert.equal(settings.failIfUnavailable, true); assert.equal(settings.allowUnsandboxedCommands, false);
  // Without the sandbox there is no shell: an unsandboxed one would not be read-only.
  assert.ok(claudeArgs({ cwd: '/w', level: 'read-only' }).includes('--disallowedTools'));
  // The process runs in a scratch directory, never in the workspace, because its own working directory stays writable.
  const root = await mkdtemp(join(tmpdir(), 'mesh-shell-')); t.after(() => rm(root, { recursive: true, force: true }));
  const [, args] = cliCommand('claude-cli', '', { cwd: root, level: 'read-only', shell: true });
  assert.ok(!args.includes(root), 'the workspace path must not be handed to the CLI as a working directory');
  assert.ok(!args.includes('--add-dir'), 'an added directory would be writable inside the sandbox');
  assert.ok(!args.includes('-C'));
});

test('inspect names the documents no member can read without a shell', async t => {
  const { inspect, binaryDocuments } = await import('../lib/workspace.mjs');
  const root = await mkdtemp(join(tmpdir(), 'mesh-docs-')); t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'sub', 'deep'), { recursive: true }); await mkdir(join(root, 'node_modules'), { recursive: true }); await mkdir(join(root, '.hidden'), { recursive: true });
  await writeFile(join(root, 'Draft.docx'), 'PK'); await writeFile(join(root, 'notes.md'), '# text');
  await writeFile(join(root, 'sub', 'model.xlsx'), 'PK'); await writeFile(join(root, 'sub', 'deep', 'paper.pdf'), '%PDF');
  await writeFile(join(root, 'node_modules', 'ignored.docx'), 'PK'); await writeFile(join(root, '.hidden', 'secret.pdf'), '%PDF');
  const names = binaryDocuments(root).map(d => d.name).sort();
  assert.deepEqual(names, ['Draft.docx', 'model.xlsx', 'paper.pdf']);
  assert.ok(binaryDocuments(root).every(d => d.size > 0 && d.path.startsWith(root)));
  const info = await inspect(root);
  assert.deepEqual(info.documents.map(d => d.name).sort(), names);
});
