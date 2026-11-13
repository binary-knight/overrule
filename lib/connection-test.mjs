// Testing a connection before it is saved: one short message through exactly the path a meeting uses, so a pass means a member
// seated on this connection can be reached, is accepted, and answers. The result is a short checklist saying which part failed.
import { TYPES, callProvider, apiBase, OVERRIDE_ENV } from './providers.mjs';
import { scrub } from './models.mjs';

// Small, so a test costs a few tokens. A reasoning model can spend all of it thinking and write nothing; that still proves the
// key and the model were accepted, so it counts as a pass and says so.
export const TEST_MAX_TOKENS = 256;
// How long a test waits for the answer. A server on this machine gets as long as a CLI: the first request after it starts can load
// a large model into memory, which takes well over the half minute a hosted API is given.
export const TEST_TIMEOUT_SECONDS = { api: 30, local: 120, cli: 120 };
export function testTimeoutSeconds(provider) {
  if (TYPES[provider.type]?.cli) return TEST_TIMEOUT_SECONDS.cli;
  if (provider.type === 'compatible') { try { if (['localhost', '127.0.0.1', '[::1]'].includes(new URL(provider.baseUrl).hostname)) return TEST_TIMEOUT_SECONDS.local; } catch {} }
  return TEST_TIMEOUT_SECONDS.api;
}
const SYSTEM = 'This is a connection test from Overrule, not a meeting. Answer with the single word OK and nothing else.';
const PROMPT = 'Reply with the word OK.';

const ok = text => ({ state: 'ok', text });
const fail = text => ({ state: 'fail', text });
const warn = text => ({ state: 'warn', text });
const clip = text => String(text || '').replace(/\s+/g, ' ').trim().slice(0, 120);

// provider: a validated connection, with the key it should use in `secret` (encrypted, never saved). keySource says where that key
// came from: typed, saved, environment, or none. cli: the CLI's sign-in status, for CLI types.
export async function testConnection(provider, { store, keySource = 'none', signal = new AbortController().signal, fetchImpl = fetch, call = callProvider, cli = null } = {}) {
  const type = provider.type, started = Date.now();
  const model = provider.model || 'The default model';
  const checks = [];
  const seconds = () => { const ms = Date.now() - started; return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`; };
  const done = (extra = {}) => ({ ok: checks.every(c => c.state !== 'fail'), checks, type, model: provider.model || '', target, keySource, ms: Date.now() - started, ...extra });
  let target;

  if (TYPES[type].cli) {
    const command = type === 'codex-cli' ? 'codex' : 'claude';
    target = `the ${command} CLI`;
    if (cli && !cli.installed) { checks.push(fail(`${command} is not installed on the server, or not on its PATH.`)); return done(); }
    if (cli?.signedIn === false) { checks.push(fail(`${command} is not signed in. Run ${command === 'codex' ? 'codex login' : 'claude auth login'} in a terminal on the server.`)); return done(); }
    checks.push(ok(cli?.signedIn ? `${command} is installed and signed in` : `${command} is installed; its sign-in could not be checked`));
  } else {
    try { target = new URL(apiBase(provider)).host; }
    catch (error) { checks.push(fail(error.message)); return done(); }
  }
  const keyName = { typed: 'the key given', saved: 'the saved key', environment: `the server’s ${TYPES[type].env}` }[keySource];

  try {
    const answer = await call(provider, { system: SYSTEM, prompt: PROMPT, maxTokens: TEST_MAX_TOKENS, timeoutSeconds: testTimeoutSeconds(provider), signal }, store, fetchImpl);
    if (!TYPES[type].cli) checks.push(ok(`Reached ${target}`), keyName ? ok(`${capital(keyName)} was accepted`) : ok('No key was needed'));
    checks.push(ok(`${model} answered in ${seconds()}: “${clip(answer.text)}”`));
    return done({ reply: clip(answer.text), usage: answer.usage || null });
  } catch (error) {
    if (error.code === 'cancelled') { checks.push(fail('The test was cancelled.')); return done({ cancelled: true }); }
    // Whatever the failure says is shown; the key it was made with is taken out first, wherever the words came from.
    const key = (() => { try { return store?.decrypt(provider.secret) || (process.env[TYPES[type].env] || '').trim(); } catch { return ''; } })();
    if (key && String(error.message).includes(key)) error = Object.assign(new Error(scrub(error.message, key)), { code: error.code, status: error.status, providerCode: error.providerCode });
    classify(error, { type, model: provider.model || 'the default model', Model: provider.model || 'The default model', target, keyName, checks, seconds, local: testTimeoutSeconds(provider) === TEST_TIMEOUT_SECONDS.local && type === 'compatible' });
    return done();
  }
}

const capital = text => text.charAt(0).toUpperCase() + text.slice(1);

// model is the ID exactly as given, never re-cased; Model is the same at the start of a sentence, which only changes the default's wording.
function classify(error, { type, model, Model, target, keyName, checks, seconds, local }) {
  const code = error.providerCode ? `, ${error.providerCode}` : '';
  const reached = ok(`Reached ${target}`);
  const accepted = keyName ? ok(`${capital(keyName)} was accepted`) : ok('No key was needed');
  switch (error.code) {
    case 'no-key': checks.push(fail(`There is no key to test with. Give one${TYPES[type].env ? `, or set ${TYPES[type].env} on the server` : ''}.`)); return;
    case 'unreachable': case 'redirect': checks.push(fail(error.message)); return;
    case 'timeout': checks.push(fail(`No answer from ${target} within ${error.message.match(/\d+/)?.[0] || 'the allowed'} seconds.${local ? ' A local server can take a while to load a model the first time; try again once it has.' : TYPES[type].cli ? '' : ' The provider may be busy, or something between here and it is holding the connection.'}`)); return;
    case 'key-format': checks.push(fail(`${error.message} Paste it again.`)); return;
    case 'output-limit': checks.push(reached, accepted, ok(`${Model} answered in ${seconds()}, but spent the test’s ${TEST_MAX_TOKENS}-token allowance before writing text. That proves the connection; meetings allow far more.`)); return;
    case 'no-text': checks.push(reached, accepted, warn(`${Model} answered in ${seconds()} with no text. A meeting turn needs text, so check that this model writes chat replies.`)); return;
    case 'format': checks.push(reached, fail(`${target} answered in a format this connection type does not read${type === 'compatible' ? '. Check that the base URL points at an OpenAI-compatible API, usually ending in /v1' : ''}.`)); return;
    case 'http': break;
    default: {
      // A CLI says why in its own words, which cliFailure has already trimmed; so does an invalid override.
      if (/not installed|not on PATH/.test(error.message)) { checks.push(fail(`${error.message.replace(/\.$/, '')}. Install it on the server, then sign in.`)); return; }
      checks.push(fail(error.message.includes(OVERRIDE_ENV) ? error.message : TYPES[type].cli ? `${Model} did not answer: ${error.message}` : error.message));
      return;
    }
  }
  const status = error.status;
  if (status === 401) { checks.push(reached, fail(keyName ? `${target} rejected ${keyName} (HTTP 401${code}). Check that it is the right key for this provider and has not been revoked.` : `${target} wants a key (HTTP 401${code}).`)); return; }
  if (status === 403) { checks.push(reached, fail(`${target} refused ${keyName || 'the request'} for ${model} (HTTP 403${code}). The key may not have access to this model or to this API.`)); return; }
  if (status === 404) { checks.push(reached, accepted, fail(`${target} does not know the model ${model} (HTTP 404${code})${type === 'compatible' ? ', or the base URL is not an OpenAI-compatible API' : ''}. Pick one from the list.`)); return; }
  if (status === 400 || status === 422) { checks.push(reached, accepted, fail(`${target} refused the request for ${model} (HTTP ${status}${code}). The model ID may be wrong, or the model may not take chat requests.`)); return; }
  if (status === 402 || (status === 429 && /quota|billing|credit|payment/i.test(error.providerCode || ''))) { checks.push(reached, accepted, fail(`The key has no credit or quota left (HTTP ${status}${code}). Check billing with the provider.`)); return; }
  if (status === 429) { checks.push(reached, accepted, fail(`${target} is rate limiting this key (HTTP 429${code}). The key works; try again shortly.`)); return; }
  if (status >= 500) { checks.push(reached, fail(`${target} had an error of its own (HTTP ${status}${code}). Try again later.`)); return; }
  checks.push(reached, fail(`${target} returned HTTP ${status}${code}.`));
}
