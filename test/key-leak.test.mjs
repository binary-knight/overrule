// Keys never leak. The real server runs as its own process, the way npm start runs it, with its output captured as the log. Every
// key used carries one random canary tag: typed into the form, saved, in the server's environment, pasted with stray whitespace,
// rejected (the fake provider echoes a rejected key in its error body, as real providers do), and used while the provider fails
// in every way the fake can fail. Then the tag is searched for everywhere a key could end up: the server log, every file in the
// data directory, every HTTP response, every command-line output, the fake provider's own log, and every URL the provider saw.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, readFile, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { startFakeProvider } from '../scripts/fake-provider.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(ROOT, 'bin', 'overrule.mjs');
const freePort = () => new Promise(resolve => { const s = createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

async function filesUnder(directory) {
  const out = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) out.push(...await filesUnder(path)); else if ((await stat(path)).isFile()) out.push(path);
  }
  return out;
}

test('no key reaches the server log, the data directory, an HTTP response, the command line, or a provider URL', { timeout: 120_000 }, async t => {
  const tag = `canary${randomBytes(6).toString('hex')}`;
  const key = name => `fake-key-${tag}-${name}`;
  const mode = (name, suffix = name) => `fake-${name}-${tag}-${suffix}`;
  const rejected = `sk-${tag}-rejected`;

  const fakeLog = [];
  const fake = await startFakeProvider({ slowMs: 30_000, log: line => fakeLog.push(line) });
  const directory = await mkdtemp(join(tmpdir(), 'overrule-leak-'));
  const port = await freePort();
  const env = {
    ...process.env, PORT: String(port), OVERRULE_HOST: '127.0.0.1', OVERRULE_DATA_DIR: directory, OVERRULE_PROVIDER_OVERRIDE_URL: fake.url,
    // Environment keys, one with the trailing newline a careless export leaves.
    OPENAI_API_KEY: `${key('env-openai')}\n`, ANTHROPIC_API_KEY: key('env-anthropic'), GEMINI_API_KEY: key('env-gemini'), HF_TOKEN: key('env-hf'),
  };
  delete env.XAI_API_KEY;
  let log = '';
  const server = spawn(process.execPath, [join(ROOT, 'server.mjs')], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout.on('data', d => { log += d; }); server.stderr.on('data', d => { log += d; });
  t.after(async () => { server.kill('SIGKILL'); await fake.close(); await rm(directory, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100 && !/is running/.test(log); i++) await wait(50);
  assert.match(log, /Overrule is running/);

  const responses = [];
  let token = '';
  const call = async (path, method = 'GET', body) => {
    const response = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', 'X-Mesh-Token': token }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await response.text();
    responses.push({ path, method, status: response.status, text });
    try { return JSON.parse(text); } catch { return text; }
  };
  token = (await call('/api/bootstrap')).token;
  const models = body => call('/api/models', 'POST', body);
  const check = body => call('/api/providers/test', 'POST', body);
  const save = body => call('/api/providers', 'POST', body);

  // A list against a provider that never answers runs to the real ten-second deadline; it runs alongside everything else.
  const hanging = Promise.all([models({ type: 'grok', apiKey: mode('hang') }), models({ type: 'huggingface', apiKey: mode('stall') })]);

  // ---- model lists: every type, every key source, every failure the fake can produce ----
  for (const type of ['openai', 'anthropic', 'gemini', 'grok', 'huggingface']) {
    await models({ type, apiKey: key(`typed-${type}`) });
    await models({ type, apiKey: rejected });
    for (const failure of ['429', '500', 'garbage', 'redirect', 'huge', 'nulls', 'shape']) await models({ type, apiKey: mode(failure, type) });
  }
  await models({ type: 'openai' }); // the environment key, with its trailing newline trimmed
  await models({ type: 'claude-cli' }); // Claude Code's list uses ANTHROPIC_API_KEY
  await models({ type: 'compatible', baseUrl: `${fake.url}/compatible/v1`, apiKey: key('typed-local') });
  await models({ type: 'compatible', baseUrl: 'http://127.0.0.1:9/v1', apiKey: key('unreachable') });
  await models({ type: 'openai', apiKey: `  ${key('padded')} \n` });
  await models({ type: 'openai', apiKey: `${key('bad')}\u0001tail` });
  await models({ type: 'openai', apiKey: `${key('spaced')} more` });

  // ---- saved connections, edited, and listed with their saved keys ----
  const sol = await save({ type: 'openai', name: 'Sol', model: 'gpt-5.6-sol', apiKey: key('saved-openai') });
  const fable = await save({ type: 'anthropic', name: 'Fable', model: 'claude-fable-5-1', apiKey: `\t${key('saved-anthropic')}\n` });
  const local = await save({ type: 'compatible', name: 'Local', model: 'llama3.3', baseUrl: `${fake.url}/compatible/v1`, apiKey: key('saved-local') });
  const refused = await save({ type: 'grok', name: 'Refused', model: 'grok-5', apiKey: rejected });
  const hangs = await save({ type: 'gemini', name: 'Hangs', model: 'gemini-3-pro', apiKey: mode('hang', 'member') });
  await save({ type: 'openai', name: 'Unsendable', model: 'gpt-5.6', apiKey: `${key('unsendable')}\u0001x` });
  await call(`/api/providers/${sol.id}`, 'PUT', { type: 'openai', name: 'Sol', model: 'gpt-6-astra', apiKey: key('edited-openai') });
  await models({ type: 'openai', connectionId: sol.id, refresh: true });
  // A council over saved connections: its file and its answers are searched like everything else.
  await call('/api/councils', 'POST', { name: 'Leak check', seats: [sol.id, fable.id, local.id], settings: { drafter: { drafterId: sol.id, neutralDrafter: false }, cycles: 1 } });
  await models({ type: 'compatible', connectionId: local.id, baseUrl: `http://localhost:${new URL(fake.url).port}/compatible/v1` });

  // ---- connection tests: passing, each kind of failure, typed, saved, and environment keys ----
  await check({ type: 'openai', model: 'gpt-5.6-sol', apiKey: key('test-typed') });
  await check({ type: 'openai', model: 'gpt-5.6-sol', apiKey: rejected });
  await check({ type: 'anthropic', model: 'claude-opus-9', apiKey: key('test-unknown-model') });
  for (const failure of ['429', '500', '403', 'quota', 'limit', 'garbage', 'redirect']) await check({ type: 'openai', model: 'gpt-5.6', apiKey: mode(failure, 'test') });
  await check({ type: 'gemini', model: 'gemini-3-pro' });
  await check({ type: 'anthropic', model: 'claude-fable-5-1', connectionId: fable.id });
  await check({ type: 'grok', model: 'grok-5', connectionId: refused.id });
  await check({ type: 'openai', model: 'gpt-5.6', apiKey: `${key('test-bad')}\u0001x` });

  // ---- a meeting: two working members, one whose key is refused, one that never answers within its turn limit ----
  const councilId = (await call('/api/councils')).find(c => c.name === 'Leak check').id;
  const run = await call('/api/runs', 'POST', { council: { id: councilId, changed: ['seats'] }, prompt: `Leak check ${tag.slice(0, 4)}`, participantIds: [sol.id, fable.id, local.id, refused.id, hangs.id], drafterId: sol.id, cycles: 1, timeoutSeconds: 10 });
  assert.ok(run.id, JSON.stringify(run));
  let finished;
  for (let i = 0; i < 600; i++) { finished = await call(`/api/runs/${run.id}`); if (finished.status !== 'running') break; await wait(100); }
  assert.notEqual(finished.status, 'running', 'the meeting finished despite a member that never answers');
  const failures = finished.entries.filter(e => e.status === 'failed').map(e => `${e.name}: ${e.error}`);
  assert.ok(failures.some(f => /^Refused: Provider returned HTTP 401/.test(f)), failures.join('\n'));
  assert.ok(failures.some(f => /^Hangs: Timed out after 10 seconds\./.test(f)), failures.join('\n'));
  await call(`/api/runs/${run.id}/export`);
  await call('/api/runs'); await call('/api/bootstrap'); await call('/api/security'); await call('/api/settings');
  assert.deepEqual((await hanging).map(r => r.errorKind), ['timeout', 'timeout']);

  // ---- the command line, with keys from the environment and standard input ----
  const cliRuns = [];
  const overrule = (args, { input = '', extra = {} } = {}) => new Promise(resolve => {
    const child = spawn(process.execPath, [CLI, ...args], { env: { ...process.env, OVERRULE_URL: base, ...extra }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', d => { stdout += d; }); child.stderr.on('data', d => { stderr += d; });
    child.on('close', code => { cliRuns.push({ args, code, stdout, stderr }); resolve({ code, stdout, stderr }); });
    child.stdin.end(input);
  });
  await overrule(['models', 'openai', '--key-env', 'LEAK_KEY', '--all', '--refresh'], { extra: { LEAK_KEY: key('cli-env') } });
  await overrule(['models', 'anthropic', '--key-stdin'], { input: rejected });
  await overrule(['models', 'sol', '--json']);
  await overrule(['connections', 'add', '--type', 'grok', '--name', 'CLI', '--model', 'grok-5', '--key-stdin'], { input: `${key('cli-stdin')}\n` });
  await overrule(['connections', 'test', 'CLI']);
  await overrule(['connections', 'test', '--type', 'openai', '--model', 'gpt-5.6', '--key-env', 'LEAK_KEY'], { extra: { LEAK_KEY: rejected } });
  await overrule(['connections', 'edit', 'CLI', '--model', 'grok-4', '--key-env', 'LEAK_KEY'], { extra: { LEAK_KEY: mode('500', 'cli') } });
  await overrule(['connections', '--json']);
  await overrule(['show', run.id, '--json']);
  await overrule(['councils', 'save', 'From leak meeting', '--from', run.id]);
  await overrule(['councils', '--json']);

  // Stop the server the way restart.sh does, so everything it would write is written.
  server.kill('SIGTERM');
  await new Promise(resolve => { if (server.exitCode !== null) resolve(); else server.once('exit', resolve); });

  // The canary keys really were used: each reached the provider, so their absence below means something.
  const sent = fake.requests.filter(r => r.key?.includes(tag));
  for (const name of ['typed-openai', 'env-openai', 'env-anthropic', 'env-gemini', 'saved-openai', 'saved-anthropic', 'edited-openai', 'saved-local', 'padded', 'test-typed', 'cli-env', 'cli-stdin']) {
    assert.ok(sent.some(r => r.key === key(name)), `${name} was never sent, so the check below would prove nothing`);
  }
  assert.ok(fake.requests.some(r => r.key === '[not a fake key]'), 'rejected keys were sent and echoed by the provider');
  assert.ok(fake.requests.some(r => r.key === mode('hang', 'member')), 'the hanging member was asked');

  // Now look for the tag everywhere the server, the command line, or the fake could have put a key.
  const places = [
    ['server log', log],
    ...(await Promise.all((await filesUnder(directory)).map(async path => [`data file ${path.slice(directory.length + 1)}`, (await readFile(path)).toString('latin1')]))),
    ...responses.map(r => [`HTTP ${r.method} ${r.path} (${r.status})`, r.text]),
    ...cliRuns.map(r => [`overrule ${r.args.join(' ')}`, r.stdout + r.stderr]),
    ['fake provider log', fakeLog.join('\n')],
    ['URLs the provider received', fake.requests.map(r => r.path).join('\n')],
  ];
  assert.ok(places.length > 80, `searched ${places.length} places`);
  const leaks = places.filter(([, text]) => text.includes(tag) || text.includes(Buffer.from(tag).toString('base64').slice(0, 12)));
  assert.deepEqual(leaks.map(([where, text]) => `${where}: …${text.slice(Math.max(0, text.indexOf(tag) - 60), text.indexOf(tag) + 60)}…`), [], 'a key leaked');

  // The saved keys are encrypted in providers.json, and even the encrypted form never leaves the server.
  const saved = JSON.parse(await readFile(join(directory, 'providers.json'), 'utf8')).filter(p => p.secret);
  assert.ok(saved.length >= 5);
  for (const { secret } of saved) assert.deepEqual(places.filter(([where, text]) => !where.startsWith('data file providers.json') && text.includes(secret)).map(([where]) => where), []);
  // And the log says only what it should: that the server started and where API calls go, with no errors or stack traces.
  assert.deepEqual(log.split('\n').filter(Boolean).filter(line => !/^(Overrule is running|LAN: |OVERRULE_PROVIDER_OVERRIDE_URL is set)/.test(line)), []);
});
