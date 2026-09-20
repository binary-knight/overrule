import { callsUsed, elapsedBudget, estimateCalls } from '../public/meeting-state.js';

// Pause is not an error, but it travels the same path: the loop stops between steps and the meeting keeps everything it has.
export class PauseError extends Error {
  constructor() { super('Paused by the owner. Adjust anything you like, then resume.'); this.name = 'PauseError'; }
}
export class BudgetLimitError extends Error {
  constructor(kind) {
    super(`${kind === 'calls' ? 'Call' : 'Time'} limit reached. Increase this session's limits to resume; work already recorded is kept.`);
    this.name = 'BudgetLimitError'; this.kind = kind;
  }
}
export function validateLimits(input, fallback) {
  const maxCalls = Number(input.maxCalls ?? fallback.maxCalls);
  const maxDurationSeconds = Number(input.maxDurationSeconds ?? fallback.maxDurationSeconds);
  if (!Number.isInteger(maxCalls) || maxCalls < 1 || maxCalls > 1000) throw new Error('Use a session call limit between 1 and 1,000.');
  if (!Number.isInteger(maxDurationSeconds) || maxDurationSeconds < 1 || maxDurationSeconds > 86400) throw new Error('Use a session time limit between 1 second and 24 hours.');
  return { maxCalls, maxDurationSeconds };
}
export function newBudget(options, openings = true) {
  const maximum = estimateCalls(options.participants.length, options.cycles, options.maxRevisions ?? 1, openings).maximum;
  return { ...validateLimits(options, { maxCalls: maximum, maxDurationSeconds: 3600 }), elapsedMs: 0, activeSince: null };
}
// A session deadline that fires mid-implementation cancels the draft and its checkout is removed, so the session must outlast
// the implementer. The check batch gets the same allowance again, hence the advice to leave room for both.
export function assertCoversImplementer(maxDurationSeconds, workspace) {
  if (!workspace || workspace.level === 'read-only' || !workspace.implementTimeout) return;
  if (maxDurationSeconds < workspace.implementTimeout) {
    const minutes = n => `${Math.ceil(n / 60)} min`;
    throw new Error(`The session time limit (${minutes(maxDurationSeconds)}) is shorter than the implementer time limit (${minutes(workspace.implementTimeout)}); a deadline during implementation would throw the work away. Set the session limit to at least ${minutes(workspace.implementTimeout)}, and to ${minutes(workspace.implementTimeout * 2)} or more if the candidate has checks to run.`);
  }
}
export function assertBudget(run, calls = 0) {
  if (elapsedBudget(run) >= run.budget.maxDurationSeconds * 1000) throw new BudgetLimitError('time');
  if (callsUsed(run) + calls > run.budget.maxCalls) throw new BudgetLimitError('calls');
}
export function settleBudget(run, now = Date.now()) {
  if (!run.budget) return;
  run.budget.elapsedMs = Math.min(elapsedBudget(run, now), run.budget.maxDurationSeconds * 1000);
  run.budget.activeSince = null;
}
