// Shared by the server and browser so budgets, citations, and verdicts agree.
const committed = run => (run.entries || []).filter(e => e.status === 'complete' && !e.superseded);
export const currentDraft = run => committed(run).find(e => e.phase === 'draft' && e.candidateVersion === run.candidateVersion);
export function estimateCalls(count, cycles, revisions = 1, openings = true) {
  const initial = openings ? count : 0, floor = count * cycles;
  return { typical: initial + floor + count, maximum: initial + floor * 2 + count * (1 + revisions) };
}
// An objection's standing after the ballot. A member who votes to approve the current candidate has accepted it, so an objection
// that member raised on the floor no longer stands: leaving it open would report doubt its own author has withdrawn. Judged from
// the log, so an older meeting is read the same way.
export function issueStatus(run, issue) {
  if (issue.status !== 'open') return issue.status;
  const approved = (run.entries || []).some(e => e.phase === 'ratify' && e.status === 'complete' && !e.superseded && e.candidateVersion === run.candidateVersion
    && e.speaker === issue.raisedBy && e.fields?.vote === 'approve' && (e.seq ?? Infinity) > (issue.seq ?? -Infinity));
  return approved ? 'withdrawn' : 'open';
}
export const openIssuesOf = run => (run.issues || []).filter(i => issueStatus(run, i) === 'open');

export function callsUsed(run, allSessions = false) {
  return (run.entries || []).filter(e => e.speaker !== 'owner' && ['opening', 'floor', 'draft', 'ratify', 'propose', 'review', 'synthesize'].includes(e.phase) && (allSessions || (e.session || 1) === (run.session || 1))).length;
}
export function elapsedBudget(run, now = Date.now()) {
  return (run.budget?.elapsedMs || 0) + (run.budget?.activeSince ? Math.max(0, now - run.budget.activeSince) : 0);
}
export function candidateReady(run, candidate) {
  if (!candidate || (candidate.checkStatus && candidate.checkStatus !== 'complete')) return false;
  const commands = run.workspace?.checks || [], checks = candidate.checks || [];
  return checks.length === commands.length && commands.every((command, i) => checks[i].command === command && Number.isInteger(checks[i].code));
}
// A quotation is checked for its words, not its typography: members restyle quote marks and drop Markdown emphasis when they
// quote, and an accurate quotation must not be rejected for that. Anything that changes the words still fails.
const quoteText = text => String(text || '').normalize('NFKC').replace(/[\u2018\u2019\u201A\u201B\u2032`]/gu, "'").replace(/[\u201C\u201D\u201E\u201F\u2033]/gu, '"')
  .replace(/["']/gu, '"').replace(/\*\*|__|~~|`/gu, '').replace(/(^|\s)[*_]+|[*_]+(?=\s|$|[.,;:!?])/gu, '$1').replace(/\s+/gu, ' ').trim();
export function citationEvidence(run, entry, citations = entry.fields?.concedes || []) {
  const valid = [], invalid = [];
  for (const value of (Array.isArray(citations) ? citations : []).slice(0, 10)) {
    const id = typeof value?.entry === 'string' ? value.entry.trim() : '';
    const quote = typeof value?.quote === 'string' ? value.quote.trim() : '';
    const source = (run.entries || []).find(e => e.id === id);
    let reason;
    if (!id || !quote || id.length > 20 || quote.length > 600) reason = 'Missing or oversized entry ID or quotation.';
    else if (!source || source.status !== 'complete' || source.superseded) reason = 'The cited entry is missing, incomplete, or superseded.';
    else if (source.id === entry.id || source.seq >= entry.seq) reason = 'A citation must refer to an earlier contribution.';
    else if (!quoteText(source.text).includes(quoteText(quote))) reason = 'The quoted passage does not appear in that entry.';
    const item = { entry: id.slice(0, 20), quote: quote.slice(0, 600) };
    if (reason) invalid.push({ ...item, reason });
    else if (!valid.some(c => c.entry === id && c.quote === quote)) valid.push(item);
  }
  return { valid, invalid };
}
export function assessResult(run) {
  const done = committed(run), draft = currentDraft(run), candidate = draft?.candidate;
  const active = (run.participants || []).filter(p => !(run.dropped || []).includes(p.id) && done.some(e => e.phase === 'opening' && e.speaker === p.id));
  const voters = active.filter(p => p.id !== run.drafterId);
  const ballots = voters.map(p => done.filter(e => e.phase === 'ratify' && e.candidateVersion === run.candidateVersion && e.speaker === p.id && (!candidate || !e.candidateHash || e.candidateHash === candidate.hash)).at(-1)).filter(Boolean);
  const votes = { approve: 0, object: 0, abstain: 0 };
  for (const ballot of ballots) votes[['approve', 'object', 'abstain'].includes(ballot.fields?.vote) ? ballot.fields.vote : 'abstain']++;
  const missingBallots = voters.length - ballots.length;
  const checks = candidate?.checks || [], openIssues = openIssuesOf(run);
  const writeWorkspace = run.workspace && run.workspace.level !== 'read-only';
  // A member voting against the candidate is dissent. A floor objection nobody answered before the budget ran out is not the
  // same thing, and a caller that can buy more turns should be able to tell them apart without reading the prose.
  const dissent = Boolean(votes.object);
  const unsettled = !dissent && Boolean(openIssues.length || draft?.fields?.unresolved?.length) && ['budget', 'stalled'].includes(run.stopReason);
  let code = 'incomplete', label = 'Verification incomplete';
  if (checks.some(c => Number.isInteger(c.code) && c.code !== 0)) { code = 'checks-failed'; label = 'Checks failed'; }
  else if (dissent) { code = 'objections'; label = 'Objections remain'; }
  // A meeting that failed before anyone drafted an answer did not run out of turns, whatever the floor's stop reason says.
  else if (run.status === 'failed' && !draft) { code = 'incomplete'; label = 'Incomplete: the meeting stopped on an error before an answer was drafted'; }
  else if (unsettled) { code = 'unsettled'; label = run.stopReason === 'stalled' ? 'Unsettled: the floor stopped moving' : 'Unsettled: the meeting ran out of turns'; }
  else if (openIssues.length || draft?.fields?.unresolved?.length) { code = 'objections'; label = 'Objections remain'; }
  else if (draft && (!writeWorkspace || candidateReady(run, candidate)) && voters.length > 0 && !missingBallots && votes.approve === voters.length && run.status === 'complete') { code = 'approved'; label = 'Approved'; }
  const verification = !writeWorkspace || !(run.workspace.checks || []).length ? 'No independent automated checks; approval records model agreement.' : !candidateReady(run, candidate) ? 'Configured checks have not all finished.' : checks.some(c => c.code !== 0) ? 'Review the failing checks before applying.' : 'All configured checks passed on the recorded commit.';
  return { code, label, verification, dissent, stopReason: run.stopReason || null, votes, voters: voters.length, missingBallots, ballots, draft, candidate, openIssues };
}
