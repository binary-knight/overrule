import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../server.mjs';
import { git } from '../lib/workspace.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = fileURLToPath(new URL('..', import.meta.url));
const directory = await mkdtemp(join(tmpdir(), 'mesh-browser-'));
const project = await mkdtemp(join(tmpdir(), 'mesh-browser-project-with-a-deliberately-long-name-'));
const block = value => '\n```json\n' + JSON.stringify(value) + '\n```';
let checks = 0, drafts = 0;
const { server, access, mesh } = createApp({ directory, detect: async () => ({ codex: { installed: true, signedIn: true }, claude: { installed: true, signedIn: true } }),
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
  assert.deepEqual(errors, []);
  console.log('Browser checks passed: desktop, mobile, connections, escaped content, demo, history, export, citation links, verdicts, limit settings and resume, cancellation, LAN pairing, and workspace verification retry. No live model calls.');
} finally {
  for (const run of mesh.runs) mesh.cancel(run.id);
  for (let i = 0; i < 1000 && mesh.controllers.size; i++) await delay(10);
  await browser?.close();
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  await rm(directory, { recursive: true, force: true });
  await rm(project, { recursive: true, force: true });
}
