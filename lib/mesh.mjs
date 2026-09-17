import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { basename } from 'node:path';
import { createBranch, addWorktree, removeWorktree, commitCandidate, candidateDiff, runChecks, writeArtifact, applyCandidate as mergeCandidate, discardCandidate as dropCandidate } from './workspace.mjs';
import { setTimeout as delay } from 'node:timers/promises';
import { callProvider, publicProvider } from './providers.mjs';
import { rulesFor, activeMembers, plan, prompts, splitFields, normalizeFields, latestStance, record, metrics, stopReasonText, committed } from './meeting.mjs';

export const DEMO_PROMPT = 'Show me how Model Mesh brings different perspectives together.';

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
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 10 || timeoutSeconds > 600) throw new Error('Use a timeout between 10 and 600 seconds.');
  return { prompt, participants, drafterId, cycles, maxTokens, timeoutSeconds, workspace: input.workspace || null };
}

const isCli = p => p.type === 'codex-cli' || p.type === 'claude-cli';
export const latestCandidate = run => [...run.entries].reverse().find(e => e.phase === 'draft' && e.status === 'complete' && e.candidate)?.candidate || null;

// Upper bound on calls: openings, floor turns, draft, ballots, one revision with its ballots, and one re-ask per member.
export function plannedCalls(count, cycles) { return count + count * cycles + 1 + (count - 1) + 1 + (count - 1) + count; }

export class Mesh {
  constructor(store, providerCall = callProvider, tools = {}) {
    this.store = store; this.providerCall = providerCall; this.runChecks = tools.runChecks || runChecks; this.attachments = tools.attachments || null;
    this.runs = store.read('runs.json', []); this.listeners = new Map(); this.controllers = new Map();
    for (const run of this.runs) if (run.status === 'running') {
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
      entries: [], issues: [], seq: 0, candidateVersion: 1, revisions: 0, maxRevisions: 1, stopReason: null, floorStarted: false, dropped: [], pendingOwner: [], final: '', demo,
      workspace: options.workspace ? { path: options.workspace.path, name: basename(options.workspace.path), level: options.workspace.level, network: Boolean(options.workspace.network), checks: options.workspace.checks || [], implementTimeout: options.workspace.implementTimeout || 900, canary: options.workspace.canary || null, measurement: options.workspace.measurement || null, skipMeasurement: Boolean(options.workspace.skipMeasurement), claudeSandbox: options.workspace.claudeSandbox !== false, attachedFrom: options.workspace.attachedFrom || 'localhost', branch: null, base: null, impl: null, review: null } : null,
      plannedCalls: plannedCalls(options.participants.length, options.cycles),
      ...(options.attachments?.length ? { attachments: options.attachments } : {}),
    };
    this.runs.unshift(run);
    // Never evict an active run, even when older history is pruned.
    const old = this.runs.filter(r => r.status !== 'running').slice(30);
    for (const gone of old) if (gone.attachments?.length) this.attachments?.release(gone.id).catch(() => {});
    this.runs = this.runs.filter(r => !old.includes(r));
    this.start(run, options);
    return run;
  }
  // Continue a stopped meeting from the log. Committed entries are reused; failed and partial attempts are never re-read.
  resume(run, participants) {
    if (run.kind !== 'meeting') throw new Error('This discussion predates meetings and cannot be resumed. Start a new meeting with its prompt.');
    if (!['failed', 'interrupted', 'cancelled'].includes(run.status)) throw new Error('Only a failed, interrupted, or stopped meeting can be resumed.');
    if (run.attachments?.length && run.documents?.state === 'removed') throw new Error('The documents for this meeting were removed from the host, so it cannot be resumed. Start a new meeting and attach them again.');
    if (this.controllers.size >= 2) throw new Error('Two meetings are already running. Stop or finish one first.');
    Object.assign(run, { status: 'running', final: '', resumedAt: new Date().toISOString() }); delete run.error; delete run.finishedAt;
    this.start(run, { participants });
    return run;
  }
  start(run, options) {
    const controller = new AbortController(); this.controllers.set(run.id, controller);
    this.publish(run);
    this.execute(run, options.participants, controller.signal).catch(async error => {
      run.status = controller.signal.aborted ? 'cancelled' : 'failed';
      run.error = error.message;
      await this.releaseDocuments(run, { keepText: true }).catch(() => {}); // before the last publish, so the page that is watching sees it
      this.publish(run);
    }).finally(() => { this.controllers.delete(run.id); this.cleanup(run).catch(() => {}); });
  }
  // Temporary checkouts go away with the run; the candidate branch stays until the owner applies or discards it.
  async cleanup(run) {
    await this.releaseDocuments(run, { keepText: run.status !== 'complete' });
    const ws = run.workspace; if (!ws) return;
    for (const key of ['impl', 'review']) if (ws[key]) { await removeWorktree(ws.path, ws[key]); ws[key] = null; }
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
    const ws = run.workspace, candidate = latestCandidate(run);
    if (!ws || !candidate) throw new Error('This meeting has no candidate commit to apply.');
    if (ws.discarded) throw new Error('The candidate branch was discarded.');
    if (run.status === 'running') throw new Error('Wait for the meeting to close before applying.');
    ws.applied = { ...(await mergeCandidate(ws.path, ws.branch)), hash: candidate.hash, at: new Date().toISOString() }; this.save();
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
    const { hash, changed } = await commitCandidate(ws.impl, `Council candidate v${draft.candidateVersion} for meeting ${run.id.slice(0, 8)}`);
    const diff = await candidateDiff(ws.path, ws.base, hash);
    const artifact = diff.bytes ? await writeArtifact(this.store.directory, `${run.id}-v${draft.candidateVersion}.patch`, diff.full) : null;
    draft.candidate = { hash, branch: ws.branch, base: ws.base, changed, stat: diff.stat, files: diff.files, patch: diff.patch, bytes: diff.bytes, artifact: artifact ? basename(artifact) : null, checks: [] };
    this.publish(run);
    if (ws.review) await removeWorktree(ws.path, ws.review);
    ws.review = await addWorktree(ws.path, hash, { detach: true, label: 'review' });
    if (ws.checks.length) { draft.candidate.checks = await this.runChecks(ws.checks, ws.review, { network: ws.network, timeoutSeconds: ws.implementTimeout, signal }); this.publish(run); }
  }
  cancel(id) { const controller = this.controllers.get(id); if (controller) controller.abort(); }
  // The owner joins the meeting; the message is delivered at the next turn boundary and the next speaker must address it.
  say(run, text) {
    if (run.status !== 'running') throw new Error('The meeting is not in session. Resume it or start a new one.');
    run.pendingOwner.push({ text, at: new Date().toISOString() }); this.publish(run);
  }
  consumeOwner(run) {
    while (run.pendingOwner.length) {
      const { text, at } = run.pendingOwner.shift();
      run.entries.push({ id: `e${++run.seq}`, seq: run.seq, attempt: 1, speaker: 'owner', name: 'Owner', phase: 'floor', cycle: null, status: 'complete', text, startedAt: at, finishedAt: at });
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
      if (!ws || !isCli(provider)) return {};
      if (action.type === 'draft' && ws.level !== 'read-only') return { cwd: ws.impl, level: ws.level, network: ws.network, sandboxed: ws.claudeSandbox, timeoutSeconds: ws.implementTimeout };
      if (action.type === 'ratify' && ws.review && existsSync(ws.review)) return { cwd: ws.review, level: ws.level === 'full-access' ? 'full-access' : 'read-only' };
      // Floor turns: read-only under a confined level; at full access every tool-bearing member is loose, as the owner chose.
      return { cwd: ws.path, level: ws.level === 'full-access' ? 'full-access' : 'read-only' };
    };
    const invoke = async (provider, action, extra = {}) => {
      signal.throwIfAborted();
      const attempt = run.entries.filter(e => e.speaker === provider.id && e.phase === action.phase && (e.cycle ?? null) === (action.cycle ?? null) && (e.candidateVersion ?? null) === (action.version ?? null)).length + 1;
      const entry = { id: `e${++run.seq}`, seq: run.seq, attempt, speaker: provider.id, name: provider.name, phase: action.phase, cycle: action.cycle ?? null, candidateVersion: action.version ?? null, status: 'running', startedAt: new Date().toISOString(), ...(action.addressOwner ? { addressedOwner: true } : {}) };
      run.entries.push(entry); this.publish(run);
      try {
        const prompt = prompts(run, action.type === 'revise' ? { ...action, type: 'draft' } : action, { ...extra, documents });
        const ctx = context(provider, action);
        if (ctx.cwd) entry.workspace = { level: ctx.level, checkout: ctx.cwd === ws.path ? 'workspace' : ctx.cwd === ws.impl ? 'implementer' : 'candidate' };
        const result = run.demo ? await demoCall(run, provider, action, signal) : await this.providerCall(provider, { system: `${rulesFor(run)}\nYour perspective: ${provider.role}.`, prompt, maxTokens: run.maxTokens, timeoutSeconds: run.timeoutSeconds, signal, ...ctx }, this.store);
        signal.throwIfAborted();
        const { body, fields } = splitFields(result.text);
        Object.assign(entry, { status: 'complete', text: body, fields: normalizeFields(run, action.phase, fields), usage: result.usage });
        if (result.actions?.length) entry.actions = result.actions.slice(0, 200);
        if (action.type === 'ratify' && extra.candidate && !extra.candidate.checks?.length) entry.fields.opinion = true;
      } catch (error) { entry.status = signal.aborted ? 'cancelled' : 'failed'; entry.error = error.message; }
      entry.finishedAt = new Date().toISOString(); this.publish(run);
      return entry;
    };
    const recordTurn = entry => {
      const f = entry.fields;
      for (const o of f.objections) run.issues.push({ id: `o${run.issues.length + 1}`, raisedBy: entry.speaker, against: o.against, claim: o.claim, condition: o.condition, status: 'open', entry: entry.id, seq: entry.seq });
      // Only the member who raised an objection, or the owner, can assess its resolution.
      for (const id of f.resolves) { const issue = run.issues.find(i => i.id === id && i.status === 'open'); if (issue && (issue.raisedBy === entry.speaker)) Object.assign(issue, { status: 'resolved', resolvedBy: entry.id }); }
    };
    while (true) {
      signal.throwIfAborted();
      this.consumeOwner(run);
      const active = activeMembers(run);
      const action = plan(run, active);
      if (action.type === 'fail') throw new Error(action.error);
      if (action.type === 'stop') { run.stopReason = action.reason; run.phase = 'draft'; this.publish(run); continue; }
      if (action.type === 'revise') { run.revisions++; run.candidateVersion++; this.publish(run); continue; }
      if (action.type === 'finalize') {
        const draft = committed(run).find(e => e.phase === 'draft' && e.candidateVersion === run.candidateVersion);
        run.record = record(run);
        if (draft.candidate) run.record.candidate = { hash: draft.candidate.hash, branch: draft.candidate.branch, changed: draft.candidate.changed, files: draft.candidate.files.length, checks: draft.candidate.checks.map(k => ({ command: k.command, code: k.code })) };
        run.final = finalText(run, draft.text, run.record);
        await this.cleanup(run);
        await this.releaseDocuments(run).catch(() => {}); // the meeting is over: files and extracted text leave the host before the result is announced
        Object.assign(run, { status: 'complete', phase: 'complete', finishedAt: new Date().toISOString() }); this.publish(run); return;
      }
      run.phase = action.phase; this.publish(run);
      if (action.type === 'opening') {
        await Promise.all(action.members.map(m => invoke(providerOf(m.id), action)));
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
      if (action.type === 'ratify') {
        const candidate = latestCandidate(run);
        if (candidate && ws && (!ws.review || !existsSync(ws.review))) { ws.review = await addWorktree(ws.path, candidate.hash, { detach: true, label: 'review' }); this.publish(run); }
        await Promise.all(action.members.map(m => invoke(providerOf(m.id), action, { candidate, readonlyCheckout: Boolean(candidate && ws?.review && isCli(m)) })));
        continue;
      }
      throw new Error(`Unknown action ${action.type}`);
    }
  }
}

function finalText(run, draft, rec) {
  const lines = [draft.trim(), '', '## Council record', '', stopReasonText(rec.stopReason), `Ballots on candidate v${rec.version}: ${rec.votes.approve} approve, ${rec.votes.object} object, ${rec.votes.abstain} abstain${rec.missingBallots ? `, ${rec.missingBallots} missing` : ''}.`];
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
    return { text: `Demonstration only — ${provider.name}\n\n"The judge is the owner reading the final answer" meets my condition, so o1 is resolved. I agree on that basis.\n\n\`\`\`json\n{"stance":"agree","concedes":[{"entry":"${committed(run).filter(e => e.phase === 'floor').at(-1)?.id || 'e4'}","quote":"the judge is the owner reading the final answer"}],"objections":[],"resolves":["o1"],"settle":"","needs":null,"nominates":"${other.name}","verification":"unperformed"}\n\`\`\``, usage: { input: 0, output: 0 } };
  }
  if (action.type === 'draft') return { text: `# Your models, in a meeting\n\nThis is a scripted demonstration, not an AI-generated answer to your prompt.\n\nIn a live meeting, each member first writes an opening position without seeing the others. Then the floor opens: members take turns, quote the claims they answer, raise objections with a condition that would resolve them, and change their stance only by citing what changed their mind. When every member agrees on substance and no objection is open, or the turn budget runs out, the drafter writes a candidate and the other members vote on that exact text. Objections stay on the record.\n\n## What to try next\n\n1. Open Connections and check your Codex and Claude Code sign-ins, or add API keys.\n2. Select at least two members, choose how many cycles the meeting may run, and write your prompt.\n3. Start the meeting, and speak whenever you want; the next member must answer you.\n\n\`\`\`json\n{"version":${action.version},"unresolved":[],"verification":"unperformed"}\n\`\`\``, usage: { input: 0, output: 0 } };
  return { text: `Demonstration only — ${provider.name}\n\nThe candidate carries the resolved criterion and marks verification as unperformed. I approve.\n\n\`\`\`json\n{"vote":"approve","objections":[],"reason":"it says what was agreed and no more"}\n\`\`\``, usage: { input: 0, output: 0 } };
}

export function exportMarkdown(run) {
  const head = `# Model Mesh${run.demo ? ' — scripted demo' : ''}\n\n${run.createdAt} · ${run.status}${run.stopReason ? ` · ${run.stopReason}` : ''}\n\n## Prompt\n\n${run.prompt}\n\n${run.attachments?.length ? `## Documents\n\n${run.attachments.map(a => `- ${a.name} (${a.size.toLocaleString('en-US')} bytes, sha256 ${a.sha256.slice(0, 12)}, ${a.chars.toLocaleString('en-US')} characters read)${a.warning ? ` — ${a.warning}` : ''}`).join('\n')}\n\n` : ''}## Final answer\n\n${run.final || run.error || 'No final answer yet.'}\n\n`;
  if (run.kind !== 'meeting') return head + '## Discussion\n\n' + run.entries.map(e => `### ${e.name} · ${e.phase}${e.round ? ` ${e.round}` : ''} · ${e.status}\n\n${e.text || e.error || 'Pending'}\n`).join('\n');
  const fieldsOf = e => e.fields ? '\n\n```json\n' + JSON.stringify(e.fields) + '\n```' : '';
  const cand = latestCandidate(run);
  const candidate = cand ? `## Candidate commit\n\n${cand.hash} on ${cand.branch}${cand.changed ? '' : ' (no file changes)'}\n\n\`\`\`\n${cand.stat || 'no changes'}\n\`\`\`\n\n${cand.checks.map(k => `### $ ${k.command} (exit ${k.code})\n\n\`\`\`\n${k.output.trim()}\n\`\`\`\n`).join('\n')}\n` : '';
  const issues = run.issues.length ? `## Objections\n\n${run.issues.map(i => `- ${i.id} [${i.status}] ${i.claim} — resolves when: ${i.condition}`).join('\n')}\n\n` : '';
  const m = run.record?.metrics || metrics(run);
  return head + candidate + issues + `## Meeting record\n\nFloor turns ${m.floorTurns} · stance changes ${m.stanceChanges} · cited concessions ${m.citedConcessions} · objections ${m.objectionsResolved}/${m.objectionsRaised} resolved${m.label ? ` · ${m.label}` : ''}\n\n## Transcript\n\n` +
    run.entries.map(e => `### ${e.id} · ${e.name} · ${e.phase}${e.cycle ? ` cycle ${e.cycle}` : ''}${e.candidateVersion ? ` v${e.candidateVersion}` : ''} · ${e.status}${e.superseded ? ' · superseded' : ''}\n\n${e.text || e.error || 'Pending'}${fieldsOf(e)}\n`).join('\n');
}
