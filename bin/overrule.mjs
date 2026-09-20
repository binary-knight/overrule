#!/usr/bin/env node
// A command line into a running Overrule server, so another agent can convene the council and read its verdict.
// Every meeting started this way is an ordinary meeting: same members, same limits, same history, visible in the browser.
import { readFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { buildPlaybook, PLAYBOOKS } from '../public/playbooks.js';

const DEFAULT_URL = process.env.OVERRULE_URL || 'http://127.0.0.1:4310';
const USAGE = `overrule — convene a council of models from the command line.

  overrule ask "<brief>" [options]        Hold a meeting about a question.
  overrule review [path] [options]        Review a workspace, usually with a report template.
  overrule resume <id> [options]          Pick a stopped meeting up, optionally with more turns.
  overrule reconvene <id> "<what next>"   Reopen a closed meeting with a new instruction.
  overrule watch <id>                     Follow a meeting that is already running.
  overrule show <id> [--json]             Print a finished meeting's report.
  overrule list [--json]                  List recent meetings.
  overrule playbooks                      List the report templates.

Options
  --playbook <id>        Start from a report template (see: overrule playbooks).
  --path <dir>           Workspace to attach. "review" takes it as its first argument.
  --level <name>         talk, read-only (default with a workspace), workspace-write, full-access.
  --members <names>      Comma-separated connection names. Default: every ready connection, up to eight.
  --drafter <name>       Which member writes the candidate. Default: the first member.
  --cycles <n>           Turns per member, 1 to 8. Default 2.
  --revisions <n>        Revisions allowed after objections, 0 to 5. Default 1.
  --research             Members that can browse may search the web.
  --deep-research        They research the subject before taking a position. Implies --research.
  --attach <file>        Attach a document. Repeatable.
  --exclude <path>       Tell members a path is out of scope. Repeatable. An instruction to
                         the council, not a boundary the machine enforces.
  --check <command>      A command run on the candidate commit at a write level. Repeatable.
  --network              Allow the network for the implementer and the checks at a write level.
  --implement-limit <s>  Seconds the implementer may take at a write level.
  --turn-limit <s>       Seconds one member's turn may take. Default: the server's.
  --time-limit <m>       Minutes the whole session may take.
  --call-limit <n>       Model calls the whole session may make.
  --acknowledge          Accept the warnings this meeting needs (secrets in the tree, uncommitted work).
  --acknowledge-full-access   Required for --level full-access.
  --note <text>          A message to the council, delivered with resume.
  --no-wait              Print the meeting id and exit instead of waiting.
  --json                 Print one JSON object instead of a report.
  --quiet                Print the report only, with no progress.
  --url <address>        Server to use. Default ${DEFAULT_URL}.
  --code <pairing code>  Pair first; needed only when the server is not on this machine.

Exit status: 0 approved, 2 objections remain (a member voted against), 3 checks failed,
4 verification incomplete, 5 unsettled (out of turns or stalled, with nobody dissenting;
resume with more cycles), 1 error.`;

const VERDICT_EXIT = { approved: 0, objections: 2, 'checks-failed': 3, incomplete: 4, unsettled: 5 };
const FLAGS = new Set(['research', 'deep-research', 'network', 'json', 'quiet', 'no-wait', 'acknowledge', 'acknowledge-full-access', 'help', 'version']);
const MANY = new Set(['attach', 'check', 'exclude']);

export function parseArgs(argv) {
  const options = { _: [], attach: [], check: [], exclude: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) { options._.push(arg); continue; }
    const [name, inline] = arg.slice(2).split(/=(.*)/s);
    if (FLAGS.has(name)) { options[name] = inline === undefined ? true : inline !== 'false'; continue; }
    const value = inline === undefined ? argv[++i] : inline;
    if (value === undefined) throw new Error(`--${name} needs a value.`);
    if (MANY.has(name)) options[name].push(value); else options[name] = value;
  }
  return options;
}

const fail = message => { throw Object.assign(new Error(message), { expected: true }); };
const number = (value, name) => { const n = Number(value); if (!Number.isInteger(n)) fail(`--${name} takes a whole number.`); return n; };

class Client {
  constructor(url, code) { this.url = url.replace(/\/$/, ''); this.code = code; this.cookie = ''; this.token = ''; }
  async call(path, method = 'GET', body, headers = {}) {
    let response;
    const send = () => fetch(this.url + path, {
      method, redirect: 'error',
      headers: { ...(body !== undefined && !(body instanceof Uint8Array) ? { 'Content-Type': 'application/json' } : {}), ...(this.token ? { 'X-Mesh-Token': this.token } : {}), ...(this.cookie ? { Cookie: this.cookie } : {}), ...headers },
      body: body === undefined ? undefined : body instanceof Uint8Array ? body : JSON.stringify(body),
    });
    try { response = await send(); }
    catch (error) { fail(`No Overrule server at ${this.url}. Start it with "npm start" on that machine, or pass --url. (${error.message})`); }
    if (response.status === 401) fail(`${this.url} needs pairing. Pass --code with the pairing code from its LAN access dialog.`);
    const text = await response.text();
    let data; try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
    if (response.status === 403 && data.code === 'stale-token') { await this.connect(); return this.call(path, method, body, headers); }
    if (!response.ok) fail(data.error || `${method} ${path} failed with HTTP ${response.status}.`);
    return data;
  }
  async connect() {
    if (this.code) {
      const response = await fetch(this.url + '/api/unlock', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: this.code }) }).catch(error => fail(`No Overrule server at ${this.url}. (${error.message})`));
      const cookie = response.headers.get('set-cookie');
      if (!response.ok) fail('The pairing code was not accepted.');
      if (cookie) this.cookie = cookie.split(';')[0];
    }
    const bootstrap = await this.call('/api/bootstrap');
    this.token = bootstrap.token;
    return bootstrap;
  }
}

// Members: the names the owner gave their connections, or everything that is ready, which is what an agent usually wants.
function chooseMembers(bootstrap, options) {
  const ready = bootstrap.providers.filter(p => {
    const cli = bootstrap.types[p.type]?.cli;
    if (!cli) return p.hasKey || p.environmentKey || p.type === 'compatible';
    return bootstrap.clis[p.type === 'codex-cli' ? 'codex' : 'claude']?.installed !== false;
  });
  let chosen = ready;
  if (options.members) {
    const wanted = options.members.split(',').map(name => name.trim().toLowerCase()).filter(Boolean);
    chosen = wanted.map(name => {
      const found = bootstrap.providers.find(p => p.name.toLowerCase() === name || p.id === name);
      if (!found) fail(`No connection named "${name}". Available: ${bootstrap.providers.map(p => p.name).join(', ') || 'none'}.`);
      return found;
    });
  }
  if (chosen.length < 2) fail(`A meeting needs at least two members; ${chosen.length} are ready. Configure connections in the browser first.`);
  chosen = chosen.slice(0, 8);
  const drafter = options.drafter ? chosen.find(p => p.name.toLowerCase() === options.drafter.toLowerCase() || p.id === options.drafter) : chosen[0];
  if (!drafter) fail(`The drafter "${options.drafter}" is not one of the members.`);
  return { participantIds: chosen.map(p => p.id), drafterId: drafter.id, names: chosen.map(p => p.name), seats: chosen };
}

async function attachDocuments(client, files, log) {
  const ids = [];
  for (const file of files) {
    const path = resolve(file);
    const data = await readFile(path).catch(() => fail(`Cannot read ${path}.`));
    log(`Attaching ${basename(path)} (${data.length.toLocaleString()} bytes)`);
    const meta = await client.call('/api/attachments', 'POST', new Uint8Array(data), { 'Content-Type': 'application/octet-stream', 'X-File-Name': encodeURIComponent(basename(path)) });
    log(`  read ${meta.chars.toLocaleString()} characters${meta.warning ? `: ${meta.warning}` : ''}`);
    ids.push(meta.id);
  }
  return ids;
}

function workspacePayload(options) {
  const path = options.path ? resolve(options.path) : null;
  if (!path) return undefined;
  const level = options.level && options.level !== 'talk' ? options.level : options.level === 'talk' ? null : 'read-only';
  if (!level) return undefined;
  if (level === 'full-access' && !options['acknowledge-full-access']) fail('Full access needs --acknowledge-full-access: every member with tools can do anything your account can do on that machine.');
  return {
    path, level, checks: options.check, exclude: options.exclude, network: options.network === true || level === 'full-access',
    acknowledgeSecrets: Boolean(options.acknowledge), acknowledgeDirty: Boolean(options.acknowledge), acknowledgeFullAccess: Boolean(options['acknowledge-full-access']),
    ...(options['implement-limit'] ? { implementTimeout: Number(options['implement-limit']) } : {}),
  };
}

async function waitFor(client, id, log) {
  let last = '';
  for (;;) {
    const run = await client.call(`/api/runs/${id}`);
    if (run.status !== 'running') return run;
    const speaking = run.entries.filter(e => e.status === 'running').map(e => e.name).join(', ');
    const line = `${run.phase}${speaking ? `: ${speaking}` : ''} (${run.entries.filter(e => e.status === 'complete').length} contributions)`;
    if (line !== last) { log(line); last = line; }
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
}

// Everything a calling agent would otherwise have to scrape out of the Markdown: the ballots, the objections with the
// condition that resolves each one, the candidate text, and why the meeting closed.
function machineReadable(run, url) {
  const record = run.record || {};
  const draft = [...(run.entries || [])].reverse().find(e => e.phase === 'draft' && e.status === 'complete' && !e.superseded && e.candidateVersion === run.candidateVersion);
  const name = id => (run.participants || []).find(p => p.id === id)?.name || id;
  return {
    id: run.id, status: run.status, url: `${url}/#${run.id}`,
    verdict: record.verdict ? { ...record.verdict, votes: record.votes || null, voters: record.voters ?? null, missingBallots: record.missingBallots ?? null } : null,
    stopReason: run.stopReason || null, cycles: run.cycles, session: run.session || 1,
    final: run.final || '', candidate: draft?.text || '', candidateVersion: run.candidateVersion,
    ballots: (run.entries || []).filter(e => e.phase === 'ratify' && e.status === 'complete' && !e.superseded && e.candidateVersion === run.candidateVersion)
      .map(e => ({ member: e.name, vote: e.fields?.vote || 'abstain', reason: e.fields?.reason || '', objections: (e.fields?.objections || []).map(o => ({ claim: o.claim, resolvingCondition: o.condition })) })),
    objections: (run.issues || []).map(issue => ({ id: issue.id, raisedBy: name(issue.raisedBy), against: name(issue.against), claim: issue.claim, resolvingCondition: issue.condition, status: issue.status })),
    openObjections: (run.issues || []).filter(i => i.status === 'open').length,
    members: (run.participants || []).map(p => p.name), drafter: name(run.drafterId),
    workspace: run.workspace ? { path: run.workspace.path, level: run.workspace.level, origin: run.workspace.origin || null, head: run.workspace.head || null } : null,
    research: Boolean(run.research), deepResearch: Boolean(run.deepResearch),
    metrics: record.metrics || null, error: run.error || null,
  };
}

function report(run) {
  const verdict = run.record?.verdict;
  return [
    `# ${verdict?.label || run.status}${run.workspace ? ` — ${run.workspace.name}` : ''}`,
    verdict?.verification || '',
    run.workspace?.origin ? `Reviewed ${run.workspace.origin} at ${(run.workspace.head || '').slice(0, 12)}` : '',
    '', run.final || run.error || 'No answer.',
  ].filter(line => line !== '').join('\n');
}

export async function main(argv, { out = console.log, err = console.error } = {}) {
  const options = parseArgs(argv);
  if (options.help || !options._.length) { out(USAGE); return 0; }
  const command = options._[0];
  if (command === 'playbooks') { for (const entry of PLAYBOOKS) out(`${entry.id.padEnd(14)} ${entry.label}\n${''.padEnd(15)}${entry.summary}`); return 0; }

  const client = new Client(options.url || DEFAULT_URL, options.code);
  const log = options.quiet || options.json ? () => {} : message => err(message);

  if (command === 'list') {
    await client.connect();
    const runs = await client.call('/api/runs');
    if (options.json) { out(JSON.stringify(runs, null, 2)); return 0; }
    for (const run of runs.slice(0, 20)) out(`${run.id.slice(0, 8)}  ${String(run.status).padEnd(11)} ${new Date(run.createdAt).toLocaleString()}  ${(run.prompt || '').replace(/\s+/g, ' ').slice(0, 70)}`);
    return 0;
  }
  if (command === 'resume' || command === 'reconvene') {
    const id = options._[1] || fail(`overrule ${command} needs a meeting id.`);
    await client.connect();
    const found = (await client.call('/api/runs')).find(run => run.id === id || run.id.startsWith(id)) || fail(`No meeting starts with ${id}.`);
    const body = {
      ...(options.cycles ? { cycles: number(options.cycles, 'cycles') } : {}),
      ...(options.revisions === undefined ? {} : { revisions: number(options.revisions, 'revisions') }),
      ...(options['turn-limit'] ? { timeoutSeconds: number(options['turn-limit'], 'turn-limit') } : {}),
      ...(options['call-limit'] ? { maxCalls: number(options['call-limit'], 'call-limit') } : {}),
      ...(options['time-limit'] ? { maxDurationSeconds: number(options['time-limit'], 'time-limit') * 60 } : {}),
      ...(options.research || options['deep-research'] ? { research: true } : {}), ...(options['deep-research'] ? { deepResearch: true } : {}),
    };
    if (command === 'reconvene') {
      const text = options._.slice(2).join(' ').trim() || options.note || fail('Say what the council should take up next: overrule reconvene <id> "…".');
      await client.call(`/api/runs/${found.id}/reconvene`, 'POST', { text, cycles: body.cycles ?? 2, maxCalls: body.maxCalls, maxDurationSeconds: body.maxDurationSeconds });
    } else {
      await client.call(`/api/runs/${found.id}/resume`, 'POST', { ...body, note: options.note || '' });
    }
    log(`${command === 'resume' ? 'Resumed' : 'Reconvened'} ${found.id.slice(0, 8)}.`);
    if (options['no-wait']) { out(options.json ? JSON.stringify({ id: found.id, status: 'running' }, null, 2) : found.id); return 0; }
    const finished = await waitFor(client, found.id, log);
    out(options.json ? JSON.stringify(machineReadable(finished, client.url), null, 2) : report(finished));
    return VERDICT_EXIT[finished.record?.verdict?.code] ?? (finished.status === 'complete' ? 0 : 1);
  }
  if (command === 'show' || command === 'watch') {
    const id = options._[1] || fail(`overrule ${command} needs a meeting id.`);
    await client.connect();
    const found = (await client.call('/api/runs')).find(run => run.id === id || run.id.startsWith(id)) || fail(`No meeting starts with ${id}.`);
    const run = command === 'watch' ? await waitFor(client, found.id, log) : await client.call(`/api/runs/${found.id}`);
    out(options.json ? JSON.stringify(machineReadable(run, client.url), null, 2) : report(run));
    return VERDICT_EXIT[run.record?.verdict?.code] ?? (run.status === 'complete' ? 0 : 1);
  }
  if (command !== 'ask' && command !== 'review') fail(`Unknown command "${command}". Run overrule --help.`);

  if (command === 'review' && !options.path) options.path = options._[1] || '.';
  const bootstrap = await client.connect();
  const members = chooseMembers(bootstrap, options);
  const workspace = workspacePayload(options);
  let prompt = command === 'review' ? options._.slice(1).filter(arg => arg !== options.path).join(' ') : options._.slice(1).join(' ');
  if (options.playbook) {
    const info = workspace ? await client.call('/api/workspace/inspect', 'POST', { path: workspace.path }) : {};
    const built = buildPlaybook(options.playbook, { name: info.name || (workspace ? basename(workspace.path) : ''), head: info.head || '', origin: '' });
    if (!built) fail(`No report template called "${options.playbook}". Run overrule playbooks.`);
    prompt = prompt ? `${built}\n\nALSO FROM THE OWNER\n${prompt}` : built;
  }
  if (!prompt.trim()) fail(command === 'review' ? 'Give a brief, or pick one with --playbook.' : 'Give a brief: overrule ask "your question".');

  const attachmentIds = options.attach.length ? await attachDocuments(client, options.attach, log) : [];
  const billed = members.seats.filter(p => !bootstrap.types[p.type]?.cli);
  const seating = `Seating ${members.seats.map(p => `${p.name}${bootstrap.types[p.type]?.cli ? '' : ' (billed per token)'}`).join(', ')}${workspace ? ` on ${workspace.path} (${workspace.level})` : ''}`;
  if (!options.quiet) err(seating + (billed.length && !options.members ? `\n${billed.length} of these bill your API accounts per token. Pass --members to choose the council yourself.` : ''));
  const { seats, names, ...meeting } = members;
  const run = await client.call('/api/runs', 'POST', {
    prompt, ...meeting, cycles: options.cycles ? number(options.cycles, 'cycles') : 2,
    revisions: options.revisions === undefined ? 1 : number(options.revisions, 'revisions'),
    research: Boolean(options.research) || Boolean(options['deep-research']), deepResearch: Boolean(options['deep-research']),
    ...(options['turn-limit'] ? { timeoutSeconds: number(options['turn-limit'], 'turn-limit') } : {}),
    ...(options['call-limit'] ? { maxCalls: number(options['call-limit'], 'call-limit') } : {}),
    ...(options['time-limit'] ? { maxDurationSeconds: number(options['time-limit'], 'time-limit') * 60 } : {}),
    ...(attachmentIds.length ? { attachmentIds } : {}), ...(workspace ? { workspace } : {}),
  });
  log(`Meeting ${run.id.slice(0, 8)} started. Watch it at ${client.url}`);
  if (options['no-wait']) { out(options.json ? JSON.stringify({ id: run.id, status: run.status }, null, 2) : run.id); return 0; }
  const finished = await waitFor(client, run.id, log);
  out(options.json ? JSON.stringify(machineReadable(finished, client.url), null, 2) : report(finished));
  return VERDICT_EXIT[finished.record?.verdict?.code] ?? (finished.status === 'complete' ? 0 : 1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  // process.exit truncates a piped stdout: set the status and let the process end once the report has been written.
  main(process.argv.slice(2))
    .then(code => { process.exitCode = code; })
    .catch(error => { console.error(error.expected ? error.message : `overrule: ${error.stack}`); process.exitCode = 1; });
}
