import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
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

test('the agent instructions and prompts only use commands and options the tool has', async () => {
  const usage = (await run(process.execPath, [CLI, '--help'])).stdout;
  // Only the agent-facing files: the README describes other tools' flags as well.
  const docs = await Promise.all(['AGENTS.md', 'docs/agent-prompt.md'].map(name => readFile(join(dirname(fileURLToPath(import.meta.url)), '..', name), 'utf8')));
  const text = docs.join('\n');
  const commands = [...text.matchAll(/overrule(?:\.mjs)? ([a-z-]+)/g)].map(m => m[1]).filter(name => !['playbooks'].includes(name));
  for (const command of new Set(commands)) assert.match(usage, new RegExp(`overrule ${command}\\b`), `documented command "${command}" is not in the usage`);
  const flags = [...text.matchAll(/--[a-z][a-z-]+/g)].map(m => m[0]);
  for (const flag of new Set(flags)) assert.ok(usage.includes(flag), `documented option "${flag}" is not in the usage`);
  // The exit statuses the instructions promise are the ones the tool actually uses.
  for (const line of ['0 approved', '2 objections remain', '3 checks failed', '4 verification incomplete']) assert.ok(usage.includes(line), line);
  const agents = docs[0];
  assert.match(agents, /Never pass `--level workspace-write`|Never pass `--acknowledge`/);
  assert.match(docs[1], /```\n[\s\S]*overrule/, 'the prompt file has no copy-paste block');
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

test('a meeting that runs out of turns is unsettled, not dissent, and resume finishes it', async t => {
  // One cycle, an objection raised on the floor that nobody answers, and every ballot approving: the budget bound it, nobody dissented.
  let objected = false;
  const { url } = await serve(t, { providerCall: async (provider, request) => {
    if (/Write your OPENING POSITION/.test(request.prompt)) return { text: 'Opening.' + block({ assumptions: [], risk: 'r', criteria: ['c'] }) };
    if (/RATIFICATION BALLOT/.test(request.prompt)) return { text: 'Fine.' + block({ vote: 'approve', objections: [], reason: 'ok' }) };
    if (/You are the drafter|IMPLEMENTER/.test(request.prompt)) return { text: 'The sentence stands.' + block({ version: 1, unresolved: [] }) };
    if (!objected) { objected = true; return { text: 'One worry.' + block({ stance: 'agree', concedes: [], objections: [{ against: null, claim: 'the wording is ambiguous', condition: 'name the enforcing check' }], resolves: [], nominates: null }) }; }
    return { text: 'Agreed.' + block({ stance: 'agree', concedes: [], objections: [], resolves: [], nominates: null }) };
  } });
  const first = await overrule(url, ['ask', 'Which wording?', '--cycles', '1', '--json']);
  assert.equal(first.code, 5, `expected the unsettled exit status, got ${first.code}: ${first.stderr}`);
  assert.ok(first.stdout.trim(), `stdout was empty; stderr: ${first.stderr}`);
  const report = JSON.parse(first.stdout);
  assert.equal(report.verdict.code, 'unsettled'); assert.match(report.verdict.label, /ran out of turns/);
  assert.equal(report.verdict.dissent, false); assert.equal(report.stopReason, 'budget');
  assert.equal(report.verdict.votes.object, 0); assert.equal(report.openObjections, 1);
  // The record a caller would otherwise have to scrape out of the prose.
  assert.equal(report.objections[0].claim, 'the wording is ambiguous');
  assert.equal(report.objections[0].resolvingCondition, 'name the enforcing check');
  assert.ok(report.objections[0].raisedBy && report.objections[0].status === 'open');
  assert.ok(report.ballots.length >= 1 && report.ballots.every(b => b.member && b.vote));
  assert.match(report.candidate, /The sentence stands/); assert.ok(report.members.length >= 2 && report.drafter);
  assert.equal(report.research, false); assert.ok(report.metrics && Number.isInteger(report.metrics.floorTurns));
  // Resume with more turns instead of paying for the openings again.
  const refused = await overrule(url, ['resume', report.id.slice(0, 8), '--json']);
  assert.equal(refused.code, 1); assert.match(refused.stderr, /Give it more cycles than the 1 it had|reconvene it with a new instruction/);
  const again = await overrule(url, ['resume', report.id.slice(0, 8), '--cycles', '2', '--note', 'Settle the open objection.', '--json']);
  assert.ok(again.stdout.trim(), `resume printed nothing; stderr: ${again.stderr}`);
  const second = JSON.parse(again.stdout);
  assert.equal(second.id, report.id); assert.equal(second.cycles, 2);
  assert.equal(second.metrics.floorTurns > report.metrics.floorTurns, true, 'resume did not buy more turns');
  assert.equal((await overrule(url, ['resume', 'nope-nope'])).code, 1);
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
  const result = await overrule(url, ['review', root, '--playbook', 'changes', '--cycles', '1', '--revisions', '0', '--exclude', '_authoring/', '--json']);
  assert.equal(result.code, 2, `expected the objections exit status, got ${result.code}: ${result.stderr}`);
  const report = JSON.parse(result.stdout);
  assert.equal(report.verdict.code, 'objections');
  assert.ok(calls.every(call => call.cwd === root), 'members did not run in the workspace');
  assert.match(calls[0].prompt, /Review the change in progress/);
  assert.match(calls[0].prompt, /read-only/);
  assert.match(calls[0].prompt, /out of scope: _authoring\/\. Do not read or cite them/);
  assert.match(calls[0].prompt, /not a boundary the machine enforces/);
  // The council and what it bills is said out loud before the first call.
  assert.match(result.stderr, /Seating .*Codex/);
  // An unknown template and an unreachable server fail with advice rather than a stack trace.
  assert.match((await overrule(url, ['review', root, '--playbook', 'nope'])).stderr, /No report template called "nope"/);
  const down = await overrule('http://127.0.0.1:9', ['ask', 'hello']);
  assert.equal(down.code, 1); assert.match(down.stderr, /No Overrule server at http:\/\/127\.0\.0\.1:9/);
});
