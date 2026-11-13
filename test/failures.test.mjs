// Failure handling for model lists and connection tests: providers that are slow, hang, stall mid-answer, or cannot be reached;
// lists that are empty, not JSON, the wrong shape, partly broken, or long; a damaged cache file; keys pasted with stray characters.
// Deadlines are shortened here so the suite stays quick; test/key-leak.test.mjs runs the real server with the real ones.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../server.mjs';
import { OVERRIDE_ENV, cleanKey } from '../lib/providers.mjs';
import { normalize, checkModel, hintFor } from '../lib/models.mjs';
import { TEST_TIMEOUT_SECONDS, testTimeoutSeconds } from '../lib/connection-test.mjs';
import { startFakeProvider } from '../scripts/fake-provider.mjs';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'overrule.mjs');
const LIST_TIMEOUT_MS = 600;

function setEnv(t, name, value) {
  const before = process.env[name];
  if (value === undefined) delete process.env[name]; else process.env[name] = value;
  t.after(() => { if (before === undefined) delete process.env[name]; else process.env[name] = before; });
}
async function setup(t, { directory, catalogOptions = {}, saveCheckWaitMs = 300, slowMs = 30_000, fake: shared } = {}) {
  const fake = shared || await startFakeProvider({ slowMs });
  setEnv(t, OVERRIDE_ENV, fake.url);
  directory ||= await mkdtemp(join(tmpdir(), 'overrule-failures-'));
  const app = createApp({ directory, addresses: [], detect: async () => ({ codex: { installed: true, signedIn: true }, claude: { installed: true, signedIn: true } }), catalogOptions: { timeoutMs: LIST_TIMEOUT_MS, ...catalogOptions }, saveCheckWaitMs });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const bootstrap = await (await fetch(base + '/api/bootstrap')).json();
  const headers = { 'Content-Type': 'application/json', 'X-Mesh-Token': bootstrap.token };
  const stop = async () => { app.server.closeAllConnections(); await new Promise(resolve => app.server.close(resolve)); };
  t.after(async () => { await stop(); if (!shared) await fake.close(); await rm(directory, { recursive: true, force: true }); });
  const post = async (path, body) => { const started = Date.now(); const response = await fetch(base + path, { method: 'POST', headers, body: JSON.stringify(body) }); return { ...(await response.json()), status: response.status, seconds: (Date.now() - started) / 1000 }; };
  const upstream = provider => fake.requests.filter(r => r.provider === provider).length;
  return { fake, app, base, bootstrap, directory, stop, post, upstream, list: body => post('/api/models', body), test: body => post('/api/providers/test', body) };
}
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

test('a provider that answers in 30 seconds, never answers, or stops halfway is given up on at the deadline and said to be unreachable', async t => {
  const { list, test: check, fake, bootstrap } = await setup(t);
  assert.deepEqual(bootstrap.limits, { listSeconds: LIST_TIMEOUT_MS / 1000, testSeconds: TEST_TIMEOUT_SECONDS }, 'the form is told the deadlines it shows');
  for (const mode of ['slow', 'hang', 'stall']) {
    const result = await list({ type: 'openai', apiKey: `fake-${mode}` });
    assert.equal(result.errorKind, 'timeout', mode); assert.deepEqual(result.models, []);
    assert.equal(result.error, 'The provider did not answer within 0.6 seconds.');
    assert.match(result.hint, /may be busy/);
    assert.ok(result.seconds < 2, `${mode} took ${result.seconds}s`);
  }
  // Our side closes the connection at the deadline; nothing is left open at the provider.
  await wait(100);
  assert.ok(fake.requests.filter(r => r.provider === 'openai').every(r => r.hungUp || r.status), 'every abandoned request was hung up');

  const before = TEST_TIMEOUT_SECONDS.api; TEST_TIMEOUT_SECONDS.api = 1; t.after(() => { TEST_TIMEOUT_SECONDS.api = before; });
  for (const mode of ['hang', 'stall']) {
    const result = await check({ type: 'anthropic', model: 'claude-opus-5', apiKey: `fake-${mode}` });
    assert.equal(result.ok, false);
    assert.match(result.checks.at(-1).text, /^No answer from 127\.0\.0\.1:\d+ within 1 seconds\. The provider may be busy/);
    assert.ok(result.seconds < 3, `${mode} test took ${result.seconds}s`);
  }

  const local = await list({ type: 'compatible', baseUrl: 'http://127.0.0.1:9/v1' });
  assert.equal(local.errorKind, 'unreachable'); assert.equal(local.error, 'Could not reach 127.0.0.1:9.');
  assert.equal(local.hint, 'Check that the server is running at http://127.0.0.1:9/v1 (for Ollama, ollama serve), then try again.');
  assert.equal(hintFor('unreachable', 'openai', 'https://api.openai.com/v1'), 'Check that this machine can reach the internet, then try again.');
  // A server on this machine gets longer to answer a test: the first request can load a model into memory.
  assert.equal(testTimeoutSeconds({ type: 'compatible', baseUrl: 'http://localhost:11434/v1' }), TEST_TIMEOUT_SECONDS.local);
  assert.equal(testTimeoutSeconds({ type: 'compatible', baseUrl: 'https://llm.example/v1' }), 1);
  assert.equal(testTimeoutSeconds({ type: 'codex-cli' }), TEST_TIMEOUT_SECONDS.cli);
});

test('a failure is remembered for a moment, shared by everyone asking, and retried on request', async t => {
  const { list, upstream } = await setup(t, { catalogOptions: { failureTtlMs: 1500 } });
  const first = await list({ type: 'openai', apiKey: 'fake-hang-1' });
  assert.equal(first.errorKind, 'timeout'); assert.equal(first.remembered, undefined); assert.equal(upstream('openai'), 1);
  // Typing, reopening the form, or another device asking within the window does not wait on the provider again.
  const again = await list({ type: 'openai', apiKey: 'fake-hang-1' });
  // The proof is that the provider was not asked again; the time is a generous bound under load, well short of the 0.6 s deadline.
  assert.equal(again.remembered, true); assert.equal(again.errorKind, 'timeout'); assert.equal(upstream('openai'), 1); assert.ok(again.seconds < 0.5);
  assert.ok(Date.parse(again.failedAt) <= Date.now());
  // Refresh asks now, whatever was remembered.
  const forced = await list({ type: 'openai', apiKey: 'fake-hang-1', refresh: true });
  assert.equal(forced.remembered, undefined); assert.equal(upstream('openai'), 2);
  // After the window, the next ordinary request asks again.
  await wait(1600);
  await list({ type: 'openai', apiKey: 'fake-hang-1' }); assert.equal(upstream('openai'), 3);

  // Five requests at once while the provider hangs: one request reaches it, all five get its answer.
  const answers = await Promise.all(Array.from({ length: 5 }, () => list({ type: 'openai', apiKey: 'fake-hang-2' })));
  assert.equal(upstream('openai'), 4); assert.ok(answers.every(a => a.errorKind === 'timeout'));
  // A failure for one key says nothing about another.
  assert.equal((await list({ type: 'openai', apiKey: 'fake-key' })).models.length, 7);
});

test('a list already fetched is kept when the provider later fails, and replaced when it answers again', async t => {
  const { list, fake } = await setup(t, { catalogOptions: { ttlMs: 300 } });
  const good = await list({ type: 'anthropic', apiKey: 'fake-key' });
  assert.equal(good.models.length, 6); assert.equal(good.stale, false);
  for (const [mode, kind] of [['hang', 'timeout'], ['500', 'http'], ['garbage', 'format'], ['shape', 'format'], ['401', 'key']]) {
    fake.modes.anthropic = mode;
    const kept = await list({ type: 'anthropic', apiKey: 'fake-key', refresh: true });
    assert.equal(kept.stale, true, mode); assert.equal(kept.models.length, 6, mode); assert.equal(kept.errorKind, kind, mode);
    assert.equal(kept.fetchedAt, good.fetchedAt, 'the age shown is the age of the list, not of the failure');
  }
  // Past the ten-minute mark (shortened here) an ordinary request also keeps the old list while the provider is down.
  await wait(350);
  fake.modes.anthropic = 'hang';
  const aged = await list({ type: 'anthropic', apiKey: 'fake-key', refresh: true });
  assert.equal(aged.stale, true); assert.equal(aged.models.length, 6);
  delete fake.modes.anthropic;
  const back = await list({ type: 'anthropic', apiKey: 'fake-key', refresh: true });
  assert.equal(back.stale, false); assert.equal(back.error, null); assert.notEqual(back.fetchedAt, good.fetchedAt);
});

test('saving never waits long on a slow provider, and the list it was waiting for still arrives', async t => {
  const { post, list, fake, upstream } = await setup(t, { catalogOptions: { timeoutMs: 1500 }, saveCheckWaitMs: 300, slowMs: 800 });
  const saved = await post('/api/providers', { type: 'openai', name: 'Slow', model: 'gpt-5.6-sol', apiKey: 'fake-slow-save' });
  // "Has not answered yet" is the proof that saving did not wait for the list (it would have said "listed"); the time is a bound.
  assert.equal(saved.status, 201); assert.ok(saved.seconds < 1.5, `save took ${saved.seconds}s`);
  assert.deepEqual(saved.modelCheck, { status: 'unchecked', detail: 'gpt-5.6-sol was not checked: OpenAI API has not answered for its model list yet. Test connection tries the model itself.' });
  // The request carried on after the save answered, and its list is there for the next person who asks.
  await wait(900);
  const after = await list({ type: 'openai', connectionId: saved.id });
  assert.equal(after.cached, true); assert.equal(after.models.length, 7); assert.equal(upstream('openai'), 1);
  // A provider that cannot be reached at all gives its answer at once, so saving says why.
  const down = await post('/api/providers', { type: 'compatible', name: 'Down', model: 'm', baseUrl: 'http://127.0.0.1:9/v1' });
  assert.match(down.modelCheck.detail, /^m was not checked: could not reach 127\.0\.0\.1:9/);
  assert.equal(fake.requests.filter(r => r.hungUp).length, 0);
});

test('empty lists, lists that are not JSON or not lists, broken entries, 500 entries, and overlong lists', async t => {
  // Not a test of deadlines: the normal ten seconds, so streaming 8 MB on a busy machine is never mistaken for a timeout.
  const { list, fake } = await setup(t, { catalogOptions: { timeoutMs: 10_000 } });
  // Empty: an answer, not an error; a model cannot be checked against it.
  const empty = await list({ type: 'openai', apiKey: 'fake-empty' });
  assert.deepEqual([empty.models, empty.error, empty.errorKind, empty.stale], [[], null, null, false]);
  assert.equal(checkModel('openai', 'gpt-5.6', empty, { label: 'OpenAI API' }).status, 'unchecked');

  for (const mode of ['garbage', 'shape']) {
    const bad = await list({ type: 'compatible', baseUrl: `${fake.url}/compatible/v1`, apiKey: `fake-${mode}` });
    assert.equal(bad.errorKind, 'format'); assert.equal(bad.error, 'The provider returned a model list in an unexpected format.');
    assert.equal(bad.hint, 'Check that the base URL points at an OpenAI-compatible API, usually ending in /v1.');
  }
  assert.equal((await list({ type: 'gemini', apiKey: 'fake-shape' })).errorKind, 'format');
  const huge = await list({ type: 'openai', apiKey: 'fake-huge' });
  assert.equal(huge.errorKind, 'too-large'); assert.match(huge.error, /over 8 MB/);

  // One broken entry costs that entry, not the list.
  for (const [type, good, skipped] of [['openai', 7, 8], ['gemini', 4, 8], ['huggingface', 4, 8], ['grok', 3, 8]]) {
    const partial = await list({ type, apiKey: 'fake-nulls' });
    assert.equal(partial.error, null, type); assert.equal(partial.models.length, good, type); assert.equal(partial.skipped, skipped, type);
  }
  // Anthropic's first page here is all broken entries, so it gives no usable "next": the list says it is incomplete.
  const cut = await list({ type: 'anthropic', apiKey: 'fake-nulls' });
  assert.equal(cut.truncated, true); assert.equal(cut.error, null);

  // 500 models, in each provider's shape and paging: every one read, one in ten hidden, newest first.
  fake.requests.length = 0;
  for (const type of ['openai', 'anthropic', 'gemini', 'grok', 'huggingface']) {
    const many = await list({ type, apiKey: 'fake-many' });
    assert.equal(many.models.length, 450, type); assert.equal(many.hidden.length, 50, type); assert.equal(many.truncated, false, type);
    assert.match(many.models[0].id, /model-498$/, `${type} newest first`);
    assert.equal(new Set(many.models.map(m => m.id)).size, 450);
  }
  assert.equal(fake.requests.filter(r => r.provider === 'anthropic').length, 5, 'Anthropic read across five pages of 100');
  assert.equal(normalize('openai', Array.from({ length: 2100 }, (_, i) => ({ id: `m-${i}` }))).truncated, true);
  assert.equal(normalize('openai', Array.from({ length: 2100 }, (_, i) => ({ id: `m-${i}` }))).models.length, 2000);
});

test('a damaged model cache costs the cached lists and nothing else: the server starts, warns, and rewrites it', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'overrule-failures-cache-'));
  await writeFile(join(directory, 'models.json'), '{ "entries": { broken');
  const warnings = [];
  const warn = console.warn; console.warn = message => warnings.push(String(message)); t.after(() => { console.warn = warn; });
  const { list, stop, fake } = await setup(t, { directory });
  assert.deepEqual(warnings, ['data/models.json could not be read (not valid JSON); model lists will be fetched again and the file rewritten.']);
  assert.equal((await list({ type: 'grok', apiKey: 'fake-key' })).models.length, 3);
  const rewritten = JSON.parse(await readFile(join(directory, 'models.json'), 'utf8'));
  assert.equal(Object.keys(rewritten.entries).length, 1);
  await stop();

  // Entries of the wrong shape are dropped one by one; a good one beside them is kept.
  const key = Object.keys(rewritten.entries)[0];
  await writeFile(join(directory, 'models.json'), JSON.stringify({ version: 1, entries: {
    [key]: { ...rewritten.entries[key], models: [...rewritten.entries[key].models, null, { id: 'bad\u0007' }, { id: 42 }] },
    'openai|x|y': { models: 'nope', fetchedAt: new Date().toISOString() },
    'openai|x|z': { models: [], fetchedAt: 'yesterday' },
  } }));
  warnings.length = 0;
  const { list: again } = await setup(t, { directory, fake });
  const restored = await again({ type: 'grok', apiKey: 'fake-key' });
  assert.equal(restored.cached, true); assert.deepEqual(restored.models.map(m => m.id), ['grok-5', 'grok-4.1-fast', 'grok-4']);
  assert.deepEqual(warnings, []);
});

test('a pasted key is trimmed, and a key that cannot be sent is refused in words that never repeat it', async t => {
  const { list, test: check, post, fake } = await setup(t);
  assert.equal(cleanKey('  fake-key \n'), 'fake-key');
  assert.equal((await list({ type: 'openai', apiKey: ' fake-key\n' })).models.length, 7);
  assert.equal(fake.requests.at(-1).key, 'fake-key', 'the trimmed key is what was sent');
  assert.equal((await check({ type: 'openai', model: 'gpt-5.6', apiKey: '\tfake-key ' })).ok, true);
  const saved = await post('/api/providers', { type: 'openai', name: 'Padded', model: 'gpt-5.6', apiKey: ' fake-padded\n' });
  assert.equal((await list({ type: 'openai', connectionId: saved.id })).models.length, 7); assert.equal(fake.requests.at(-1).key, 'fake-padded');

  for (const bad of ['fake-key with-space', 'fake-key\u0001x', 'fake-keyé', 'fake-key\u2028x']) {
    const listed = await list({ type: 'openai', apiKey: bad });
    assert.equal(listed.status, 400); assert.equal(listed.error, 'The API key has characters a key cannot contain, such as spaces or control characters. Paste it again.');
    const tested = await check({ type: 'openai', model: 'gpt-5.6', apiKey: bad });
    assert.deepEqual(tested.checks.map(c => c.text), ['The API key has characters a key cannot contain, such as spaces or control characters. Paste it again.']);
    const refused = await post('/api/providers', { type: 'openai', name: 'Bad', model: 'gpt-5.6', apiKey: bad });
    assert.equal(refused.status, 400);
    for (const answer of [listed, tested, refused]) assert.ok(!JSON.stringify(answer).includes('with-space') && !JSON.stringify(answer).includes('\\u0001x'));
  }
  // An environment key is trimmed too; one that cannot be sent is named, never shown.
  setEnv(t, 'XAI_API_KEY', 'fake-env\n');
  assert.equal((await check({ type: 'grok', model: 'grok-5' })).ok, true);
  setEnv(t, 'XAI_API_KEY', 'fake-env\u0001secretpart');
  const envBad = await check({ type: 'grok', model: 'grok-5' });
  assert.deepEqual(envBad.checks.map(c => c.text), ['XAI_API_KEY on the server has characters a key cannot contain, such as spaces or control characters. Paste it again.']);
  const envList = await list({ type: 'grok' });
  assert.equal(envList.errorKind, 'key-format'); assert.ok(!JSON.stringify([envBad, envList]).includes('secretpart'));
});

function overrule(url, args, env = {}) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [CLI, ...args], { env: { ...process.env, OVERRULE_URL: url, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', d => { stdout += d; }); child.stderr.on('data', d => { stderr += d; });
    child.on('close', code => resolve({ code, stdout, stderr }));
  });
}

test('the command line reports the same failures: unreachable with what to check, remembered, stale, skipped, and long lists', async t => {
  const { base, fake } = await setup(t, { catalogOptions: { ttlMs: 200 } });
  const down = await overrule(base, ['models', 'compatible', '--base-url', 'http://127.0.0.1:9/v1']);
  assert.equal(down.code, 1);
  assert.match(down.stderr, /OpenAI-compatible API \(local or hosted\): can't reach the provider\. Could not reach 127\.0\.0\.1:9\. Check that the server is running at http:\/\/127\.0\.0\.1:9\/v1 \(for Ollama, ollama serve\), then try again\./);
  const remembered = await overrule(base, ['models', 'compatible', '--base-url', 'http://127.0.0.1:9/v1']);
  assert.match(remembered.stderr, /\(Tried just now; --refresh tries again now\.\)/);
  const timeout = await overrule(base, ['models', 'openai', '--key-env', 'K'], { K: 'fake-hang' });
  assert.match(timeout.stderr, /can't reach the provider\. The provider did not answer within 0\.6 seconds\./);

  assert.equal((await overrule(base, ['models', 'grok', '--key-env', 'K'], { K: 'fake-key' })).code, 0);
  await wait(250); fake.modes.grok = 'hang';
  const stale = await overrule(base, ['models', 'grok', '--key-env', 'K'], { K: 'fake-key' });
  assert.equal(stale.code, 0, 'an old list is still a list');
  assert.match(stale.stderr, /Warning: the provider can't be reached now, so this is the list it gave just now\. The provider did not answer/);
  assert.match(stale.stdout, /grok-5/);
  delete fake.modes.grok;

  const empty = await overrule(base, ['models', 'openai', '--key-env', 'K'], { K: 'fake-empty' });
  assert.equal(empty.code, 0); assert.match(empty.stdout, /^OpenAI API: listed no models with the key given\./);
  const broken = await overrule(base, ['models', 'openai', '--key-env', 'K'], { K: 'fake-nulls' });
  assert.match(broken.stderr, /Note: 8 entries in the list could not be read and were skipped\./);
  const many = await overrule(base, ['models', 'huggingface', '--key-env', 'K'], { K: 'fake-many' });
  assert.equal(many.stdout.trim().split('\n').length, 451, 'a header and 450 models');
});
