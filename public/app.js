import { assessResult, callsUsed, elapsedBudget, estimateCalls, citationEvidence, issueStatus, expiring, HISTORY_LIMIT, parseQuery } from './meeting-state.js';
import { PLAYBOOKS, buildPlaybook } from './playbooks.js';

const $ = id => document.getElementById(id);
const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
let state = { providers: [], selected: new Set(), runs: [], clis: {}, types: {} }, currentRun, events, editingId, toastTimer;
const glyphs = { 'codex-cli': 'O', 'claude-cli': '✳', openai: 'O', anthropic: '✳', gemini: '✧', grok: '𝕏', huggingface: '⌂', compatible: '◇' };
const colors = { 'codex-cli': 'mint', 'claude-cli': 'peach', openai: 'mint', anthropic: 'peach', gemini: 'blue', grok: 'gray', huggingface: 'lavender', compatible: 'lavender' };
function toast(message) { $('toast').textContent = message; $('toast').classList.remove('hidden'); clearTimeout(toastTimer); toastTimer = setTimeout(() => $('toast').classList.add('hidden'), 6000); }
// The draft lives in this browser only, so an expired pairing or a server restart never costs a half-written brief.
const DRAFT_KEY = 'mesh-draft';
function saveDraft() { try { localStorage.setItem(DRAFT_KEY, JSON.stringify({ prompt: $('prompt').value, rounds: $('rounds').value, revisions: $('revisions').value, research: $('research').checked, deepResearch: $('deep-research').checked, maxCalls: $('max-calls').value, duration: $('duration').value, synthesizer: $('synthesizer').value, selected: [...state.selected], maxTokens: $('max-tokens').value, timeout: $('timeout').value, workspacePath: $('workspace-path').value, workspaceChecks: $('workspace-checks').value })); } catch {} }
function readDraft() { try { return JSON.parse(localStorage.getItem(DRAFT_KEY)) || {}; } catch { return {}; } }
async function api(path, method = 'GET', data, retried = false, signal) {
  const response = await fetch(path, { method, signal, headers: { 'Content-Type': 'application/json', 'X-Mesh-Token': state.token || '' }, ...(data !== undefined ? { body: JSON.stringify(data) } : {}) });
  if (response.status === 401) { if ($('prompt').value.trim()) saveDraft(); location.assign('/'); throw new Error('Pair this device again to continue.'); }
  const result = await response.json().catch(() => ({}));
  if (response.status === 403 && result.code === 'stale-token' && !retried) {
    // The server restarted and issued a new mutation token: pick it up and retry once instead of failing every save.
    const fresh = await fetch('/api/bootstrap');
    if (fresh.ok) { state.token = (await fresh.json()).token; return api(path, method, data, true, signal); }
  }
  if (!response.ok) throw new Error(result.error || 'Request failed.'); return result;
}
function cliKey(type) { return type === 'codex-cli' ? 'codex' : 'claude'; }
function readiness(p) {
  if (state.types[p.type]?.cli) {
    const cli = state.clis[cliKey(p.type)] || {};
    if (!cli.installed) return { level: 'missing', text: 'CLI not found on the server' };
    if (cli.signedIn === true) return { level: 'ready', text: 'Signed in, ready' };
    if (cli.signedIn === false) return { level: 'attention', text: `Not signed in. Run ${cliKey(p.type) === 'codex' ? 'codex login' : 'claude auth login'}` };
    return { level: 'unknown', text: 'CLI installed, sign-in not checked' };
  }
  if (p.hasKey) return { level: 'ready', text: 'Saved API key' };
  if (p.environmentKey) return { level: 'ready', text: 'Environment API key' };
  if (p.type === 'compatible') return { level: 'ready', text: 'Custom endpoint' };
  return { level: 'attention', text: 'API key needed' };
}
function available(p) { return !['attention', 'missing'].includes(readiness(p).level); }
function status(p) { return readiness(p).text; }
function badge(p) { return `<span class="provider-icon ${colors[p.type]}">${glyphs[p.type]}</span>`; }
function showPage(page) {
  for (const name of ['workspace', 'connections', 'security', 'archive']) { $(name).classList.toggle('hidden', page !== name); $(`${name}-nav`).classList.toggle('active', page === name); }
  $('page-crumb').textContent = page === 'connections' ? 'Connections' : page === 'security' ? 'Security' : page === 'archive' ? 'Archive' : currentRun ? 'Discussion' : 'New discussion';
  if (page === 'archive') { renderArchive(); $('archive-search').focus(); }
  if (page === 'security') loadSecurity().catch(error => toast(error.message));
}
function renderProviders() {
  state.selected = new Set([...state.selected].filter(id => state.providers.some(p => p.id === id)));
  $('connection-count').textContent = state.providers.length;
  $('participants').innerHTML = state.providers.length ? state.providers.map(p => `<label class="participant ${state.selected.has(p.id) ? 'selected' : ''}" title="${escapeHTML(status(p))}"><input type="checkbox" value="${escapeHTML(p.id)}" ${state.selected.has(p.id) ? 'checked' : ''}>${badge(p)}<span class="participant-info"><strong><i class="state-dot ${readiness(p).level}"></i>${escapeHTML(p.name)}</strong><small>${escapeHTML(p.model || 'CLI default model')}</small></span><span class="provider-status ${available(p) ? 'ready' : ''}">${state.types[p.type]?.cli ? 'Local' : 'API'}</span></label>`).join('') : '<p class="empty-copy">Add two connections to assemble your council.</p>';
  $('participants').querySelectorAll('input').forEach(input => input.addEventListener('change', () => {
    if (input.checked && state.selected.size >= 6) { input.checked = false; return toast('Choose up to six participants.'); }
    input.checked ? state.selected.add(input.value) : state.selected.delete(input.value); renderProviders(); saveDraft();
  }));
  const previousEditor = $('synthesizer').value;
  $('synthesizer').innerHTML = state.providers.filter(p => state.selected.has(p.id)).map(p => `<option value="${escapeHTML(p.id)}">${escapeHTML(p.name)}</option>`).join('');
  if (state.selected.has(previousEditor)) $('synthesizer').value = previousEditor;
  $('connection-cards').innerHTML = state.providers.map(p => `<article class="card connection-card"><div class="connection-title">${badge(p)}<div><h2>${escapeHTML(p.name)}</h2><span>${escapeHTML(state.types[p.type].label)}</span></div></div><p class="model-name">${escapeHTML(p.model || 'CLI default model')}</p><p>${escapeHTML(p.role)}</p><div class="connection-bottom"><span class="connection-state"><i class="${readiness(p).level}"></i>${escapeHTML(status(p))}</span><span>${state.types[p.type]?.cli ? `<button class="text-button" data-check="${cliKey(p.type)}">Check sign-in</button>` : ''}<button class="text-button" data-duplicate="${escapeHTML(p.id)}">Add another model</button><button class="text-button" data-edit="${escapeHTML(p.id)}">Edit</button></span></div></article>`).join('');
  $('connection-cards').querySelectorAll('[data-duplicate]').forEach(button => button.onclick = () => openProvider(null, button.dataset.duplicate));
  $('connection-cards').querySelectorAll('[data-edit]').forEach(button => button.onclick = () => openProvider(button.dataset.edit));
  $('connection-cards').querySelectorAll('[data-check]').forEach(button => button.onclick = async () => {
    button.disabled = true; button.textContent = 'Checking…';
    try { state.clis = await api('/api/clis/check', 'POST'); renderProviders(); toast(`${button.dataset.check === 'codex' ? 'Codex' : 'Claude Code'}: ${state.clis[button.dataset.check]?.detail || 'checked.'}`); }
    catch (error) { toast(error.message); button.disabled = false; button.textContent = 'Check sign-in'; }
  });
  updateEstimate(); drawMesh();
}
// Document text rides in every prompt, so it multiplies with the number of calls. Rough: four characters to a token.
function documentNote() {
  const total = (state.attachments || []).reduce((n, a) => n + (a.chars || 0), 0), chars = Math.min(DOC_PROMPT_CAP, total);
  if (!chars) return '';
  return `. Documents add about ${Math.max(1, Math.round(chars / 4000))}k tokens to every call${total > DOC_PROMPT_CAP ? `; members see the first ${DOC_PROMPT_CAP.toLocaleString()} of ${total.toLocaleString()} characters` : ''}`;
}
function updateEstimate() {
  const n = state.selected.size, cycles = Number($('rounds').value);
  const { typical, maximum } = estimateCalls(n, cycles, Number($('revisions').value));
  $('max-calls').placeholder = `Automatic (${maximum})`;
  const limit = $('max-calls').value ? Number($('max-calls').value) : maximum;
  $('call-estimate').textContent = n ? `About ${typical} calls; up to ${maximum} with revisions and re-asks. Limits: ${limit} calls / ${$('duration').value} min${limit < typical ? '. This call limit may stop before a final answer' : ''}${documentNote()}` : 'Select your members';
  const blocker = state.providers.find(p => state.selected.has(p.id) && !available(p));
  // A signed-out CLI reading can be stale; the server re-probes before spending anything, so only a missing CLI or key hard-blocks here.
  const hard = blocker && !(state.types[blocker.type]?.cli && readiness(blocker).level === 'attention');
  const level = typeof levelValue === 'function' ? levelValue() : '';
  $('start-note').textContent = blocker ? `${blocker.name}: ${status(blocker)}. ${hard ? 'Fix this in Connections before starting.' : 'The server will re-check when you start.'}` : level === 'full-access' ? 'FULL ACCESS: every member with tools can do anything your account can do on this machine.' : level === 'workspace-write' ? 'Members read the workspace; the drafter implements on a new branch in its own checkout. Your tree changes only when you apply.' : level === 'read-only' ? 'Members read the workspace inside their sandboxes. Its contents reach every selected provider.' : 'Turns run one at a time. Your brief and every contribution go to every selected provider.';
  $('start-note').classList.toggle('start-blocker', Boolean(blocker) || level === 'full-access');
  $('start').disabled = state.selected.size < 2 || Boolean(hard) || (currentRun?.status === 'running');
}
// Ten standing perspectives a member can take in the room. Each is a starting point; the field stays editable.
const ARCHETYPES = [
  ['Builder', 'Builder: propose concrete, practical solutions first, then defend them. Prefer the smallest thing that works and name what it would take to ship it.'],
  ['Skeptic', 'Skeptic: assume nothing is established until it is shown. Challenge assumptions, ask for evidence, and refuse to agree on politeness.'],
  ['Security reviewer', 'Security reviewer: look for what an attacker, a mistake, or bad input could do. Name threats, trust boundaries, and the cheapest mitigation for each.'],
  ['Architect', 'Architect: think in structures and boundaries. Weigh how a choice ages: coupling, migration cost, failure modes, and what becomes hard to change later.'],
  ['User advocate', 'User advocate: speak for the person who has to use the result. Push for clarity, fewer steps, and honest defaults; object to anything that serves the builder over the user.'],
  ['Quant', 'Quant: turn claims into numbers. Ask for the model, the inputs, and the sensitivity; distinguish measured results from estimates and say how wrong each could be.'],
  ['Pragmatist', 'Pragmatist: optimize for what can actually be done with the time, people, and tools at hand. Cut scope before cutting quality, and say what to defer.'],
  ['Devil’s advocate', 'Devil’s advocate: argue the strongest case against whatever the room is converging on, even if you privately agree, so the decision survives contact with its best objection.'],
  ['Domain expert', 'Domain expert: bring the field’s established practice and its known failure patterns. Cite the rule or precedent you rely on and say where the field itself is unsettled.'],
  ['Editor', 'Editor: care about the deliverable as a document. Push for precise claims, plain words, a clear structure, and nothing the reader cannot act on.'],
];
function archetypeSetup() {
  $('role-archetype').innerHTML = '<option value="">Custom (write your own below)</option>' + ARCHETYPES.map(([name], i) => `<option value="${i}">${escapeHTML(name)}</option>`).join('');
  $('role-archetype').onchange = () => { const pick = ARCHETYPES[Number($('role-archetype').value)]; if (pick) $('provider-role').value = pick[1]; };
  $('provider-role').oninput = () => { const i = ARCHETYPES.findIndex(([, text]) => text === $('provider-role').value); $('role-archetype').value = i >= 0 ? String(i) : ''; };
}
// ---------- documents ----------
// Files dropped on the brief upload straight to the host, which reads their text once. The server's staged list is the truth,
// so a reload or another paired device shows the same documents.
const DOC_MAX_BYTES = 25 * 1024 * 1024, DOC_MAX_FILES = 10, DOC_PROMPT_CAP = 60000;
const bytesText = n => n < 1024 ? `${n} B` : n < 1048576 ? `${Math.round(n / 1024)} KB` : `${(n / 1048576).toFixed(1)} MB`;
function renderAttachments() {
  const list = state.attachments || [];
  $('attach-note').classList.toggle('hidden', !list.length);
  $('attach-list').innerHTML = list.map((a, i) => `<div class="attach-item${a.warning ? ' has-warning' : ''}"><div class="attach-main"><span class="attach-name">${escapeHTML(a.name)}</span><span class="attach-meta">${bytesText(a.size)}${a.uploading ? ', uploading and reading…' : a.chars ? `, ${a.chars.toLocaleString()} characters read` : ', no text read'}</span>${a.uploading ? '' : `<button type="button" class="attach-remove" data-remove-doc="${i}" aria-label="Remove ${escapeHTML(a.name)}">×</button>`}</div>${a.warning ? `<p class="attach-warning">${escapeHTML(a.warning)}</p>` : ''}</div>`).join('');
  $('attach-list').querySelectorAll('[data-remove-doc]').forEach(b => b.onclick = async () => {
    const doc = state.attachments[Number(b.dataset.removeDoc)]; if (!doc) return;
    try { await api(`/api/attachments/${doc.id}`, 'DELETE'); } catch (error) { return toast(error.message); }
    state.attachments = state.attachments.filter(a => a !== doc); renderAttachments(); updateEstimate();
  });
}
async function uploadDocument(file, retried = false) {
  const response = await fetch('/api/attachments', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-File-Name': encodeURIComponent(file.name), 'X-Mesh-Token': state.token || '' }, body: file });
  const result = await response.json().catch(() => ({}));
  if (response.status === 403 && result.code === 'stale-token' && !retried) { const fresh = await fetch('/api/bootstrap'); if (fresh.ok) { state.token = (await fresh.json()).token; return uploadDocument(file, true); } }
  if (response.status === 401) throw new Error('Pair this device again, then attach the file.');
  if (!response.ok) throw new Error(result.error || `${file.name} could not be uploaded.`);
  return result;
}
async function attachFiles(files) {
  state.attachments ||= [];
  for (const file of [...files]) {
    if (state.attachments.length >= DOC_MAX_FILES) { toast(`A meeting takes up to ${DOC_MAX_FILES} documents.`); break; }
    if (file.size > DOC_MAX_BYTES) { toast(`${file.name} is larger than 25 MB.`); continue; }
    if (!file.size) { toast(`${file.name} is empty, or it is a folder. Zip a folder to attach it.`); continue; }
    const pending = { name: file.name, size: file.size, uploading: true }; state.attachments.push(pending); renderAttachments(); updateEstimate();
    try { Object.assign(pending, await uploadDocument(file), { uploading: false }); }
    catch (error) { state.attachments = state.attachments.filter(a => a !== pending); toast(error.message); }
    renderAttachments(); updateEstimate();
  }
}
function documentsSetup() {
  $('attach-button').onclick = () => $('attach-input').click();
  $('attach-input').onchange = () => { attachFiles($('attach-input').files); $('attach-input').value = ''; };
  const zone = $('drop-zone'), hasFiles = event => [...(event.dataTransfer?.types || [])].includes('Files'); let depth = 0;
  zone.addEventListener('dragenter', event => { if (!hasFiles(event)) return; event.preventDefault(); depth++; zone.classList.add('dragging'); });
  zone.addEventListener('dragover', event => { if (hasFiles(event)) { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; } });
  zone.addEventListener('dragleave', event => { if (hasFiles(event) && --depth <= 0) { depth = 0; zone.classList.remove('dragging'); } });
  zone.addEventListener('drop', event => { if (!hasFiles(event)) return; event.preventDefault(); depth = 0; zone.classList.remove('dragging'); attachFiles(event.dataTransfer.files); });
  // A file dropped beside the brief must not make the browser navigate away from a half-written meeting.
  for (const type of ['dragover', 'drop']) window.addEventListener(type, event => { if (hasFiles(event) && !zone.contains(event.target)) event.preventDefault(); });
  // Pasting a file (a screenshot of a table will not work, but a copied document does) attaches it too.
  $('prompt').addEventListener('paste', event => { const files = [...(event.clipboardData?.files || [])]; if (files.length) { event.preventDefault(); attachFiles(files); } });
}
// ---------- workspace ----------
const levelValue = () => document.querySelector('input[name=workspace-level]:checked')?.value || '';
function workspaceSetup() {
  const config = state.workspaceConfig || {}, recent = config.recent || [];
  $('workspace-lan').classList.toggle('hidden', Boolean(config.local));
  $('workspace-budget').value = config.maxScore ?? ''; $('workspace-budget').placeholder = config.agentsec ? 'No budget' : 'Needs agentsec-pack'; $('workspace-budget').disabled = !config.agentsec; $('budget-save').disabled = !config.agentsec;
  $('agentsec-help').classList.toggle('hidden', config.agentsec !== false);
  $('recent-head').classList.toggle('hidden', recent.length === 0);
  $('recent').innerHTML = recent.map(r => `<span class="recent-chip"><button type="button" class="recent-open" data-recent="${escapeHTML(r.path)}" data-git="${r.git ? 1 : ''}" title="${r.missing ? 'This folder no longer exists' : r.git ? 'Use and inspect this workspace' : 'Browse this folder'}">${escapeHTML(r.path)}</button><button type="button" class="recent-remove" data-remove="${escapeHTML(r.path)}" aria-label="Forget ${escapeHTML(r.path)}">×</button></span>`).join('');
  // A project opens straight into Inspect; a plain folder opens the browser there, since it is more likely a folder of projects.
  $('recent').querySelectorAll('[data-recent]').forEach(b => b.onclick = () => { $('workspace-path').value = b.dataset.recent; saveDraft(); if (b.dataset.git) { $('browser').classList.add('hidden'); $('workspace-inspect').click(); } else browseTo(b.dataset.recent); });
  $('recent').querySelectorAll('[data-remove]').forEach(b => b.onclick = async () => { try { state.workspaceConfig = { ...config, ...(await api('/api/workspace/recent', 'DELETE', { path: b.dataset.remove })) }; workspaceSetup(); } catch (error) { toast(error.message); } });
  workspaceLevelChanged();
}
// Host browser for picking the workspace from any machine. Folders that cannot be a workspace still show, greyed, so the tree stays navigable.
async function browseTo(path) {
  try {
    const listing = await api('/api/workspace/browse-host', 'POST', { path });
    $('browser').classList.remove('hidden');
    $('browser-crumb').innerHTML = `${listing.parent ? '<button type="button" class="text-button" id="browser-up">Up</button>' : ''}<span>${escapeHTML(listing.path)}</span>${listing.git ? '<span class="chip vote-approve">git</span>' : ''}${listing.selectable ? '<button type="button" class="text-button" id="browser-use">Use this folder</button>' : '<span class="chip">cannot be a workspace</span>'}`;
    if (listing.parent) $('browser-up').onclick = () => browseTo(listing.parent);
    if (listing.selectable) $('browser-use').onclick = () => { $('workspace-path').value = listing.path; saveDraft(); $('browser').classList.add('hidden'); $('workspace-inspect').click(); };
    $('browser-entries').innerHTML = listing.entries.length ? listing.entries.map(e => `<button type="button" class="browser-entry ${e.selectable ? '' : 'unselectable'}" data-path="${escapeHTML(e.path)}"><span>📁 ${escapeHTML(e.name)}</span>${e.git ? '<span class="chip vote-approve">git</span>' : e.selectable ? '' : '<span>browse only</span>'}</button>`).join('') : '<p class="empty-copy">No subfolders.</p>';
    $('browser-entries').querySelectorAll('[data-path]').forEach(b => b.onclick = () => browseTo(b.dataset.path));
  } catch (error) { toast(error.message); }
}
// Staging a document that is already on the host: the file never passes through the browser.
async function attachWorkspaceDocuments(documents) {
  state.attachments ||= [];
  for (const doc of documents) {
    if (state.attachments.some(a => a.name === doc.name)) continue;
    const pending = { name: doc.name, size: doc.size, uploading: true }; state.attachments.push(pending); renderAttachments();
    try { Object.assign(pending, await api('/api/attachments/from-workspace', 'POST', { workspace: $('workspace-path').value.trim(), path: doc.path }), { uploading: false }); }
    catch (error) { state.attachments = state.attachments.filter(a => a !== pending); toast(error.message); }
    renderAttachments(); updateEstimate();
  }
  if (state.workspaceInfo) renderWorkspaceInfo(state.workspaceInfo);
}
function workspaceLevelChanged() {
  const level = levelValue(), info = state.workspaceInfo;
  const levelNames = { 'read-only': 'Read-only tools', 'workspace-write': 'Workspace-write', 'full-access': 'Full access' };
  $('workspace-state').textContent = level ? `${levelNames[level]}${info ? ': ' + info.name : ''}` : '';
  $('workspace-write-options').classList.toggle('hidden', level !== 'workspace-write' && level !== 'full-access');
  $('workspace-network').disabled = level === 'full-access'; if (level === 'full-access') $('workspace-network').checked = true;
  $('workspace-full-ack').classList.toggle('hidden', level !== 'full-access');
  const needSecrets = Boolean(level && info?.secrets?.length), needDirty = level !== '' && level !== 'read-only' && Boolean(info?.dirty);
  $('workspace-acks').classList.toggle('hidden', !(needSecrets || needDirty));
  $('ack-secrets-label').classList.toggle('hidden', !needSecrets); $('ack-dirty-label').classList.toggle('hidden', !needDirty);
  updateEstimate();
}
function renderWorkspaceInfo(info) {
  state.workspaceInfo = info;
  $('playbooks').classList.toggle('hidden', !info);
  const lines = [];
  lines.push(info.git ? `<span class="ok">Git repository</span> on branch <b>${escapeHTML(info.branch)}</b> at ${escapeHTML((info.head || '').slice(0, 10))}${info.dirty ? `, <span class="warn">${info.dirtyFiles.length} uncommitted change${info.dirtyFiles.length === 1 ? '' : 's'}</span>` : ', clean'}` : `<span class="warn">Not a git repository root</span>, so read-only only`);
  if (info.secrets?.length) lines.push(`<span class="warn">Looks like secrets:</span> ${info.secrets.slice(0, 6).map(escapeHTML).join(', ')}${info.secrets.length > 6 ? ', …' : ''}`);
  // A Word or PDF file in the tree is binary. A member with a shell can unzip one; a member without one cannot read it at all.
  // Attaching it puts its text in every member's prompt, which is the only way the whole council reads the same thing.
  var documents = (info.documents || []).filter(doc => !(state.attachments || []).some(a => a.name === doc.name));
  if (documents.length) lines.push(`<span class="warn">${documents.length} document${documents.length === 1 ? '' : 's'} no member can read without a shell:</span> ${documents.map((doc, i) => `<button type="button" class="text-button" data-attach-doc="${i}">${escapeHTML(doc.name)}</button>`).join(', ')} — <button type="button" class="text-button" data-attach-doc="all"><b>attach ${documents.length === 1 ? 'it' : 'all'}</b></button>`);
  for (const [level, c] of Object.entries(info.canaries || {})) {
    lines.push(`<span class="${c.ok ? 'ok' : 'bad'}">${escapeHTML(level)}:</span> ${escapeHTML(c.detail)}`);
    const m = info.measurements?.[level];
    if (m?.available) {
      const over = info.maxScore !== null && info.maxScore !== undefined && m.score !== null && m.score > info.maxScore;
      lines.push(`&nbsp;&nbsp;<span class="${over ? 'bad' : m.score > 50 ? 'warn' : 'ok'}">Blast radius ${m.score ?? '?'} of 100</span>${over ? ', over your budget, refused' : ''}${m.findings.length ? '. Findings: ' + m.findings.map(f => `${escapeHTML(f.severity)} ${escapeHTML(f.id)} ${escapeHTML(f.title)}`).join('; ') : ''}`);
      const readable = m.secrets.filter(s => s.readable);
      if (readable.length) lines.push(`&nbsp;&nbsp;<span class="warn">readable from inside:</span> ${readable.map(s => escapeHTML(s.path)).join(', ')}`);
      else if (m.secrets.length) lines.push(`&nbsp;&nbsp;<span class="ok">no probed secret path readable</span>`);
    } else if (m) lines.push(`&nbsp;&nbsp;<span class="warn">${escapeHTML(m.detail)}</span>`);
  }
  $('workspace-info').innerHTML = lines.join('<br>'); $('workspace-info').classList.remove('hidden');
  $('workspace-info').querySelectorAll('[data-attach-doc]').forEach(button => button.onclick = () => {
    const which = button.dataset.attachDoc;
    attachWorkspaceDocuments(which === 'all' ? documents : [documents[Number(which)]]);
  });
  document.querySelectorAll('input[name=workspace-level]').forEach(input => {
    const allowed = !input.value || Boolean(info.canaries?.[input.value]?.ok);
    input.disabled = !allowed; input.closest('.level').classList.toggle('disabled', !allowed);
    if (!allowed && input.checked) document.querySelector('input[name=workspace-level][value=""]').checked = true;
  });
  workspaceLevelChanged();
}
function workspacePayload() {
  const level = levelValue(); if (!level) return undefined;
  return { path: $('workspace-path').value.trim(), level, checks: $('workspace-checks').value.split('\n').map(l => l.trim()).filter(Boolean), network: $('workspace-network').checked, implementTimeout: Number($('workspace-timeout').value), acknowledgeSecrets: $('ack-secrets').checked, acknowledgeDirty: $('ack-dirty').checked, acknowledgeFullAccess: $('ack-full').checked, claudeSandbox: $('workspace-claude-sandbox').checked, skipMeasurement: $('workspace-skip-measure').checked };
}
function drawMesh() {
  const providers = state.providers.filter(p => state.selected.has(p.id));
  const n = providers.length;
  const nodes = providers.map((p, i) => ({ p, x: 170 + Math.cos(-Math.PI / 2 + i * 2 * Math.PI / n) * 98, y: 119 + Math.sin(-Math.PI / 2 + i * 2 * Math.PI / n) * 77 }));
  let svg = '<defs><pattern id="dots" width="16" height="16" patternUnits="userSpaceOnUse"><circle cx="2" cy="2" r=".7"/></pattern></defs><rect width="340" height="256" fill="url(#dots)"/><circle class="orbit" cx="170" cy="119" r="77"/>';
  for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) svg += `<line class="mesh-edge" x1="${nodes[i].x}" y1="${nodes[i].y}" x2="${nodes[j].x}" y2="${nodes[j].y}"/>`;
  for (const node of nodes) svg += `<line class="mesh-spoke" x1="170" y1="119" x2="${node.x}" y2="${node.y}"/>`;
  svg += '<rect class="mesh-center" x="146" y="95" width="48" height="48" rx="15"/><text x="170" y="126" class="center-glyph">◈</text>';
  for (const { p, x, y } of nodes) svg += `<g class="mesh-node ${colors[p.type]}"><circle cx="${x}" cy="${y}" r="24"/><text x="${x}" y="${y + 6}">${escapeHTML(glyphs[p.type])}</text><text class="mesh-node-label" x="${x}" y="${y + 41}">${escapeHTML(p.name.slice(0, 15))}</text></g>`;
  if (!n) svg += '<text x="170" y="221" class="mesh-node-label">Select your participants</text>';
  $('mesh-diagram').innerHTML = svg;
}
const BIN_ICON = '<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 4h11M6.5 4V2.5h3V4M4 4l.7 9.5h6.6L12 4M6.75 6.5v5M9.25 6.5v5"/></svg>';
const PIN_ICON = filled => `<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M6.5 2h3v4l2 3h-7l2-3z"${filled ? ' fill="currentColor"' : ''}/><path d="M5.5 2h5M8 9v5"/></svg>`;
const EDIT_ICON = '<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M10.5 2.5l3 3L6 13H3v-3zM9 4l3 3"/></svg>';
// How a meeting is named everywhere in the interface: the name the owner gave it, otherwise its brief.
const runLabel = run => run.title || (run.demo ? 'Scripted demo' : run.prompt);
const shortDate = iso => new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
// Which project groups are folded away is a preference of this browser, like the draft; the pins themselves live on the server.
const COLLAPSED_KEY = 'overrule-collapsed-projects';
const collapsedProjects = new Set((() => { try { return JSON.parse(localStorage.getItem(COLLAPSED_KEY)) || []; } catch { return []; } })());
const saveCollapsed = () => { try { localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...collapsedProjects])); } catch {} };
const byName = (a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' });
const projectsInUse = () => [...new Set(state.runs.map(r => r.pin?.project).filter(Boolean))].sort(byName);
const MORE_ICON = '<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true" fill="currentColor"><circle cx="3.5" cy="8" r="1.3"/><circle cx="8" cy="8" r="1.3"/><circle cx="12.5" cy="8" r="1.3"/></svg>';
// The limit the server applies now: the setting, or fewer if the disk has no room for that many. Infinity when none applies.
const historyLimit = () => state.settings ? state.settings.effectiveLimit ?? Infinity : HISTORY_LIMIT;
const FIELD_LABELS = { tags: 'Tags', brief: 'Brief', details: 'Details', answer: 'Answer', transcript: 'Transcript' };
// An excerpt is worth a line only when it shows something the listing does not: tags and projects are already on screen, and an
// unnamed meeting is listed by its brief, whose first words are its title.
const showSnippet = (run, match) => Boolean(match?.snippet) && match.field !== 'tags' && !(match.field === 'brief' && !run.title && match.at < 28);
const escapeRegExp = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Escapes the text, then marks the search terms in it. The pattern is built from escaped terms, so nothing in a query is markup.
function highlight(text, query) {
  const terms = parseQuery(query);
  if (!terms.length) return escapeHTML(text);
  let out = '', last = 0;
  for (const found of String(text).matchAll(new RegExp(terms.map(escapeRegExp).join('|'), 'giu'))) {
    out += escapeHTML(text.slice(last, found.index)) + `<mark>${escapeHTML(found[0])}</mark>`; last = found.index + found[0].length;
  }
  return out + escapeHTML(text.slice(last));
}
function historyRow(run) {
  const label = runLabel(run), id = escapeHTML(run.id), pinned = Boolean(run.pin), short = escapeHTML(label.slice(0, 80));
  const match = view.matches?.get(run.id);
  // Tags double as filters: clicking one shows only meetings with that tag.
  const tags = pinned && run.pin.tags?.length ? `<span class="history-tags">${run.pin.tags.map(t => `<span class="tag${view.tags.has(t) ? ' active' : ''}" data-filter-tag="${escapeHTML(t)}" title="Show only meetings tagged ${escapeHTML(t)}">${escapeHTML(t)}</span>`).join('')}</span>` : '';
  const found = showSnippet(run, match) ? `<span class="history-snippet"><em>${FIELD_LABELS[match.field] || 'Found'}:</em> ${highlight(match.snippet, view.query)}</span>` : '';
  // Past the limit: say it goes, and that it goes completely, naming a branch whose changes would be lost. Or say why it could not go.
  const branch = run.workspace?.unappliedBranch;
  const leaving = run.pruneBlocked ? `<span class="history-expiring">Past the history limit but kept: ${escapeHTML(run.pruneBlocked)} It is removed once that is resolved.</span>`
    : run.expiring ? `<span class="history-expiring">Deleted when the next meeting starts${branch ? `, with its unapplied branch ${escapeHTML(branch)}` : ''}. Pin or archive it to keep it.</span>` : '';
  return `<div class="history-row${pinned ? ' pinned' : ''}${currentRun?.id === run.id ? ' current' : ''}"><button class="history-item" data-run="${id}"><span class="history-dot ${escapeHTML(run.status)}"></span><span class="history-text"><span class="history-title">${highlight(label, view.query)}</span><small>${shortDate(run.createdAt)}, ${escapeHTML(run.status)}</small>${tags}${found}${leaving}</span></button><span class="history-actions"><button type="button" class="history-action history-pin" data-pin-run="${id}" aria-pressed="${pinned}" aria-label="${pinned ? 'Pinned; edit or unpin' : 'Pin'} meeting: ${short}" title="${pinned ? 'Pinned. Edit tags and project, or unpin' : 'Pin to the top'}">${PIN_ICON(pinned)}</button><button type="button" class="history-action history-more" data-menu-run="${id}" aria-haspopup="menu" aria-expanded="false" aria-label="More actions for meeting: ${short}" title="Rename, archive, or delete">${MORE_ICON}</button></span></div>`;
}
// ---------- search and filters ----------
// Typing searches on the server, which reads every meeting in full; project and tag chips narrow what it found. Archived meetings
// are left out of the list, and counted so the owner knows to look in the Archive.
const RECENT_PAGE = 50;
const view = { query: '', matches: null, tags: new Set(), project: null, allFilters: false, recentShown: RECENT_PAGE, archiveQuery: '', archiveMatches: null };
const filtering = () => Boolean(view.matches || view.tags.size || view.project);
const passes = run => (!view.matches || view.matches.has(run.id)) && (!view.project || run.pin?.project === view.project) && [...view.tags].every(t => (run.pin?.tags || []).includes(t));
const searches = {};
async function runSearch(which) {
  const query = which === 'archive' ? view.archiveQuery : view.query, key = which === 'archive' ? 'archiveMatches' : 'matches';
  searches[which]?.abort();
  if (!parseQuery(query).length) { view[key] = null; return true; }
  const controller = searches[which] = new AbortController();
  try {
    const found = await api(`/api/runs?q=${encodeURIComponent(query)}`, 'GET', undefined, false, controller.signal);
    view[key] = new Map(found.map(r => [r.id, r.match]));
    return true;
  } catch (error) { if (error.name !== 'AbortError') toast(error.message); return false; }
}
function searchAsYouType(input, which, render) {
  let timer;
  input.addEventListener('input', () => {
    view[which === 'archive' ? 'archiveQuery' : 'query'] = input.value; view.recentShown = RECENT_PAGE;
    clearTimeout(timer);
    // An emptied box shows everything at once; otherwise wait for a pause in typing, and drop any answer a newer query replaced.
    if (!parseQuery(input.value).length) { searches[which]?.abort(); view[which === 'archive' ? 'archiveMatches' : 'matches'] = null; return render(); }
    timer = setTimeout(async () => { if (await runSearch(which)) render(); }, 150);
  });
  input.addEventListener('keydown', event => { if (event.key === 'Escape' && input.value) { event.preventDefault(); input.value = ''; input.dispatchEvent(new Event('input')); } });
}
function clearFilters() {
  $('history-search').value = ''; view.query = ''; view.matches = null; view.tags.clear(); view.project = null; searches.history?.abort(); renderHistory();
}
function toggleTag(tag) { view.tags.has(tag) ? view.tags.delete(tag) : view.tags.add(tag); view.recentShown = RECENT_PAGE; renderHistory(); }
function renderFilters() {
  const live = state.runs.filter(r => !r.archived);
  const projects = [...new Set(live.map(r => r.pin?.project).filter(Boolean))].sort(byName);
  const counts = new Map(); for (const r of live) for (const t of r.pin?.tags || []) counts.set(t, (counts.get(t) || 0) + 1);
  // A filter whose tag or project no longer exists (its last meeting was unpinned or archived) would hide everything: drop it.
  for (const t of [...view.tags]) if (!counts.has(t)) view.tags.delete(t);
  if (view.project && !projects.includes(view.project)) view.project = null;
  const tags = [...counts.keys()].sort((a, b) => counts.get(b) - counts.get(a) || byName(a, b));
  const chips = [...projects.map(p => `<button type="button" class="filter-chip project" data-chip-project="${escapeHTML(p)}" aria-pressed="${view.project === p}" title="Show only the ${escapeHTML(p)} project">${escapeHTML(p)}</button>`),
    ...tags.map(t => `<button type="button" class="filter-chip" data-chip-tag="${escapeHTML(t)}" aria-pressed="${view.tags.has(t)}" title="Show only meetings tagged ${escapeHTML(t)}">#${escapeHTML(t)}</button>`)];
  const limit = 10, hidden = view.allFilters ? 0 : Math.max(0, chips.length - limit);
  $('history-filters').classList.toggle('hidden', !chips.length);
  $('history-filters').innerHTML = chips.slice(0, chips.length - hidden).join('') + (hidden ? `<button type="button" class="filter-more" data-chips-more>+${hidden} more</button>` : view.allFilters && chips.length > limit ? '<button type="button" class="filter-more" data-chips-more>Fewer</button>' : '');
  $('history-filters').querySelectorAll('[data-chip-project]').forEach(b => b.onclick = () => { view.project = view.project === b.dataset.chipProject ? null : b.dataset.chipProject; view.recentShown = RECENT_PAGE; renderHistory(); });
  $('history-filters').querySelectorAll('[data-chip-tag]').forEach(b => b.onclick = () => toggleTag(b.dataset.chipTag));
  $('history-filters').querySelector('[data-chips-more]')?.addEventListener('click', () => { view.allFilters = !view.allFilters; renderFilters(); });
}
function renderHistory() {
  renderFilters();
  const live = state.runs.filter(r => !r.archived), shown = live.filter(passes), searching = filtering();
  // Pinned first, most recently pinned on top: loose pins, then one group per project. Everything else keeps its date order below,
  // a page at a time, since a history that keeps every meeting can grow long.
  const pinned = shown.filter(r => r.pin).sort((a, b) => String(b.pin.pinnedAt || '').localeCompare(String(a.pin.pinnedAt || '')));
  const recent = shown.filter(r => !r.pin), visible = recent.slice(0, view.recentShown), more = recent.length - visible.length;
  let html = '';
  if (pinned.length) {
    html += `<div class="history-heading">Pinned <span class="count">${pinned.length}</span></div>` + pinned.filter(r => !r.pin.project).map(historyRow).join('');
    for (const project of [...new Set(pinned.map(r => r.pin.project).filter(Boolean))].sort(byName)) {
      // While searching, every group is open: a match folded out of sight would look like no match at all.
      const members = pinned.filter(r => r.pin.project === project), open = searching || !collapsedProjects.has(project);
      html += `<div class="history-group"><button type="button" class="history-group-head" data-project="${escapeHTML(project)}" aria-expanded="${open}"${searching ? ' disabled' : ''}><span class="caret" aria-hidden="true">${open ? '▾' : '▸'}</span><span class="history-group-name">${escapeHTML(project)}</span><span class="count">${members.length}</span></button>${open ? members.map(historyRow).join('') : ''}</div>`;
    }
  }
  if (recent.length || !searching) html += '<div class="history-heading">Recent meetings</div>';
  if (recent.length) html += visible.map(historyRow).join('') + (more ? `<button type="button" class="history-more-button" data-show-more>Show ${Math.min(more, RECENT_PAGE)} more of ${more}</button>` : '');
  else if (!searching) html += `<p class="history-empty">${pinned.length ? 'Meetings you have not pinned appear here.' : 'A new perspective<br>starts with a question.'}</p>`;
  if (searching && !shown.length) html += '<p class="history-empty">No meetings match.</p>';
  $('history').innerHTML = html;
  // What the filter found, what it hides, and where else to look.
  const inArchive = view.matches ? state.runs.filter(r => r.archived && view.matches.has(r.id)).length : 0;
  $('history-summary').classList.toggle('hidden', !searching);
  $('history-summary').innerHTML = searching ? `${shown.length} of ${live.length} ${live.length === 1 ? 'meeting matches' : 'meetings match'}.${inArchive ? ` <button type="button" class="text-button" data-to-archive>${inArchive} in the Archive</button>` : ''} <button type="button" class="text-button" data-clear-filters>Clear</button>` : '';
  $('history-summary').querySelector('[data-clear-filters]')?.addEventListener('click', clearFilters);
  $('history-summary').querySelector('[data-to-archive]')?.addEventListener('click', () => { $('archive-search').value = view.query; view.archiveQuery = view.query; view.archiveMatches = view.matches; showPage('archive'); });
  $('history').querySelectorAll('[data-run]').forEach(button => button.onclick = event => {
    const tag = event.target.closest('[data-filter-tag]');
    return tag ? toggleTag(tag.dataset.filterTag) : loadRun(button.dataset.run);
  });
  $('history').querySelectorAll('[data-pin-run]').forEach(button => button.onclick = () => openPin(button.dataset.pinRun));
  $('history').querySelectorAll('[data-menu-run]').forEach(button => button.onclick = () => openRowMenu(button, button.dataset.menuRun));
  $('history').querySelector('[data-show-more]')?.addEventListener('click', () => { view.recentShown += RECENT_PAGE; renderHistory(); });
  $('history').querySelectorAll('[data-project]').forEach(button => button.onclick = () => {
    const name = button.dataset.project; collapsedProjects.has(name) ? collapsedProjects.delete(name) : collapsedProjects.add(name); saveCollapsed(); renderHistory();
  });
  renderArchive();
}
async function refreshHistory() {
  state.runs = await api('/api/runs');
  // A search already showing is asked again, so a meeting that just finished or changed is found, or dropped, like the rest.
  if (view.matches) await runSearch('history');
  if (view.archiveMatches) await runSearch('archive');
  renderHistory();
}
searchAsYouType($('history-search'), 'history', renderHistory);
searchAsYouType($('archive-search'), 'archive', renderArchive);
// ---------- the row menu ----------
// One menu per row holds the actions that do not fit beside it. Items that cannot act yet stay listed, disabled, with the reason.
let menuFor = null;
function closeRowMenu(refocus = false) {
  if (!menuFor) return;
  const button = $('history').querySelector(`[data-menu-run="${CSS.escape(menuFor)}"]`);
  button?.setAttribute('aria-expanded', 'false');
  $('row-menu').classList.add('hidden'); menuFor = null;
  if (refocus) button?.focus();
}
function openRowMenu(button, id) {
  if (menuFor === id) return closeRowMenu(true);
  closeRowMenu();
  const run = state.runs.find(r => r.id === id); if (!run) return;
  const running = run.status === 'running';
  const items = [
    ['rename', run.title ? 'Rename…' : 'Name…', ''],
    ['pin', run.pin ? 'Edit pin…' : 'Pin…', ''],
    ['archive', 'Archive', running ? 'Stop it before archiving it.' : ''],
    ['delete', 'Delete…', running ? 'Stop it before deleting it.' : run.pin ? 'Unpin it before deleting it.' : ''],
  ];
  const menu = $('row-menu');
  menu.innerHTML = items.map(([action, label, blocked]) => `<button type="button" role="menuitem" class="row-menu-item${action === 'delete' ? ' danger' : ''}" data-menu-action="${action}"${blocked ? ` aria-disabled="true" data-blocked="${escapeHTML(blocked)}"` : ''}>${label}${blocked ? `<small>${escapeHTML(blocked)}</small>` : ''}</button>`).join('');
  menu.classList.remove('hidden'); menuFor = id; button.setAttribute('aria-expanded', 'true');
  const at = button.getBoundingClientRect(), size = menu.getBoundingClientRect();
  menu.style.top = `${Math.max(8, Math.min(at.bottom + 4, innerHeight - size.height - 8))}px`;
  menu.style.left = `${Math.max(8, Math.min(at.left, innerWidth - size.width - 8))}px`;
  menu.querySelectorAll('[data-menu-action]').forEach(item => item.onclick = () => {
    if (item.dataset.blocked) return toast(item.dataset.blocked);
    closeRowMenu();
    ({ rename: () => openRename(id), pin: () => openPin(id), archive: () => archiveRun(id), delete: () => confirmDelete(id) })[item.dataset.menuAction]();
  });
  menu.querySelector('[role=menuitem]').focus();
}
$('row-menu').addEventListener('keydown', event => {
  const items = [...$('row-menu').querySelectorAll('[role=menuitem]')], at = items.indexOf(document.activeElement);
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); items[(at + (event.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length].focus(); }
  else if (event.key === 'Home' || event.key === 'End') { event.preventDefault(); items[event.key === 'Home' ? 0 : items.length - 1].focus(); }
  else if (event.key === 'Escape') { event.preventDefault(); closeRowMenu(true); }
  else if (event.key === 'Tab') closeRowMenu();
});
document.addEventListener('pointerdown', event => { if (menuFor && !event.target.closest('#row-menu, [data-menu-run]')) closeRowMenu(); });
$('history').addEventListener('scroll', () => closeRowMenu());
window.addEventListener('resize', () => closeRowMenu());
// ---------- the archive ----------
function archiveRow(run) {
  const label = runLabel(run), id = escapeHTML(run.id), match = view.archiveMatches?.get(run.id);
  const meta = [`${shortDate(run.createdAt)}, ${escapeHTML(run.status)}`, `archived ${shortDate(run.archived.at)}`, run.pin ? `pinned${run.pin.project ? ` in ${escapeHTML(run.pin.project)}` : ''}` : ''].filter(Boolean).join(' · ');
  const tags = run.pin?.tags?.length ? `<span class="history-tags">${run.pin.tags.map(t => `<span class="tag">${escapeHTML(t)}</span>`).join('')}</span>` : '';
  const found = showSnippet(run, match) ? `<p class="history-snippet"><em>${FIELD_LABELS[match.field] || 'Found'}:</em> ${highlight(match.snippet, view.archiveQuery)}</p>` : '';
  return `<article class="card archive-item"><div class="archive-main"><button type="button" class="archive-open" data-open-run="${id}"><span class="history-dot ${escapeHTML(run.status)}"></span><span>${highlight(label, view.archiveQuery)}</span></button><p class="archive-meta">${meta}</p>${tags}${found}</div><div class="archive-actions"><button type="button" class="button secondary" data-unarchive-run="${id}">Unarchive</button><button type="button" class="button danger" data-delete-archived="${id}">Delete</button></div></article>`;
}
function renderArchive() {
  const archived = state.runs.filter(r => r.archived).sort((a, b) => String(b.archived.at).localeCompare(String(a.archived.at)));
  $('archive-count').textContent = archived.length; $('archive-count').classList.toggle('hidden', !archived.length);
  if ($('archive').classList.contains('hidden')) return;
  const shown = archived.filter(r => !view.archiveMatches || view.archiveMatches.has(r.id));
  $('archive-search').classList.toggle('hidden', !archived.length);
  $('archive-summary').innerHTML = !archived.length ? '' : view.archiveMatches ? `${shown.length} of ${archived.length} archived ${archived.length === 1 ? 'meeting matches' : 'meetings match'}.` : `${archived.length} archived ${archived.length === 1 ? 'meeting' : 'meetings'}, most recently archived first.`;
  $('archive-list').innerHTML = shown.length ? shown.map(archiveRow).join('')
    : archived.length ? '<p class="empty-copy">No archived meetings match.</p>'
    : '<p class="empty-copy">Nothing is archived. Choose Archive from a meeting’s ⋯ menu in the history, or in the meeting itself, to keep it here out of the way.</p>';
  $('archive-list').querySelectorAll('[data-open-run]').forEach(b => b.onclick = () => loadRun(b.dataset.openRun));
  $('archive-list').querySelectorAll('[data-unarchive-run]').forEach(b => b.onclick = () => unarchiveRun(b.dataset.unarchiveRun));
  $('archive-list').querySelectorAll('[data-delete-archived]').forEach(b => b.onclick = () => confirmDelete(b.dataset.deleteArchived));
}
function applyArchive(id, archived) {
  for (const run of state.runs) if (run.id === id) run.archived = archived;
  if (currentRun?.id === id) { currentRun.archived = archived; renderRun(currentRun); }
  renderHistory(); refreshHistory().catch(() => {});
}
async function archiveRun(id) {
  try { const { archived } = await api(`/api/runs/${encodeURIComponent(id)}/archive`, 'PUT'); applyArchive(id, archived); toast('Archived. It is kept in full under Archive.'); }
  catch (error) { toast(error.message); }
}
async function unarchiveRun(id) {
  const run = state.runs.find(r => r.id === id) || (currentRun?.id === id ? currentRun : null);
  if (!run?.archived) return;
  // Back in the list it counts toward the limit again, so say first if that makes it the next to go.
  const leaves = expiring(state.runs.map(r => r.id === id ? { ...r, archived: null } : r), historyLimit()).has(id);
  if (leaves && !(await confirmAction({ title: 'Unarchive this meeting?', ok: 'Unarchive', body: `<p>It goes back to <strong>Recent meetings</strong> in date order.</p><p class="warn">It is older than your ${historyLimit()} most recent meetings, so when the next meeting starts it is deleted completely, as Delete would: its record, documents, and patches${run.workspace?.unappliedBranch ? `, and its unapplied branch ${escapeHTML(run.workspace.unappliedBranch)}` : ''}. Pin it to keep it, or leave it archived.</p>` }))) return;
  try {
    const result = await api(`/api/runs/${encodeURIComponent(id)}/archive`, 'DELETE'); applyArchive(id, null);
    toast(result.expiring ? 'Unarchived. It is deleted when the next meeting starts unless you pin it.' : run.pin ? 'Unarchived. It is back under Pinned.' : 'Unarchived. It is back in the meeting list.');
  } catch (error) { toast(error.message); }
}
function renderArchiveControls(run) {
  const archived = Boolean(run.archived);
  $('archive-run').classList.toggle('hidden', archived || run.status === 'running');
  $('run-archived').classList.toggle('hidden', !archived);
  if (!archived) return;
  $('run-archived-text').textContent = `Archived ${new Date(run.archived.at).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })}. It is kept in full and hidden from the meeting list. Unarchive it to resume or reconvene it.`;
  for (const id of ['resume', 'limit-form', 'reconvene-form']) $(id).classList.add('hidden');
}
$('archive-run').onclick = () => currentRun && archiveRun(currentRun.id);
$('unarchive-run').onclick = () => currentRun && unarchiveRun(currentRun.id);
// ---------- settings ----------
// The history keeps a number of meetings the owner picks, up to what the disk has room for, or as many as the disk safely holds.
// The dialog shows the arithmetic behind that room, and what a change would delete, before anything is saved.
const sizeText = bytes => bytes === null || bytes === undefined ? 'an unknown amount' : bytes < 1048576 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : bytes < 1073741824 ? `${(bytes / 1048576).toFixed(1)} MB` : `${(bytes / 1073741824).toFixed(1)} GB`;
const countText = n => Number(n).toLocaleString();
let settingsView = null;
const keepChoice = () => document.querySelector('input[name=history-keep]:checked')?.value;
// 'max', a valid number, or undefined while the number typed is not one the server would take.
function chosenLimit() {
  if (keepChoice() === 'max') return 'max';
  const value = Number($('history-limit').value), room = settingsView?.capacity?.room;
  return Number.isSafeInteger(value) && value >= 1 && (room === undefined || value <= room) ? value : undefined;
}
function updateSettingsPreview() {
  const limit = chosenLimit(), fits = settingsView?.capacity, preview = $('settings-preview');
  $('history-limit').classList.toggle('muted-input', keepChoice() === 'max');
  $('settings-save').disabled = limit === undefined;
  if (limit === undefined) {
    preview.className = 'settings-preview warn';
    preview.textContent = fits && Number($('history-limit').value) > fits.room ? `This disk has safe room for about ${countText(fits.room)} meetings. Choose up to that, or choose as many as the disk safely holds.` : 'Enter a whole number of meetings, at least 1.';
    return;
  }
  // The same rule the server applies at the next start: the setting, or fewer if the disk has no room for that many.
  const applied = Math.min(limit === 'max' ? Infinity : limit, fits ? fits.atNextStart : Infinity);
  const leaving = expiring(state.runs, applied).size;
  preview.className = `settings-preview${leaving ? ' warn' : ' hidden'}`;
  preview.textContent = leaving ? `${leaving} ${leaving === 1 ? 'meeting is' : 'meetings are'} past that limit and will be deleted, completely, when the next meeting starts. Pin or archive any you want to keep; they are marked in the history.` : '';
}
function renderSettings(view) {
  settingsView = view;
  const fits = view.capacity, { meetingsBytes, freeBytes, diskBytes } = view.storage, p = view.policy;
  const max = view.historyLimit === 'max';
  for (const input of document.querySelectorAll('input[name=history-keep]')) input.checked = input.value === (max ? 'max' : 'limit');
  $('history-limit').value = max ? Math.min(HISTORY_LIMIT, fits?.room || HISTORY_LIMIT) : view.historyLimit;
  if (fits) $('history-limit').max = fits.room; else $('history-limit').removeAttribute('max');
  $('history-limit-hint').textContent = fits ? `Up to ${countText(fits.room)}: what fits in the space meetings may use on this disk. The default is 30.` : 'The disk’s free space could not be read, so no upper limit applies. The default is 30.';
  $('history-max-hint').textContent = fits ? `About ${countText(fits.room)} right now. The number follows the free space: when room runs out, the history stops growing and each new meeting replaces the oldest unpinned one.` : 'The disk’s free space could not be read, so nothing is removed to make room.';
  $('settings-low').classList.toggle('hidden', !fits?.low);
  $('settings-low').textContent = fits?.low ? `Free space is low: meetings have no room left to grow on this disk, so the history is holding at its current size and each new meeting replaces the oldest unpinned one. Free some space, or pin or archive what you want to keep.` : '';
  $('settings-storage').textContent = `Meetings take ${sizeText(meetingsBytes)} on the host${freeBytes === null ? '.' : `; its disk has ${sizeText(freeBytes)} free${diskBytes ? ` of ${sizeText(diskBytes)}` : ''}.`}`;
  $('settings-math').classList.toggle('hidden', !fits);
  if (fits) $('settings-math-text').textContent = `Meetings may grow into at most ${Math.round(p.shareOfFree * 100)}% of the free space, and the disk always keeps ${sizeText(fits.reserveBytes)} free for everything else (${Math.round(p.reserveShare * 100)}% of its size, and never less than ${sizeText(p.reserveMinBytes)}). ${fits.growthBytes > 0 ? `That leaves ${sizeText(fits.growthBytes)} for new meetings.` : 'That leaves no room for new meetings.'} A meeting is counted at ${sizeText(fits.perMeetingBytes)}: the size of the largest tenth of the meetings here, and never less than ${sizeText(p.minMeetingBytes)}. That is room for ${countText(fits.more)} more on top of the ${countText(fits.room - fits.more)} the list holds now.`;
  updateSettingsPreview();
}
async function openSettings() {
  let view;
  try { view = await api('/api/settings'); } catch (error) { return toast(error.message); }
  state.settings = { historyLimit: view.historyLimit, effectiveLimit: view.effectiveLimit };
  $('settings-error').textContent = '';
  renderSettings(view);
  $('settings-dialog').showModal();
}
$('settings-button').onclick = openSettings;
document.querySelectorAll('input[name=history-keep]').forEach(input => input.onchange = updateSettingsPreview);
$('history-limit').addEventListener('input', () => { document.querySelector('input[name=history-keep][value=limit]').checked = true; updateSettingsPreview(); });
$('history-limit').addEventListener('focus', () => { document.querySelector('input[name=history-keep][value=limit]').checked = true; updateSettingsPreview(); });
$('settings-cancel').onclick = $('close-settings').onclick = () => $('settings-dialog').close();
$('settings-form').addEventListener('submit', async event => {
  event.preventDefault();
  const limit = chosenLimit(); if (limit === undefined) return;
  $('settings-save').disabled = true; $('settings-error').textContent = '';
  try {
    const saved = await api('/api/settings', 'PUT', { historyLimit: limit });
    state.settings = { historyLimit: saved.historyLimit, effectiveLimit: saved.effectiveLimit }; $('settings-dialog').close();
    await refreshHistory().catch(() => {});
    const kept = saved.historyLimit === 'max' ? `as many meetings as the disk safely holds${saved.room === null ? '' : `, about ${countText(saved.room)} right now`}` : `the ${countText(saved.historyLimit)} most recent meetings`;
    toast(`Saved. The history keeps ${kept}.${saved.expiring ? ` ${saved.expiring} will be deleted when the next meeting starts.` : ''}`);
  } catch (error) { $('settings-error').textContent = error.message; }
  finally { $('settings-save').disabled = false; }
});
// ---------- pinning ----------
// One dialog pins a meeting or edits a pinned meeting's tags and project, and unpins it. The pin is stored with the meeting on the
// server, so it survives restarts and shows on every paired device.
let pinTarget = null;
const parseTags = text => text.split(',').map(t => t.replace(/\s+/g, ' ').trim()).filter(Boolean);
function renderTagSuggestions() {
  const chosen = new Set(parseTags($('pin-tags').value).map(t => t.toLowerCase()));
  const known = [...new Set(state.runs.flatMap(r => r.pin?.tags || []))].filter(t => !chosen.has(t.toLowerCase())).sort(byName).slice(0, 16);
  $('pin-suggestions').classList.toggle('hidden', !known.length);
  $('pin-suggestions').innerHTML = known.length ? `<span>Tags in use:</span>${known.map(t => `<button type="button" class="tag tag-button" data-add-tag="${escapeHTML(t)}">${escapeHTML(t)}</button>`).join('')}` : '';
  $('pin-suggestions').querySelectorAll('[data-add-tag]').forEach(button => button.onclick = () => {
    $('pin-tags').value = [...parseTags($('pin-tags').value), button.dataset.addTag].join(', '); renderTagSuggestions(); $('pin-tags').focus();
  });
}
function openPin(id) {
  const run = currentRun?.id === id ? currentRun : state.runs.find(r => r.id === id);
  if (!run) return;
  pinTarget = id;
  $('pin-title').textContent = run.pin ? 'Pinned meeting' : 'Pin this meeting';
  const label = runLabel(run); $('pin-prompt').textContent = label.length > 400 ? label.slice(0, 400) + '…' : label;
  $('pin-project').value = run.pin?.project || ''; $('pin-tags').value = (run.pin?.tags || []).join(', ');
  $('project-options').innerHTML = projectsInUse().map(p => `<option value="${escapeHTML(p)}"></option>`).join('');
  $('pin-save').textContent = run.pin ? 'Save' : 'Pin meeting'; $('pin-save').disabled = false;
  $('pin-unpin').classList.toggle('hidden', !run.pin);
  $('pin-error').textContent = ''; renderTagSuggestions();
  $('pin-dialog').showModal(); $('pin-project').focus();
}
// The page shows the change at once; the history is then re-read for the server's view, including which meetings are now expiring.
function applyPin(id, pin) {
  for (const run of state.runs) if (run.id === id) run.pin = pin;
  if (currentRun?.id === id) { currentRun.pin = pin; renderPinControls(currentRun); }
  renderHistory(); refreshHistory().catch(() => {});
}
function renderPinControls(run) {
  $('pin-run').textContent = run.pin ? 'Edit pin' : 'Pin';
  const pin = run.pin;
  $('run-pin').classList.toggle('hidden', !pin);
  $('run-pin').innerHTML = pin ? `<span class="run-pin-label">${PIN_ICON(true)} Pinned</span>${pin.project ? `<span>Project: <strong>${escapeHTML(pin.project)}</strong></span>` : ''}${pin.tags.length ? `<span class="history-tags">${pin.tags.map(t => `<span class="tag">${escapeHTML(t)}</span>`).join('')}</span>` : ''}` : '';
}
function confirmAction({ title, body, ok }) {
  return new Promise(resolve => {
    const dialog = $('confirm-dialog'); let answer = false;
    $('confirm-title').textContent = title; $('confirm-body').innerHTML = body; $('confirm-ok').textContent = ok;
    $('confirm-form').onsubmit = event => { event.preventDefault(); answer = true; dialog.close(); };
    $('confirm-cancel').onclick = $('close-confirm').onclick = () => dialog.close();
    dialog.onclose = () => resolve(answer);
    dialog.showModal(); $('confirm-cancel').focus();
  });
}
async function unpinRun(id) {
  const run = state.runs.find(r => r.id === id) || (currentRun?.id === id ? currentRun : null);
  if (!run?.pin) return;
  // Unpinning clears the organization and puts the meeting back in date order, which may be past the limit: say so before it happens.
  const lost = [run.pin.project ? `its project, ${escapeHTML(run.pin.project)}` : '', run.pin.tags?.length ? `its ${run.pin.tags.length === 1 ? 'tag' : 'tags'} (${run.pin.tags.map(escapeHTML).join(', ')})` : ''].filter(Boolean);
  const leaves = !run.archived && expiring(state.runs.map(r => r.id === id ? { ...r, pin: null } : r), historyLimit()).has(id);
  if (lost.length || leaves) {
    const body = [`<p>It goes back to <strong>Recent meetings</strong> in date order.</p>`, lost.length ? `<p>Unpinning clears ${lost.join(' and ')}.</p>` : '', leaves ? `<p class="warn">It is older than your ${historyLimit()} most recent meetings, so when the next meeting starts it is deleted completely, as Delete would: its record, documents, and patches${run.workspace?.unappliedBranch ? `, and its unapplied branch ${escapeHTML(run.workspace.unappliedBranch)}` : ''}. Pin it again before then to keep it.</p>` : ''].join('');
    if (!(await confirmAction({ title: 'Unpin this meeting?', body, ok: 'Unpin' }))) return;
  }
  try {
    const result = await api(`/api/runs/${encodeURIComponent(id)}/pin`, 'DELETE');
    applyPin(id, null);
    toast(result.expiring ? 'Unpinned. It is deleted when the next meeting starts.' : 'Unpinned. It is back in Recent meetings.');
  } catch (error) { toast(error.message); refreshHistory().catch(() => {}); }
}
$('pin-form').addEventListener('submit', async event => {
  event.preventDefault();
  const id = pinTarget; if (!id) return;
  const wasPinned = Boolean((currentRun?.id === id ? currentRun : state.runs.find(r => r.id === id))?.pin);
  $('pin-save').disabled = true; $('pin-error').textContent = '';
  try {
    const { pin } = await api(`/api/runs/${encodeURIComponent(id)}/pin`, 'PUT', { project: $('pin-project').value, tags: parseTags($('pin-tags').value) });
    $('pin-dialog').close(); applyPin(id, pin);
    toast(wasPinned ? 'Saved.' : `Pinned${pin.project ? ` under ${pin.project}` : ''}. It stays at the top and is never removed to make room.`);
  } catch (error) { $('pin-error').textContent = error.message; $('pin-save').disabled = false; }
});
$('pin-tags').addEventListener('input', renderTagSuggestions);
$('pin-cancel').onclick = $('close-pin').onclick = () => $('pin-dialog').close();
$('pin-unpin').onclick = () => { const id = pinTarget; $('pin-dialog').close(); unpinRun(id); };
$('pin-dialog').addEventListener('close', () => { pinTarget = null; });
$('pin-run').onclick = () => currentRun && openPin(currentRun.id);
// ---------- renaming ----------
// The name is only how the meeting is listed and shown; the brief stays as the council read it. Saved on the server with the meeting.
let renameTarget = null;
function openRename(id) {
  const run = currentRun?.id === id ? currentRun : state.runs.find(r => r.id === id);
  if (!run) return;
  renameTarget = id;
  const brief = run.demo ? 'Scripted demo' : run.prompt;
  $('rename-title').textContent = run.title ? 'Rename meeting' : 'Name this meeting';
  $('rename-input').value = run.title || '';
  $('rename-brief').textContent = brief.length > 240 ? brief.slice(0, 240) + '…' : brief;
  $('rename-clear').classList.toggle('hidden', !run.title);
  $('rename-error').textContent = ''; $('rename-save').disabled = false;
  $('rename-dialog').showModal(); $('rename-input').select();
}
function applyTitle(id, title) {
  for (const run of state.runs) if (run.id === id) run.title = title;
  if (currentRun?.id === id) { currentRun.title = title; renderNameControls(currentRun); }
  renderHistory(); refreshHistory().catch(() => {});
}
function renderNameControls(run) {
  $('run-name-text').textContent = run.title || ''; $('run-name-text').classList.toggle('hidden', !run.title);
  $('rename-run').textContent = run.title ? 'Rename' : 'Name this meeting';
}
async function saveTitle(title) {
  const id = renameTarget; if (!id) return;
  $('rename-save').disabled = true; $('rename-error').textContent = '';
  try {
    const result = await api(`/api/runs/${encodeURIComponent(id)}/title`, 'PUT', { title });
    $('rename-dialog').close(); applyTitle(id, result.title);
    toast(result.title ? 'Renamed.' : 'Name removed. The meeting is listed by its brief again.');
  } catch (error) { $('rename-error').textContent = error.message; $('rename-save').disabled = false; }
}
$('rename-form').addEventListener('submit', event => { event.preventDefault(); saveTitle($('rename-input').value); });
$('rename-clear').onclick = () => saveTitle('');
$('rename-cancel').onclick = $('close-rename').onclick = () => $('rename-dialog').close();
$('rename-dialog').addEventListener('close', () => { renameTarget = null; });
$('rename-run').onclick = () => currentRun && openRename(currentRun.id);
// ---------- deleting a meeting ----------
// The dialog reads the full meeting first, so it can say exactly what goes: documents, patches, and a candidate branch that was never applied.
let pendingDelete = null, deleteBusy = false;
const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;
function deletionItems(run) {
  const ws = run.workspace, items = [];
  const sessions = run.sessions?.length ? `, across ${plural(run.sessions.length + 1, 'session')}` : '';
  items.push(`The meeting record: the brief, ${plural(run.entries?.length || 0, 'transcript entry', 'transcript entries')}, the votes, the objections, and the final answer${sessions}.`);
  const docs = run.attachments || [];
  if (docs.length && run.documents?.state !== 'removed') items.push(`${plural(docs.length, 'attached document')} and ${docs.length === 1 ? 'its' : 'their'} extracted text: ${docs.map(d => escapeHTML(d.name)).join(', ')}.`);
  const patches = (run.entries || []).filter(e => e.candidate?.artifact).length;
  if (patches) items.push(`${plural(patches, 'candidate patch file')} saved on the host.`);
  if (ws?.impl) items.push('<span class="warn">The implementer’s unfinished checkout, kept so the meeting could resume its partial work.</span>');
  if (ws?.branch && !ws.discarded) items.push(ws.applied
    ? `The candidate branch <code>${escapeHTML(ws.branch)}</code> in ${escapeHTML(ws.name)}. It was applied into ${escapeHTML(ws.applied.into)}, and that merge stays.`
    : `<span class="warn">The candidate branch <code>${escapeHTML(ws.branch)}</code> in ${escapeHTML(ws.name)}. It was never applied, so its changes are lost.</span>`);
  return items;
}
async function confirmDelete(id) {
  let run;
  try { run = await api(`/api/runs/${encodeURIComponent(id)}`); }
  catch (error) { toast(error.message); return refreshHistory().catch(() => {}); }
  if (run.status === 'running') return toast('This meeting is in session. Stop it first, then delete it.');
  if (run.pin) return toast('This meeting is pinned. Unpin it first, then delete it.');
  pendingDelete = run.id;
  const label = runLabel(run);
  $('delete-prompt').textContent = label.length > 400 ? label.slice(0, 400) + '…' : label;
  $('delete-items').innerHTML = deletionItems(run).map(item => `<li>${item}</li>`).join('');
  $('delete-keeps').textContent = `${run.workspace ? `Your working tree in ${run.workspace.name} is not touched. ` : ''}Exports and patches you already downloaded are not affected.`;
  $('delete-error').textContent = '';
  setDeleteBusy(false);
  $('delete-dialog').showModal(); $('delete-cancel').focus();
}
function setDeleteBusy(busy) {
  deleteBusy = busy;
  $('delete-confirm').disabled = $('delete-cancel').disabled = $('close-delete').disabled = busy;
  $('delete-confirm').textContent = busy ? 'Deleting…' : 'Delete permanently';
}
// Drops a meeting that no longer exists from the page: out of the history, and off the screen if it was the one shown.
function forgetRun(id) {
  state.runs = state.runs.filter(r => r.id !== id); view.matches?.delete(id); view.archiveMatches?.delete(id);
  if (currentRun?.id === id) newDiscussion(); else renderHistory();
  refreshHistory().catch(() => {});
}
$('delete-form').addEventListener('submit', async event => {
  event.preventDefault();
  const id = pendingDelete; if (!id || deleteBusy) return;
  setDeleteBusy(true); $('delete-error').textContent = '';
  try {
    const result = await api(`/api/runs/${encodeURIComponent(id)}`, 'DELETE');
    setDeleteBusy(false); $('delete-dialog').close(); forgetRun(id);
    toast(`Meeting deleted${result.removed?.branch ? `, with its branch ${result.removed.branch}` : ''}.`);
  } catch (error) { setDeleteBusy(false); $('delete-error').textContent = error.message; }
});
$('delete-cancel').onclick = $('close-delete').onclick = () => $('delete-dialog').close();
$('delete-dialog').addEventListener('cancel', event => { if (deleteBusy) event.preventDefault(); }); // Escape cannot hide a delete in flight
$('delete-dialog').addEventListener('close', () => { pendingDelete = null; });
$('delete-run').onclick = () => currentRun && confirmDelete(currentRun.id);
// Another window or a paired device may have deleted meetings: catch up whenever this tab comes back into view.
document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState !== 'visible' || !state.token) return;
  try { await refreshHistory(); } catch { return; }
  if (currentRun && currentRun.status !== 'running' && !state.runs.some(r => r.id === currentRun.id)) { newDiscussion(); toast('That meeting was deleted, so it is no longer shown.'); }
  // A pin changed from another window or device shows on the meeting in view, too.
  const shown = currentRun && state.runs.find(r => r.id === currentRun.id);
  if (shown && JSON.stringify(shown.pin || null) !== JSON.stringify(currentRun.pin || null)) { currentRun.pin = shown.pin; renderPinControls(currentRun); }
  if (shown && (shown.title || null) !== (currentRun.title || null)) { currentRun.title = shown.title; renderNameControls(currentRun); }
  if (shown && Boolean(shown.archived) !== Boolean(currentRun.archived)) { currentRun.archived = shown.archived; renderRun(currentRun); }
});
function markdown(text) {
  // Render a deliberately small Markdown subset; provider HTML is always escaped.
  return text.split(/(```[\s\S]*?```)/g).map(part => {
    if (part.startsWith('```')) return `<pre><code>${escapeHTML(part.replace(/^```[^\n]*\n?/, '').replace(/```$/, ''))}</code></pre>`;
    return escapeHTML(part).split('\n').map(line => {
      let formatted = line.replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
      const heading = formatted.match(/^(#{1,4}) (.*)$/);
      if (heading) return `<h${Math.min(heading[1].length + 1, 5)}>${heading[2]}</h${Math.min(heading[1].length + 1, 5)}>`;
      if (/^[-*] /.test(formatted)) return `<p class="md-list">• ${formatted.slice(2)}</p>`;
      return formatted ? `<p>${formatted}</p>` : '';
    }).join('');
  }).join('');
}
function selectTab(tab) {
  $('answer-layout').classList.toggle('hidden', tab !== 'answer'); $('answer').classList.toggle('hidden', tab !== 'answer'); $('transcript').classList.toggle('hidden', tab !== 'transcript');
  $('issues').classList.toggle('hidden', tab !== 'transcript' || !currentRun?.issues?.length);
  document.querySelectorAll('[data-tab]').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
}
const isMeeting = run => run.kind === 'meeting';
const who = (run, id) => id === 'owner' ? 'You' : run.participants.find(p => p.id === id)?.name || id || 'the group';
const elapsed = e => e.startedAt ? `${Math.max(0, Math.round((new Date(e.finishedAt || Date.now()) - new Date(e.startedAt)) / 1000))}s` : '';
function entryTag(run, e) {
  if (e.phase === 'opening') return 'Opening position';
  if (e.phase === 'floor') return e.speaker === 'owner' ? (e.reconvene ? `You reconvened the council, session ${e.session || 1}` : e.adjust ? 'You changed the settings' : 'You') : `Floor, cycle ${e.cycle}${(run.sessions?.length || (e.session || 1) > 1) ? `, session ${e.session || 1}` : ''}`;
  if (e.phase === 'draft') return `Candidate v${e.candidateVersion}`;
  if (e.phase === 'ratify') return `Ballot on v${e.candidateVersion}`;
  return e.phase === 'propose' ? 'Independent proposal' : e.phase === 'review' ? `Review, round ${e.round}` : 'Final synthesis';
}
function renderEntry(run, e) {
  const f = e.fields || {}, icon = e.status === 'complete' ? '✓' : e.status === 'running' ? '◌' : '!';
  const chips = [];
  if (e.phase === 'floor' && e.speaker !== 'owner' && f.stance) chips.push(`<span class="chip stance-${f.stance}">${f.stance}</span>`);
  if (e.phase === 'ratify' && f.vote) chips.push(`<span class="chip vote-${f.vote}">${f.vote}</span>`);
  if (e.superseded) chips.push('<span class="chip">superseded</span>');
  if (e.attempt > 1) chips.push(`<span class="chip">attempt ${e.attempt}</span>`);
  if (e.workspace) chips.push(`<span class="chip">${escapeHTML(e.workspace.level)} in ${escapeHTML(e.workspace.checkout)}</span>`);
  if (f.opinion) chips.push('<span class="chip opinion">opinion, no checks</span>');
  const meta = [];
  const citations = citationEvidence(run, e);
  if (citations.valid.length) meta.push(`Concedes ${citations.valid.map(c => `${entryLink(run, c.entry)} “${escapeHTML(c.quote)}”`).join('; ')}`);
  for (const c of [...citations.invalid, ...(f.invalidConcessions || [])]) meta.push(`<span class="citation-invalid">Citation not counted: ${escapeHTML(c.entry)} “${escapeHTML(c.quote)}” — ${escapeHTML(c.reason)}</span>`);
  for (const o of f.objections || []) meta.push(`Objects${o.against ? ` to ${escapeHTML(who(run, o.against))}` : ''}: “${escapeHTML(o.claim)}”${o.condition ? ` — resolves when ${escapeHTML(o.condition)}` : ''}`);
  if (f.resolves?.length) meta.push(`Resolves ${f.resolves.map(escapeHTML).join(', ')}`);
  if (f.settle) meta.push(`Would be settled by: ${escapeHTML(f.settle)}`);
  if (f.needs?.what) meta.push(`Needs ${escapeHTML(f.needs.what)}${f.needs.from ? ` from ${escapeHTML(who(run, f.needs.from))}` : ''}`);
  if (f.nominates) meta.push(`Nominates ${escapeHTML(who(run, f.nominates))}`);
  if (f.openPoints?.length) meta.push(`Open: ${f.openPoints.map(escapeHTML).join('; ')}`);
  if (f.unresolved?.length) meta.push(`Left unresolved: ${f.unresolved.map(escapeHTML).join(', ')}`);
  if (f.reason && e.phase === 'ratify') meta.push(escapeHTML(f.reason));
  if (e.candidateHash) meta.push(`Reviewed commit <code>${escapeHTML(e.candidateHash.slice(0, 12))}</code>`);
  if (e.note) meta.push(escapeHTML(e.note));
  let extras = '';
  if (e.candidate) {
    const c = e.candidate;
    const checkNote = c.checkStatus === 'running' ? 'Checks are running. Voting waits for the results.' : c.checkStatus === 'pending' ? 'Verification is unfinished. Checks must finish before voting or applying.' : !c.checks.length ? 'No checks configured; ballots on this candidate are opinions.' : '';
    extras += `<div class="candidate"><div><b>Candidate commit ${escapeHTML(c.hash.slice(0, 12))}</b> on ${escapeHTML(c.branch)}${c.changed ? '' : ' <span class="warn">(no file changes)</span>'}${c.artifact ? `. <a href="/api/runs/${run.id}/patch">Download patch</a>` : ''}</div>${c.files.length ? `<ul class="files">${c.files.map(fi => `<li><code>${escapeHTML(fi.status)}</code> ${escapeHTML(fi.path)}</li>`).join('')}</ul>` : ''}${c.patch ? `<details><summary>Patch (${c.bytes.toLocaleString()} bytes)</summary><pre>${escapeHTML(c.patch)}</pre></details>` : ''}${c.checks.length ? c.checks.map(k => `<details${k.code === 0 ? '' : ' open'}><summary>$ ${escapeHTML(k.command)} → ${k.code === 0 ? 'passed' : k.code === null ? 'could not run' : `exit ${k.code}`} (${k.seconds}s)</summary><pre>${escapeHTML(k.output)}</pre></details>`).join('') : ''}${checkNote ? `<div class="warn">${checkNote}</div>` : ''}</div>`;
  }
  if (e.actions?.length) extras += `<details class="activity"><summary>Activity: ${e.actions.length} tool event${e.actions.length === 1 ? '' : 's'}</summary><ul>${e.actions.map(a => `<li><code>${escapeHTML(a.type)}</code> ${a.command ? escapeHTML(a.command) : ''}${a.exitCode !== undefined && a.exitCode !== null ? ` → exit ${a.exitCode}` : ''}${a.paths?.length ? `, ${a.paths.map(escapeHTML).join(', ')}` : ''}</li>`).join('')}</ul></details>`;
  return `<article class="card msg ${e.speaker === 'owner' ? 'owner' : ''} ${e.reconvene || e.adjust ? 'reconvene' : ''} ${e.status} ${e.superseded ? 'superseded' : ''}" id="entry-${escapeHTML(e.id)}" data-entry="${escapeHTML(e.id)}" tabindex="-1"><header><span class="entry-status ${e.status}">${icon}</span><strong>${escapeHTML(who(run, e.speaker))}</strong><span>${entryTag(run, e)}${e.addressedOwner ? ', answering you' : ''}</span>${chips.join('')}<small>${escapeHTML(e.id)}, ${e.status === 'running' ? 'speaking' : e.status}, <span class="entry-elapsed" data-started="${e.status === 'running' && e.startedAt ? escapeHTML(e.startedAt) : ''}">${elapsed(e)}</span></small></header><div class="msg-body">${e.text ? markdown(e.text) : `<p>${escapeHTML(e.error || 'Speaking…')}</p>`}${meta.map(m => `<p class="entry-meta">${m}</p>`).join('')}${extras}</div></article>`;
}
function entryLink(run, id, label = id) {
  return run.entries.some(e => e.id === id) ? `<a href="#entry-${encodeURIComponent(id)}" data-jump-entry="${escapeHTML(id)}">${escapeHTML(label)}</a>` : escapeHTML(label);
}
function renderEvidence(run, result) {
  const panel = $('result-evidence'); panel.classList.toggle('hidden', !isMeeting(run));
  $('answer-layout').classList.toggle('without-evidence', !isMeeting(run));
  if (!isMeeting(run)) return;
  const { candidate, draft, ballots, openIssues } = result;
  const objections = [
    ...openIssues.map(i => `<li>${entryLink(run, i.entry, i.id)}: ${escapeHTML(i.claim)}<br><small>Resolves when: ${escapeHTML(i.condition)}</small></li>`),
    ...ballots.filter(b => b.fields?.vote === 'object').map(b => `<li>${entryLink(run, b.id, who(run, b.speaker))}: ${(b.fields.objections || []).length ? b.fields.objections.map(o => `${escapeHTML(o.claim)}<br><small>Resolves when: ${escapeHTML(o.condition)}</small>`).join('<br>') : escapeHTML(b.fields.reason || 'Unspecified objection')}</li>`),
    ...(draft?.fields?.unresolved || []).filter(id => !openIssues.some(i => i.id === id)).map(id => `<li>Candidate caveat: ${escapeHTML(id)}</li>`),
  ];
  const citations = run.entries.filter(e => e.status === 'complete' && !e.superseded && (e.session || 1) === (run.session || 1)).flatMap(e => citationEvidence(run, e).valid.map(c => `<li>“${escapeHTML(c.quote)}”<br><small>${entryLink(run, c.entry, `Source ${c.entry}`)} · ${entryLink(run, e.id, `${who(run, e.speaker)}'s concession`)}</small></li>`));
  const checks = candidate?.checks || [];
  panel.innerHTML = `<h3>Evidence and review</h3><p class="verdict verdict-${result.code}">${escapeHTML(result.label)}</p><p>${escapeHTML(result.verification)}</p>
    <h4>Candidate</h4><p>${draft ? entryLink(run, draft.id, candidate ? `Commit ${candidate.hash.slice(0, 12)} · v${draft.candidateVersion}` : `Text candidate v${draft.candidateVersion}`) : 'No candidate yet.'}</p>
    <h4>Votes</h4><ul>${ballots.map(b => `<li>${entryLink(run, b.id, who(run, b.speaker))}: ${escapeHTML(b.fields?.vote || 'abstain')}</li>`).join('')}</ul><p>${result.missingBallots} missing; ${result.votes.abstain} abstained.</p>
    <h4>Unresolved objections</h4>${objections.length ? `<ul>${objections.join('')}</ul>` : '<p>None recorded.</p>'}
    <h4>Check results</h4>${checks.map(c => `<details${c.code === 0 ? '' : ' open'}><summary>${escapeHTML(c.command)} — ${c.code === 0 ? 'passed' : c.code === null ? 'incomplete' : `exit ${c.code}`}</summary><pre>${escapeHTML(c.output)}</pre></details>`).join('') || `<p>${run.workspace?.checks?.length ? 'Waiting for configured checks.' : 'No automated checks configured.'}</p>`}
    <h4>Validated concessions</h4>${citations.length ? `<ul>${citations.join('')}</ul>` : '<p>No validated concession citations in this session.</p>'}<p class="field-hint">A matching quotation establishes traceability, not the truth of the claim.</p>`;
}
function renderUsage(run) {
  if (!run) return;
  const tokens = run.entries.reduce((sum, e) => sum + (e.usage?.input || 0) + (e.usage?.output || 0), 0);
  const seconds = Math.floor(elapsedBudget(run) / 1000), time = `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  $('usage').textContent = run.budget ? `Session ${run.session || 1}: ${callsUsed(run)} / ${run.budget.maxCalls} calls · ${time} / ${run.budget.maxDurationSeconds / 60} min${run.session > 1 ? ` · ${callsUsed(run, true)} calls overall` : ''}${tokens ? ` · ${tokens.toLocaleString()} reported tokens overall` : ''}` : `${callsUsed(run, true)} calls${tokens ? ` · ${tokens.toLocaleString()} reported tokens` : ''}`;
}
// The server publishes only when something changes, so a long turn would otherwise look frozen. Tick the clocks here instead.
setInterval(() => {
  try {
    if (currentRun?.status !== 'running') return;
    renderUsage(currentRun);
    for (const span of document.querySelectorAll('.entry-elapsed[data-started]:not([data-started=""])')) {
      span.textContent = `${Math.max(0, Math.round((Date.now() - new Date(span.dataset.started)) / 1000))}s`;
    }
    const waiting = currentRun.entries.filter(e => e.status === 'running');
    const longest = waiting.reduce((worst, e) => Math.max(worst, Date.now() - new Date(e.startedAt)), 0) / 1000;
    $('run-note').classList.toggle('hidden', !waiting.length);
    if (waiting.length) $('run-note').textContent = `Waiting on ${waiting.map(e => e.name).join(', ')} for ${Math.round(longest)}s of the ${currentRun.timeoutSeconds}s allowed for a turn.${currentRun.deepResearch && longest > 60 ? ' Deep research searches the web before answering, which takes minutes.' : ''}`;
  } catch (error) { console.error('clock', error); }
}, 1000);
document.addEventListener('click', event => {
  const link = event.target.closest('[data-jump-entry]');
  if (!link || !currentRun) return;
  event.preventDefault(); selectTab('transcript');
  const target = document.getElementById(`entry-${link.dataset.jumpEntry}`);
  if (target) {
    document.querySelectorAll('.linked-entry').forEach(e => e.classList.remove('linked-entry'));
    target.classList.add('linked-entry'); target.scrollIntoView({ behavior: 'smooth', block: 'center' }); target.focus({ preventScroll: true });
  }
});
function renderRun(run) {
  const changedSession = currentRun?.id !== run.id || currentRun?.session !== run.session;
  const wasShowingLimits = !$('limit-form').classList.contains('hidden');
  currentRun = run;
  $('discussion').classList.remove('hidden'); $('workspace').classList.add('run-view'); $('page-crumb').textContent = 'Discussion';
  const meeting = isMeeting(run);
  $('run-label').textContent = run.demo ? 'Scripted demo. No model calls.' : '';
  const titles = { opening: 'Members are writing their positions.', floor: 'The council has the floor.', draft: 'The drafter is writing the candidate.', check: 'Checking the candidate before voting.', ratify: 'Members are voting on the candidate.', propose: 'Independent ideas are taking shape.', review: 'The council is comparing notes.', synthesize: 'Bringing the best ideas together.' };
  const result = assessResult(run);
  $('run-title').textContent = run.status === 'complete' ? (meeting ? result.label : 'The discussion is complete.') : run.status === 'limited' ? 'Session limit reached.' : run.status === 'paused' ? 'Meeting paused.' : run.pauseRequested ? 'Pausing after this step.' : run.status === 'running' ? (titles[run.phase] || 'The council is thinking.') : `${meeting ? 'Meeting' : 'Discussion'} ${run.status}.`;
  $('floor-outcome').textContent = meeting && run.stopReason ? `Discussion closed: ${run.stopReason === 'budget' ? 'cycle budget reached' : run.stopReason}. Final candidate review is shown separately.` : '';
  $('run-prompt').textContent = run.prompt;
  $('cancel').classList.toggle('hidden', run.status !== 'running'); $('cancel').disabled = false;
  // The waiting line belongs to a meeting in session; a finished one must not keep the last turn's clock on screen.
  if (run.status !== 'running') $('run-note').classList.add('hidden');
  $('pause').classList.toggle('hidden', run.status !== 'running'); $('pause').disabled = Boolean(run.pauseRequested);
  $('pause').textContent = run.pauseRequested ? 'Pausing after this step' : 'Pause';
  const remaining = Math.max(0, (run.budget?.maxCalls || run.plannedCalls) - callsUsed(run));
  const stopped = meeting && ['failed', 'interrupted', 'cancelled', 'limited', 'paused'].includes(run.status);
  const needsLimits = stopped && (run.status === 'limited' || (run.budget && (callsUsed(run) >= run.budget.maxCalls || elapsedBudget(run) >= run.budget.maxDurationSeconds * 1000)));
  $('resume').classList.toggle('hidden', !stopped || needsLimits); $('resume').disabled = false;
  $('resume').textContent = run.phase === 'check' ? 'Retry candidate checks' : run.phase === 'draft' && run.stopReason ? 'Resume candidate preparation' : `Resume meeting (up to ${remaining} call${remaining === 1 ? '' : 's'})`;
  $('export').href = `/api/runs/${run.id}/export`;
  $('delete-run').classList.toggle('hidden', run.status === 'running');
  renderPinControls(run);
  renderNameControls(run);
  const ws = run.workspace;
  const docs = run.attachments || [], docState = run.documents?.state;
  $('run-documents').classList.toggle('hidden', !docs.length);
  if (docs.length) {
    const where = docState === 'removed' ? 'Removed from the host.' : docState === 'text-kept' ? 'The files are removed; their extracted text is kept on the host so this meeting can be resumed or reconvened.' : 'On the host until the meeting closes.';
    $('run-documents').innerHTML = `Documents: ${docs.map(a => `${escapeHTML(a.name)} (${a.chars ? a.chars.toLocaleString() + ' characters' : 'no text read'})`).join(', ')}. ${where}${docState === 'text-kept' && run.status !== 'running' ? ' <button type="button" class="text-button" id="remove-documents">Remove the text now</button>' : ''}`;
    const remove = $('remove-documents'); if (remove) remove.onclick = async () => { try { await api(`/api/runs/${run.id}/documents`, 'DELETE'); watchRun(await api(`/api/runs/${run.id}`)); toast('Removed. This meeting can no longer be resumed or reconvened.'); } catch (error) { toast(error.message); } };
  }
  $('run-workspace').classList.toggle('hidden', !ws && !run.research);
  $('run-workspace').classList.toggle('start-blocker', ws?.level === 'full-access');
  const research = run.research ? `Internet research on${run.deepResearch ? ', deep research on' : ''}: members may search the web` : '';
  if (!ws && run.research) $('run-workspace').textContent = research + '.';
  if (ws) $('run-workspace').textContent = [`Workspace ${ws.name}, ${ws.level === 'full-access' ? 'full access' : ws.level}`, ws.origin ? `a clone of ${ws.origin}` : '', ws.head ? `at commit ${ws.head.slice(0, 12)}` : '', ws.attachedFrom && ws.attachedFrom !== 'localhost' ? `attached from ${ws.attachedFrom}` : '', ws.branch ? `branch ${ws.branch}` : '', ws.network ? 'network on' : '', ws.applied ? `applied into ${ws.applied.into} at ${new Date(ws.applied.at).toLocaleTimeString()}` : ws.discarded ? 'branch discarded' : '', ws.measurement ? `blast radius ${ws.measurement.score ?? '?'} of 100` : '', (ws.canary?.detail || '').replace(/\.$/, ''), research].filter(Boolean).join('. ') + '.';
  const candidate = ws && [...run.entries].reverse().find(e => e.phase === 'draft' && e.status === 'complete' && !e.superseded && e.candidateVersion === run.candidateVersion && e.candidate)?.candidate;
  const canAct = Boolean(candidate) && run.status !== 'running' && !ws.applied && !ws.discarded;
  const checksFinished = candidate && (!candidate.checkStatus || candidate.checkStatus === 'complete') && candidate.checks.length === ws.checks.length && ws.checks.every((command, i) => candidate.checks[i].command === command && Number.isInteger(candidate.checks[i].code));
  $('apply').classList.toggle('hidden', !canAct || !checksFinished); $('discard').classList.toggle('hidden', !ws?.branch || run.status === 'running' || Boolean(ws.applied || ws.discarded)); $('apply').disabled = $('discard').disabled = false;
  if (canAct) $('apply').textContent = `Apply ${candidate.hash.slice(0, 8)} to ${ws.name}`;
  $('run-error').classList.toggle('hidden', !run.error); $('run-error').textContent = run.error || '';
  const steps = meeting ? [['opening', 'Opening'], ['floor', run.phase === 'floor' ? `Floor, cycle ${Math.min(run.cycles, run.floorCycle || 1 + Math.floor(run.entries.filter(e => e.phase === 'floor' && e.speaker !== 'owner' && e.status === 'complete' && !e.superseded && (e.session || 1) === (run.session || 1)).length / Math.max(1, run.participants.length - (run.dropped?.length || 0))))} of ${run.cycles}` : `Floor, ${run.cycles} cycle${run.cycles !== 1 ? 's' : ''}`], ['draft', 'Draft'], ...(ws && ws.level !== 'read-only' ? [['check', 'Checks']] : []), ['ratify', 'Ratify']] : [['propose', 'Independent proposals'], ['review', `${run.rounds} review round${run.rounds !== 1 ? 's' : ''}`], ['synthesize', 'Final synthesis']];
  const index = run.status === 'complete' ? steps.length : steps.findIndex(([phase]) => phase === run.phase);
  $('run-progress').innerHTML = steps.map(([, label], i) => `<div class="progress-step ${i < index ? 'done' : i === index ? 'current' : ''}"><span>${i < index ? '✓' : i + 1}</span>${label}</div>`).join('');
  $('entry-count').textContent = run.entries.length;
  renderUsage(run); renderEvidence(run, result);
  const citedConcessions = run.entries.filter(e => e.phase === 'floor' && e.status === 'complete' && !e.superseded && (e.session || 1) === (run.session || 1)).reduce((sum, e) => sum + citationEvidence(run, e).valid.length, 0);
  const metricsLine = run.record ? `<p class="record-line">${run.record.metrics.floorTurns} floor turns, ${run.record.metrics.stanceChanges} stance changes, ${citedConcessions} cited concessions, ${run.record.metrics.objectionsResolved} of ${run.record.metrics.objectionsRaised} objections resolved${run.record.metrics.ownerInterjections ? `, you spoke ${run.record.metrics.ownerInterjections} time${run.record.metrics.ownerInterjections === 1 ? '' : 's'}` : ''}.</p>` : '';
  const earlier = (run.sessions || []).length ? `<details class="earlier-sessions"><summary>Earlier sessions (${run.sessions.length})</summary>${run.sessions.map(s => `<section><h4>Session ${s.session}${s.stopReason ? `, closed by ${s.stopReason}` : s.status ? `, ${s.status}` : ''}</h4>${s.final ? markdown(s.final) : '<p>No final answer.</p>'}</section>`).join('')}</details>` : '';
  $('answer').innerHTML = run.final ? metricsLine + markdown(run.final) + earlier : `<div class="answer-waiting"><span class="${run.status === 'running' ? 'thinking-symbol' : ''}">◈</span><h3>${run.status === 'running' ? (meeting ? 'The meeting is in session.' : 'Good answers are worth a conversation.') : 'The thread is saved.'}</h3><p>${run.status === 'running' ? `Open the ${meeting ? 'Meeting' : 'Discussion'} tab to follow each contribution as it arrives${meeting ? ', or speak to the council below' : ''}.` : 'Review the transcript for completed contributions and connection errors.'}</p></div>`;
  if (!run.final && run.status !== 'running' && result.draft) $('answer').innerHTML = '<p class="notice">Unfinished candidate — review is not complete.</p>' + markdown(result.draft.text) + earlier;
  if (meeting) $('transcript').innerHTML = run.entries.map(e => renderEntry(run, e)).join('');
  else {
    const openEntries = new Set([...$('transcript').querySelectorAll('details[open]')].map(el => el.dataset.entry));
    $('transcript').innerHTML = run.entries.map(e => `<details class="card transcript-entry" data-entry="${e.id}" ${openEntries.has(e.id) || e.status === 'failed' ? 'open' : ''}><summary><span class="entry-status ${e.status}">${e.status === 'complete' ? '✓' : e.status === 'running' ? '◌' : '!'}</span><strong>${escapeHTML(e.name)}</strong><span>${entryTag(run, e)}</span><small>${escapeHTML(e.status)}</small></summary><div class="entry-body">${e.text ? markdown(e.text) : `<p>${escapeHTML(e.error || 'Waiting for this model’s response…')}</p>`}</div></details>`).join('');
  }
  const issues = run.issues || [];
  $('issues').classList.toggle('hidden', !meeting || !issues.length || $('transcript').classList.contains('hidden'));
  $('issues').innerHTML = `<h3>Objections</h3>` + issues.map(i => `<div class="issue"><b>${escapeHTML(i.id)}</b><span>${escapeHTML(who(run, i.raisedBy))} → ${escapeHTML(who(run, i.against))}: “${escapeHTML(i.claim)}”<br>Resolves when ${escapeHTML(i.condition)}</span><span class="chip ${issueStatus(run, i) === 'open' ? 'vote-object' : 'vote-approve'}" title="${issueStatus(run, i) === 'withdrawn' ? 'Its author voted to approve the candidate' : ''}">${issueStatus(run, i)}</span></div>`).join('');
  $('say-form').classList.toggle('hidden', !meeting || run.status !== 'running');
  $('reconvene-form').classList.toggle('hidden', !meeting || run.demo || run.status === 'running' || !run.floorStarted); $('reconvene-form').querySelector('button').disabled = false;
  $('limit-form').classList.toggle('hidden', !stopped);
  $('limit-form').querySelector('h3').textContent = needsLimits ? 'Raise the limits and resume' : 'Adjust and resume';
  if (stopped && (changedSession || !wasShowingLimits)) fillAdjustForm(run);
  if (changedSession) { $('reconvene-max-calls').value = ''; $('reconvene-duration').value = Math.ceil((run.budget?.maxDurationSeconds || 3600) / 60); }
  $('say-note').textContent = run.pendingOwner?.length ? `${run.pendingOwner.length} message${run.pendingOwner.length === 1 ? '' : 's'} queued for the next turn.` : 'Delivered at the next turn. The next member must address you.';
  renderArchiveControls(run); // last: an archived meeting hides resume and reconvene shown above
  updateEstimate();
}
// The adjust panel starts from what the meeting is running with now, so submitting it unchanged changes nothing.
function fillAdjustForm(run) {
  const ws = run.workspace;
  $('adjust-workspace').classList.toggle('hidden', !ws);
  if (ws) {
    for (const input of document.querySelectorAll('input[name=adjust-level]')) input.checked = input.value === ws.level;
    $('adjust-network').checked = Boolean(ws.network); $('adjust-network').disabled = ws.level === 'read-only';
    $('adjust-claude-sandbox').checked = ws.claudeSandbox !== false;
    $('adjust-checks').value = (ws.checks || []).join('\n');
    $('adjust-timeout').value = ws.implementTimeout || 900;
    adjustLevelChanged();
  }
  $('adjust-research').checked = run.research === true; $('adjust-deep-research').checked = run.deepResearch === true;
  $('adjust-timeout-seconds').value = run.timeoutSeconds;
  $('adjust-cycles').value = String(run.cycles); $('adjust-revisions').value = String(run.maxRevisions ?? 1);
  $('adjust-cycles-hint').classList.toggle('hidden', run.stopReason !== 'budget');
  if (run.budget) { $('resume-max-calls').value = run.budget.maxCalls; $('resume-duration').value = Math.ceil(run.budget.maxDurationSeconds / 60); }
  $('adjust-note').value = '';
}
function adjustLevel() { return document.querySelector('input[name=adjust-level]:checked')?.value || 'read-only'; }
function adjustLevelChanged() {
  const level = adjustLevel();
  $('adjust-full-ack').classList.toggle('hidden', level !== 'full-access');
  // Moving a read-only meeting to a write level is the first time uncommitted work matters, so it is acknowledged here.
  $('adjust-dirty-ack').classList.toggle('hidden', level === 'read-only' || currentRun?.workspace?.level !== 'read-only');
  if (level === 'full-access') { $('adjust-network').checked = true; $('adjust-network').disabled = true; }
  else $('adjust-network').disabled = level === 'read-only';
  if (level === 'read-only') $('adjust-network').checked = false;
}
document.querySelectorAll('input[name=adjust-level]').forEach(input => input.onchange = adjustLevelChanged);
// Deep research needs the web: ticking it turns internet research on, and turning that off turns deep research off with it.
function linkResearch(web, deep, timeout) {
  $(deep).onchange = () => {
    if ($(deep).checked) $(web).checked = true;
    // Searching before answering takes minutes, not seconds; a three-minute turn limit cuts the member off mid-search.
    if ($(deep).checked && timeout && Number($(timeout).value) < 900) { $(timeout).value = 900; toast('Turn limit raised to 15 minutes: deep research needs minutes per turn.'); }
    saveDraft();
  };
  $(web).onchange = () => { if (!$(web).checked) $(deep).checked = false; saveDraft(); };
}
linkResearch('research', 'deep-research', 'timeout'); linkResearch('adjust-research', 'adjust-deep-research', 'adjust-timeout-seconds');
function watchRun(run) {
  events?.close(); renderRun(run); selectTab(['complete', 'limited'].includes(run.status) ? 'answer' : 'transcript');
  if (run.status !== 'running') return;
  events = new EventSource(`/api/runs/${run.id}/events`);
  events.onmessage = event => {
    const parsed = JSON.parse(event.data);
    if (parsed.deleted) { events.close(); forgetRun(parsed.id); return toast('That meeting was deleted, so it is no longer shown.'); }
    const value = parsed, wasRunning = currentRun?.status === 'running'; renderRun(value);
    // A run watched to completion lands on its answer; a failure stays on the transcript where the error is open.
    if (wasRunning && ['complete', 'limited'].includes(value.status)) selectTab('answer');
    if (value.status !== 'running') { events.close(); refreshHistory().catch(error => toast(error.message)); }
  };
  events.onerror = () => { $('run-error').classList.remove('hidden'); $('run-error').textContent = 'Reconnecting to the local server…'; };
}
async function loadRun(id) {
  try { const run = await api(`/api/runs/${id}`); showPage('workspace'); watchRun(run); renderHistory(); $('discussion').scrollIntoView({ behavior: 'smooth', block: 'start' }); }
  catch (error) { toast(error.message); refreshHistory().catch(() => {}); } // it may have been deleted elsewhere
}
async function startRun(demo = false) {
  if (!demo && !$('prompt').value.trim()) { $('prompt').focus(); return toast('Describe what you want your council to work on.'); }
  if (!demo && (state.attachments || []).some(a => a.uploading)) return toast('Wait for the documents to finish uploading.');
  $('start').disabled = true; $('demo').disabled = true;
  try {
    const run = await api('/api/runs', 'POST', { prompt: demo ? '' : $('prompt').value.trim(), participantIds: [...state.selected], drafterId: $('synthesizer').value, neutralDrafter: !demo && Boolean($('neutral-drafter')?.checked), cycles: Number($('rounds').value), maxTokens: Number($('max-tokens').value), timeoutSeconds: Number($('timeout').value), revisions: Number($('revisions')?.value ?? 1), research: !demo && $('research').checked, deepResearch: !demo && $('deep-research').checked, maxCalls: demo || !$('max-calls').value ? undefined : Number($('max-calls').value), maxDurationSeconds: demo ? 3600 : Number($('duration').value) * 60, demo, workspace: demo ? undefined : workspacePayload(), attachmentIds: demo ? undefined : (state.attachments || []).filter(a => a.id).map(a => a.id) });
    if (!demo && run.attachments?.length) { state.attachments = []; renderAttachments(); }
    showPage('workspace'); watchRun(run); await refreshHistory(); $('discussion').scrollIntoView({ behavior: 'smooth', block: 'start' });
    if (!demo && run.workspace) api('/api/workspace').then(config => { state.workspaceConfig = config; workspaceSetup(); }).catch(() => {}); // the workspace just became a recent
  } catch (error) { toast(error.message); } finally { $('demo').disabled = false; updateEstimate(); }
}
function newDiscussion() {
  events?.close();
  // Clear the brief only when it was already submitted as the shown run; an unrelated draft survives a look at history.
  if (currentRun && $('prompt').value.trim() === currentRun.prompt) $('prompt').value = '';
  currentRun = null; $('workspace').classList.remove('run-view'); $('discussion').classList.add('hidden'); $('prompt').dispatchEvent(new Event('input')); showPage('workspace'); updateEstimate(); renderHistory(); window.scrollTo({ top: 0, behavior: 'smooth' }); $('prompt').focus();
}
// Model suggestions come from the Codex catalog the CLI publishes and the Claude list the app knows; free text is always allowed.
function modelOptions(type) {
  if (type === 'codex-cli') return state.clis.codex?.models || [];
  if (type === 'claude-cli' || type === 'anthropic') return (state.clis.claude?.models || []).filter(m => type === 'claude-cli' || m.id.startsWith('claude-'));
  return [];
}
function applyPreset() {
  const preset = (state.presets || []).find(p => p.id === $('provider-preset').value);
  if (!preset) return;
  $('provider-url').value = preset.baseUrl; if (!$('provider-name').value) $('provider-name').value = preset.label.replace(/ \(.*\)$/, '');
  $('model-hint').textContent = preset.hint;
}
function formType() {
  const type = $('provider-type').value, cli = state.types[type].cli;
  $('model-options').innerHTML = modelOptions(type).map(m => `<option value="${escapeHTML(m.id)}">${escapeHTML(m.label && m.label !== m.id ? `${m.label}${m.description ? ' — ' + m.description : ''}` : m.description || '')}</option>`).join('');
  $('preset-label').classList.toggle('hidden', type !== 'compatible');
  $('provider-preset').innerHTML = '<option value="">Custom endpoint</option>' + (state.presets || []).filter(p => p.type === 'compatible').map(p => `<option value="${escapeHTML(p.id)}">${escapeHTML(p.label)}</option>`).join('');
  $('api-key-label').classList.toggle('hidden', cli); $('clear-key-label').classList.toggle('hidden', cli || !editingId);
  $('base-url-label').classList.toggle('hidden', type !== 'compatible'); $('provider-url').required = type === 'compatible'; $('provider-model').required = !cli;
  $('provider-model').placeholder = cli ? 'Blank uses the CLI default model' : 'Exact model ID from your provider';
  const options = modelOptions(type);
  $('model-hint').textContent = cli ? `Uses your installed ${type === 'codex-cli' ? 'codex' : 'claude'} tool and its active sign-in. ${options.length ? 'Pick a model from the list or type any ID the tool accepts; blank uses its default.' : 'Blank uses the tool’s default model.'}` : type === 'huggingface' ? (state.presets || []).find(p => p.id === 'huggingface')?.hint || '' : 'Use a model available to your API account. Model IDs are editable so you can use new releases.';
}
function openProvider(id, duplicateOf) {
  editingId = id || null; $('provider-form').reset(); $('provider-error').textContent = '';
  $('dialog-title').textContent = id ? 'Edit connection' : duplicateOf ? 'Add another model' : 'Add a connection';
  $('delete-connection').classList.toggle('hidden', !id);
  $('provider-type').innerHTML = Object.entries(state.types).map(([value, t]) => `<option value="${value}">${escapeHTML(t.label)}</option>`).join('');
  const p = state.providers.find(p => p.id === (id || duplicateOf));
  if (p) { $('provider-type').value = p.type; $('provider-name').value = duplicateOf ? `${p.name} ` : p.name; $('provider-model').value = duplicateOf ? '' : p.model; $('provider-url').value = p.baseUrl || ''; $('provider-role').value = p.role; }
  else $('provider-type').value = 'openai';
  $('provider-key').placeholder = id && p?.hasKey ? 'Leave blank to keep your saved key' : duplicateOf && p?.hasKey ? 'Paste the key again for this connection (keys are never copied)' : 'Paste an API key (or use a server environment key)';
  archetypeSetup(); $('provider-role').dispatchEvent(new Event('input'));
  formType(); if (duplicateOf) { $('provider-model').focus(); }
  $('provider-dialog').showModal();
}
$('provider-form').addEventListener('submit', async event => {
  event.preventDefault(); const button = event.submitter; button.disabled = true;
  try {
    const data = { type: $('provider-type').value, name: $('provider-name').value, model: $('provider-model').value, baseUrl: $('provider-url').value, apiKey: $('provider-key').value, clearKey: $('clear-key').checked, role: $('provider-role').value };
    const saved = await api(editingId ? `/api/providers/${editingId}` : '/api/providers', editingId ? 'PUT' : 'POST', data);
    if (editingId) state.providers = state.providers.map(p => p.id === editingId ? saved : p); else { state.providers.push(saved); if (state.selected.size < 6) state.selected.add(saved.id); }
    $('provider-key').value = ''; $('provider-dialog').close(); renderProviders(); toast('Connection saved.');
  } catch (error) { $('provider-error').textContent = error.message; } finally { button.disabled = false; }
});
$('delete-connection').onclick = async () => {
  try { await api(`/api/providers/${editingId}`, 'DELETE'); state.providers = state.providers.filter(p => p.id !== editingId); $('provider-dialog').close(); renderProviders(); toast('Connection removed.'); }
  catch (error) { $('provider-error').textContent = error.message; }
};
$('provider-dialog').addEventListener('close', () => { $('provider-key').value = ''; });
$('provider-type').onchange = formType; $('provider-preset').onchange = applyPreset; $('close-dialog').onclick = () => $('provider-dialog').close();
$('connections-nav').onclick = $('manage-connections').onclick = () => showPage('connections'); $('workspace-nav').onclick = () => showPage('workspace'); $('security-nav').onclick = () => showPage('security'); $('archive-nav').onclick = () => showPage('archive');
// ---------- security page ----------
let securityEvents;
const scoreClass = s => s === null || s === undefined ? '' : s <= 30 ? 'ok' : s <= 60 ? 'warn' : 'bad';
async function loadSecurity() {
  const data = await api('/api/security'); state.security = data;
  $('security-off').classList.toggle('hidden', data.agentsec);
  if (data.vendored) { for (const id of ['agentsec-install-note', 'security-install-note']) $(id).innerHTML = `Unpacks the bundle shipped with this app (agentsec-pack ${escapeHTML(data.vendored.version)}, ${escapeHTML(data.vendored.commit.slice(0, 8))}, packaged ${escapeHTML(data.vendored.date.slice(0, 10))}) into <code>~/agentsec-pack</code> on the host and creates its Python environment. Takes about a minute.`; }
  renderSecurity();
  if (!securityEvents) {
    securityEvents = new EventSource('/api/security/events');
    securityEvents.onmessage = event => { const value = JSON.parse(event.data); if (value.type === 'finished') { state.security.results = [value.result, ...(state.security.results || []).filter(r => r.id !== value.result.id)]; state.security.running = null; toast(`${value.result.label}: ${value.result.available ? `blast radius ${value.result.score ?? '?'}/100` : value.result.detail}`); } else if (value.type === 'started') state.security.running = value.job; else if (value.type === 'status') Object.assign(state.security, { running: value.running, queued: value.queued }); renderSecurity(); };
  }
}
function renderSecurity() {
  const data = state.security || { profiles: [], results: [], presets: [] };
  $('security-status').textContent = data.running ? `Measuring ${data.running.label}` : data.queued?.length ? `${data.queued.length} queued` : 'Idle';
  const latest = (providerId, mode) => (data.results || []).find(r => r.providerId === providerId && r.mode === mode);
  $('member-boundaries').innerHTML = data.profiles.map(row => {
    const r = latest(row.providerId, row.mode);
    const score = r ? (r.available ? `<span class="score ${scoreClass(r.score)}">${r.score ?? '?'}</span>` : '<span class="score warn">—</span>') : '<span class="score"></span>';
    const detail = r ? `<small>${escapeHTML(r.detail || '')}${r.secrets?.filter(s => s.readable).length ? ` Readable: ${r.secrets.filter(s => s.readable).map(s => escapeHTML(s.path)).join(', ')}.` : ''}</small>` : '<small>Not measured yet.</small>';
    const busy = data.running && data.running.label === `${row.name} (${row.mode})`;
    return `<div class="boundary"><div><strong>${escapeHTML(row.name)}</strong><small>${escapeHTML(row.model || row.type)}</small></div><span class="mode">${escapeHTML(row.mode)}</span><div>${escapeHTML(row.boundary)}${detail}</div><div>${score} ${row.measurable ? `<button type="button" class="text-button" data-measure="${escapeHTML(row.providerId)}" data-mode="${escapeHTML(row.mode)}" ${busy ? 'disabled' : ''}>${busy ? 'Measuring…' : r ? 'Measure again' : 'Measure'}</button>` : ''}</div></div>`;
  }).join('');
  $('member-boundaries').querySelectorAll('[data-measure]').forEach(b => b.onclick = async () => { b.disabled = true; try { await api('/api/security/run', 'POST', { kind: 'member', providerId: b.dataset.measure, mode: b.dataset.mode }); toast('Queued. Results appear here when the measurement finishes.'); } catch (error) { toast(error.message); b.disabled = false; } });
  const current = $('lab-preset').value;
  $('lab-preset').innerHTML = (data.presets || []).map(p => `<option value="${escapeHTML(p.name)}" ${p.available ? '' : 'disabled'}>${escapeHTML(p.name)}${p.available ? '' : ` (needs ${escapeHTML(p.needs)})`}</option>`).join('');
  if (current) $('lab-preset').value = current;
  labPresetChanged();
  $('security-results').innerHTML = (data.results || []).map(r => `<div class="result"><header><span class="score ${r.available ? scoreClass(r.score) : 'warn'}">${r.available ? `${r.score ?? '?'}/100` : 'no result'}</span><strong>${escapeHTML(r.label)}</strong><span class="chip">${escapeHTML(r.kind)}</span>${r.selfMeasured ? '<span class="chip opinion">member measured itself</span>' : ''}<small>${new Date(r.at).toLocaleString()}</small><button type="button" class="text-button danger" data-remove="${r.id}">Remove</button></header><small>${escapeHTML(r.detail || '')}</small>${r.findings?.length ? `<ul>${r.findings.map(f => `<li><b>${escapeHTML(f.severity)}</b> ${escapeHTML(f.id)} ${escapeHTML(f.title)}</li>`).join('')}</ul>` : ''}${r.secrets?.filter(s => s.readable).length ? `<small>Readable from inside: ${r.secrets.filter(s => s.readable).map(s => escapeHTML(s.path)).join(', ')}</small>` : ''}</div>`).join('') || '<p class="empty-copy">No measurements yet.</p>';
  $('security-results').querySelectorAll('[data-remove]').forEach(b => b.onclick = async () => { try { await api(`/api/security/results/${b.dataset.remove}`, 'DELETE'); state.security.results = state.security.results.filter(r => r.id !== b.dataset.remove); renderSecurity(); } catch (error) { toast(error.message); } });
}
function labPresetChanged() {
  const preset = (state.security?.presets || []).find(p => p.name === $('lab-preset').value);
  $('lab-image-label').classList.toggle('hidden', preset?.kind !== 'container');
  $('lab-rationale').textContent = preset?.rationale || '';
}
// Installing agentsec-pack from the page: one job, its log streamed into the box the button lives in.
async function installAgentsec(button, logBox) {
  button.disabled = true; logBox.classList.remove('hidden'); logBox.textContent = 'Starting…\n';
  try {
    const job = await api('/api/security/install', 'POST');
    const events = new EventSource('/api/security/events');
    events.onmessage = async event => {
      const value = JSON.parse(event.data);
      if (value.type === 'log' && value.id === job.id) { logBox.textContent += value.line + '\n'; logBox.scrollTop = logBox.scrollHeight; }
      if (value.type === 'finished' && value.result.id === job.id) {
        events.close(); logBox.textContent += (value.result.available ? 'Done. ' : 'Failed. ') + value.result.detail + '\n'; button.disabled = false;
        if (value.result.available) { toast(value.result.detail); try { state.workspaceConfig = await api('/api/workspace'); workspaceSetup(); } catch {} if (!$('security').classList.contains('hidden')) loadSecurity().catch(() => {}); }
      }
    };
  } catch (error) { toast(error.message); logBox.textContent += error.message + '\n'; button.disabled = false; }
}
$('agentsec-install').onclick = () => installAgentsec($('agentsec-install'), $('agentsec-install-log'));
$('security-install').onclick = () => installAgentsec($('security-install'), $('security-install-log'));
$('lab-preset').onchange = labPresetChanged;
$('lab-run').onclick = async () => {
  $('lab-run').disabled = true;
  try { await api('/api/security/run', 'POST', { kind: 'preset', preset: $('lab-preset').value, image: $('lab-image').value.trim() }); toast('Queued. Container runs can take a few minutes.'); }
  catch (error) { toast(error.message); } finally { $('lab-run').disabled = false; }
};
$('add-connection').onclick = () => openProvider(); $('new-discussion').onclick = newDiscussion;
$('help-button').onclick = () => $('help-dialog').showModal(); $('theme-toggle').onclick = () => window.meshTheme?.toggle(); $('close-help').onclick = () => $('help-dialog').close();
$('lan-button').onclick = async () => {
  try { const access = await api('/api/access'); $('lan-code').value = access.pairingCode; $('lan-urls').innerHTML = access.urls.map(url => `<p><a href="${escapeHTML(url)}" target="_blank" rel="noreferrer">${escapeHTML(url)} ↗</a></p>`).join('') || '<p>No LAN address was detected. Restart the app after connecting to your network.</p>'; $('lan-dialog').showModal(); }
  catch (error) { toast(error.message); }
};
$('close-lan').onclick = () => $('lan-dialog').close();
$('rotate-lan-code').onclick = async () => { try { const access = await api('/api/access/rotate', 'POST'); $('lan-code').value = access.pairingCode; toast('Pairing code rotated. Every paired device must enter the new code.'); } catch (error) { toast(error.message); } };
$('lan-dialog').addEventListener('close', () => { $('lan-code').value = ''; });
$('copy-lan-code').onclick = async () => { try { await navigator.clipboard.writeText($('lan-code').value); toast('Pairing code copied.'); } catch { $('lan-code').select(); toast('Select and copy the code with your keyboard.'); } };
$('prompt').oninput = () => { $('char-count').textContent = `${$('prompt').value.length.toLocaleString()} / 24,000`; saveDraft(); };
$('rounds').onchange = $('revisions').onchange = $('max-calls').oninput = $('duration').oninput = () => { updateEstimate(); saveDraft(); };
$('synthesizer').onchange = $('max-tokens').onchange = $('timeout').onchange = saveDraft;
$('reconvene-form').addEventListener('submit', async event => {
  event.preventDefault(); const text = $('reconvene-text').value.trim(); if (!text || !currentRun) return;
  const button = event.submitter; button.disabled = true;
  try { const run = await api(`/api/runs/${currentRun.id}/reconvene`, 'POST', { text, cycles: Number($('reconvene-cycles').value), maxCalls: $('reconvene-max-calls').value ? Number($('reconvene-max-calls').value) : undefined, maxDurationSeconds: Number($('reconvene-duration').value) * 60 }); $('reconvene-text').value = ''; watchRun(run); renderHistory(); toast(`Session ${run.session} is open. The next member will address you.`); }
  catch (error) { toast(error.message); button.disabled = false; }
});
$('say-form').addEventListener('submit', async event => {
  event.preventDefault(); const text = $('say-text').value.trim(); if (!text || !currentRun) return;
  const button = event.submitter; button.disabled = true;
  try { await api(`/api/runs/${currentRun.id}/say`, 'POST', { text }); $('say-text').value = ''; toast('Delivered. The next member will address you.'); }
  catch (error) { toast(error.message); } finally { button.disabled = false; }
});
$('repo-clone').onclick = async () => {
  const button = $('repo-clone'), url = $('repo-url').value.trim();
  if (!url) { $('repo-url').focus(); return toast('Enter the https address of a repository.'); }
  button.disabled = true; button.textContent = 'Cloning…';
  try {
    const repo = await api('/api/workspace/clone', 'POST', { url });
    state.repo = repo; $('repo-url').value = '';
    $('workspace-path').value = repo.path; saveDraft();
    toast(`${repo.name} at ${repo.head.slice(0, 8)}${repo.updated ? ' (updated an existing clone)' : ''}. Attached read-only.`);
    if (!levelValue()) document.querySelector('input[name=workspace-level][value=read-only]').checked = true;
    $('workspace-inspect').click();
    try { state.workspaceConfig = await api('/api/workspace'); workspaceSetup(); } catch {}
  } catch (error) { toast(error.message); }
  finally { button.disabled = false; button.textContent = 'Clone and attach'; }
};
// Report templates: only useful once the council has something to read, so they appear with the workspace.
function playbookSetup() {
  $('playbook').innerHTML = '<option value="">Write my own brief</option>' + PLAYBOOKS.map(p => `<option value="${p.id}">${escapeHTML(p.label)}</option>`).join('');
  $('playbook').onchange = () => {
    const chosen = PLAYBOOKS.find(p => p.id === $('playbook').value);
    $('playbook-note').classList.toggle('hidden', !chosen);
    if (!chosen) return;
    $('playbook-note').textContent = `${chosen.summary} Edit the brief before you start; it is yours now.`;
    // A clone's folder carries the owner as well, so the brief uses the repository's own name when this is that clone.
    const info = state.workspaceInfo || {}, repo = state.repo?.path === $('workspace-path').value.trim() ? state.repo : null;
    $('prompt').value = buildPlaybook(chosen.id, { name: repo?.name || info.name || '', head: info.head || repo?.head || '', origin: repo?.url || info.origin || '' });
    $('prompt').dispatchEvent(new Event('input')); $('prompt').focus();
    if (!levelValue()) { document.querySelector('input[name=workspace-level][value=read-only]').checked = true; workspaceLevelChanged(); toast('Level set to read-only so members can read the code.'); }
  };
}
$('workspace-browse').onclick = () => { if (!$('browser').classList.contains('hidden')) return $('browser').classList.add('hidden'); browseTo($('workspace-path').value.trim() || state.workspaceConfig?.browseStart || ''); };
$('budget-save').onclick = async () => { try { const { maxScore } = await api('/api/workspace/budget', 'POST', { maxScore: $('workspace-budget').value.trim() === '' ? null : Number($('workspace-budget').value) }); state.workspaceConfig = { ...(state.workspaceConfig || {}), maxScore }; toast(maxScore === null ? 'Budget cleared.' : `Levels scoring above ${maxScore} will be refused.`); } catch (error) { toast(error.message); } };
$('workspace-inspect').onclick = async () => {
  $('workspace-inspect').disabled = true;
  try { renderWorkspaceInfo(await api('/api/workspace/inspect', 'POST', { path: $('workspace-path').value.trim() })); saveDraft(); }
  catch (error) { toast(error.message); $('workspace-info').classList.add('hidden'); state.workspaceInfo = null; }
  finally { $('workspace-inspect').disabled = false; }
};
document.querySelectorAll('input[name=workspace-level]').forEach(input => input.onchange = workspaceLevelChanged);
$('workspace-checks').onchange = saveDraft;
$('apply').onclick = async () => { $('apply').disabled = true; try { const result = await api(`/api/runs/${currentRun.id}/apply`, 'POST'); toast(`Applied into ${result.into}.`); renderRun(await api(`/api/runs/${currentRun.id}`)); } catch (error) { toast(error.message); $('apply').disabled = false; } };
$('discard').onclick = async () => { $('discard').disabled = true; try { await api(`/api/runs/${currentRun.id}/discard`, 'POST'); toast('Candidate branch discarded.'); renderRun(await api(`/api/runs/${currentRun.id}`)); } catch (error) { toast(error.message); $('discard').disabled = false; } };
$('resume').onclick = async () => {
  $('resume').disabled = true;
  try { const run = await api(`/api/runs/${currentRun.id}/resume`, 'POST'); watchRun(run); await refreshHistory(); }
  catch (error) { toast(error.message); $('resume').disabled = false; }
};
$('limit-form').addEventListener('submit', async event => {
  event.preventDefault(); if (!currentRun) return;
  const button = event.submitter; button.disabled = true;
  const ws = currentRun.workspace;
  const payload = {
    maxCalls: Number($('resume-max-calls').value), maxDurationSeconds: Number($('resume-duration').value) * 60,
    cycles: Number($('adjust-cycles').value), revisions: Number($('adjust-revisions').value), research: $('adjust-research').checked, deepResearch: $('adjust-deep-research').checked, timeoutSeconds: Number($('adjust-timeout-seconds').value), note: $('adjust-note').value.trim(),
  };
  if (ws) payload.workspace = {
    level: adjustLevel(), network: $('adjust-network').checked, claudeSandbox: $('adjust-claude-sandbox').checked,
    checks: $('adjust-checks').value.split('\n').map(line => line.trim()).filter(Boolean), implementTimeout: Number($('adjust-timeout').value),
    acknowledgeSecrets: true, acknowledgeDirty: ws.level !== 'read-only' || $('adjust-ack-dirty').checked, acknowledgeFullAccess: $('adjust-ack-full').checked, skipMeasurement: ws.skipMeasurement === true,
  };
  try { const run = await api(`/api/runs/${currentRun.id}/resume`, 'POST', payload); watchRun(run); await refreshHistory(); toast('Resumed.'); }
  catch (error) { toast(error.message); } finally { button.disabled = false; }
});
document.querySelectorAll('[data-example]').forEach(button => button.onclick = () => { $('prompt').value = button.dataset.example; $('prompt').dispatchEvent(new Event('input')); $('prompt').focus(); });
document.querySelectorAll('[data-tab]').forEach(button => button.onclick = () => selectTab(button.dataset.tab));
$('start').onclick = () => startRun(); $('demo').onclick = () => startRun(true);
$('pause').onclick = async () => {
  $('pause').disabled = true;
  try { await api(`/api/runs/${currentRun.id}/pause`, 'POST'); toast('Pausing after the step in flight. Nothing is thrown away.'); }
  catch (error) { toast(error.message); $('pause').disabled = false; }
};
$('cancel').onclick = async () => { $('cancel').disabled = true; try { await api(`/api/runs/${currentRun.id}/cancel`, 'POST'); } catch (error) { toast(error.message); $('cancel').disabled = false; } };
$('reuse').onclick = () => { const prompt = currentRun.prompt; newDiscussion(); $('prompt').value = prompt; $('prompt').dispatchEvent(new Event('input')); };
(async () => {
  try {
    const bootstrap = await api('/api/bootstrap'); Object.assign(state, bootstrap);
    $('lan-button').classList.toggle('hidden', !state.local); $('session-label').textContent = state.local ? 'Local session' : 'Paired LAN session';
    if (!state.local) { $('footer-title').textContent = 'Shared workspace'; $('footer-sub').textContent = 'Paired over your LAN'; $('footer-label').textContent = 'LAN'; }
    const draft = readDraft(), restored = (draft.selected || []).filter(id => state.providers.some(p => p.id === id));
    state.selected = new Set(restored.length ? restored : state.providers.slice(0, 2).map(p => p.id));
    if (draft.prompt) $('prompt').value = draft.prompt;
    $('research').checked = draft.research === true; $('deep-research').checked = draft.deepResearch === true;
    for (const [id, value] of [['rounds', draft.rounds], ['revisions', draft.revisions], ['max-calls', draft.maxCalls], ['duration', draft.duration], ['max-tokens', draft.maxTokens], ['timeout', draft.timeout]]) if (value) $(id).value = value;
    renderProviders(); if (draft.synthesizer && state.selected.has(draft.synthesizer)) $('synthesizer').value = draft.synthesizer;
    if (draft.workspacePath) $('workspace-path').value = draft.workspacePath; if (draft.workspaceChecks) $('workspace-checks').value = draft.workspaceChecks;
    try { state.workspaceConfig = await api('/api/workspace'); } catch { state.workspaceConfig = {}; }
    workspaceSetup();
    documentsSetup(); playbookSetup(); try { state.attachments = (await api('/api/attachments')).staged; } catch { state.attachments = []; } renderAttachments(); updateEstimate();
    $('char-count').textContent = `${$('prompt').value.length.toLocaleString()} / 24,000`;
    renderHistory(); const active = state.runs.find(r => r.status === 'running'); if (active) await loadRun(active.id);
  }
  catch (error) { toast(`Could not connect to the local server: ${error.message}`); $('start').disabled = true; }
})();
