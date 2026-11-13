// Test connection: one short message through the meeting path, before anything is saved, with a checklist that says whether the
// provider was reached, the key accepted, and the model answered. Runs against scripts/fake-provider.mjs and fake CLIs on PATH.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, readFile, writeFile, mkdir, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../server.mjs';
import { callProvider, runProcess, OVERRIDE_ENV } from '../lib/providers.mjs';
import { TEST_TIMEOUT_SECONDS, TEST_MAX_TOKENS } from '../lib/connection-test.mjs';
import { Store } from '../lib/store.mjs';
import { startFakeProvider } from '../scripts/fake-provider.mjs';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'overrule.mjs');
const signedIn = { codex: { installed: true, signedIn: true }, claude: { installed: true, signedIn: true } };

function setEnv(t, name, value) {
  const before = process.env[name];
  process.env[name] = value;
  t.after(() => { if (before === undefined) delete process.env[name]; else process.env[name] = before; });
}
async function setup(t, { detect = async () => signedIn, slowMs } = {}) {
  const fake = await startFakeProvider({ slowMs });
  setEnv(t, OVERRIDE_ENV, fake.url);
  const directory = await mkdtemp(join(tmpdir(), 'overrule-conntest-'));
  const app = createApp({ directory, addresses: [], detect });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const { token } = await (await fetch(base + '/api/bootstrap')).json();
  const headers = { 'Content-Type': 'application/json', 'X-Mesh-Token': token };
  t.after(async () => { app.server.closeAllConnections(); await new Promise(resolve => app.server.close(resolve)); await fake.close(); await rm(directory, { recursive: true, force: true }); });
  const post = async (path, body, init = {}) => { const response = await fetch(base + path, { method: 'POST', headers, body: JSON.stringify(body), ...init }); return { status: response.status, body: await response.json() }; };
  const check = async body => { const r = await post('/api/providers/test', body); assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body; };
  const lines = result => result.checks.map(c => `${c.state}: ${c.text}`);
  return { fake, app, base, directory, headers, post, check, lines, save: body => post('/api/providers', body) };
}

test('a working connection passes with each part confirmed, through every API adapter', async t => {
  const { check, lines, fake } = await setup(t);
  const cases = [
    ['openai', 'gpt-5.6-sol'], ['anthropic', 'claude-fable-5-1'], ['gemini', 'gemini-3-pro'], ['grok', 'grok-5'], ['huggingface', 'openai/gpt-oss-120b:fastest'],
  ];
  for (const [type, model] of cases) {
    const result = await check({ type, model, apiKey: 'fake-key' });
    assert.equal(result.ok, true, `${type}: ${lines(result)}`);
    assert.deepEqual(lines(result).map(l => l.replace(/\d+ ms/, 'N ms')), [`ok: Reached ${new URL(fake.url).host}`, 'ok: The key given was accepted', `ok: ${model} answered in N ms: “OK”`]);
    assert.equal(result.reply, 'OK'); assert.equal(result.keySource, 'typed');
    const sent = fake.requests.filter(r => r.provider === type && r.method === 'POST').at(-1);
    assert.equal(sent.status, 200); assert.equal(sent.key, 'fake-key');
  }
  const local = await check({ type: 'compatible', model: 'llama3.3', baseUrl: `${fake.url}/compatible/v1` });
  assert.equal(local.ok, true); assert.equal(local.checks[1].text, 'No key was needed');
  // A reasoning model that spends the small allowance thinking has still accepted the key and the model.
  const thinking = await check({ type: 'openai', model: 'o5-mini', apiKey: 'fake-limit' });
  assert.equal(thinking.ok, true); assert.match(thinking.checks[2].text, new RegExp(`spent the test’s ${TEST_MAX_TOKENS}-token allowance before writing text`));
  assert.equal((await check({ type: 'anthropic', model: 'claude-opus-5', apiKey: 'fake-limit' })).ok, true);
  assert.equal((await check({ type: 'grok', model: 'grok-5', apiKey: 'fake-limit' })).ok, true);
});

test('a failing connection says which part failed, in the app’s words, without repeating the provider’s', async t => {
  const { check, lines, fake } = await setup(t);
  const host = new URL(fake.url).host;
  const badKey = await check({ type: 'openai', model: 'gpt-5.6-sol', apiKey: 'sk-not-a-fake-key' });
  assert.equal(badKey.ok, false);
  assert.deepEqual(lines(badKey), [`ok: Reached ${host}`, `fail: ${host} rejected the key given (HTTP 401, invalid_api_key). Check that it is the right key for this provider and has not been revoked.`]);
  assert.ok(!JSON.stringify(badKey).includes('sk-not-a-fake-key'), 'the provider echoed the key in its error body; the test result must not');
  const anthropicKey = await check({ type: 'anthropic', model: 'claude-opus-5', apiKey: 'sk-ant-wrong' });
  assert.match(anthropicKey.checks[1].text, /HTTP 401, authentication_error/); assert.ok(!JSON.stringify(anthropicKey).includes('sk-ant-wrong'));

  const model = await check({ type: 'anthropic', model: 'claude-opus-9', apiKey: 'fake-key' });
  assert.deepEqual(lines(model), [`ok: Reached ${host}`, 'ok: The key given was accepted', `fail: ${host} does not know the model claude-opus-9 (HTTP 404, not_found_error). Pick one from the list.`]);
  assert.match((await check({ type: 'compatible', model: 'nope', baseUrl: `${fake.url}/compatible/v1` })).checks[2].text, /or the base URL is not an OpenAI-compatible API/);
  assert.match((await check({ type: 'grok', model: 'grok-5', apiKey: 'fake-quota' })).checks[2].text, /^The key has no credit or quota left \(HTTP 429, insufficient_quota\)/);
  assert.match((await check({ type: 'openai', model: 'gpt-5.6', apiKey: 'fake-429' })).checks[2].text, /is rate limiting this key \(HTTP 429\)\. The key works/);
  assert.match((await check({ type: 'gemini', model: 'gemini-3-pro', apiKey: 'fake-403' })).checks[1].text, /refused the key given for gemini-3-pro \(HTTP 403\)/);
  const down = await check({ type: 'openai', model: 'gpt-5.6', apiKey: 'fake-503' });
  assert.deepEqual(down.checks.map(c => c.state), ['ok', 'fail']); assert.match(down.checks[1].text, /had an error of its own \(HTTP 503\)/);
  assert.match((await check({ type: 'compatible', model: 'x', baseUrl: `${fake.url}/compatible/v1`, apiKey: 'fake-garbage' })).checks[1].text, /format this connection type does not read\. Check that the base URL points at an OpenAI-compatible API/);
  assert.deepEqual(lines(await check({ type: 'compatible', model: 'x', baseUrl: 'http://127.0.0.1:9/v1' })), ['fail: Could not reach 127.0.0.1:9.']);
  assert.deepEqual(lines(await check({ type: 'huggingface', model: 'openai/gpt-oss-120b', apiKey: 'fake-redirect' })), [`fail: ${host} answered with a redirect, which is refused so a key is never forwarded.`]);
  assert.deepEqual(lines(await check({ type: 'gemini', model: 'gemini-3-pro' })), ['fail: There is no key to test with. Give one, or set GEMINI_API_KEY on the server.']);
  // A form that could not be saved is the test's answer, not a failed request.
  assert.deepEqual(lines(await check({ type: 'openai', model: '', apiKey: 'fake-key' })), ['fail: Enter the model ID from your provider.']);
  assert.deepEqual(lines(await check({ type: 'compatible', model: 'm', baseUrl: 'http://10.1.1.1/v1' })), ['fail: Use an HTTPS API base URL, or HTTP for a localhost model server.']);
});

test('a provider that does not answer in time fails the test, and a caller that hangs up cancels the call', async t => {
  const { check, fake, base, headers } = await setup(t, { slowMs: 5000 });
  const before = TEST_TIMEOUT_SECONDS.api; TEST_TIMEOUT_SECONDS.api = 1; t.after(() => { TEST_TIMEOUT_SECONDS.api = before; });
  const slow = await check({ type: 'openai', model: 'gpt-5.6', apiKey: 'fake-slow' });
  assert.deepEqual(slow.checks.map(c => c.text), [`No answer from ${new URL(fake.url).host} within 1 seconds. The provider may be busy, or something between here and it is holding the connection.`]);

  TEST_TIMEOUT_SECONDS.api = 30;
  const leaving = new AbortController();
  const pending = fetch(base + '/api/providers/test', { method: 'POST', headers, body: JSON.stringify({ type: 'openai', model: 'gpt-5.6', apiKey: 'fake-slow' }), signal: leaving.signal }).catch(() => null);
  for (let i = 0; i < 100 && fake.requests.filter(r => r.method === 'POST').length < 2; i++) await new Promise(r => setTimeout(r, 20));
  leaving.abort(); await pending;
  const call = fake.requests.filter(r => r.method === 'POST').at(-1);
  for (let i = 0; i < 100 && !call.hungUp; i++) await new Promise(r => setTimeout(r, 20));
  assert.equal(call.hungUp, true, 'closing the dialog stops the provider call instead of leaving it to run for 30 seconds');
});

test('the test uses the key the form would save, sends a saved key only where it was saved for, and saves nothing', async t => {
  const { check, save, fake, directory, post, base } = await setup(t);
  const last = () => fake.requests.filter(r => r.method === 'POST').at(-1);
  assert.equal((await fetch(base + '/api/providers/test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 403, 'needs the page token like any change');

  const saved = (await save({ type: 'openai', name: 'Sol', model: 'gpt-5.6-sol', apiKey: 'fake-saved' })).body;
  const before = await readFile(join(directory, 'providers.json'), 'utf8');
  const withSaved = await check({ type: 'openai', model: 'gpt-6-astra', connectionId: saved.id });
  assert.equal(withSaved.ok, true); assert.equal(withSaved.keySource, 'saved'); assert.equal(last().key, 'fake-saved'); assert.equal(withSaved.checks[1].text, 'The saved key was accepted');
  assert.equal((await check({ type: 'openai', model: 'gpt-6-astra', connectionId: saved.id, apiKey: 'fake-typed' })).keySource, 'typed'); assert.equal(last().key, 'fake-typed');
  // "Remove saved key" ticked: the test is of the form without it.
  assert.match((await check({ type: 'openai', model: 'gpt-6-astra', connectionId: saved.id, clearKey: true })).checks[0].text, /no key to test with/);
  // The type changed in the form: the saved key stays with its own provider.
  assert.match((await check({ type: 'grok', model: 'grok-5', connectionId: saved.id })).checks[0].text, /no key to test with/);
  assert.equal(await readFile(join(directory, 'providers.json'), 'utf8'), before, 'testing changes nothing on disk, not even the model');
  assert.ok(!before.includes('fake-typed'));

  const local = (await save({ type: 'compatible', name: 'Local', model: 'llama3.3', baseUrl: `${fake.url}/compatible/v1`, apiKey: 'fake-local' })).body;
  await check({ type: 'compatible', model: 'llama3.3', baseUrl: `${fake.url}/compatible/v1`, connectionId: local.id }); assert.equal(last().key, 'fake-local');
  const moved = await check({ type: 'compatible', model: 'llama3.3', baseUrl: `http://localhost:${new URL(fake.url).port}/compatible/v1`, connectionId: local.id });
  assert.equal(moved.keySource, 'none'); assert.equal(last().key, null, 'a saved key is never sent to an address it was not saved for');
  assert.match((await post('/api/providers/test', { type: 'openai', model: 'x', connectionId: 'missing' })).body.error, /Connection not found/);

  setEnv(t, 'XAI_API_KEY', 'fake-env');
  const env = await check({ type: 'grok', model: 'grok-5' });
  assert.equal(env.ok, true); assert.equal(env.keySource, 'environment'); assert.equal(last().key, 'fake-env');
  assert.equal(env.checks[1].text, 'The server’s XAI_API_KEY was accepted');
});

// Stand-ins for the CLIs, so the test runs the real launcher: fixed arguments, prompt on stdin, output parsed as a meeting would.
async function fakeCli(t, scripts) {
  const bin = await mkdtemp(join(tmpdir(), 'overrule-fake-cli-'));
  for (const [name, body] of Object.entries(scripts)) { await writeFile(join(bin, name), `#!/bin/sh\n${body}\n`); await chmod(join(bin, name), 0o755); }
  setEnv(t, 'PATH', `${bin}:${process.env.PATH}`);
  t.after(() => rm(bin, { recursive: true, force: true }));
  return bin;
}

test('a CLI connection is tested by running the CLI once, after its sign-in is checked', async t => {
  const bin = await fakeCli(t, {
    codex: `printf '%s\\n' "$@" > "$(dirname "$0")/codex-args"\ncat > "$(dirname "$0")/codex-stdin"\necho '{"type":"item.completed","item":{"type":"agent_message","text":"OK"}}'\necho '{"type":"turn.completed","usage":{"input_tokens":12,"output_tokens":1}}'`,
    claude: `cat > /dev/null\necho '{"is_error":true,"subtype":"error","result":"model: claude-nope is not available"}'\nexit 1`,
  });
  let probes = 0, status = signedIn;
  const { check } = await setup(t, { detect: async () => { probes++; return status; } });
  const codex = await check({ type: 'codex-cli', model: 'gpt-5.6-codex' });
  assert.equal(codex.ok, true, JSON.stringify(codex));
  assert.deepEqual(codex.checks.map(c => c.text.replace(/\d+ ms/, 'N ms')), ['codex is installed and signed in', 'gpt-5.6-codex answered in N ms: “OK”']);
  const args = (await readFile(join(bin, 'codex-args'), 'utf8')).split('\n');
  assert.equal(args[args.indexOf('--model') + 1], 'gpt-5.6-codex'); assert.equal(args[args.indexOf('--sandbox') + 1], 'read-only');
  assert.ok(args.includes('features.shell_tool=false'), 'tools are off, as for a member with no workspace');
  assert.match(await readFile(join(bin, 'codex-stdin'), 'utf8'), /Reply with the word OK/, 'the prompt goes on stdin, never in the arguments');
  assert.ok(probes >= 2, 'the sign-in is checked afresh for a test');
  assert.match((await check({ type: 'codex-cli', model: '' })).checks[1].text, /^The default model answered in/);

  const claude = await check({ type: 'claude-cli', model: 'claude-nope' });
  assert.equal(claude.ok, false);
  assert.match(claude.checks[1].text, /^claude-nope did not answer: claude exited with code 1: model: claude-nope is not available\./);

  status = { codex: { installed: true, signedIn: false }, claude: { installed: false } };
  assert.deepEqual((await check({ type: 'codex-cli', model: '' })).checks.map(c => c.text), ['codex is not signed in. Run codex login in a terminal on the server.']);
  assert.deepEqual((await check({ type: 'claude-cli', model: 'opus' })).checks.map(c => c.text), ['claude is not installed on the server, or not on its PATH.']);
});

test('provider errors carry what went wrong as fields, and a network failure names the host', async t => {
  const store = new Store(await mkdtemp(join(tmpdir(), 'overrule-tagged-')));
  t.after(() => rm(store.directory, { recursive: true, force: true }));
  const request = { system: 's', prompt: 'p', maxTokens: 10, timeoutSeconds: 5, signal: new AbortController().signal };
  const provider = { type: 'compatible', model: 'm', baseUrl: 'https://api.example/v1', secret: store.encrypt('sk-secret') };
  const failure = async fetchImpl => { try { await callProvider(provider, request, store, fetchImpl); } catch (error) { return error; } assert.fail('should fail'); };
  const http = await failure(async () => Response.json({ error: { message: 'Incorrect API key provided: sk-secret', type: 'invalid_request_error', code: 'invalid_api_key' } }, { status: 401 }));
  assert.equal(http.code, 'http'); assert.equal(http.status, 401); assert.equal(http.providerCode, 'invalid_api_key');
  assert.equal(http.message, 'Provider returned HTTP 401. Check your key and model access.', 'the message a meeting shows is unchanged');
  assert.equal((await failure(async () => Response.json([{ error: { code: 429, message: 'x', status: 'RESOURCE_EXHAUSTED' } }], { status: 429 }))).providerCode, 'RESOURCE_EXHAUSTED');
  assert.equal((await failure(async () => new Response('<html>sk-secret</html>', { status: 500 }))).providerCode, null);
  assert.equal((await failure(async () => Response.json({ error: { code: 'has spaces: sk-secret' } }, { status: 400 }))).providerCode, null, 'only a bare identifier is kept');
  const offline = await failure(async () => { throw new TypeError('fetch failed'); });
  assert.equal(offline.code, 'unreachable'); assert.equal(offline.message, 'Could not reach api.example.');
  const redirected = await failure(async () => { throw new TypeError('fetch failed', { cause: new Error('unexpected redirect') }); });
  assert.equal(redirected.code, 'redirect');
  assert.equal((await failure(async () => Response.json({ choices: [{ finish_reason: 'length', message: { content: null } }] }))).code, 'output-limit');
  assert.equal((await failure(async () => Response.json({ choices: [{ message: { content: ' ' } }] }))).code, 'no-text');

  // A directory on PATH that cannot be read makes spawn say EACCES for a command found nowhere else: that is "not installed" too.
  if (process.getuid?.() !== 0) {
    const locked = await mkdtemp(join(tmpdir(), 'overrule-locked-'));
    await mkdir(join(locked, 'inner')); await chmod(join(locked, 'inner'), 0o000);
    t.after(async () => { await chmod(join(locked, 'inner'), 0o700); await rm(locked, { recursive: true, force: true }); });
    const pathBefore = process.env.PATH; process.env.PATH = `${join(locked, 'inner')}:${pathBefore}`;
    try { await assert.rejects(runProcess('overrule-no-such-command', []), /is not installed or is not on PATH/); }
    finally { process.env.PATH = pathBefore; }
  }
});

function overrule(url, args, { env = {}, input = '' } = {}) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [CLI, ...args], { env: { ...process.env, OVERRULE_URL: url, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', d => { stdout += d; }); child.stderr.on('data', d => { stderr += d; });
    child.on('close', code => resolve({ code, stdout, stderr }));
    child.stdin.end(input);
  });
}

test('the command line tests a new or saved connection, prints the same checklist, and exits 1 when it fails', async t => {
  const { base, save, fake, directory } = await setup(t);
  const host = new URL(fake.url).host;
  const fresh = await overrule(base, ['connections', 'test', '--type', 'openai', '--model', 'gpt-5.6-sol', '--key-stdin'], { input: 'fake-key' });
  assert.equal(fresh.code, 0, fresh.stderr);
  assert.match(fresh.stderr, /Testing OpenAI API, gpt-5\.6-sol: one short message, billed by the provider as a few tokens\./);
  assert.match(fresh.stdout, new RegExp(`^ {2}✓ Reached ${host}\\n {2}✓ The key given was accepted\\n {2}✓ gpt-5\\.6-sol answered in \\d+ ms: “OK”\\nThe connection works\\.\\n$`));

  await save({ type: 'anthropic', name: 'Fable', model: 'claude-fable-5-1', apiKey: 'fake-key' });
  const before = await readFile(join(directory, 'providers.json'), 'utf8');
  assert.equal((await overrule(base, ['connections', 'test', 'fable'])).code, 0);
  const trial = await overrule(base, ['connections', 'test', 'Fable', '--model', 'claude-fable-9']);
  assert.equal(trial.code, 1);
  assert.match(trial.stderr, /Testing "Fable" \(Anthropic API, claude-fable-9\)/);
  assert.match(trial.stdout, /✓ The saved key was accepted\n {2}✗ .* does not know the model claude-fable-9 \(HTTP 404, not_found_error\)\. Pick one from the list\.\nThe connection did not work\.\n$/);
  assert.equal(await readFile(join(directory, 'providers.json'), 'utf8'), before, 'trying a model does not edit the connection');

  const json = await overrule(base, ['connections', 'test', '--type', 'compatible', '--base-url', `${fake.url}/compatible/v1`, '--model', 'llama3.3', '--json']);
  assert.equal(json.code, 0); assert.equal(JSON.parse(json.stdout).ok, true);
  assert.match((await overrule(base, ['connections', 'test', '--preset', 'ollama', '--base-url', `${fake.url}/compatible/v1`, '--model', 'llama3.3'])).stderr, /one short message\.\n/, 'a local server is not said to bill');
  assert.match((await overrule(base, ['connections', 'test'])).stderr, /needs --type or a connection name/);
  assert.match((await overrule(base, ['connections', 'test', 'Nobody'])).stderr, /No connection named "Nobody"/);
  const noKey = await overrule(base, ['connections', 'test', '--type', 'grok', '--model', 'grok-5']);
  assert.equal(noKey.code, 1); assert.match(noKey.stdout, /✗ There is no key to test with/);
});
