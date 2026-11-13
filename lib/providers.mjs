import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const TYPES = {
  'codex-cli': { label: 'Codex (local sign-in)', cli: true },
  'claude-cli': { label: 'Claude Code (local sign-in)', cli: true },
  openai: { label: 'OpenAI API', url: 'https://api.openai.com/v1', env: 'OPENAI_API_KEY' },
  anthropic: { label: 'Anthropic API', url: 'https://api.anthropic.com/v1', env: 'ANTHROPIC_API_KEY' },
  gemini: { label: 'Gemini API', url: 'https://generativelanguage.googleapis.com/v1beta/openai', env: 'GEMINI_API_KEY' },
  grok: { label: 'Grok API', url: 'https://api.x.ai/v1', env: 'XAI_API_KEY' },
  huggingface: { label: 'Hugging Face Inference Providers', url: 'https://router.huggingface.co/v1', env: 'HF_TOKEN' },
  compatible: { label: 'OpenAI-compatible API (local or hosted)', url: '' },
};

// Claude Code's own aliases, which the CLI resolves to the newest model of each family, so they never go stale. Full model IDs
// come from Anthropic's model list when an Anthropic API key is available (see lib/models.mjs). Free text is always allowed.
export const CLAUDE_ALIASES = [
  { id: 'fable', label: 'Fable (newest)', description: 'Claude Code alias for the newest Fable model' },
  { id: 'opus', label: 'Opus (newest)', description: 'Claude Code alias for the newest Opus model' },
  { id: 'sonnet', label: 'Sonnet (newest)', description: 'Claude Code alias for the newest Sonnet model' },
  { id: 'haiku', label: 'Haiku (newest)', description: 'Claude Code alias for the newest Haiku model' },
];

// For development only: send every built-in API type to one server on this machine, such as scripts/fake-provider.mjs, under
// /<type>/ plus the provider's own path. Only loopback addresses are accepted, so a typo cannot send saved keys anywhere else;
// an invalid value fails every API call rather than falling back to the real provider. Nothing about it is saved.
export const OVERRIDE_ENV = 'OVERRULE_PROVIDER_OVERRIDE_URL';
export function providerOverride(env = process.env) {
  const raw = env[OVERRIDE_ENV];
  if (!raw) return null;
  let url;
  try { url = new URL(raw); } catch { throw new Error(`${OVERRIDE_ENV} is not a URL.`); }
  if (!['http:', 'https:'].includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || url.username || url.password || url.search || url.hash) throw new Error(`${OVERRIDE_ENV} must be an http address on this machine (localhost, 127.0.0.1 or [::1]).`);
  return url.toString().replace(/\/$/, '');
}
// Where API calls for a connection go. Built-in types are resolved at call time rather than read from the saved connection, so the
// override never reaches providers.json and a changed provider URL applies to connections saved before it.
export function apiBase(provider, env = process.env) {
  if (provider.type === 'compatible') return provider.baseUrl;
  const base = TYPES[provider.type]?.url;
  if (!base) throw new Error('This connection type has no API address.');
  const override = providerOverride(env);
  return override ? `${override}/${provider.type}${new URL(base).pathname}` : base;
}
export const PRESETS = [
  { id: 'ollama', label: 'Ollama (local)', type: 'compatible', baseUrl: 'http://localhost:11434/v1', hint: 'Model ID as shown by `ollama list`, for example llama3.3 or qwen2.5-coder:32b.' },
  { id: 'lmstudio', label: 'LM Studio (local)', type: 'compatible', baseUrl: 'http://localhost:1234/v1', hint: 'Enable the local server in LM Studio; the model ID is the one it lists.' },
  { id: 'vllm', label: 'vLLM (local)', type: 'compatible', baseUrl: 'http://localhost:8000/v1', hint: 'The model ID is the name the vLLM server was started with.' },
  { id: 'llamacpp', label: 'llama.cpp server (local)', type: 'compatible', baseUrl: 'http://localhost:8080/v1', hint: 'Any model ID is accepted; llama.cpp serves the model it was started with.' },
  { id: 'huggingface', label: 'Hugging Face Inference Providers', type: 'huggingface', baseUrl: 'https://router.huggingface.co/v1', hint: 'Model ID from the Hub, optionally with a provider or policy suffix, for example openai/gpt-oss-120b:fastest. Needs a Hugging Face token with Inference Providers permission.' },
];

export function validateProvider(input, previous) {
  const type = input.type;
  if (!Object.hasOwn(TYPES, type)) throw new Error('Choose a supported connection type.');
  const name = String(input.name || '').trim();
  const model = String(input.model || '').trim();
  if (!name || name.length > 80) throw new Error('Use a name between 1 and 80 characters.');
  if (model.length > 160 || /[\r\n\0]/.test(model)) throw new Error('Invalid model ID.');
  if (!TYPES[type].cli && !model) throw new Error('Enter the model ID from your provider.');
  const baseUrl = type === 'compatible' ? compatibleBaseUrl(input.baseUrl) : TYPES[type].url || '';
  const key = cleanKey(input.apiKey);
  if (previous && previous.baseUrl !== baseUrl && !key && previous.secret) throw new Error('Re-enter your key when changing the endpoint.');
  return { name, type, model, baseUrl, role: String(input.role || 'Generalist').slice(0, 300) };
}

// A pasted key, as it will be sent: surrounding whitespace (a stray space or newline from copying) removed, and nothing left that
// cannot travel in an HTTP header. A key is never repeated in the error, because errors are shown and logged.
export function cleanKey(value) {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value !== 'string' || value.length > 4096) throw new Error('Invalid API key.');
  const key = value.trim();
  if (key && !/^[\x21-\x7e]+$/.test(key)) throw new Error('The API key has characters a key cannot contain, such as spaces or control characters. Paste it again.');
  return key;
}

// An OpenAI-compatible base URL: HTTPS anywhere, or plain HTTP to a model server on this machine. No credentials or query in it.
export function compatibleBaseUrl(value) {
  try {
    const url = new URL(value);
    if (url.username || url.password || url.search || url.hash) throw new Error();
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) throw new Error();
    return url.toString().replace(/\/$/, '');
  } catch { throw new Error('Use an HTTPS API base URL, or HTTP for a localhost model server.'); }
}

export function publicProvider(provider) {
  const { secret, ...safe } = provider;
  return { ...safe, hasKey: Boolean(secret), environmentKey: Boolean(TYPES[provider.type]?.env && process.env[TYPES[provider.type].env]) };
}

// Children get a minimal environment. The server's environment may hold provider keys and whatever the owner's shell exported, and a
// sandboxed member can read its own environment, so nothing passes through unless it is on this list or in OVERRULE_CLI_ENV_PASSTHROUGH (MESH_CLI_ENV_PASSTHROUGH still works).
const CHILD_ENV_KEYS = ['HOME', 'USER', 'LOGNAME', 'PATH', 'SHELL', 'TERM', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ', 'TMPDIR', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_RUNTIME_DIR', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS', 'REQUESTS_CA_BUNDLE', 'GIT_SSL_CAINFO'];
export function childEnv(source = process.env) {
  const extra = String(source.OVERRULE_CLI_ENV_PASSTHROUGH || source.MESH_CLI_ENV_PASSTHROUGH || '').split(',').map(s => s.trim()).filter(Boolean);
  const env = {};
  for (const key of [...CHILD_ENV_KEYS, ...extra]) if (source[key] !== undefined) env[key] = source[key];
  return env;
}

// Only fixed executables and argument arrays are used; prompts are passed on stdin.
export function runProcess(command, args, { input = '', cwd, signal, limit = 4_000_000, capture = false, env } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const child = spawn(command, args, { cwd, env: env || childEnv(), shell: false, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', failure, killTimer;
    const kill = (sig) => { try { if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, sig); else child.kill(sig); } catch {} };
    const stop = (error) => { failure ||= error; kill('SIGTERM'); killTimer ||= setTimeout(() => kill('SIGKILL'), 1500); };
    const abort = () => stop(signal.reason || new Error('Cancelled.'));
    signal?.addEventListener('abort', abort, { once: true });
    child.stdout.on('data', chunk => { stdout += chunk; if (stdout.length > limit) stop(new Error('Provider output exceeded the response limit.')); });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-8000); });
    child.stdin.on('error', () => {});
    // EACCES is what spawn reports when a directory on PATH cannot be read and the command is found nowhere else: not installed either.
    child.on('error', error => { failure = error.code === 'ENOENT' ? new Error(`${command} is not installed or is not on PATH.`) : error.code === 'EACCES' ? new Error(`${command} is not installed or is not on PATH (the system refused to run it).`) : error; });
    child.on('close', code => {
      clearTimeout(killTimer);
      signal?.removeEventListener('abort', abort);
      if (failure) return reject(failure);
      if (capture) return resolve({ code, stdout, stderr });
      if (code !== 0) return reject(new Error(cliFailure(command, code, stdout, stderr)));
      resolve(stdout);
    });
    child.stdin.end(input);
  });
}

const CODEX_TALK = ['-c', 'features.shell_tool=false', '-c', 'features.unified_exec=false'];
const CODEX_COMMON = ['-a', 'never', 'exec', '--ignore-user-config', '--skip-git-repo-check', '--ephemeral', '--json', '--color', 'never', '-c', 'features.multi_agent=false', '-c', 'features.apps=false', '-c', 'features.plugins=false', '-c', 'web_search="disabled"'];
// Research mode gives members the web. Codex runs the search through its own provider rather than the sandboxed shell, so it
// works at every level; Claude Code gets its search and fetch tools back. Members that cannot browse are named as such in the prompt.
export const RESEARCH_MODELS = /opus-5|opus-4[-.]?[678]|sonnet-5|sonnet-4[-.]?6|fable-5/i;
export function researchSupport(provider) {
  if (provider.type === 'codex-cli') return { web: true, detail: 'searches the web through Codex' };
  if (provider.type === 'claude-cli') return { web: true, detail: 'searches the web, and fetches pages except under read-only' };
  if (provider.type === 'openai') return { web: true, detail: 'searches the web through the Responses API' };
  if (provider.type === 'anthropic') return { web: true, detail: 'searches the web through the Messages API' };
  return { web: false, detail: 'cannot browse; it relies on what others quote' };
}

// Codex runs inside its own OS sandbox: read-only for talk and floor turns, workspace-write for a confined implementer, and
// danger-full-access when the owner chooses to let a member run loose on the machine.
export function codexArgs({ level, cwd, model, network = false, research = false } = {}) {
  const sandbox = level === 'full-access' ? 'danger-full-access' : level === 'workspace-write' ? 'workspace-write' : 'read-only';
  // In a workspace, AGENTS.md is a repository-text channel into the member; a zero byte budget keeps Codex from reading it (documented key; verify on the host with the README probe).
  return [...CODEX_COMMON.map(arg => research && arg === 'web_search="disabled"' ? 'web_search="live"' : arg), '--sandbox', sandbox, ...(cwd ? ['-C', cwd, '-c', 'project_doc_max_bytes=0'] : CODEX_TALK), ...(sandbox === 'workspace-write' ? ['-c', `sandbox_workspace_write.network_access=${network ? 'true' : 'false'}`] : []), ...(model ? ['--model', model] : []), '-'];
}

// Claude Code's own OS sandbox, generated per call: writes only inside the checkout, no network unless allowed, no unsandboxed retry.
export function claudeSandboxSettings({ cwd = null, network = false, allowedDomains = [] } = {}) {
  // No writable path at all is how a read-only member gets a shell: its own scratch directory stays writable, the workspace does not.
  return JSON.stringify({ sandbox: { enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false, autoAllowBashIfSandboxed: true, filesystem: { allowWrite: cwd ? [cwd] : [] }, network: { allowedDomains: network ? (allowedDomains.length ? allowedDomains : ['*']) : [] } } });
}

// Claude Code by level. read-only: file tools confined to the workspace, no shell (a permission boundary, not an OS one).
// workspace-write: edits and shell allowed, inside Claude's OS sandbox when `sandboxed`, otherwise only the permission layer.
// full-access: every permission check off; the member can do anything the account can. The owner chose it and acknowledged it.
export function claudeArgs({ level, cwd, model, network = false, sandboxed = true, research = false, shell = false } = {}) {
  const base = ['--print', '--output-format', 'json', '--no-session-persistence', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--permission-prompts', 'none'];
  const withModel = model ? ['--model', model] : [];
  // The web tools must be named in --allowedTools as well: this permission mode denies anything that would otherwise ask.
  const web = research ? ['--allowedTools', 'WebSearch', 'WebFetch'] : [];
  if (!cwd) return [...base, '--permission-mode', 'dontAsk', '--safe-mode', '--tools', research ? 'WebSearch,WebFetch' : '', ...web, ...withModel];
  // --safe-mode keeps the account's own sign-in and skips CLAUDE.md discovery, which is a repository-text channel into the member. --bare would drop OAuth sign-in.
  // A read-only member gets the same shell its Codex peers have when Claude Code's own sandbox can hold it: the process runs in a
  // throwaway directory with nothing else writable, so commands can read the workspace and cannot change it. Restricted mode
  // removes the code-running tools unless --tools names them, so they are named back in.
  if (level === 'read-only' && shell) {
    const tools = ['Bash', 'Read', 'Glob', 'Grep', ...(research ? ['WebSearch', 'WebFetch'] : [])];
    return [...base, '--permission-mode', 'dontAsk', '--safe-mode', '--restricted', '--tools', tools.join(','), '--allowedTools', ...tools, '--settings', claudeSandboxSettings({ network: false }), ...withModel];
  }
  // Restricted mode removes WebFetch whatever the allow list says, so a read-only researcher searches but does not fetch pages.
  if (level === 'read-only') return [...base, '--permission-mode', 'dontAsk', '--safe-mode', '--restricted', '--disallowedTools', 'Bash', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit', ...(research ? [] : ['WebFetch', 'WebSearch']), ...web, ...withModel];
  if (level === 'workspace-write') return [...base, '--permission-mode', 'acceptEdits', '--safe-mode', '--allowedTools', 'Bash', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit', ...(research ? ['WebSearch', 'WebFetch'] : []), ...(research ? [] : ['--disallowedTools', 'WebFetch', 'WebSearch']), ...(sandboxed ? ['--settings', claudeSandboxSettings({ cwd, network })] : []), ...withModel];
  return [...base, '--dangerously-skip-permissions', ...withModel];
}

export function cliCommand(type, model, context = {}) {
  return type === 'codex-cli' ? ['codex', codexArgs({ ...context, model })] : ['claude', claudeArgs({ ...context, model })];
}

// What a CLI member did with its tools, from the event stream. Telemetry that may be incomplete, never proof.
function summarizeItem(item) {
  const action = { type: item.type, status: item.status };
  if (typeof item.command === 'string') action.command = item.command.slice(0, 400);
  else if (Array.isArray(item.command)) action.command = item.command.join(' ').slice(0, 400);
  if (item.exit_code !== undefined) action.exitCode = item.exit_code;
  if (Array.isArray(item.changes)) action.paths = item.changes.map(c => `${c.kind || 'change'} ${c.path}`).slice(0, 40);
  if (typeof item.aggregated_output === 'string' && item.aggregated_output) action.output = item.aggregated_output.slice(-2000);
  if (item.type === 'mcp_tool_call' || item.type === 'web_search') action.command = action.command || `${item.server || ''} ${item.tool || item.query || ''}`.trim();
  return action;
}

// What a CLI said when it failed, in its own words. Codex reports its errors as events on standard output (a model at capacity,
// a usage limit), Claude Code as a JSON result; either beats a guess. Sign-in is suggested only when the message is about auth.
export function cliFailure(command, code, stdout = '', stderr = '') {
  let said = '';
  for (const line of String(stdout).split('\n')) {
    let event; try { event = JSON.parse(line); } catch { continue; }
    const message = event?.type === 'error' ? event.message : event?.type === 'turn.failed' ? event.error?.message : event?.is_error ? event.result : null;
    if (message) said = String(message);
  }
  if (!said) said = String(stderr).trim().split('\n').filter(Boolean).at(-1) || '';
  said = said.replace(/\s+/g, ' ').slice(0, 300);
  const hint = stderr.includes('unrecognized') || stderr.includes('unknown option') ? ' Update the CLI to support the required options.'
    : !said || /sign.?in|log.?in|auth|credential|unauthori[sz]ed|401|403/i.test(said) ? ' Check its sign-in in your terminal.' : '';
  return `${command} exited with code ${code}${said ? `: ${said}${/[.!?]$/.test(said) ? '' : '.'}` : '.'}${hint}`;
}

export function parseCli(type, output) {
  if (type === 'claude-cli') {
    const result = JSON.parse(output);
    if (result.is_error || (result.subtype && result.subtype !== 'success')) throw new Error('Claude Code could not complete the request. Check sign-in, model access, and plan limits in your terminal.');
    const actions = (result.permission_denials || []).map(d => ({ type: 'denied', command: `${d.tool_name || 'tool'} ${JSON.stringify(d.tool_input || {}).slice(0, 200)}` }));
    return { text: result.result || '', usage: normalizeUsage(result.usage), actions };
  }
  let text = '', usage = {}, error = false; const actions = [];
  for (const line of output.split('\n').filter(Boolean)) {
    let event; try { event = JSON.parse(line); } catch { continue; }
    if (event.type === 'turn.failed') error = true;
    if (event.type === 'item.completed' && event.item?.type === 'agent_message') text = event.item.text;
    else if (event.type === 'item.completed' && event.item && event.item.type !== 'reasoning') actions.push(summarizeItem(event.item));
    if (event.type === 'turn.completed') usage = normalizeUsage(event.usage);
  }
  if (error) throw new Error('Codex could not complete the request. Check sign-in, model access, and plan limits in your terminal.');
  return { text, usage, actions };
}

// Anthropic reports cached input apart from input_tokens, and a Claude Code call is mostly cached system prompt: leaving it out
// undercounts what a member read. OpenAI's input_tokens already includes its cached share, so nothing is added there.
function normalizeUsage(value = {}) {
  return { input: (value.input_tokens ?? value.prompt_tokens ?? 0) + (value.cache_creation_input_tokens || 0) + (value.cache_read_input_tokens || 0), output: value.output_tokens ?? value.completion_tokens ?? 0 };
}

export function apiRequest(provider, system, prompt, maxTokens, { research = false, deepResearch = false } = {}) {
  const { type, model } = provider, baseUrl = apiBase(provider);
  const browse = research && researchSupport(provider).web;
  if (type === 'openai') return { url: `${baseUrl}/responses`, body: { model, instructions: system, input: prompt, max_output_tokens: maxTokens, store: false, ...(browse ? { tools: [{ type: 'web_search' }] } : {}) } };
  // The dated tool name is the provider's own versioning: current models take the newer search tool, older ones only the first one.
  if (type === 'anthropic') return { url: `${baseUrl}/messages`, body: { model, system, messages: [{ role: 'user', content: prompt }], max_tokens: maxTokens, ...(browse ? { tools: [{ type: RESEARCH_MODELS.test(model || '') ? 'web_search_20260209' : 'web_search_20250305', name: 'web_search', max_uses: deepResearch ? 25 : 8 }] } : {}) } };
  return { url: `${baseUrl}/chat/completions`, body: { model, messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }], max_tokens: maxTokens, stream: false } };
}

// Reads a JSON body up to a size limit. The deadline is enforced here as well as in fetch: fetch passes an abort on to a body it is
// still reading only while its own request object is alive, and nothing holds that object once the headers have arrived, so after a
// garbage collection a provider that sends headers and then goes quiet would hold this read open for good. Cancelling the reader
// ourselves ends the read and closes the connection.
export async function readJson(response, limit = 4_000_000, signal = null) {
  const reader = response.body.getReader();
  const stop = () => { reader.cancel(signal.reason).catch(() => {}); };
  if (signal?.aborted) stop(); else signal?.addEventListener('abort', stop, { once: true });
  try {
    const chunks = []; let length = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (signal?.aborted) throw signal.reason;
      if (done) break;
      length += value.length;
      if (length > limit) { await reader.cancel(); throw new Error(`Provider response exceeded ${Math.round(limit / 1_000_000)} MB.`); }
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally { signal?.removeEventListener('abort', stop); }
}

// A deadline whose timer holds its own controller. AbortSignal.timeout() and AbortSignal.any() keep their signals only weakly
// reachable, and a stalled provider answer showed how little else may be holding things (see readJson); a turn limit should not
// depend on what the garbage collector leaves. A parent signal (the meeting being cancelled) still aborts it.
export function deadline(ms, parent) {
  const controller = new AbortController();
  let expired = false;
  const timer = setTimeout(() => { expired = true; controller.abort(new DOMException('The operation was aborted due to timeout', 'TimeoutError')); }, ms);
  timer.unref?.();
  const onParent = () => controller.abort(parent.reason);
  if (parent) { if (parent.aborted) onParent(); else parent.addEventListener('abort', onParent, { once: true }); }
  return { signal: controller.signal, expired: () => expired, clear() { clearTimeout(timer); parent?.removeEventListener('abort', onParent); } };
}

// A provider's own short error code (invalid_api_key, model_not_found, insufficient_quota, not_found_error, RESOURCE_EXHAUSTED), read
// from the start of its error body. Only a bare identifier is kept: the message beside it can echo part of the key.
async function providerErrorCode(response) {
  try {
    const reader = response.body?.getReader();
    if (!reader) return null;
    const chunks = []; let length = 0;
    while (length < 16_384) { const { done, value } = await reader.read(); if (done) break; chunks.push(value); length += value.length; }
    await reader.cancel().catch(() => {});
    let data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (Array.isArray(data)) data = data[0];
    const error = data?.error && typeof data.error === 'object' ? data.error : data;
    const code = [error?.code, error?.status, error?.type].find(value => typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_.-]{1,39}$/.test(value) && value !== 'error');
    return code || null;
  } catch { return null; }
}
// Errors carry what went wrong as fields as well as words, so a connection test can say which part failed.
const tagged = (message, fields) => Object.assign(new Error(message), fields);

export async function callProvider(provider, request, store, fetchImpl = fetch) {
  const { system, prompt, maxTokens, timeoutSeconds, signal } = request;
  const limit = deadline(timeoutSeconds * 1000, signal), timedSignal = limit.signal;
  let result, url, key = '';
  try {
    if (TYPES[provider.type].cli) {
      // With a workspace the member runs inside it under the requested level; without one, in an empty temporary directory with tools off.
      // A Claude member reading a workspace runs in a scratch directory, because its sandbox keeps its own working directory
      // writable; the workspace is reachable for reading and stays out of everything it can change.
      const readingShell = provider.type === 'claude-cli' && request.cwd && (request.level || 'read-only') === 'read-only' && request.claudeShell !== false;
      const own = !request.cwd || readingShell, cwd = own ? await mkdtemp(join(tmpdir(), 'overrule-')) : request.cwd;
      try {
        const [command, args] = cliCommand(provider.type, provider.model, { research: Boolean(request.research), ...(request.cwd ? { cwd: request.cwd, level: request.level || 'read-only', network: request.network, sandboxed: request.sandboxed !== false, shell: readingShell } : {}) });
        result = parseCli(provider.type, await runProcess(command, args, { cwd, signal: timedSignal, input: `${system}\n\n${prompt}` }));
      } finally { if (own) await rm(cwd, { recursive: true, force: true }); }
    } else {
      const saved = store.decrypt(provider.secret);
      key = saved || (process.env[TYPES[provider.type].env] || '').trim();
      if (!key && provider.type !== 'compatible') throw tagged('Add an API key in Connections.', { code: 'no-key' });
      if (!/^[\x21-\x7e]+$/.test(key) && key) throw tagged(`${saved ? 'The saved key' : `${TYPES[provider.type].env} on the server`} has characters a key cannot contain, such as spaces or control characters.`, { code: 'key-format' });
      const request_ = apiRequest(provider, system, prompt, maxTokens, { research: Boolean(request.research), deepResearch: Boolean(request.deepResearch) });
      url = request_.url; const body = request_.body;
      const headers = { 'Content-Type': 'application/json' };
      if (key) headers[provider.type === 'anthropic' ? 'x-api-key' : 'Authorization'] = provider.type === 'anthropic' ? key : `Bearer ${key}`;
      if (provider.type === 'anthropic') headers['anthropic-version'] = '2023-06-01';
      const response = await fetchImpl(url, { method: 'POST', headers, body: JSON.stringify(body), signal: timedSignal, redirect: 'error' });
      if (!response.ok) {
        const providerCode = await providerErrorCode(response);
        const hint = response.status === 401 || response.status === 403 ? 'Check your key and model access.' : response.status === 429 ? 'Rate or credit limit reached. Try again later.' : 'Check the model ID, provider status, and token limit.';
        throw tagged(`Provider returned HTTP ${response.status}. ${hint}`, { code: 'http', status: response.status, providerCode });
      }
      const data = await readJson(response, undefined, timedSignal);
      let text;
      if (provider.type === 'openai') {
        if (data.status === 'incomplete') throw tagged('OpenAI reached the output limit. Increase the token limit and retry.', { code: 'output-limit' });
        text = data.output?.flatMap(item => item.content || []).filter(item => item.type === 'output_text').map(item => item.text).join('\n');
      } else if (provider.type === 'anthropic') {
        if (data.stop_reason === 'max_tokens') throw tagged('Claude reached the output limit. Increase the token limit and retry.', { code: 'output-limit' });
        text = data.content?.filter(item => item.type === 'text').map(item => item.text).join('\n');
      } else {
        if (data.choices?.[0]?.finish_reason === 'length') throw tagged('The model reached the output limit. Increase the token limit and retry.', { code: 'output-limit' });
        text = data.choices?.[0]?.message?.content;
      }
      result = { text, usage: normalizeUsage(data.usage) };
    }
    if (typeof result.text !== 'string' || !result.text.trim()) throw tagged('The provider returned no text. Check the model and output limit.', { code: 'no-text' });
    if (result.text.length > 100_000) throw new Error('The answer exceeded the 100,000 character limit.');
    return result;
  } catch (error) {
    if (signal.aborted) throw tagged('Cancelled.', { code: 'cancelled' });
    if (limit.expired()) throw tagged(`Timed out after ${timeoutSeconds} seconds.`, { code: 'timeout' });
    if (error instanceof SyntaxError) throw tagged('The provider returned an unexpected response format.', { code: 'format' });
    // fetch reports every network failure as "fetch failed"; say which host, and say so plainly when it was a refused redirect.
    if (error instanceof TypeError && url && (error.message === 'fetch failed' || error.message === 'terminated' || /ByteString|header/i.test(error.message))) {
      const host = new URL(url).host, why = `${error.message} ${error.cause?.message || ''}`;
      if (/redirect/i.test(why)) throw tagged(`${host} answered with a redirect, which is refused so a key is never forwarded.`, { code: 'redirect' });
      if (/ByteString|header/i.test(why)) throw tagged('The key has characters a key cannot contain, such as spaces or control characters.', { code: 'key-format' });
      // The connection opened and then broke: the answer was cut off rather than never sent.
      if (/terminated|other side closed|socket/i.test(why)) throw tagged(`${host} broke off its answer.`, { code: 'unreachable' });
      throw tagged(`Could not reach ${host}.`, { code: 'unreachable' });
    }
    // Whatever else went wrong, its words are shown and stored: the key is taken out of them first.
    if (key && String(error?.message).includes(key)) throw Object.assign(new Error(String(error.message).split(key).join('[key]')), { code: error.code });
    throw error;
  } finally { limit.clear(); }
}

export function cliKey(type) { return type === 'codex-cli' ? 'codex' : 'claude'; }

// Interpret a CLI's own status command. signedIn is true, false, or null when the CLI cannot report it.
export function interpretAuth(command, { code, stdout = '', stderr = '' }) {
  const unknownCommand = /unrecognized|unknown (command|option|subcommand)|unexpected argument/i.test(stderr);
  if (command === 'codex') {
    // Codex prints its status line to stderr and exits 0 only when signed in.
    const output = stdout + stderr;
    if (code === 0 && !/not logged in/i.test(output)) return { signedIn: true, detail: 'Signed in.' };
    if (unknownCommand && !/not logged in/i.test(output)) return { signedIn: null, detail: 'Update Codex to check sign-in status.' };
    return { signedIn: false, detail: 'Not signed in. Run codex login in your terminal.' };
  }
  try {
    const data = JSON.parse(stdout);
    if (typeof data.loggedIn === 'boolean') return data.loggedIn ? { signedIn: true, detail: 'Signed in.' } : { signedIn: false, detail: 'Not signed in. Run claude auth login in your terminal.' };
  } catch {}
  if (unknownCommand) return { signedIn: null, detail: 'Update Claude Code to check sign-in status.' };
  if (code !== 0) return { signedIn: false, detail: 'Not signed in. Run claude auth login in your terminal.' };
  return { signedIn: null, detail: 'Sign-in status could not be read.' };
}

export async function probeCli(command, run = runProcess, pause = 750) {
  const checkedAt = new Date().toISOString();
  const args = command === 'codex' ? ['login', 'status'] : ['auth', 'status', '--json'];
  try {
    let auth = interpretAuth(command, await run(command, args, { signal: AbortSignal.timeout(8000), capture: true }));
    // A signed-out reading can be transient while the CLI rewrites its credentials, so confirm it once before reporting it.
    if (auth.signedIn === false) { await new Promise(resolve => setTimeout(resolve, pause)); auth = interpretAuth(command, await run(command, args, { signal: AbortSignal.timeout(8000), capture: true })); }
    return { installed: true, checkedAt, ...auth };
  } catch (error) {
    if (/not installed|not on PATH/.test(error.message)) return { installed: false, signedIn: null, detail: 'CLI not found on the server PATH.', checkedAt };
    return { installed: true, signedIn: null, detail: 'Sign-in status could not be checked.', checkedAt };
  }
}

// Sign-in status only. Model lists are fetched on demand by lib/models.mjs, so checking a sign-in no longer runs `codex debug models`.
export async function detectClis() {
  const [codex, claude] = await Promise.all([probeCli('codex'), probeCli('claude')]);
  return { codex, claude };
}
