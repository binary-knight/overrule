// The Security page: what each council member can reach from inside the way this app launches it, and a lab for measuring and
// hardening sandboxes with the owner's agentsec-pack. Presets and member profiles only; a browser never supplies a launcher.
import { readFile, mkdir, writeFile, readdir, rm, mkdtemp } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { runProcess, TYPES, cliCommand } from './providers.mjs';
import { agentsecBinary, measureTemplate, levelTemplate } from './workspace.mjs';

const IMAGE = /^[a-z0-9][a-z0-9._\/-]{0,200}(:[A-Za-z0-9._-]{1,128})?(@sha256:[a-f0-9]{64})?$/;

export function packRoot(binary) { return binary ? dirname(dirname(dirname(binary))) : null; }

// Named sandbox configurations shipped with agentsec-pack, with whether this host can run each one.
export async function listPresets(binary = agentsecBinary(), run = runProcess) {
  const root = packRoot(binary);
  const file = root && join(root, 'agentsec', 'data', 'presets.json');
  if (!file || !existsSync(file)) return [];
  const data = JSON.parse(await readFile(file, 'utf8'));
  const presets = Object.entries(data.presets || {}).map(([name, p]) => ({ name, kind: p.kind, needs: p.kind === 'container' ? p.engine : String(p.template || '').split(' ')[0], rationale: p.rationale || '', flags: p.flags || null, template: p.kind === 'command' ? p.template : null }));
  const available = {};
  for (const need of new Set(presets.map(p => p.needs))) {
    try { available[need] = (await run('sh', ['-c', `command -v ${need.replace(/[^a-zA-Z0-9_.-]/g, '')}`], { capture: true, signal: AbortSignal.timeout(5000) })).code === 0; } catch { available[need] = false; }
  }
  return presets.map(p => ({ ...p, available: Boolean(available[p.needs]) }));
}

// How this app launches each member, and which of those launches can be measured from inside.
export function memberProfiles(providers) {
  const rows = [];
  for (const p of providers) {
    const base = { providerId: p.id, name: p.name, type: p.type, model: p.model || '' };
    if (p.type === 'codex-cli') {
      rows.push({ ...base, mode: 'talk', boundary: 'Codex OS sandbox, read-only, empty temporary directory, shell tool off', measurable: 'template', template: levelTemplate('read-only') });
      rows.push({ ...base, mode: 'read-only', boundary: 'Codex OS sandbox, read-only, inside the workspace', measurable: 'template', template: levelTemplate('read-only') });
      rows.push({ ...base, mode: 'workspace-write', boundary: 'Codex OS sandbox, writes inside the checkout, network off unless allowed', measurable: 'template', template: levelTemplate('workspace-write') });
      rows.push({ ...base, mode: 'full-access', boundary: 'No boundary: danger-full-access, anything your account can do', measurable: 'template', template: levelTemplate('full-access') });
    } else if (p.type === 'claude-cli') {
      rows.push({ ...base, mode: 'talk', boundary: 'No tools at all; nothing executes', measurable: null });
      rows.push({ ...base, mode: 'read-only', boundary: 'Claude Code permission layer: file reads confined to the workspace, no shell. Not an OS boundary; the probe needs a shell, so this row cannot be measured', measurable: null });
      rows.push({ ...base, mode: 'workspace-write', boundary: 'Claude Code OS sandbox (bubblewrap) when available: writes inside the checkout, network off. Measured by asking this member to run the probe, which spends one call', measurable: 'claude' });
      rows.push({ ...base, mode: 'full-access', boundary: 'No boundary: permission checks off, anything your account can do. Measured by asking this member to run the probe, which spends one call', measurable: 'claude' });
    } else {
      rows.push({ ...base, mode: 'talk', boundary: 'API member: never executes anything on this machine', measurable: null });
    }
  }
  return rows;
}

// Ask a Claude Code member to run the probe inside its own boundary and score what comes back. Honest about the source: this is the
// member measuring itself, the same capture path agentsec-pack documents for any agent's own sandbox.
export async function measureClaude(provider, mode, { dataDir, binary = agentsecBinary(), run = runProcess, providerCall, rawDir = null } = {}) {
  if (!binary) return { available: false, detail: 'agentsec-pack is not installed.' };
  const probe = join(packRoot(binary), 'agentsec', 'probe', 'blast_probe.py');
  if (!existsSync(probe)) return { available: false, detail: 'agentsec probe not found beside the binary.' };
  const cwd = await mkdtemp(join(tmpdir(), 'mesh-claude-probe-'));
  const result = { available: true, tool: basename(binary), level: mode, template: `claude (${mode}) runs python3 blast_probe.py`, score: null, findings: [], secrets: [], detail: '', selfMeasured: true };
  try {
    const outFile = join(cwd, 'probe.json');
    const [command, args] = cliCommand('claude-cli', provider.model, { cwd, level: mode, network: false, sandboxed: true });
    const prompt = `Run exactly this shell command and nothing else, then reply with the single word DONE:\npython3 ${probe} > ${outFile}`;
    const call = providerCall || (async () => { const r = await run(command, args, { cwd, input: prompt, signal: AbortSignal.timeout(300_000), capture: true }); return { code: r.code, stderr: r.stderr, stdout: r.stdout }; });
    const reply = await call({ cwd, command, args, prompt });
    if (!existsSync(outFile)) { result.available = false; result.detail = `The member did not produce probe output (exit ${reply.code ?? '?'}). ${(reply.stderr || reply.stdout || '').trim().slice(-300)}`; return result; }
    const label = `overrule-claude-${mode}`;
    const scored = await run(binary, ['score', outFile, '--label', label, '--how', `Overrule asked the Claude Code member to run the probe under its ${mode} launch (--print, ${mode === 'full-access' ? 'permissions off' : 'acceptEdits inside Claude Code sandbox settings'}) on ${new Date().toISOString().slice(0, 10)}; environment minimised by the app`, '--redact'], { cwd, capture: true, signal: AbortSignal.timeout(60_000) });
    const reportsDir = join(cwd, 'reports');
    const file = existsSync(reportsDir) ? (await readdir(reportsDir)).find(f => f.endsWith('.json')) : null;
    if (!file) { result.detail = `score produced no report: ${(scored.stderr || scored.stdout).trim().slice(-300)}`; return result; }
    const data = JSON.parse(await readFile(join(reportsDir, file), 'utf8'));
    if (rawDir) { await mkdir(rawDir, { recursive: true, mode: 0o700 }); await writeFile(join(rawDir, `${label}-${Date.now()}.json`), JSON.stringify(data), { mode: 0o600 }); result.raw = true; }
    result.score = data.summary?.score ?? null;
    result.findings = (data.summary?.findings || []).map(f => ({ id: f.id, severity: f.severity, title: f.title, category: f.category })).filter(f => f.severity !== 'info');
    result.detail = `${result.tool}: blast radius ${result.score}/100 from the member's own probe run, ${result.findings.length} finding${result.findings.length === 1 ? '' : 's'} above info. Secret-path asserts are not available on this capture path.`;
  } catch (error) { result.detail = `Measurement failed: ${error.message}`; }
  finally { await rm(cwd, { recursive: true, force: true }).catch(() => {}); }
  return result;
}

// Install agentsec-pack on the host from the bundle this project vendors (built by scripts/package-agentsec.sh and refreshed by CI),
// falling back to a clone of the public repository. Fixed commands, fixed paths, every step logged.
export async function vendoredAgentsec(vendorDir) {
  const manifest = join(vendorDir, 'agentsec.json');
  if (!existsSync(manifest)) return null;
  try { const data = JSON.parse(await readFile(manifest, 'utf8')); return existsSync(join(vendorDir, data.file)) ? { ...data, path: join(vendorDir, data.file) } : null; } catch { return null; }
}

export async function installAgentsec({ vendorDir, target = join(homedir(), 'agentsec-pack'), run = runProcess, log = () => {}, source = 'https://github.com/binary-knight/agentsec-pack.git' } = {}) {
  const binary = join(target, '.venv', 'bin', 'agentsec');
  const step = async (label, command, args, options = {}) => {
    log(`$ ${[command, ...args].join(' ')}`);
    const r = await run(command, args, { capture: true, signal: AbortSignal.timeout(600_000), ...options });
    const text = (r.stdout + (r.stderr ? '\n' + r.stderr : '')).trim();
    if (text) log(text.slice(-2000));
    if (r.code !== 0) throw new Error(`${label} failed (exit ${r.code}).`);
    return r;
  };
  if (existsSync(binary)) { log(`Already installed at ${binary}.`); return { binary, installed: false }; }
  const bundle = await vendoredAgentsec(vendorDir);
  await mkdir(dirname(target), { recursive: true });
  if (existsSync(target)) throw new Error(`${target} exists but holds no installed tool. Remove or rename it, then install again.`);
  if (bundle) {
    log(`Unpacking vendored agentsec-pack ${bundle.version} (${bundle.commit.slice(0, 8)}, packaged ${bundle.date}).`);
    const staging = await mkdtemp(join(tmpdir(), 'mesh-agentsec-install-'));
    try {
      await step('Unpack', 'tar', ['-xzf', bundle.path, '-C', staging]);
      await step('Place', 'mv', [join(staging, 'agentsec-pack'), target]);
    } finally { await rm(staging, { recursive: true, force: true }).catch(() => {}); }
  } else {
    log('No vendored bundle found; cloning the public repository (needs network access to GitHub).');
    await step('Clone', 'git', ['clone', '--depth', '1', source, target]);
  }
  await step('Create the virtual environment', 'python3', ['-m', 'venv', join(target, '.venv')]);
  await step('Install', join(target, '.venv', 'bin', 'pip'), ['install', '--disable-pip-version-check', '-e', target], { cwd: target });
  if (!existsSync(binary)) throw new Error(`Install finished but ${binary} is missing.`);
  await step('Check', binary, ['presets']);
  log(`Installed at ${binary}.`);
  return { binary, installed: true };
}

export function validateImage(image) {
  const text = String(image || '').trim();
  if (!IMAGE.test(text)) throw new Error('Enter a container image name like python:3.12-slim or ghcr.io/org/agent:tag.');
  return text;
}

// One measurement at a time, results kept under the app's data, progress published to listeners.
export class SecurityJobs {
  constructor(directory, { binary = agentsecBinary(), run = runProcess, measure = measureTemplate, measureClaudeFn = measureClaude, presets = listPresets, install = installAgentsec, vendorDir = null } = {}) {
    this.dir = join(directory, 'security'); this.binary = binary; this.run = run; this.measure = measure; this.measureClaudeFn = measureClaudeFn; this.presetsFn = presets; this.installFn = install; this.vendorDir = vendorDir;
    this.queue = []; this.current = null; this.listeners = new Set();
  }
  async results() {
    if (!existsSync(this.dir)) return [];
    const files = (await readdir(this.dir)).filter(f => f.endsWith('.json'));
    const out = [];
    for (const f of files) { try { out.push(JSON.parse(await readFile(join(this.dir, f), 'utf8'))); } catch {} }
    return out.sort((a, b) => (b.at || '').localeCompare(a.at || ''));
  }
  publish(event) { for (const cb of this.listeners) cb(event); }
  status() { return { running: this.current, queued: this.queue.map(j => ({ id: j.id, label: j.label })) }; }
  enqueue(job) {
    if (!this.binary && job.kind !== 'install') throw new Error('agentsec-pack is not installed on the host.');
    if (job.kind === 'install' && (this.current?.kind === 'install' || this.queue.some(j => j.kind === 'install'))) throw new Error('An install is already running.');
    const entry = { id: randomUUID(), at: new Date().toISOString(), status: 'queued', ...job };
    this.queue.push(entry); this.publish({ type: 'queued', job: entry }); this.pump(); return entry;
  }
  async pump() {
    if (this.current || !this.queue.length) return;
    const job = this.queue.shift(); this.current = { id: job.id, label: job.label, kind: job.kind, startedAt: new Date().toISOString(), log: [] };
    this.publish({ type: 'started', job: this.current });
    let result;
    try {
      const rawDir = join(this.dir, 'raw');
      if (job.kind === 'install') {
        const log = line => { this.current.log.push(line); this.publish({ type: 'log', id: job.id, line }); };
        const done = await this.installFn({ vendorDir: this.vendorDir, run: this.run, log });
        this.binary = done.binary;
        const record = { id: job.id, at: job.at, kind: 'install', label: job.label, available: true, detail: done.installed ? `Installed agentsec-pack at ${done.binary}.` : `agentsec-pack was already installed at ${done.binary}.`, log: this.current.log };
        this.current = null; this.publish({ type: 'finished', result: record, installed: true }); this.pump(); return;
      }
      if (job.kind === 'claude') result = await this.measureClaudeFn(job.provider, job.mode, { dataDir: dirname(this.dir), binary: this.binary, run: this.run, rawDir });
      else result = await this.measure(job.template, job.label.replace(/[^a-zA-Z0-9_.-]+/g, '-').replace(/^-+|-+$/g, ''), job.cwd || tmpdir(), { dataDir: dirname(this.dir), binary: this.binary, run: this.run, assertPaths: job.kind !== 'container', rawDir });
    } catch (error) { result = { available: false, detail: error.message, log: this.current?.log }; }
    const record = { id: job.id, at: job.at, kind: job.kind, label: job.label, subject: job.subject || null, template: job.template || result.template || null, providerId: job.providerId || null, mode: job.mode || null, ...result };
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    await writeFile(join(this.dir, `${job.id}.json`), JSON.stringify(record, null, 2), { mode: 0o600 });
    this.current = null; this.publish({ type: 'finished', result: record });
    this.pump();
  }
  async remove(id) { if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('Bad id.'); await rm(join(this.dir, `${id}.json`), { force: true }); }
  // A self-contained HTML page over every stored result, rendered by agentsec itself.
  async html() {
    if (!this.binary) throw new Error('agentsec-pack is not installed on the host.');
    const dir = await mkdtemp(join(tmpdir(), 'mesh-security-report-'));
    try {
      const inputs = await this.results();
      // agentsec report wants its own envelope shape; the stored results keep the summary the app extracted, so re-run report over raw files when present.
      const out = join(dir, 'report.html');
      const raw = existsSync(join(this.dir, 'raw')) ? join(this.dir, 'raw') : null;
      if (!raw) throw new Error('No raw agentsec reports are stored yet; run a measurement first.');
      const r = await this.run(this.binary, ['report', raw, '--out', out], { capture: true, signal: AbortSignal.timeout(60_000) });
      if (!existsSync(out)) throw new Error(`report failed: ${(r.stderr || r.stdout).trim().slice(-300)}`);
      return await readFile(out, 'utf8');
    } finally { await rm(dir, { recursive: true, force: true }).catch(() => {}); }
  }
}

export function presetTemplate(preset) {
  if (preset.kind === 'command') return preset.template;
  return null;
}
