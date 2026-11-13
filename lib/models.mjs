// Model suggestions, fetched from each provider's own list when the owner asks for them, so a new release shows up without an
// update to this app. Only models a member can hold a conversation with are offered; the rest are counted, with the reason, so a
// connection saved with one of them can be warned about. Free text is always allowed: these are suggestions, never a gate.
import { createHmac } from 'node:crypto';
import { TYPES, CLAUDE_ALIASES, apiBase, readJson, runProcess, deadline } from './providers.mjs';
import { sameModel } from '../public/model-match.js';

export const LIST_TIMEOUT_MS = 10_000;
const LIST_LIMIT_BYTES = 8_000_000;
const MAX_PAGES = 20;
const MAX_MODELS = 2000;
// Providers that refuse to list models without a key. Hugging Face's router and OpenAI-compatible servers may answer without one.
export const NEEDS_KEY = new Set(['openai', 'anthropic', 'gemini', 'grok']);

// Names that mark a model meant for something other than conversation. Overrule members only exchange text, so these are hidden.
// Matched against the model ID, lower-cased; the first match names the reason.
const NOT_CONVERSATION = [
  [/embed|rerank|(^|[-_/])bge-|(^|[-_/])e5-/, 'an embedding or ranking model'],
  [/(^|[-_/.])tts([-_.]|$)|text-to-speech|whisper|transcribe|(^|[-_])audio|realtime|native-audio|(^|[-_])speech|(^|[-_/])live([-_]|$)|lyria/, 'a speech, audio or realtime model'],
  [/dall-e|gpt-image|imagen|imagine|(^|[-_.])image([-_.]|$)|image-generation|(^|[-_])veo|(^|[-_])sora|(^|[-_])video/, 'an image or video model'],
  [/moderation|llama-guard|shieldgemma/, 'a moderation model'],
  [/(^|[-_])ocr([-_]|$)|(^|[-_])aqa([-_]|$)/, 'a document or retrieval model'],
];
// OpenAI members use the Responses API with no tools of their own: legacy completion models do not speak it, and these need tools
// Overrule does not give them.
const OPENAI_ONLY = [
  [/^(babbage|davinci)|gpt-3\.5-turbo-instruct/, 'a legacy completions model'],
  [/search-preview|search-api|computer-use|deep-research/, 'a model that needs tools Overrule does not give its members'],
];

export function exclusionReason(type, id) {
  const lower = String(id).toLowerCase();
  for (const [pattern, reason] of [...(type === 'openai' ? OPENAI_ONLY : []), ...NOT_CONVERSATION]) if (pattern.test(lower)) return reason;
  return null;
}

const iso = value => {
  if (value === undefined || value === null || value === '') return null;
  const date = typeof value === 'number' ? new Date(value * 1000) : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
};
const text = (value, cap = 200) => typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, cap) : '';
const positive = value => Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : null;

// A failure the owner can act on, in our words: the provider's own response body is never repeated, because it can echo a key.
// kind says what sort of failure it was (unreachable, timeout, redirect, key, rate, not-found, http, format, too-large,
// key-format, cli), so the form and the command line can say what to do about it.
export class ListError extends Error {
  constructor(message, kind = 'http') { super(message); this.kind = kind; }
}
function httpFailure(status) {
  if (status === 401 || status === 403) return new ListError(`The provider rejected the key (HTTP ${status}). Check the key and its permissions.`, 'key');
  if (status === 404) return new ListError('This endpoint does not list models (HTTP 404). Type the model ID instead.', 'not-found');
  if (status === 429) return new ListError('The provider is rate limiting this key (HTTP 429). Try again shortly.', 'rate');
  return new ListError(`The provider returned HTTP ${status} when asked for its models.`, 'http');
}
// What a key may contain to travel in an HTTP header: visible ASCII and nothing else. Anything else would fail inside fetch with
// an error about the header rather than about the key.
export const HEADER_SAFE_KEY = /^[\x21-\x7e]+$/;
// Defence in depth: whatever an error says, the key it was made with is taken out before it is shown or logged.
export function scrub(text, key) {
  let out = String(text ?? '');
  if (key && key.length >= 4) out = out.split(key).join('[key]');
  return out;
}
const timedOut = timeoutMs => new ListError(`The provider did not answer within ${Math.round(timeoutMs / 100) / 10} seconds.`, 'timeout');

async function getJson(url, headers, { fetchImpl, signal, timeoutMs }) {
  let response;
  try { response = await fetchImpl(url, { method: 'GET', headers: { Accept: 'application/json', ...headers }, signal, redirect: 'error' }); }
  catch (error) {
    if (signal?.aborted) throw timedOut(timeoutMs);
    const host = (() => { try { return new URL(url).host; } catch { return 'the provider'; } })();
    const why = `${error.message} ${error.cause?.message || ''}`;
    if (/redirect/i.test(why)) throw new ListError(`${host} answered with a redirect, which is refused so a key is never forwarded.`, 'redirect');
    if (/header|ByteString/i.test(why)) throw new ListError('The key has characters a key cannot contain, such as spaces or control characters. Paste it again.', 'key-format');
    throw new ListError(`Could not reach ${host}.`, 'unreachable');
  }
  if (!response.ok) { await response.body?.cancel().catch(() => {}); throw httpFailure(response.status); }
  try { return await readJson(response, LIST_LIMIT_BYTES, signal); }
  catch (error) {
    // A provider that sends its headers and then stalls is caught here: the same deadline covers reading the body.
    if (signal?.aborted) throw timedOut(timeoutMs);
    if (error instanceof SyntaxError) throw new ListError('The provider returned a model list in an unexpected format.', 'format');
    if (/exceeded/.test(error.message)) throw new ListError(`The provider's model list was over ${LIST_LIMIT_BYTES / 1_000_000} MB, more than any model list should be.`, 'too-large');
    throw new ListError('The provider’s answer broke off before the model list was complete.', 'unreachable');
  }
}
const isEntry = value => value !== null && typeof value === 'object' && !Array.isArray(value);
// The array of models in a list response. The list as a whole must be an array; a single entry that is not an object is passed on
// as a blank one, which normalize counts as skipped, so one broken entry never costs the rest of the list.
const list = data => {
  const items = isEntry(data) ? (data.data ?? data.models) : null;
  if (!Array.isArray(items)) throw new ListError('The provider returned a model list in an unexpected format.', 'format');
  return items;
};
const each = (items, read) => items.map(m => isEntry(m) ? read(m) : {});
const idOf = value => typeof value === 'string' ? value : null;

// Each adapter returns { items: raw entries as { id, label, created, context, description }, truncated }.
const ADAPTERS = {
  async openai({ base, key }, io) {
    return { items: each(list(await getJson(`${base}/models`, { Authorization: `Bearer ${key}` }, io)), m => ({ id: idOf(m.id), created: iso(m.created) })) };
  },
  // Anthropic pages with after_id and says when there is more.
  async anthropic({ base, key }, io) {
    const items = []; let after = '', truncated = false;
    for (let page = 0; ; page++) {
      if (page === MAX_PAGES) { truncated = true; break; }
      const data = await getJson(`${base}/models?limit=1000${after ? `&after_id=${encodeURIComponent(after)}` : ''}`, { 'x-api-key': key, 'anthropic-version': '2023-06-01' }, io);
      items.push(...each(list(data), m => ({ id: idOf(m.id), label: text(m.display_name, 80), created: iso(m.created_at) })));
      if (!data.has_more) break;
      // "There is more" with no usable way to ask for it: stop, and say the list is incomplete rather than pretend it is whole.
      if (typeof data.last_id !== 'string' || !data.last_id || data.last_id === after) { truncated = true; break; }
      after = data.last_id;
    }
    return { items, truncated };
  },
  // Gemini's own list says which methods a model supports, which the compatibility endpoint's list does not. Members call the
  // compatibility endpoint, which takes the ID without its "models/" prefix. The key goes in a header, never in the URL.
  async gemini({ base, key }, io) {
    const root = base.replace(/\/openai$/, '');
    const items = []; let token = '', truncated = false;
    for (let page = 0; ; page++) {
      if (page === MAX_PAGES) { truncated = true; break; }
      const data = await getJson(`${root}/models?pageSize=1000${token ? `&pageToken=${encodeURIComponent(token)}` : ''}`, { 'x-goog-api-key': key }, io);
      items.push(...each(list(data), m => {
        const methods = Array.isArray(m.supportedGenerationMethods) ? m.supportedGenerationMethods : null;
        return { id: idOf(m.name)?.replace(/^models\//, '') ?? null, label: text(m.displayName, 80), description: text(m.description), context: positive(m.inputTokenLimit), generates: methods ? methods.includes('generateContent') : true };
      }));
      if (data.nextPageToken === undefined || data.nextPageToken === null || data.nextPageToken === '') break;
      if (typeof data.nextPageToken !== 'string' || data.nextPageToken === token) { truncated = true; break; }
      token = data.nextPageToken;
    }
    return { items, truncated };
  },
  async grok({ base, key }, io) {
    return { items: each(list(await getJson(`${base}/models`, { Authorization: `Bearer ${key}` }, io)), m => ({ id: idOf(m.id), created: iso(m.created) })) };
  },
  // The router lists each model with the inference providers that serve it and, where known, what it takes in and gives back.
  async huggingface({ base, key }, io) {
    return { items: each(list(await getJson(`${base}/models`, key ? { Authorization: `Bearer ${key}` } : {}, io)), m => {
      const providers = Array.isArray(m.providers) ? m.providers.filter(isEntry) : [];
      const outputs = m.architecture?.output_modalities;
      return { id: idOf(m.id), created: iso(m.created), context: positive(Math.max(0, ...providers.map(p => Number(p.context_length) || 0))), description: providers.length ? `served by ${providers.map(p => text(p.provider, 40)).filter(Boolean).slice(0, 4).join(', ')}${providers.length > 4 ? ` and ${providers.length - 4} more` : ''}` : '', generates: Array.isArray(outputs) ? outputs.includes('text') : true };
    }) };
  },
  // Ollama, LM Studio, vLLM and llama.cpp all answer /models in OpenAI's shape, some with a context length of their own.
  async compatible({ base, key }, io) {
    return { items: each(list(await getJson(`${base}/models`, key ? { Authorization: `Bearer ${key}` } : {}, io)), m => ({ id: idOf(m.id), created: iso(m.created), context: positive(m.max_model_len ?? m.context_length ?? m.meta?.n_ctx_train) })) };
  },
};

// Codex publishes its catalog through the CLI, signed in as the owner; nothing here reads its credentials.
export async function codexModels(run = runProcess) {
  let result;
  try { result = await run('codex', ['debug', 'models'], { signal: AbortSignal.timeout(15000), capture: true }); }
  catch (error) { throw /not installed|not on PATH/.test(error.message) ? new ListError('Codex is not installed on the server, so its models cannot be listed.', 'cli') : new ListError('Codex did not list its models in time.', 'timeout'); }
  if (result.code !== 0) throw new ListError('codex debug models failed. Update Codex, or type the model ID.', 'cli');
  let data; try { data = JSON.parse(result.stdout); } catch { throw new ListError('Codex listed its models in an unexpected format.', 'format'); }
  const items = Array.isArray(data) ? data : isEntry(data) && Array.isArray(data.models ?? data.data) ? data.models ?? data.data : null;
  if (!items) throw new ListError('Codex listed its models in an unexpected format.', 'format');
  return { items: each(items, m => ({ id: idOf(m.slug) || idOf(m.id) || idOf(m.name), label: text(m.display_name || m.displayName, 80), description: text(m.description) })).filter(m => !/auto-review/.test(m.id || '')) };
}

// Turn raw entries into what the form and the command line show: no duplicates, only conversational models, newest first.
// skipped counts entries that could not be read; truncated says the list was longer than this app takes in.
export function normalize(type, raw, { truncated = false } = {}) {
  const models = [], hidden = [], seen = new Set();
  let skipped = 0;
  if (raw.length > MAX_MODELS) truncated = true;
  for (const entry of raw.slice(0, MAX_MODELS)) {
    // An ID is used exactly as the provider gave it, or not at all: one with control characters or past the length a connection
    // accepts is skipped rather than repaired into a different ID.
    const id = typeof entry?.id === 'string' ? entry.id.trim() : '';
    if (!id || id.length > 160 || /[\x00-\x1f\x7f]/.test(id)) { skipped++; continue; }
    if (seen.has(id)) continue;
    seen.add(id);
    const reason = exclusionReason(type, id) || (entry.generates === false ? 'a model that does not generate text' : null);
    if (reason) { hidden.push({ id, reason }); continue; }
    const model = { id };
    if (entry.label && entry.label !== id) model.label = entry.label;
    if (entry.created) model.created = entry.created;
    if (entry.context) model.context = entry.context;
    if (entry.description) model.description = entry.description;
    models.push(model);
  }
// Newest first. Dated models by date; a list without dates (Gemini's) by the version in the name, so gemini-3 leads gemini-2.5;
  // ties keep the provider's order. Codex's list is already in the order the CLI recommends, so it is left as it is.
  if (type !== 'codex-cli') {
    const order = new Map(models.map((m, i) => [m.id, i]));
    const version = id => Number(id.match(/\d+(?:\.\d+)?/)?.[0] ?? -1);
    models.sort((a, b) => a.created && b.created ? b.created.localeCompare(a.created) || order.get(a.id) - order.get(b.id)
      : a.created ? -1 : b.created ? 1 : version(b.id) - version(a.id) || order.get(a.id) - order.get(b.id));
  }
  return { models, hidden, skipped, truncated };
}

// Fetch one provider's list. `base` is where the API lives (apiBase for built-in types, the saved URL for compatible ones).
export async function listModels({ type, base, key = '' }, { fetchImpl = fetch, run = runProcess, timeoutMs = LIST_TIMEOUT_MS } = {}) {
  if (type === 'codex-cli') { const { items } = await codexModels(run); return normalize(type, items); }
  const adapter = ADAPTERS[type];
  if (!adapter) throw new ListError('This connection type has no model list.', 'http');
  if (key && !HEADER_SAFE_KEY.test(key)) throw new ListError('The key has characters a key cannot contain, such as spaces or control characters. Paste it again.', 'key-format');
  // The deadline covers reading the body too; readJson enforces it there, because fetch alone may not (see readJson).
  const limit = deadline(timeoutMs);
  try {
    const { items, truncated } = await adapter({ base, key }, { fetchImpl, signal: limit.signal, timeoutMs });
    return normalize(type, items, { truncated });
  } finally { limit.clear(); }
}

// What to do about a failure, in words that suit the browser and the command line alike.
export function hintFor(kind, type, base) {
  const local = type === 'compatible' && (() => { try { return ['localhost', '127.0.0.1', '[::1]'].includes(new URL(base).hostname); } catch { return false; } })();
  if (kind === 'unreachable') return type === 'compatible' ? `Check that the server is running at ${base}${local ? ' (for Ollama, ollama serve)' : ''}, then try again.` : 'Check that this machine can reach the internet, then try again.';
  if (kind === 'timeout') return local ? 'A local server can be slow while it starts or loads a model. Try again in a moment.' : 'The provider may be busy, or something between here and it is holding the connection. Try again in a moment.';
  if (kind === 'format' || kind === 'not-found') return type === 'compatible' ? 'Check that the base URL points at an OpenAI-compatible API, usually ending in /v1.' : '';
  return '';
}

const TTL_MS = 10 * 60_000;
const FAILURE_TTL_MS = 30_000;
const MAX_ENTRIES = 40;
const FILE = 'models.json';

// A list as it was saved, checked before it is trusted: the cache file is ours, but it lives on disk where anything can happen to it.
function savedEntry(value) {
  if (!isEntry(value) || typeof value.fetchedAt !== 'string' || Number.isNaN(Date.parse(value.fetchedAt)) || !Array.isArray(value.models)) return null;
  const models = value.models.filter(m => isEntry(m) && typeof m.id === 'string' && m.id && m.id.length <= 160 && !/[\x00-\x1f\x7f]/.test(m.id));
  const hidden = Array.isArray(value.hidden) ? value.hidden.filter(m => isEntry(m) && typeof m.id === 'string' && typeof m.reason === 'string') : [];
  return { models, hidden, skipped: Number.isInteger(value.skipped) ? value.skipped : 0, truncated: value.truncated === true, fetchedAt: value.fetchedAt };
}

// Lists by provider, endpoint and key, kept in memory and in data/models.json so a provider that cannot be reached still leaves the
// last list it gave. Keys are never stored: a keyed hash tells one key's list from another's, because keys can see different models.
//
// Failure handling, in order: a fresh list (under ten minutes old) is returned without asking. A failure is remembered for half
// a minute, so a provider that is down or hangs is not waited on again by every keystroke; Refresh asks anyway. One request at a
// time goes to a provider for one key, and everyone asking meanwhile shares its answer. A caller that cannot wait (saving a
// connection) gives a maximum wait, gets "pending" when it runs out, and the request carries on and fills the cache.
export class ModelCatalog {
  constructor(store, { fetchImpl = fetch, run = runProcess, now = () => Date.now(), ttlMs = TTL_MS, failureTtlMs = FAILURE_TTL_MS, timeoutMs = LIST_TIMEOUT_MS } = {}) {
    Object.assign(this, { store, fetchImpl, run, now, ttlMs, failureTtlMs, timeoutMs });
    this.salt = createHmac('sha256', store.key).update('overrule model cache').digest();
    this.entries = {};
    this.failures = new Map();
    this.inflight = new Map();
    // A damaged cache costs the cached lists and nothing else: the server starts, the lists are fetched again, the file is rewritten.
    let saved;
    try { saved = store.read(FILE, {}); }
    catch (error) { console.warn(`data/${FILE} could not be read (${error instanceof SyntaxError ? 'not valid JSON' : error.code || 'unreadable'}); model lists will be fetched again and the file rewritten.`); saved = {}; }
    if (isEntry(saved) && isEntry(saved.entries)) for (const [id, value] of Object.entries(saved.entries)) { const entry = savedEntry(value); if (entry) this.entries[id] = entry; }
  }
  cacheKey(type, base, key) {
    return `${type}|${base || ''}|${key ? createHmac('sha256', this.salt).update(key).digest('hex').slice(0, 24) : 'no-key'}`;
  }
  save() {
    const kept = Object.entries(this.entries).sort(([, a], [, b]) => (b.fetchedAt || '').localeCompare(a.fetchedAt || '')).slice(0, MAX_ENTRIES);
    this.entries = Object.fromEntries(kept);
    try { this.store.write(FILE, { version: 1, entries: this.entries }); } catch (error) { console.error(`Could not save the model list cache: ${error.code || 'write failed'}.`); }
  }
  // Starts the request for one list, or returns the one already going. Its outcome lands in the cache or in the failures, whoever
  // is still waiting for it.
  fetchOnce(id, { type, base, key }) {
    if (this.inflight.has(id)) return this.inflight.get(id);
    const request = (async () => {
      try {
        const fetched = await listModels({ type, base, key }, { fetchImpl: this.fetchImpl, run: this.run, timeoutMs: this.timeoutMs });
        this.entries[id] = { ...fetched, fetchedAt: new Date(this.now()).toISOString() };
        this.failures.delete(id); this.save();
        return this.entries[id];
      } catch (error) {
        if (!(error instanceof ListError)) console.error(`Model list for ${type} failed: ${scrub(error.stack || error.message, key)}`);
        const failure = error instanceof ListError ? { error: error.message, errorKind: error.kind } : { error: 'The model list could not be read.', errorKind: 'http' };
        // Expired failures are dropped as new ones arrive, so a server that runs for months keeps only the last half minute's.
        for (const [other, old] of this.failures) if (this.now() - Date.parse(old.failedAt) >= this.failureTtlMs) this.failures.delete(other);
        this.failures.set(id, { ...failure, hint: hintFor(failure.errorKind, type, base), failedAt: new Date(this.now()).toISOString() });
        throw error;
      } finally { this.inflight.delete(id); }
    })();
    request.catch(() => {});
    this.inflight.set(id, request);
    return request;
  }
  // What the form and the command line receive. A fresh cached list is returned as it is; an older one is fetched again, and if
  // the fetch fails the older list is returned with the error, marked stale.
  async get({ type, base = '', key = '', refresh = false, maxWaitMs = null }) {
    const id = this.cacheKey(type, base, key);
    const cached = this.entries[id];
    const empty = { models: [], hidden: [], skipped: 0, truncated: false, fetchedAt: null };
    const view = (entry, extra = {}) => ({ ...empty, ...(entry || {}), cached: false, stale: false, error: null, errorKind: null, hint: '', failedAt: null, pending: false, ...extra });
    const failed = failure => view(cached, { cached: Boolean(cached), stale: Boolean(cached), ...failure });
    if (cached && !refresh && this.now() - Date.parse(cached.fetchedAt) < this.ttlMs) return view(cached, { cached: true });
    const failure = this.failures.get(id);
    if (failure && !refresh && !this.inflight.has(id) && this.now() - Date.parse(failure.failedAt) < this.failureTtlMs) return failed({ ...failure, remembered: true });
    const request = this.fetchOnce(id, { type, base, key });
    const outcome = maxWaitMs === null ? request : Promise.race([request, new Promise(resolve => setTimeout(resolve, maxWaitMs, 'pending').unref?.())]);
    try {
      const entry = await outcome;
      if (entry === 'pending') return view(cached, { cached: Boolean(cached), stale: Boolean(cached), pending: true });
      return view(entry);
    } catch { return failed(this.failures.get(id)); }
  }
}

export function checkModel(type, model, result, { label = TYPES[type]?.label || type, aliasesOnly = false } = {}) {
  const id = String(model || '').trim();
  if (!id) return null;
  if (result.models.some(m => sameModel(type, id, m.id))) return { status: 'listed', detail: `${id} is in the list ${label} gave.` };
  const hidden = result.hidden?.find(m => sameModel(type, id, m.id));
  if (hidden) return { status: 'not-for-conversation', detail: `${label.charAt(0).toUpperCase()}${label.slice(1)} lists ${id} as ${hidden.reason}, not one a council member can talk with. Saved anyway; its turns will likely fail.` };
  if (result.pending && !result.models.length) return { status: 'unchecked', detail: `${id} was not checked: ${label} has not answered for its model list yet. Test connection tries the model itself.` };
  if (aliasesOnly) return { status: 'unchecked', detail: `${id} was not checked: without an Anthropic API key only Claude Code's aliases are known. The CLI will say if it does not accept it.` };
  if (!result.models.length) return { status: 'unchecked', detail: `${id} was not checked: ${result.error ? result.error.replace(/\.$/, '').replace(/^./, c => c.toLowerCase()) : `${label} listed no models`}.` };
  return { status: 'unlisted', detail: `${id} is not among the ${result.models.length} models ${label} listed${result.stale ? ' the last time it answered' : ''}. Saved anyway; check the ID if its first turn fails.` };
}

export { CLAUDE_ALIASES };
