// Optional real-provider smoke test. Uses existing local CLI credentials and plan allowance.
const base = 'http://127.0.0.1:4310';
const bootstrap = await (await fetch(`${base}/api/bootstrap`)).json();
const response = await fetch(`${base}/api/runs`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-Mesh-Token': bootstrap.token },
  body: JSON.stringify({ prompt: 'Connection smoke test: Which is larger as a decimal number, 9.11 or 9.9? Give the correct answer with a brief check. Keep every contribution under 80 words before the structured block. Do not use any tools.', participantIds: ['codex-local', 'claude-local'], drafterId: 'codex-local', cycles: 1, timeoutSeconds: 120, maxTokens: 768 }),
});
const created = await response.json();
if (!response.ok) throw new Error(created.error);
console.log(`Live check started: ${created.id}`);
let previous = '';
for (let i = 0; i < 300; i++) {
  const run = await (await fetch(`${base}/api/runs/${created.id}`)).json();
  const progress = run.entries.map(e => `${e.id} ${e.name}/${e.phase}: ${e.status}${e.fields?.stance ? ` ${e.fields.stance}` : ''}${e.fields?.parsed === false ? ' UNPARSED' : ''}${e.error ? ` (${e.error})` : ''}`).join('; ');
  if (progress !== previous) { console.log(progress); previous = progress; }
  if (run.status !== 'running') {
    const unparsed = run.entries.filter(e => e.status === 'complete' && e.fields?.parsed === false).map(e => e.id);
    console.log(JSON.stringify({ status: run.status, stopReason: run.stopReason, record: run.record, unparsed, final: run.final, error: run.error }, null, 2));
    // A meeting only proves itself when the real models followed the structured block; unparsed turns close it on budget.
    process.exitCode = run.status === 'complete' && unparsed.length === 0 ? 0 : 1;
    break;
  }
  await new Promise(resolve => setTimeout(resolve, 2000));
}
