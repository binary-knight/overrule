#!/usr/bin/env node
// Print the running server's LAN pairing code and the addresses other devices can reach it at, for an owner working over
// SSH who cannot open the LAN access dialog on the host's screen. The code is read from the server itself over localhost, which
// is the only route the server answers it on; when the server is not running, the last saved code is shown with a warning,
// because a start generates a new one.
//
//   node scripts/pairing-code.mjs            the code and the addresses, grouped
//   node scripts/pairing-code.mjs --rotate   a new code; every paired device is signed out
//   node scripts/pairing-code.mjs --json     one JSON object
//
// PORT and OVERRULE_DATA_DIR mean what they mean for the server.

import { readFile } from 'node:fs/promises';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

// Tailscale hands out 100.64.0.0/10; Docker and other virtual bridges are named for what they are.
export function kindOf(address, interfaces = networkInterfaces()) {
  const [a, b] = address.split('.').map(Number);
  if (a === 100 && b >= 64 && b <= 127) return 'tailscale';
  const name = Object.entries(interfaces).find(([, list]) => (list || []).some(x => x.address === address))?.[0] || '';
  if (/^(docker|br-|veth|virbr|lxc|lxd|cni|flannel|tun|tap)/.test(name)) return 'virtual';
  return 'lan';
}

export function describe({ pairingCode, urls, rotatedAt }, { live, interfaces } = {}) {
  const groups = { tailscale: [], lan: [], virtual: [] };
  for (const url of urls) groups[kindOf(new URL(url).hostname, interfaces)].push(url);
  return { pairingCode, rotatedAt, live, ...groups };
}

export function render(info) {
  const lines = [];
  if (!info.live) lines.push('The server is not running. This is the code it saved last; starting it makes a new one, so start it first, then run this again.', '');
  lines.push(`Pairing code: ${info.pairingCode}`, `Set ${info.rotatedAt}`, '');
  if (info.tailscale.length) lines.push('Over Tailscale, from any device on your tailnet:', ...info.tailscale.map(u => `  ${u}`));
  if (info.lan.length) lines.push('On this network:', ...info.lan.map(u => `  ${u}`));
  if (info.virtual.length) lines.push('Virtual bridges on this machine, not reachable from other devices:', ...info.virtual.map(u => `  ${u}`));
  const first = info.tailscale[0] || info.lan[0];
  if (first) lines.push('', 'From another machine, the command line pairs with:', `  node bin/overrule.mjs list --url ${first} --code ${info.pairingCode}`);
  return lines.join('\n');
}

async function fromServer(port, rotate) {
  const base = `http://127.0.0.1:${port}`;
  let response;
  try { response = await fetch(`${base}/api/access`); } catch { return null; }
  if (!response.ok) throw new Error(`The server answered ${response.status} to /api/access: ${(await response.json().catch(() => ({}))).error || 'no detail'}.`);
  if (!rotate) return response.json();
  const bootstrap = await (await fetch(`${base}/api/bootstrap`)).json();
  const rotated = await fetch(`${base}/api/access/rotate`, { method: 'POST', headers: { 'x-mesh-token': bootstrap.token, 'Content-Type': 'application/json' }, body: '{}' });
  if (!rotated.ok) throw new Error(`Rotation was refused: ${(await rotated.json().catch(() => ({}))).error || rotated.status}.`);
  return rotated.json();
}

async function fromFile(directory, port) {
  const saved = JSON.parse(await readFile(join(directory, 'lan.json'), 'utf8'));
  const addresses = [...new Set(Object.values(networkInterfaces()).flat().filter(a => a && a.family === 'IPv4' && !a.internal).map(a => a.address))];
  return { ...saved, urls: addresses.map(a => `http://${a}:${port}`) };
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const rotate = argv.includes('--rotate'), asJson = argv.includes('--json');
  const unknown = argv.find(a => !['--rotate', '--json'].includes(a));
  if (unknown) throw new Error(`Unknown option ${unknown}. This script takes --rotate and --json.`);
  const port = Number(env.PORT || 4310), directory = env.OVERRULE_DATA_DIR || env.MESH_DATA_DIR || join(root, 'data');
  const live = await fromServer(port, rotate);
  if (!live && rotate) throw new Error(`No server is listening on port ${port}, so there is no code to rotate. Start it with ./restart.sh first.`);
  const info = describe(live || await fromFile(directory, port), { live: Boolean(live) });
  return asJson ? JSON.stringify(info, null, 2) : render(info);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(text => console.log(text)).catch(error => { console.error(error.message); process.exitCode = 1; });
}
