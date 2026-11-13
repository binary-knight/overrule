// Model suggestions and the fake provider: every list adapter, the key rules, the cache, the save-time warning, the command line,
// and a whole meeting through the real API adapters. Everything runs against scripts/fake-provider.mjs on this machine.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../server.mjs';
import { apiBase, providerOverride, callProvider, detectClis, OVERRIDE_ENV } from '../lib/providers.mjs';
import { listModels, normalize, checkModel, exclusionReason } from '../lib/models.mjs';
import { Store } from '../lib/store.mjs';
import { startFakeProvider, CATALOG } from '../scripts/fake-provider.mjs';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'overrule.mjs');
const ids = result => result.models.map(m => m.id);

async function fakeProvider(t, options) {
  const fake = await startFakeProvider(options);
  t.after(() => fake.close());
  return fake;
}
// Every built-in type goes to the fake for the length of one test.
function override(t, url) {
  const before = process.env[OVERRIDE_ENV];
  process.env[OVERRIDE_ENV] = url;
  t.after(() => { if (before === undefined) delete process.env[OVERRIDE_ENV]; else process.env[OVERRIDE_ENV] = before; });
}
async function serve(t, { directory, ...options } = {}) {
  directory ||= await mkdtemp(join(tmpdir(), 'overrule-models-'));
  const app = createApp({ directory, addresses: [], detect: async () => ({ codex: { installed: true, signedIn: true }, claude: { installed: true, signedIn: true } }), ...options });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const bootstrap = await (await fetch(base + '/api/bootstrap')).json();
  const headers = { 'Content-Type': 'application/json', 'X-Mesh-Token': bootstrap.token };
  const call = async (path, method, body) => { const response = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }); return { status: response.status, body: await response.json(), raw: response }; };
  const stop = async () => { app.server.closeAllConnections(); await new Promise(resolve => app.server.close(resolve)); };
  t.after(async () => { await stop(); await rm(directory, { recursive: true, force: true }); });
  return { ...app, base, bootstrap, headers, directory, call, stop, models: body => call('/api/models', 'POST', body), save: body => call('/api/providers', 'POST', body) };
}

test('each provider list is read in its own shape, newest first, with non-conversation models hidden and counted', async t => {
  const fake = await fakeProvider(t);
  const env = { [OVERRIDE_ENV]: fake.url };
  const list = (type, key = 'fake-key', base = apiBase({ type }, env)) => listModels({ type, base, key });

  const openai = await list('openai');
  assert.deepEqual(ids(openai), ['gpt-6-astra', 'gpt-5.6-sol', 'gpt-5.6', 'gpt-5.6-2026-01-20', 'gpt-5.6-mini', 'o5-mini', 'gpt-5.5']);
  assert.deepEqual(openai.hidden.map(m => m.id).sort(), ['davinci-002', 'gpt-4o-search-preview', 'gpt-5.6-realtime', 'gpt-image-2', 'o5-deep-research', 'omni-moderation-latest', 'text-embedding-3-large', 'tts-2', 'whisper-2']);
  assert.match(openai.hidden.find(m => m.id === 'text-embedding-3-large').reason, /embedding/);
  assert.equal(openai.models[0].created, '2026-05-12T00:00:00.000Z');

  // Anthropic and Gemini page their lists; every page is read, and Gemini's key travels in a header, never the URL.
  fake.requests.length = 0;
  const anthropic = await list('anthropic');
  assert.deepEqual(ids(anthropic), CATALOG.anthropic.map(m => m.id));
  assert.equal(anthropic.models[0].label, 'Claude Fable 5.1');
  assert.equal(fake.requests.filter(r => r.provider === 'anthropic').length, 2, 'two pages of four');
  const gemini = await list('gemini');
  assert.deepEqual(ids(gemini), ['gemini-3-pro', 'gemini-3-flash', 'gemma-3-27b-it', 'gemini-2.5-pro'], 'no models/ prefix, newest version first');
  assert.equal(gemini.models[0].context, 1048576);
  assert.deepEqual(gemini.hidden.map(m => m.id).sort(), ['aqa', 'gemini-2.5-flash-preview-tts', 'gemini-embedding-001', 'imagen-4.0-generate-001']);
  assert.equal(fake.requests.filter(r => r.provider === 'gemini').length, 2);
  assert.ok(fake.requests.filter(r => r.provider === 'gemini').every(r => r.status === 200 && !r.path.includes('key=')));

  assert.deepEqual(ids(await list('grok')), ['grok-5', 'grok-4.1-fast', 'grok-4']);
  const hf = await list('huggingface', '');
  assert.deepEqual(ids(hf), ['deepseek-ai/DeepSeek-V3.2', 'openai/gpt-oss-120b', 'Qwen/Qwen3-Coder-480B-A35B-Instruct', 'meta-llama/Llama-3.3-70B-Instruct'], 'the router lists without a token');
  assert.match(hf.models.find(m => m.id === 'openai/gpt-oss-120b').description, /served by cerebras, groq, novita, together and 1 more/);
  assert.deepEqual(hf.hidden.map(m => m.id).sort(), ['BAAI/bge-m3', 'black-forest-labs/FLUX.1-dev']);
  const local = await list('compatible', '', `${fake.url}/compatible/v1`);
  assert.deepEqual(ids(local), ['gpt-oss:20b', 'qwen2.5-coder:32b', 'llama3.3:latest']);
  assert.deepEqual(local.hidden.map(m => m.id), ['nomic-embed-text:latest']);

  // A key that sees fewer models gets the shorter list.
  assert.deepEqual(ids(await list('openai', 'fake-limited')), ['gpt-5.6-mini', 'gpt-5.5']);
});

test('the conversation filter is by name and metadata, and keeps ordinary chat and instruct models', () => {
  for (const id of ['gpt-5.6', 'claude-opus-5', 'Qwen/Qwen2.5-7B-Instruct', 'llama-3.2-11b-vision-instruct', 'gemma-3-27b-it', 'grok-4.1-fast', 'qwen2.5-coder:32b', 'deliverance-7b']) assert.equal(exclusionReason('huggingface', id), null, id);
  assert.equal(exclusionReason('openai', 'gpt-3.5-turbo-instruct'), 'a legacy completions model');
  assert.equal(exclusionReason('huggingface', 'gpt-3.5-turbo-instruct'), null, 'legacy-completions rule is OpenAI only');
  for (const id of ['mistral-ocr-latest', 'gemini-live-2.5-flash', 'gpt-4o-audio-preview', 'multilingual-e5-large', 'llama-guard-4-12b', 'jina-reranker-v2']) assert.ok(exclusionReason('huggingface', id), id);
  const { models, hidden } = normalize('compatible', [{ id: 'a' }, { id: 'a' }, { id: 'bad\nid' }, { id: 'tab\tid' }, { id: 'x'.repeat(161) }, { id: 42 }, { id: '' }, { id: 'b', generates: false }]);
  assert.deepEqual(models.map(m => m.id), ['a']);
  assert.deepEqual(hidden, [{ id: 'b', reason: 'a model that does not generate text' }]);
});

test('a failing provider gives a reason the owner can act on and never repeats its own response body', async t => {
  const fake = await fakeProvider(t, { slowMs: 2000 });
  const base = apiBase({ type: 'openai' }, { [OVERRIDE_ENV]: fake.url });
  const failure = async (key, options) => { try { await listModels({ type: 'openai', base, key }, options); } catch (error) { return error.message; } assert.fail(`${key} should fail`); };
  const rejected = await failure('sk-real-looking-secret');
  assert.match(rejected, /rejected the key \(HTTP 401\)/); assert.ok(!rejected.includes('sk-real-looking-secret'), 'the provider echoed the key; we must not');
  assert.ok(!(await failure('fake-401')).includes('fake-401'));
  assert.match(await failure('fake-429'), /rate limiting.*429/);
  assert.match(await failure('fake-404'), /does not list models.*Type the model ID/);
  assert.match(await failure('fake-500'), /HTTP 500/);
  assert.match(await failure('fake-garbage'), /unexpected format/);
  assert.match(await failure('fake-redirect'), /redirect, which is refused/);
  assert.match(await failure('fake-huge'), /model list was over 8 MB/);
  assert.match(await failure('fake-slow', { timeoutMs: 200 }), /did not answer within 0\.2 seconds/);
  assert.match(await failure('fake-key', { fetchImpl: async () => { throw new TypeError('fetch failed'); } }), /Could not reach 127\.0\.0\.1:\d+\./);
  assert.deepEqual(await listModels({ type: 'openai', base, key: 'fake-empty' }), { models: [], hidden: [], skipped: 0, truncated: false });
});

test('the provider override accepts only this machine and is never saved with a connection', async t => {
  assert.equal(providerOverride({}), null);
  assert.equal(providerOverride({ [OVERRIDE_ENV]: 'http://127.0.0.1:4999/' }), 'http://127.0.0.1:4999');
  assert.equal(providerOverride({ [OVERRIDE_ENV]: 'http://localhost:4999' }), 'http://localhost:4999');
  for (const bad of ['http://192.168.1.5:4999', 'https://fake.example', 'http://user:pw@127.0.0.1:1', 'http://127.0.0.1:1/?x=1', 'file:///tmp', 'nonsense']) assert.throws(() => providerOverride({ [OVERRIDE_ENV]: bad }), new RegExp(OVERRIDE_ENV), bad);
  assert.equal(apiBase({ type: 'gemini' }, { [OVERRIDE_ENV]: 'http://127.0.0.1:9' }), 'http://127.0.0.1:9/gemini/v1beta/openai');
  assert.equal(apiBase({ type: 'openai' }, {}), 'https://api.openai.com/v1');
  assert.equal(apiBase({ type: 'compatible', baseUrl: 'http://localhost:11434/v1' }, { [OVERRIDE_ENV]: 'http://127.0.0.1:9' }), 'http://localhost:11434/v1', 'a compatible server keeps its own address');

  // A bad override fails the call instead of quietly reaching the real provider.
  const store = new Store(await mkdtemp(join(tmpdir(), 'overrule-override-')));
  t.after(() => rm(store.directory, { recursive: true, force: true }));
  override(t, 'http://evil.example');
  let reached = false;
  await assert.rejects(callProvider({ type: 'openai', model: 'm', secret: store.encrypt('k') }, { system: 's', prompt: 'p', maxTokens: 10, timeoutSeconds: 5, signal: new AbortController().signal }, store, async () => { reached = true; return Response.json({}); }), new RegExp(OVERRIDE_ENV));
  assert.equal(reached, false);

  const fake = await fakeProvider(t);
  override(t, fake.url);
  const app = await serve(t);
  assert.deepEqual(app.bootstrap.providerOverride, { url: fake.url, env: OVERRIDE_ENV });
  const saved = await app.save({ type: 'openai', name: 'Sol', model: 'gpt-5.6-sol', apiKey: 'fake-key' });
  assert.equal(saved.status, 201); assert.equal(saved.body.baseUrl, 'https://api.openai.com/v1');
  const file = await readFile(join(app.directory, 'providers.json'), 'utf8');
  assert.ok(!file.includes(fake.url) && !file.includes('fake-key'));
});

test('listing models picks the right key and never sends a saved key to an endpoint it was not saved for', async t => {
  const fake = await fakeProvider(t);
  override(t, fake.url);
  const app = await serve(t);
  const last = () => fake.requests.at(-1);

  // The route is a change-protected POST like every other: no token, no list.
  assert.equal((await fetch(app.base + '/api/models', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"type":"openai"}' })).status, 403);
  assert.match((await app.models({ type: 'nonsense' })).body.error, /supported connection type/);
  assert.match((await app.models({ type: 'openai', connectionId: 'missing' })).body.error, /Connection not found/);

  // No key anywhere: nothing is sent, and the answer says how to give one.
  const before = fake.requests.length;
  const none = (await app.models({ type: 'openai' })).body;
  assert.equal(none.needsKey, true); assert.equal(none.env, 'OPENAI_API_KEY'); assert.deepEqual(none.models, []);
  assert.equal(fake.requests.length, before);

  const typed = (await app.models({ type: 'openai', apiKey: 'fake-key' })).body;
  assert.equal(typed.keySource, 'typed'); assert.equal(typed.models.length, 7); assert.equal(last().key, 'fake-key');
  assert.ok(!JSON.stringify(typed).includes('fake-key'), 'the key never comes back');

  const sol = (await app.save({ type: 'openai', name: 'Sol', model: 'gpt-5.6-sol', apiKey: 'fake-limited' })).body;
  const saved = (await app.models({ type: 'openai', connectionId: sol.id })).body;
  assert.equal(saved.keySource, 'saved'); assert.deepEqual(ids(saved), ['gpt-5.6-mini', 'gpt-5.5'], 'the saved key, not the typed one, and its own cache entry');
  assert.equal(last().key, 'fake-limited');
  // The form's type changed away from the saved connection's: its key stays out of another provider's list.
  assert.equal((await app.models({ type: 'grok', connectionId: sol.id })).body.needsKey, true);

  // A compatible server's saved key goes only to the address it was saved with.
  const local = (await app.save({ type: 'compatible', name: 'Local', model: 'llama3.3', baseUrl: `${fake.url}/compatible/v1`, apiKey: 'fake-local' })).body;
  assert.equal((await app.models({ type: 'compatible', connectionId: local.id })).body.keySource, 'saved'); assert.equal(last().key, 'fake-local');
  const moved = (await app.models({ type: 'compatible', connectionId: local.id, baseUrl: `http://localhost:${new URL(fake.url).port}/compatible/v1` })).body;
  assert.equal(moved.keySource, 'none'); assert.equal(last().key, null, 'no key went to the new address');
  assert.match((await app.models({ type: 'compatible', baseUrl: 'http://10.0.0.5/v1' })).body.error, /HTTPS API base URL/);

  // The server's environment key is the last resort.
  process.env.XAI_API_KEY = 'fake-env'; t.after(() => { delete process.env.XAI_API_KEY; });
  const grok = (await app.models({ type: 'grok' })).body;
  assert.equal(grok.keySource, 'environment'); assert.equal(last().key, 'fake-env'); assert.deepEqual(ids(grok), ['grok-5', 'grok-4.1-fast', 'grok-4']);
});

test('lists are cached per key, refreshed on request, kept when the provider fails, and survive a restart without the key', async t => {
  const fake = await fakeProvider(t);
  override(t, fake.url);
  const directory = await mkdtemp(join(tmpdir(), 'overrule-models-cache-'));
  const first = await serve(t, { directory });
  const count = () => fake.requests.filter(r => r.provider === 'openai').length;

  const fresh = (await first.models({ type: 'openai', apiKey: 'fake-key' })).body;
  assert.equal(fresh.cached, false); assert.equal(count(), 1);
  const again = (await first.models({ type: 'openai', apiKey: 'fake-key' })).body;
  assert.equal(again.cached, true); assert.equal(again.fetchedAt, fresh.fetchedAt); assert.equal(count(), 1, 'served from the cache');
  await first.models({ type: 'openai', apiKey: 'fake-limited' }); assert.equal(count(), 2, 'another key is another list');
  const refreshed = (await first.models({ type: 'openai', apiKey: 'fake-key', refresh: true })).body;
  assert.equal(refreshed.cached, false); assert.equal(count(), 3);

  // The provider goes down: the last list comes back, marked stale, with the reason.
  fake.modes.openai = '503';
  const stale = (await first.models({ type: 'openai', apiKey: 'fake-key', refresh: true })).body;
  assert.equal(stale.stale, true); assert.equal(stale.models.length, 7); assert.match(stale.error, /HTTP 503/);
  // With no earlier list there is nothing to fall back on.
  const nothing = (await first.models({ type: 'openai', apiKey: 'fake-never-seen', refresh: true })).body;
  assert.deepEqual(nothing.models, []); assert.match(nothing.error, /HTTP 503/);
  delete fake.modes.openai;

  const file = await readFile(join(directory, 'models.json'), 'utf8');
  assert.ok(!file.includes('fake-key') && !file.includes('fake-limited'), 'keys are never written, only a keyed hash');
  assert.ok(file.includes('gpt-6-astra'));
  await first.stop();
  const asked = count();
  const second = await serve(t, { directory });
  const restored = (await second.models({ type: 'openai', apiKey: 'fake-key' })).body;
  assert.equal(restored.cached, true); assert.equal(restored.models.length, 7); assert.equal(count(), asked, 'read from data/models.json after a restart');
});

test('Claude Code offers its aliases, Fable included, and Anthropic’s full list once an Anthropic key exists; Codex lists through its CLI', async t => {
  const fake = await fakeProvider(t);
  override(t, fake.url);
  let codexCalls = 0;
  const app = await serve(t, { modelRun: async (command, args) => { codexCalls++; assert.deepEqual([command, ...args], ['codex', 'debug', 'models']); return { code: 0, stdout: JSON.stringify({ models: [{ slug: 'gpt-5.6-codex', display_name: 'GPT-5.6 Codex' }, { slug: 'gpt-5.5' }, { slug: 'codex-auto-review' }] }) }; } });

  const aliases = (await app.models({ type: 'claude-cli' })).body;
  assert.deepEqual(ids(aliases), ['fable', 'opus', 'sonnet', 'haiku']);
  assert.equal(aliases.source, 'aliases'); assert.equal(aliases.aliasesOnly, true); assert.match(aliases.note, /ANTHROPIC_API_KEY/);

  await app.save({ type: 'anthropic', name: 'Anthropic account', model: 'claude-opus-5', apiKey: 'fake-key' });
  const full = (await app.models({ type: 'claude-cli' })).body;
  assert.deepEqual(ids(full), ['fable', 'opus', 'sonnet', 'haiku', ...CATALOG.anthropic.map(m => m.id)]);
  assert.equal(full.keySource, 'saved'); assert.equal(full.keyFrom, 'Anthropic account');
  process.env.ANTHROPIC_API_KEY = 'fake-limited'; t.after(() => { delete process.env.ANTHROPIC_API_KEY; });
  const env = (await app.models({ type: 'claude-cli' })).body;
  assert.equal(env.keyFrom, 'ANTHROPIC_API_KEY'); assert.deepEqual(ids(env), ['fable', 'opus', 'sonnet', 'haiku', 'claude-haiku-4-5']);

  const codex = (await app.models({ type: 'codex-cli' })).body;
  assert.deepEqual(ids(codex), ['gpt-5.6-codex', 'gpt-5.5'], 'the CLI order is kept and auto-review is left out');
  assert.equal(codex.models[0].label, 'GPT-5.6 Codex');
  await app.models({ type: 'codex-cli' }); assert.equal(codexCalls, 1, 'cached like any other list');
  // Checking a sign-in no longer lists Codex's models.
  assert.equal((await detectClis()).codex.models, undefined);
});

test('a model the provider does not list is saved with a warning, and the reason is specific', async t => {
  const fake = await fakeProvider(t);
  override(t, fake.url);
  const app = await serve(t);
  const check = async body => { const r = await app.save({ name: 'x', apiKey: 'fake-key', ...body }); assert.equal(r.status, 201, JSON.stringify(r.body)); return r.body.modelCheck; };

  assert.equal((await check({ type: 'openai', model: 'gpt-6-astra' })).status, 'listed');
  const typo = await check({ type: 'openai', model: 'gpt-6-astr' });
  assert.equal(typo.status, 'unlisted'); assert.match(typo.detail, /gpt-6-astr is not among the 7 models OpenAI API listed\. Saved anyway/);
  const embedding = await check({ type: 'openai', model: 'text-embedding-3-large' });
  assert.equal(embedding.status, 'not-for-conversation'); assert.match(embedding.detail, /^OpenAI API lists text-embedding-3-large as an embedding or ranking model/);
  assert.equal((await check({ type: 'huggingface', model: 'openai/gpt-oss-120b:fastest' })).status, 'listed', 'a router suffix is not part of the Hub name');
  const local = { type: 'compatible', baseUrl: `${fake.url}/compatible/v1`, apiKey: '' };
  assert.equal((await check({ ...local, model: 'llama3.3' })).status, 'listed', 'Ollama treats name and name:latest as one model');
  assert.match((await check({ ...local, model: 'mistral' })).detail, /^mistral is not among the 3 models the server at 127\.0\.0\.1:\d+ listed/);
  const down = await check({ type: 'compatible', baseUrl: 'http://127.0.0.1:9/v1', apiKey: '', model: 'anything' });
  assert.equal(down.status, 'unchecked'); assert.match(down.detail, /could not reach 127\.0\.0\.1:9/);
  assert.equal((await check({ type: 'claude-cli', model: 'fable' })).status, 'listed');
  assert.equal((await check({ type: 'claude-cli', model: 'claude-opus-5' })).status, 'unchecked', 'only aliases are known without an Anthropic key');
  assert.equal(await check({ type: 'codex-cli', model: '' }), null, 'a blank CLI model is the tool default');

  // Editing re-checks only when what decides the answer changed; a new role alone is not a reason to ask the provider again.
  const sol = (await app.save({ type: 'openai', name: 'Sol', model: 'gpt-6-astr', apiKey: 'fake-key' })).body;
  const put = body => app.call(`/api/providers/${sol.id}`, 'PUT', { type: 'openai', name: 'Sol', model: 'gpt-6-astr', ...body });
  assert.equal((await put({ role: 'Critic' })).body.modelCheck, null);
  assert.equal((await put({ model: 'gpt-5.6-sol' })).body.modelCheck.status, 'listed');
  assert.deepEqual(checkModel('openai', 'x', { models: [], hidden: [], error: null }, { label: 'OpenAI API' }).status, 'unchecked');
});

test('a whole scripted meeting runs through every API adapter against the fake provider', async t => {
  const fake = await fakeProvider(t);
  override(t, fake.url);
  const app = await serve(t);
  const members = [
    { type: 'openai', model: 'gpt-5.6-sol' }, { type: 'anthropic', model: 'claude-fable-5-1' }, { type: 'gemini', model: 'gemini-3-pro' },
    { type: 'grok', model: 'grok-5' }, { type: 'huggingface', model: 'openai/gpt-oss-120b:fastest' }, { type: 'compatible', model: 'llama3.3', baseUrl: `${fake.url}/compatible/v1` },
  ];
  const ids = [];
  for (const m of members) ids.push((await app.save({ name: `${m.type} member`, apiKey: m.type === 'compatible' ? '' : 'fake-key', ...m })).body.id);
  const started = await app.call('/api/runs', 'POST', { prompt: 'Choose a queue for billing events', participantIds: ids, drafterId: ids[0], cycles: 1 });
  assert.equal(started.status, 201, JSON.stringify(started.body));
  let run;
  for (let i = 0; i < 200; i++) { run = (await app.call(`/api/runs/${started.body.id}`, 'GET')).body; if (run.status !== 'running') break; await new Promise(r => setTimeout(r, 50)); }
  assert.equal(run.status, 'complete', run.error);
  assert.deepEqual(run.entries.filter(e => e.status === 'failed'), []);
  assert.equal(run.record.verdict.code, 'approved');
  assert.match(run.final, /written by the fake openai server, not by a model/);
  for (const type of ['openai', 'anthropic', 'gemini', 'grok', 'huggingface', 'compatible']) assert.ok(fake.requests.some(r => r.provider === type && r.method === 'POST' && r.status === 200), `${type} answered`);
  assert.ok(run.entries.every(e => e.usage?.output > 0), 'usage is reported through each adapter');

  // A model the provider does not have fails its turn the way a real provider would.
  const typo = (await app.save({ type: 'openai', name: 'Typo', model: 'gpt-6-astr', apiKey: 'fake-key' })).body;
  const failing = (await app.call('/api/runs', 'POST', { prompt: 'x', participantIds: [typo.id, ids[1]], drafterId: ids[1], cycles: 1 })).body;
  for (let i = 0; i < 200; i++) { run = (await app.call(`/api/runs/${failing.id}`, 'GET')).body; if (run.status !== 'running') break; await new Promise(r => setTimeout(r, 50)); }
  assert.match(run.entries.find(e => e.status === 'failed').error, /HTTP 404\. Check the model ID/);
});

// ---- the command line ----
function overrule(url, args, { env = {}, input } = {}) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [CLI, ...args], { env: { ...process.env, OVERRULE_URL: url, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', d => { stdout += d; }); child.stderr.on('data', d => { stderr += d; });
    child.on('close', code => resolve({ code, stdout, stderr }));
    child.stdin.end(input ?? '');
  });
}

test('the command line lists models and adds, edits and removes connections with the same checks as the browser', async t => {
  const fake = await fakeProvider(t);
  override(t, fake.url);
  const app = await serve(t, { modelRun: async () => ({ code: 0, stdout: '[{"slug":"gpt-5.6-codex"}]' }) });

  const noKey = await overrule(app.base, ['models', 'openai']);
  assert.equal(noKey.code, 1); assert.match(noKey.stderr, /only for a key\. Pass --key-env <VAR> or --key-stdin/);
  assert.match(noKey.stderr, new RegExp(`${OVERRIDE_ENV} is set on the server`));
  const listed = await overrule(app.base, ['models', 'openai', '--key-env', 'MY_KEY'], { env: { MY_KEY: 'fake-key' } });
  assert.equal(listed.code, 0, listed.stderr);
  assert.match(listed.stdout, /^OpenAI API: 7 models, listed just now with the key given\. 9 hidden as not for conversation \(--all shows them\)\./);
  assert.match(listed.stdout, /\n {2}gpt-6-astra +2026-05-12\n/); assert.ok(!listed.stdout.includes('text-embedding'));
  const all = await overrule(app.base, ['models', 'openai', '--key-stdin', '--all'], { input: 'fake-key\n' });
  assert.match(all.stdout, /Hidden, not for conversation:\n[\s\S]*text-embedding-3-large +an embedding or ranking model/);
  const json = JSON.parse((await overrule(app.base, ['models', 'claude', '--json'])).stdout);
  assert.deepEqual(ids(json), ['fable', 'opus', 'sonnet', 'haiku']);
  assert.match((await overrule(app.base, ['models', 'codex'])).stdout, /gpt-5\.6-codex/);
  assert.match((await overrule(app.base, ['models', 'compatible'])).stderr, /needs --base-url/);
  assert.match((await overrule(app.base, ['models', 'compatible', '--base-url', `${fake.url}/compatible/v1`])).stdout, /3 models/);
  assert.match((await overrule(app.base, ['models', 'nonsense'])).stderr, /neither a connection nor a type\. Types: codex, claude, openai/);
  assert.match((await overrule(app.base, ['models', 'openai', '--key-stdin'])).stderr, /No key arrived/);
  assert.match((await overrule(app.base, ['models', 'openai', '--key-env', 'UNSET_VARIABLE'])).stderr, /UNSET_VARIABLE is not set/);

  // Add: the key arrives on standard input; an unlisted model is saved with the browser's warning.
  const added = await overrule(app.base, ['connections', 'add', '--type', 'openai', '--name', 'Astra', '--model', 'gpt-6-astr', '--key-stdin'], { input: 'fake-key' });
  assert.equal(added.code, 0, added.stderr);
  assert.match(added.stdout, /^Added "Astra": OpenAI API, gpt-6-astr, saved API key\./);
  assert.match(added.stderr, /Warning: gpt-6-astr is not among the 7 models OpenAI API listed\. Saved anyway/);
  assert.ok(!(await readFile(join(app.directory, 'providers.json'), 'utf8')).includes('fake-key'));
  const byName = await overrule(app.base, ['models', 'astra']);
  assert.match(byName.stdout, /^Astra \(OpenAI API\): 7 models, listed just now with the saved key\./);

  // Edit keeps what is not given, and checks the new model.
  const edited = await overrule(app.base, ['connections', 'edit', 'Astra', '--model', 'gpt-6-astra', '--role', 'Critic']);
  assert.match(edited.stdout, /Updated "Astra": OpenAI API, gpt-6-astra, saved API key\./); assert.equal(edited.stderr.match(/Warning/), null);
  const wrongKind = await overrule(app.base, ['connections', 'edit', 'Astra', '--model', 'tts-2']);
  assert.match(wrongKind.stderr, /Warning: OpenAI API lists tts-2 as a speech, audio or realtime model/);
  await overrule(app.base, ['connections', 'add', '--preset', 'ollama', '--base-url', `${fake.url}/compatible/v1`, '--model', 'llama3.3']);
  const list = await overrule(app.base, ['connections']);
  assert.match(list.stdout, /Astra +OpenAI API +tts-2 +saved API key/);
  assert.match(list.stdout, /Ollama +OpenAI-compatible API \(local or hosted\) +llama3\.3 +custom endpoint/);
  const stored = (await app.call('/api/bootstrap', 'GET')).body.providers.find(p => p.name === 'Astra');
  assert.equal(stored.role, 'Critic'); assert.equal(stored.hasKey, true);

  assert.match((await overrule(app.base, ['connections', 'add', '--type', 'claude', '--key-env', 'K'], { env: { K: 'fake-key' } })).stderr, /take no key/);
  assert.match((await overrule(app.base, ['connections', 'add', '--type', 'compatible'])).stderr, /needs --base-url/);
  assert.match((await overrule(app.base, ['connections', 'edit', 'Nobody'])).stderr, /No connection named "Nobody"/);

  // Remove asks first, and with no terminal to ask on, refuses without --yes.
  const refused = await overrule(app.base, ['connections', 'remove', 'Astra']);
  assert.equal(refused.code, 1); assert.match(refused.stderr, /Pass --yes/);
  const removed = await overrule(app.base, ['connections', 'remove', 'astra', '--yes']);
  assert.equal(removed.stdout.trim(), 'Removed "Astra".');
  assert.ok(!(await app.call('/api/bootstrap', 'GET')).body.providers.some(p => p.name === 'Astra'));
});
