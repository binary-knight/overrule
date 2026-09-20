import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../server.mjs';
import { git } from '../lib/workspace.mjs';
import { parseArgs } from '../bin/overrule.mjs';

const run = promisify(execFile);
const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'overrule.mjs');
const block = fields => '\n```json\n' + JSON.stringify(fields) + '\n```';

// A server with scripted members, so the command line is exercised end to end without spending anything.
async function serve(t, { providerCall, ...options } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'overrule-cli-'));
  const seen = [];
  const { server } = createApp({
    directory, addresses: [], canary: async level => ({ level, ok: true, available: true, detail: 'stub holds' }),
    measure: async () => ({ available: false, detail: 'stub' }), checkRunner: async commands => commands.map(command => ({ command, code: 0, output: 'ok', seconds: 0 })),
    detect: async () => ({ codex: { installed: true, signedIn: true, detail: 'Signed in.', models: [] }, claude: { installed: true, signedIn: true, detail: 'Signed in.', models: [] } }),
    providerCall: providerCall || (async (provider, request) => {
      seen.push({ name: provider.name, prompt: request.prompt, cwd: request.cwd, research: request.research });
      if (/Write your OPENING POSITION/.test(request.prompt)) return { text: 'Opening.' + block({ assumptions: [], risk: 'r', criteria: ['c'] }) };
      if (/RATIFICATION BALLOT/.test(request.prompt)) return { text: 'Fine.' + block({ vote: 'approve', objections: [], reason: 'ok' }) };
      if (/You are the drafter|IMPLEMENTER/.test(request.prompt)) return { text: 'The change is sound.' + block({ version: 1, unresolved: [] }) };
      return { text: 'Agreed.' + block({ stance: 'agree', concedes: [], objections: [], resolves: [], nominates: null }) };
    }),
    ...options,
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(directory, { recursive: true, force: true }); });
  return { url: `http://127.0.0.1:${server.address().port}`, seen, directory };
}
const overrule = (url, args) => run(process.execPath, [CLI, ...args], { env: { ...process.env, OVERRULE_URL: url }, maxBuffer: 8e6 })
  .then(result => ({ code: 0, ...result }))
  .catch(error => ({ code: error.code, stdout: error.stdout || '', stderr: error.stderr || String(error) }));

test('the command line parses its arguments, including repeats, equals form, and flags', () => {
  const options = parseArgs(['review', '/srv/app', '--playbook=security', '--attach', 'a.md', '--attach', 'b.md', '--check', 'npm test', '--deep-research', '--cycles', '3', '--json']);
  assert.deepEqual(options._, ['review', '/srv/app']);
  assert.equal(options.playbook, 'security'); assert.deepEqual(options.attach, ['a.md', 'b.md']); assert.deepEqual(options.check, ['npm test']);
  assert.equal(options['deep-research'], true); assert.equal(options.cycles, '3'); assert.equal(options.json, true);
  assert.equal(parseArgs(['ask', 'x', '--quiet=false']).quiet, false);
  assert.throws(() => parseArgs(['ask', '--playbook']), /--playbook needs a value/);
});

test('overrule ask holds a meeting and reports its verdict, and --json is machine readable', async t => {
  const { url, seen } = await serve(t);
  const help = await overrule(url, ['--help']);
  assert.equal(help.code, 0); assert.match(help.stdout, /overrule ask/); assert.match(help.stdout, /Exit status: 0 approved/);
  const templates = await overrule(url, ['playbooks']);
  assert.match(templates.stdout, /^security\s/m); assert.match(templates.stdout, /^changes\s/m);
  const result = await overrule(url, ['ask', 'Should we ship on Friday?', '--cycles', '1', '--json']);
  assert.equal(result.code, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.verdict.code, 'approved'); assert.match(report.final, /The change is sound/);
  assert.match(report.url, /#/); assert.ok(report.id);
  assert.ok(seen.every(call => /Should we ship on Friday\?/.test(call.prompt)), 'the brief did not reach the members');
  // The meeting is an ordinary one: it is in the history and can be printed again by id.
  const listed = await overrule(url, ['list']);
  assert.match(listed.stdout, new RegExp(report.id.slice(0, 8)));
  const shown = await overrule(url, ['show', report.id.slice(0, 8)]);
  assert.equal(shown.code, 0); assert.match(shown.stdout, /^# Approved/);
});

test('overrule review attaches a workspace, uses a report template, and answers with an exit status', async t => {
  const root = await mkdtemp(join(tmpdir(), 'overrule-cli-repo-')); t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(root, { recursive: true });
  await git(root, ['init', '-q', '-b', 'main']); await writeFile(join(root, 'index.js'), 'console.log(1)\n');
  await git(root, ['add', '-A']); await git(root, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init']);
  const objecting = async (provider, request) => {
    if (/Write your OPENING POSITION/.test(request.prompt)) return { text: 'Opening.' + block({ assumptions: [], risk: 'r', criteria: ['c'] }) };
    if (/RATIFICATION BALLOT/.test(request.prompt)) return { text: 'No.' + block({ vote: 'object', objections: [{ claim: 'untested', condition: 'add a test' }], reason: 'untested' }) };
    if (/You are the drafter|IMPLEMENTER/.test(request.prompt)) return { text: 'Findings.' + block({ version: 1, unresolved: [] }) };
    return { text: 'Agreed.' + block({ stance: 'agree', concedes: [], objections: [], resolves: [], nominates: null }) };
  };
  const calls = [];
  const { url } = await serve(t, { providerCall: async (p, r) => { calls.push({ cwd: r.cwd, prompt: r.prompt }); return objecting(p, r); } });
  const result = await overrule(url, ['review', root, '--playbook', 'changes', '--cycles', '1', '--revisions', '0', '--json']);
  assert.equal(result.code, 2, `expected the objections exit status, got ${result.code}: ${result.stderr}`);
  const report = JSON.parse(result.stdout);
  assert.equal(report.verdict.code, 'objections');
  assert.ok(calls.every(call => call.cwd === root), 'members did not run in the workspace');
  assert.match(calls[0].prompt, /Review the change in progress/);
  assert.match(calls[0].prompt, /read-only/);
  // An unknown template and an unreachable server fail with advice rather than a stack trace.
  assert.match((await overrule(url, ['review', root, '--playbook', 'nope'])).stderr, /No report template called "nope"/);
  const down = await overrule('http://127.0.0.1:9', ['ask', 'hello']);
  assert.equal(down.code, 1); assert.match(down.stderr, /No Overrule server at http:\/\/127\.0\.0\.1:9/);
});
