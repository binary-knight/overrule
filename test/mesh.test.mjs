import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve as resolvePath } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Store } from '../lib/store.mjs';
import { Mesh, validateRun, exportMarkdown } from '../lib/mesh.mjs';
import { callProvider, validateProvider, parseCli, cliCommand, interpretAuth, probeCli } from '../lib/providers.mjs';
import { createApp } from '../server.mjs';
import http from 'node:http';
import { Access } from '../lib/access.mjs';

async function setup(t) { const dir = await mkdtemp(join(tmpdir(), 'mesh-test-')); t.after(() => rm(dir, { recursive: true, force: true })); return new Store(dir); }
async function finished(mesh, run) { for (let i = 0; i < 900 && mesh.controllers.has(run.id); i++) await delay(10); assert.notEqual(run.status, 'running'); return run; }
const participants = ['Alpha', 'Beta'].map((name, i) => ({ id: String(i), name, type: 'compatible', model: 'test-model', baseUrl: 'http://localhost:9999/v1', role: name }));
const options = { prompt: 'Solve the problem', participants, drafterId: '0', cycles: 2, maxTokens: 4096, timeoutSeconds: 10 };

// Scripted council members for meeting tests. Each handler receives (provider, request, phase) and returns the reply text.
const phaseOf = prompt => /Write your OPENING POSITION/.test(prompt) ? 'opening' : /RATIFICATION BALLOT on candidate/.test(prompt) ? 'ratify' : /You are the drafter|You are the IMPLEMENTER/.test(prompt) ? 'draft' : 'turn';
const block = fields => '\n```json\n' + JSON.stringify(fields) + '\n```';
const opening = name => `${name} opens.` + block({ assumptions: ['a'], risk: 'r', criteria: ['c'], verification: 'unperformed' });
const turn = (text, fields) => text + block({ stance: 'agree', concedes: [], objections: [], resolves: [], settle: '', needs: null, nominates: null, verification: 'unperformed', ...fields });
const draft = text => text + block({ version: 1, unresolved: [], verification: 'unperformed' });
const ballot = (vote, objections = []) => `ballot ${vote}` + block({ vote, objections, reason: 'because' });
function council(script) {
  const calls = [];
  const call = async (provider, request) => { const phase = phaseOf(request.prompt); const number = calls.length; calls.push({ provider, request, phase }); const reply = await script(provider, request, phase, number, calls); return typeof reply === 'string' ? { text: reply, usage: { input: 10, output: 5 } } : reply; };
  return { calls, call };
}
const agreeable = (provider, request, phase) => phase === 'opening' ? opening(provider.name) : phase === 'turn' ? turn(`${provider.name} agrees.`) : phase === 'draft' ? draft(`Deliverable by ${provider.name}`) : ballot('approve');

test('floor turns read what was said before them, and the meeting closes by consensus with a ratified candidate', async t => {
  const store = await setup(t);
  const { calls, call } = council((provider, request, phase, number) => {
    if (phase === 'opening') return opening(provider.name);
    if (phase === 'turn') return turn(`Turn ${number} by ${provider.name}: "${provider.name === 'Alpha' ? 'Beta opens.' : 'Alpha opens.'}" is fine.`);
    if (phase === 'draft') return draft('The deliverable');
    return ballot('approve');
  });
  const mesh = new Mesh(store, call);
  const run = mesh.create({ ...options, cycles: 1 }); await finished(mesh, run);
  assert.equal(run.status, 'complete'); assert.equal(run.stopReason, 'consensus');
  assert.deepEqual(calls.map(c => c.phase), ['opening', 'opening', 'turn', 'turn', 'draft', 'ratify']);
  for (const c of calls.slice(0, 2)) assert.doesNotMatch(c.request.prompt, /opens\./);
  assert.match(calls[2].request.prompt, /Alpha opens\./); assert.match(calls[2].request.prompt, /Beta opens\./);
  assert.match(calls[3].request.prompt, /Turn 2 by Alpha/); assert.doesNotMatch(calls[2].request.prompt, /Turn 3/);
  assert.match(calls[5].request.prompt, /The deliverable/);
  assert.equal(calls[5].provider.name, 'Beta');
  assert.match(run.final, /^The deliverable/); assert.match(run.final, /1 approve/); assert.match(run.final, /No deliberation occurred/);
  assert.equal(run.record.metrics.label, 'no-deliberation');
  assert.match(exportMarkdown(run), /Meeting record/);
  assert.equal(new Mesh(store).runs[0].final, run.final);
});

test('objections are tracked by id, an uncited flip is re-asked once, and the raiser resolves', async t => {
  const store = await setup(t);
  const { calls, call } = council((provider, request, phase, number, all) => {
    if (phase === 'opening') return opening(provider.name);
    const turns = all.filter(c => c.phase === 'turn').length; // includes this call
    if (phase === 'turn' && turns === 1) return turn('"Beta opens." lacks a check.', { stance: 'disagree', objections: [{ against: 'Beta', claim: 'Beta opens.', condition: 'a check is named' }], settle: 'a named check', nominates: 'Beta' });
    if (phase === 'turn' && turns === 2) { assert.match(request.prompt, /Answer these objections addressed to you by id: o1/); return turn('On o1: the check is the test suite.', { stance: 'agree', concedes: [{ entry: 'e3', quote: 'lacks a check' }] }); }
    if (phase === 'turn' && turns === 3) { assert.match(request.prompt, /Assess the objections you raised \(o1\)/); return turn('Fine.', { stance: 'agree' }); } // uncited flip
    if (phase === 'turn' && turns === 4) { assert.match(request.prompt, /moved from disagree to agree without citing/); return turn('"the check is the test suite" resolves it.', { stance: 'agree', concedes: [{ entry: 'e4', quote: 'the check is the test suite' }], resolves: ['o1'] }); }
    if (phase === 'turn') return turn('Agreed.');
    if (phase === 'draft') return draft('Deliverable');
    return ballot('approve');
  });
  const mesh = new Mesh(store, call);
  const run = mesh.create({ ...options, cycles: 3 }); await finished(mesh, run);
  assert.equal(run.status, 'complete', run.error);
  assert.equal(run.issues.length, 1); assert.deepEqual([run.issues[0].id, run.issues[0].against, run.issues[0].status], ['o1', '1', 'resolved']);
  const alphaTurns = run.entries.filter(e => e.phase === 'floor' && e.speaker === '0');
  assert.equal(alphaTurns[1].superseded, true); assert.equal(alphaTurns[2].attempt, 2); assert.equal(alphaTurns[2].fields.stance, 'agree');
  assert.equal(run.record.metrics.citedConcessions, 2); assert.equal(run.record.metrics.label, null); assert.equal(run.stopReason, 'consensus');
  assert.doesNotMatch(calls.at(-1).request.prompt, /Fine\./); // superseded turn never re-enters the thread
});

test('a turn without a parseable block is recorded as disagree, the budget closes the meeting, and objections stay on the record', async t => {
  const store = await setup(t);
  const { call } = council((provider, request, phase) => phase === 'opening' ? opening(provider.name) : phase === 'turn' ? 'I have thoughts but no block.' : phase === 'draft' ? draft('Candidate') : ballot('object', [{ claim: 'Candidate', condition: 'evidence' }]));
  const mesh = new Mesh(store, call);
  const run = mesh.create({ ...options, cycles: 1 }); await finished(mesh, run);
  assert.equal(run.status, 'complete'); assert.equal(run.stopReason, 'budget');
  const floor = run.entries.filter(e => e.phase === 'floor');
  assert.equal(floor.length, 2); assert.ok(floor.every(e => e.fields.stance === 'disagree' && e.fields.openPoints[0] === 'structured fields unparsed'));
  assert.equal(run.revisions, 1); assert.equal(run.candidateVersion, 2);
  assert.equal(run.entries.filter(e => e.phase === 'draft').length, 2); assert.equal(run.entries.filter(e => e.phase === 'ratify').length, 2);
  assert.match(run.final, /Objections on record:\n- Beta: "Candidate" — resolves when: evidence/);
});

test('the owner can speak; the next member must address it and ballots on an existing candidate are invalidated', async t => {
  const store = await setup(t); let mesh;
  const { calls, call } = council(async (provider, request, phase, number, all) => {
    if (phase === 'opening') return opening(provider.name);
    if (phase === 'turn') return turn(`${provider.name}: ${/owner has just spoken/.test(request.prompt) ? 'Addressing the owner: "' + request.prompt.match(/OWNER interjection\n([^\n]+)/)[1] + '"' : 'agree'}`);
    if (phase === 'draft') { if (!all.some(c => c.phase === 'draft' && c !== all.at(-1))) mesh.say(mesh.runs[0], 'Please keep it under one page.'); return draft('Candidate'); }
    return ballot('approve');
  });
  mesh = new Mesh(store, call);
  const run = mesh.create({ ...options, cycles: 1 }); await finished(mesh, run);
  assert.equal(run.status, 'complete', run.error);
  const owner = run.entries.find(e => e.speaker === 'owner'); assert.ok(owner); assert.equal(owner.text, 'Please keep it under one page.');
  const after = run.entries[run.entries.indexOf(owner) + 1];
  assert.equal(after.phase, 'floor'); assert.match(after.text, /Addressing the owner: "Please keep it under one page\."/);
  assert.equal(run.candidateVersion, 2); assert.deepEqual(calls.map(c => c.phase), ['opening', 'opening', 'turn', 'turn', 'draft', 'turn', 'draft', 'ratify']);
  assert.equal(run.record.metrics.ownerInterjections, 1);
  assert.throws(() => mesh.say(run, 'late'), /not in session/);
});

test('one failed opening cannot be presented as a council, and a failed speaker is skipped', async t => {
  const store = await setup(t);
  const mesh = new Mesh(store, async (p, r) => { if (p.id === '1') throw new Error('Rate limit'); return agreeable(p, r, phaseOf(r.prompt)); });
  const run = mesh.create(options); await finished(mesh, run);
  assert.equal(run.status, 'failed'); assert.match(run.error, /Fewer than two members opened/); assert.equal(run.final, '');
  const three = [...participants, { id: '2', name: 'Gamma', type: 'compatible', model: 'test-model', baseUrl: 'http://localhost:9999/v1', role: 'Gamma' }];
  let betaTurns = 0;
  const mesh2 = new Mesh(await setup(t), async (p, r) => { const phase = phaseOf(r.prompt); if (p.id === '1' && phase === 'turn' && ++betaTurns <= 2) throw new Error('Timed out'); return agreeable(p, r, phase); });
  const run2 = mesh2.create({ ...options, participants: three, cycles: 2 }); await finished(mesh2, run2);
  assert.equal(run2.status, 'complete', run2.error);
  assert.equal(run2.entries.filter(e => e.speaker === '1' && e.status === 'failed').length, 2); assert.deepEqual(run2.dropped, ['1']);
  assert.ok(run2.entries.filter(e => e.phase === 'ratify').every(e => e.speaker !== '1'));
});

test('cancellation aborts pending calls and schedules no further turns', async t => {
  let aborted = 0;
  const mesh = new Mesh(await setup(t), async (p, { signal }) => { try { await delay(5000, null, { signal }); } catch (error) { aborted++; throw error; } });
  const run = mesh.create(options); mesh.cancel(run.id); await finished(mesh, run);
  assert.equal(run.status, 'cancelled'); assert.equal(aborted, 2); assert.equal(run.entries.length, 2); assert.ok(run.entries.every(e => e.status === 'cancelled'));
});

test('server restart marks partial meetings interrupted', async t => {
  const store = await setup(t); store.write('runs.json', [{ id: 'x', status: 'running', entries: [{ status: 'running' }] }]);
  const mesh = new Mesh(store); assert.equal(mesh.runs[0].status, 'interrupted'); assert.equal(mesh.runs[0].entries[0].status, 'interrupted');
});

test('encrypted keys round-trip, reject tampering, and use restricted file permissions', async t => {
  const store = await setup(t); const encrypted = store.encrypt('private-test-api-key');
  assert.equal(store.decrypt(encrypted), 'private-test-api-key');
  assert.notEqual(encrypted, store.encrypt('private-test-api-key'));
  const tampered = Buffer.from(encrypted, 'base64'); tampered[15] ^= 1; assert.throws(() => store.decrypt(tampered.toString('base64')));
  store.write('providers.json', [{ secret: encrypted }]);
  assert.ok(!(await readFile(join(store.directory, 'providers.json'), 'utf8')).includes('private-test-api-key'));
  assert.equal((await stat(join(store.directory, 'vault.key'))).mode & 0o777, 0o600);
});

test('input validation bounds cost and prevents invalid endpoint and key reuse', () => {
  const base = { prompt: 'test', participantIds: ['0', '1'], drafterId: '0' };
  assert.throws(() => validateRun({ ...base, cycles: 50 }, participants), /cycles/);
  assert.throws(() => validateRun({ ...base, participantIds: ['0', '0'] }, participants), /2 and 8/);
  assert.throws(() => validateRun({ ...base, timeoutSeconds: 0 }, participants), /timeout/);
  assert.throws(() => validateProvider({ name: 'test', type: 'compatible', model: 'm', baseUrl: 'http://evil.example/v1' }), /HTTPS/);
  assert.throws(() => validateProvider({ name: 'test', type: 'compatible', model: 'm', baseUrl: 'https://new.example/v1' }, { baseUrl: 'https://old.example/v1', secret: 'old-key' }), /Re-enter/);
  assert.equal(validateProvider({ name: 'test', type: 'compatible', model: 'm', baseUrl: 'http://localhost:11434/v1' }).baseUrl, 'http://localhost:11434/v1');
});

test('all API adapters authenticate server-side and normalize response text and usage', async t => {
  const store = await setup(t);
  for (const type of ['openai', 'anthropic', 'gemini', 'grok', 'compatible']) {
    let request;
    const fetchImpl = async (url, init) => {
      request = { url, ...init, data: JSON.parse(init.body) };
      return Response.json(type === 'openai' ? { status: 'completed', output: [{ content: [{ type: 'output_text', text: 'answer' }] }], usage: { input_tokens: 11, output_tokens: 7 } } : type === 'anthropic' ? { content: [{ type: 'text', text: 'answer' }], usage: { input_tokens: 11, output_tokens: 7 } } : { choices: [{ message: { content: 'answer' } }], usage: { prompt_tokens: 11, completion_tokens: 7 } });
    };
    const result = await callProvider({ type, model: 'example-model', baseUrl: 'https://api.example/v1', secret: store.encrypt('test-key') }, { system: 'instructions', prompt: 'user task', signal: new AbortController().signal, maxTokens: 2048, timeoutSeconds: 10 }, store, fetchImpl);
    assert.equal(result.text, 'answer'); assert.deepEqual(result.usage, { input: 11, output: 7 });
    assert.equal(request.redirect, 'error'); assert.equal(request.data.model, 'example-model');
    assert.equal(request.headers[type === 'anthropic' ? 'x-api-key' : 'Authorization'], type === 'anthropic' ? 'test-key' : 'Bearer test-key');
    if (type === 'openai') { assert.match(request.url, /\/responses$/); assert.equal(request.data.store, false); assert.equal(request.data.max_output_tokens, 2048); }
    else assert.equal(request.data.max_tokens, 2048);
  }
});

test('provider errors do not leak upstream error bodies or treat truncated answers as complete', async t => {
  const store = await setup(t), provider = { type: 'compatible', model: 'test', baseUrl: 'https://api.example/v1' };
  const request = { system: 'system', prompt: 'prompt', signal: new AbortController().signal, timeoutSeconds: 10, maxTokens: 1000 };
  await assert.rejects(callProvider(provider, request, store, async () => new Response('secret-upstream-token', { status: 401 })), error => /HTTP 401/.test(error.message) && !error.message.includes('secret-upstream-token'));
  await assert.rejects(callProvider(provider, request, store, async () => Response.json({ choices: [{ finish_reason: 'length', message: { content: 'partial' } }] })), /output limit/);
});

test('CLI adapters parse structured events and keep prompts out of command arguments', () => {
  assert.equal(parseCli('codex-cli', '{"type":"item.completed","item":{"type":"agent_message","text":"answer"}}\n{"type":"turn.completed","usage":{"input_tokens":3,"output_tokens":2}}').text, 'answer');
  assert.equal(parseCli('claude-cli', '{"subtype":"success","result":"answer"}').text, 'answer');
  assert.throws(() => parseCli('claude-cli', '{"is_error":true,"result":"raw diagnostic"}'), /could not complete/);
  assert.throws(() => parseCli('codex-cli', '{"type":"turn.failed"}'), /could not complete/);
  const [, args] = cliCommand('codex-cli', 'my-model'); assert.ok(args.includes('read-only')); assert.ok(args.includes('features.shell_tool=false'));
  const [, claudeArgs] = cliCommand('claude-cli', ''); assert.equal(claudeArgs[claudeArgs.indexOf('--tools') + 1], ''); assert.ok(claudeArgs.includes('--safe-mode'));
});

test('LAN pairing rejects forged and expired cookies and throttles wrong codes', async t => {
  const access = new Access(await setup(t), ['192.0.2.1']);
  const req = { headers: {}, socket: { remoteAddress: '192.0.2.2' } };
  assert.equal(access.authenticated(req), false);
  assert.equal(access.authenticated({ headers: { cookie: 'mesh_session=9999999999999.forged' } }), false);
  const result = access.unlock(req, access.code); assert.equal(result.status, 200);
  assert.equal(access.authenticated({ headers: { cookie: result.cookie } }), true);
  const expired = String(Date.now() - 1000);
  assert.equal(access.authenticated({ headers: { cookie: `mesh_session=${expired}.${access.sign(expired)}` } }), false);
  for (let i = 0; i < 6; i++) assert.equal(access.unlock(req, 'wrong').status, 401);
  assert.equal(access.unlock(req, access.code).status, 429);
  // Rotation replaces the code and revokes every session issued under the old one.
  const oldCode = access.code; access.rotate();
  assert.notEqual(access.code, oldCode); assert.ok(access.code.length >= 32);
  assert.equal(access.authenticated({ headers: { cookie: result.cookie } }), false);
  assert.equal(access.unlock({ headers: {}, socket: { remoteAddress: '192.0.2.3' } }, oldCode).status, 401);
  assert.equal(access.unlock({ headers: {}, socket: { remoteAddress: '192.0.2.3' } }, access.code).status, 200);
});

test('HTTP API enforces origin and CSRF, hides saved keys, persists history, and exports real workflow', async t => {
  const store = await setup(t);
  const { server, mesh, access } = createApp({ directory: store.directory, addresses: ['192.0.2.1'], detect: async () => ({ codex: { installed: true, signedIn: true }, claude: { installed: true, signedIn: true } }), providerCall: async (p, r) => ({ text: `Answer from ${p.name}` + (phaseOf(r.prompt) === 'opening' ? opening(p.name) : phaseOf(r.prompt) === 'turn' ? turn('') : phaseOf(r.prompt) === 'draft' ? draft('') : ballot('approve')), usage: { input: 1, output: 1 } }) });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const bootstrap = await (await fetch(base + '/api/bootstrap')).json();
  const headers = { 'Content-Type': 'application/json', 'X-Mesh-Token': bootstrap.token };
  assert.equal((await fetch(base + '/api/providers', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 403);
  assert.equal((await fetch(base + '/api/bootstrap', { headers: { Origin: 'https://attacker.example' } })).status, 403);
  const badHostStatus = await new Promise((resolve, reject) => { const request = http.get(base + '/api/bootstrap', { headers: { Host: 'attacker.example' } }, response => { response.resume(); resolve(response.statusCode); }); request.on('error', reject); });
  assert.equal(badHostStatus, 403);
  const lanRequest = (path, method = 'GET', data, cookie) => new Promise((resolve, reject) => {
    const request = http.request(base + path, { method, headers: { Host: `192.0.2.1:${server.address().port}`, 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) } }, response => {
      let text = ''; response.on('data', chunk => { text += chunk; }); response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, text }));
    }); request.on('error', reject); request.end(data ? JSON.stringify(data) : undefined);
  });
  assert.match((await lanRequest('/')).text, /Pair your device/);
  assert.equal((await lanRequest('/api/bootstrap')).status, 401);
  assert.equal((await lanRequest('/api/access')).status, 401);
  assert.equal((await lanRequest('/api/unlock', 'POST', { code: 'wrong' })).status, 401);
  const unlocked = await lanRequest('/api/unlock', 'POST', { code: access.code }); assert.equal(unlocked.status, 200);
  const cookie = unlocked.headers['set-cookie'][0];
  assert.match(cookie, /HttpOnly/); assert.match(cookie, /SameSite=Strict/);
  assert.equal((await lanRequest('/api/bootstrap', 'GET', undefined, cookie)).status, 200);
  assert.equal((await lanRequest('/api/access', 'GET', undefined, cookie)).status, 403);
  assert.equal((await lanRequest('/api/providers', 'POST', {}, cookie)).status, 403);
  const connection = { type: 'openai', name: 'API test', model: 'example', apiKey: 'sensitive-test-key' };
  const created = await (await fetch(base + '/api/providers', { method: 'POST', headers, body: JSON.stringify(connection) })).json();
  assert.equal(created.hasKey, true); assert.equal(created.secret, undefined); assert.equal(created.apiKey, undefined);
  assert.ok(!(await (await fetch(base + '/api/bootstrap')).text()).includes('sensitive-test-key'));
  const runResponse = await fetch(base + '/api/runs', { method: 'POST', headers, body: JSON.stringify({ prompt: 'Compare options', participantIds: bootstrap.providers.map(p => p.id), drafterId: bootstrap.providers[0].id, cycles: 1 }) });
  assert.equal(runResponse.status, 201);
  const { id } = await runResponse.json(); await finished(mesh, mesh.runs.find(r => r.id === id));
  const run = await (await fetch(`${base}/api/runs/${id}`)).json(); assert.equal(run.status, 'complete', run.error); assert.equal(run.entries.length, 6);
  const exported = await (await fetch(`${base}/api/runs/${id}/export`)).text(); assert.match(exported, /Answer from Claude Code/); assert.match(exported, /Answer from Codex/);
  const page = await fetch(base); assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
});

test('CLI readiness probe distinguishes signed in, signed out, and CLIs that cannot report', async () => {
  assert.equal(interpretAuth('codex', { code: 0, stdout: '', stderr: 'WARNING: could not create PATH aliases\nLogged in using ChatGPT\n' }).signedIn, true);
  assert.equal(interpretAuth('codex', { code: 0, stdout: 'Logged in using ChatGPT\n' }).signedIn, true);
  assert.equal(interpretAuth('codex', { code: 1, stdout: '', stderr: 'Not logged in\n' }).signedIn, false);
  assert.equal(interpretAuth('codex', { code: 1, stdout: 'Not logged in\n' }).signedIn, false);
  assert.equal(interpretAuth('codex', { code: 2, stderr: "error: unrecognized subcommand 'status'" }).signedIn, null);
  assert.equal(interpretAuth('claude', { code: 0, stdout: '{"loggedIn":true,"authMethod":"claude.ai"}' }).signedIn, true);
  assert.equal(interpretAuth('claude', { code: 1, stdout: '{"loggedIn":false}' }).signedIn, false);
  assert.equal(interpretAuth('claude', { code: 1, stderr: "error: unknown command 'auth'" }).signedIn, null);
  const missing = await probeCli('codex', async () => { throw new Error('codex is not installed or is not on PATH.'); });
  assert.equal(missing.installed, false);
  const signedOut = await probeCli('claude', async (command, args) => { assert.deepEqual(args, ['auth', 'status', '--json']); return { code: 1, stdout: '{"loggedIn":false}', stderr: '' }; });
  assert.deepEqual([signedOut.installed, signedOut.signedIn], [true, false]);
  let attempts = 0;
  const transient = await probeCli('codex', async () => (++attempts === 1 ? { code: 1, stdout: '', stderr: 'Not logged in\n' } : { code: 0, stdout: '', stderr: 'Logged in using ChatGPT\n' }), 5);
  assert.deepEqual([transient.signedIn, attempts], [true, 2]);
});

test('a signed-out CLI blocks a run before any call is spent, after one fresh probe', async t => {
  const store = await setup(t); let probes = 0, calls = 0;
  const { server, mesh } = createApp({ directory: store.directory, addresses: [], detect: async () => { probes++; return { codex: { installed: true, signedIn: probes > 2 }, claude: { installed: true, signedIn: true } }; }, providerCall: async (p, r) => { calls++; return { text: agreeable(p, r, phaseOf(r.prompt)) }; } });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const bootstrap = await (await fetch(base + '/api/bootstrap')).json();
  assert.equal(bootstrap.clis.codex.signedIn, false);
  const headers = { 'Content-Type': 'application/json', 'X-Mesh-Token': bootstrap.token };
  const body = JSON.stringify({ prompt: 'Compare options', participantIds: bootstrap.providers.map(p => p.id), drafterId: bootstrap.providers[0].id, cycles: 1 });
  const blocked = await fetch(base + '/api/runs', { method: 'POST', headers, body });
  assert.equal(blocked.status, 400); assert.match((await blocked.json()).error, /Codex is not signed in/); assert.equal(calls, 0); assert.equal(probes, 2);
  const checked = await (await fetch(base + '/api/clis/check', { method: 'POST', headers })).json();
  assert.equal(checked.codex.signedIn, true);
  const started = await fetch(base + '/api/runs', { method: 'POST', headers, body });
  assert.equal(started.status, 201); const { id } = await started.json(); await finished(mesh, mesh.runs.find(r => r.id === id)); assert.equal(calls, 6);
});

test('a failed drafter can be retried without repeating the floor, and an interrupted turn resumes by sequence', async t => {
  const store = await setup(t); let drafts = 0;
  const { calls, call } = council((provider, request, phase) => { if (phase === 'draft' && ++drafts === 1) throw new Error('Rate limit'); return agreeable(provider, request, phase); });
  const mesh = new Mesh(store, call);
  const run = mesh.create({ ...options, cycles: 1 }); await finished(mesh, run);
  assert.equal(run.status, 'failed'); assert.match(run.error, /drafter could not/); assert.equal(calls.length, 5);
  assert.throws(() => mesh.resume({ ...run, status: 'complete' }, participants), /Only a failed/);
  mesh.resume(run, participants); await finished(mesh, run);
  assert.equal(run.status, 'complete', run.error); assert.equal(calls.length, 7);
  assert.deepEqual(calls.slice(5).map(c => c.phase), ['draft', 'ratify']);
  const draftsRecorded = run.entries.filter(e => e.phase === 'draft'); assert.equal(draftsRecorded.length, 2); assert.deepEqual(draftsRecorded.map(e => [e.status, e.attempt]), [['failed', 1], ['complete', 2]]);
  assert.equal(run.error, undefined); assert.equal(new Mesh(store).runs[0].status, 'complete');
  // Interrupted mid-floor: the committed turns are reused and the meeting continues from the next speaker.
  const store2 = await setup(t);
  const partial = JSON.parse(JSON.stringify(run)); partial.id = 'p'; partial.status = 'running'; partial.stopReason = null; partial.final = ''; partial.record = undefined;
  partial.entries = partial.entries.slice(0, 3); partial.entries[2].status = 'running'; partial.seq = 3; partial.candidateVersion = 1; partial.revisions = 0;
  store2.write('runs.json', [partial]);
  const second = council(agreeable); const mesh2 = new Mesh(store2, second.call);
  const run2 = mesh2.runs[0]; assert.equal(run2.status, 'interrupted'); assert.equal(run2.entries[2].status, 'interrupted');
  mesh2.resume(run2, participants); await finished(mesh2, run2);
  assert.equal(run2.status, 'complete', run2.error);
  assert.deepEqual(second.calls.map(c => `${c.provider.name}:${c.phase}`), ['Alpha:turn', 'Beta:turn', 'Alpha:draft', 'Beta:ratify']);
  assert.doesNotMatch(second.calls[0].request.prompt, /\[e3\]/); // the interrupted attempt never enters the thread
});

test('history from before meetings stays readable but cannot be resumed', async t => {
  const store = await setup(t);
  store.write('runs.json', [{ id: 'old', createdAt: new Date().toISOString(), status: 'failed', phase: 'synthesize', prompt: 'Old', participants, synthesizerId: '0', rounds: 1, entries: [{ id: 'a', participantId: '0', name: 'Alpha', phase: 'propose', round: 0, status: 'complete', text: 'old proposal' }], final: '', plannedCalls: 5 }]);
  const mesh = new Mesh(store); assert.match(exportMarkdown(mesh.runs[0]), /old proposal/);
  assert.throws(() => mesh.resume(mesh.runs[0], participants), /predates meetings/);
});

test('the scripted demo ignores a draft prompt and stale mutation tokens are identifiable', async t => {
  const store = await setup(t);
  const { server, mesh } = createApp({ directory: store.directory, addresses: [], detect: async () => ({ codex: { installed: false }, claude: { installed: false } }) });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const stale = await fetch(base + '/api/runs', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Mesh-Token': 'old' }, body: '{}' });
  assert.equal(stale.status, 403); assert.equal((await stale.json()).code, 'stale-token');
  const { token } = await (await fetch(base + '/api/bootstrap')).json();
  const demo = await (await fetch(base + '/api/runs', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Mesh-Token': token }, body: JSON.stringify({ demo: true, prompt: 'I want you t' }) })).json();
  assert.doesNotMatch(demo.prompt, /I want you/); const demoRun = mesh.runs.find(r => r.id === demo.id); await finished(mesh, demoRun);
  assert.equal(demoRun.status, 'complete', demoRun.error); assert.equal(demoRun.stopReason, 'consensus'); assert.equal(demoRun.issues[0].status, 'resolved'); assert.match(demoRun.final, /in a meeting/);
});

// ---------- workspaces ----------
import { mkdir, writeFile, symlink, chmod, readFile as readFileP } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { validateWorkspacePath, validateRoot, browse, scanSecrets, git, inspect as inspectWorkspace, measureLevel } from '../lib/workspace.mjs';
import { runProcess, childEnv } from '../lib/providers.mjs';

async function repo(dir) {
  await mkdir(dir, { recursive: true });
  await git(dir, ['init', '-q', '-b', 'main']);
  await writeFile(join(dir, 'README.md'), '# demo\n');
  await git(dir, ['add', '-A']); await git(dir, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init']);
  // A hook that would reject every commit; the controller must ignore it.
  await mkdir(join(dir, '.git', 'hooks'), { recursive: true }); await writeFile(join(dir, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\nexit 1\n'); await chmod(join(dir, '.git', 'hooks', 'pre-commit'), 0o755);
  return dir;
}
const okCanary = async level => ({ level, ok: true, available: true, detail: 'stub boundary holds' });
const plainChecks = async (commands, cwd) => { const out = []; for (const command of commands) { const r = await (await import('../lib/providers.mjs')).runProcess('bash', ['-lc', command], { cwd, capture: true, signal: AbortSignal.timeout(20000) }); out.push({ command, code: r.code, output: r.stdout + r.stderr, seconds: 0 }); } return out; };

test('workspace paths are validated against the configured root, symlinks, hidden segments, and the app itself', async t => {
  const root = await mkdtemp(join(tmpdir(), 'mesh-root-')); t.after(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'project'); await mkdir(join(project, 'node_modules'), { recursive: true }); await mkdir(join(root, '.hidden', 'x'), { recursive: true });
  await writeFile(join(project, '.env'), 'X=1'); await writeFile(join(project, 'id_rsa'), 'k'); await writeFile(join(project, 'node_modules', '.env'), 'ignored'); await writeFile(join(project, 'app.js'), '');
  await symlink(project, join(root, 'link'));
  const rules = { roots: [root], appRoot: '/home/jknight/model-mesh', dataDir: join(root, 'appdata') }; await mkdir(join(root, 'appdata'));
  assert.equal(validateWorkspacePath(project, rules), project);
  assert.throws(() => validateWorkspacePath(project, { ...rules, roots: [] }), /No allowed directories/);
  assert.throws(() => validateRoot('/etc', rules), /System directories/); assert.throws(() => validateRoot('~', rules), /home directory itself/);
  assert.deepEqual(browse(null, rules).entries.map(e => e.path), [root]); assert.deepEqual(browse(root, rules).entries.map(e => e.name), ['appdata', 'project']);
  assert.throws(() => validateWorkspacePath(join(root, 'link'), rules), /Symlinked/);
  const elsewhere = await mkdtemp(join(tmpdir(), 'mesh-other-')); t.after(() => rm(elsewhere, { recursive: true, force: true }));
  assert.throws(() => validateWorkspacePath(elsewhere, rules), /must be inside/);
  assert.throws(() => validateWorkspacePath(join(root, '.hidden', 'x'), rules), /Hidden/);
  assert.throws(() => validateWorkspacePath(join(root, 'appdata'), rules), /own directory/);
  assert.throws(() => validateWorkspacePath(join(root, 'missing'), rules), /does not exist/);
  assert.deepEqual(scanSecrets(project).sort(), ['.env', 'id_rsa']);
  const info = await inspectWorkspace(project); assert.equal(info.git, false); assert.equal(info.secrets.length, 2);
});

test('a workspace-write meeting implements in an isolated checkout, commits past hooks, verifies, and can be applied or discarded', async t => {
  const root = await mkdtemp(join(tmpdir(), 'mesh-root-')); t.after(() => rm(root, { recursive: true, force: true }));
  const project = await repo(join(root, 'project'));
  const store = await setup(t); const seen = [];
  const { server, mesh, access } = createApp({ directory: store.directory, addresses: ['192.0.2.1'], workspaceRoot: root, canary: okCanary, checkRunner: plainChecks, measure: async level => ({ available: false, detail: 'stub: not measured' }),
    detect: async () => ({ codex: { installed: true, signedIn: true }, claude: { installed: true, signedIn: true } }),
    providerCall: async (p, r) => {
      const phase = phaseOf(r.prompt); seen.push({ name: p.name, phase, cwd: r.cwd, level: r.level, timeout: r.timeoutSeconds });
      if (phase === 'draft' && r.level === 'workspace-write') { assert.match(r.prompt, /You are the IMPLEMENTER/); await writeFile(join(r.cwd, 'hello.txt'), 'hello from the council\n'); return { text: draft('Added hello.txt as agreed.'), actions: [{ type: 'command_execution', command: 'echo hi', exitCode: 0 }] }; }
      if (phase === 'ratify') { assert.match(r.prompt, /CANDIDATE COMMIT/); assert.match(r.prompt, /\+hello from the council/); assert.match(r.prompt, /\$ cat hello.txt\nexit 0/); return { text: ballot('approve') }; }
      return { text: agreeable(p, r, phase) };
    } });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const bootstrap = await (await fetch(base + '/api/bootstrap')).json();
  const headers = { 'Content-Type': 'application/json', 'X-Mesh-Token': bootstrap.token };
  const post = (path, data) => fetch(base + path, { method: 'POST', headers, body: JSON.stringify(data) });
  const config = await (await fetch(base + '/api/workspace')).json(); assert.deepEqual(config.roots, [root]);
  // Allowed directories are managed from the page and persisted.
  const extra = join(root, 'extra'); await mkdir(extra);
  assert.deepEqual((await (await post('/api/workspace/roots', { path: extra })).json()).roots, [root, extra]);
  assert.match((await (await post('/api/workspace/roots', { path: '/usr' })).json()).error, /System directories/);
  const browsed = await (await post('/api/workspace/browse', { path: root })).json(); assert.ok(browsed.entries.some(e => e.name === 'project' && e.git));
  assert.deepEqual((await (await fetch(base + '/api/workspace/roots', { method: 'DELETE', headers, body: JSON.stringify({ path: extra }) })).json()).roots, [root]);
  assert.deepEqual(JSON.parse(await readFileP(join(store.directory, 'workspaces.json'), 'utf8')).roots, [root]);
  const inspected = await (await post('/api/workspace/inspect', { path: project })).json(); assert.equal(inspected.git, true); assert.equal(inspected.branch, 'main'); assert.equal(inspected.canaries['workspace-write'].ok, true);
  const ids = bootstrap.providers.map(p => p.id), codex = ids[0], claude = ids[1];
  const body = extra => ({ prompt: 'Add a greeting file', participantIds: ids, drafterId: codex, cycles: 1, workspace: { path: project, level: 'workspace-write', checks: ['cat hello.txt'], ...extra } });
  // Refusals: LAN session, wrong drafter, dirty tree, non-repository, secrets.
  const lan = await new Promise((resolve, reject) => { const request = http.request(base + '/api/runs', { method: 'POST', headers: { Host: `192.0.2.1:${server.address().port}`, 'Content-Type': 'application/json', 'X-Mesh-Token': bootstrap.token } }, response => { let text = ''; response.on('data', c => text += c); response.on('end', () => resolve({ status: response.statusCode, text })); }); request.on('error', reject); request.end(JSON.stringify(body())); });
  assert.equal(lan.status, 401);
  // A paired LAN device may attach: it is the owner working remotely. The origin is recorded on the meeting.
  const pairing = await new Promise((resolve, reject) => { const request = http.request(base + '/api/unlock', { method: 'POST', headers: { Host: `192.0.2.1:${server.address().port}`, 'Content-Type': 'application/json' } }, response => { response.resume(); response.on('end', () => resolve(response.headers['set-cookie'][0])); }); request.on('error', reject); request.end(JSON.stringify({ code: access.code })); });
  const lanInspect = await new Promise((resolve, reject) => { const request = http.request(base + '/api/workspace/inspect', { method: 'POST', headers: { Host: `192.0.2.1:${server.address().port}`, 'Content-Type': 'application/json', 'X-Mesh-Token': bootstrap.token, Cookie: pairing } }, response => { let text = ''; response.on('data', c => text += c); response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(text) })); }); request.on('error', reject); request.end(JSON.stringify({ path: project })); });
  assert.equal(lanInspect.status, 200); assert.equal(lanInspect.body.git, true);
  // A paired client that skips the interface meets the same server-side refusals: here the secrets acknowledgement.
  await writeFile(join(project, '.env'), 'SECRET=1');
  const lanCreate = await new Promise((resolve, reject) => { const request = http.request(base + '/api/runs', { method: 'POST', headers: { Host: `192.0.2.1:${server.address().port}`, 'Content-Type': 'application/json', 'X-Mesh-Token': bootstrap.token, Cookie: pairing } }, response => { let text = ''; response.on('data', c => text += c); response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(text) })); }); request.on('error', reject); request.end(JSON.stringify(body())); });
  assert.equal(lanCreate.status, 400); assert.match(lanCreate.body.error, /look like secrets/); await rm(join(project, '.env'));
  await writeFile(join(project, 'scratch.txt'), 'dirty'); assert.match((await (await post('/api/runs', body())).json()).error, /uncommitted changes/); await rm(join(project, 'scratch.txt'));
  await mkdir(join(root, 'plain')); assert.match((await (await post('/api/runs', body({ path: join(root, 'plain') }))).json()).error, /needs a git repository/);
  await writeFile(join(project, '.env'), 'SECRET=1'); assert.match((await (await post('/api/runs', body())).json()).error, /look like secrets/); await rm(join(project, '.env'));
  // The real thing.
  const created = await post('/api/runs', body()); const createdText = await created.text(); assert.equal(created.status, 201, createdText);
  const { id } = JSON.parse(createdText); const run = mesh.runs.find(r => r.id === id); await finished(mesh, run);
  assert.equal(run.status, 'complete', run.error);
  const floor = seen.filter(s => s.phase === 'turn' || s.phase === 'opening'); assert.ok(floor.length >= 3); assert.ok(floor.every(s => s.cwd === project && s.level === 'read-only'));
  const impl = seen.find(s => s.phase === 'draft'); assert.equal(impl.level, 'workspace-write'); assert.notEqual(impl.cwd, project); assert.equal(impl.timeout, 900);
  const vote = seen.find(s => s.phase === 'ratify'); assert.equal(vote.level, 'read-only'); assert.notEqual(vote.cwd, project); assert.notEqual(vote.cwd, impl.cwd);
  const candidate = run.entries.find(e => e.phase === 'draft').candidate;
  assert.equal(candidate.changed, true); assert.deepEqual(candidate.files, [{ status: 'A', path: 'hello.txt' }]); assert.notEqual(candidate.hash, candidate.base); assert.equal(candidate.checks[0].code, 0);
  assert.equal(run.entries.find(e => e.phase === 'draft').actions[0].command, 'echo hi');
  assert.equal(run.entries.find(e => e.phase === 'ratify').fields.opinion, undefined);
  assert.match(run.final, /Candidate commit/); assert.match(run.final, /cat hello.txt → passed/);
  assert.equal(run.workspace.impl, null); assert.equal(run.workspace.review, null); assert.ok(!existsSync(impl.cwd)); assert.ok(!existsSync(vote.cwd));
  assert.ok(!existsSync(join(project, 'hello.txt')), 'the owner tree is untouched until apply');
  assert.match(await (await fetch(`${base}/api/runs/${id}/patch`)).text(), /hello from the council/);
  assert.match(exportMarkdown(run), /Candidate commit/);
  const applied = await (await post(`/api/runs/${id}/apply`, {})).json(); assert.equal(applied.into, 'main'); assert.equal(await readFileP(join(project, 'hello.txt'), 'utf8'), 'hello from the council\n');
  assert.equal((await (await post(`/api/runs/${id}/apply`, {})).json()).into, 'main'); // applying twice is a harmless no-op merge
  // A second meeting, discarded instead of applied.
  const second = await (await post('/api/runs', { ...body(), prompt: 'Another' })).json(); const run2 = mesh.runs.find(r => r.id === second.id); await finished(mesh, run2);
  assert.equal(run2.status, 'complete', run2.error);
  const discarded = await (await post(`/api/runs/${second.id}/discard`, {})).json(); assert.ok(discarded.discarded);
  assert.doesNotMatch(await git(project, ['branch', '--list']), new RegExp(run2.workspace.branch));
  assert.match(await git(project, ['branch', '--list']), new RegExp(run.workspace.branch));
});

test('a long candidate reaches every voter in full', async t => {
  const store = await setup(t); const long = 'Section. ' + 'x'.repeat(20000) + ' THE-LAST-LINE';
  const { calls, call } = council((provider, request, phase) => phase === 'draft' ? draft(long) : phase === 'ratify' ? ballot('approve') : agreeable(provider, request, phase));
  const mesh = new Mesh(store, call); const run = mesh.create({ ...options, cycles: 1 }); await finished(mesh, run);
  assert.equal(run.status, 'complete', run.error);
  const vote = calls.find(c => c.phase === 'ratify'); assert.match(vote.request.prompt, /THE-LAST-LINE/); assert.doesNotMatch(vote.request.prompt, /truncated at 12,000/);
});

test('children get a minimal environment, and agentsec measurements are parsed and can gate a level', async t => {
  const env = childEnv({ HOME: '/h', PATH: '/bin', OPENAI_API_KEY: 'sk-secret', ANTHROPIC_API_KEY: 'x', CLAUDE_CODE_MESSAGING_TOKEN: 't', MESH_CLI_ENV_PASSTHROUGH: 'ANTHROPIC_API_KEY' });
  assert.deepEqual(env, { HOME: '/h', PATH: '/bin', ANTHROPIC_API_KEY: 'x' });
  process.env.MESH_TEST_LEAK = 'leaked'; t.after(() => delete process.env.MESH_TEST_LEAK);
  const seen = (await runProcess('sh', ['-c', 'echo "${MESH_TEST_LEAK:-scrubbed} ${HOME:+home}"'], { capture: true })).stdout.trim();
  assert.equal(seen, 'scrubbed home');
  // agentsec output parsing, with a fake binary that writes the two report shapes.
  const dir = await mkdtemp(join(tmpdir(), 'mesh-agentsec-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const fake = async (binary, args) => {
    const out = args[args.indexOf('--out') + 1];
    if (args[0] === 'blast-radius') await writeFile(join(out, `${args[args.indexOf('--label') + 1]}.json`), JSON.stringify({ summary: { score: 41, findings: [{ id: 'NET-003', severity: 'info', title: 'no network', category: 'network' }, { id: 'SEC-003', severity: 'high', title: 'Credential files readable', category: 'secrets' }] } }));
    else await writeFile(out, JSON.stringify({ rows: [{ path: join(dir, 'vault.key'), kind: 'not-readable', observed: 'READABLE', ok: false }, { path: '/home/x/.ssh', kind: 'not-readable', observed: 'not readable', ok: true }] }));
    return { code: 0, stdout: '', stderr: '' };
  };
  await writeFile(join(dir, 'vault.key'), 'k');
  const m = await measureLevel('read-only', dir, { dataDir: dir, binary: '/fake/agentsec', run: fake });
  assert.equal(m.score, 41); assert.deepEqual(m.findings.map(f => f.id), ['SEC-003']); assert.equal(m.secrets.filter(s => s.readable).length, 1); assert.match(m.detail, /1 of 2 secret paths readable/);
  assert.equal((await measureLevel('read-only', dir, { dataDir: dir, binary: null })).available, false);
  // The budget gate on attach.
  const root = await mkdtemp(join(tmpdir(), 'mesh-root-')); t.after(() => rm(root, { recursive: true, force: true }));
  const project = await repo(join(root, 'project')); const store = await setup(t);
  const { server } = createApp({ directory: store.directory, addresses: [], workspaceRoot: root, canary: okCanary, checkRunner: plainChecks, measure: async level => ({ available: true, tool: 'agentsec', level, score: 41, findings: [], secrets: [], detail: 'stub' }),
    detect: async () => ({ codex: { installed: true, signedIn: true }, claude: { installed: true, signedIn: true } }), providerCall: async (p, r) => ({ text: agreeable(p, r, phaseOf(r.prompt)) }) });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}`; const bootstrap = await (await fetch(base + '/api/bootstrap')).json();
  const headers = { 'Content-Type': 'application/json', 'X-Mesh-Token': bootstrap.token }; const post = (path, data) => fetch(base + path, { method: 'POST', headers, body: JSON.stringify(data) });
  const inspected = await (await post('/api/workspace/inspect', { path: project })).json(); assert.equal(inspected.measurements['read-only'].score, 41);
  assert.equal((await (await post('/api/workspace/budget', { maxScore: 30 })).json()).maxScore, 30);
  const body = { prompt: 'x', participantIds: bootstrap.providers.map(p => p.id), drafterId: bootstrap.providers[0].id, cycles: 1, workspace: { path: project, level: 'read-only' } };
  assert.match((await (await post('/api/runs', body)).json()).error, /blast radius is 41, above your budget of 30/);
  assert.equal((await (await post('/api/workspace/budget', { maxScore: null })).json()).maxScore, null);
  const created = await (await post('/api/runs', body)).json(); assert.equal(created.workspace.measurement.score, 41);
});

test('codex tool activity is captured from its event stream', () => {
  const lines = [
    '{"type":"item.completed","item":{"type":"command_execution","command":"npm test","exit_code":0,"aggregated_output":"ok\\n","status":"completed"}}',
    '{"type":"item.completed","item":{"type":"file_change","changes":[{"kind":"add","path":"hello.txt"}],"status":"completed"}}',
    '{"type":"item.completed","item":{"type":"reasoning","text":"thinking"}}',
    '{"type":"item.completed","item":{"type":"agent_message","text":"done"}}',
    '{"type":"turn.completed","usage":{"input_tokens":5,"output_tokens":2}}',
  ].join('\n');
  const parsed = parseCli('codex-cli', lines);
  assert.equal(parsed.text, 'done'); assert.equal(parsed.actions.length, 2);
  assert.deepEqual(parsed.actions[0], { type: 'command_execution', status: 'completed', command: 'npm test', exitCode: 0, output: 'ok\n' });
  assert.deepEqual(parsed.actions[1].paths, ['add hello.txt']);
  const [, args] = cliCommand('codex-cli', 'gpt-6-astra', { cwd: '/w', level: 'workspace-write', network: false });
  assert.ok(args.includes('workspace-write')); assert.ok(args.includes('sandbox_workspace_write.network_access=false')); assert.ok(!args.includes('features.shell_tool=false'));
  const [, floorArgs] = cliCommand('claude-cli', '', { cwd: '/w', level: 'read-only' }); assert.ok(floorArgs.includes('--restricted')); assert.ok(floorArgs.includes('Bash')); assert.ok(floorArgs.includes('--safe-mode')); assert.ok(!floorArgs.includes('--bare'), 'bare mode would drop OAuth sign-in');
  const [, writeArgs] = cliCommand('claude-cli', '', { cwd: '/w', level: 'workspace-write', sandboxed: true }); assert.ok(writeArgs.includes('acceptEdits')); assert.ok(writeArgs.includes('--settings')); assert.match(writeArgs[writeArgs.indexOf('--settings') + 1], /failIfUnavailable":true/);
  assert.ok(!cliCommand('claude-cli', '', { cwd: '/w', level: 'workspace-write', sandboxed: false })[1].includes('--settings'));
});

import { SecurityJobs, memberProfiles, validateImage, listPresets } from '../lib/security.mjs';

test('full access needs an acknowledgement, Claude may implement, and measurement can be skipped', async t => {
  const root = await mkdtemp(join(tmpdir(), 'mesh-root-')); t.after(() => rm(root, { recursive: true, force: true }));
  const project = await repo(join(root, 'project')); const store = await setup(t); const seen = [];
  const canaries = []; const measured = [];
  const { server, mesh } = createApp({ directory: store.directory, addresses: [], workspaceRoot: root, checkRunner: plainChecks,
    canary: async (level, cwd) => { canaries.push(level); return { level, ok: true, available: true, detail: level === 'full-access' ? 'No boundary, as chosen' : 'stub holds' }; },
    measure: async level => { measured.push(level); return { available: true, tool: 'agentsec', level, score: 88, findings: [], secrets: [], detail: 'stub' }; },
    detect: async () => ({ codex: { installed: true, signedIn: true }, claude: { installed: true, signedIn: true } }),
    providerCall: async (p, r) => { const phase = phaseOf(r.prompt); seen.push({ name: p.name, phase, level: r.level, sandboxed: r.sandboxed, cwd: r.cwd }); if (phase === 'draft' && r.cwd) { await writeFile(join(r.cwd, 'note.txt'), 'by claude\n'); return { text: draft('Wrote note.txt') }; } return { text: agreeable(p, r, phase) }; } });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}`; const bootstrap = await (await fetch(base + '/api/bootstrap')).json();
  const headers = { 'Content-Type': 'application/json', 'X-Mesh-Token': bootstrap.token }; const post = (path, data) => fetch(base + path, { method: 'POST', headers, body: JSON.stringify(data) });
  const ids = bootstrap.providers.map(p => p.id), claude = ids[1];
  const body = extra => ({ prompt: 'Add a note', participantIds: ids, drafterId: claude, cycles: 1, workspace: { path: project, level: 'full-access', ...extra } });
  assert.match((await (await post('/api/runs', body())).json()).error, /needs your acknowledgement/);
  const created = await (await post('/api/runs', body({ acknowledgeFullAccess: true, skipMeasurement: true, claudeSandbox: false }))).json();
  assert.equal(created.workspace.level, 'full-access'); assert.equal(created.workspace.network, true); assert.equal(created.workspace.skipMeasurement, true); assert.equal(created.workspace.measurement, null);
  assert.deepEqual(measured, []); assert.ok(canaries.includes('full-access'));
  const run = mesh.runs.find(r => r.id === created.id); await finished(mesh, run); assert.equal(run.status, 'complete', run.error);
  assert.ok(seen.filter(s => s.phase === 'turn').every(s => s.level === 'full-access'));
  const impl = seen.find(s => s.phase === 'draft'); assert.equal(impl.name, 'Claude Code'); assert.equal(impl.level, 'full-access'); assert.equal(impl.sandboxed, false);
  assert.equal(run.entries.find(e => e.phase === 'draft').candidate.files[0].path, 'note.txt');
  // A workspace-write meeting with a Claude drafter passes the sandboxed flag through.
  const second = await (await post('/api/runs', { ...body({ level: 'workspace-write' }), prompt: 'Again' })).json(); const run2 = mesh.runs.find(r => r.id === second.id); await finished(mesh, run2);
  assert.equal(run2.status, 'complete', run2.error); assert.equal(seen.filter(s => s.phase === 'draft').at(-1).sandboxed, true); assert.deepEqual(measured, ['workspace-write']);
});

test('the security page lists member boundaries and presets, queues measurements one at a time, and refuses launchers from the browser', async t => {
  const store = await setup(t);
  const rows = memberProfiles([{ id: 'c', name: 'Codex', type: 'codex-cli', model: '' }, { id: 'k', name: 'Claude Code', type: 'claude-cli', model: 'claude-opus-5' }, { id: 'a', name: 'API', type: 'openai', model: 'gpt-5.5' }]);
  assert.deepEqual(rows.filter(r => r.providerId === 'c').map(r => r.mode), ['talk', 'read-only', 'workspace-write', 'full-access']);
  assert.equal(rows.find(r => r.providerId === 'k' && r.mode === 'read-only').measurable, null); assert.equal(rows.find(r => r.providerId === 'k' && r.mode === 'workspace-write').measurable, 'claude');
  assert.equal(rows.find(r => r.providerId === 'a').measurable, null);
  assert.equal(validateImage('python:3.12-slim'), 'python:3.12-slim'); assert.throws(() => validateImage('python; rm -rf /'), /image name/);
  const presets = await listPresets('/x/.venv/bin/agentsec'); assert.deepEqual(presets, []); // no pack at that path
  const order = [];
  const jobs = new SecurityJobs(store.directory, { binary: '/fake/agentsec', presets: async () => [],
    measure: async (template, label) => { order.push(label); await delay(20); return { available: true, tool: 'agentsec', template, score: 26, findings: [{ id: 'SEC-003', severity: 'high', title: 'Credential files readable', category: 'secrets' }], secrets: [], detail: 'stub' }; },
    measureClaudeFn: async (provider, mode) => ({ available: true, tool: 'agentsec', level: mode, score: 41, findings: [], secrets: [], detail: 'stub claude', selfMeasured: true }) });
  const events = []; jobs.listeners.add(e => events.push(e.type));
  const { server } = createApp({ directory: store.directory, addresses: [], securityJobs: jobs, detect: async () => ({ codex: { installed: true, signedIn: true }, claude: { installed: true, signedIn: true } }) });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}`; const bootstrap = await (await fetch(base + '/api/bootstrap')).json();
  const headers = { 'Content-Type': 'application/json', 'X-Mesh-Token': bootstrap.token }; const post = (path, data) => fetch(base + path, { method: 'POST', headers, body: JSON.stringify(data) });
  const page = await (await fetch(base + '/api/security')).json(); assert.equal(page.agentsec, true); assert.equal(page.profiles.length, 8);
  const [codex, claude] = bootstrap.providers.map(p => p.id);
  assert.equal((await post('/api/security/run', { kind: 'member', providerId: codex, mode: 'read-only' })).status, 202);
  assert.equal((await post('/api/security/run', { kind: 'member', providerId: codex, mode: 'workspace-write' })).status, 202);
  assert.equal((await post('/api/security/run', { kind: 'member', providerId: claude, mode: 'full-access' })).status, 202);
  assert.match((await (await post('/api/security/run', { kind: 'member', providerId: claude, mode: 'read-only' })).json()).error, /cannot be measured/);
  assert.match((await (await post('/api/security/run', { kind: 'template', template: 'bash -c {probe}' })).json()).error, /Choose a member or a preset/);
  for (let i = 0; i < 100 && (jobs.current || jobs.queue.length); i++) await delay(20);
  assert.deepEqual(order, ['Codex-read-only', 'Codex-workspace-write']);
  const results = (await (await fetch(base + '/api/security')).json()).results;
  assert.equal(results.length, 3); assert.ok(results.some(r => r.selfMeasured && r.score === 41)); assert.ok(results.every(r => r.provider === undefined));
  assert.ok(events.includes('queued') && events.includes('started') && events.includes('finished'));
  assert.equal((await fetch(`${base}/api/security/results/${results[0].id}`, { method: 'DELETE', headers })).status, 200);
  assert.equal((await (await fetch(base + '/api/security')).json()).results.length, 2);
});

import { browseHost } from '../lib/workspace.mjs';
test('the host browser lists folders from the home directory and marks what can be allowed', async t => {
  const root = await mkdtemp(join(tmpdir(), 'mesh-host-')); t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'projects', 'app', '.git'), { recursive: true }); await mkdir(join(root, '.hidden')); await mkdir(join(root, 'node_modules'));
  const rules = { roots: [], appRoot: join(root, 'projects', 'app'), dataDir: join(root, 'projects', 'app', 'data') };
  const listing = browseHost(root, rules);
  assert.deepEqual(listing.entries.map(e => [e.name, e.selectable]), [['projects', true]]);
  assert.equal(listing.parent, resolvePath(root, '..'));
  const inner = browseHost(join(root, 'projects'), rules);
  assert.deepEqual(inner.entries.map(e => [e.name, e.git, e.selectable]), [['app', true, false]]); // the app's own directory cannot be allowed
  assert.equal(browseHost('/etc', rules).selectable, false);
  assert.throws(() => browseHost(join(root, 'missing'), rules), /does not exist/);
  const home = browseHost('', rules); assert.equal(home.selectable, false); assert.ok(Array.isArray(home.entries));
});

import { installAgentsec, vendoredAgentsec } from '../lib/security.mjs';
test('the in-app installer unpacks the vendored bundle, builds a venv, verifies the binary, and reports through the job queue', async t => {
  const box = await mkdtemp(join(tmpdir(), 'mesh-install-')); t.after(() => rm(box, { recursive: true, force: true }));
  // A vendored bundle like scripts/package-agentsec.sh produces: a tarball with an agentsec-pack/ prefix and a manifest beside it.
  const vendor = join(box, 'vendor'); await mkdir(join(box, 'src', 'agentsec-pack'), { recursive: true }); await writeFile(join(box, 'src', 'agentsec-pack', 'pyproject.toml'), '[project]\nname="agentsec-pack"\nversion="0.0.1"\n');
  await mkdir(vendor); await runProcess('tar', ['-czf', join(vendor, 'agentsec-pack-0.0.1-abcdef12.tar.gz'), '-C', join(box, 'src'), 'agentsec-pack'], { capture: true });
  await writeFile(join(vendor, 'agentsec.json'), JSON.stringify({ version: '0.0.1', commit: 'abcdef1234567890', date: '2026-09-17T00:00:00Z', file: 'agentsec-pack-0.0.1-abcdef12.tar.gz' }));
  assert.equal((await vendoredAgentsec(vendor)).version, '0.0.1'); assert.equal(await vendoredAgentsec(join(box, 'nowhere')), null);
  const target = join(box, 'home', 'agentsec-pack'); const commands = []; const log = [];
  // The runner records every command; venv and pip are simulated by creating the binary the installer checks for.
  const run = async (command, args, options) => {
    commands.push([command, ...args].join(' '));
    if (command === 'tar' || command === 'mv') return runProcess(command, args, options);
    if (command === 'python3') { await mkdir(join(target, '.venv', 'bin'), { recursive: true }); return { code: 0, stdout: '', stderr: '' }; }
    if (command.endsWith('/pip')) { await writeFile(join(target, '.venv', 'bin', 'agentsec'), '#!/bin/sh\necho preset table\n'); await chmod(join(target, '.venv', 'bin', 'agentsec'), 0o755); return { code: 0, stdout: 'Successfully installed agentsec-pack', stderr: '' }; }
    return { code: 0, stdout: 'preset table', stderr: '' };
  };
  const done = await installAgentsec({ vendorDir: vendor, target, run, log: l => log.push(l) });
  assert.equal(done.installed, true); assert.equal(done.binary, join(target, '.venv', 'bin', 'agentsec'));
  assert.ok(existsSync(join(target, 'pyproject.toml')), 'source unpacked into the target');
  assert.deepEqual(commands.map(c => c.split(' ')[0].split('/').pop()), ['tar', 'mv', 'python3', 'pip', 'agentsec']);
  assert.match(log.join('\n'), /Unpacking vendored agentsec-pack 0.0.1 \(abcdef12/); assert.match(log.at(-1), /Installed at/);
  assert.deepEqual(await installAgentsec({ vendorDir: vendor, target, run, log: () => {} }), { binary: done.binary, installed: false }); // idempotent
  // Through the job queue: no binary at first, the install job is allowed, and afterwards measurements are.
  const store = await setup(t);
  const jobs = new SecurityJobs(store.directory, { binary: null, vendorDir: vendor, presets: async () => [], install: async ({ log }) => { log('step'); return { binary: '/x/agentsec', installed: true }; }, measure: async () => ({ available: true, score: 1, findings: [], secrets: [], detail: 'ok' }) });
  assert.throws(() => jobs.enqueue({ kind: 'member', template: 'x', label: 'x' }), /not installed/);
  const events = []; jobs.listeners.add(e => events.push(e.type));
  jobs.enqueue({ kind: 'install', label: 'Install agentsec-pack' });
  for (let i = 0; i < 100 && (jobs.current || jobs.queue.length); i++) await delay(10);
  assert.equal(jobs.binary, '/x/agentsec'); assert.ok(events.includes('log') && events.includes('finished'));
  assert.doesNotThrow(() => jobs.enqueue({ kind: 'member', template: 'x', label: 'later' }));
});
