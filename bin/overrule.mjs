#!/usr/bin/env node
// A command line into a running Overrule server, so another agent can convene the council and read its verdict.
// Every meeting started this way is an ordinary meeting: same members, same limits, same history, visible in the browser.
import { readFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { buildPlaybook, PLAYBOOKS } from '../public/playbooks.js';
import { assessResult, callsUsed, issueStatus, openIssuesOf } from '../public/meeting-state.js';
import { GROUP_IDS, COUNCIL_GROUPS, MAX_SEATS, describeCouncil, snapshotFromRun, keep } from '../public/councils.js';

const DEFAULT_URL = process.env.OVERRULE_URL || 'http://127.0.0.1:4310';
const USAGE = `overrule — convene a council of models from the command line.

  overrule ask "<brief>" [options]        Hold a meeting about a question.
  overrule review [path] [options]        Review a workspace, usually with a report template.
  overrule resume <id> [options]          Pick a stopped meeting up, optionally with more turns.
  overrule reconvene <id> "<what next>"   Reopen a closed meeting with a new instruction.
  overrule watch <id>                     Follow a meeting that is already running.
  overrule show <id> [--json]             Print a finished meeting's report.
  overrule list [--search <words>] [--tag <tag>]... [--project <name>] [--archived] [--json]
                                          List meetings: pinned first, then recent ones. --search matches
                                          names, briefs, tags, answers, and transcripts; --archived lists the Archive.
  overrule rename <id> "<name>"           Change how a meeting is listed; "" lists it by its brief again.
  overrule pin <id> [--project <name>] [--tag <tag>]...
                                          Pin a meeting to the top of the history so it is never pruned,
                                          or change a pinned meeting's project and tags.
  overrule unpin <id>                     Return a pinned meeting to the recent list; clears its project and tags.
  overrule archive <id>                   Move a stopped meeting to the Archive: kept in full, off the list, never pruned.
  overrule unarchive <id>                 Return an archived meeting to the list.
  overrule settings [--keep <n>|max]      Show or change how many meetings the history keeps; "max" keeps as many as
                                          the disk safely holds, which is also the most a number may be.
  overrule delete <id> [--yes]            Permanently delete a stopped meeting and everything kept for it.
  overrule playbooks                      List the report templates.
  overrule connections [--json]           List connections: each one's model and whether it is ready.
  overrule connections add --type <type> [--name <name>] [--model <id>] [--preset <id>] [--base-url <url>]
                           [--key-env <VAR> | --key-stdin] [--role <text>]
                                          Add a connection. The model is checked against the provider's own list;
                                          one it does not list is saved with a warning.
  overrule connections edit <name> [--name <new>] [--model <id>] [--base-url <url>] [--key-env <VAR> | --key-stdin]
                           [--clear-key] [--role <text>]
                                          Change a connection; what is not given stays as it is.
  overrule connections test [<name>] [--type <type>] [--model <id>] [--preset <id>] [--base-url <url>]
                           [--key-env <VAR> | --key-stdin] [--clear-key]
                                          Send one short message through the path a meeting uses and say whether the
                                          provider was reached, the key accepted, and the model answered. Takes what add
                                          takes, or a connection's name, whose saved values the options override. Nothing
                                          is saved. Exit status 0 if it works, 1 if not.
  overrule connections remove <name> [--yes]
                                          Remove a connection and its saved key.
  overrule councils [--json]              List saved councils: their seats and what else each keeps.
  overrule councils save <name> [--members <names>] [--from <meeting id>] [--drafter <name>] [--neutral-drafter]
                           [--cycles <n>] [--revisions <n>] [--research] [--deep-research] [--call-limit <n>]
                           [--time-limit <m>] [--turn-limit <s>] [--without <groups>] [--purpose <text>] [--replace]
                                          Save a council. --members sets its seats, or --from copies a finished meeting's
                                          seats and settings as it last ran. A council keeps the settings you give, or, with
                                          --from, all of them except the groups named in --without (drafter, cycles,
                                          revisions, research, limits). --replace overwrites a council of the same name.
  overrule councils rename <name> "<new name>"
  overrule councils remove <name> [--yes]
  overrule models <type|connection> [--base-url <url>] [--preset <id>] [--key-env <VAR> | --key-stdin] [--refresh] [--all]
                                          List the models a provider offers, newest first, as the browser suggests them.
                                          Types: codex, claude, openai, anthropic, gemini, grok, huggingface, compatible.
                                          A connection's name uses its saved key. Lists are cached for ten minutes;
                                          --refresh asks again, --all also shows models hidden as not for conversation.

Options
  --playbook <id>        Start from a report template (see: overrule playbooks).
  --path <dir>           Workspace to attach. "review" takes it as its first argument.
  --level <name>         talk, read-only (default with a workspace), workspace-write, full-access.
  --council <name>       Seat a saved council and apply the settings it keeps. Options given as well override it.
  --members <names>      Comma-separated connection names, 2 to 8. Default: the council's seats with --council,
                         otherwise every ready connection, up to eight.
  --drafter <name>       Which member writes the candidate. Default: the first member.
  --neutral-drafter      The drafter writes the answer but does not argue or vote. Needs three or more members.
  --cycles <n>           Turns per member, 1 to 4. Default 2, or the council's.
  --revisions <n>        Revisions allowed after objections, 0 to 5. Default 1, or the council's.
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
  --project <name>       With pin: the project to group the meeting under. --project "" removes it.
  --tag <tag>            With pin: a tag for the meeting. Repeatable; replaces the meeting's tags.
  --search <words>       With list: only meetings where every word or "quoted phrase" appears.
  --archived             With list: list archived meetings instead.
  --keep <n>|max         With settings: keep the n most recent meetings, or as many as the disk safely holds.
  --yes                  Confirm "delete", "connections remove" or "councils remove" without asking. Required when there is no terminal to ask on.
  --key-env <VAR>        With connections and models: read the API key from this environment variable of the command line.
  --key-stdin            With connections and models: read the API key from standard input. Keys are never taken as arguments,
                         which would leave them in shell history and the process list.
  --json                 Print one JSON object instead of a report.
  --quiet                Print the report only, with no progress.
  --url <address>        Server to use. Default ${DEFAULT_URL}.
  --code <pairing code>  Pair first; needed only when the server is not on this machine.

Exit status says whether the council settled the question.
  Settled:    0 approved · 2 a member voted against · 3 a check on the candidate failed
  Retryable:  5 unsettled, nobody dissented and more turns would plausibly change it
              4 verification did not finish
  Error:      1
Treat any non-zero status you do not recognise as retryable rather than as failure.`;

const VERDICT_EXIT = { approved: 0, objections: 2, 'checks-failed': 3, incomplete: 4, unsettled: 5 };
const FLAGS = new Set(['neutral-drafter', 'research', 'deep-research', 'network', 'json', 'quiet', 'no-wait', 'acknowledge', 'acknowledge-full-access', 'yes', 'archived', 'help', 'version', 'clear-key', 'key-stdin', 'refresh', 'all', 'replace']);
const MANY = new Set(['attach', 'check', 'exclude', 'tag']);

export function parseArgs(argv) {
  const options = { _: [], attach: [], check: [], exclude: [], tag: [] };
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
// A saved council by name (or id), as the browser lists them.
function findCouncil(bootstrap, name) {
  const wanted = String(name || '').trim().toLowerCase();
  return (bootstrap.councils || []).find(c => c.name.toLowerCase() === wanted || c.id === name) || null;
}
function chooseMembers(bootstrap, options, council = null) {
  const ready = bootstrap.providers.filter(p => {
    const cli = bootstrap.types[p.type]?.cli;
    if (!cli) return p.hasKey || p.environmentKey || p.type === 'compatible';
    return bootstrap.clis[p.type === 'codex-cli' ? 'codex' : 'claude']?.installed !== false;
  });
  let chosen = ready;
  if (council && !options.members) chosen = council.seats.map(id => bootstrap.providers.find(p => p.id === id)).filter(Boolean);
  if (options.members) {
    const wanted = options.members.split(',').map(name => name.trim().toLowerCase()).filter(Boolean);
    chosen = wanted.map(name => {
      const found = bootstrap.providers.find(p => p.name.toLowerCase() === name || p.id === name);
      if (!found) fail(`No connection named "${name}". Available: ${bootstrap.providers.map(p => p.name).join(', ') || 'none'}.`);
      return found;
    });
  }
  if (chosen.length < 2) fail(council && !options.members ? `The council "${council.name}" has ${chosen.length} seat${chosen.length === 1 ? '' : 's'} left; a meeting needs two. Add seats with overrule councils save "${council.name}" --members … --replace, or pass --members.` : `A meeting needs at least two members; ${chosen.length} are ready. Add connections with overrule connections add, or in the browser.`);
  if (options.members && chosen.length > MAX_SEATS) fail(`A meeting seats up to ${MAX_SEATS} members.`);
  chosen = chosen.slice(0, MAX_SEATS);
  const keptDrafter = council?.settings?.drafter?.drafterId;
  const drafter = options.drafter ? chosen.find(p => p.name.toLowerCase() === options.drafter.toLowerCase() || p.id === options.drafter) : chosen.find(p => p.id === keptDrafter) || chosen[0];
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
export function machineReadable(run, url) {
  const record = run.record || {};
  // Judge the log rather than the stored record: a meeting decided by an older version carries that version's verdict, and the
  // browser already recomputes. A caller should not see one answer here and another on screen.
  const live = run.entries?.length ? assessResult(run) : null;
  const draft = [...(run.entries || [])].reverse().find(e => e.phase === 'draft' && e.status === 'complete' && !e.superseded && e.candidateVersion === run.candidateVersion);
  const name = id => (run.participants || []).find(p => p.id === id)?.name || id;
  return {
    id: run.id, title: run.title || null, status: run.status, url: `${url}/#${run.id}`,
    verdict: live ? { code: live.code, label: live.label, verification: live.verification, dissent: live.dissent, stopReason: live.stopReason, votes: live.votes, voters: live.voters, missingBallots: live.missingBallots } : record.verdict || null,
    stopReason: run.stopReason || null, cycles: run.cycles, session: run.session || 1, pin: run.pin || null,
    final: run.final || '', candidate: draft?.text || '', candidateVersion: run.candidateVersion,
    ballots: (run.entries || []).filter(e => e.phase === 'ratify' && e.status === 'complete' && !e.superseded && e.candidateVersion === run.candidateVersion)
      .map(e => ({ member: e.name || name(e.speaker), vote: e.fields?.vote || 'abstain', choice: e.fields?.choice || '', reason: e.fields?.reason || '', objections: (e.fields?.objections || []).map(o => ({ claim: o.claim, resolvingCondition: o.condition })) })),
    objections: (run.issues || []).map(issue => ({ id: issue.id, raisedBy: name(issue.raisedBy), against: name(issue.against), claim: issue.claim, resolvingCondition: issue.condition, status: issueStatus(run, issue) })),
    openObjections: openIssuesOf(run).length,
    members: (run.participants || []).map(p => p.name), drafter: name(run.drafterId),
    workspace: run.workspace ? { path: run.workspace.path, level: run.workspace.level, origin: run.workspace.origin || null, head: run.workspace.head || null } : null,
    research: Boolean(run.research), deepResearch: Boolean(run.deepResearch), council: run.council || null,
    metrics: record.metrics || null, error: run.error || null,
    // Model calls and the tokens providers reported, across every session, counted as the interface counts them.
    calls: callsUsed(run, true),
    // Turns that failed, by whom and why: a meeting that lost a member is not the council the caller asked for.
    failedTurns: (run.entries || []).filter(e => e.status === 'failed' && e.speaker !== 'owner').map(e => ({ member: e.name || name(e.speaker), phase: e.phase, error: String(e.error || '').slice(0, 300) })),
    usage: (run.entries || []).reduce((sum, e) => ({ input: sum.input + (e.usage?.input || 0), output: sum.output + (e.usage?.output || 0) }), { input: 0, output: 0 }),
  };
}

function report(run, assessed) {
  const verdict = assessed?.verdict || run.record?.verdict;
  return [
    `# ${verdict?.label || run.status}${run.workspace ? ` — ${run.workspace.name}` : ''}`,
    verdict?.verification || '',
    run.workspace?.origin ? `Reviewed ${run.workspace.origin} at ${(run.workspace.head || '').slice(0, 12)}` : '',
    '', run.final || run.error || 'No answer.',
  ].filter(line => line !== '').join('\n');
}

// Changing a meeting by id: a prefix must name exactly one meeting, so a short id never acts on the wrong one.
async function onlyMeeting(client, id) {
  const matches = (await client.call('/api/runs')).filter(run => run.id === id || run.id.startsWith(id));
  if (!matches.length) fail(`No meeting starts with ${id}.`);
  if (matches.length > 1) fail(`${id} matches ${matches.length} meetings. Give more of the id.`);
  return matches[0];
}

// Asks on the terminal. With no terminal there is nobody to ask: null, which the caller treats as a refusal with advice.
async function askTerminal(question) {
  if (!process.stdin.isTTY || !process.stderr.isTTY) return null;
  const { createInterface } = await import('node:readline/promises');
  const prompt = createInterface({ input: process.stdin, output: process.stderr });
  try { return /^y(es)?$/i.test((await prompt.question(question)).trim()); } finally { prompt.close(); }
}

// ---- Connections and model suggestions: the same server calls the Connections page makes. ----
const TYPE_ALIASES = { codex: 'codex-cli', claude: 'claude-cli', 'claude-code': 'claude-cli', hf: 'huggingface', xai: 'grok', google: 'gemini' };
const typeOf = (bootstrap, value) => {
  const type = TYPE_ALIASES[String(value || '').toLowerCase()] || String(value || '').toLowerCase();
  return Object.hasOwn(bootstrap.types, type) ? type : null;
};
const typeNames = bootstrap => Object.keys(bootstrap.types).map(t => Object.entries(TYPE_ALIASES).find(([, v]) => v === t)?.[0] || t).join(', ');
function findConnection(bootstrap, name) {
  const wanted = String(name || '').trim().toLowerCase();
  return bootstrap.providers.find(p => p.name.toLowerCase() === wanted || p.id === name) || null;
}
function readiness(bootstrap, p) {
  if (bootstrap.types[p.type]?.cli) {
    const cli = bootstrap.clis[p.type === 'codex-cli' ? 'codex' : 'claude'] || {};
    return !cli.installed ? 'CLI not found on the server' : cli.signedIn === true ? 'signed in' : cli.signedIn === false ? 'not signed in' : 'sign-in not checked';
  }
  return p.hasKey ? 'saved API key' : p.environmentKey ? 'environment API key' : p.type === 'compatible' ? 'custom endpoint' : 'API key needed';
}
// A key comes from an environment variable or standard input, never from an argument.
async function keyFrom(options, readStdin) {
  if (options['key-env'] && options['key-stdin']) fail('Use --key-env or --key-stdin, not both.');
  if (options['key-env']) {
    const value = process.env[options['key-env']];
    if (!value) fail(`${options['key-env']} is not set in this shell.`);
    return value.trim();
  }
  if (options['key-stdin']) {
    const value = await readStdin();
    if (value === null) fail('--key-stdin reads a piped key, for example: printenv OPENAI_API_KEY | overrule … --key-stdin. Use --key-env to name a variable instead.');
    if (!value.trim()) fail('No key arrived on standard input.');
    return value.trim();
  }
  return undefined;
}
async function pipedInput() {
  if (process.stdin.isTTY) return null;
  let data = '';
  for await (const chunk of process.stdin) { data += chunk; if (data.length > 8192) fail('The key on standard input is too long.'); }
  return data;
}
const overrideNote = bootstrap => bootstrap.providerOverride ? (bootstrap.providerOverride.error ? `${bootstrap.providerOverride.error} API connections will fail until it is fixed or unset.` : `Note: ${bootstrap.providerOverride.env} is set on the server; built-in API connections go to ${bootstrap.providerOverride.url}, not to their providers.`) : '';
function ago(iso) {
  const seconds = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  return seconds < 60 ? 'just now' : seconds < 3600 ? `${Math.round(seconds / 60)} min ago` : seconds < 86400 ? `${Math.round(seconds / 3600)} h ago` : `${Math.round(seconds / 86400)} days ago`;
}
// The warning the Connections page shows after a save, in the same words.
function reportCheck(check, err) {
  if (!check) return;
  if (check.status === 'unlisted' || check.status === 'not-for-conversation') err(`Warning: ${check.detail}`);
  else if (check.status === 'unchecked') err(`Note: ${check.detail}`);
}

export async function main(argv, { out = console.log, err = console.error, confirm = askTerminal, readStdin = pipedInput } = {}) {
  const options = parseArgs(argv);
  if (options.help || !options._.length) { out(USAGE); return 0; }
  const command = options._[0];
  if (command === 'playbooks') { for (const entry of PLAYBOOKS) out(`${entry.id.padEnd(14)} ${entry.label}\n${''.padEnd(15)}${entry.summary}`); return 0; }

  const client = new Client(options.url || DEFAULT_URL, options.code);
  const log = options.quiet || options.json ? () => {} : message => err(message);

  if (command === 'models') {
    const target = options._[1] || fail(`overrule models needs a connection type or a connection's name.`);
    const bootstrap = await client.connect();
    const connection = findConnection(bootstrap, target);
    const preset = options.preset ? bootstrap.presets.find(p => p.id === options.preset) || fail(`No preset called "${options.preset}". Presets: ${bootstrap.presets.map(p => p.id).join(', ')}.`) : null;
    const type = connection?.type || preset?.type || typeOf(bootstrap, target) || fail(`"${target}" is neither a connection nor a type. Types: ${typeNames(bootstrap)}. Connections: ${bootstrap.providers.map(p => p.name).join(', ') || 'none'}.`);
    const apiKey = await keyFrom(options, readStdin);
    const baseUrl = options['base-url'] || preset?.baseUrl || connection?.baseUrl;
    if (type === 'compatible' && !baseUrl) fail('An OpenAI-compatible server needs --base-url, for example http://localhost:11434/v1, or --preset ollama.');
    const result = await client.call('/api/models', 'POST', { type, refresh: Boolean(options.refresh), ...(connection ? { connectionId: connection.id } : {}), ...(apiKey ? { apiKey } : {}), ...(type === 'compatible' ? { baseUrl } : {}) });
    if (options.json) { out(JSON.stringify(result, null, 2)); return result.models.length || !result.error ? 0 : 1; }
    const note = overrideNote(bootstrap); if (note) err(note);
    const label = connection ? `${connection.name} (${bootstrap.types[type].label})` : bootstrap.types[type].label;
    const aliases = type === 'claude-cli' ? result.models.filter(m => !m.id.includes('-')) : [];
    const listed = result.models.length - aliases.length;
    const key = { typed: ' with the key given', saved: ' with the saved key', environment: " with the server's environment key" }[result.keySource] || '';
    // Why a list failed, what to check, and whether that failure was remembered from a moment ago rather than asked now.
    const reach = ['unreachable', 'timeout'].includes(result.errorKind);
    const problem = `${result.error}${result.hint ? ` ${result.hint}` : ''}${result.remembered && result.failedAt ? ` (Tried ${ago(result.failedAt)}; --refresh tries again now.)` : ''}`;
    const hiddenNote = result.hidden?.length ? ` ${result.hidden.length} hidden as not for conversation${options.all ? '' : ' (--all shows them)'}.` : '';
    if (result.source === 'aliases') out(`${label}: ${aliases.length} aliases, which follow the newest model of each family. ${result.note || ''}`.trim());
    else if (result.needsKey) err(`${label} lists its models only for a key. Pass --key-env <VAR> or --key-stdin${result.env ? `, or set ${result.env} where the server runs` : ''}.`);
    else if (!listed && result.error) err(`${label}: ${reach ? "can't reach the provider" : "couldn't list models"}${result.keyFrom ? ` with the key from ${result.keyFrom}` : ''}. ${problem}`);
    else {
      if (!listed) out(`${label}: listed no models${key}.${hiddenNote}`);
      else out(`${label}: ${listed} model${listed === 1 ? '' : 's'}${aliases.length ? ` and ${aliases.length} aliases` : ''}, listed ${ago(result.fetchedAt)}${result.keyFrom ? ` with the key from ${result.keyFrom}` : key}.${hiddenNote}`);
      if (result.stale) err(`Warning: ${reach ? "the provider can't be reached now" : 'asking again failed'}, so this is the list it gave ${ago(result.fetchedAt)}. ${problem}`);
      if (result.skipped) err(`Note: ${result.skipped} ${result.skipped === 1 ? 'entry' : 'entries'} in the list could not be read and ${result.skipped === 1 ? 'was' : 'were'} skipped.`);
      if (result.truncated) err('Note: the list was longer than Overrule reads; only the first part is shown.');
    }
    const width = Math.min(48, Math.max(10, ...result.models.map(m => m.id.length), ...(options.all ? result.hidden.map(m => m.id.length) : [])));
    for (const m of result.models) out(`  ${m.id.padEnd(width)}  ${[!m.id.includes('-') && type === 'claude-cli' ? 'alias' : '', m.label, m.created?.slice(0, 10), m.context ? `${m.context.toLocaleString('en-US')} tokens` : '', m.description].filter(Boolean).join(' · ')}`.trimEnd());
    if (options.all && result.hidden?.length) { out('Hidden, not for conversation:'); for (const m of result.hidden) out(`  ${m.id.padEnd(width)}  ${m.reason}`); }
    return result.models.length || !result.error ? 0 : 1;
  }
  if (command === 'connections') {
    const action = options._[1] || 'list';
    const bootstrap = await client.connect();
    const note = overrideNote(bootstrap);
    if (action === 'list') {
      if (options.json) { out(JSON.stringify(bootstrap.providers.map(p => ({ ...p, ready: readiness(bootstrap, p) })), null, 2)); return 0; }
      if (note) err(note);
      if (!bootstrap.providers.length) { out('No connections. Add one with overrule connections add --type <type>.'); return 0; }
      const column = values => Math.max(...values.map(v => v.length));
      const rows = bootstrap.providers.map(p => [p.name, bootstrap.types[p.type].label, p.model || 'CLI default model', readiness(bootstrap, p)]);
      const widths = [0, 1, 2].map(i => column(rows.map(r => r[i])));
      for (const row of rows) out(row.map((cell, i) => i < 3 ? cell.padEnd(widths[i]) : cell).join('  '));
      return 0;
    }
    if (action === 'add' || action === 'edit' || action === 'test') {
      const named = action === 'edit' ? options._[2] || fail('overrule connections edit needs the connection name.') : action === 'test' ? options._[2] : null;
      const existing = named ? findConnection(bootstrap, named) || fail(`No connection named "${named}". Available: ${bootstrap.providers.map(p => p.name).join(', ') || 'none'}.`) : null;
      const preset = options.preset ? bootstrap.presets.find(p => p.id === options.preset) || fail(`No preset called "${options.preset}". Presets: ${bootstrap.presets.map(p => p.id).join(', ')}.`) : null;
      const type = options.type ? typeOf(bootstrap, options.type) || fail(`Unknown type "${options.type}". Types: ${typeNames(bootstrap)}.`) : preset?.type || existing?.type || fail(`overrule connections ${action} needs --type${action === 'test' ? ' or a connection name' : ''}. Types: ${typeNames(bootstrap)}.`);
      const apiKey = await keyFrom(options, readStdin);
      if (apiKey && bootstrap.types[type].cli) fail('CLI connections use the tool’s own sign-in and take no key.');
      const body = {
        type, name: options.name ?? existing?.name ?? preset?.label.replace(/ \(.*\)$/, '') ?? bootstrap.types[type].label,
        model: options.model ?? (existing?.type === type ? existing.model : '') ?? '',
        baseUrl: options['base-url'] ?? preset?.baseUrl ?? existing?.baseUrl ?? '',
        role: options.role ?? existing?.role ?? 'Generalist',
        ...(apiKey ? { apiKey } : {}), ...(options['clear-key'] ? { clearKey: true } : {}),
      };
      if (type === 'compatible' && !body.baseUrl) fail('An OpenAI-compatible connection needs --base-url, for example http://localhost:11434/v1, or --preset ollama.');
      if (action === 'test') {
        const cli = bootstrap.types[type].cli;
        if (!options.json) {
          if (note) err(note);
          err(`Testing ${existing ? `"${existing.name}" (${bootstrap.types[type].label}, ${body.model || 'CLI default model'})` : `${bootstrap.types[type].label}, ${body.model || 'CLI default model'}`}: one short message${cli ? ', counted against the CLI plan; this can take up to two minutes' : type === 'compatible' ? '' : ', billed by the provider as a few tokens'}.`);
        }
        const result = await client.call('/api/providers/test', 'POST', { ...body, ...(existing ? { connectionId: existing.id } : {}) });
        if (options.json) { out(JSON.stringify(result, null, 2)); return result.ok ? 0 : 1; }
        for (const check of result.checks) out(`  ${{ ok: '✓', warn: '!', fail: '✗' }[check.state]} ${check.text}`);
        out(result.ok ? (result.checks.some(c => c.state === 'warn') ? 'The connection works, with a warning.' : 'The connection works.') : 'The connection did not work.');
        return result.ok ? 0 : 1;
      }
      const saved = await client.call(existing ? `/api/providers/${existing.id}` : '/api/providers', existing ? 'PUT' : 'POST', body);
      if (options.json) { out(JSON.stringify(saved, null, 2)); return 0; }
      if (note) err(note);
      out(`${existing ? 'Updated' : 'Added'} "${saved.name}": ${bootstrap.types[saved.type].label}, ${saved.model || 'CLI default model'}, ${readiness(bootstrap, saved)}.`);
      reportCheck(saved.modelCheck, err);
      return 0;
    }
    if (action === 'remove') {
      const found = findConnection(bootstrap, options._[2] || fail('overrule connections remove needs the connection name.')) || fail(`No connection named "${options._[2]}". Available: ${bootstrap.providers.map(p => p.name).join(', ') || 'none'}.`);
      if (!options.yes) {
        const agreed = await confirm(`Remove the connection "${found.name}" (${bootstrap.types[found.type].label}${found.hasKey ? ', with its saved key' : ''})? [y/N] `);
        if (agreed === null) fail('Not removed: there is no terminal to confirm on. Pass --yes to remove without asking.');
        if (!agreed) fail('Not removed.');
      }
      const removed = await client.call(`/api/providers/${found.id}`, 'DELETE');
      if (options.json) out(JSON.stringify({ removed: found.id, councils: removed.councils || [] }, null, 2));
      else {
        out(`Removed "${found.name}".`);
        for (const c of removed.councils || []) err(`It left the council "${c.name}", which has ${c.seatsLeft} seat${c.seatsLeft === 1 ? '' : 's'} left${c.notes.length ? `; ${c.notes.join('; ')}` : ''}.`);
      }
      return 0;
    }
    fail(`Unknown connections action "${action}". Use add, edit, test, or remove, or none to list them.`);
  }
  if (command === 'councils') {
    const action = options._[1] || 'list';
    const bootstrap = await client.connect();
    const nameOf = id => bootstrap.providers.find(p => p.id === id)?.name || id;
    const named = value => findCouncil(bootstrap, value) || fail(`No council called "${value}". Councils: ${(bootstrap.councils || []).map(c => c.name).join(', ') || 'none'}.`);
    if (action === 'list') {
      const list = [...(bootstrap.councils || [])].sort((a, b) => a.name.localeCompare(b.name));
      if (options.json) { out(JSON.stringify(list, null, 2)); return 0; }
      if (!list.length) { out('No saved councils. Save one with overrule councils save <name> --members <names>, or from a meeting with --from <id>.'); return 0; }
      for (const c of list) out(`${c.name}${c.incomplete ? ' (needs seats)' : ''}${c.purpose ? `: ${c.purpose}` : ''}\n  ${describeCouncil(c, nameOf)}`);
      return 0;
    }
    if (action === 'save') {
      const name = options._[2] || fail('overrule councils save needs a name.');
      const seatOf = value => { const found = findConnection(bootstrap, value); if (!found) fail(`No connection named "${value}". Available: ${bootstrap.providers.map(p => p.name).join(', ') || 'none'}.`); return found.id; };
      let seats = null, settings = {}, groups = [];
      if (options.from) {
        const found = await onlyMeeting(client, options.from);
        if (found.demo) fail('The scripted demo has no council to save.');
        const snapshot = snapshotFromRun(await client.call(`/api/runs/${found.id}`));
        seats = snapshot.seats.filter(id => bootstrap.providers.some(p => p.id === id));
        const gone = snapshot.seats.length - seats.length;
        if (gone) err(`${gone} of that meeting's members ${gone === 1 ? 'is' : 'are'} no longer a saved connection and ${gone === 1 ? 'is' : 'are'} left out.`);
        settings = snapshot.settings; groups = GROUP_IDS.filter(id => id !== 'drafter' || seats.includes(settings.drafter.drafterId));
      }
      if (options.members) seats = [...new Set(options.members.split(',').map(n => n.trim()).filter(Boolean).map(seatOf))];
      if (!seats) fail('Give the seats with --members, or copy a meeting with --from <id>.');
      // Options given here are kept, on top of (or instead of) what --from copied.
      const add = id => { if (!groups.includes(id)) groups.push(id); };
      if (options.drafter !== undefined || options['neutral-drafter'] !== undefined) {
        const drafterId = options.drafter !== undefined ? seatOf(options.drafter) : settings.drafter?.drafterId && seats.includes(settings.drafter.drafterId) ? settings.drafter.drafterId : seats[0];
        settings.drafter = { drafterId, neutralDrafter: options['neutral-drafter'] !== undefined ? Boolean(options['neutral-drafter']) : Boolean(settings.drafter?.neutralDrafter) }; add('drafter');
      }
      if (options.cycles !== undefined) { settings.cycles = number(options.cycles, 'cycles'); add('cycles'); }
      if (options.revisions !== undefined) { settings.revisions = number(options.revisions, 'revisions'); add('revisions'); }
      if (options.research !== undefined || options['deep-research'] !== undefined) { settings.research = { research: Boolean(options.research) || Boolean(options['deep-research']), deepResearch: Boolean(options['deep-research']) }; add('research'); }
      if (['call-limit', 'time-limit', 'turn-limit'].some(o => options[o] !== undefined)) {
        const base = settings.limits || { maxCalls: null, maxDurationSeconds: 3600, maxTokens: 4096, timeoutSeconds: 180 };
        settings.limits = { ...base, ...(options['call-limit'] !== undefined ? { maxCalls: number(options['call-limit'], 'call-limit') } : {}), ...(options['time-limit'] !== undefined ? { maxDurationSeconds: number(options['time-limit'], 'time-limit') * 60 } : {}), ...(options['turn-limit'] !== undefined ? { timeoutSeconds: number(options['turn-limit'], 'turn-limit') } : {}) };
        add('limits');
      }
      if (options.without) {
        const without = options.without.split(',').map(g => g.trim().toLowerCase()).filter(Boolean);
        const unknown = without.filter(g => !GROUP_IDS.includes(g));
        if (unknown.length) fail(`--without takes ${GROUP_IDS.join(', ')}; not ${unknown.join(', ')}.`);
        groups = groups.filter(g => !without.includes(g));
      }
      const existing = findCouncil(bootstrap, name);
      const body = { name, purpose: options.purpose ?? (existing && options.replace ? existing.purpose : ''), seats, settings: keep(settings, groups), replace: Boolean(options.replace) };
      let saved;
      try { saved = await client.call('/api/councils', 'POST', body); }
      catch (error) { if (/already exists/.test(error.message)) fail(`${error.message} Pass --replace to replace it, or choose another name.`); throw error; }
      if (options.json) { out(JSON.stringify(saved, null, 2)); return 0; }
      out(`${existing && options.replace ? 'Replaced' : 'Saved'} the council "${saved.name}": ${describeCouncil(saved, nameOf)}.`);
      const left = GROUP_IDS.filter(id => !(id in saved.settings));
      if (left.length) err(`It does not keep ${left.map(id => COUNCIL_GROUPS.find(g => g.id === id).label.toLowerCase()).join(', ')}; those stay as each meeting sets them.`);
      return 0;
    }
    if (action === 'rename') {
      const council = named(options._[2] || fail('overrule councils rename needs the council name.'));
      const to = options._.slice(3).join(' ').trim() || fail(`Give the new name: overrule councils rename "${council.name}" "<new name>".`);
      const saved = await client.call(`/api/councils/${council.id}`, 'PUT', { name: to, purpose: council.purpose, seats: council.seats, settings: council.settings });
      out(options.json ? JSON.stringify(saved, null, 2) : `Renamed the council "${council.name}" to "${saved.name}".`);
      return 0;
    }
    if (action === 'remove') {
      const council = named(options._[2] || fail('overrule councils remove needs the council name.'));
      if (!options.yes) {
        const agreed = await confirm(`Remove the council "${council.name}" (${describeCouncil(council, nameOf)})? Its connections stay saved. [y/N] `);
        if (agreed === null) fail('Not removed: there is no terminal to confirm on. Pass --yes to remove without asking.');
        if (!agreed) fail('Not removed.');
      }
      await client.call(`/api/councils/${council.id}`, 'DELETE');
      out(options.json ? JSON.stringify({ removed: council.id }, null, 2) : `Removed the council "${council.name}". Its connections stay saved.`);
      return 0;
    }
    fail(`Unknown councils action "${action}". Use save, rename, or remove, or none to list them.`);
  }
  if (command === 'list') {
    await client.connect();
    // The server searches; tags and project narrow the result here, the way the browser's filters do.
    const found = await client.call(`/api/runs${options.search ? `?q=${encodeURIComponent(options.search)}` : ''}`);
    const tags = options.tag.map(t => t.toLowerCase()), project = options.project?.toLowerCase();
    const runs = found.filter(run => Boolean(run.archived) === Boolean(options.archived)
      && tags.every(t => (run.pin?.tags || []).some(have => have.toLowerCase() === t))
      && (project === undefined || (run.pin?.project || '').toLowerCase() === project));
    if (options.json) { out(JSON.stringify(runs, null, 2)); return 0; }
    if (!runs.length) { out(options.archived ? 'The Archive is empty' + (options.search || tags.length || project !== undefined ? ' for that search.' : '.') : 'No meetings' + (options.search || tags.length || project !== undefined ? ' match.' : ' yet.')); return 0; }
    const snippet = run => run.match?.snippet ? `\n          ${run.match.field}: ${run.match.snippet.slice(0, 110)}` : '';
    if (options.archived) {
      for (const run of runs) out(`${run.id.slice(0, 8)}  ${String(run.status).padEnd(11)} ${new Date(run.createdAt).toLocaleString()}  ${(run.title || (run.demo ? 'Scripted demo' : run.prompt) || '').replace(/\s+/g, ' ').slice(0, 70)}  (archived ${new Date(run.archived.at).toLocaleDateString()})${snippet(run)}`);
      return 0;
    }
    // Pinned meetings first, as in the browser, then the most recent others.
    const pinned = runs.filter(run => run.pin), recent = runs.filter(run => !run.pin).slice(0, options.search ? 50 : 20);
    const line = run => `${run.id.slice(0, 8)}  ${String(run.status).padEnd(11)} ${new Date(run.createdAt).toLocaleString()}  ${(run.title || (run.demo ? 'Scripted demo' : run.prompt) || '').replace(/\s+/g, ' ').slice(0, 70)}`;
    if (pinned.length) {
      out('Pinned');
      for (const run of pinned) out(`${line(run)}${run.pin.project ? `  [${run.pin.project}]` : ''}${run.pin.tags?.length ? `  ${run.pin.tags.map(t => `#${t}`).join(' ')}` : ''}${snippet(run)}`);
      out(recent.length ? '\nRecent' : '');
    }
    for (const run of recent) out(`${line(run)}${run.pruneBlocked ? `  (past the limit but kept: ${run.pruneBlocked})` : run.expiring ? '  (deleted when the next meeting starts)' : ''}${snippet(run)}`);
    return 0;
  }
  if (command === 'archive' || command === 'unarchive') {
    const id = options._[1] || fail(`overrule ${command} needs a meeting id.`);
    await client.connect();
    const found = await onlyMeeting(client, id);
    const result = await client.call(`/api/runs/${found.id}/archive`, command === 'archive' ? 'PUT' : 'DELETE');
    if (options.json) out(JSON.stringify({ id: found.id, ...result }, null, 2));
    else if (command === 'archive') out(`Archived ${found.id.slice(0, 8)}. It is kept in full and listed with overrule list --archived.`);
    else out(`Unarchived ${found.id.slice(0, 8)}.${result.expiring ? ' It is past the history limit, so the next meeting started deletes it. Pin it to keep it.' : ''}`);
    return 0;
  }
  if (command === 'settings') {
    await client.connect();
    const count = n => Number(n).toLocaleString('en-US');
    const size = bytes => bytes === null || bytes === undefined ? 'an unknown amount' : bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : bytes >= 1024 ** 2 ? `${(bytes / 1024 ** 2).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
    if (options.keep !== undefined) {
      const keep = String(options.keep).toLowerCase();
      if (!['max', 'all'].includes(keep) && !/^\d+$/.test(keep)) fail('--keep takes a number of meetings, or "max" for as many as the disk safely holds.');
      const saved = await client.call('/api/settings', 'PUT', { historyLimit: keep === 'max' || keep === 'all' ? 'max' : Number(keep) });
      if (options.json) { out(JSON.stringify(saved, null, 2)); return 0; }
      out(saved.historyLimit === 'max' ? `The history now keeps as many meetings as the disk safely holds${saved.room === null ? '' : `: about ${count(saved.room)} right now`}.` : `The history now keeps the ${count(saved.historyLimit)} most recent meetings, not counting pinned or archived ones.`);
      if (saved.expiring) out(`${saved.expiring} meeting${saved.expiring === 1 ? ' is' : 's are'} past that limit and will be deleted when the next meeting starts. Pin or archive any you want to keep.`);
      return 0;
    }
    const current = await client.call('/api/settings');
    if (options.json) { out(JSON.stringify(current, null, 2)); return 0; }
    const fits = current.capacity, { meetingsBytes, freeBytes, diskBytes } = current.storage;
    out(`History: ${current.historyLimit === 'max' ? 'keeps as many meetings as the disk safely holds' : `keeps the ${count(current.historyLimit)} most recent meetings`}, not counting pinned or archived ones.`);
    out(`Storage: meetings use ${size(meetingsBytes)}; the disk has ${size(freeBytes)} free${diskBytes ? ` of ${size(diskBytes)}` : ''}.`);
    if (!fits) out('Room: the free space could not be read, so no upper limit applies.');
    else {
      out(`Room: meetings may use ${fits.growthBytes > 0 ? size(fits.growthBytes) : 'nothing'} more (half the free space, keeping ${size(fits.reserveBytes)} free). At about ${size(fits.perMeetingBytes)} a meeting, that is ${count(fits.more)} more: up to ${count(fits.room)} in all.`);
      if (fits.low) out('Free space is low: the history is holding at its size, and each new meeting replaces the oldest unpinned one.');
    }
    return 0;
  }
  if (command === 'rename') {
    const id = options._[1] || fail('overrule rename needs a meeting id.');
    if (options._.length < 3) fail('Give the new name: overrule rename <id> "<name>". An empty name, "", lists the meeting by its brief again.');
    await client.connect();
    const found = await onlyMeeting(client, id);
    const result = await client.call(`/api/runs/${found.id}/title`, 'PUT', { title: options._.slice(2).join(' ') });
    if (options.json) out(JSON.stringify({ id: found.id, ...result }, null, 2));
    else out(result.title ? `Renamed ${found.id.slice(0, 8)} to "${result.title}".` : `Removed the name of ${found.id.slice(0, 8)}; it is listed by its brief again.`);
    return 0;
  }
  if (command === 'pin' || command === 'unpin') {
    const id = options._[1] || fail(`overrule ${command} needs a meeting id.`);
    await client.connect();
    const found = await onlyMeeting(client, id);
    if (command === 'unpin') {
      if (!found.pin) fail(`Meeting ${found.id.slice(0, 8)} is not pinned.`);
      const result = await client.call(`/api/runs/${found.id}/pin`, 'DELETE');
      if (options.json) out(JSON.stringify({ id: found.id, ...result }, null, 2));
      else out(`Unpinned ${found.id.slice(0, 8)}.${result.expiring ? ' It is past the recent-meeting limit, so the next meeting started removes it. Pin it again to keep it.' : ''}`);
      return 0;
    }
    // Only what was given changes: --tag replaces the tags, --project the project; pinning again with neither keeps both.
    const body = { ...(options.tag.length ? { tags: options.tag } : {}), ...(options.project !== undefined ? { project: options.project } : {}) };
    const { pin } = await client.call(`/api/runs/${found.id}/pin`, 'PUT', body);
    if (options.json) out(JSON.stringify({ id: found.id, pin }, null, 2));
    else out(`Pinned ${found.id.slice(0, 8)}${pin.project ? ` under ${pin.project}` : ''}${pin.tags.length ? ` with ${pin.tags.map(t => `#${t}`).join(' ')}` : ''}.`);
    return 0;
  }
  if (command === 'delete') {
    const id = options._[1] || fail('overrule delete needs a meeting id.');
    await client.connect();
    const found = await onlyMeeting(client, id);
    if (found.status === 'running') fail(`Meeting ${found.id.slice(0, 8)} is in session. Stop it first, then delete it.`);
    if (found.pin) fail(`Meeting ${found.id.slice(0, 8)} is pinned. Unpin it first (overrule unpin ${found.id.slice(0, 8)}), then delete it.`);
    if (!options.yes) {
      const summary = `${found.id.slice(0, 8)} (${found.status}) ${(found.demo ? 'Scripted demo' : found.prompt || '').replace(/\s+/g, ' ').slice(0, 70)}`;
      const agreed = await confirm(`Delete meeting ${summary} permanently?\nThis removes its record, documents, patch files, and any candidate branch it left in the workspace. [y/N] `);
      if (agreed === null) fail('Not deleted: there is no terminal to confirm on. Pass --yes to delete without asking.');
      if (!agreed) fail('Not deleted.');
    }
    const result = await client.call(`/api/runs/${found.id}`, 'DELETE');
    if (options.json) out(JSON.stringify(result, null, 2));
    else out(`Deleted ${found.id.slice(0, 8)}${result.removed?.branch ? ` and its branch ${result.removed.branch}` : ''}.`);
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
    const finished = await waitFor(client, found.id, log), result = machineReadable(finished, client.url);
    out(options.json ? JSON.stringify(result, null, 2) : report(finished, result));
    return VERDICT_EXIT[result.verdict?.code] ?? (finished.status === 'complete' ? 0 : 1);
  }
  if (command === 'show' || command === 'watch') {
    const id = options._[1] || fail(`overrule ${command} needs a meeting id.`);
    await client.connect();
    const found = (await client.call('/api/runs')).find(run => run.id === id || run.id.startsWith(id)) || fail(`No meeting starts with ${id}.`);
    const run = command === 'watch' ? await waitFor(client, found.id, log) : await client.call(`/api/runs/${found.id}`);
    const shown = machineReadable(run, client.url);
    out(options.json ? JSON.stringify(shown, null, 2) : report(run, shown));
    return VERDICT_EXIT[shown.verdict?.code] ?? (run.status === 'complete' ? 0 : 1);
  }
  if (command !== 'ask' && command !== 'review') fail(`Unknown command "${command}". Run overrule --help.`);

  if (command === 'review' && !options.path) options.path = options._[1] || '.';
  const bootstrap = await client.connect();
  const council = options.council ? findCouncil(bootstrap, options.council) || fail(`No council called "${options.council}". Councils: ${(bootstrap.councils || []).map(c => c.name).join(', ') || 'none'}.`) : null;
  const members = chooseMembers(bootstrap, options, council);
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
  // A council's kept settings come first; an option given on the command line wins over the council, and is recorded as a change.
  const kept = council?.settings || {};
  const given = name => options[name] !== undefined;
  const changed = council ? [
    ...(options.members ? ['seats'] : []), ...('drafter' in kept && (given('drafter') || given('neutral-drafter')) ? ['drafter'] : []),
    ...('cycles' in kept && given('cycles') ? ['cycles'] : []), ...('revisions' in kept && given('revisions') ? ['revisions'] : []),
    ...('research' in kept && (given('research') || given('deep-research')) ? ['research'] : []),
    ...('limits' in kept && (given('turn-limit') || given('call-limit') || given('time-limit')) ? ['limits'] : []),
  ] : [];
  const research = given('research') || given('deep-research') ? Boolean(options.research) || Boolean(options['deep-research']) : Boolean(kept.research?.research);
  const deepResearch = given('deep-research') || given('research') ? Boolean(options['deep-research']) : Boolean(kept.research?.deepResearch);
  const neutralDrafter = given('neutral-drafter') ? Boolean(options['neutral-drafter']) : Boolean(!given('drafter') && kept.drafter?.neutralDrafter && kept.drafter.drafterId === meeting.drafterId);
  const limits = kept.limits || {};
  if (council && !options.quiet) err(`Council "${council.name}": ${describeCouncil(council, id => bootstrap.providers.find(p => p.id === id)?.name || id)}${changed.length ? ` (changed here: ${changed.join(', ')})` : ''}`);
  const run = await client.call('/api/runs', 'POST', {
    prompt, ...meeting, ...(neutralDrafter ? { neutralDrafter: true } : {}),
    cycles: given('cycles') ? number(options.cycles, 'cycles') : kept.cycles ?? 2,
    revisions: given('revisions') ? number(options.revisions, 'revisions') : kept.revisions ?? 1,
    research, deepResearch,
    ...(given('turn-limit') ? { timeoutSeconds: number(options['turn-limit'], 'turn-limit') } : limits.timeoutSeconds ? { timeoutSeconds: limits.timeoutSeconds } : {}),
    ...(given('call-limit') ? { maxCalls: number(options['call-limit'], 'call-limit') } : limits.maxCalls ? { maxCalls: limits.maxCalls } : {}),
    ...(given('time-limit') ? { maxDurationSeconds: number(options['time-limit'], 'time-limit') * 60 } : limits.maxDurationSeconds ? { maxDurationSeconds: limits.maxDurationSeconds } : {}),
    ...(limits.maxTokens ? { maxTokens: limits.maxTokens } : {}),
    ...(council ? { council: { id: council.id, changed } } : {}),
    ...(attachmentIds.length ? { attachmentIds } : {}), ...(workspace ? { workspace } : {}),
  });
  log(`Meeting ${run.id.slice(0, 8)} started. Watch it at ${client.url}`);
  if (options['no-wait']) { out(options.json ? JSON.stringify({ id: run.id, status: run.status }, null, 2) : run.id); return 0; }
  const finished = await waitFor(client, run.id, log), result = machineReadable(finished, client.url);
  out(options.json ? JSON.stringify(result, null, 2) : report(finished, result));
  return VERDICT_EXIT[result.verdict?.code] ?? (finished.status === 'complete' ? 0 : 1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  // process.exit truncates a piped stdout: set the status and let the process end once the report has been written.
  main(process.argv.slice(2))
    .then(code => { process.exitCode = code; })
    .catch(error => { console.error(error.expected ? error.message : `overrule: ${error.stack}`); process.exitCode = 1; });
}
