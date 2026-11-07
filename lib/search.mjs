// Searching meetings. A query is words and "quoted phrases"; a meeting matches when every one of them appears somewhere in it,
// ignoring case: its name, tags and project, brief, workspace and documents, members, final answers, or transcript. Each match
// says where it was found, with a short excerpt, so a meeting found by something said in its transcript shows why it is listed.

import { parseQuery } from '../public/meeting-state.js';
export { parseQuery };

// Searched in this order; the first field holding a term is the one reported.
const FIELDS = [
  ['name', run => run.title || ''],
  ['tags', run => [...(run.pin?.tags || []), run.pin?.project || ''].filter(Boolean).join(' · ')],
  ['brief', run => (run.demo ? 'Scripted demo. ' : '') + (run.prompt || '')],
  ['details', run => [run.workspace?.name, run.workspace?.origin, ...(run.attachments || []).map(a => a.name), ...(run.participants || []).map(p => p.name), run.id].filter(Boolean).join(' · ')],
  ['answer', run => [run.final, ...(run.sessions || []).map(s => s.final)].filter(Boolean).join('\n\n')],
  ['transcript', run => (run.entries || []).filter(e => e.text).map(e => `${e.name}: ${e.text}`).join('\n\n')],
];

// A stopped meeting's text changes only when it is renamed, pinned, reconvened, or resumed, so its lowercased fields are kept
// between searches; a meeting in session is read afresh each time. This keeps typing responsive on a long history.
const cache = new WeakMap();
function fieldsOf(run) {
  const signature = run.status === 'running' ? null : [run.status, run.seq, run.title, JSON.stringify(run.pin || null), (run.final || '').length, run.sessions?.length || 0, run.entries?.length || 0].join('|');
  const hit = signature && cache.get(run);
  if (hit && hit.signature === signature) return hit.fields;
  const fields = FIELDS.map(([name, read]) => { const raw = read(run); return { name, raw, lower: raw.toLowerCase() }; });
  if (signature) cache.set(run, { signature, fields });
  return fields;
}

const escapeRegExp = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Around the first occurrence in the original text, found case-insensitively there so the excerpt is exact whatever the letters.
function excerpt(raw, term, before = 60, after = 110) {
  const found = new RegExp(escapeRegExp(term), 'iu').exec(raw);
  const at = found ? found.index : 0;
  const start = Math.max(0, at - before), end = Math.min(raw.length, at + term.length + after);
  return { at, snippet: `${start > 0 ? '…' : ''}${raw.slice(start, end).replace(/\s+/g, ' ').trim()}${end < raw.length ? '…' : ''}` };
}

// Returns null when the query has no terms (nothing to filter), otherwise a Map of matching meeting ids to { field, snippet }.
export function searchRuns(runs, query) {
  const terms = parseQuery(query);
  if (!terms.length) return null;
  const matches = new Map();
  for (const run of runs) {
    const fields = fieldsOf(run);
    if (!terms.every(term => fields.some(f => f.lower.includes(term)))) continue;
    const field = fields.find(f => terms.some(term => f.lower.includes(term)));
    const term = terms.find(t => field.lower.includes(t));
    // "at" is where in that field the match begins, so a caller can tell whether the listing already shows it.
    matches.set(run.id, field.name === 'name' ? { field: 'name', snippet: null, at: field.lower.indexOf(term) } : { field: field.name, ...excerpt(field.raw, term) });
  }
  return matches;
}
