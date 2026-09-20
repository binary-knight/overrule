import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { basename } from 'node:path';
import { git, createBranch, addWorktree, removeWorktree, commitCandidate, candidateDiff, runChecks, writeArtifact, applyCandidate as mergeCandidate, discardCandidate as dropCandidate } from './workspace.mjs';
import { setTimeout as delay } from 'node:timers/promises';
import { callProvider, publicProvider } from './providers.mjs';
import { rulesFor, activeMembers, plan, prompts, splitFields, normalizeFields, latestStance, record, metrics, stopReasonText, committed, currentSession, candidateReady } from './meeting.mjs';
import { callsUsed, elapsedBudget, estimateCalls, assessResult, citationEvidence } from '../public/meeting-state.js';
import { newBudget, validateLimits, assertBudget, settleBudget, assertCoversImplementer, BudgetLimitError, PauseError } from './budget.mjs';

export const DEMO_PROMPT = 'Show me how Overrule brings different perspectives together.';

export function validateRun(input, providers) {
  const prompt = String(input.prompt || '').trim();
  if (!prompt || prompt.length > 24000) throw new Error('Enter a prompt between 1 and 24,000 characters.');
  const ids = [...new Set(Array.isArray(input.participantIds) ? input.participantIds : [])];
  if (ids.length < 2 || ids.length > 8) throw new Error('Select between 2 and 8 members.');
  const participants = ids.map(id => providers.find(p => p.id === id));
  if (participants.some(p => !p)) throw new Error('One of the selected connections no longer exists.');
  const drafterId = input.drafterId ?? input.synthesizerId;
  if (!ids.includes(drafterId)) throw new Error('Choose a drafter from the participants.');
  const cycles = Number(input.cycles ?? input.rounds ?? 2), maxTokens = Number(input.maxTokens ?? 4096), timeoutSeconds = Number(input.timeoutSeconds ?? 180);
  if (!Number.isInteger(cycles) || cycles < 1 || cycles > 4) throw new Error('Choose 1–4 meeting cycles.');
  if (!Number.isInteger(maxTokens) || maxTokens < 256 || maxTokens > 32768) throw new Error('Use an output limit between 256 and 32,768 tokens.');
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 10 || timeoutSeconds > 3600) throw new Error('Use a timeout between 10 and 3,600 seconds.');
  const research = input.research === true || input.deepResearch === true;
  const deepResearch = input.deepResearch === true;
  if (input.deepResearch === true && input.research === false) throw new Error('Deep research needs internet research switched on.');
  const maxRevisions = Number(input.revisions ?? 1);
  if (!Number.isInteger(maxRevisions) || maxRevisions < 0 || maxRevisions > 5) throw new Error('Allow between 0 and 5 revisions.');
  const limits = validateLimits(input, { maxCalls: plannedCalls(participants.length, cycles, maxRevisions), maxDurationSeconds: 3600 });
  return { prompt, participants, drafterId, cycles, maxTokens, timeoutSeconds, maxRevisions, research, deepResearch, ...limits, workspace: input.workspace || null };
}

const isCli = p => p.type === 'codex-cli' || p.type === 'claude-cli';
export const latestCandidate = run => [...run.entries].reverse().find(e => e.phase === 'draft' && e.status === 'complete' && e.candidate)?.candidate || null;

// Conservative allowance: one re-ask for each floor turn, plus every configured revision.
export function plannedCalls(count, cycles, revisions = 1) { return estimateCalls(count, cycles, revisions).maximum; }

export class Mesh {
  constructor(store, providerCall = callProvider, tools = {}) {
    this.store = store; this.providerCall = providerCall; this.runChecks = tools.runChecks || runChecks; this.attachments = tools.attachments || null;
    this.runs = store.read('runs.json', []); this.listeners = new Map(); this.controllers = new Map();
    for (const run of this.runs) if (run.status === 'running') {
      settleBudget(run); // a crash cannot reset the time already allowed to an active attempt
      run.status = 'interrupted'; run.error = 'The server stopped during this meeting.';
      for (const entry of run.entries) if (entry.status === 'running') entry.status = 'interrupted';
    }
    this.save();
  }
  save() { this.store.write('runs.json', this.runs); }
  publish(run) { this.save(); for (const callback of this.listeners.get(run.id) || []) callback(run); }
  create(options, demo = false) {
    if (this.controllers.size >= 2) throw new Error('Two meetings are already running. Stop or finish one first.');
    const run = {
      id: options.id || randomUUID(), createdAt: new Date().toISOString(), status: 'running', phase: 'opening', kind: 'meeting', prompt: options.prompt,
      participants: options.participants.map(p => { const { hasKey, environmentKey, ...safe } = publicProvider(p); return safe; }),
      drafterId: options.drafterId, cycles: options.cycles, maxTokens: options.maxTokens, timeoutSeconds: options.timeoutSeconds,
      entries: [], issues: [], seq: 0, candidateVersion: 1, revisions: 0, maxRevisions: options.maxRevisions ?? 1, session: 1, stopReason: null, floorStarted: false, dropped: [], pendingOwner: [], final: '', demo,
      workspace: options.workspace ? { path: options.workspace.path, name: basename(options.workspace.path), origin: options.workspace.origin || '', head: options.workspace.head || '', level: options.workspace.level, network: Boolean(options.workspace.network), checks: options.workspace.checks || [], implementTimeout: options.workspace.implementTimeout || 900, canary: options.workspace.canary || null, measurement: options.workspace.measurement || null, skipMeasurement: Boolean(options.workspace.skipMeasurement), claudeSandbox: options.workspace.claudeSandbox !== false, attachedFrom: options.workspace.attachedFrom || 'localhost', branch: null, base: null, impl: null, review: null } : null,
      research: options.research === true || options.deepResearch === true, deepResearch: options.deepResearch === true,
      plannedCalls: plannedCalls(options.participants.length, options.cycles, options.maxRevisions ?? 1), budget: newBudget(options),
      ...(options.attachments?.length ? { attachments: options.attachments } : {}),
    };
    this.runs.unshift(run);
    // Never evict an active run, even when older history is pruned.
    const old = this.runs.filter(r => r.status !== 'running').slice(30);
    for (const gone of old) this.cleanup(gone).then(() => this.releaseDocuments(gone)).catch(() => {});
    this.runs = this.runs.filter(r => !old.includes(r));
    this.start(run, options);
    return run;
  }
  // Continue a stopped meeting from the log. Committed entries are reused; failed and partial attempts are never re-read.
  resume(run, participants, limits = {}, changes = {}) {
    if (this.controllers.has(run.id)) throw new Error('Wait for the meeting to finish stopping before resuming.');
    if (run.kind !== 'meeting') throw new Error('This discussion predates meetings and cannot be resumed. Start a new meeting with its prompt.');
    if (!['failed', 'interrupted', 'cancelled', 'limited', 'paused'].includes(run.status)) throw new Error('Only a paused, failed, interrupted, or stopped meeting can be resumed.');
    if (run.attachments?.length && run.documents?.state === 'removed') throw new Error('The documents for this meeting were removed from the host, so it cannot be resumed. Start a new meeting and attach them again.');
    if (this.controllers.size >= 2) throw new Error('Two meetings are already running. Stop or finish one first.');
    const before = { cycles: run.cycles, maxRevisions: run.maxRevisions };
    const changed = this.applySettings(run, changes);
    // A member whose opening failed, usually by running out of time, is out of the meeting for good once the floor starts.
    // While the floor has not spoken yet, a resume gives those members their opening back instead of losing their seat.
    const heard = phase => committed(run).some(e => e.phase === phase && e.speaker !== 'owner');
    const silent = run.participants.filter(p => !committed(run).some(e => e.phase === 'opening' && e.speaker === p.id));
    if (run.floorStarted && !heard('floor') && silent.length) {
      run.floorStarted = false; run.dropped = run.dropped.filter(id => !silent.some(p => p.id === id));
      changed.push(`${silent.map(p => p.name).join(' and ')} ${silent.length === 1 ? 'writes an opening position' : 'write opening positions'} after all`);
    }
    const old = run.budget || newBudget({ ...run, maxCalls: Math.min(1000, callsUsed(run) + plannedCalls(participants.length, run.cycles, run.maxRevisions)) });
    const budget = { ...old, ...validateLimits(limits, old), activeSince: null };
    // A longer meeting needs the calls to hold it: asking for more cycles or revisions raises the allowance with them.
    if (limits.maxCalls === undefined) {
      const seats = Math.max(2, activeMembers(run).length);
      const extra = estimateCalls(seats, run.cycles, run.maxRevisions, false).maximum - estimateCalls(seats, before.cycles, before.maxRevisions, false).maximum;
      if (extra > 0) { budget.maxCalls = Math.min(1000, budget.maxCalls + extra); changed.push(`call allowance raised to ${budget.maxCalls}`); }
    }
    assertCoversImplementer(budget.maxDurationSeconds, run.workspace);
    if (budget.elapsedMs >= budget.maxDurationSeconds * 1000) throw new Error('Increase the session time limit before resuming.');
    if (run.limitReason === 'calls' && callsUsed(run) >= budget.maxCalls) throw new Error('Increase the session call limit before resuming.');
    run.budget = budget; delete run.limitReason;
    Object.assign(run, { status: 'running', final: '', resumedAt: new Date().toISOString() }); delete run.error; delete run.finishedAt; delete run.pauseRequested;
    // The change goes on the record as the owner's own contribution, so the next member answers it and the transcript shows what moved.
    if (changed.length || changes.note) {
      const at = new Date().toISOString(), note = String(changes.note || '').trim();
      const text = [changed.length ? `Settings changed before resuming: ${changed.join('; ')}.` : 'Resumed with the same settings.', note].filter(Boolean).join('\n\n');
      run.entries.push({ id: `e${++run.seq}`, seq: run.seq, attempt: 1, speaker: 'owner', name: 'Owner', phase: 'floor', cycle: null, session: currentSession(run), adjust: true, status: 'complete', text, startedAt: at, finishedAt: at });
    }
    this.start(run, { participants });
    return run;
  }
  // Settings an owner may change while a meeting is stopped. The workspace path, the members, and the brief are fixed: changing
  // those would invalidate what every member has already read. Returns a plain-language list of what moved, for the record.
  applySettings(run, { workspace, cycles, maxRevisions, research, deepResearch, timeoutSeconds } = {}) {
    const changed = [];
    if (Number.isInteger(timeoutSeconds) && timeoutSeconds !== run.timeoutSeconds) {
      if (timeoutSeconds < 10 || timeoutSeconds > 3600) throw new Error('Use a timeout between 10 and 3,600 seconds.');
      changed.push(`time limit for one member's turn ${run.timeoutSeconds} to ${timeoutSeconds} seconds`);
      run.timeoutSeconds = timeoutSeconds;
    }
    if (typeof deepResearch === 'boolean' || typeof research === 'boolean') {
      const wantsDeep = deepResearch === undefined ? run.deepResearch === true : deepResearch;
      if (research === false && wantsDeep) throw new Error('Deep research needs internet research switched on.');
      const wantsWeb = (research === undefined ? run.research === true : research) || wantsDeep;
      if (wantsWeb !== (run.research === true)) changed.push(`internet research ${wantsWeb ? 'on: members may search the web' : 'off: no member may search the web'}`);
      if (wantsDeep !== (run.deepResearch === true)) changed.push(`deep research ${wantsDeep ? 'on: members research the subject before taking a position' : 'off'}`);
      run.research = wantsWeb; run.deepResearch = wantsDeep;
    }
    if (workspace) {
      const old = run.workspace;
      if (!old) throw new Error('This meeting has no workspace. Reconvene it or start a new meeting to attach one.');
      if (workspace.path !== old.path) throw new Error('The workspace folder cannot change mid-meeting; the members have already read this one.');
      const merged = { ...old, ...workspace, branch: old.branch, base: old.base, impl: old.impl, review: old.review, checkWorktree: old.checkWorktree, applied: old.applied, discarded: old.discarded };
      const levelText = level => level === 'full-access' ? 'full access' : level;
      if (merged.level !== old.level) changed.push(`access level ${levelText(old.level)} to ${levelText(merged.level)}`);
      if (merged.network !== old.network) changed.push(`network ${merged.network ? 'on' : 'off'} for the implementer and the checks`);
      if (merged.claudeSandbox !== old.claudeSandbox) changed.push(`Claude Code implementer sandbox ${merged.claudeSandbox ? 'on' : 'off'}`);
      if (merged.implementTimeout !== old.implementTimeout) changed.push(`implementer time limit ${Math.round(merged.implementTimeout / 60)} minutes`);
      if (String(merged.checks) !== String(old.checks)) changed.push(merged.checks.length ? `checks: ${merged.checks.join(', ')}` : 'checks removed');
      run.workspace = merged;
      // A candidate already captured was verified under the old settings: anything that changes how it is built or checked sends it back for verification.
      const candidate = committed(run).find(e => e.phase === 'draft' && e.candidateVersion === run.candidateVersion)?.candidate;
      const reverify = ['checks', 'network', 'implementTimeout', 'claudeSandbox'].some(key => String(merged[key]) !== String(old[key]));
      if (candidate && reverify) { candidate.checkStatus = 'pending'; changed.push('the candidate goes back for verification under the new settings'); }
      if (merged.level === 'read-only' && old.level !== 'read-only') { for (const key of ['impl', 'review', 'checkWorktree']) merged[key] = null; }
    }
    if (Number.isInteger(cycles) && cycles !== run.cycles) {
      if (cycles < 1 || cycles > 8) throw new Error('Choose 1–8 cycles.');
      const more = cycles > run.cycles;
      changed.push(`meeting length ${run.cycles} to ${cycles} cycles`);
      run.cycles = cycles;
      // More cycles reopens a floor that closed only because the budget ran out; consensus and stalemate are the council's call, not the budget's.
      if (more && run.stopReason === 'budget') { run.stopReason = null; run.phase = 'floor'; changed.push('the floor reopens'); }
    }
    if (Number.isInteger(maxRevisions) && maxRevisions !== run.maxRevisions) {
      if (maxRevisions < 0 || maxRevisions > 5) throw new Error('Allow between 0 and 5 revisions.');
      changed.push(`revisions after objections ${run.maxRevisions} to ${maxRevisions}`);
      run.maxRevisions = maxRevisions;
    }
    return changed;
  }
  // Reopen a closed meeting with a new instruction: same members, same record, same workspace branch and documents. The floor
  // gets a fresh budget; the earlier result is kept as history and the members see it as such. Resume is for finishing the same
  // instruction; this is for the next one.
  async reconvene(run, participants, { text, cycles, ...limits }) {
    if (this.controllers.has(run.id)) throw new Error('The meeting is still in session. Wait for it to finish stopping.');
    if (run.kind !== 'meeting' || run.demo) throw new Error('Only a real meeting can be reconvened.');
    if (run.status === 'running') throw new Error('The meeting is still in session. Stop it first, or speak to the council instead.');
    if (this.controllers.size >= 2) throw new Error('Two meetings are already running. Stop or finish one first.');
    if (run.attachments?.length && run.documents?.state === 'removed') throw new Error('The documents for this meeting were removed from the host, so it cannot be reconvened. Start a new meeting and attach them again.');
    if (!run.floorStarted) throw new Error('This meeting never got past its openings. Resume it instead.');
    const budget = newBudget({ participants, cycles, maxRevisions: run.maxRevisions, maxCalls: limits.maxCalls, maxDurationSeconds: limits.maxDurationSeconds ?? run.budget?.maxDurationSeconds }, false);
    assertCoversImplementer(budget.maxDurationSeconds, run.workspace);
    const ws = run.workspace, session = currentSession(run);
    run.sessions = [...(run.sessions || []), { session, cycles: run.cycles, stopReason: run.stopReason, status: run.status, record: run.record || null, final: run.final || '', candidateVersion: run.candidateVersion, finishedAt: run.finishedAt || null, budget: run.budget || null, calls: callsUsed(run), applied: ws?.applied || null, discarded: ws?.discarded || null }];
    if (ws && ws.level !== 'read-only') {
      // Applied: the branch is already in main, so it moves up to main's head. The implementer then sees whatever the owner changed since,
      // and the next candidate is the delta from there. Discarded: the branch is gone; the draft step recreates it.
      if (ws.applied && ws.branch) { ws.base = (await git(ws.path, ['rev-parse', 'HEAD'])).trim(); await git(ws.path, ['branch', '--force', ws.branch, ws.base]); ws.impl = null; ws.applied = null; }
      if (ws.discarded) { ws.branch = null; ws.base = null; ws.discarded = null; ws.impl = null; ws.review = null; }
    }
    Object.assign(run, { session: session + 1, cycles, floorCycle: 1, status: 'running', phase: 'floor', stopReason: null, revisions: 0, candidateVersion: run.candidateVersion + 1, final: '', record: null, dropped: [], failures: {}, reconvenedAt: new Date().toISOString() });
    delete run.error; delete run.finishedAt;
    run.budget = budget; delete run.limitReason;
    const n = activeMembers(run).length; run.plannedCalls += estimateCalls(n, cycles, run.maxRevisions, false).maximum;
    const at = new Date().toISOString();
    run.entries.push({ id: `e${++run.seq}`, seq: run.seq, attempt: 1, speaker: 'owner', name: 'Owner', phase: 'floor', cycle: null, session: run.session, reconvene: true, status: 'complete', text, startedAt: at, finishedAt: at });
    this.start(run, { participants });
    return run;
  }
  start(run, options) {
    const controller = new AbortController(); this.controllers.set(run.id, controller);
    run.budget.activeSince = Date.now();
    const deadline = setTimeout(() => controller.abort(new BudgetLimitError('time')), Math.max(1, run.budget.maxDurationSeconds * 1000 - run.budget.elapsedMs));
    deadline.unref?.();
    this.publish(run);
    this.execute(run, options.participants, controller.signal).catch(async error => {
      const cause = controller.signal.reason instanceof BudgetLimitError ? controller.signal.reason : error;
      run.error = cause.message;
      settleBudget(run);
      // A time-limit stop means the whole allowance is spent, whatever the wall clock read at the instant the timer fired.
      if (cause instanceof BudgetLimitError && cause.kind === 'time' && run.budget) run.budget.elapsedMs = run.budget.maxDurationSeconds * 1000;
      // A completed draft may still have uncommitted files. Keep that checkout
      // until capture succeeds; publish the stopped state only after cleanup.
      // An implementation that was cancelled, timed out, or failed keeps its checkout too: the branch has not moved, so a
      // resume hands the same partial work back to the implementer instead of starting the build again.
      const draft = run.entries.filter(e => e.phase === 'draft' && e.candidateVersion === run.candidateVersion && !e.superseded).at(-1);
      await this.cleanup(run, { keepImplementation: Boolean(draft && !draft.capture && !draft.candidate) }).catch(cleanupError => { run.error += ` Cleanup: ${cleanupError.message}`; });
      run.status = cause instanceof PauseError ? 'paused' : cause instanceof BudgetLimitError ? 'limited' : controller.signal.aborted ? 'cancelled' : 'failed';
      run.final = ''; // A deadline during final cleanup must not leave an approved answer on a stopped run.
      if (cause instanceof BudgetLimitError) run.limitReason = cause.kind;
      run.finishedAt = new Date().toISOString();
      run.record = record(run);
      this.publish(run);
    }).finally(() => { clearTimeout(deadline); settleBudget(run); this.controllers.delete(run.id); this.publish(run); });
  }
  // Temporary checkouts go away with the run; the candidate branch stays until the owner applies or discards it.
  async cleanup(run, { keepImplementation = false } = {}) {
    await this.releaseDocuments(run, { keepText: true });
    const ws = run.workspace; if (!ws) return;
    for (const key of ['impl', 'review', 'checkWorktree']) if (ws[key] && !(key === 'impl' && keepImplementation)) { await removeWorktree(ws.path, ws[key]); ws[key] = null; }
    this.save();
  }
  // Uploaded files leave the host when the meeting closes. A meeting that did not finish keeps only the extracted text, so it can
  // be resumed; the owner can remove that too, and it goes with the meeting when it finishes or ages out of the history.
  async releaseDocuments(run, { keepText = false } = {}) {
    const state = keepText ? 'text-kept' : 'removed';
    if (!run.attachments?.length || !this.attachments || run.documents?.state === 'removed' || run.documents?.state === state) return;
    await this.attachments.release(run.id, { keepText });
    run.documents = { state, at: new Date().toISOString() }; this.save();
  }
  async applyCandidate(run) {
    const ws = run.workspace, candidate = committed(run).find(e => e.phase === 'draft' && e.candidateVersion === run.candidateVersion)?.candidate;
    if (!ws || !candidate) throw new Error('This meeting has no candidate commit to apply.');
    if (ws.discarded) throw new Error('The candidate branch was discarded.');
    if (run.status === 'running') throw new Error('Wait for the meeting to close before applying.');
    if (!candidateReady(run, candidate)) throw new Error('Candidate verification is unfinished. Resume the meeting before applying.');
    ws.applied = { ...(await mergeCandidate(ws.path, ws.branch, candidate.hash)), hash: candidate.hash, at: new Date().toISOString() }; this.save();
    return ws.applied;
  }
  async discardCandidate(run) {
    const ws = run.workspace;
    if (!ws?.branch) throw new Error('This meeting has no candidate branch.');
    if (run.status === 'running') throw new Error('Stop the meeting before discarding its branch.');
    await this.cleanup(run); await dropCandidate(ws.path, ws.branch);
    ws.discarded = new Date().toISOString(); this.save();
    return { discarded: ws.discarded };
  }
  async captureCandidate(run, draft, signal) {
    const ws = run.workspace;
    signal.throwIfAborted();
    if (!draft.capture) {
      draft.capture = await commitCandidate(ws.impl, `Council candidate v${draft.candidateVersion} for meeting ${run.id.slice(0, 8)}`);
      this.publish(run); // resume can rebuild the diff even if its checkout is gone
    }
    const { hash } = draft.capture;
    const diff = await candidateDiff(ws.path, ws.base, hash);
    const artifact = diff.bytes ? await writeArtifact(this.store.directory, `${run.id}-v${draft.candidateVersion}.patch`, diff.full) : null;
    draft.candidate = { hash, branch: ws.branch, base: ws.base, changed: diff.files.length > 0, stat: diff.stat, files: diff.files, patch: diff.patch, bytes: diff.bytes, artifact: artifact ? basename(artifact) : null, checks: [], checkStatus: 'pending' };
    this.publish(run);
  }
  async verifyCandidate(run, candidate, signal) {
    const ws = run.workspace;
    candidate.checkStatus = 'running'; delete candidate.checkError;
    // A legacy/interrupted candidate may have ballots without complete checks.
    for (const entry of run.entries) if (entry.phase === 'ratify' && entry.candidateVersion === run.candidateVersion) { entry.superseded = true; entry.note = 'Verification was incomplete; vote again after checks finish.'; }
    this.publish(run);
    try {
      signal.throwIfAborted();
      if (ws.checkWorktree) { await removeWorktree(ws.path, ws.checkWorktree); ws.checkWorktree = null; }
      candidate.checks = [];
      if (ws.checks.length) {
        ws.checkWorktree = await addWorktree(ws.path, candidate.hash, { detach: true, label: 'checks' }); this.publish(run);
        candidate.checks = await this.runChecks(ws.checks, ws.checkWorktree, { network: ws.network, timeoutSeconds: ws.implementTimeout, signal });
      }
      signal.throwIfAborted();
      if (!candidateReady(run, { ...candidate, checkStatus: 'complete' })) throw new Error('Candidate verification did not finish. Resume to retry the checks.');
      candidate.checkStatus = 'complete';
    } catch (error) {
      candidate.checkStatus = 'pending'; candidate.checkError = error.message;
      throw error;
    } finally {
      if (ws.checkWorktree) { await removeWorktree(ws.path, ws.checkWorktree); ws.checkWorktree = null; }
      this.publish(run);
    }
  }
  cancel(id) { const controller = this.controllers.get(id); if (controller) controller.abort(); }
  // Pause waits for the step in flight to finish, so no call is thrown away; Stop ends it immediately.
  pause(run) {
    if (run.status !== 'running') throw new Error('The meeting is not in session.');
    if (run.pauseRequested) throw new Error('The meeting is already pausing; it stops after the step in flight.');
    run.pauseRequested = true; this.publish(run);
    return run;
  }
  // The owner joins the meeting; the message is delivered at the next turn boundary and the next speaker must address it.
  say(run, text) {
    if (run.status !== 'running') throw new Error('The meeting is not in session. Resume it or start a new one.');
    run.pendingOwner.push({ text, at: new Date().toISOString() }); this.publish(run);
  }
  consumeOwner(run) {
    while (run.pendingOwner.length) {
      const { text, at } = run.pendingOwner.shift();
      run.entries.push({ id: `e${++run.seq}`, seq: run.seq, attempt: 1, speaker: 'owner', name: 'Owner', phase: 'floor', cycle: null, status: 'complete', session: currentSession(run), text, startedAt: at, finishedAt: at });
      // Anything said after a draft exists invalidates the ballots on it: the candidate must be redrawn.
      if (committed(run).some(e => e.phase === 'draft' && e.candidateVersion === run.candidateVersion)) run.candidateVersion++;
    }
  }
  async execute(run, participants, signal) {
    const providerOf = id => participants.find(p => p.id === id);
    const ws = run.workspace;
    // Extracted text of the attached documents, read once per run and never stored on the run itself (the run is saved on every update).
    const documents = run.attachments?.length && !run.demo ? await this.attachments.texts(run.id, run.attachments) : null;
    // Where a CLI member runs and under which boundary: the workspace read-only on the floor, the isolated checkout for the implementer.
    const context = (provider, action) => {
      const research = run.research === true ? { research: true, deepResearch: run.deepResearch === true } : {};
      if (!ws || !isCli(provider)) return research;
      if (action.type === 'draft' && ws.level !== 'read-only') return { ...research, cwd: ws.impl, level: ws.level, network: ws.network, sandboxed: ws.claudeSandbox, timeoutSeconds: ws.implementTimeout };
      if (action.type === 'ratify' && ws.review && existsSync(ws.review)) return { ...research, cwd: ws.review, level: ws.level === 'full-access' ? 'full-access' : 'read-only' };
      // Floor turns: read-only under a confined level; at full access every tool-bearing member is loose, as the owner chose.
      return { ...research, cwd: ws.path, level: ws.level === 'full-access' ? 'full-access' : 'read-only' };
    };
    const invoke = async (provider, action, extra = {}) => {
      signal.throwIfAborted();
      assertBudget(run, 1);
      const attempt = run.entries.filter(e => e.speaker === provider.id && e.phase === action.phase && (e.cycle ?? null) === (action.cycle ?? null) && (e.candidateVersion ?? null) === (action.version ?? null)).length + 1;
      const entry = { id: `e${++run.seq}`, seq: run.seq, attempt, speaker: provider.id, name: provider.name, phase: action.phase, session: currentSession(run), cycle: action.cycle ?? null, candidateVersion: action.version ?? null, status: 'running', startedAt: new Date().toISOString(), ...(action.addressOwner ? { addressedOwner: true } : {}) };
      run.entries.push(entry); this.publish(run);
      try {
        const prompt = prompts(run, action.type === 'revise' ? { ...action, type: 'draft' } : action, { ...extra, documents });
        const ctx = context(provider, action);
        if (ctx.cwd) entry.workspace = { level: ctx.level, checkout: ctx.cwd === ws.path ? 'workspace' : ctx.cwd === ws.impl ? 'implementer' : 'candidate' };
        const result = run.demo ? await demoCall(run, provider, action, signal) : await this.providerCall(provider, { system: `${rulesFor(run)}\nYour perspective: ${provider.role}.`, prompt, maxTokens: run.maxTokens, timeoutSeconds: run.timeoutSeconds, signal, ...ctx }, this.store);
        entry.usage = result.usage; // keep reported usage even if cancellation arrived with the response
        signal.throwIfAborted();
        const { body, fields } = splitFields(result.text);
        Object.assign(entry, { status: 'complete', text: body, fields: normalizeFields(run, action.phase, fields, entry), usage: result.usage });
        if (result.actions?.length) entry.actions = result.actions.slice(0, 200);
        if (action.type === 'ratify' && extra.candidate) {
          entry.candidateHash = extra.candidate.hash;
          if (!extra.candidate.checks?.length) entry.fields.opinion = true;
        }
      } catch (error) { entry.status = signal.aborted ? 'cancelled' : 'failed'; entry.error = error.message; }
      entry.finishedAt = new Date().toISOString(); this.publish(run);
      return entry;
    };
    const invokeBatch = async (members, action, extra = {}) => {
      assertBudget(run, members.length);
      const results = await Promise.allSettled(members.map(m => invoke(providerOf(m.id), action, typeof extra === 'function' ? extra(m) : extra)));
      const failed = results.find(r => r.status === 'rejected');
      if (failed) throw failed.reason;
    };
    const recordTurn = entry => {
      const f = entry.fields;
      for (const o of f.objections) run.issues.push({ id: `o${run.issues.length + 1}`, raisedBy: entry.speaker, against: o.against, claim: o.claim, condition: o.condition, status: 'open', entry: entry.id, seq: entry.seq });
      // Only the member who raised an objection, or the owner, can assess its resolution.
      for (const id of f.resolves) { const issue = run.issues.find(i => i.id === id && i.status === 'open'); if (issue && (issue.raisedBy === entry.speaker)) Object.assign(issue, { status: 'resolved', resolvedBy: entry.id }); }
    };
    while (true) {
      signal.throwIfAborted();
      if (run.pauseRequested) { delete run.pauseRequested; throw new PauseError(); }
      assertBudget(run);
      this.consumeOwner(run);
      const active = activeMembers(run);
      const action = plan(run, active);
      if (action.type === 'fail') throw new Error(action.error);
      if (action.type === 'stop') { run.stopReason = action.reason; run.phase = 'draft'; this.publish(run); continue; }
      if (action.type === 'revise') { run.revisions++; run.candidateVersion++; this.publish(run); continue; }
      if (action.type === 'finalize') {
        const draft = committed(run).find(e => e.phase === 'draft' && e.candidateVersion === run.candidateVersion);
        run.record = record({ ...run, status: 'complete' });
        if (draft.candidate) run.record.candidate = { hash: draft.candidate.hash, branch: draft.candidate.branch, changed: draft.candidate.changed, files: draft.candidate.files.length, checks: draft.candidate.checks.map(k => ({ command: k.command, code: k.code })) };
        run.final = finalText(run, draft.text, run.record);
        await this.cleanup(run);
        await this.releaseDocuments(run, { keepText: true }).catch(() => {}); // uploaded files leave the host now; the text stays so the meeting can be reconvened, until the owner removes it
        signal.throwIfAborted();
        Object.assign(run, { status: 'complete', phase: 'complete', finishedAt: new Date().toISOString() }); this.publish(run); return;
      }
      run.phase = action.phase;
      if (action.type === 'turn') run.floorCycle = action.cycle;
      this.publish(run);
      if (action.type === 'opening') {
        assertBudget(run, action.members.length); // reserve the independent batch before launching any member
        await invokeBatch(action.members, action);
        signal.throwIfAborted();
        if (activeMembers(run).length < 2) throw new Error('Fewer than two members opened successfully. Review connection errors and resume.');
        run.floorStarted = true; continue;
      }
      if (action.type === 'turn') {
        const speaker = providerOf(action.speaker.id), before = latestStance(run, speaker.id);
        let entry = await invoke(speaker, action);
        if (entry.status === 'complete' && before === 'disagree' && entry.fields.stance === 'agree' && !entry.fields.concedes.length) {
          // An uncited flip is asked about once; if it stays uncited it is recorded as disagree.
          entry.superseded = true; entry.note = 'Re-asked: moved to agree without citing what changed.';
          const again = await invoke(speaker, action, { reask: entry.id });
          if (again.status === 'complete') { entry = again; if (entry.fields.stance === 'agree' && !entry.fields.concedes.length) { entry.fields.stance = 'disagree'; entry.fields.openPoints.push('uncited stance change'); } }
          else entry = again;
        }
        if (entry.status === 'complete') { run.failures = { ...run.failures, [speaker.id]: 0 }; recordTurn(entry); }
        else if (entry.status === 'failed') {
          // A failed speaker is skipped and the meeting continues; two failures in a row drop the member.
          const failures = (run.failures?.[speaker.id] || 0) + 1; run.failures = { ...run.failures, [speaker.id]: failures };
          if (failures >= 2 && !run.dropped.includes(speaker.id)) { run.dropped.push(speaker.id); entry.note = 'Dropped after two consecutive failures.'; }
        }
        this.publish(run); continue;
      }
      if (action.type === 'draft') {
        let extra = {};
        if (ws && ws.level !== 'read-only') {
          if (!ws.branch) Object.assign(ws, await createBranch(ws.path, run.id));
          if (!ws.impl || !existsSync(ws.impl)) ws.impl = await addWorktree(ws.path, ws.branch, { label: 'impl' });
          this.publish(run);
          extra = { implementer: { cwd: ws.impl, branch: ws.branch, network: ws.network } };
        } else if (ws) extra = { workspace: true };
        const draft = await invoke(providerOf(run.drafterId), action, extra);
        if (draft.status !== 'complete') throw new Error('The drafter could not produce the candidate. The meeting is preserved; review its error and resume.');
        if (ws && ws.level !== 'read-only') await this.captureCandidate(run, draft, signal);
        continue;
      }
      if (action.type === 'capture') {
        const draft = committed(run).find(e => e.phase === 'draft' && e.candidateVersion === action.version);
        if (!draft.capture && (!ws.impl || !existsSync(ws.impl))) {
          draft.superseded = true; draft.note = 'The uncaptured implementation checkout was lost; the draft must be rebuilt.'; this.publish(run);
        } else await this.captureCandidate(run, draft, signal);
        continue;
      }
      if (action.type === 'check') {
        const candidate = committed(run).find(e => e.phase === 'draft' && e.candidateVersion === action.version).candidate;
        await this.verifyCandidate(run, candidate, signal);
        continue;
      }
      if (action.type === 'ratify') {
        assertBudget(run, action.members.length);
        const candidate = committed(run).find(e => e.phase === 'draft' && e.candidateVersion === action.version)?.candidate;
        if (candidate && ws) {
          // Checks may format or generate files. Voters always start from the
          // recorded commit in a separate checkout, including after a restart.
          if (ws.review) await removeWorktree(ws.path, ws.review);
          ws.review = await addWorktree(ws.path, candidate.hash, { detach: true, label: 'review' }); this.publish(run);
        }
        await invokeBatch(action.members, action, m => ({ candidate, readonlyCheckout: Boolean(candidate && ws?.review && isCli(m)) }));
        continue;
      }
      throw new Error(`Unknown action ${action.type}`);
    }
  }
}

function finalText(run, draft, rec) {
  const lines = [draft.trim(), '', '## Council record', '', `Final verdict: ${rec.verdict.label}. ${rec.verdict.verification}`, stopReasonText(rec.stopReason), `Ballots on candidate v${rec.version}: ${rec.votes.approve} approve, ${rec.votes.object} object, ${rec.votes.abstain} abstain${rec.missingBallots ? `, ${rec.missingBallots} missing` : ''}.`];
  if (rec.objections.length) lines.push('', 'Objections on record:', ...rec.objections.map(o => `- ${o.by}: "${o.claim}"${o.condition ? ` — resolves when: ${o.condition}` : ''}`));
  if (rec.openIssues.length) lines.push('', 'Open objections from the floor:', ...rec.openIssues.map(i => `- ${i.id}: "${i.claim}" — resolves when: ${i.condition}`));
  if (rec.candidate) {
    const c = rec.candidate;
    lines.push('', `Candidate commit ${c.hash.slice(0, 12)} on branch ${c.branch}${c.changed ? ` changed ${c.files} file${c.files === 1 ? '' : 's'}` : ' changed no files'}. Apply or discard it from the meeting view; your working tree is untouched until you apply.`);
    if (c.checks.length) lines.push(`Checks on that commit: ${c.checks.map(k => `${k.command} → ${k.code === 0 ? 'passed' : k.code === null ? 'could not run' : `exit ${k.code}`}`).join('; ')}.`);
    else lines.push('No checks were configured; every ballot above is an opinion, not a verified vote.');
  }
  if (rec.metrics.label === 'no-deliberation') lines.push('', 'No deliberation occurred: every member agreed from the first floor turn with no cited concession or objection. Treat this as one answer, not a council decision.');
  return lines.join('\n');
}

async function demoCall(run, provider, action, signal) {
  await delay(500 + (provider.id.charCodeAt(0) % 4) * 150, undefined, { signal });
  const other = run.participants.find(p => p.id !== provider.id);
  // Count substantive turns only, so an owner interjection does not shift the scripted exchange.
  const turn = committed(run).filter(e => e.phase === 'floor' && e.speaker !== 'owner' && !e.addressedOwner).length;
  if (action.type === 'opening') return { text: `Demonstration only — ${provider.name}\n\nApproach: start from the outcome the owner wants, write down the constraints, and build the smallest version that can be judged. My perspective is ${provider.role.toLowerCase()}.\n\n\`\`\`json\n{"assumptions":["the owner wants something practical","the result can be checked"],"risk":"solving an imagined problem instead of the stated one","criteria":["a reader can act on it","every claim is marked verified or not"],"verification":"unperformed"}\n\`\`\``, usage: { input: 0, output: 0 } };
  if (action.type === 'turn') {
    if (action.addressOwner) return { text: `Demonstration only — ${provider.name}\n\nThe owner said: "${committed(run).filter(e => e.speaker === 'owner').at(-1)?.text.slice(0, 160)}". I take that as a constraint on the deliverable and will hold the candidate to it.\n\n\`\`\`json\n{"stance":"agree","concedes":[],"objections":[],"resolves":[],"settle":"","needs":null,"nominates":"${other.name}","verification":"unperformed"}\n\`\`\``, usage: { input: 0, output: 0 } };
    if (turn === 0) return { text: `Demonstration only — ${provider.name}\n\n${other.name} wrote "build the smallest version that can be judged". Small is right, but nothing here says who judges it. I object until the acceptance criteria name a reader.\n\n\`\`\`json\n{"stance":"disagree","concedes":[],"objections":[{"against":"${other.name}","claim":"build the smallest version that can be judged","condition":"the criteria name who judges the result and how"}],"resolves":[],"settle":"a named reader and a check they can run","needs":null,"nominates":"${other.name}","verification":"unperformed"}\n\`\`\``, usage: { input: 0, output: 0 } };
    if (turn === 1) return { text: `Demonstration only — ${provider.name}\n\nOn o1: "the criteria name who judges the result and how" is a fair condition. The judge is the owner reading the final answer, and the check is whether each claim carries its evidence or is marked unverified. I add that to the criteria.\n\n\`\`\`json\n{"stance":"agree","concedes":[{"entry":"${committed(run).filter(e => e.phase === 'floor').at(-1)?.id || 'e3'}","quote":"nothing here says who judges it"}],"objections":[],"resolves":[],"settle":"","needs":null,"nominates":"${other.name}","verification":"unperformed"}\n\`\`\``, usage: { input: 0, output: 0 } };
    return { text: `Demonstration only — ${provider.name}\n\n"The judge is the owner reading the final answer" meets my condition, so o1 is resolved. I agree on that basis.\n\n\`\`\`json\n{"stance":"agree","concedes":[{"entry":"${committed(run).filter(e => e.phase === 'floor').at(-1)?.id || 'e4'}","quote":"The judge is the owner reading the final answer"}],"objections":[],"resolves":["o1"],"settle":"","needs":null,"nominates":"${other.name}","verification":"unperformed"}\n\`\`\``, usage: { input: 0, output: 0 } };
  }
  if (action.type === 'draft') return { text: `# Your models, in a meeting\n\nThis is a scripted demonstration, not an AI-generated answer to your prompt.\n\nIn a live meeting, each member first writes an opening position without seeing the others. Then the floor opens: members take turns, quote the claims they answer, raise objections with a condition that would resolve them, and change their stance only by citing what changed their mind. When every member agrees on substance and no objection is open, or the turn budget runs out, the drafter writes a candidate and the other members vote on that exact text. Objections stay on the record.\n\n## What to try next\n\n1. Open Connections and check your Codex and Claude Code sign-ins, or add API keys.\n2. Select at least two members, choose how many cycles the meeting may run, and write your prompt.\n3. Start the meeting, and speak whenever you want; the next member must answer you.\n\n\`\`\`json\n{"version":${action.version},"unresolved":[],"verification":"unperformed"}\n\`\`\``, usage: { input: 0, output: 0 } };
  return { text: `Demonstration only — ${provider.name}\n\nThe candidate carries the resolved criterion and marks verification as unperformed. I approve.\n\n\`\`\`json\n{"vote":"approve","objections":[],"reason":"it says what was agreed and no more"}\n\`\`\``, usage: { input: 0, output: 0 } };
}

export function exportMarkdown(run) {
  const head = `# Overrule${run.demo ? ' — scripted demo' : ''}\n\n${run.createdAt} · ${run.status}${run.stopReason ? ` · ${run.stopReason}` : ''}\n\n## Prompt\n\n${run.prompt}\n\n${run.workspace?.origin || run.workspace?.head ? `## Repository reviewed\n\n${run.workspace.origin || run.workspace.name} at commit ${(run.workspace.head || 'unknown').slice(0, 12)}\n\n` : ''}${run.attachments?.length ? `## Documents\n\n${run.attachments.map(a => `- ${a.name} (${a.size.toLocaleString('en-US')} bytes, sha256 ${a.sha256.slice(0, 12)}, ${a.chars.toLocaleString('en-US')} characters read)${a.warning ? ` — ${a.warning}` : ''}`).join('\n')}\n\n` : ''}## Final answer${run.sessions?.length ? ` (session ${run.session})` : ''}\n\n${run.final || run.error || 'No final answer yet.'}\n\n${(run.sessions || []).map(s => `## Session ${s.session} result\n\n${s.final || s.status || ''}`).join('\n\n')}\n\n`;
  if (run.kind !== 'meeting') return head + '## Discussion\n\n' + run.entries.map(e => `### ${e.name} · ${e.phase}${e.round ? ` ${e.round}` : ''} · ${e.status}\n\n${e.text || e.error || 'Pending'}\n`).join('\n');
  const fieldsOf = e => e.fields ? '\n\n```json\n' + JSON.stringify(e.fields) + '\n```' : '';
  const verdict = assessResult(run), cand = verdict.candidate;
  const candidate = cand ? `## Candidate commit\n\n${cand.hash} on ${cand.branch}${cand.changed ? '' : ' (no file changes)'}\n\n\`\`\`\n${cand.stat || 'no changes'}\n\`\`\`\n\n${cand.checks.map(k => `### $ ${k.command} (exit ${k.code})\n\n\`\`\`\n${k.output.trim()}\n\`\`\`\n`).join('\n')}\n` : '';
  const issues = run.issues.length ? `## Objections\n\n${run.issues.map(i => `- ${i.id} [${i.status}] ${i.claim} — resolves when: ${i.condition}`).join('\n')}\n\n` : '';
  const m = metrics(run);
  const usage = `Session ${currentSession(run)}: ${callsUsed(run)}${run.budget ? ` / ${run.budget.maxCalls}` : ''} calls; ${callsUsed(run, true)} calls overall. Active time: ${Math.round(elapsedBudget(run) / 1000)}${run.budget ? ` / ${run.budget.maxDurationSeconds}` : ''} seconds.`;
  const citations = committed(run).filter(e => (e.session || 1) === currentSession(run)).flatMap(e => citationEvidence(run, e).valid.map(c => `- [${e.id}](#entry-${encodeURIComponent(e.id)}) concedes [${c.entry}](#entry-${encodeURIComponent(c.entry)}): "${c.quote}"`));
  return head + `## Final verdict\n\n${verdict.label}. ${verdict.verification}\n\n## Usage\n\n${usage}\n\n` + candidate + issues + `## Citation evidence\n\n${citations.join('\n') || 'No validated concessions.'}\n\n## Meeting record\n\nFloor turns ${m.floorTurns} · stance changes ${m.stanceChanges} · cited concessions ${m.citedConcessions} · objections ${m.objectionsResolved}/${m.objectionsRaised} resolved${m.label ? ` · ${m.label}` : ''}\n\n## Transcript\n\n` +
    run.entries.map(e => `<a id="entry-${encodeURIComponent(e.id)}"></a>\n\n### ${e.id} · ${e.name} · ${e.phase}${e.cycle ? ` cycle ${e.cycle}` : ''}${e.candidateVersion ? ` v${e.candidateVersion}` : ''} · ${e.status}${e.superseded ? ' · superseded' : ''}\n\n${e.candidateHash ? `Reviewed commit: ${e.candidateHash}\n\n` : ''}${e.text || e.error || 'Pending'}${fieldsOf(e)}\n`).join('\n');
}
