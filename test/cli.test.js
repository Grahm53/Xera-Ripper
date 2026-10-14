import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveCommand, shouldOpenBrowser, COMMANDS } from '../src/cli.js';
import { browserCommand, openBrowser } from '../src/openBrowser.js';
import { readAsset, isSea } from '../src/assets.js';
import { BUNDLED_ASSETS, STATIC } from '../src/server.js';
import { makeProjectGame } from './helpers/projectFixture.js';

const BIN = fileURLToPath(new URL('../bin/xera-ripper.js', import.meta.url));

test('command resolution: verbs, double-click, and files dropped onto the program', () => {
  const exists = (p) => p === '/games/MyGame.apk' || p === 'C:\\Games\\Data';
  assert.deepEqual(resolveCommand([], { isSea: false }), { cmd: undefined }, 'plain Node with no args shows help');
  assert.deepEqual(resolveCommand([], { isSea: true }), { cmd: 'serve', target: undefined, autoOpen: true }, 'double-clicked exe starts the UI');
  assert.deepEqual(resolveCommand(['project', 'x.apk'], { isSea: true }), { cmd: 'project', target: 'x.apk' });
  for (const verb of COMMANDS) assert.equal(resolveCommand([verb], { exists }).cmd, verb);
  assert.deepEqual(resolveCommand(['/games/MyGame.apk'], { isSea: true, exists }), { cmd: 'serve', target: '/games/MyGame.apk', autoOpen: true, dropped: true, extra: [] });
  assert.equal(resolveCommand(['C:\\Games\\Data', '/games/MyGame.apk'], { exists }).extra.length, 1, 'several dropped items: first is loaded, the rest is reported');
  assert.deepEqual(resolveCommand(['nonsense'], { exists }), { cmd: 'nonsense', unknown: true });
});

test('browser auto-open rules', () => {
  assert.equal(shouldOpenBrowser({}), false);
  assert.equal(shouldOpenBrowser({ autoOpen: true }), true);
  assert.equal(shouldOpenBrowser({ open: true }), true);
  assert.equal(shouldOpenBrowser({ autoOpen: true, noOpen: true }), false, '--no-open always wins');
  assert.equal(shouldOpenBrowser({ open: true, noOpen: true }), false);
});

test('opening the browser: per-platform commands, never throws', () => {
  const url = 'http://127.0.0.1:8765/?t=abc_DEF-123';
  assert.deepEqual(browserCommand(url, 'win32'), { cmd: 'cmd', args: ['/c', 'start', '""', `"${url}"`], options: { windowsVerbatimArguments: true } });
  assert.deepEqual(browserCommand(url, 'darwin'), { cmd: 'open', args: [url], options: {} });
  assert.deepEqual(browserCommand(url, 'linux'), { cmd: 'xdg-open', args: [url], options: {} });
  const calls = [];
  const fake = (cmd, args, opts) => { calls.push({ cmd, args, opts }); return { on() {}, unref() {} }; };
  assert.equal(openBrowser(url, { platform: 'win32', spawnFn: fake }), true);
  assert.equal(calls[0].cmd, 'cmd');
  assert.equal(calls[0].opts.windowsVerbatimArguments, true);
  assert.equal(calls[0].opts.detached, true);
  assert.equal(calls[0].opts.stdio, 'ignore');
  assert.equal(openBrowser(url, { spawnFn: () => { throw new Error('no browser'); } }), false);
});

test('bundled assets: everything the single-file build must embed exists and is readable', () => {
  assert.equal(isSea, false, 'unit tests run as plain Node');
  assert.ok(BUNDLED_ASSETS.includes('data/lzma.tpk') && BUNDLED_ASSETS.includes('ui/index.html'));
  assert.equal(new Set(BUNDLED_ASSETS).size, BUNDLED_ASSETS.length, 'no duplicates');
  for (const key of BUNDLED_ASSETS) assert.ok(readAsset(key).length > 100, `${key} must exist`);
  for (const [url, { key }] of Object.entries(STATIC)) assert.ok(BUNDLED_ASSETS.includes(key), `${url} -> ${key} is embedded`);
  assert.throws(() => readAsset('ui/does-not-exist.js'));
  assert.ok(readAsset('data/lzma.tpk').subarray(0, 4).equals(Buffer.from('TPK*')), 'type-tree database header');
});

test('the CLI: --version and --help work, errors are one line with exit code 1', () => {
  const v = spawnSync(process.execPath, [BIN, '--version'], { encoding: 'utf8' });
  assert.equal(v.status, 0);
  assert.match(v.stdout, /^xera-ripper \d+\.\d+\.\d+/);
  const h = spawnSync(process.execPath, [BIN, '--help'], { encoding: 'utf8' });
  assert.equal(h.status, 0);
  assert.match(h.stdout, /drag a game file onto the \.exe/);
  const bad = spawnSync(process.execPath, [BIN, 'list', '/definitely/not/here'], { encoding: 'utf8' });
  assert.equal(bad.status, 1);
  assert.equal(bad.stderr.trim(), 'xera-ripper: no such file or folder: /definitely/not/here');
  assert.ok(!bad.stderr.includes('    at '), 'no stack trace for expected errors');
});

test('dropping a game folder on the program starts the UI with it loaded (end to end)', async () => {
  const game = makeProjectGame();
  const child = spawn(process.execPath, [BIN, game, '--no-open', '--port', '0'], { stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    let out = '';
    const url = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no URL printed:\n${out}`)), 15000);
      child.stdout.on('data', (d) => {
        out += d;
        const m = /(http:\/\/127\.0\.0\.1:\d+\/\?t=[\w-]+)/.exec(out);
        if (m) { clearTimeout(timer); resolve(m[1]); }
      });
      child.on('exit', (c) => reject(new Error(`exited ${c}:\n${out}`)));
    });
    await new Promise((r) => setTimeout(r, 100));
    assert.match(out, new RegExp(`Loaded: ${game.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    const u = new URL(url);
    const state = await (await fetch(`${u.origin}/api/state`, { headers: { 'X-Xera-Token': u.searchParams.get('t') } })).json();
    assert.equal(state.loaded, true);
    assert.equal(state.summary.assetCount, 15);
    assert.equal((await fetch(url)).status, 200, 'the UI page itself is served');
  } finally {
    child.kill();
  }
});
