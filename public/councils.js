// Saved councils: named sets of seats, with whichever meeting settings the owner chose to keep. Shared by the server, which
// validates and stores them, the browser, which applies and saves them, and the command line, so all three describe a council,
// read one from a finished meeting, and tell what has changed since one was applied in the same way.

// The settings a council can keep besides its seats, which it always keeps. A council applies only the groups it kept; everything
// else stays as the form or the command line already has it.
export const COUNCIL_GROUPS = [
  { id: 'drafter', label: 'Drafter', hint: 'who writes the candidate, and whether as a neutral drafter' },
  { id: 'cycles', label: 'Meeting length', hint: 'how many cycles the floor runs' },
  { id: 'revisions', label: 'Revisions after objections', hint: 'how many times the drafter may revise' },
  { id: 'research', label: 'Research', hint: 'internet research and deep research' },
  { id: 'limits', label: 'Limits', hint: 'session call and time limits, output tokens and time per call' },
];
export const GROUP_IDS = COUNCIL_GROUPS.map(g => g.id);
export const MAX_SEATS = 8;

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
// One line per kept group, in the owner's words. nameOf turns a connection id into its name.
export function describeGroup(id, value, nameOf = x => x) {
  if (id === 'drafter') return `${nameOf(value.drafterId)} drafts${value.neutralDrafter ? ' as a neutral drafter' : ''}`;
  if (id === 'cycles') return plural(value, 'cycle');
  if (id === 'revisions') return value ? plural(value, 'revision') : 'no revisions';
  if (id === 'research') return value.deepResearch ? 'deep research' : value.research ? 'internet research' : 'no research';
  if (id === 'limits') {
    return `${value.maxCalls ? plural(value.maxCalls, 'call') : 'automatic call limit'}, ${Math.round(value.maxDurationSeconds / 60)} min, ${Number(value.maxTokens).toLocaleString('en-US')} output tokens and ${value.timeoutSeconds} s per call`;
  }
  return '';
}
export function describeCouncil(council, nameOf = x => x) {
  return [council.seats.map(nameOf).join(', '), ...GROUP_IDS.filter(id => id in (council.settings || {})).map(id => describeGroup(id, council.settings[id], nameOf))].join(' · ');
}

import { estimateCalls } from './meeting-state.js';

// Everything a council could keep, read from a meeting as it last ran (a resumed or reconvened meeting's latest settings).
export function snapshotFromRun(run) {
  // A meeting on the automatic call limit records the number it worked out to. A council keeps "automatic" instead, so the limit
  // follows its seats and cycles the next time rather than freezing this meeting's count. (A later session has no openings.)
  const count = (run.participants || []).length, revisions = run.maxRevisions ?? 1;
  const automatic = [true, false].map(openings => estimateCalls(count, run.cycles, revisions, openings).maximum);
  const maxCalls = run.budget?.maxCalls && !automatic.includes(run.budget.maxCalls) ? run.budget.maxCalls : null;
  return {
    seats: (run.participants || []).map(p => p.id),
    settings: {
      drafter: { drafterId: run.drafterId, neutralDrafter: run.neutralDrafter === true },
      cycles: run.cycles,
      revisions: run.maxRevisions ?? 1,
      research: { research: run.research === true, deepResearch: run.deepResearch === true },
      // The form and the command line set time in whole minutes, so the snapshot does too; otherwise applying it would read as a change.
      limits: { maxCalls, maxDurationSeconds: Math.max(60, Math.round((run.budget?.maxDurationSeconds ?? 3600) / 60) * 60), maxTokens: run.maxTokens ?? 4096, timeoutSeconds: run.timeoutSeconds ?? 180 },
    },
  };
}
// Keep only the chosen groups of a snapshot.
export function keep(settings, groups) {
  return Object.fromEntries(GROUP_IDS.filter(id => groups.includes(id) && settings[id] !== undefined).map(id => [id, settings[id]]));
}
// What differs between a council and the settings now in use: 'seats' and the ids of kept groups whose values changed.
export function changesFrom(council, current) {
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const seats = [...council.seats].sort(), now = [...current.seats].sort();
  return [...(same(seats, now) ? [] : ['seats']), ...GROUP_IDS.filter(id => id in (council.settings || {}) && !same(council.settings[id], current.settings[id]))];
}
