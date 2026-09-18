import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Store } from '../lib/store.mjs';
import { Mesh, validateRun, exportMarkdown } from '../lib/mesh.mjs';
import { normalizeFields, metrics } from '../lib/meeting.mjs';
import { assessResult, callsUsed, citationEvidence, estimateCalls, elapsedBudget } from '../public/meeting-state.js';

const members = ['Alpha', 'Beta', 'Gamma'].map((name, i) => ({ id: String(i), name, type: 'compatible', model: 'fixture', role: name, baseUrl: 'http://localhost:9999/v1' }));
const options = { prompt: 'A test task', participants: members.slice(0, 2), drafterId: '0', cycles: 1, maxTokens: 4096, timeoutSeconds: 10, maxRevisions: 0 };
const block = fields => '\n```json\n' + JSON.stringify(fields) + '\n```';
const phaseOf = prompt => /Write your OPENING POSITION/.test(prompt) ? 'opening' : /RATIFICATION BALLOT/.test(prompt) ? 'ratify' : /You are the drafter/.test(prompt) ? 'draft' : 'floor';
const reply = phase => phase === 'opening' ? 'There is a check.' + block({ assumptions: [], risk: 'x', criteria: ['test'] }) : phase === 'floor' ? 'Agree.' + block({ stance: 'agree', concedes: [], objections: [] }) : phase === 'draft' ? 'Deliverable.' + block({ version: 1, unresolved: [] }) : 'Vote.' + block({ vote: 'approve', objections: [], reason: 'Reviewed' });
const provider = async (p, r) => ({ text: reply(phaseOf(r.prompt)), usage: { input: 10, output: 5 } });
async function storeFor(t) { const dir = await mkdtemp(join(tmpdir(), 'mesh-results-')); t.after(() => rm(dir, { recursive: true, force: true })); return new Store(dir); }
async function finished(mesh, run) { for (let i = 0; i < 1000 && mesh.controllers.has(run.id); i++) await delay(5); assert.equal(mesh.controllers.has(run.id), false); return run; }

test('citations require an earlier completed source and a matching quotation, with whitespace normalization', () => {
  const source = { id: 'e1', seq: 1, speaker: '0', status: 'complete', text: 'There is\n a check.' };
  const entry = { id: 'e2', seq: 2, speaker: '1' };
  const run = { participants: members, entries: [source, entry, { ...source, id: 'e3', seq: 3 }, { ...source, id: 'e4', status: 'failed' }, { ...source, id: 'e5', superseded: true }] };
  const fields = normalizeFields(run, 'floor', { stance: 'agree', concedes: [
    { entry: 'e1', quote: 'There is a check.' }, { entry: 'e1', quote: 'There is a check.' },
    { entry: 'missing', quote: 'There is a check.' }, { entry: 'e1', quote: 'invented' },
    { entry: 'e2', quote: 'self' }, { entry: 'e3', quote: 'There is a check.' },
    { entry: 'e4', quote: 'There is a check.' }, { entry: 'e5', quote: 'There is a check.' },
  ] }, entry);
  assert.deepEqual(fields.concedes, [{ entry: 'e1', quote: 'There is a check.' }]);
  assert.equal(fields.invalidConcessions.length, 6);
  assert.ok(fields.invalidConcessions.every(c => c.reason));
  source.text = 'There is a check. ' + 'x'.repeat(600);
  assert.equal(citationEvidence(run, entry, [{ entry: 'e1', quote: source.text + ' invented tail' }]).valid.length, 0);
});

test('a fabricated concession cannot bypass the re-ask or inflate concession metrics', async t => {
  const store = await storeFor(t), perMember = new Map();
  const mesh = new Mesh(store, async (p, r) => {
    const phase = phaseOf(r.prompt);
    if (phase !== 'floor') return provider(p, r);
    const n = (perMember.get(p.id) || 0) + 1; perMember.set(p.id, n);
    return { text: 'Claim.' + block({ stance: n === 1 ? 'disagree' : 'agree', concedes: n === 1 ? [] : [{ entry: 'not-real', quote: 'A made-up reason.' }], objections: [] }) };
  });
  const run = mesh.create({ ...options, cycles: 2 }); await finished(mesh, run);
  assert.equal(run.status, 'complete', run.error); assert.equal(run.stopReason, 'budget');
  assert.equal(run.entries.filter(e => e.superseded).length, 2);
  assert.ok(run.entries.filter(e => e.phase === 'floor' && !e.superseded).every(e => e.fields.stance === 'disagree'));
  assert.equal(metrics(run).citedConcessions, 0); assert.equal(metrics(run).rejectedCitations, 2);
  assert.equal(callsUsed(run), 10); // includes both rejected attempts
  assert.match(exportMarkdown(run), /invalidConcessions/);
});

test('final verdict distinguishes approval, objections, missing votes, and failed or unfinished checks', async t => {
  const mesh = new Mesh(await storeFor(t), provider), run = mesh.create(options); await finished(mesh, run);
  assert.equal(run.stopReason, 'consensus'); assert.equal(run.record.verdict.label, 'Approved');
  assert.match(run.record.verdict.verification, /model agreement/);
  const vote = run.entries.find(e => e.phase === 'ratify'), draft = run.entries.find(e => e.phase === 'draft');
  vote.fields.vote = 'object'; assert.equal(assessResult(run).label, 'Objections remain');
  vote.fields.vote = 'abstain'; assert.equal(assessResult(run).label, 'Verification incomplete');
  vote.fields.vote = 'approve'; vote.status = 'failed'; assert.equal(assessResult(run).missingBallots, 1);
  vote.status = 'complete';
  run.issues.push({ id: 'o1', status: 'open' }); assert.equal(assessResult(run).label, 'Objections remain'); run.issues = [];
  run.workspace = { level: 'workspace-write', checks: ['verify'] };
  assert.equal(assessResult(run).label, 'Verification incomplete');
  draft.candidate = { hash: 'a'.repeat(40), checks: [{ command: 'verify', code: 1 }], checkStatus: 'complete' };
  assert.equal(assessResult(run).label, 'Checks failed');
  draft.candidate.checks[0].code = 0; assert.equal(assessResult(run).label, 'Approved');
  draft.candidate.checkStatus = 'pending'; assert.equal(assessResult(run).label, 'Verification incomplete');
  draft.candidate.checkStatus = 'complete'; vote.candidateHash = 'b'.repeat(40); assert.equal(assessResult(run).label, 'Verification incomplete');
});

test('every revision setting is included in estimates and five revisions fit the allowance', async t => {
  for (let revisions = 0; revisions <= 5; revisions++) assert.equal(estimateCalls(3, 2, revisions).maximum, 3 + 12 + 3 * (1 + revisions));
  const mesh = new Mesh(await storeFor(t), async (p, r) => phaseOf(r.prompt) === 'ratify' ? { text: 'Object.' + block({ vote: 'object', objections: [{ claim: 'Needs work', condition: 'Revise' }] }) } : provider(p, r));
  const run = mesh.create({ ...options, maxRevisions: 5 }); await finished(mesh, run);
  assert.equal(run.status, 'complete', run.error); assert.equal(callsUsed(run), 16);
  assert.equal(run.plannedCalls, 18); assert.equal(run.budget.maxCalls, 18);
  assert.equal(run.record.verdict.label, 'Objections remain'); assert.equal(run.stopReason, 'consensus');
  assert.match(run.final, /Final verdict: Objections remain/);
});

test('a call limit smaller than the opening batch makes no calls and can be raised explicitly', async t => {
  let actual = 0; const mesh = new Mesh(await storeFor(t), async (p, r) => { actual++; return provider(p, r); });
  const run = mesh.create({ ...options, maxCalls: 1 }); await finished(mesh, run);
  assert.equal(run.status, 'limited'); assert.equal(run.limitReason, 'calls'); assert.equal(actual, 0); assert.equal(run.entries.length, 0);
  mesh.resume(run, options.participants, { maxCalls: 6 }); await finished(mesh, run);
  assert.equal(run.status, 'complete', run.error); assert.equal(actual, 6); assert.equal(callsUsed(run), 6);
});

test('parallel ballots reserve the full batch and resuming never resets spent calls', async t => {
  let actual = 0; const mesh = new Mesh(await storeFor(t), async (p, r) => { actual++; return provider(p, r); });
  const run = mesh.create({ ...options, participants: members, maxCalls: 8 }); await finished(mesh, run);
  assert.equal(run.status, 'limited'); assert.equal(actual, 7); assert.equal(run.entries.some(e => e.phase === 'ratify'), false);
  mesh.resume(run, members); await finished(mesh, run);
  assert.equal(actual, 7); assert.equal(run.status, 'limited');
  mesh.resume(run, members, { maxCalls: 9 }); await finished(mesh, run);
  assert.equal(run.status, 'complete', run.error); assert.equal(actual, 9); assert.equal(callsUsed(run), 9);
  assert.equal(run.record.votes.approve, 2);
});

test('owner interjections count the additional work but not the owner message as a model call', async t => {
  let mesh, actual = 0, drafts = 0;
  mesh = new Mesh(await storeFor(t), async (p, r) => {
    actual++; if (phaseOf(r.prompt) === 'draft' && ++drafts === 1) mesh.say(mesh.runs[0], 'One more requirement.');
    return provider(p, r);
  });
  const run = mesh.create({ ...options, maxCalls: 6 }); await finished(mesh, run);
  assert.equal(run.status, 'limited'); assert.equal(actual, 6); assert.equal(callsUsed(run), 6);
  assert.equal(run.entries.filter(e => e.speaker === 'owner').length, 1);
  mesh.resume(run, options.participants, { maxCalls: 8 }); await finished(mesh, run);
  assert.equal(run.status, 'complete', run.error); assert.equal(actual, 8); assert.equal(callsUsed(run), 8);
});

test('total duration cancels pending calls and survives restart until the owner raises it', async t => {
  const store = await storeFor(t); let aborted = 0;
  const mesh = new Mesh(store, async (p, r) => { try { await delay(5000, null, { signal: r.signal }); } catch (error) { aborted++; throw error; } return provider(p, r); });
  const run = mesh.create({ ...options, maxDurationSeconds: 1 }); await finished(mesh, run);
  assert.equal(run.status, 'limited'); assert.equal(run.limitReason, 'time'); assert.equal(aborted, 2);
  assert.equal(callsUsed(run), 2); assert.ok(elapsedBudget(run) >= 1000);
  const restarted = new Mesh(store, provider), recovered = restarted.runs[0];
  assert.throws(() => restarted.resume(recovered, options.participants), /Increase the session time limit/);
  restarted.resume(recovered, options.participants, { maxCalls: 10, maxDurationSeconds: 60 }); await finished(restarted, recovered);
  assert.equal(recovered.status, 'complete', recovered.error); assert.equal(callsUsed(recovered), 8);
  assert.ok(elapsedBudget(recovered) >= 1000);
});

test('an interrupted active budget is accounted conservatively instead of reset after a crash', async t => {
  const store = await storeFor(t), mesh = new Mesh(store, provider), run = mesh.create(options); await finished(mesh, run);
  run.status = 'running'; run.budget = { maxCalls: 20, maxDurationSeconds: 2, elapsedMs: 500, activeSince: Date.now() - 5000 };
  store.write('runs.json', [run]); const recovered = new Mesh(store, provider).runs[0];
  assert.equal(recovered.budget.elapsedMs, 2000); assert.equal(recovered.budget.activeSince, null);
});

test('a deadline during final cleanup cannot leave an approved answer on a stopped session', async t => {
  const mesh = new Mesh(await storeFor(t), provider); let cleanups = 0;
  mesh.cleanup = async () => { if (++cleanups === 1) await delay(1100); };
  const run = mesh.create({ ...options, maxDurationSeconds: 1 }); await finished(mesh, run);
  assert.equal(run.status, 'limited'); assert.equal(run.limitReason, 'time'); assert.equal(run.final, '');
  assert.equal(run.record.verdict.label, 'Verification incomplete'); assert.equal(callsUsed(run), 6);
  mesh.resume(run, options.participants, { maxDurationSeconds: 60 }); await finished(mesh, run);
  assert.equal(run.status, 'complete', run.error); assert.equal(callsUsed(run), 6);
});

test('reconvening starts a new explicit allowance and preserves the prior session usage', async t => {
  const mesh = new Mesh(await storeFor(t), provider), run = mesh.create({ ...options, maxCalls: 6 }); await finished(mesh, run);
  await mesh.reconvene(run, options.participants, { text: 'Next task', cycles: 1, maxCalls: 4, maxDurationSeconds: 120 }); await finished(mesh, run);
  assert.equal(run.status, 'complete', run.error); assert.equal(run.session, 2);
  assert.equal(run.sessions[0].calls, 6); assert.equal(run.sessions[0].budget.maxCalls, 6);
  assert.equal(callsUsed(run), 4); assert.equal(callsUsed(run, true), 10); assert.equal(run.budget.maxCalls, 4);
  assert.match(exportMarkdown(run), /Session 2: 4 \/ 4 calls; 10 calls overall/);
  await mesh.reconvene(run, options.participants, { text: 'Another task', cycles: 1, maxCalls: undefined, maxDurationSeconds: undefined }); await finished(mesh, run);
  assert.equal(run.budget.maxDurationSeconds, 120); assert.equal(run.budget.maxCalls, 6);
});

test('API limit validation refuses invalid numbers and does not depend on browser validation', () => {
  const input = { prompt: 'test', participantIds: ['0', '1'], drafterId: '0' };
  for (const value of [0, -1, 1.5, 1001, 'bad']) assert.throws(() => validateRun({ ...input, maxCalls: value }, members), /call limit/);
  for (const value of [0, -1, 0.5, 86401, 'bad']) assert.throws(() => validateRun({ ...input, maxDurationSeconds: value }, members), /time limit/);
  assert.equal(callsUsed({ entries: ['propose', 'review', 'synthesize'].map(phase => ({ phase, name: 'Legacy model' })) }), 3);
});
