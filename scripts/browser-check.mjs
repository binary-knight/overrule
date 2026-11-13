import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../server.mjs';
import { git } from '../lib/workspace.mjs';
import { startFakeProvider } from './fake-provider.mjs';
import { OVERRIDE_ENV } from '../lib/providers.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = fileURLToPath(new URL('..', import.meta.url));
const directory = await mkdtemp(join(tmpdir(), 'mesh-browser-'));
const project = await mkdtemp(join(tmpdir(), 'mesh-browser-project-with-a-deliberately-long-name-'));
const block = value => '\n```json\n' + JSON.stringify(value) + '\n```';
let checks = 0, drafts = 0;
// Model lists give up after three seconds here rather than ten, so the waiting and unreachable states are quick to reach.
const { server, access, mesh } = createApp({ directory, catalogOptions: { timeoutMs: 3000 }, detect: async () => ({ codex: { installed: true, signedIn: true }, claude: { installed: true, signedIn: true } }),
  canary: async () => ({ ok: true }), measure: async () => ({ available: false }),
  providerCall: async (provider, request) => {
    if (/You are the IMPLEMENTER/.test(request.prompt)) {
      drafts++; await writeFile(join(request.cwd, 'result.txt'), 'reviewed');
      return { text: 'Implemented.' + block({ version: 1, unresolved: [] }) };
    }
    if (/RATIFICATION BALLOT/.test(request.prompt)) return { text: 'Reviewed.' + block(/BROWSER-OBJECT/.test(request.prompt) ? { vote: 'object', objections: [{ claim: 'Unsafe <img src=x onerror=alert(1)>', condition: 'Resolve the review finding' }], reason: 'Review finding remains' } : { vote: 'approve', objections: [], reason: 'Reviewed' }) };
    return { text: 'Agreed.' + block({ stance: 'agree', assumptions: [], risk: 'Unverified', criteria: ['correct'] }) };
  },
  checkRunner: async (commands, cwd, { signal }) => {
    if (++checks === 1) await delay(60_000, null, { signal });
    return commands.map(command => ({ command, code: 0, output: 'passed', seconds: 0 }));
  },
});
let browser;
// Model suggestions come from a fake provider on this machine, through the same override a developer would use.
const fake = await startFakeProvider();
process.env[OVERRIDE_ENV] = fake.url;
try {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '0.0.0.0', resolve); });
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  const base = `http://127.0.0.1:${server.address().port}`;
  await page.goto(base); await page.waitForSelector('.participant');
  assert.equal(await page.locator('.participant').count(), 2);
  assert.equal(await page.locator('#call-estimate').textContent(), 'About 8 calls; up to 14 with revisions and re-asks. Limits: 14 calls / 60 min');
  await page.selectOption('#revisions', '5');
  assert.match(await page.locator('#call-estimate').textContent(), /up to 22/);
  await page.fill('#max-calls', '30'); await page.fill('#duration', '90');
  await page.reload(); await page.waitForSelector('.participant');
  assert.equal(await page.inputValue('#revisions'), '5');
  assert.equal(await page.inputValue('#max-calls'), '30');
  assert.equal(await page.inputValue('#duration'), '90');
  await page.selectOption('#revisions', '1'); await page.fill('#max-calls', ''); await page.fill('#duration', '60');
  await mkdir(join(root, 'artifacts'), { recursive: true });
  await page.screenshot({ path: join(root, 'artifacts', 'desktop.png'), fullPage: true });
  await page.click('#start'); assert.match(await page.locator('#toast').textContent(), /Describe/);
  await page.click('#connections-nav'); await page.click('#add-connection');
  await page.selectOption('#provider-type', 'compatible');
  await page.fill('#provider-name', 'Test <img src=x onerror=alert(1)>');
  await page.fill('#provider-model', 'test-model'); await page.fill('#provider-url', 'http://localhost:11434/v1');
  await page.fill('#provider-key', 'browser-test-key'); await page.fill('#provider-role', 'Test reviewer');
  await page.click('#provider-form button[type=submit]'); await page.waitForSelector('#provider-dialog', { state: 'hidden' });
  assert.equal(await page.locator('.connection-card').count(), 3);
  assert.equal(await page.locator('.connection-card img').count(), 0);
  const connection = await page.locator('.connection-card').last(); await connection.locator('[data-edit]').click();
  assert.equal(await page.inputValue('#provider-key'), ''); await page.click('#delete-connection');
  await page.waitForSelector('#provider-dialog', { state: 'hidden' });
  // Model suggestions: the key field shows for the default type, the list arrives once a key is typed, an unlisted ID is a warning
  // while typing and after saving, and a typed key is cleared when the type changes so it never reaches another provider.
  const modelStatus = pattern => page.waitForFunction(source => new RegExp(source).test(document.querySelector('#model-status').textContent), pattern.source);
  assert.match(await page.locator('#provider-override').textContent(), new RegExp(`${OVERRIDE_ENV} is set`));
  await page.click('#add-connection');
  assert.equal(await page.inputValue('#provider-type'), 'openai'); assert.ok(await page.isVisible('#provider-key'));
  await modelStatus(/Paste a key above/);
  await page.fill('#provider-key', 'fake-key'); await modelStatus(/^7 models from OpenAI API with the key above/);
  assert.equal(await page.locator('#model-options option').count(), 7);
  assert.equal(await page.locator('#model-options option').first().getAttribute('value'), 'gpt-6-astra');
  await page.fill('#provider-name', 'Astra'); await page.fill('#provider-model', 'gpt-6-astr');
  assert.match(await page.locator('#model-warning').textContent(), /gpt-6-astr is not in the list OpenAI API returned/);
  await page.fill('#provider-model', 'gpt-6-astra'); assert.ok(await page.isHidden('#model-warning'));
  await page.fill('#provider-model', 'text-embedding-3-large'); assert.match(await page.locator('#model-warning').textContent(), /embedding or ranking model/);
  await page.selectOption('#provider-type', 'anthropic');
  assert.equal(await page.inputValue('#provider-key'), ''); assert.ok(await page.isVisible('#provider-key'));
  await page.selectOption('#provider-type', 'claude-cli'); await modelStatus(/^4 Claude Code aliases/);
  assert.deepEqual(await page.locator('#model-options option').evaluateAll(options => options.map(o => o.value)), ['fable', 'opus', 'sonnet', 'haiku']);
  await page.selectOption('#provider-type', 'openai'); await page.fill('#provider-key', 'fake-key'); await modelStatus(/^7 models/);
  // Test connection: the unsaved form is tried through the meeting path; the result goes as soon as the form changes.
  const testResult = async () => { await page.waitForFunction(() => !/Sending/.test(document.querySelector('#test-result').textContent)); return page.locator('#test-result').textContent(); };
  await page.fill('#provider-model', 'gpt-6-astra'); await page.click('#test-connection');
  assert.match(await testResult(), /^The connection works\.✓Reached [^✓]+✓The key given was accepted✓gpt-6-astra answered in \d+ ms: “OK”$/);
  await page.fill('#provider-model', 'gpt-6-astr'); assert.ok(await page.isHidden('#test-result'));
  await page.click('#test-connection');
  assert.match(await testResult(), /^The connection did not work\..*does not know the model gpt-6-astr \(HTTP 404, model_not_found\)/);
  assert.equal(await page.locator('#test-connection').textContent(), 'Test again');
  await page.screenshot({ path: join(root, 'artifacts', 'connection-test.png') });
  // Failure handling in the form. A provider that never answers: the wait counts up and says when it gives up, then says the
  // provider cannot be reached. A test against it can be cancelled. A list already fetched is kept, marked, when the provider fails.
  const modelState = value => page.waitForFunction(v => document.querySelector('#model-status').dataset.state === v, value, { timeout: 15000 });
  const canary = `fake-hang-browsercanary${Date.now()}`;
  const bodies = [];
  page.on('response', response => { if (response.url().includes('/api/')) bodies.push(response.text().catch(() => '')); });
  await page.fill('#provider-key', canary);
  await modelStatus(/^Listing models… 2 s \(gives up after 3 s\)$/);
  await modelState('unreachable');
  assert.match(await page.locator('#model-status').textContent(), /^⚠ Can’t reach OpenAI API: The provider did not answer within 3 seconds\. The provider may be busy.*You can still type the model ID\.$/);
  await page.click('#test-connection');
  await page.waitForFunction(() => /Sending one short message to gpt-6-astr… [2-9] s \(gives up after 30 s\)/.test(document.querySelector('#test-result').textContent));
  assert.equal(await page.locator('#test-connection').textContent(), 'Cancel test');
  await page.click('#test-connection');
  assert.match(await page.locator('#test-result').textContent(), /^Test cancelled\.✗Cancelled before an answer came back\. Nothing was saved\.$/);
  await page.screenshot({ path: join(root, 'artifacts', 'connection-unreachable.png') });
  await page.fill('#provider-key', 'fake-key'); await modelStatus(/^7 models/);
  fake.modes.openai = 'hang';
  await page.click('#model-refresh'); await modelState('unreachable');
  assert.match(await page.locator('#model-status').textContent(), /^⚠ Showing the 7 models OpenAI API listed just now with the key above\. It can’t be reached now: The provider did not answer within 3 seconds\./);
  assert.equal(await page.locator('#model-options option').count(), 7, 'the old list is still offered');
  delete fake.modes.openai;
  // A local server that is not running says so, with what to check.
  await page.selectOption('#provider-type', 'compatible'); await page.fill('#provider-url', 'http://127.0.0.1:9/v1'); await page.press('#provider-url', 'Tab');
  await modelState('unreachable');
  assert.match(await page.locator('#model-status').textContent(), /^⚠ Can’t reach this server: Could not reach 127\.0\.0\.1:9\. Check that the server is running at http:\/\/127\.0\.0\.1:9\/v1 \(for Ollama, ollama serve\), then try again\./);
  // The typed key never came back in any answer, and nothing in the browser kept it.
  assert.ok(!(await Promise.all(bodies)).some(text => text.includes('browsercanary')), 'a typed key came back from the server');
  assert.ok(!(await page.evaluate(() => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }))).includes('browsercanary'));
  await page.selectOption('#provider-type', 'openai');
  await page.fill('#provider-key', 'fake-key'); await modelStatus(/^7 models/); await page.fill('#provider-model', 'gpt-6-astr');
  await page.click('#provider-form button[type=submit]'); await page.waitForSelector('#provider-dialog', { state: 'hidden' });
  assert.match(await page.locator('#toast').textContent(), /^Connection saved\. Warning: gpt-6-astr is not among the 7 models OpenAI API listed/);
  await page.locator('.connection-card', { hasText: 'Astra' }).locator('[data-edit]').click();
  await modelStatus(/with the saved key/); await page.click('#model-refresh'); await modelStatus(/listed just now/);
  await page.click('#delete-connection'); await page.waitForSelector('#provider-dialog', { state: 'hidden' });
  // Saved councils and the seat limit. Seven local connections join the two defaults, so eight can be seated and a ninth refused.
  {
    const token = (await (await page.request.get(base + '/api/bootstrap')).json()).token;
    const extra = [];
    for (let i = 1; i <= 7; i++) extra.push((await (await page.request.post(base + '/api/providers', { headers: { 'X-Mesh-Token': token }, data: { type: 'compatible', name: `Local ${i}`, model: 'm', baseUrl: 'http://127.0.0.1:9/v1' } })).json()).id);
    await page.reload(); await page.click('#workspace-nav'); await page.waitForSelector('.participant');
    const seat = id => page.click(`#participants input[value="${id}"]`);
    const seated = () => page.$$eval('#participants input:checked', inputs => inputs.map(i => i.value));
    for (const id of extra.slice(0, 6)) await seat(id);
    assert.equal((await seated()).length, 8, 'eight seats, as the server and the command line allow');
    await seat(extra[6]);
    assert.equal((await seated()).length, 8); assert.equal(await page.locator('#toast').textContent(), 'A meeting seats up to 8 members.');
    assert.match(await page.locator('.seats-hint').textContent(), /unchecked stays saved under Connections/);
    // Save the eight as "Wide", keeping everything but the limits.
    await page.selectOption('#rounds', '3');
    await page.click('#council-save'); await page.fill('#council-name', 'Wide'); await page.fill('#council-purpose', 'Everyone at once');
    await page.uncheck('#council-groups input[data-group="limits"]');
    await page.click('#council-submit'); await page.waitForSelector('#council-dialog', { state: 'hidden' });
    assert.match(await page.locator('#toast').textContent(), /^Saved the council “Wide”: Codex, Claude Code, Local 1, .* · Codex drafts · 3 cycles · 1 revision · no research\.$/);
    assert.equal(await page.locator('#council-select option:checked').textContent(), 'Wide');
    // Seat two, then pick Wide again: its seats and kept settings come back.
    for (const id of extra.slice(0, 6)) await seat(id);
    await page.selectOption('#rounds', '1');
    assert.match(await page.locator('#council-note').textContent(), /Changed since you picked it: seats, meeting length\./);
    await page.selectOption('#council-select', ''); await page.selectOption('#council-select', { label: 'Wide' });
    assert.equal((await seated()).length, 8); assert.equal(await page.inputValue('#rounds'), '3');
    assert.match(await page.locator('#council-note').textContent(), /^Everyone at onceKeeps: Codex, Claude Code, Local 1/);
    assert.doesNotMatch(await page.locator('#council-note').textContent(), /Changed/);
    // Deleting a seated connection takes it out of the council, and the owner is told.
    await page.click('#connections-nav'); await page.locator('.connection-card', { hasText: 'Local 1' }).locator('[data-edit]').click();
    await page.click('#delete-connection'); await page.waitForSelector('#provider-dialog', { state: 'hidden' });
    assert.equal(await page.locator('#toast').textContent(), 'Connection removed. It also left Wide (7 seats left).');
    await page.click('#workspace-nav');
    assert.match(await page.locator('#council-note').textContent(), /Keeps: Codex, Claude Code, Local 2,/);
    // Delete the council: the seats it chose stay chosen, and its connections stay saved.
    await page.click('#council-delete'); await page.click('#confirm-ok');
    await page.waitForFunction(() => document.querySelectorAll('#council-select option').length === 1);
    assert.equal((await seated()).length, 7);
    for (const id of extra.slice(1)) await page.request.delete(`${base}/api/providers/${id}`, { headers: { 'X-Mesh-Token': token } });
    await page.reload(); await page.waitForSelector('.participant');
    await page.selectOption('#rounds', '2');
  }
  await page.click('#workspace-nav'); await page.click('#demo');
  await page.waitForFunction(() => document.querySelector('#run-title').textContent === 'Approved');
  assert.equal(await page.locator('.msg').count(), 8);
  await page.click('[data-tab=answer]'); assert.match(await page.locator('#answer').textContent(), /scripted demonstration/);
  assert.ok(await page.locator('#result-evidence').isVisible());
  assert.match(await page.locator('#floor-outcome').textContent(), /consensus/);
  assert.match(await page.locator('#result-evidence').textContent(), /No independent automated checks/);
  await page.locator('#result-evidence a', { hasText: 'Source e' }).first().click();
  assert.ok(await page.locator('#transcript .linked-entry').isVisible());
  await page.click('[data-tab=answer]');
  const exportHref = await page.locator('#export').getAttribute('href');
  const transcript = await (await page.request.get(base + exportHref)).text(); assert.match(transcript, /Demo reviewer/);
  assert.match(transcript, /Final verdict: Approved/); assert.match(transcript, /\(#entry-e\d+\)/);
  await page.screenshot({ path: join(root, 'artifacts', 'discussion.png'), fullPage: true });
  await page.reload(); await page.waitForSelector('.history-item'); await page.locator('.history-item').first().click();
  await page.waitForFunction(() => document.querySelector('#run-title').textContent === 'Approved');
  await page.click('#new-discussion'); await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: join(root, 'artifacts', 'mobile.png'), fullPage: true });
  // The agentsec install help holds shell commands that cannot wrap, and it only shows on machines without agentsec-pack; show it
  // regardless, so the narrowest layouts are always checked with their widest content, on phone and tablet widths and every page.
  await page.evaluate(() => { for (const id of ['agentsec-help', 'security-off']) document.getElementById(id).classList.remove('hidden'); });
  const overflowing = async () => page.evaluate(() => document.documentElement.scrollWidth > innerWidth ? `${document.documentElement.scrollWidth}px in ${innerWidth}px` : '');
  for (const width of [390, 768]) {
    await page.setViewportSize({ width, height: 900 });
    for (const nav of ['workspace', 'security', 'archive', 'connections']) {
      await page.evaluate(id => document.getElementById(`${id}-nav`).click(), nav);
      assert.equal(await overflowing(), '', `${nav} page overflows at ${width}px`);
    }
    await page.evaluate(() => document.getElementById('new-discussion').click());
    assert.equal(await overflowing(), '', `the new meeting form overflows at ${width}px`);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Mobile has horizontal overflow');
  await page.click('#demo'); await page.waitForSelector('#cancel:not(.hidden)'); await page.click('#cancel');
  await page.waitForFunction(() => document.querySelector('#run-title').textContent === 'Meeting cancelled.');
  if (!access.addresses.length) throw new Error('A LAN interface is required for the LAN browser check.');
  const lanContext = await browser.newContext();
  const lan = await lanContext.newPage();
  await lan.goto(`http://${access.addresses[0]}:${server.address().port}`);
  await lan.waitForSelector('#pair-code');
  await lan.screenshot({ path: join(root, 'artifacts', 'lan-pairing.png'), fullPage: true });
  assert.equal((await lan.request.get(`http://${access.addresses[0]}:${server.address().port}/api/bootstrap`)).status(), 401);
  await lan.fill('#pair-code', 'wrong'); await lan.click('#pair-form button');
  await lan.waitForFunction(() => document.querySelector('#pair-error').textContent.includes('incorrect'));
  await lan.fill('#pair-code', access.code); await lan.click('#pair-form button');
  await lan.waitForSelector('.participant');
  assert.equal(await lan.locator('#session-label').textContent(), 'Paired LAN session');
  assert.ok(await lan.locator('#lan-button').isHidden());
  await lanContext.close();
  // A workspace check can be stopped and retried from the browser without another draft.
  await git(project, ['init', '-q', '-b', 'main']); await writeFile(join(project, 'README.md'), 'base'); await git(project, ['add', '-A']);
  await git(project, ['-c', 'user.name=Test', '-c', 'user.email=test@localhost', 'commit', '-q', '-m', 'base']);
  const boot = await (await page.request.get(base + '/api/bootstrap')).json();
  const created = await page.request.post(base + '/api/runs', { headers: { 'X-Mesh-Token': boot.token }, data: { prompt: 'Browser recovery fixture', participantIds: boot.providers.map(p => p.id), drafterId: boot.providers[0].id, cycles: 1, workspace: { path: project, level: 'workspace-write', checks: ['verify'] } } });
  assert.equal(created.status(), 201, await created.text());
  await page.setViewportSize({ width: 1440, height: 1100 }); await page.reload();
  await page.waitForSelector('.history-item'); await page.locator('.history-item').first().click();
  await page.waitForFunction(() => document.querySelector('#run-title').textContent === 'Checking the candidate before voting.');
  assert.match(await page.locator('.progress-step.current').textContent(), /Checks/);
  assert.match(await page.locator('.candidate').textContent(), /Checks are running/);
  assert.doesNotMatch(await page.locator('.candidate').textContent(), /No checks configured/);
  await page.click('#cancel'); await page.waitForFunction(() => document.querySelector('#run-title').textContent === 'Meeting cancelled.');
  assert.equal(await page.locator('#resume').textContent(), 'Retry candidate checks'); assert.ok(await page.locator('#apply').isHidden());
  await page.click('#resume'); await page.waitForFunction(() => document.querySelector('#run-title').textContent === 'Approved');
  assert.equal(checks, 2); assert.equal(drafts, 1); assert.ok(await page.locator('#apply').isVisible());
  assert.match(await page.locator('#result-evidence').textContent(), /All configured checks passed on the recorded commit/);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: join(root, 'artifacts', 'workspace-mobile.png'), fullPage: true });
  const overflow = await page.evaluate(() => [...document.querySelectorAll('body *')].filter(e => e.getBoundingClientRect().right > innerWidth + 1).map(e => ({ tag: e.tagName, id: e.id, className: e.className, width: e.getBoundingClientRect().width })).slice(0, 12));
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `Workspace meeting has mobile overflow: ${JSON.stringify(overflow)}`);
  // A limit stops before the ballot, then explicit higher totals reuse the finished draft.
  await page.setViewportSize({ width: 1440, height: 1100 });
  const limitedResponse = await page.request.post(base + '/api/runs', { headers: { 'X-Mesh-Token': boot.token }, data: { prompt: 'Browser limit fixture', participantIds: boot.providers.map(p => p.id), drafterId: boot.providers[0].id, cycles: 1, revisions: 0, maxCalls: 5 } });
  assert.equal(limitedResponse.status(), 201, await limitedResponse.text());
  const limitedId = (await limitedResponse.json()).id;
  await page.reload(); await page.waitForSelector('.history-item'); await page.locator('.history-item').first().click();
  await page.waitForFunction(() => document.querySelector('#run-title').textContent === 'Session limit reached.');
  assert.match(await page.locator('#usage').textContent(), /5 \/ 5 calls/);
  assert.match(await page.locator('#result-evidence').textContent(), /Verification incomplete/);
  assert.ok(await page.locator('#limit-form').isVisible());
  await page.fill('#resume-max-calls', '6'); await page.click('#limit-form button[type=submit]');
  await page.waitForFunction(() => document.querySelector('#run-title').textContent === 'Approved');
  assert.match(await page.locator('#usage').textContent(), /6 \/ 6 calls/);
  assert.equal(mesh.runs.find(r => r.id === limitedId).entries.filter(e => e.phase === 'draft').length, 1);
  // An interrupted run whose recovered time is exhausted must offer editable limits too.
  const recovered = mesh.runs.find(r => r.id === limitedId);
  recovered.status = 'interrupted'; recovered.budget.elapsedMs = recovered.budget.maxDurationSeconds * 1000;
  recovered.final = ''; mesh.publish(recovered);
  await page.reload(); await page.waitForSelector('.history-item'); await page.locator('.history-item').first().click();
  await page.waitForFunction(() => document.querySelector('#run-title').textContent === 'Meeting interrupted.');
  assert.ok(await page.locator('#limit-form').isVisible()); assert.ok(await page.locator('#resume').isHidden());
  await page.fill('#resume-duration', '90'); await page.click('#limit-form button[type=submit]');
  await page.waitForFunction(() => document.querySelector('#run-title').textContent === 'Approved');
  assert.match(await page.locator('#usage').textContent(), /6 \/ 6 calls/);
  // Floor consensus cannot hide a final objection; quotes in the evidence panel are escaped.
  const objectedResponse = await page.request.post(base + '/api/runs', { headers: { 'X-Mesh-Token': boot.token }, data: { prompt: 'BROWSER-OBJECT', participantIds: boot.providers.map(p => p.id), drafterId: boot.providers[0].id, cycles: 1, revisions: 0 } });
  assert.equal(objectedResponse.status(), 201, await objectedResponse.text());
  await page.reload(); await page.waitForSelector('.history-item'); await page.locator('.history-item').first().click();
  await page.waitForFunction(() => document.querySelector('#run-title').textContent === 'Objections remain');
  assert.match(await page.locator('#floor-outcome').textContent(), /consensus/);
  assert.match(await page.locator('#result-evidence').textContent(), /Unsafe <img src=x onerror=alert\(1\)>/);
  assert.equal(await page.locator('#result-evidence img').count(), 0);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: join(root, 'artifacts', 'evidence-mobile.png'), fullPage: true });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Evidence panel has mobile overflow');
  // Deleting asks first; keeping changes nothing, confirming removes the shown meeting and returns to the composer.
  await page.setViewportSize({ width: 1440, height: 1100 });
  const objectedId = (await objectedResponse.json()).id;
  // Renaming changes how the meeting is listed and survives a reload; the brief stays as the council read it.
  await page.click('#rename-run'); await page.waitForFunction(() => document.querySelector('#rename-dialog').open);
  await page.fill('#rename-input', 'Objection fixture'); await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelector('#run-name-text').textContent === 'Objection fixture');
  await page.reload(); await page.waitForSelector(`[data-run="${objectedId}"]`);
  assert.equal(await page.locator(`[data-run="${objectedId}"] .history-title`).textContent(), 'Objection fixture');
  await page.locator(`[data-run="${objectedId}"]`).click(); await page.waitForFunction(() => document.querySelector('#run-title').textContent === 'Objections remain');
  assert.equal(await page.locator('#run-prompt').textContent(), 'BROWSER-OBJECT');
  // Search narrows the list as you type and marks what matched; Escape clears it.
  await page.fill('#history-search', 'browser-object');
  await page.waitForFunction(id => document.querySelectorAll('#history [data-run]').length === 1 && document.querySelector(`#history [data-run="${id}"]`), objectedId);
  assert.match(await page.locator('#history-summary').textContent(), /^1 of \d+ meetings match/);
  await page.locator('#history-search').press('Escape');
  await page.waitForFunction(() => document.querySelector('#history-summary').classList.contains('hidden') && document.querySelectorAll('#history [data-run]').length > 1);
  // Archiving hides it from the list and keeps it under Archive, where it can be opened and unarchived.
  await page.click('#archive-run'); await page.waitForFunction(id => !document.querySelector(`#history [data-run="${id}"]`) && !document.querySelector('#run-archived').classList.contains('hidden'), objectedId);
  await page.click('#archive-nav'); await page.waitForSelector(`[data-open-run="${objectedId}"]`);
  assert.equal(await page.locator('#archive-count').textContent(), '1');
  await page.click(`[data-unarchive-run="${objectedId}"]`); await page.waitForFunction(id => document.querySelector(`#history [data-run="${id}"]`), objectedId);
  await page.click(`[data-run="${objectedId}"]`); await page.waitForFunction(() => document.querySelector('#run-title').textContent === 'Objections remain' && document.querySelector('#run-archived').classList.contains('hidden'));
  // Settings: as many meetings as the disk safely holds, saved on the host, then back to the default. The dialog shows the room.
  await page.click('#settings-button'); await page.waitForFunction(() => document.querySelector('#settings-dialog').open);
  assert.match(await page.locator('#settings-storage').textContent(), /Meetings take .* on the host/);
  await page.check('input[name=history-keep][value=max]'); await page.click('#settings-save');
  await page.waitForFunction(() => !document.querySelector('#settings-dialog').open);
  assert.equal((await (await page.request.get(base + '/api/settings')).json()).historyLimit, 'max');
  await page.click('#settings-button'); await page.waitForFunction(() => document.querySelector('#settings-dialog').open);
  await page.fill('#history-limit', '30'); await page.click('#settings-save'); await page.waitForFunction(() => !document.querySelector('#settings-dialog').open);
  assert.equal((await (await page.request.get(base + '/api/settings')).json()).historyLimit, 30);
  // Pinning puts the meeting under Pinned with its project, survives a reload, and blocks deletion until it is unpinned.
  await page.click('#pin-run'); await page.waitForFunction(() => document.querySelector('#pin-dialog').open);
  await page.fill('#pin-project', 'Browser check'); await page.fill('#pin-tags', 'smoke, objection'); await page.click('#pin-save');
  await page.waitForFunction(() => /Project: Browser check/.test(document.querySelector('#run-pin').textContent));
  await page.reload(); await page.waitForSelector('.history-group-name');
  assert.equal(await page.locator('.history-group-name').textContent(), 'Browser check');
  assert.deepEqual(await page.locator(`.history-group [data-run="${objectedId}"] .tag`).allTextContents(), ['smoke', 'objection']);
  await page.locator(`[data-run="${objectedId}"]`).click(); await page.waitForFunction(() => document.querySelector('#run-title').textContent === 'Objections remain');
  await page.click('#delete-run'); await page.waitForFunction(() => /pinned\. Unpin it first/.test(document.querySelector('#toast').textContent));
  await page.click('#pin-run'); await page.waitForFunction(() => document.querySelector('#pin-dialog').open); await page.click('#pin-unpin');
  await page.waitForFunction(() => document.querySelector('#confirm-dialog').open); await page.click('#confirm-ok');
  await page.waitForFunction(() => document.querySelector('#run-pin').classList.contains('hidden') && !document.querySelector('.history-group'));
  await page.click('#delete-run'); await page.waitForFunction(() => document.querySelector('#delete-dialog').open);
  assert.match(await page.locator('#delete-items').textContent(), /The meeting record/);
  await page.click('#delete-cancel'); assert.equal((await page.request.get(`${base}/api/runs/${objectedId}`)).status(), 200);
  await page.click('#delete-run'); await page.waitForFunction(() => document.querySelector('#delete-dialog').open); await page.click('#delete-confirm');
  await page.waitForFunction(() => document.querySelector('#discussion').classList.contains('hidden'));
  assert.equal(await page.locator(`[data-run="${objectedId}"]`).count(), 0);
  assert.equal((await page.request.get(`${base}/api/runs/${objectedId}`)).status(), 404);
  assert.deepEqual(errors, []);
  console.log('Browser checks passed: desktop, mobile, connections, model suggestions, connection tests, saved councils, the eight-seat limit, escaped content, demo, history, export, citation links, verdicts, limit settings and resume, cancellation, search, archive, settings, renaming, pinning, deletion, LAN pairing, and workspace verification retry. No live model calls.');
} finally {
  for (const run of mesh.runs) mesh.cancel(run.id);
  for (let i = 0; i < 1000 && mesh.controllers.size; i++) await delay(10);
  await browser?.close();
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  await rm(directory, { recursive: true, force: true });
  await rm(project, { recursive: true, force: true });
  await fake.close();
}
