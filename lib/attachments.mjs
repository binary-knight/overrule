// Documents the owner drops into a meeting. A file is saved under the data directory, its text is extracted once at upload,
// members read that text in their prompts, and the files go away when the meeting closes. Nothing here is ever executed, and
// nothing from inside an archive is written to disk under a name the archive chose.
import { createWriteStream, existsSync } from 'node:fs';
import { mkdir, rm, readFile, writeFile, readdir, rename, stat, mkdtemp } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import { runProcess } from './providers.mjs';

export const MAX_FILE_BYTES = 25 * 1024 * 1024;
export const MAX_FILES = 10;
export const MAX_MEETING_BYTES = 60 * 1024 * 1024;
export const MAX_STAGED = 40;
export const TEXT_STORE_CAP = 2_000_000; // characters of extracted text kept per file; prompts take far less (see DOCUMENT_CAP in meeting.mjs)
const STAGED_TTL_MS = 24 * 60 * 60 * 1000;
const ZIP_ENTRY_CAP = 8 * 1024 * 1024, ZIP_TOTAL_CAP = 48 * 1024 * 1024, ZIP_READ_ENTRIES = 300;

const TEXT_EXT = new Set(['txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'jsonl', 'yaml', 'yml', 'xml', 'html', 'htm', 'log', 'ini', 'toml', 'conf', 'cfg', 'sql', 'sh', 'bat', 'ps1', 'py', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'java', 'c', 'h', 'cpp', 'hpp', 'cs', 'go', 'rs', 'rb', 'php', 'swift', 'kt', 'css', 'scss', 'tex', 'rst', 'srt', 'vtt']);
const OFFICE_EXT = new Set(['docx', 'pptx', 'xlsx', 'odt', 'ods', 'odp']);
const LEGACY_EXT = new Set(['doc', 'xls', 'ppt', 'rtf']);
export const ACCEPTED = [...TEXT_EXT, ...OFFICE_EXT, ...LEGACY_EXT, 'pdf', 'zip'];
const extOf = name => extname(String(name)).slice(1).toLowerCase();
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// A display name only: the file on disk is always called "file". Path parts, control characters, and length are cut here.
export function cleanName(input) {
  const name = String(input || '').split(/[\\/]/).pop().replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 120);
  if (!name || name === '.' || name === '..') throw new Error('The file needs a name.');
  return name;
}
export function assertAccepted(name) {
  const ext = extOf(name);
  if (!ACCEPTED.includes(ext)) throw new Error(`${ext ? '.' + ext : 'That kind of'} file cannot be read as text. Accepted: PDF, Word, Excel, PowerPoint, OpenDocument, zip, and plain text or code files.`);
  return ext;
}

// ---------- zip, read in memory ----------
export function zipEntries(buffer) {
  let eocd = -1;
  for (let i = buffer.length - 22, min = Math.max(0, buffer.length - 65_557); i >= min; i--) if (buffer.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('This is not a readable zip archive.');
  const count = buffer.readUInt16LE(eocd + 10); let p = buffer.readUInt32LE(eocd + 16);
  if (count === 0xffff || p === 0xffffffff) throw new Error('Zip64 archives are not supported. Make a smaller archive.');
  const entries = [];
  for (let i = 0; i < count; i++) {
    if (p + 46 > buffer.length || buffer.readUInt32LE(p) !== 0x02014b50) throw new Error('The zip directory is damaged.');
    const nameLength = buffer.readUInt16LE(p + 28);
    entries.push({ name: buffer.subarray(p + 46, p + 46 + nameLength).toString('utf8'), encrypted: Boolean(buffer.readUInt16LE(p + 8) & 1), method: buffer.readUInt16LE(p + 10), compressed: buffer.readUInt32LE(p + 20), size: buffer.readUInt32LE(p + 24), local: buffer.readUInt32LE(p + 42) });
    p += 46 + nameLength + buffer.readUInt16LE(p + 30) + buffer.readUInt16LE(p + 32);
  }
  return entries;
}
// The declared size is never trusted: inflation stops at the limit, which is what defuses a zip bomb.
export function zipRead(buffer, entry, limit = ZIP_ENTRY_CAP) {
  if (entry.encrypted) throw new Error('password-protected');
  const p = entry.local;
  if (p + 30 > buffer.length || buffer.readUInt32LE(p) !== 0x04034b50) throw new Error('damaged');
  const start = p + 30 + buffer.readUInt16LE(p + 26) + buffer.readUInt16LE(p + 28), data = buffer.subarray(start, start + entry.compressed);
  if (entry.method === 0) { if (data.length > limit) throw new Error('too large'); return data; }
  if (entry.method !== 8) throw new Error('unsupported compression');
  try { return inflateRawSync(data, { maxOutputLength: limit }); } catch (error) { throw new Error(error.code === 'ERR_BUFFER_TOO_LARGE' ? 'too large' : 'damaged'); }
}

// ---------- office formats are zip archives of XML ----------
const entities = text => text.replace(/&(#x?[0-9a-f]+|amp|lt|gt|quot|apos);/gi, (_, e) => e[0] === '#' ? String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[e.toLowerCase()]);
const strip = xml => entities(xml.replace(/<[^>]+>/g, '')).replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
const numbered = (entries, pattern) => entries.filter(e => pattern.test(e.name)).sort((a, b) => Number(a.name.match(pattern)[1]) - Number(b.name.match(pattern)[1]));
function officeText(buffer, ext) {
  const entries = zipEntries(buffer), read = name => { const e = entries.find(x => x.name === name); return e ? zipRead(buffer, e, ZIP_TOTAL_CAP).toString('utf8') : ''; };
  if (ext === 'docx') return strip(['word/document.xml', 'word/footnotes.xml', 'word/endnotes.xml'].map(read).join('\n').replace(/<w:tab\b[^>]*\/>/g, '\t').replace(/<w:br\b[^>]*\/>/g, '\n').replace(/<\/w:p>/g, '\n'));
  if (ext === 'pptx') return numbered(entries, /^ppt\/slides\/slide(\d+)\.xml$/).map(e => `Slide ${e.name.match(/(\d+)\.xml$/)[1]}\n${strip(zipRead(buffer, e, ZIP_TOTAL_CAP).toString('utf8').replace(/<\/a:p>/g, '\n'))}`).join('\n\n');
  if (ext === 'xlsx') {
    const shared = [...read('xl/sharedStrings.xml').matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)].map(m => strip([...m[1].matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map(t => t[1]).join('')));
    const names = [...read('xl/workbook.xml').matchAll(/<sheet\b[^>]*\bname="([^"]*)"/g)].map(m => entities(m[1]));
    return numbered(entries, /^xl\/worksheets\/sheet(\d+)\.xml$/).map((e, i) => {
      const rows = [...zipRead(buffer, e, ZIP_TOTAL_CAP).toString('utf8').matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)].map(row => [...row[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)].map(cell => {
        const type = (cell[1].match(/\bt="([^"]*)"/) || [])[1], inner = cell[2] || '', value = (inner.match(/<v\b[^>]*>([\s\S]*?)<\/v>/) || [])[1];
        if (type === 's') return shared[Number(value)] ?? '';
        if (type === 'inlineStr') return strip(inner);
        return value === undefined ? '' : entities(value);
      }).join('\t').replace(/\t+$/, ''));
      return `Sheet: ${names[i] || i + 1}\n${rows.filter(Boolean).join('\n')}`;
    }).join('\n\n');
  }
  // OpenDocument text, spreadsheet, presentation
  return strip(read('content.xml').replace(/<text:tab\b[^>]*\/>/g, '\t').replace(/<text:line-break\b[^>]*\/>/g, '\n').replace(/<\/table:table-cell>/g, '\t').replace(/<\/(text:p|text:h|table:table-row|draw:page)>/g, '\n'));
}

// ---------- tools on the host, for the formats that need them ----------
async function withTempFile(buffer, ext, work) {
  const dir = await mkdtemp(join(tmpdir(), 'mesh-doc-'));
  try { const file = join(dir, `doc.${ext}`); await writeFile(file, buffer, { mode: 0o600 }); return await work(file, dir); }
  finally { await rm(dir, { recursive: true, force: true }); }
}
async function pdfText(file, run) {
  let result;
  try { result = await run('pdftotext', ['-layout', '-enc', 'UTF-8', file, '-'], { capture: true, limit: 16_000_000, signal: AbortSignal.timeout(60_000) }); }
  catch (error) { throw new Error(/not installed|ENOENT/.test(error.message) ? 'PDF text needs pdftotext on the host (sudo apt install poppler-utils).' : 'pdftotext could not read this PDF.'); }
  if (result.code !== 0) throw new Error(/password|encrypt/i.test(result.stderr) ? 'This PDF is password-protected.' : 'pdftotext could not read this PDF.');
  return result.stdout.replace(/\f/g, '\n\n');
}
// Old binary Office formats go through LibreOffice with a throwaway profile, so nothing in the account's own profile is touched.
async function legacyText(file, dir, ext, run) {
  const target = ext === 'xls' ? 'csv' : ext === 'ppt' ? 'pdf' : 'txt:Text';
  try { await run('soffice', [`-env:UserInstallation=file://${join(dir, 'profile')}`, '--headless', '--norestore', '--convert-to', target, '--outdir', dir, file], { capture: true, cwd: dir, signal: AbortSignal.timeout(90_000) }); }
  catch (error) { throw new Error(/not installed|ENOENT/.test(error.message) ? `Old .${ext} files need LibreOffice on the host. Save the file as .${ext}x and attach that instead.` : `LibreOffice could not convert this .${ext} file.`); }
  const out = join(dir, `doc.${target.split(':')[0]}`);
  if (!existsSync(out)) throw new Error(`LibreOffice could not convert this .${ext} file.`);
  return ext === 'ppt' ? pdfText(out, run) : readFile(out, 'utf8');
}
const looksBinary = buffer => buffer.subarray(0, 8192).includes(0);

// Text of one document held in memory. Returns { text, warning }; a document that yields nothing is still attached, with the reason.
export async function extractText(buffer, name, { run = runProcess, nested = false } = {}) {
  const ext = extOf(name);
  try {
    if (TEXT_EXT.has(ext)) { if (looksBinary(buffer)) return { text: '', warning: 'This file is not plain text.' }; return finish(buffer.toString('utf8')); }
    if (OFFICE_EXT.has(ext)) return finish(officeText(buffer, ext));
    if (ext === 'pdf') return finish(await withTempFile(buffer, 'pdf', file => pdfText(file, run)), 'No text layer was found. A scanned PDF needs OCR before members can read it.');
    if (LEGACY_EXT.has(ext)) return finish(await withTempFile(buffer, ext, (file, dir) => legacyText(file, dir, ext, run)));
    if (ext === 'zip' && !nested) return await zipText(buffer, run);
    return { text: '', warning: nested ? 'Not read: an archive inside an archive, or a kind of file with no text.' : 'This kind of file has no readable text.' };
  } catch (error) { return { text: '', warning: error.message }; }
}
function finish(text, emptyWarning = 'No text was found in this file.') {
  const clean = String(text || '').replace(/\r\n?/g, '\n').replace(/\u0000/g, '').trim();
  if (!clean) return { text: '', warning: emptyWarning };
  return clean.length > TEXT_STORE_CAP ? { text: clean.slice(0, TEXT_STORE_CAP), warning: `Only the first ${TEXT_STORE_CAP.toLocaleString('en-US')} characters were kept.` } : { text: clean, warning: '' };
}
async function zipText(buffer, run) {
  const entries = zipEntries(buffer).filter(e => !e.name.endsWith('/'));
  const parts = [`Archive contents (${entries.length} file${entries.length === 1 ? '' : 's'}):\n${entries.slice(0, 500).map(e => `- ${e.name} (${e.size.toLocaleString('en-US')} bytes)`).join('\n')}${entries.length > 500 ? '\n- …' : ''}`];
  const skipped = []; let total = 0, read = 0;
  for (const entry of entries) {
    const label = entry.name.replace(/[\u0000-\u001f]/g, '');
    if (/(^|[\\/])\.\.([\\/]|$)/.test(entry.name) || /^([\\/]|[a-z]:)/i.test(entry.name)) { skipped.push(`${label} (unsafe path)`); continue; }
    if (/(^|\/)(__MACOSX|\.git|node_modules)\//.test(entry.name) || !ACCEPTED.includes(extOf(entry.name))) continue;
    if (read >= ZIP_READ_ENTRIES) { skipped.push(`${label} (over ${ZIP_READ_ENTRIES} files)`); continue; }
    let data;
    try { data = zipRead(buffer, entry); } catch (error) { skipped.push(`${label} (${error.message})`); continue; }
    total += data.length; if (total > ZIP_TOTAL_CAP) { skipped.push(`${label} and later files (archive expands past ${ZIP_TOTAL_CAP / 1024 / 1024} MB)`); break; }
    read++;
    const inner = await extractText(data, entry.name, { run, nested: true });
    if (inner.text) parts.push(`=== ${label} ===\n${inner.text}`); else skipped.push(`${label} (${inner.warning})`);
  }
  const result = finish(parts.join('\n\n'));
  const notes = [read ? '' : 'No readable documents were found inside; members see only the file list.', skipped.length ? `Not read: ${skipped.slice(0, 8).join('; ')}${skipped.length > 8 ? `; and ${skipped.length - 8} more` : ''}.` : '', result.warning].filter(Boolean);
  return { text: result.text, warning: notes.join(' ') };
}

// ---------- storage: staged until a meeting claims them, then removed when it closes ----------
export class Attachments {
  constructor(directory, { run = runProcess } = {}) { this.root = join(directory, 'attachments'); this.staged = join(this.root, 'staged'); this.run = run; }
  dir(id, runId) { if (!ID.test(id) || (runId && !ID.test(runId))) throw new Error('Unknown document.'); return runId ? join(this.root, runId, id) : join(this.staged, id); }
  async meta(id, runId) { try { return JSON.parse(await readFile(join(this.dir(id, runId), 'meta.json'), 'utf8')); } catch { return null; } }
  async list() {
    let ids = []; try { ids = await readdir(this.staged); } catch {}
    return (await Promise.all(ids.filter(id => ID.test(id)).map(id => this.meta(id)))).filter(Boolean).sort((a, b) => a.at.localeCompare(b.at));
  }
  // Streams the upload to disk with a hard byte cap, then extracts its text once.
  async stage(rawName, stream) {
    const name = cleanName(rawName); assertAccepted(name);
    if ((await this.list()).length >= MAX_STAGED) throw new Error('Too many documents are waiting. Remove some first.');
    const id = randomUUID(), dir = this.dir(id); await mkdir(dir, { recursive: true, mode: 0o700 });
    try {
      const hash = createHash('sha256'), out = createWriteStream(join(dir, 'file'), { mode: 0o600 }); let size = 0;
      try {
        for await (const chunk of (stream.iterator ? stream.iterator({ destroyOnReturn: false }) : stream)) {
          size += chunk.length; if (size > MAX_FILE_BYTES) throw new Error(`${name} is larger than ${MAX_FILE_BYTES / 1024 / 1024} MB.`);
          hash.update(chunk); if (!out.write(chunk)) await new Promise(resolve => out.once('drain', resolve));
        }
      } finally { await new Promise(resolve => out.end(resolve)); }
      if (!size) throw new Error(`${name} is empty.`);
      const { text, warning } = await extractText(await readFile(join(dir, 'file')), name, { run: this.run });
      await writeFile(join(dir, 'text.txt'), text, { mode: 0o600 });
      const meta = { id, name, size, sha256: hash.digest('hex'), chars: text.length, warning, at: new Date().toISOString() };
      await writeFile(join(dir, 'meta.json'), JSON.stringify(meta), { mode: 0o600 });
      return meta;
    } catch (error) { await rm(dir, { recursive: true, force: true }); throw error; }
  }
  async remove(id) { await rm(this.dir(id), { recursive: true, force: true }); }
  // Moves staged documents under the meeting that uses them and returns what the meeting records about them.
  async claim(ids, runId) {
    if (!Array.isArray(ids) || !ids.length) return [];
    const unique = [...new Set(ids.map(String))];
    if (unique.length > MAX_FILES) throw new Error(`Attach at most ${MAX_FILES} documents to a meeting.`);
    const metas = await Promise.all(unique.map(id => this.meta(id)));
    if (metas.some(m => !m)) throw new Error('A document is no longer on the host. Remove it from the list and attach it again.');
    if (metas.reduce((n, m) => n + m.size, 0) > MAX_MEETING_BYTES) throw new Error(`Documents for one meeting can total ${MAX_MEETING_BYTES / 1024 / 1024} MB.`);
    await mkdir(join(this.root, runId), { recursive: true, mode: 0o700 });
    for (const m of metas) await rename(this.dir(m.id), this.dir(m.id, runId));
    return metas.map(({ id, name, size, sha256, chars, warning }) => ({ id, name, size, sha256, chars, warning }));
  }
  async unclaim(runId, metas) { await mkdir(this.staged, { recursive: true }); for (const m of metas) await rename(this.dir(m.id, runId), this.dir(m.id)).catch(() => {}); await rm(join(this.root, runId), { recursive: true, force: true }); }
  // The extracted text of a meeting's documents, for its prompts. Missing text means the documents were already removed.
  async texts(runId, metas) {
    return Promise.all(metas.map(async m => {
      try { return { name: m.name, text: await readFile(join(this.dir(m.id, runId), 'text.txt'), 'utf8') }; }
      catch { throw new Error('The documents for this meeting were removed from the host. Start a new meeting and attach them again.'); }
    }));
  }
  // When a meeting closes: uploaded files always go. The extracted text goes too unless the meeting could still be resumed.
  async release(runId, { keepText = false } = {}) {
    if (!ID.test(runId)) return;
    const dir = join(this.root, runId);
    if (!keepText) return rm(dir, { recursive: true, force: true });
    let ids = []; try { ids = await readdir(dir); } catch {}
    await Promise.all(ids.map(id => rm(join(dir, id, 'file'), { force: true })));
  }
  // At startup: staged uploads older than a day, and folders of meetings that no longer exist or have finished.
  async sweep(keepRunIds = []) {
    let names = []; try { names = await readdir(this.root); } catch { return; }
    for (const name of names) if (name !== 'staged' && !keepRunIds.includes(name)) await rm(join(this.root, name), { recursive: true, force: true });
    for (const meta of await this.list()) if (Date.now() - Date.parse(meta.at) > STAGED_TTL_MS) await this.remove(meta.id);
    let staged = []; try { staged = await readdir(this.staged); } catch {}
    for (const id of staged) if (!existsSync(join(this.staged, id, 'meta.json')) && Date.now() - (await stat(join(this.staged, id))).mtimeMs > 60_000) await rm(join(this.staged, id), { recursive: true, force: true });
  }
}
