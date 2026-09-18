// Workspace attachment: path rules, secret scan, hook-proof git, isolated worktrees, sandbox arguments, and canaries.
// A level is defined by the boundary the canary proves on this machine, never by the flag that requests it.
import { realpathSync, statSync, readdirSync, existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { resolve, sep, join, relative, basename } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { runProcess } from './providers.mjs';
import { readFile } from 'node:fs/promises';

export const LEVELS = ['read-only', 'workspace-write', 'full-access'];
export const LEVEL_TEXT = { 'read-only': 'read-only tools', 'workspace-write': 'workspace-write', 'full-access': 'FULL ACCESS' };
export const PATCH_CAP = 60_000;
const SECRET_PATTERNS = [/^\.env(\..*)?$/i, /\.(pem|key|p12|pfx|jks|keystore)$/i, /^id_(rsa|ed25519|ecdsa|dsa)$/i, /credentials?(\..*)?$/i, /secrets?(\..*)?$/i, /^\.(npmrc|netrc|pypirc|git-credentials|docker\/config\.json)$/i, /token(s)?\.(json|txt|yml|yaml)$/i, /service[-_]?account.*\.json$/i];
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'target', 'vendor', '__pycache__', '.venv', 'venv']);

const SYSTEM_DIRS = ['/', '/etc', '/usr', '/bin', '/sbin', '/lib', '/lib64', '/var', '/proc', '/sys', '/dev', '/boot', '/root', '/opt', '/srv', '/run'];
const expand = text => resolve(text.startsWith('~/') || text === '~' ? join(homedir(), text.slice(1)) : text);

// A real directory, reached without symlinks, that is not the system, the home directory itself, the app, or its data.
function realDirectory(input, { appRoot, dataDir, browsing = false }) {
  const text = String(input || '').trim();
  if (!text) throw new Error('Enter a directory.');
  const path = expand(text);
  let real;
  try { real = realpathSync(path); } catch { throw new Error('That directory does not exist.'); }
  if (real !== path) throw new Error('Symlinked paths are refused. Use the real directory path.');
  if (!statSync(real).isDirectory()) throw new Error('That path is not a directory.');
  if (SYSTEM_DIRS.includes(real) || SYSTEM_DIRS.some(d => d !== '/' && real.startsWith(d + sep))) throw new Error('System directories cannot be workspaces.');
  if (real === realpathSync(homedir())) throw new Error('Your home directory itself cannot be a workspace; its hidden folders hold your credentials. Choose a project folder inside it.');
  for (const forbidden of [appRoot, dataDir].filter(Boolean)) {
    let f; try { f = realpathSync(resolve(forbidden)); } catch { continue; }
    if (real === f || real.startsWith(f + sep) || (!browsing && f.startsWith(real + sep))) throw new Error('The app’s own directory and its data directory cannot be a workspace.');
  }
  if (real.split(sep).some(part => part.startsWith('.'))) throw new Error('Hidden directories cannot be workspaces.');
  return real;
}

// Any directory that passes the rules above can be a workspace. There is no separate allow list: whoever can attach a workspace
// could always have allowed its parent first, so the list was one authority split into two steps. The rules are the boundary.
export function validateWorkspacePath(input, { appRoot, dataDir } = {}) { return realDirectory(input, { appRoot, dataDir }); }

// Browse the host to pick a workspace. Starts at the home directory; hidden and dependency folders are skipped; each entry says
// whether it could be a workspace, so system directories, the app's own folders, and folders that contain the app still show and
// can be walked through but cannot be chosen.
export function browseHost(input, rules) {
  const start = String(input || '').trim() ? expand(String(input).trim()) : homedir();
  let real;
  try { real = realpathSync(start); } catch { throw new Error('That directory does not exist.'); }
  if (!statSync(real).isDirectory()) throw new Error('That path is not a directory.');
  const selectable = p => { try { validateWorkspacePath(p, rules); return true; } catch { return false; } };
  let entries = [];
  try { entries = readdirSync(real, { withFileTypes: true }).filter(e => e.isDirectory() && !e.name.startsWith('.') && !SKIP_DIRS.has(e.name)).map(e => { const p = join(real, e.name); return { name: e.name, path: p, git: existsSync(join(p, '.git')), selectable: selectable(p) }; }).sort((a, b) => a.name.localeCompare(b.name)).slice(0, 300); }
  catch { throw new Error('That directory cannot be read.'); }
  const parent = real === '/' ? null : resolve(real, '..');
  return { path: real, parent, selectable: selectable(real), git: existsSync(join(real, '.git')), entries };
}

export function scanSecrets(dir, limit = 40) {
  const hits = [];
  const walk = (current, depth) => {
    if (hits.length >= limit || depth > 6) return;
    let entries; try { entries = readdirSync(current, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (hits.length >= limit) return;
      if (entry.isDirectory()) { if (!SKIP_DIRS.has(entry.name)) walk(join(current, entry.name), depth + 1); continue; }
      if (SECRET_PATTERNS.some(p => p.test(entry.name))) hits.push(relative(dir, join(current, entry.name)));
    }
  };
  walk(dir, 0);
  return hits;
}

// Every controller git call ignores repository hooks: an acting member can write them.
export async function git(cwd, args, { signal, input } = {}) {
  const result = await runProcess('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd, signal: signal || AbortSignal.timeout(120_000), capture: true, input });
  if (result.code !== 0) throw new Error(`git ${args[0]} failed: ${(result.stderr || result.stdout).trim().slice(0, 400)}`);
  return result.stdout;
}

export async function inspect(path) {
  const info = { path, name: basename(path), git: false, branch: null, head: null, dirty: false, dirtyFiles: [], secrets: scanSecrets(path) };
  try {
    const top = (await git(path, ['rev-parse', '--show-toplevel'])).trim();
    if (realpathSync(top) !== path) throw new Error('not the repository root');
    info.git = true;
    info.branch = (await git(path, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
    info.head = (await git(path, ['rev-parse', 'HEAD'])).trim();
    const status = await git(path, ['status', '--porcelain', '--untracked-files=all']);
    info.dirtyFiles = status.split('\n').filter(Boolean).map(l => l.slice(3)).slice(0, 50);
    info.dirty = info.dirtyFiles.length > 0;
  } catch (error) { info.gitError = error.message; }
  return info;
}

export async function createBranch(path, runId) {
  const branch = `mesh/${runId.slice(0, 8)}`;
  const base = (await git(path, ['rev-parse', 'HEAD'])).trim();
  await git(path, ['branch', '--force', branch, base]);
  return { branch, base };
}

export async function addWorktree(path, ref, { detach = false, label = 'work' } = {}) {
  // A checkout lost with a crashed server stays registered until pruned, and git refuses to check the branch out again.
  try { await git(path, ['worktree', 'prune']); } catch {}
  const dir = await mkdtemp(join(tmpdir(), `mesh-${label}-`));
  await rm(dir, { recursive: true, force: true });
  await git(path, ['worktree', 'add', ...(detach ? ['--detach'] : []), dir, ref]);
  return dir;
}

export async function removeWorktree(path, dir) {
  if (!dir) return;
  try { await git(path, ['worktree', 'remove', '--force', dir]); } catch {}
  await rm(dir, { recursive: true, force: true }).catch(() => {});
  try { await git(path, ['worktree', 'prune']); } catch {}
}

// Commit whatever the implementer left in its checkout. Returns the new hash, or the head unchanged when nothing moved.
export async function commitCandidate(worktree, message, author = 'Model Mesh <mesh@localhost>') {
  await git(worktree, ['add', '-A']);
  const staged = (await git(worktree, ['status', '--porcelain'])).trim();
  const before = (await git(worktree, ['rev-parse', 'HEAD'])).trim();
  if (!staged) return { hash: before, changed: false };
  await git(worktree, ['-c', `user.name=Model Mesh`, '-c', 'user.email=mesh@localhost', 'commit', '--quiet', '--no-verify', '--author', author, '-m', message]);
  return { hash: (await git(worktree, ['rev-parse', 'HEAD'])).trim(), changed: true };
}

export async function candidateDiff(path, base, hash) {
  const stat = (await git(path, ['diff', '--stat', `${base}..${hash}`])).trim();
  const files = (await git(path, ['diff', '--name-status', `${base}..${hash}`])).trim().split('\n').filter(Boolean).map(l => { const [status, ...rest] = l.split('\t'); return { status, path: rest.join('\t') }; });
  const full = await git(path, ['diff', '--binary', `${base}..${hash}`]);
  return { stat, files, patch: full.length > PATCH_CAP ? full.slice(0, PATCH_CAP) + `\n[patch truncated at ${PATCH_CAP} characters; the full patch is on the branch]` : full, bytes: full.length, full };
}

export async function applyCandidate(path, branch, hash) {
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(hash || '')) throw new Error('The candidate must identify an exact commit.');
  const commit = (await git(path, ['rev-parse', '--verify', `${hash}^{commit}`])).trim();
  if (commit !== hash) throw new Error('The candidate commit could not be verified.');
  const status = (await git(path, ['status', '--porcelain', '--untracked-files=all'])).trim();
  if (status) throw new Error('Your working tree has uncommitted changes. Commit or stash them before applying the candidate.');
  const current = (await git(path, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
  if (current === branch) throw new Error('The candidate branch is checked out. Switch to your branch first.');
  await git(path, ['-c', 'user.name=Model Mesh', '-c', 'user.email=mesh@localhost', 'merge', '--no-ff', '--no-verify', '-m', `Apply council candidate ${hash} from ${branch}`, hash]);
  return { merged: (await git(path, ['rev-parse', 'HEAD'])).trim(), into: current };
}

export async function discardCandidate(path, branch) {
  try { await git(path, ['worktree', 'prune']); } catch {}
  await git(path, ['branch', '-D', branch]);
}

// ---------- canaries ----------

// Proves what a Codex sandbox level does on this machine: a write inside must succeed only at write level, a write outside and a
// proxy-ignoring socket open must always fail. A level whose canary does not hold is refused.
export async function codexCanary(level, cwd, run = runProcess) {
  // Full access has no boundary by definition: the canary records what that means on this machine rather than testing for one.
  if (level === 'full-access') {
    const outside = join(homedir(), `.mesh-canary-${process.pid}`);
    const script = `(echo x > "${outside}") 2>/dev/null && r="outside=ok" || r="outside=blocked"; rm -f "${outside}"; (timeout 5 bash -c "exec 3<>/dev/tcp/1.1.1.1/443") 2>/dev/null && r="$r net=ok" || r="$r net=blocked"; echo "$r"`;
    try {
      const { stdout } = await run('bash', ['-c', script], { cwd, signal: AbortSignal.timeout(20_000), capture: true });
      const net = /net=ok/.test(stdout), outsideOk = /outside=ok/.test(stdout);
      return { level, available: true, inside: 'ok', outside: outsideOk ? 'ok' : 'blocked', network: net ? 'ok' : 'blocked', ok: true, detail: `No boundary, as chosen: this member can write anywhere your account can${net ? ' and reach the network' : '; the network was unreachable from here'}.` };
    } catch (error) { return { level, available: true, inside: 'ok', outside: 'ok', network: null, ok: true, detail: `No boundary, as chosen (canary could not run: ${error.message}).` }; }
  }
  const outside = join(homedir(), `.mesh-canary-${process.pid}`);
  const script = `env -u http_proxy -u https_proxy -u HTTP_PROXY -u HTTPS_PROXY -u ALL_PROXY -u all_proxy bash -c '
r=""; (echo x > ./.mesh-canary) 2>/dev/null && r="$r inside=ok" || r="$r inside=blocked"; rm -f ./.mesh-canary 2>/dev/null
(echo x > "${outside}") 2>/dev/null && r="$r outside=ok" || r="$r outside=blocked"; rm -f "${outside}" 2>/dev/null
(timeout 5 bash -c "exec 3<>/dev/tcp/1.1.1.1/443") 2>/dev/null && r="$r net=ok" || r="$r net=blocked"
echo "$r"'`;
  const result = { level, available: false, inside: null, outside: null, network: null, ok: false, detail: '' };
  try {
    const { code, stdout, stderr } = await run('codex', ['sandbox', '-c', `sandbox_mode="${level}"`, '--', 'bash', '-c', script], { cwd, signal: AbortSignal.timeout(30_000), capture: true });
    const read = key => (stdout.match(new RegExp(`${key}=(ok|blocked)`)) || [])[1] || null;
    Object.assign(result, { inside: read('inside'), outside: read('outside'), network: read('net') });
    if (code !== 0 && !result.inside) { result.detail = `codex sandbox exited ${code}: ${(stderr || stdout).trim().slice(0, 300)}`; return result; }
    result.available = true;
    const wantInside = level === 'workspace-write' ? 'ok' : 'blocked';
    result.ok = result.inside === wantInside && result.outside === 'blocked' && result.network === 'blocked';
    result.detail = result.ok ? `Boundary holds: writes ${level === 'workspace-write' ? 'inside only' : 'blocked'}, no writes outside, no network.` : `Boundary does not hold (inside=${result.inside}, outside=${result.outside}, network=${result.network}). This level is refused.`;
  } catch (error) { result.detail = `Canary could not run: ${error.message}`; }
  await rm(outside, { force: true }).catch(() => {});
  return result;
}

// Runs the owner's allowlisted checks against a candidate checkout inside the write-level sandbox scoped to that copy.
export async function runChecks(commands, cwd, { network = false, timeoutSeconds = 600, run = runProcess, signal } = {}) {
  const results = [];
  const deadline = AbortSignal.timeout(timeoutSeconds * 1000);
  const checkSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
  for (const command of commands) {
    signal?.throwIfAborted();
    const started = Date.now();
    try {
      checkSignal.throwIfAborted();
      const { code, stdout, stderr } = await run('codex', ['sandbox', '-c', 'sandbox_mode="workspace-write"', '-c', `sandbox_workspace_write.network_access=${network ? 'true' : 'false'}`, '--', 'bash', '-lc', command], { cwd, signal: checkSignal, capture: true });
      checkSignal.throwIfAborted();
      results.push({ command, code, output: (stdout + (stderr ? `\n[stderr]\n${stderr}` : '')).slice(-6000), seconds: Math.round((Date.now() - started) / 1000) });
    } catch (error) {
      signal?.throwIfAborted();
      results.push({ command, code: null, output: deadline.aborted ? `Checks timed out after ${timeoutSeconds} seconds.` : error.message, seconds: Math.round((Date.now() - started) / 1000) });
      if (deadline.aborted) break;
    }
  }
  return results;
}

export async function writeArtifact(dataDir, name, text) {
  const path = join(dataDir, 'artifacts'); await import('node:fs/promises').then(fs => fs.mkdir(path, { recursive: true, mode: 0o700 }));
  const file = join(path, name); await writeFile(file, text, { mode: 0o600 }); return file;
}

export function workspaceExists(path) { return Boolean(path) && existsSync(path); }

// ---------- blast-radius measurement with agentsec-pack ----------

// The owner's agentsec-pack, when installed, measures what a member can actually reach from inside each level: network, secrets,
// host filesystem, privileges, sockets. The app's own hand-rolled canary only proves writes and network. Both run; both are shown.
export function agentsecBinary(env = process.env) {
  const candidates = [env.MESH_AGENTSEC, join(homedir(), 'agentsec-pack', '.venv', 'bin', 'agentsec'), join(homedir(), '.local', 'bin', 'agentsec')].filter(Boolean);
  return candidates.find(p => existsSync(p)) || null;
}

// Paths whose readability from inside a level the owner most needs to know about: the app's own secrets and the account's credentials.
export function secretPaths(dataDir) {
  const h = homedir();
  return [join(dataDir, 'vault.key'), join(dataDir, 'providers.json'), join(h, '.ssh'), join(h, '.codex', 'auth.json'), join(h, '.claude'), join(h, '.gitconfig'), join(h, '.config', 'gh', 'hosts.yml'), join(h, '.aws', 'credentials'), join(h, '.netrc')];
}

export function levelTemplate(level) { return level === 'full-access' ? 'python3 {probe}' : `codex sandbox -c sandbox_mode="${level}" -- python3 {probe}`; }

export async function measureLevel(level, cwd, options = {}) {
  return measureTemplate(levelTemplate(level), `model-mesh-${level}`, cwd, { ...options, level });
}

// Measure any launcher template that contains {probe}: the blast-radius score and findings, plus which secret paths are readable.
export async function measureTemplate(template, label, cwd, { dataDir, level = null, binary = agentsecBinary(), run = runProcess, assertPaths = true, rawDir = null } = {}) {
  if (!binary) return { available: false, detail: 'agentsec-pack is not installed; only the built-in canary ran.' };
  const out = await mkdtemp(join(tmpdir(), 'mesh-agentsec-'));
  const result = { available: true, tool: basename(binary), level, template, score: null, findings: [], secrets: [], detail: '' };
  try {
    // blast-radius takes an output directory and writes <label>.json and <label>.md into it.
    const report = join(out, `${label}.json`);
    const blast = await run(binary, ['blast-radius', 'command', '--template', template, '--label', label, '--redact', '--out', out], { cwd, signal: AbortSignal.timeout(180_000), capture: true });
    if (existsSync(report)) {
      const data = JSON.parse(await readFile(report, 'utf8'));
      // The raw, redacted report is kept when asked, so agentsec can render its own page over everything measured here.
      if (rawDir) { await import('node:fs/promises').then(fs => fs.mkdir(rawDir, { recursive: true, mode: 0o700 })); await writeFile(join(rawDir, `${label}-${Date.now()}.json`), JSON.stringify(data), { mode: 0o600 }); result.raw = true; }
      result.score = data.summary?.score ?? null;
      result.findings = (data.summary?.findings || []).map(f => ({ id: f.id, severity: f.severity, title: f.title, category: f.category })).filter(f => f.severity !== 'info');
    } else result.detail = `blast-radius produced no report (exit ${blast.code}): ${(blast.stderr || blast.stdout).trim().slice(-300)}`;
    const assertOut = join(out, 'assert.json');
    const paths = assertPaths ? secretPaths(dataDir).filter(existsSync) : [];
    const args = ['assert', '--kind', 'command', '--template', template, '--out', assertOut];
    for (const p of paths) args.push('--not-readable', p);
    if (paths.length) await run(binary, args, { cwd, signal: AbortSignal.timeout(180_000), capture: true });
    if (existsSync(assertOut)) result.secrets = (JSON.parse(await readFile(assertOut, 'utf8')).rows || []).map(r => ({ path: r.path.replace(homedir(), '~'), readable: r.observed === 'READABLE' || r.observed === 'readable', ok: Boolean(r.ok) }));
    const reachable = result.secrets.filter(s => s.readable).length;
    if (!result.detail) result.detail = `${result.tool}: blast radius ${result.score ?? '?'}/100, ${result.findings.length} finding${result.findings.length === 1 ? '' : 's'} above info; ${reachable ? `${reachable} of ${result.secrets.length} secret paths readable` : 'no probed secret path readable'}.`;
  } catch (error) { result.detail = `agentsec could not run: ${error.message}`; }
  finally { await rm(out, { recursive: true, force: true }).catch(() => {}); }
  return result;
}
