import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server.mjs';
import { describe, kindOf, main, render } from '../scripts/pairing-code.mjs';

const interfaces = { wlp0: [{ address: '192.168.1.20', family: 'IPv4', internal: false }], docker0: [{ address: '172.17.0.1', family: 'IPv4', internal: false }], tailscale0: [{ address: '100.92.150.116', family: 'IPv4', internal: false }] };

test('addresses are grouped by how another device can reach them', () => {
  assert.equal(kindOf('100.92.150.116', interfaces), 'tailscale');
  assert.equal(kindOf('100.200.0.1', interfaces), 'lan', 'only 100.64/10 is Tailscale');
  assert.equal(kindOf('172.17.0.1', interfaces), 'virtual');
  assert.equal(kindOf('192.168.1.20', interfaces), 'lan');
  const info = describe({ pairingCode: 'abc', rotatedAt: 't', urls: ['http://192.168.1.20:4310', 'http://172.17.0.1:4310', 'http://100.92.150.116:4310'] }, { live: true, interfaces });
  assert.deepEqual(info.tailscale, ['http://100.92.150.116:4310']);
  assert.deepEqual(info.lan, ['http://192.168.1.20:4310']);
  assert.deepEqual(info.virtual, ['http://172.17.0.1:4310']);
  const text = render(info);
  assert.match(text, /Pairing code: abc/);
  assert.match(text, /--url http:\/\/100\.92\.150\.116:4310 --code abc/, 'the command line pairs over Tailscale first');
  assert.doesNotMatch(text, /not running/);
});

test('the script reads the live code over localhost, rotates it, and falls back to the saved file', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'overrule-pair-'));
  const { server, access } = createApp({ directory, addresses: ['192.168.1.20'], detect: async () => ({}) });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const env = { PORT: String(server.address().port), OVERRULE_DATA_DIR: directory };
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await rm(directory, { recursive: true, force: true }); });

  const shown = JSON.parse(await main(['--json'], env));
  assert.equal(shown.pairingCode, access.code);
  assert.equal(shown.live, true);
  assert.deepEqual(shown.lan, [`http://192.168.1.20:${env.PORT}`]);

  const before = access.code;
  const rotated = JSON.parse(await main(['--rotate', '--json'], env));
  assert.notEqual(rotated.pairingCode, before);
  assert.equal(rotated.pairingCode, access.code, 'the server now holds the new code');
  assert.equal(JSON.parse(await readFile(join(directory, 'lan.json'), 'utf8')).pairingCode, access.code);

  await new Promise(resolve => server.close(resolve));
  const saved = JSON.parse(await main(['--json'], env));
  assert.equal(saved.live, false);
  assert.equal(saved.pairingCode, access.code, 'the saved file is the last code');
  assert.match(render(saved), /not running/);
  await assert.rejects(main(['--rotate'], env), /no code to rotate/);
  await assert.rejects(main(['--bogus'], env), /Unknown option/);
});
