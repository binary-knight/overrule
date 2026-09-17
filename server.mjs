import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { Store } from './lib/store.mjs';
import { TYPES, PRESETS, validateProvider, publicProvider, detectClis, cliKey } from './lib/providers.mjs';
import { Mesh, validateRun, exportMarkdown, DEMO_PROMPT, latestCandidate } from './lib/mesh.mjs';
import { validateWorkspacePath, validateRoot, browse as browseWorkspace, browseHost, inspect as inspectWorkspace, codexCanary, measureLevel, agentsecBinary, LEVELS } from './lib/workspace.mjs';
import { SecurityJobs, listPresets, memberProfiles, validateImage, vendoredAgentsec } from './lib/security.mjs';
import { Access } from './lib/access.mjs';

const root = fileURLToPath(new URL('.', import.meta.url));
const defaults = [
  { id: 'codex-local', name: 'Codex', type: 'codex-cli', model: '', baseUrl: '', role: 'Builder: propose concrete, practical solutions' },
  { id: 'claude-local', name: 'Claude Code', type: 'claude-cli', model: '', baseUrl: '', role: 'Reviewer: challenge assumptions and improve clarity' },
];
const demoPool = () => [{ ...defaults[0], id: 'demo-builder', name: 'Demo builder' }, { ...defaults[1], id: 'demo-reviewer', name: 'Demo reviewer' }];

export function createApp({ directory = process.env.MESH_DATA_DIR || join(root, 'data'), providerCall, detect = detectClis, addresses, workspaceRoot = process.env.MESH_WORKSPACE_ROOT || '', canary = codexCanary, checkRunner, measure = (level, cwd) => measureLevel(level, cwd, { dataDir: directory }), securityJobs } = {}) {
  const store = new Store(directory);
  const access = new Access(store, addresses);
  let providers = store.read('providers.json', defaults.map(p => ({ ...p })));
  const mesh = new Mesh(store, providerCall, { runChecks: checkRunner });
  const csrf = randomBytes(32).toString('hex');
  let cliStatus = detect(), probedAt = Date.now();
  const refreshClis = () => { probedAt = Date.now(); return (cliStatus = detect()); };
  // A cached signed-out reading is re-checked on page load once it is half a minute old, so a sign-in made since then shows without a manual check.
  async function currentClis() {
    const clis = await cliStatus;
    const signedOut = Object.values(clis).some(c => c?.installed && c.signedIn === false);
    return signedOut && Date.now() - probedAt > 30_000 ? refreshClis() : clis;
  }
  // Refuse to spend calls on a participant that cannot answer. A CLI reported as signed out is probed once more first,
  // because the user may have signed in since the cached check.
  async function assertReady(participants) {
    let clis = await cliStatus, refreshed = false;
    for (const p of participants) {
      if (!TYPES[p.type].cli) {
        if (p.type !== 'compatible' && !p.secret && !process.env[TYPES[p.type].env]) throw new Error(`Add an API key for ${p.name} in Connections.`);
        continue;
      }
      const key = cliKey(p.type);
      if ((!clis[key]?.installed || clis[key].signedIn === false) && !refreshed) { clis = await refreshClis(); refreshed = true; }
      if (!clis[key]?.installed) throw new Error(`${p.name} requires its CLI on the server PATH. See Connections for setup.`);
      if (clis[key].signedIn === false) throw new Error(`${p.name} is not signed in. Run ${key === 'codex' ? 'codex login' : 'claude auth login'} in your terminal, then use Check in Connections.`);
    }
  }
  // Allowed directories live in the app, managed from the page; MESH_WORKSPACE_ROOT only seeds the list.
  const workspaceSettings = store.read('workspaces.json', { roots: [] });
  let roots = workspaceSettings.roots || [];
  // An optional blast-radius budget: a level whose measured score exceeds it is refused. Blank means show the number and let the owner decide.
  let maxScore = Number.isInteger(workspaceSettings.maxScore) ? workspaceSettings.maxScore : null;
  const saveWorkspaceSettings = () => store.write('workspaces.json', { roots, maxScore });
  if (workspaceRoot) { try { const seeded = validateRoot(workspaceRoot, { appRoot: root, dataDir: directory }); if (!roots.includes(seeded)) { roots.push(seeded); saveWorkspaceSettings(); } } catch (error) { console.error(`MESH_WORKSPACE_ROOT ignored: ${error.message}`); } }
  const workspaceRules = { get roots() { return roots; }, appRoot: root, dataDir: directory };
  const security = securityJobs || new SecurityJobs(directory, { vendorDir: join(root, 'vendor') });
  // A workspace is attached only from the host machine, only under the configured root, and only at a level whose canary holds here.
  // Paired devices may attach workspaces: the owner runs this server headless and works from other machines. The pairing code is
  // therefore the key to sandboxed code execution under the workspace root; where a workspace was attached from is recorded.
  async function parseWorkspace(input, options, from) {
    if (!input || typeof input !== 'object' || !input.path) return null;
    const path = validateWorkspacePath(input.path, workspaceRules);
    const level = String(input.level || 'read-only');
    if (!LEVELS.includes(level)) throw new Error('Choose read-only or workspace-write access.');
    const info = await inspectWorkspace(path);
    if (info.secrets.length && !input.acknowledgeSecrets) throw new Error(`The workspace holds files that look like secrets (${info.secrets.slice(0, 3).join(', ')}${info.secrets.length > 3 ? ', …' : ''}). Anything a member reads can reach its provider. Acknowledge that to continue, or use a clone without them.`);
    const drafter = options.participants.find(p => p.id === options.drafterId);
    const checks = Array.isArray(input.checks) ? input.checks.map(c => String(c).trim()).filter(Boolean).slice(0, 10) : [];
    if (checks.some(c => c.length > 300)) throw new Error('Keep each check command under 300 characters.');
    const implementTimeout = Number(input.implementTimeout ?? 900);
    if (!Number.isInteger(implementTimeout) || implementTimeout < 60 || implementTimeout > 3600) throw new Error('Use an implementer time limit between 60 and 3,600 seconds.');
    if (level !== 'read-only') {
      if (!info.git) throw new Error(`${level === 'full-access' ? 'Full access' : 'Workspace-write'} needs a git repository at the workspace root, so every candidate is a commit you can apply or discard.`);
      if (info.dirty && !input.acknowledgeDirty) throw new Error(`The working tree has uncommitted changes (${info.dirtyFiles.slice(0, 3).join(', ')}${info.dirtyFiles.length > 3 ? ', …' : ''}). Commit or stash them, or acknowledge that the candidate branch starts from HEAD without them.`);
      if (!drafter || !['codex-cli', 'claude-cli'].includes(drafter.type)) throw new Error('The drafter must be a Codex or Claude Code member to act on files. API members have no tools.');
    }
    // Full access is the owner's call and is granted per meeting, never remembered.
    if (level === 'full-access' && input.acknowledgeFullAccess !== true) throw new Error('Full access needs your acknowledgement for this meeting: every member with tools can do anything your account can do on this machine, including reading this app’s own saved keys and your credential files, and sending them to a provider.');
    const result = await canary(level, path);
    if (!result.ok) throw new Error(`${level} is refused on this machine: ${result.detail}`);
    const skipMeasurement = input.skipMeasurement === true;
    const measurement = skipMeasurement ? { available: false, detail: 'Measurement skipped by the owner.' } : await measure(level, path);
    if (!skipMeasurement && maxScore !== null && measurement.available && measurement.score !== null && measurement.score > maxScore) throw new Error(`${level} is refused: its measured blast radius is ${measurement.score}, above your budget of ${maxScore}. ${measurement.detail}`);
    const network = level === 'full-access' ? true : level === 'workspace-write' && input.network === true;
    return { path, level, network, claudeSandbox: input.claudeSandbox !== false, checks, implementTimeout, canary: result, skipMeasurement, measurement: measurement.available ? { tool: measurement.tool, score: measurement.score, findings: measurement.findings, secrets: measurement.secrets, detail: measurement.detail } : null, attachedFrom: from };
  }
  function json(res, status, data) { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); }
  async function body(req) {
    if (!(req.headers['content-type'] || '').startsWith('application/json')) throw new Error('Expected application/json.');
    let data = '';
    for await (const chunk of req) { data += chunk; if (data.length > 64_000) throw new Error('Request too large.'); }
    const parsed = JSON.parse(data);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Expected a JSON object.');
    return parsed;
  }
  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      // Reject hostile origins and DNS rebinding against the local credential broker.
      const port = server.address()?.port;
      if (!access.allowedHost(req.headers.host, port)) return json(res, 403, { error: 'Use localhost or this machine’s LAN IP address.' });
      if (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) return json(res, 403, { error: 'Cross-origin requests are blocked.' });
      if (req.headers['sec-fetch-site'] === 'cross-site') return json(res, 403, { error: 'Cross-site requests are blocked.' });
      const url = new URL(req.url, `http://${req.headers.host}`);
      const local = access.local(req, port);
      if (req.method === 'POST' && url.pathname === '/api/unlock') {
        const result = access.unlock(req, (await body(req)).code);
        if (result.cookie) res.setHeader('Set-Cookie', result.cookie);
        return json(res, result.status, result.error ? { error: result.error } : { ok: true });
      }
      if (!local && !access.authenticated(req)) {
        const loginFiles = { '/': ['login.html', 'text/html'], '/login.js': ['login.js', 'text/javascript'], '/theme.js': ['theme.js', 'text/javascript'], '/styles.css': ['styles.css', 'text/css'], '/favicon.svg': ['favicon.svg', 'image/svg+xml'] };
        if (req.method === 'GET' && Object.hasOwn(loginFiles, url.pathname)) {
          const [file, mime] = loginFiles[url.pathname];
          res.writeHead(200, { 'Content-Type': `${mime}; charset=utf-8` });
          return res.end(await readFile(join(root, 'public', file)));
        }
        return json(res, 401, { error: 'Pair this device first. Open the app and enter the LAN pairing code.' });
      }
      if (!['GET', 'HEAD'].includes(req.method) && req.headers['x-mesh-token'] !== csrf) return json(res, 403, { error: 'Refresh the page before making changes.', code: 'stale-token' });
      if (req.method === 'GET' && url.pathname === '/api/access') {
        if (!local) return json(res, 403, { error: 'View the pairing code through localhost on the host machine.' });
        return json(res, 200, { pairingCode: access.code, urls: access.urls(port), rotatedAt: access.rotatedAt });
      }
      if (req.method === 'POST' && url.pathname === '/api/access/rotate') {
        if (!local) return json(res, 403, { error: 'Rotate the pairing code through localhost on the host machine.' });
        return json(res, 200, { pairingCode: access.rotate(), urls: access.urls(port), rotatedAt: access.rotatedAt });
      }
      if (req.method === 'GET' && url.pathname === '/api/bootstrap') return json(res, 200, { token: csrf, providers: providers.map(publicProvider), types: TYPES, presets: PRESETS, clis: await currentClis(), runs: summaries(mesh.runs), local, lanUrls: access.urls(port) });
      if (req.method === 'POST' && url.pathname === '/api/clis/check') return json(res, 200, await refreshClis());
      if (req.method === 'GET' && url.pathname === '/api/workspace') return json(res, 200, { roots, local, levels: LEVELS, maxScore, agentsec: Boolean(security.binary || agentsecBinary()) });
      if (req.method === 'POST' && url.pathname === '/api/workspace/budget') {
        const value = (await body(req)).maxScore;
        maxScore = value === null || value === '' ? null : Number(value);
        if (maxScore !== null && (!Number.isInteger(maxScore) || maxScore < 0 || maxScore > 100)) throw new Error('The budget is a whole number from 0 to 100, or blank for none.');
        saveWorkspaceSettings(); return json(res, 200, { maxScore });
      }
      if (req.method === 'POST' && url.pathname === '/api/workspace/roots') {
        const added = validateRoot((await body(req)).path, workspaceRules);
        if (roots.length >= 20) throw new Error('You can allow up to 20 directories.');
        if (!roots.includes(added)) { roots = [...roots, added]; saveWorkspaceSettings(); }
        return json(res, 200, { roots });
      }
      if (req.method === 'DELETE' && url.pathname === '/api/workspace/roots') {
        const removed = String((await body(req)).path || '');
        roots = roots.filter(r => r !== removed); saveWorkspaceSettings();
        return json(res, 200, { roots });
      }
      if (req.method === 'POST' && url.pathname === '/api/workspace/browse') return json(res, 200, browseWorkspace((await body(req)).path, workspaceRules));
      if (req.method === 'POST' && url.pathname === '/api/workspace/browse-host') return json(res, 200, browseHost((await body(req)).path, workspaceRules));
      // ---- Security page: member boundaries and the sandbox lab. Presets and member profiles only; no launcher comes from a browser. ----
      if (req.method === 'GET' && url.pathname === '/api/security') {
        const vendored = await vendoredAgentsec(security.vendorDir || join(root, 'vendor'));
        return json(res, 200, { agentsec: Boolean(security.binary), binary: security.binary, vendored: vendored ? { version: vendored.version, commit: vendored.commit, date: vendored.date } : null, presets: security.binary ? await listPresets(security.binary) : [], profiles: memberProfiles(providers), results: (await security.results()).map(r => ({ ...r, provider: undefined })), ...security.status() });
      }
      if (req.method === 'POST' && url.pathname === '/api/security/install') {
        return json(res, 202, security.enqueue({ kind: 'install', label: 'Install agentsec-pack', subject: 'Installs the vendored agentsec-pack into ~/agentsec-pack on the host and creates its virtual environment.' }));
      }
      if (req.method === 'POST' && url.pathname === '/api/security/run') {
        const input = await body(req);
        if (input.kind === 'member') {
          const provider = providers.find(p => p.id === input.providerId);
          const row = memberProfiles(provider ? [provider] : []).find(r => r.mode === input.mode);
          if (!row || !row.measurable) throw new Error('That member and mode cannot be measured from inside.');
          const job = row.measurable === 'claude' ? { kind: 'claude', provider: { ...provider, secret: undefined }, providerId: provider.id, mode: row.mode, label: `${provider.name} (${row.mode})`, subject: row.boundary } : { kind: 'member', providerId: provider.id, mode: row.mode, template: row.template, label: `${provider.name} (${row.mode})`, subject: row.boundary };
          return json(res, 202, security.enqueue(job));
        }
        if (input.kind === 'preset') {
          const preset = (await listPresets(security.binary)).find(p => p.name === input.preset);
          if (!preset) throw new Error('Unknown preset.');
          if (!preset.available) throw new Error(`${preset.name} needs ${preset.needs} on this host.`);
          if (preset.kind === 'container') {
            const image = validateImage(input.image);
            const flags = preset.flags.map(f => f.replace(/'/g, '')).join(' ');
            return json(res, 202, security.enqueue({ kind: 'container', preset: preset.name, image, template: `${preset.needs} run --rm -v {probe}:/agentsec_probe.py:ro ${flags} ${image} python3 /agentsec_probe.py`, label: `${preset.name} · ${image}`, subject: preset.rationale }));
          }
          return json(res, 202, security.enqueue({ kind: 'preset', preset: preset.name, template: preset.template, label: preset.name, subject: preset.rationale }));
        }
        throw new Error('Choose a member or a preset to measure.');
      }
      if (req.method === 'GET' && url.pathname === '/api/security/events') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
        const send = value => { if (!res.destroyed) res.write(`data: ${JSON.stringify(value)}\n\n`); };
        security.listeners.add(send); send({ type: 'status', ...security.status() });
        const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 15000);
        res.on('close', () => { clearInterval(heartbeat); security.listeners.delete(send); });
        return;
      }
      const securityResult = url.pathname.match(/^\/api\/security\/results\/([a-f0-9-]{36})$/);
      if (securityResult && req.method === 'DELETE') { await security.remove(securityResult[1]); return json(res, 200, { ok: true }); }
      if (req.method === 'GET' && url.pathname === '/api/security/report.html') {
        const html = await security.html();
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:" });
        return res.end(html);
      }
      if (req.method === 'POST' && url.pathname === '/api/workspace/inspect') {
        const path = validateWorkspacePath((await body(req)).path, workspaceRules);
        const info = await inspectWorkspace(path);
        const canaries = { 'read-only': await canary('read-only', path) };
        if (info.git) { canaries['workspace-write'] = await canary('workspace-write', path); canaries['full-access'] = await canary('full-access', path); }
        const measurements = {};
        for (const level of Object.keys(canaries)) if (canaries[level].ok) measurements[level] = await measure(level, path);
        return json(res, 200, { ...info, canaries, measurements, maxScore });
      }
      if (req.method === 'POST' && url.pathname === '/api/providers') {
        if (providers.length >= 20) throw new Error('You can save up to 20 connections.');
        const input = await body(req);
        const provider = { ...validateProvider(input), id: randomUUID() };
        if (input.apiKey && !TYPES[provider.type].cli) provider.secret = store.encrypt(input.apiKey);
        providers.push(provider); store.write('providers.json', providers);
        return json(res, 201, publicProvider(provider));
      }
      const providerMatch = url.pathname.match(/^\/api\/providers\/([a-zA-Z0-9-]+)$/);
      if (providerMatch && ['PUT', 'DELETE'].includes(req.method)) {
        const old = providers.find(p => p.id === providerMatch[1]);
        if (!old) return json(res, 404, { error: 'Connection not found.' });
        if (req.method === 'DELETE') { providers = providers.filter(p => p !== old); store.write('providers.json', providers); return json(res, 200, { ok: true }); }
        const input = await body(req);
        const provider = { ...validateProvider(input, old), id: old.id };
        if (!TYPES[provider.type].cli) provider.secret = input.apiKey ? store.encrypt(input.apiKey) : (input.clearKey || old.type !== provider.type ? undefined : old.secret);
        providers = providers.map(p => p.id === old.id ? provider : p); store.write('providers.json', providers);
        return json(res, 200, publicProvider(provider));
      }
      if (req.method === 'GET' && url.pathname === '/api/runs') return json(res, 200, summaries(mesh.runs));
      if (req.method === 'POST' && url.pathname === '/api/runs') {
        const input = await body(req);
        const demo = input.demo === true;
        const pool = demo ? demoPool() : providers;
        // The scripted demo never reads the prompt, so a half-written draft must not become its recorded prompt.
        if (demo) Object.assign(input, { prompt: DEMO_PROMPT, participantIds: pool.map(p => p.id), drafterId: pool[0].id, cycles: 2 });
        const options = validateRun(input, pool);
        options.workspace = demo ? null : await parseWorkspace(input.workspace, options, local ? 'localhost' : String(req.socket.remoteAddress || 'lan'));
        if (!demo) await assertReady(options.participants);
        return json(res, 201, mesh.create(options, demo));
      }
      const match = url.pathname.match(/^\/api\/runs\/([a-zA-Z0-9-]+)(?:\/(events|cancel|resume|say|export|apply|discard|patch))?$/);
      if (match) {
        const run = mesh.runs.find(r => r.id === match[1]);
        if (!run) return json(res, 404, { error: 'Discussion not found.' });
        if (req.method === 'POST' && match[2] === 'cancel') { mesh.cancel(run.id); return json(res, 200, { ok: true }); }
        if (req.method === 'POST' && match[2] === 'say') {
          const text = String((await body(req)).text || '').trim();
          if (!text || text.length > 4000) throw new Error('Say something between 1 and 4,000 characters.');
          mesh.say(run, text); return json(res, 200, { ok: true, pending: run.pendingOwner.length });
        }
        if (req.method === 'POST' && match[2] === 'resume') {
          const pool = run.demo ? demoPool() : providers;
          const participants = run.participants.map(p => pool.find(x => x.id === p.id));
          if (participants.some(p => !p)) throw new Error('A connection used by this discussion no longer exists. Start a new discussion instead.');
          if (run.workspace) {
            const result = await canary(run.workspace.level, run.workspace.path);
            if (!result.ok) throw new Error(`${run.workspace.level} is refused on this machine: ${result.detail}`);
          }
          if (!run.demo) await assertReady(participants);
          return json(res, 200, mesh.resume(run, participants));
        }
        if (req.method === 'POST' && (match[2] === 'apply' || match[2] === 'discard')) {
          return json(res, 200, match[2] === 'apply' ? await mesh.applyCandidate(run) : await mesh.discardCandidate(run));
        }
        if (req.method === 'GET' && match[2] === 'patch') {
          const candidate = latestCandidate(run);
          if (!candidate?.artifact) return json(res, 404, { error: 'This meeting has no patch.' });
          res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Disposition': `attachment; filename="${candidate.artifact}"` });
          return res.end(await readFile(join(directory, 'artifacts', candidate.artifact)));
        }
        if (req.method === 'GET' && match[2] === 'export') {
          res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8', 'Content-Disposition': `attachment; filename="mesh-${run.id}.md"` }); return res.end(exportMarkdown(run));
        }
        if (req.method === 'GET' && match[2] === 'events') {
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
          const send = value => { if (!res.destroyed) { if (res.writableLength > 2_000_000) return res.destroy(); res.write(`data: ${JSON.stringify(value)}\n\n`); } };
          if (!mesh.listeners.has(run.id)) mesh.listeners.set(run.id, new Set());
          mesh.listeners.get(run.id).add(send); send(run);
          const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 15000);
          res.on('close', () => { clearInterval(heartbeat); mesh.listeners.get(run.id)?.delete(send); if (!mesh.listeners.get(run.id)?.size) mesh.listeners.delete(run.id); });
          return;
        }
        if (req.method === 'GET' && !match[2]) return json(res, 200, run);
      }
      const files = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/theme.js': ['theme.js', 'text/javascript'], '/styles.css': ['styles.css', 'text/css'], '/favicon.svg': ['favicon.svg', 'image/svg+xml'] };
      if (req.method === 'GET' && Object.hasOwn(files, url.pathname)) {
        const [file, mime] = files[url.pathname];
        const contents = await readFile(join(root, 'public', file));
        res.writeHead(200, { 'Content-Type': `${mime}; charset=utf-8` }); return res.end(contents);
      }
      return json(res, 404, { error: 'Not found.' });
    } catch (error) {
      if (res.headersSent) return res.end();
      json(res, 400, { error: error instanceof SyntaxError ? 'Invalid JSON request.' : error.message });
    }
  });
  server.requestTimeout = 30_000;
  return { server, mesh, store, access };
}

function summaries(runs) { return runs.map(({ id, prompt, status, createdAt, demo, participants, workspace }) => ({ id, prompt: prompt.slice(0, 140), status, createdAt, demo, count: participants.length, workspace: workspace ? { name: workspace.name, level: workspace.level } : null })); }

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT || 4310);
  const { server, mesh, access } = createApp();
  server.listen(port, process.env.MESH_HOST || '0.0.0.0', () => {
    console.log(`Model Mesh is running at http://localhost:${server.address().port}`);
    for (const url of access.urls(server.address().port)) console.log(`LAN: ${url} (pairing required; view the code in the local app’s LAN access menu)`);
  });
  server.on('error', error => { console.error(error.code === 'EADDRINUSE' ? `Port ${port} is in use. Start with PORT=4311 npm start.` : error.message); process.exitCode = 1; });
  const shutdown = () => { for (const id of mesh.controllers.keys()) mesh.cancel(id); server.close(); server.closeAllConnections(); };
  process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
}
