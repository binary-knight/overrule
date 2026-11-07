import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Store } from '../lib/store.mjs';
import { capacity, measureStorage, POLICY } from '../lib/capacity.mjs';
import { createApp } from '../server.mjs';

const KB = 1024, MB = 1024 ** 2, GB = 1024 ** 3;
const members = ['Alpha', 'Beta'].map((name, i) => ({ id: String(i), name, type: 'codex-cli', role: name }));
const block = fields => '\n```json\n' + JSON.stringify(fields) + '\n```';
const phaseOf = prompt => /Write your OPENING POSITION/.test(prompt) ? 'opening' : /RATIFICATION BALLOT/.test(prompt) ? 'ratify' : /You are the drafter/.test(prompt) ? 'draft' : 'floor';
const reply = phase => phase === 'opening' ? 'Opening.' + block({ assumptions: [], risk: 'r', criteria: ['c'] }) : phase === 'draft' ? 'Drafted.' + block({ version: 1, unresolved: [] }) : phase === 'ratify' ? 'Approved.' + block({ vote: 'approve', objections: [], reason: 'ok' }) : 'Agreed.' + block({ stance: 'agree', concedes: [], objections: [], resolves: [], nominates: null });
const past = n => Array.from({ length: n }, (_, i) => ({ id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, kind: 'meeting', prompt: `Meeting ${i}`, status: 'complete', createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, n - i)).toISOString(), participants: members, entries: [], issues: [] }));
const disk = (freeBytes, diskBytes) => async () => ({ bsize: 4096, bavail: Math.floor(freeBytes / 4096), blocks: Math.floor(diskBytes / 4096) });

test('room is half the free space, keeping a tenth of the disk and at least 2 GB free, at a cautious size per meeting', () => {
  // The owner's example: 80 GB free. Meetings may not take it all; they may grow by half of it, leaving 40 GB for everything else.
  const big = capacity({ freeBytes: 80 * GB, diskBytes: 256 * GB, footprints: Array(40).fill(100 * KB) }, 40);
  assert.equal(big.growthBytes, 40 * GB); assert.equal(big.perMeetingBytes, POLICY.minMeetingBytes, 'small meetings are still counted at 256 KB');
  assert.deepEqual([big.more, big.room, big.atNextStart, big.low], [163840, 163880, 163879, false]);
  // Nearly all of a disk free: the tenth kept in reserve is what limits growth, not the half.
  assert.equal(capacity({ freeBytes: 95 * GB, diskBytes: 100 * GB, footprints: [] }, 0).growthBytes, 47.5 * GB);
  assert.equal(capacity({ freeBytes: 12 * GB, diskBytes: 100 * GB, footprints: [] }, 0).growthBytes, 2 * GB, 'a 10 GB reserve leaves 2 of 12');
  // A small disk: the 2 GB floor on the reserve applies.
  const small = capacity({ freeBytes: 3 * GB, diskBytes: 8 * GB, footprints: [] }, 0);
  assert.equal(small.reserveBytes, 2 * GB); assert.equal(small.growthBytes, 1 * GB);
  // The size used is the largest tenth of the meetings here, so a few big meetings with documents make the estimate cautious.
  const mixed = [...Array(17).fill(50 * KB), 5 * MB, 6 * MB, 7 * MB];
  assert.equal(capacity({ freeBytes: 80 * GB, diskBytes: 256 * GB, footprints: mixed }, 20).perMeetingBytes, 5 * MB, "the 18th of 20 by size");
  // No room: the list holds at its size, and the next start makes room for the new meeting by removing one.
  const full = capacity({ freeBytes: 1.5 * GB, diskBytes: 100 * GB, footprints: [] }, 25);
  assert.deepEqual([full.growthBytes, full.more, full.room, full.atNextStart, full.low], [0, 0, 25, 24, true]);
  assert.equal(capacity({ freeBytes: 0, diskBytes: 100 * GB, footprints: [] }, 0).atNextStart, 0, 'never negative');
  assert.equal(capacity({ freeBytes: null }, 5), null, 'unknown free space: no room is claimed either way');
});

test('storage is measured per meeting, documents and patches included, and free space may be unreadable', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'overrule-capacity-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const runs = past(2); runs[0].attachments = [{ id: 'd' }];
  new Store(directory).write('runs.json', runs);
  await mkdir(join(directory, 'attachments', runs[0].id, 'd'), { recursive: true });
  await writeFile(join(directory, 'attachments', runs[0].id, 'd', 'text.txt'), 'x'.repeat(300 * KB));
  await mkdir(join(directory, 'artifacts')); await writeFile(join(directory, 'artifacts', `${runs[1].id}-v1.patch`), 'y'.repeat(50 * KB));
  const measured = await measureStorage(directory, runs, { statfs: disk(10 * GB, 100 * GB) });
  assert.ok(measured.footprints[0] > 300 * KB && measured.footprints[0] < 302 * KB, 'record plus its document');
  assert.ok(measured.footprints[1] > 50 * KB && measured.footprints[1] < 52 * KB, 'record plus its patch');
  assert.ok(measured.meetingsBytes >= 350 * KB); assert.equal(measured.freeBytes, 10 * GB); assert.equal(measured.diskBytes, 100 * GB);
  const unreadable = await measureStorage(directory, runs, { statfs: async () => { throw new Error('not supported'); } });
  assert.equal(unreadable.freeBytes, null); assert.equal(capacity(unreadable, 2), null);
});

async function serve(t, directory, statfs) {
  const app = createApp({ directory, addresses: [], statfs, providerCall: async (p, r) => ({ text: reply(phaseOf(r.prompt)) }), detect: async () => ({ codex: { installed: true, signedIn: true }, claude: { installed: true, signedIn: true } }) });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { app.server.closeAllConnections(); await new Promise(resolve => app.server.close(resolve)); });
  const base = `http://127.0.0.1:${app.server.address().port}`, bootstrap = await (await fetch(base + '/api/bootstrap')).json();
  const headers = { 'Content-Type': 'application/json', 'X-Mesh-Token': bootstrap.token }, ids = bootstrap.providers.map(p => p.id);
  const start = async () => {
    const { id } = await (await fetch(base + '/api/runs', { method: 'POST', headers, body: JSON.stringify({ prompt: 'Another', participantIds: ids, drafterId: ids[0], cycles: 1 }) })).json();
    for (let i = 0; i < 1000 && app.mesh.controllers.has(id); i++) await delay(10);
  };
  return { ...app, base, headers, start, put: (path, data) => fetch(base + path, { method: 'PUT', headers, body: JSON.stringify(data) }) };
}

test('on a full disk the history holds at its size: each new meeting replaces the oldest, and pinned and archived ones stay', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'overrule-full-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const runs = past(12);
  runs[10].pin = { pinnedAt: '2026-01-01T00:00:00Z', tags: [], project: '' }; runs[11].archived = { at: '2026-01-01T00:00:00Z' };
  new Store(directory).write('runs.json', runs);
  let free = 1 * GB; // below the 2 GB reserve: no room to grow
  const app = await serve(t, directory, async () => ({ bsize: 4096, bavail: Math.floor(free / 4096), blocks: Math.floor(100 * GB / 4096) }));
  assert.equal((await app.put('/api/settings', { historyLimit: 'max' })).status, 200);
  const view = await (await fetch(app.base + '/api/settings')).json();
  assert.equal(view.capacity.low, true); assert.equal(view.capacity.room, 10);
  const unpinned = async () => (await (await fetch(app.base + '/api/runs')).json()).filter(r => !r.pin && !r.archived);
  assert.equal((await unpinned()).filter(r => r.expiring).length, 1, 'the oldest is marked as the next to go');
  const oldest = runs[9].id;
  for (let i = 0; i < 3; i++) await app.start();
  const after = await unpinned();
  assert.equal(after.length, 10, 'neither grown nor cut back');
  assert.ok(!after.some(r => r.id === oldest), 'the oldest made room first');
  const all = await (await fetch(app.base + '/api/runs')).json();
  assert.ok(all.some(r => r.id === runs[10].id) && all.some(r => r.id === runs[11].id), 'pinned and archived untouched');
  // A number saved while there was room is held to what fits now, and the interface is told the limit in force.
  free = 80 * GB;
  assert.equal((await app.put('/api/settings', { historyLimit: 500 })).status, 200);
  free = 1 * GB;
  // (Listing the history may reuse a measurement up to half a minute old; Settings and every meeting start measure afresh.)
  const fresh = await (await fetch(app.base + '/api/settings')).json();
  assert.equal(fresh.historyLimit, 500); assert.ok(fresh.effectiveLimit < 500);
  // Space comes back: the history may grow again, and a number above the room is refused while it is short.
  free = 80 * GB;
  await app.start();
  assert.equal((await unpinned()).length, 11, 'grew by the new meeting');
  free = 1 * GB;
  assert.match((await (await app.put('/api/settings', { historyLimit: 5000 })).json()).error, /safe room for about 11 meetings/);
});
