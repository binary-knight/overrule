// How many meetings the history can safely keep on this disk. Meetings may grow into at most half of the space that is free now,
// and the disk always keeps a reserve free for everything else: a tenth of its size, and never less than 2 GB. A meeting is assumed
// to take as much as the largest tenth of the meetings already here, and never less than 256 KB, so the estimate errs on the safe
// side. When there is no room left the history stops growing, and each new meeting replaces the oldest unpinned one; it never
// shrinks to give back space that something else used, and pinned and archived meetings are never touched.
import { readdir, stat, statfs as fsStatfs } from 'node:fs/promises';
import { join } from 'node:path';

export const POLICY = { shareOfFree: 0.5, reserveShare: 0.1, reserveMinBytes: 2 * 1024 ** 3, minMeetingBytes: 256 * 1024 };

async function sizeOf(path) {
  let info; try { info = await stat(path); } catch { return 0; }
  if (!info.isDirectory()) return info.size;
  let total = 0; for (const name of await readdir(path).catch(() => [])) total += await sizeOf(join(path, name));
  return total;
}

// What meetings occupy, one by one and in total, and what the disk holding them has. Free space is null when it cannot be read.
export async function measureStorage(directory, runs, { statfs = fsStatfs } = {}) {
  const patches = new Map();
  for (const name of await readdir(join(directory, 'artifacts')).catch(() => [])) {
    const id = name.replace(/-v\d+\.patch$/, '');
    patches.set(id, (patches.get(id) || 0) + await sizeOf(join(directory, 'artifacts', name)));
  }
  const footprints = [];
  for (const run of runs) {
    const documents = run.attachments?.length ? await sizeOf(join(directory, 'attachments', run.id)) : 0;
    footprints.push(Buffer.byteLength(JSON.stringify(run, null, 2)) + documents + (patches.get(run.id) || 0));
  }
  const meetingsBytes = (await sizeOf(join(directory, 'runs.json'))) + (await sizeOf(join(directory, 'attachments'))) + (await sizeOf(join(directory, 'artifacts')));
  let freeBytes = null, diskBytes = null;
  try { const disk = await statfs(directory); freeBytes = disk.bavail * disk.bsize; diskBytes = disk.blocks * disk.bsize; } catch {}
  return { meetingsBytes, freeBytes, diskBytes, footprints };
}

// `counted` is how many meetings the history limit applies to now (stopped, neither pinned nor archived). Returns null when free
// space is unknown, otherwise:
//   room         the most meetings the list can keep: those it has, plus as many more as fit in the growth allowed;
//   atNextStart  the limit to apply when a meeting starts, whose own space comes out of that allowance first. With no room
//                left this is one fewer than the list holds, so the new meeting replaces the oldest instead of adding to it.
export function capacity({ freeBytes, diskBytes, footprints = [] }, counted, policy = POLICY) {
  if (freeBytes === null || freeBytes === undefined || !Number.isFinite(freeBytes)) return null;
  const sorted = [...footprints].sort((a, b) => a - b);
  const largestTenth = sorted.length ? sorted[Math.floor(0.9 * (sorted.length - 1))] : 0;
  const perMeetingBytes = Math.max(policy.minMeetingBytes, largestTenth);
  const reserveBytes = Math.max(policy.reserveMinBytes, (diskBytes || 0) * policy.reserveShare);
  const growthBytes = Math.max(0, Math.min(freeBytes * policy.shareOfFree, freeBytes - reserveBytes));
  const more = Math.floor(growthBytes / perMeetingBytes);
  return { perMeetingBytes, reserveBytes, growthBytes, more, room: counted + more, atNextStart: Math.max(0, counted + more - 1), low: more < 1 };
}
