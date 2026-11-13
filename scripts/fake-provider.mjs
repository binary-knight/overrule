#!/usr/bin/env node
// A local stand-in for every API provider Overrule speaks to, for development and tests with no network and no credits.
// It answers each provider's model list in that provider's own shape (paging, auth header, field names) and answers meeting turns
// with scripted replies that follow the rules of order, so a whole meeting can run through the real API adapters.
//
//   npm run fake-provider                      # listens on http://127.0.0.1:4999
//   OVERRULE_PROVIDER_OVERRIDE_URL=http://127.0.0.1:4999 npm start
//
// Then add connections with any key that starts with "fake-". Some keys make the provider misbehave on purpose:
//   fake-401 fake-429 fake-500    that HTTP status          fake-slow      answers after 15 seconds
//   fake-garbage                  a body that is not JSON   fake-redirect  a redirect to another host
//   fake-huge                     a model list over 8 MB    fake-empty     an empty model list
//   fake-limited                  an account that sees only a few models
//   fake-quota                    429 insufficient_quota    fake-limit     a reply cut off at the token limit, with no text
//   fake-hang                     accepts and never answers fake-stall     sends headers and half a body, then nothing
//   fake-many                     a model list of 500       fake-shape     JSON that is not a model list
//   fake-nulls                    a model list with broken entries among good ones
// Anything after a further dash is ignored (fake-429-a1b2 acts as fake-429). A key that does not start with "fake-" is rejected with 401. For an OpenAI-compatible connection use the base URL
// http://127.0.0.1:4999/compatible/v1; it needs no key. Model names below are illustrative, not any provider's real catalog.
import http from 'node:http';

const day = date => Math.floor(Date.parse(date) / 1000);
export const CATALOG = {
  openai: [
    { id: 'gpt-6-astra', created: day('2026-05-12') }, { id: 'gpt-5.6-sol', created: day('2026-02-03') }, { id: 'gpt-5.6', created: day('2026-01-20') },
    { id: 'gpt-5.6-2026-01-20', created: day('2026-01-20') }, { id: 'gpt-5.6-mini', created: day('2026-01-20') }, { id: 'gpt-5.5', created: day('2025-10-01') },
    { id: 'o5-mini', created: day('2025-11-14') }, { id: 'text-embedding-3-large', created: day('2024-01-25') }, { id: 'tts-2', created: day('2025-06-01') },
    { id: 'whisper-2', created: day('2025-06-01') }, { id: 'gpt-image-2', created: day('2025-12-01') }, { id: 'omni-moderation-latest', created: day('2024-09-26') },
    { id: 'gpt-5.6-realtime', created: day('2026-01-20') }, { id: 'gpt-4o-search-preview', created: day('2025-03-11') }, { id: 'o5-deep-research', created: day('2025-12-09') },
    { id: 'davinci-002', created: day('2023-08-21') },
  ].map(m => ({ ...m, object: 'model', owned_by: 'system' })),
  anthropic: [
    { id: 'claude-fable-5-1', display_name: 'Claude Fable 5.1', created_at: '2026-04-22T00:00:00Z' }, { id: 'claude-opus-5', display_name: 'Claude Opus 5', created_at: '2026-03-04T00:00:00Z' },
    { id: 'claude-sonnet-5', display_name: 'Claude Sonnet 5', created_at: '2026-03-04T00:00:00Z' }, { id: 'claude-opus-4-8', display_name: 'Claude Opus 4.8', created_at: '2025-12-10T00:00:00Z' },
    { id: 'claude-sonnet-4-6', display_name: 'Claude Sonnet 4.6', created_at: '2025-11-18T00:00:00Z' }, { id: 'claude-haiku-4-5', display_name: 'Claude Haiku 4.5', created_at: '2025-10-15T00:00:00Z' },
  ].map(m => ({ type: 'model', ...m })),
  gemini: [
    { name: 'models/gemini-3-pro', displayName: 'Gemini 3 Pro', description: 'Our most capable model.', inputTokenLimit: 1048576, supportedGenerationMethods: ['generateContent', 'countTokens'] },
    { name: 'models/gemini-3-flash', displayName: 'Gemini 3 Flash', description: 'Fast and versatile.', inputTokenLimit: 1048576, supportedGenerationMethods: ['generateContent', 'countTokens'] },
    { name: 'models/gemini-2.5-pro', displayName: 'Gemini 2.5 Pro', inputTokenLimit: 1048576, supportedGenerationMethods: ['generateContent'] },
    { name: 'models/gemma-3-27b-it', displayName: 'Gemma 3 27B', inputTokenLimit: 131072, supportedGenerationMethods: ['generateContent'] },
    { name: 'models/gemini-embedding-001', displayName: 'Gemini Embedding', supportedGenerationMethods: ['embedContent'] },
    { name: 'models/imagen-4.0-generate-001', displayName: 'Imagen 4', supportedGenerationMethods: ['predict'] },
    { name: 'models/gemini-2.5-flash-preview-tts', displayName: 'Gemini 2.5 Flash TTS', supportedGenerationMethods: ['generateContent'] },
    { name: 'models/aqa', displayName: 'Attributed Question Answering', supportedGenerationMethods: ['generateAnswer'] },
  ],
  grok: [
    { id: 'grok-5', created: day('2026-02-17') }, { id: 'grok-4.1-fast', created: day('2025-11-19') }, { id: 'grok-4', created: day('2025-07-09') },
    { id: 'grok-2-image-1212', created: day('2024-12-12') }, { id: 'grok-imagine-video', created: day('2025-10-01') },
  ].map(m => ({ ...m, object: 'model', owned_by: 'xai' })),
  huggingface: [
    { id: 'openai/gpt-oss-120b', created: day('2025-08-05'), providers: ['cerebras', 'groq', 'novita', 'together', 'fireworks-ai'] },
    { id: 'Qwen/Qwen3-Coder-480B-A35B-Instruct', created: day('2025-07-22'), providers: ['together', 'novita'] },
    { id: 'meta-llama/Llama-3.3-70B-Instruct', created: day('2024-12-06'), providers: ['groq', 'sambanova'] },
    { id: 'deepseek-ai/DeepSeek-V3.2', created: day('2025-12-01'), providers: ['novita'] },
    { id: 'black-forest-labs/FLUX.1-dev', created: day('2024-08-01'), providers: ['fal-ai'], output: ['image'] },
    { id: 'BAAI/bge-m3', created: day('2024-01-30'), providers: ['hf-inference'], output: ['embeddings'] },
  ].map(({ providers, output = ['text'], ...m }) => ({ ...m, object: 'model', owned_by: m.id.split('/')[0], architecture: { input_modalities: ['text'], output_modalities: output }, providers: providers.map(provider => ({ provider, status: 'live', context_length: 131072 })) })),
  compatible: [
    { id: 'llama3.3:latest', created: day('2025-01-10') }, { id: 'qwen2.5-coder:32b', created: day('2025-02-02') },
    { id: 'gpt-oss:20b', created: day('2025-08-06') }, { id: 'nomic-embed-text:latest', created: day('2024-11-01') },
  ].map(m => ({ ...m, object: 'model', owned_by: 'library' })),
};
// What an account restricted to a few models sees (the "fake-limited" key).
const LIMITED = { openai: ['gpt-5.5', 'gpt-5.6-mini'], anthropic: ['claude-haiku-4-5'], gemini: ['models/gemini-2.5-pro'], grok: ['grok-4'], huggingface: ['meta-llama/Llama-3.3-70B-Instruct'], compatible: ['llama3.3:latest'] };
const PROVIDERS = Object.keys(CATALOG);
const idOf = (provider, m) => provider === 'gemini' ? m.name.replace(/^models\//, '') : m.id;

// ---- scripted meeting replies ----
const block = value => '\n\n```json\n' + JSON.stringify(value) + '\n```';
const lastMatch = (text, pattern) => [...text.matchAll(pattern)].at(-1);
export function scriptedReply(system, prompt, { provider, model }) {
  const who = `Scripted reply from the fake ${provider} server (${model})`;
  const task = (prompt.match(/OWNER TASK\n([\s\S]*?)\n\nMEMBERS/)?.[1] || 'the task').replace(/\s+/g, ' ').slice(0, 120);
  if (/Write your OPENING POSITION/.test(prompt)) {
    return `${who}.\n\nApproach to "${task}": state the goal, list the constraints, and propose the smallest result the owner can check.` + block({ assumptions: ['the owner wants a result they can check'], risk: 'answering a different question than the one asked', criteria: ['each claim is marked verified or not'], verification: 'unperformed' });
  }
  if (/RATIFICATION BALLOT/.test(prompt)) {
    const version = Number(lastMatch(prompt, /candidate v(\d+)/g)?.[1] || 1);
    return `${who}.\n\nCandidate v${version} says what the floor agreed and marks what was not verified. I approve.` + block({ vote: 'approve', objections: [], reason: 'it states what was agreed and no more', choice: '' });
  }
  if (/You are the drafter|You are the IMPLEMENTER/.test(prompt)) {
    const version = Number(lastMatch(prompt, /candidate v(\d+)/g)?.[1] || 1);
    return `# Answer (scripted, candidate v${version})\n\nThis text was written by the fake ${provider} server, not by a model. For "${task}": the members agreed to state the goal, the constraints, and the smallest checkable result. Nothing here was verified.` + block({ version, unresolved: [], verification: 'unperformed' });
  }
  const turn = prompt.match(/It is your turn, (.+?), cycle (\d+) of (\d+)\./);
  if (turn) {
    const owner = /The owner has just spoken/.test(prompt) ? ' The owner has spoken; I take that message as a constraint on the answer.' : '';
    return `${who}, speaking as ${turn[1]} in cycle ${turn[2]}.${owner}\n\nOn "propose the smallest result the owner can check": I agree, and have nothing to add.` + block({ stance: 'agree', concedes: [], objections: [], resolves: [], settle: '', needs: null, nominates: '', verification: 'unperformed' });
  }
  // Anything else, such as Overrule's connection test, gets the short answer it asks for.
  return /\bOK\b/.test(`${system} ${prompt}`) ? 'OK' : `${who}. There was no meeting step in this request to answer.`;
}

// ---- the server ----
function keyFrom(provider, headers) {
  if (provider === 'anthropic') return headers['x-api-key'] || '';
  if (provider === 'gemini' && headers['x-goog-api-key']) return headers['x-goog-api-key'];
  return (headers.authorization || '').replace(/^Bearer\s+/i, '');
}
const send = (res, status, value, headers = {}) => { res.writeHead(status, { 'Content-Type': 'application/json', ...headers }); res.end(JSON.stringify(value)); };
// Providers echo part of a bad key back in their error bodies; Overrule must never pass that on, so the fake does it too.
const rejection = (provider, key) => provider === 'anthropic' ? { type: 'error', error: { type: 'authentication_error', message: `invalid x-api-key: ${key}` } } : { error: { message: `Incorrect API key provided: ${key}`, type: 'invalid_request_error', code: 'invalid_api_key' } };

export async function startFakeProvider({ port = 0, host = '127.0.0.1', pageSize = 4, slowMs = 15_000, log = null } = {}) {
  const requests = [];
  const modes = {}; // provider -> mode, for tests that break a provider without a special key (compatible servers take none)
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://fake');
    const [, provider, ...rest] = url.pathname.split('/');
    const path = '/' + rest.join('/');
    const key = PROVIDERS.includes(provider) ? keyFrom(provider, req.headers) : '';
    const record = { method: req.method, provider, path, key: key.startsWith('fake-') ? key : key ? '[not a fake key]' : null, status: 0 };
    requests.push(record);
    res.on('close', () => { if (!res.writableFinished) record.hungUp = true; });
    const reply = (status, value, headers) => { record.status = status; log?.(`${req.method} ${url.pathname} ${status}`); send(res, status, value, headers); };
    if (!PROVIDERS.includes(provider)) return reply(404, { error: { message: `Unknown provider. Use one of /${PROVIDERS.join(', /')}.` } });
    const listing = req.method === 'GET' && /\/models$/.test(path);
    // The mode is the word after "fake-": fake-429 and fake-429-anything both answer 429, so a test can make every key unique.
    const mode = modes[provider] || (key.startsWith('fake-') ? key.slice(5).split('-')[0] : '');
    // Who may ask: a model list from Hugging Face or a compatible server needs no key; everything else does, and it must be a fake one.
    const keyless = provider === 'compatible' || (provider === 'huggingface' && listing);
    if ((key || !keyless) && !key.startsWith('fake-') && !modes[provider]) return reply(401, rejection(provider, key || '(none)'));
    if (provider === 'anthropic' && !req.headers['anthropic-version']) return reply(400, { type: 'error', error: { type: 'invalid_request_error', message: 'anthropic-version header is required' } });
    if (provider === 'gemini' && url.searchParams.has('key')) return reply(400, { error: { message: 'Send the key in the x-goog-api-key header in this fake, so tests notice a key in a URL.' } });
    if (/^(401|403|404|429|500|503)$/.test(mode)) return reply(Number(mode), provider === 'anthropic' ? { type: 'error', error: { type: 'api_error', message: `fake ${mode}; key was ${key}` } } : { error: { message: `fake ${mode}; key was ${key}` } });
    if (mode === 'slow') await new Promise(resolve => { const timer = setTimeout(resolve, slowMs); res.on('close', () => { clearTimeout(timer); resolve(); }); });
    // Never answers: the request is read and then nothing, until the caller gives up and closes the connection.
    if (mode === 'hang') { req.resume(); return new Promise(resolve => res.on('close', resolve)); }
    // Answers the headers and half a body, then goes silent: a reader has to give up on the body, not only on the headers.
    if (mode === 'stall') { record.status = 200; res.writeHead(200, { 'Content-Type': 'application/json' }); res.write(listing ? '{"object":"list","data":[{"id":"half' : '{"id":"resp_fake","output":[{"content":[{"type":"output_text","text":"hal'); return new Promise(resolve => res.on('close', resolve)); }
    if (res.destroyed) return;
    if (mode === 'redirect') return reply(302, { error: 'moved' }, { Location: `http://example.invalid${url.pathname}` });
    if (mode === 'garbage') { record.status = 200; res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end('<html>not json</html>'); }
    if (mode === 'huge' && listing) {
      record.status = 200; res.writeHead(200, { 'Content-Type': 'application/json' });
      res.write('{"object":"list","data":[');
      const filler = JSON.stringify({ id: 'x'.repeat(1000), object: 'model' });
      let closed = false; res.once('close', () => { closed = true; res.emit('drain'); });
      for (let i = 0; i < 9000 && !closed; i++) if (!res.write((i ? ',' : '') + filler)) await new Promise(resolve => res.once('drain', resolve));
      return res.end(']}');
    }
    if (listing && mode === 'shape') return reply(200, provider === 'gemini' && path === '/v1beta/models' ? { models: 'none today' } : { object: 'list', data: { message: 'not a list' } });
    let models = mode === 'empty' ? [] : mode === 'many' ? manyModels(provider) : CATALOG[provider];
    if (mode === 'nulls') models = [null, 7, 'text', {}, { id: null }, { id: ['x'] }, { name: 42 }, { id: 'bad\u0000id', name: 'models/bad\u0000id' }, ...models];
    if (mode === 'limited') models = models.filter(m => LIMITED[provider].includes(provider === 'gemini' ? m.name : m.id));
    if (listing) return reply(200, modelList(provider, path, models, url.searchParams, mode === 'many' ? 100 : pageSize));
    if (req.method !== 'POST') return reply(404, { error: { message: 'Not found.' } });
    let body;
    try { body = JSON.parse(await readBody(req)); } catch { return reply(400, { error: { message: 'Invalid JSON.' } }); }
    const chatPath = { openai: '/v1/responses', anthropic: '/v1/messages', gemini: '/v1beta/openai/chat/completions' }[provider] || '/v1/chat/completions';
    if (path !== chatPath) return reply(404, { error: { message: `This fake answers ${chatPath} for ${provider}.` } });
    const wanted = String(body.model || '');
    const listed = CATALOG[provider].map(m => idOf(provider, m));
    const bare = provider === 'huggingface' ? wanted.replace(/:[^/:]+$/, '') : provider === 'compatible' ? wanted.replace(/:latest$/, '') : wanted;
    if (!listed.some(id => id === bare || (provider === 'compatible' && id.replace(/:latest$/, '') === bare))) return reply(404, provider === 'anthropic' ? { type: 'error', error: { type: 'not_found_error', message: `model: ${wanted}` } } : { error: { message: `The model ${wanted} does not exist.`, type: 'invalid_request_error', code: 'model_not_found' } });
    if (mode === 'quota') return reply(429, { error: { message: `You exceeded your current quota; key ${key}.`, type: 'insufficient_quota', code: 'insufficient_quota' } });
    if (mode === 'limit') {
      // A reasoning model that spent its whole allowance thinking: accepted, answered, and wrote nothing.
      if (provider === 'openai') return reply(200, { id: 'resp_fake', object: 'response', status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [{ type: 'reasoning', summary: [] }], usage: { input_tokens: 20, output_tokens: body.max_output_tokens } });
      if (provider === 'anthropic') return reply(200, { id: 'msg_fake', type: 'message', role: 'assistant', content: [], stop_reason: 'max_tokens', usage: { input_tokens: 20, output_tokens: body.max_tokens } });
      return reply(200, { id: 'chatcmpl-fake', object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: null }, finish_reason: 'length' }], usage: { prompt_tokens: 20, completion_tokens: body.max_tokens } });
    }
    const [system, prompt] = provider === 'openai' ? [body.instructions || '', String(body.input || '')]
      : provider === 'anthropic' ? [body.system || '', (body.messages || []).map(m => typeof m.content === 'string' ? m.content : (m.content || []).map(c => c.text || '').join('')).join('\n')]
        : [(body.messages || []).filter(m => m.role === 'system').map(m => m.content).join('\n'), (body.messages || []).filter(m => m.role === 'user').map(m => m.content).join('\n')];
    const text = scriptedReply(system, prompt, { provider, model: wanted });
    const usage = { input: Math.ceil((system.length + prompt.length) / 4), output: Math.ceil(text.length / 4) };
    if (provider === 'openai') return reply(200, { id: 'resp_fake', object: 'response', status: 'completed', model: wanted, output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }], usage: { input_tokens: usage.input, output_tokens: usage.output } });
    if (provider === 'anthropic') return reply(200, { id: 'msg_fake', type: 'message', role: 'assistant', model: wanted, content: [{ type: 'text', text }], stop_reason: 'end_turn', usage: { input_tokens: usage.input, output_tokens: usage.output } });
    return reply(200, { id: 'chatcmpl-fake', object: 'chat.completion', model: wanted, choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }], usage: { prompt_tokens: usage.input, completion_tokens: usage.output } });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
  const address = server.address();
  return {
    url: `http://${address.family === 'IPv6' ? `[${address.address}]` : address.address}:${address.port}`, server, requests, modes,
    close: () => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }),
  };
}

// 500 models, one in ten not for conversation, dated a day apart, in the provider's own shape.
function manyModels(provider) {
  return Array.from({ length: 500 }, (_, i) => {
    const id = `${i % 10 === 9 ? 'embed' : 'model'}-${String(i).padStart(3, '0')}`, created = Math.floor(Date.parse('2024-01-01') / 1000) + i * 86400;
    if (provider === 'anthropic') return { type: 'model', id: `claude-${id}`, display_name: `Claude ${id}`, created_at: new Date(created * 1000).toISOString() };
    if (provider === 'gemini') return { name: `models/gemini-${id}`, displayName: `Gemini ${id}`, supportedGenerationMethods: [i % 10 === 9 ? 'embedContent' : 'generateContent'] };
    return { id: provider === 'huggingface' ? `org/${id}` : id, object: 'model', created, owned_by: 'fake' };
  });
}

function modelList(provider, path, models, params, pageSize) {
  if (provider === 'anthropic') {
    const limit = Math.min(Number(params.get('limit')) || 20, pageSize);
    const after = params.get('after_id');
    const start = after ? models.findIndex(m => m?.id === after) + 1 : 0;
    const page = models.slice(start, start + limit);
    return { data: page, has_more: start + limit < models.length, first_id: page[0]?.id || null, last_id: page.at(-1)?.id || null };
  }
  if (provider === 'gemini') {
    if (path !== '/v1beta/models') return { object: 'list', data: models.map(m => ({ id: m.name, object: 'model', owned_by: 'google' })) };
    const size = Math.min(Number(params.get('pageSize')) || 50, pageSize);
    const start = Number(params.get('pageToken') || 0);
    const page = models.slice(start, start + size);
    return { models: page, ...(start + size < models.length ? { nextPageToken: String(start + size) } : {}) };
  }
  return { object: 'list', data: models };
}

async function readBody(req) {
  let data = '';
  for await (const chunk of req) { data += chunk; if (data.length > 20_000_000) throw new Error('too large'); }
  return data;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const args = process.argv.slice(2), value = name => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
  if (args.includes('--help')) { console.log('node scripts/fake-provider.mjs [--port 4999] [--quiet]\nA local fake of every API provider. See the comment at the top of this file.'); process.exit(0); }
  const fake = await startFakeProvider({ port: Number(value('port') ?? 4999), log: args.includes('--quiet') ? null : line => console.log(line) });
  console.log(`Fake providers listening at ${fake.url}: ${PROVIDERS.map(p => `/${p}`).join(' ')}`);
  console.log(`Start Overrule against it:  OVERRULE_PROVIDER_OVERRIDE_URL=${fake.url} npm start`);
  console.log(`Use any key starting with "fake-". OpenAI-compatible base URL: ${fake.url}/compatible/v1`);
  const stop = () => fake.close().then(() => process.exit(0));
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
}
