import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, statSync, truncateSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Session, NothingLoadedError } from '../src/session.js';
import { DirSource, FileSource, ZipSource, DiskFile } from '../src/sources.js';
import { safeSegment } from '../src/names.js';
import { yamlString } from '../src/unityYaml.js';
import { sceneTree } from '../src/views.js';
import { browse, createApp } from '../src/server.js';
import { buildZip } from './helpers/zipbuilder.js';
import { buildSerializedFile, textAssetData, TEXTASSET_TREE } from './helpers/builders.js';
import { makeProjectGame } from './helpers/projectFixture.js';

const BIN = fileURLToPath(new URL('../bin/xera-ripper.js', import.meta.url));
const tmp = () => mkdtempSync(join(tmpdir(), 'xera-rob-'));

// ---- a failed Open must not destroy what is loaded ------------------------------------------------------------------------
test('a failed or empty load changes nothing: the previously loaded game stays loaded', () => {
  const s = new Session();
  s.load(makeProjectGame());
  const before = { files: s.files.length, assets: s.assets.length, input: s.inputPath };
  assert.ok(before.assets > 0);

  const empty = tmp();
  assert.throws(() => s.load(empty), NothingLoadedError);
  assert.equal(s.assets.length, before.assets, 'empty folder: assets still there');
  assert.equal(s.inputPath, before.input);

  const bad = join(tmp(), 'corrupt.apk');
  writeFileSync(bad, Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(200, 7)]));
  assert.throws(() => s.load(bad), /not a zip archive/);
  assert.throws(() => s.load(join(tmp(), 'missing')), (e) => e.code === 'ENOENT');
  assert.equal(s.files.length, before.files, 'corrupt archive / missing path: files still there');
  assert.equal(s.loaded, true);
  assert.doesNotThrow(() => s.detail(0), 'assets are still addressable');
});

test('the empty-load error says why: unopenable Unity-looking files are listed with their reasons', () => {
  const dir = tmp();
  // a plausible serialized-file header (version 9 is recognised but unsupported) so the file is a candidate that then fails
  const hdr = Buffer.alloc(64);
  hdr.writeUInt32BE(100, 4); hdr.writeUInt32BE(64, 8); hdr.writeUInt32BE(9, 12); hdr.writeUInt32BE(40, 16);
  writeFileSync(join(dir, 'level9'), hdr);
  const s = new Session();
  try { s.load(dir); assert.fail('should have thrown'); } catch (e) {
    assert.ok(e instanceof NothingLoadedError);
    assert.match(e.message, /No Unity files were found/);
    assert.ok(Array.isArray(e.skipped));
  }
  const empty = tmp();
  assert.throws(() => new Session().load(empty), /Pick a UnityFS bundle/);
});

test('API: a failed /api/load answers 400 with the reason and leaves the loaded game usable', async () => {
  const app = createApp({});
  const { url } = await app.start({ port: 0 });
  const u = new URL(url);
  const H = { 'X-Xera-Token': u.searchParams.get('t'), 'content-type': 'application/json' };
  const post = (p, b) => fetch(u.origin + p, { method: 'POST', headers: H, body: JSON.stringify(b) });
  try {
    assert.equal((await post('/api/load', { path: makeProjectGame() })).status, 200);
    const r = await post('/api/load', { path: tmp() });
    assert.equal(r.status, 400);
    assert.match((await r.json()).error, /No Unity files were found/);
    const st = await (await fetch(`${u.origin}/api/state`, { headers: H })).json();
    assert.equal(st.loaded, true, 'server still has the game');
    assert.ok(st.summary.assetCount > 0);
    assert.equal((await fetch(`${u.origin}/api/asset/0`, { headers: H })).status, 200);
    // quoted + spaced path (Explorer "Copy as path") still loads
    assert.equal((await post('/api/load', { path: `  "${makeProjectGame()}"  ` })).status, 200);
  } finally { await app.stop(); }
});

test('API: deliberate failures show their real message, not "internal error"', async () => {
  const app = createApp({});
  const { url } = await app.start({ port: 0 });
  const u = new URL(url);
  const H = { 'X-Xera-Token': u.searchParams.get('t'), 'content-type': 'application/json' };
  try {
    await fetch(`${u.origin}/api/load`, { method: 'POST', headers: H, body: JSON.stringify({ path: makeProjectGame() }) });
    const blocker = join(tmp(), 'iamafile');
    writeFileSync(blocker, 'x');
    const r = await fetch(`${u.origin}/api/project`, { method: 'POST', headers: H, body: JSON.stringify({ outDir: join(blocker, 'sub'), name: 'P' }) });
    assert.equal(r.status, 500);
    const msg = (await r.json()).error;
    assert.match(msg, /export failed/);
    assert.notEqual(msg, 'internal error');
  } finally { await app.stop(); }
});

test('API: a startup notice (e.g. the dropped folder could not be opened) reaches the page via /api/state', async () => {
  const app = createApp({});
  app.setNotice('Could not open C:\\x: nothing Unity in there');
  const { url } = await app.start({ port: 0 });
  const u = new URL(url);
  try {
    const st = await (await fetch(`${u.origin}/api/state`, { headers: { 'X-Xera-Token': u.searchParams.get('t') } })).json();
    assert.match(st.notice, /Could not open/);
  } finally { await app.stop(); }
});

test('CLI: opening an empty folder is a one-line error that says what to pick', () => {
  const r = spawnSync(process.execPath, [BIN, 'list', tmp()], { encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /No Unity files were found/);
  assert.ok(!/\n\s+at /.test(r.stderr), 'no stack trace');
});

// ---- one locked folder must not stop the rest of the game from opening --------------------------------------------------
test('a folder that cannot be read is reported and skipped; the rest of the game still opens', () => {
  const root = makeProjectGame();
  const real = { readdirSync, lstatSync: (p) => statSync(p, { throwIfNoEntry: true }) };
  const locked = join(root, 'Game_Data', 'Locked');
  mkdirSync(locked);
  const io = {
    readdirSync: (d) => { if (d === locked) throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }); return real.readdirSync(d); },
    lstatSync: (p) => (p.includes('Locked') && p !== locked ? (() => { throw Object.assign(new Error('EPERM'), { code: 'EPERM' }); })() : real.lstatSync(p)),
  };
  const src = new DirSource(root, io);
  const list = src.list();
  assert.ok(list.some((e) => e.name.endsWith('level1')), 'other files are still listed');
  assert.equal(src.problems.length, 1);
  assert.match(src.problems[0].name, /Locked/);
  assert.match(src.problems[0].reason, /EACCES/);
});

// ---- streamed resources are read by range, not whole ------------------------------------------------------------------------
test('streamed .resS files stay on disk: only the requested bytes are read', () => {
  const dir = tmp();
  const big = Buffer.alloc(3 * 1024 * 1024, 1);
  Buffer.from('HELLO-RESOURCE').copy(big, 1_000_000);
  writeFileSync(join(dir, 'level0.resS'), big);
  const src = new DirSource(dir);
  const res = src.find('archive:/CAB-x/level0.resS');
  assert.ok(res instanceof DiskFile, 'a disk-backed handle, not a 3 MB Buffer');
  assert.equal(res.length, big.length);
  assert.equal(res.subarray(1_000_000, 1_000_014).toString(), 'HELLO-RESOURCE');
  assert.equal(res.subarray(big.length - 2).length, 2);
  assert.equal(res.subarray(big.length + 10, big.length + 20).length, 0, 'past the end is empty, not an exception');
});

test('a lone file finds its sibling .resS by looking in its own folder only (case-insensitive), not by walking the parent', () => {
  const dir = tmp();
  mkdirSync(join(dir, 'sub'));
  writeFileSync(join(dir, 'LEVEL0'), 'x');
  writeFileSync(join(dir, 'Level0.RESS'), Buffer.from('abcdef'));
  writeFileSync(join(dir, 'sub', 'other.resS'), 'zzz');
  const src = new FileSource(join(dir, 'LEVEL0'));
  const res = src.find('archive:/CAB-1/level0.resS');
  assert.ok(res, 'found despite different case');
  assert.equal(res.subarray(0, 3).toString(), 'abc');
  assert.equal(src.find('other.resS'), null, 'a file in a subfolder is not a sibling');
  assert.equal(src.find('nothing.resS'), null);
});

test('a zip/apk resource is inflated once and reused, not once per asset', () => {
  const dir = tmp();
  const apk = join(dir, 'g.apk');
  const payload = Buffer.from('X'.repeat(5000));
  writeFileSync(apk, buildZip([{ name: 'assets/bin/Data/a.resS', data: payload, deflate: true }]));
  const src = new ZipSource(apk);
  try {
    const a = src.find('a.resS');
    const b = src.find('a.resS');
    assert.equal(a, b, 'same Buffer object: cached');
    assert.equal(a.length, 5000);
  } finally { src.close(); }
});

test('zip entries stored with backslash separators (PowerShell Compress-Archive) are normalised', () => {
  const dir = tmp();
  const apk = join(dir, 'w.apk');
  writeFileSync(apk, buildZip([{ name: 'Game_Data\\sub\\level0.resS', data: 'abc', deflate: false }]));
  const src = new ZipSource(apk);
  try {
    assert.deepEqual(src.list().map((e) => e.name), ['Game_Data/sub/level0.resS']);
    assert.equal(src.find('level0.resS').length, 3);
  } finally { src.close(); }
});

test('a serialized file larger than 2 GiB is skipped with a clear reason instead of failing mid-read', () => {
  // A sparse file costs no disk space: valid-looking header, then a hole up to just over 2 GiB.
  const dir = tmp();
  const f = join(dir, 'huge.assets');
  const size = 2 ** 31 + 4096;
  const hdr = Buffer.alloc(64);
  hdr.writeUInt32BE(100, 0); hdr.writeUInt32BE(size, 4); hdr.writeUInt32BE(17, 8); hdr.writeUInt32BE(4096, 12); // metadataSize, fileSize, version, dataOffset
  writeFileSync(f, hdr);
  truncateSync(f, size);
  assert.equal(statSync(f).size, size);
  const s = new Session();
  try { s.load(dir); assert.fail('nothing else is in there, so the load must fail'); } catch (e) {
    assert.ok(e instanceof NothingLoadedError, e.message);
    assert.equal(e.skipped.length, 1, JSON.stringify(e.skipped));
    assert.match(e.skipped[0].reason, /larger than 2 GiB/);
    assert.match(e.message, /larger than 2 GiB/, 'and the user-facing message carries it');
  }
});

// ---- names ----------------------------------------------------------------------------------------------------------------
test('file names keep letters of every language and avoid Windows device names', () => {
  assert.equal(safeSegment('ゲーム_背景'), 'ゲーム_背景');
  assert.equal(safeSegment('Café Ünïcode'), 'Café Ünïcode');
  assert.notEqual(safeSegment('日本語'), safeSegment('中文字'), 'different non-ASCII names no longer collapse into the same string');
  assert.equal(safeSegment('CON'), '_CON');
  assert.equal(safeSegment('nul.txt'), '_nul.txt');
  assert.equal(safeSegment('COM1'), '_COM1');
  assert.equal(safeSegment('lpt9.png'), '_lpt9.png');
  assert.equal(safeSegment('console'), 'console', 'only the exact device names');
  assert.equal(safeSegment('name. . '), 'name');
  assert.equal(safeSegment('a/b\\c:d*e?f"g<h>i|j'), 'a_b_c_d_e_f_g_h_i_j');
  assert.equal(safeSegment('..'), '_');
  const long = safeSegment('😀'.repeat(300));
  assert.ok(Array.from(long).length <= 100);
  assert.ok(!/[\ud800-\udbff](?![\udc00-\udfff])/.test(long), 'never cuts a surrogate pair in half');
});

test('assets with non-English names export under those names (and do not collide)', () => {
  const dir = tmp();
  mkdirSync(join(dir, 'Game_Data'));
  const types = [{ classId: 49, tree: TEXTASSET_TREE }];
  writeFileSync(join(dir, 'Game_Data', 'level0'), buildSerializedFile({
    version: 19, types,
    objects: [
      { pathId: 1, typeIndex: 0, data: textAssetData('ゲーム背景', 'one') },
      { pathId: 2, typeIndex: 0, data: textAssetData('中文字', 'two') },
      { pathId: 3, typeIndex: 0, data: textAssetData('Café', 'three') },
    ],
  }));
  const s = new Session();
  s.load(dir);
  const out = tmp();
  const r = s.export({ outDir: out, types: ['TextAsset'], ids: null, json: false });
  assert.equal(r.written, 3);
  const files = readdirSync(out, { recursive: true }).map(String);
  for (const name of ['ゲーム背景', '中文字', 'Café']) assert.ok(files.some((f) => f.includes(name)), `${name} kept in ${files.join(', ')}`);
});

// ---- hardening ------------------------------------------------------------------------------------------------------------
test('yamlString does not backtrack on a long digit string followed by a letter', () => {
  const t0 = performance.now();
  assert.equal(yamlString(`${'1'.repeat(300_000)}x`).startsWith('1'), true);
  assert.ok(performance.now() - t0 < 1000, `took ${Math.round(performance.now() - t0)} ms`);
  // and it still quotes everything YAML would read as a number
  for (const v of ['1', '1.5', '1e5', '-3', '.5', '1_000', '0x1F', '+.inf', '1.']) assert.match(yamlString(v), /^'/, v);
  for (const v of ['abc', '12abc', '1.2.3', 'v1.0']) assert.doesNotMatch(yamlString(v), /^'/, v);
});

test('scene tree: an unexpectedly-shaped Transform/GameObject is skipped, not a failure of the whole tree', () => {
  const objs = [
    { id: 0, fileIndex: 0, pathId: 1n, className: 'GameObject', name: 'A', obj: { classId: 1, pathId: 1n } },
    { id: 1, fileIndex: 0, pathId: 2n, className: 'Transform', name: '', obj: { classId: 4, pathId: 2n } },
  ];
  const values = {
    1: { m_Name: 'A', m_IsActive: true, m_Component: { not: 'an array' } },
    2: { m_GameObject: { m_FileID: 0, m_PathID: 1n }, m_Father: 'garbage', m_Children: 42 },
  };
  const session = { files: [{ name: 'f', sf: { unityVersion: '2019.4.31f1', readObject: (o) => values[Number(o.pathId)] } }], assets: objs };
  const t = sceneTree(session, 0);
  assert.equal(t.total, 1);
  assert.equal(t.roots[0].name, 'A');
});

test('file dialog: links to folders and files are listed (the link target decides), dangling links are not', () => {
  const dirent = (name, kind) => ({ name, isDirectory: () => kind === 'dir', isFile: () => kind === 'file', isSymbolicLink: () => kind === 'link-dir' || kind === 'link-file' || kind === 'link-broken' });
  const targets = { '/g/LinkedDir': { isDirectory: () => true, isFile: () => false, size: 0 }, '/g/linked.assets': { isDirectory: () => false, isFile: () => true, size: 77 } };
  const r = browse('/g', {
    platform: 'linux', pathMod: path.posix, home: () => '/home/u', exists: () => true,
    stat: (p) => { if (p === '/g') return { isFile: () => false, isDirectory: () => true, size: 0 }; if (targets[p]) return targets[p]; if (p.endsWith('.png')) return { isFile: () => true, isDirectory: () => false, size: 5 }; throw new Error('ENOENT'); },
    readdir: () => [dirent('LinkedDir', 'link-dir'), dirent('linked.assets', 'link-file'), dirent('dangling', 'link-broken'), dirent('real.png', 'file')],
  });
  const byName = Object.fromEntries(r.entries.map((e) => [e.name, e]));
  assert.equal(byName.LinkedDir.type, 'dir');
  assert.equal(byName['linked.assets'].type, 'file');
  assert.equal(byName['linked.assets'].size, 77);
  assert.ok(!byName.dangling, 'dangling link skipped');
  assert.ok(byName['real.png']);
});
