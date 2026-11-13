// Saved councils: named seats plus whichever settings their owner kept, stored on the host and shared by the browser and the
// command line; applied to a meeting, recorded on it, saved from it, and kept consistent when a connection is deleted.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../server.mjs';
import { validateCouncil, validateSettings } from '../lib/councils.mjs';
import { snapshotFromRun, keep, changesFrom, describeCouncil, GROUP_IDS } from '../public/councils.js';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'overrule.mjs');
const block = fields => '\n```json\n' + JSON.stringify(fields) + '\n```';
// Scripted members that agree, so meetings finish at once and their settings can be read back.
const scripted = async (provider, request) => {
  if (/Write your OPENING POSITION/.test(request.prompt)) return { text: 'Opening.' + block({ assumptions: [], risk: 'r', criteria: ['c'] }) };
  if (/RATIFICATION BALLOT/.test(request.prompt)) return { text: 'Fine.' + block({ vote: 'approve', objections: [], reason: 'ok' }) };
  if (/You are the drafter|IMPLEMENTER/.test(request.prompt)) return { text: 'Done.' + block({ version: Number(request.prompt.match(/candidate v(\d+)/g)?.at(-1)?.slice(11) || 1), unresolved: [] }) };
  return { text: 'Agreed.' + block({ stance: 'agree', concedes: [], objections: [], resolves: [], nominates: null }) };
};

async function serve(t, { directory } = {}) {
  directory ||= await mkdtemp(join(tmpdir(), 'overrule-councils-'));
  const app = createApp({ directory, addresses: [], providerCall: scripted, detect: async () => ({ codex: { installed: true, signedIn: true }, claude: { installed: true, signedIn: true } }) });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const bootstrap = await (await fetch(base + '/api/bootstrap')).json();
  const headers = { 'Content-Type': 'application/json', 'X-Mesh-Token': bootstrap.token };
  const call = async (path, method = 'GET', body) => { const r = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }); return { status: r.status, body: await r.json() }; };
  const stop = async () => { app.server.closeAllConnections(); await new Promise(resolve => app.server.close(resolve)); };
  t.after(async () => { await stop(); await rm(directory, { recursive: true, force: true }); });
  // Three API connections beside the two CLI defaults; keys are never used, because members are scripted.
  const ids = { codex: 'codex-local', claude: 'claude-local' };
  for (const [name, type, model] of [['Grok', 'grok', 'grok-5'], ['Fable', 'anthropic', 'claude-fable-5-1'], ['Sol', 'openai', 'gpt-5.6-sol']]) ids[name.toLowerCase()] = (await call('/api/providers', 'POST', { type, name, model, apiKey: 'sk-test' })).body.id;
  const finish = async id => { for (let i = 0; i < 200; i++) { const run = (await call(`/api/runs/${id}`)).body; if (run.status !== 'running') return run; await new Promise(r => setTimeout(r, 25)); } throw new Error('meeting did not finish'); };
  return { app, base, directory, call, stop, ids, finish };
}

test('a council is checked as a meeting would check it, and keeps only the groups it was given', () => {
  const providers = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'].map(id => ({ id, name: id.toUpperCase() }));
  const ok = validateCouncil({ name: '  Full   review ', purpose: ' for  hard things ', seats: ['a', 'b', 'b', 'c'], settings: { cycles: 3, research: { deepResearch: true } } }, providers);
  assert.deepEqual(ok, { name: 'Full review', purpose: 'for hard things', seats: ['a', 'b', 'c'], settings: { cycles: 3, research: { research: true, deepResearch: true } } });
  const bad = (input, pattern) => assert.throws(() => validateCouncil({ name: 'x', seats: ['a', 'b'], ...input }, providers), pattern);
  bad({ name: '' }, /name of 1 to 60/); bad({ name: 'x'.repeat(61) }, /name of 1 to 60/); bad({ name: 'a\u0007b' }, /name of 1 to 60/);
  bad({ purpose: 'p'.repeat(201) }, /under 200/);
  bad({ seats: ['a'] }, /2 to 8/); bad({ seats: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'] }, /2 to 8/); bad({ seats: ['a', 'zz'] }, /not a saved connection/);
  bad({ settings: { drafter: { drafterId: 'c' } } }, /drafter must be one of its seats/);
  bad({ settings: { drafter: { drafterId: 'a', neutralDrafter: true } } }, /neutral drafter needs at least three seats/);
  bad({ settings: { cycles: 5 } }, /1 to 4 cycles/); bad({ settings: { revisions: 6 } }, /0 to 5 revisions/);
  bad({ settings: { workspace: {} } }, /cannot keep workspace/);
  bad({ settings: { limits: { maxCalls: 0 } } }, /call limit/); bad({ settings: { limits: { maxTokens: 100 } } }, /output limit/); bad({ settings: { limits: { timeoutSeconds: 5 } } }, /per call/);
  assert.deepEqual(validateSettings({ limits: {} }, ['a', 'b']), { limits: { maxCalls: null, maxDurationSeconds: 3600, maxTokens: 4096, timeoutSeconds: 180 } });
  assert.equal(validateCouncil({ name: 'Eight', seats: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'] }, providers).seats.length, 8);
});

test('a meeting is read back as a council could keep it, and changes from a council are named', () => {
  const run = { participants: [{ id: 'a' }, { id: 'b' }, { id: 'c' }], drafterId: 'b', neutralDrafter: true, cycles: 3, maxRevisions: 2, research: true, deepResearch: false, maxTokens: 8192, timeoutSeconds: 300, budget: { maxCalls: 30, maxDurationSeconds: 5430 } }; // 30 is the automatic limit: 3 openings, 9 floor turns twice, 3 × (1 + 2) ballots and revisions
  const snapshot = snapshotFromRun(run);
  assert.deepEqual(snapshot, { seats: ['a', 'b', 'c'], settings: { drafter: { drafterId: 'b', neutralDrafter: true }, cycles: 3, revisions: 2, research: { research: true, deepResearch: false }, limits: { maxCalls: null, maxDurationSeconds: 5460, maxTokens: 8192, timeoutSeconds: 300 } } });
  assert.equal(snapshotFromRun({ ...run, budget: { maxCalls: 12, maxDurationSeconds: 600 } }).settings.limits.maxCalls, 12, 'a limit the owner set is kept; the automatic one is kept as automatic');
  assert.deepEqual(Object.keys(keep(snapshot.settings, ['cycles', 'research', 'nonsense'])), ['cycles', 'research']);
  const council = { seats: ['c', 'a', 'b'], settings: keep(snapshot.settings, ['cycles', 'research']) };
  assert.deepEqual(changesFrom(council, snapshot), [], 'seat order does not matter');
  assert.deepEqual(changesFrom(council, { seats: ['a', 'b'], settings: { ...snapshot.settings, cycles: 1, revisions: 5 } }), ['seats', 'cycles'], 'a change to a group the council does not keep is not a change');
  assert.equal(describeCouncil({ seats: ['a', 'b'], settings: { drafter: { drafterId: 'b', neutralDrafter: false }, revisions: 0, research: { research: false, deepResearch: false }, limits: { maxCalls: 9, maxDurationSeconds: 1800, maxTokens: 4096, timeoutSeconds: 180 } } }, id => id.toUpperCase()),
    'A, B · B drafts · no revisions · no research · 9 calls, 30 min, 4,096 output tokens and 180 s per call');
});

test('councils are saved on the host, named uniquely, replaced or renamed on request, and survive a restart', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'overrule-councils-keep-'));
  const first = await serve(t, { directory });
  const { call, ids } = first;
  assert.equal((await fetch(first.base + '/api/councils', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 403, 'changes need the page token');
  const full = await call('/api/councils', 'POST', { name: 'Full', purpose: 'Hard questions', seats: [ids.claude, ids.codex, ids.grok], settings: { drafter: { drafterId: ids.codex, neutralDrafter: false }, cycles: 3, revisions: 2, research: { research: true, deepResearch: false }, limits: { maxCalls: null, maxDurationSeconds: 5400, maxTokens: 8192, timeoutSeconds: 300 } } });
  assert.equal(full.status, 201); assert.deepEqual(full.body.seatNames, ['Claude Code', 'Codex', 'Grok']); assert.equal(full.body.incomplete, false);
  const quick = await call('/api/councils', 'POST', { name: 'Quick', seats: [ids.claude, ids.codex], settings: { cycles: 1 } });
  assert.deepEqual(quick.body.settings, { cycles: 1 });

  const clash = await call('/api/councils', 'POST', { name: 'quick', seats: [ids.claude, ids.grok] });
  assert.equal(clash.status, 409); assert.equal(clash.body.code, 'exists'); assert.equal(clash.body.error, 'A council called “Quick” already exists.');
  const replaced = await call('/api/councils', 'POST', { name: 'quick', seats: [ids.claude, ids.grok], replace: true });
  assert.equal(replaced.body.id, quick.body.id, 'replacing keeps the council’s identity'); assert.deepEqual(replaced.body.settings, {}); assert.equal(replaced.body.createdAt, quick.body.createdAt);
  assert.equal((await call(`/api/councils/${quick.body.id}`, 'PUT', { name: 'Full', seats: [ids.claude, ids.grok] })).status, 409, 'a rename cannot take another council’s name');
  const renamed = await call(`/api/councils/${quick.body.id}`, 'PUT', { name: 'Two seats', seats: [ids.claude, ids.grok] });
  assert.equal(renamed.body.name, 'Two seats');
  assert.equal((await call('/api/councils/00000000-0000-0000-0000-000000000000', 'DELETE')).status, 404);
  assert.match((await call('/api/councils', 'POST', { name: 'Ghost', seats: [ids.claude, 'nope'] })).body.error, /not a saved connection/);

  const boot = (await call('/api/bootstrap')).body;
  assert.deepEqual(boot.councils.map(c => c.name).sort(), ['Full', 'Two seats']);
  const stored = JSON.parse(await readFile(join(directory, 'councils.json'), 'utf8'));
  assert.equal(stored.length, 2); assert.ok(!JSON.stringify(stored).includes('sk-test'));
  await first.stop();
  const second = await serve(t, { directory });
  const after = (await second.call('/api/councils')).body;
  assert.deepEqual(after.find(c => c.name === 'Full').settings, full.body.settings, 'kept exactly across a restart');
  assert.equal((await second.call(`/api/councils/${full.body.id}`, 'DELETE')).status, 200);
  assert.deepEqual((await second.call('/api/councils')).body.map(c => c.name), ['Two seats']);
});

test('deleting a connection takes it out of every council, forgets it as drafter, and says which councils changed', async t => {
  const { call, ids } = await serve(t);
  const big = (await call('/api/councils', 'POST', { name: 'Big', seats: [ids.claude, ids.codex, ids.grok], settings: { drafter: { drafterId: ids.codex, neutralDrafter: true }, cycles: 2 } })).body;
  const drafted = (await call('/api/councils', 'POST', { name: 'Grok drafts', seats: [ids.grok, ids.fable, ids.sol], settings: { drafter: { drafterId: ids.grok, neutralDrafter: false } } })).body;
  const pair = (await call('/api/councils', 'POST', { name: 'Pair', seats: [ids.grok, ids.fable] })).body;
  await call('/api/councils', 'POST', { name: 'Untouched', seats: [ids.claude, ids.codex] });

  const removed = await call(`/api/providers/${ids.grok}`, 'DELETE');
  assert.deepEqual(removed.body.councils.map(c => [c.name, c.seatsLeft, c.notes]), [
    ['Big', 2, ['too few seats remain for a neutral drafter']],
    ['Grok drafts', 2, ['its drafter was that connection, so it no longer names one']],
    ['Pair', 1, []],
  ]);
  const councils = Object.fromEntries((await call('/api/councils')).body.map(c => [c.name, c]));
  assert.deepEqual(councils.Big.seats, [ids.claude, ids.codex]); assert.deepEqual(councils.Big.settings, { drafter: { drafterId: ids.codex, neutralDrafter: false }, cycles: 2 });
  assert.equal('drafter' in councils['Grok drafts'].settings, false);
  assert.equal(councils.Pair.incomplete, true); assert.deepEqual(councils.Pair.seatNames, ['Fable']);
  assert.equal(councils.Untouched.updatedAt, councils.Untouched.createdAt);
  assert.equal(big.id, councils.Big.id); assert.equal(drafted.id, councils['Grok drafts'].id); assert.equal(pair.id, councils.Pair.id);
});

test('a meeting records the council it started from, by the name the host has for it, with what was changed', async t => {
  const { call, ids, finish } = await serve(t);
  const council = (await call('/api/councils', 'POST', { name: 'Review', seats: [ids.claude, ids.codex, ids.fable], settings: { cycles: 1 } })).body;
  const start = extra => call('/api/runs', 'POST', { prompt: 'Q', participantIds: [ids.claude, ids.codex, ids.fable], drafterId: ids.codex, cycles: 1, ...extra });
  const run = await start({ council: { id: council.id, name: 'Forged name', changed: ['cycles', 'workspace', 'seats'] } });
  assert.equal(run.status, 201);
  assert.deepEqual(run.body.council, { id: council.id, name: 'Review', changed: ['cycles', 'seats'] }, 'the name is the host’s and unknown changes are dropped');
  const done = await finish(run.body.id);
  assert.equal(done.council.name, 'Review');
  assert.equal((await start({ council: { id: 'no-such-council' } })).body.council, undefined);
  assert.equal((await start({})).body.council, undefined);
  // Eight seats is the limit everywhere; nine is refused.
  const more = [];
  for (let i = 0; i < 4; i++) more.push((await call('/api/providers', 'POST', { type: 'compatible', name: `Local ${i}`, model: 'm', baseUrl: 'http://localhost:11434/v1' })).body.id);
  const eight = [ids.claude, ids.codex, ids.fable, ids.sol, ...more];
  assert.equal((await call('/api/runs', 'POST', { prompt: 'Q', participantIds: eight, drafterId: ids.codex, cycles: 1 })).status, 201);
  assert.match((await call('/api/runs', 'POST', { prompt: 'Q', participantIds: [...eight, ids.grok], drafterId: ids.codex, cycles: 1 })).body.error, /between 2 and 8/);
});

function overrule(url, args, input = '') {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [CLI, ...args], { env: { ...process.env, OVERRULE_URL: url }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', d => { stdout += d; }); child.stderr.on('data', d => { stderr += d; });
    child.on('close', code => resolve({ code, stdout, stderr }));
    child.stdin.end(input);
  });
}

test('the command line saves, lists, renames and removes councils, and a meeting started with --council gets its settings', async t => {
  const { base, call, ids } = await serve(t);
  const none = await overrule(base, ['councils']);
  assert.match(none.stdout, /^No saved councils\./);
  const saved = await overrule(base, ['councils', 'save', 'Full', '--members', 'Claude Code,Codex,Grok', '--drafter', 'Grok', '--cycles', '3', '--revisions', '2', '--deep-research', '--time-limit', '90', '--turn-limit', '600', '--purpose', 'Hard questions']);
  assert.equal(saved.code, 0, saved.stderr);
  assert.equal(saved.stdout.trim(), 'Saved the council "Full": Claude Code, Codex, Grok · Grok drafts · 3 cycles · 2 revisions · deep research · automatic call limit, 90 min, 4,096 output tokens and 600 s per call.');
  const quick = await overrule(base, ['councils', 'save', 'Quick', '--members', 'Claude Code,Codex', '--cycles', '1']);
  assert.match(quick.stderr, /It does not keep drafter, revisions after objections, research, limits; those stay as each meeting sets them\./);
  const clash = await overrule(base, ['councils', 'save', 'quick', '--members', 'Codex,Grok']);
  assert.equal(clash.code, 1); assert.equal(clash.stderr.trim(), 'A council called “Quick” already exists. Pass --replace to replace it, or choose another name.');
  assert.match((await overrule(base, ['councils', 'save', 'Bad', '--members', 'Codex,Nobody'])).stderr, /No connection named "Nobody"/);
  assert.match((await overrule(base, ['councils', 'save', 'Bad', '--members', 'Codex,Grok', '--without', 'seats'])).stderr, /--without takes drafter, cycles, revisions, research, limits; not seats/);
  assert.match((await overrule(base, ['councils', 'save', 'Bad'])).stderr, /Give the seats with --members, or copy a meeting with --from <id>\./);
  const list = await overrule(base, ['councils']);
  assert.match(list.stdout, /^Full: Hard questions\n {2}Claude Code, Codex, Grok · Grok drafts · 3 cycles/);

  // A meeting with the council: its seats, drafter and settings, as the host records them.
  const asked = await overrule(base, ['ask', 'Is it sound?', '--council', 'full', '--json']);
  assert.equal(asked.code, 0, asked.stderr);
  assert.match(asked.stderr, /^Council "Full": Claude Code, Codex, Grok · Grok drafts/m);
  const result = JSON.parse(asked.stdout);
  assert.deepEqual(result.members, ['Claude Code', 'Codex', 'Grok']); assert.equal(result.drafter, 'Grok');
  assert.deepEqual(result.council, { id: result.council.id, name: 'Full', changed: [] });
  const run = (await call(`/api/runs/${result.id}`)).body;
  assert.deepEqual([run.cycles, run.maxRevisions, run.research, run.deepResearch, run.timeoutSeconds, run.budget.maxDurationSeconds], [3, 2, true, true, 600, 5400]);

  // Options given with --council win, and are recorded as changes; settings the council does not keep are not changes.
  const overridden = JSON.parse((await overrule(base, ['ask', 'Again', '--council', 'Full', '--members', 'Claude Code,Codex', '--cycles', '1', '--research=false', '--json'])).stdout);
  assert.deepEqual(overridden.members, ['Claude Code', 'Codex']); assert.deepEqual(overridden.council.changed, ['seats', 'cycles', 'research']);
  const second = (await call(`/api/runs/${overridden.id}`)).body;
  assert.deepEqual([second.cycles, second.research, second.maxRevisions], [1, false, 2]);
  const quickRun = JSON.parse((await overrule(base, ['ask', 'Small', '--council', 'Quick', '--revisions', '0', '--json'])).stdout);
  assert.deepEqual(quickRun.council.changed, [], 'Quick does not keep revisions, so setting them is not a change');
  assert.match((await overrule(base, ['ask', 'x', '--council', 'Nope'])).stderr, /No council called "Nope"\. Councils: Full, Quick\./);

  // Save from a finished meeting, leaving some groups out.
  const fromRun = await overrule(base, ['councils', 'save', 'Last', '--from', result.id.slice(0, 8), '--without', 'limits,research']);
  assert.equal(fromRun.stdout.trim(), 'Saved the council "Last": Claude Code, Codex, Grok · Grok drafts · 3 cycles · 2 revisions.');
  const replaced = await overrule(base, ['councils', 'save', 'Last', '--from', overridden.id, '--replace']);
  assert.match(replaced.stdout, /^Replaced the council "Last": Claude Code, Codex · Claude Code drafts · 1 cycle · 2 revisions · no research · automatic call limit, 90 min/);

  assert.equal((await overrule(base, ['councils', 'rename', 'Last', 'Short', 'review'])).stdout.trim(), 'Renamed the council "Last" to "Short review".');
  const refused = await overrule(base, ['councils', 'remove', 'Quick']);
  assert.equal(refused.code, 1); assert.match(refused.stderr, /Pass --yes/);
  assert.equal((await overrule(base, ['councils', 'remove', 'quick', '--yes'])).stdout.trim(), 'Removed the council "Quick". Its connections stay saved.');

  // Removing a connection says which councils it left; a council left with one seat says so when used.
  const gone = await overrule(base, ['connections', 'remove', 'Grok', '--yes']);
  assert.match(gone.stderr, /It left the council "Full", which has 2 seats left; its drafter was that connection, so it no longer names one\./);
  await call('/api/councils', 'POST', { name: 'Duo', seats: [ids.fable, ids.sol] });
  await overrule(base, ['connections', 'remove', 'Sol', '--yes']);
  assert.match((await overrule(base, ['councils'])).stdout, /Duo \(needs seats\)/);
  assert.match((await overrule(base, ['ask', 'x', '--council', 'Duo'])).stderr, /The council "Duo" has 1 seat left; a meeting needs two\./);
  assert.deepEqual(JSON.parse((await overrule(base, ['councils', '--json'])).stdout).map(c => c.name).sort(), ['Duo', 'Full', 'Short review']);
  assert.ok(GROUP_IDS.length === 5);
});
