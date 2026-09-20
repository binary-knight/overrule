// Cloning a repository the council will read. The clone is ordinary untrusted source, so it lands outside the app in its own
// folder, is fetched over HTTPS only, never runs a hook or a submodule, and never asks for a password: a private URL without
// host credentials fails quickly instead of hanging on a prompt.
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { runProcess, childEnv } from './providers.mjs';

const CLONE_TIMEOUT_MS = 10 * 60 * 1000;
const NAME = /^[A-Za-z0-9._-]+$/;
export const repoRoot = (env = process.env) => env.OVERRULE_REPO_DIR || join(homedir(), 'overrule-repos');

// Only an https URL to a named host: ssh and local paths would use the account's keys or reach past the workspace path rules.
export function validateRepoUrl(input) {
  const text = String(input || '').trim();
  if (!text) throw new Error('Enter a repository URL, for example https://github.com/owner/project.');
  const shorthand = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(text);
  let url;
  try { url = new URL(shorthand ? `https://github.com/${text}` : text); } catch { throw new Error('That is not a URL. Use the https address of the repository.'); }
  if (url.protocol !== 'https:') throw new Error('Only https repository URLs are accepted. An ssh or local path would use this machine’s keys or reach outside the clone folder.');
  if (url.username || url.password) throw new Error('Do not put credentials in the URL. Sign git in on the host instead.');
  const host = url.hostname.toLowerCase();
  if (!host.includes('.') || host === 'localhost' || /^\d+\.\d+\.\d+\.\d+$/.test(host) || host.endsWith('.local') || host.endsWith('.internal')) throw new Error('Use a public repository host, such as github.com or gitlab.com.');
  const parts = url.pathname.replace(/\.git$/i, '').split('/').filter(Boolean);
  if (parts.length < 2 || !parts.every(part => NAME.test(part) && part !== '.' && part !== '..')) throw new Error('The URL must name an owner and a repository, for example https://github.com/owner/project.');
  const owner = parts.slice(0, -1).join('-'), name = parts.at(-1);
  return { url: `https://${host}${url.port ? ':' + url.port : ''}/${parts.join('/')}.git`, host, owner, name, folder: `${owner}-${name}`.slice(0, 80) };
}

// git, with no hooks, no prompting, and nothing of the server's environment beyond what every child process gets.
async function git(args, { cwd, run = runProcess, signal } = {}) {
  const result = await run('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
    cwd, capture: true, signal: signal || AbortSignal.timeout(CLONE_TIMEOUT_MS),
    env: { ...childEnv(), GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '/bin/true', GIT_CONFIG_NOSYSTEM: '1' },
  });
  if (result.code !== 0) {
    const detail = (result.stderr || result.stdout || '').trim().split('\n').filter(Boolean).at(-1) || 'no output';
    if (/Authentication failed|could not read Username|terminal prompts disabled|not found/i.test(detail)) throw new Error(`The repository could not be read. If it is private, sign git in on the host (for example "gh auth setup-git"). git said: ${detail.slice(0, 200)}`);
    throw new Error(`git ${args[0]} failed: ${detail.slice(0, 300)}`);
  }
  return result.stdout.trim();
}

// Clone at its default branch, shallow: the council reads the current state of the code, not its history.
export async function cloneRepo(input, { dir = repoRoot(), run = runProcess, signal } = {}) {
  const repo = validateRepoUrl(input);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, repo.folder);
  let updated = false;
  if (existsSync(path)) {
    const origin = await git(['remote', 'get-url', 'origin'], { cwd: path, run, signal }).catch(() => '');
    if (origin.replace(/\.git$/, '') !== repo.url.replace(/\.git$/, '')) throw new Error(`${path} already exists and points at ${origin || 'no remote'}. Remove it or clone under a different name.`);
    await git(['fetch', '--depth', '1', '--no-tags', 'origin', 'HEAD'], { cwd: path, run, signal });
    await git(['reset', '--hard', 'FETCH_HEAD'], { cwd: path, run, signal });
    await git(['clean', '-fdq'], { cwd: path, run, signal });
    updated = true;
  } else {
    await git(['clone', '--depth', '1', '--no-recurse-submodules', '--no-tags', '--quiet', repo.url, path], { run, signal });
  }
  const head = await git(['rev-parse', 'HEAD'], { cwd: path, run, signal });
  const branch = await git(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: path, run, signal }).catch(() => 'HEAD');
  return { path, url: repo.url, host: repo.host, name: repo.name, owner: repo.owner, head, branch, updated, shallow: true };
}
