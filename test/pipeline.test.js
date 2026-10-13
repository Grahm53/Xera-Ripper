import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, readdirSync, statSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { execFileSync } from 'node:child_process';
import { Session, safeSegment } from '../src/session.js';
import { ZipArchive } from '../src/zip.js';
import { decodePng } from './helpers/pngdecode.js';
import { buildZip } from './helpers/zipbuilder.js';
import { makeGameDir, OGG } from './helpers/fixture.js';

const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));

test('session: scans a game folder, resolves streamed resources, survives junk and corrupt bundles', () => {
  const root = makeGameDir();
  const s = new Session();
  const sum = s.load(root);
  assert.deepEqual(sum.files.map((f) => f.name).sort(), [
    'Game_Data/level0', 'Game_Data/scene.unity3d/CAB-abc', 'Game_Data/sharedassets0.assets',
  ]);
  assert.equal(sum.assetCount, 5 + 2 + 1);
  assert.equal(sum.counts.Texture2D, 5);
  assert.equal(sum.files.find((f) => f.name.endsWith('sharedassets0.assets')).hasTypeTree, false);
  assert.equal(sum.files[0].platform, 'Android');
  assert.ok(sum.skipped.some((x) => x.name.endsWith('corrupt.bundle')), 'corrupt bundle is reported, not fatal');
  assert.ok(!sum.skipped.some((x) => x.name.endsWith('.so') || x.name.endsWith('.txt')), 'junk files are ignored silently');
});

test('session: list filters by type/name and pages', () => {
  const s = new Session();
  s.load(makeGameDir());
  assert.equal(s.list({ type: 'TextAsset' }).total, 2);
  assert.deepEqual(s.list({ q: 'hero' }).rows.map((r) => r.name), ['Hero']);
  assert.equal(s.list({ limit: 3 }).rows.length, 3);
  assert.equal(s.list({ offset: 6, limit: 10 }).rows.length, 2);
  assert.equal(s.list({ q: '-' }).total >= 0, true);
});

test('session: previews decode textures, text and audio; JSON for the rest', () => {
  const s = new Session();
  s.load(makeGameDir());
  const id = (name) => s.assets.find((a) => a.name === name).id;
  const hero = s.preview(id('Hero'));
  assert.equal(hero.mime, 'image/png');
  const png = decodePng(hero.data);
  assert.deepEqual([png.width, png.height], [2, 2]);
  assert.deepEqual([...png.rgba.subarray(0, 4)], [0, 0, 255, 255]); // flipped: top-left is the 2nd stored row
  assert.equal(s.preview(id('Boom')).mime, 'audio/ogg');
  assert.match(s.preview(id('../../evil')).data.toString(), /owned\? no/);
  assert.throws(() => s.preview(id('AstcTex')), /ASTC_6x6/);
  const hidden = s.assets.find((a) => a.pathId === 20); // stripped file => no type tree => no name either
  assert.equal(hidden.name, '');
  assert.throws(() => s.preview(hidden.id), /no type tree/);
  const detail = s.detail(id('Hero'));
  assert.equal(detail.data.m_Width, 2);
  assert.deepEqual(detail.data['image data'], { $bytes: 16 });
});

test('session: export writes PNG/txt/ogg/raw, reports failures, and never escapes the output folder', () => {
  const root = makeGameDir();
  const out = mkdtempSync(join(tmpdir(), 'xera-out-'));
  const s = new Session();
  s.load(root);
  const r = s.export({ outDir: out, json: true });
  const rels = walk(out).map((f) => relative(out, f)).sort();

  for (const f of walk(out)) assert.ok(!relative(out, f).startsWith('..'), `${f} escaped`);
  assert.ok(rels.some((f) => f.endsWith('Texture2D/Hero_1.png')));
  assert.ok(rels.some((f) => f.endsWith('Texture2D/Streamed_2.png')), 'streamed from bundle resS');
  assert.ok(rels.some((f) => f.endsWith('Texture2D/LooseDxt_10.png')), 'streamed from sibling level0.resS');
  assert.ok(rels.some((f) => f.endsWith('Texture2D/AstcTex_3.ASTC_6x6.bin')), 'unsupported format written raw');
  assert.ok(rels.some((f) => f.endsWith('AudioClip/Boom_5.ogg')));
  assert.ok(rels.some((f) => f.endsWith('TextAsset/binary_11.bytes')), 'binary text asset gets .bytes');
  assert.ok(rels.some((f) => /TextAsset\/.*evil_4\.txt$/.test(f)), 'traversal name was sanitised');

  const ogg = walk(out).find((f) => f.endsWith('Boom_5.ogg'));
  assert.deepEqual(readFileSync(ogg), OGG);
  const streamed = decodePng(readFileSync(walk(out).find((f) => f.endsWith('Streamed_2.png'))));
  assert.deepEqual([...streamed.rgba.subarray(0, 4)], [255, 0, 0, 255]); // DXT1 block: left red
  assert.deepEqual([...streamed.rgba.subarray(12, 16)], [0, 0, 255, 255]); // right blue

  assert.equal(r.written, 6);            // Hero, Streamed, LooseDxt, Boom, the sanitised text, the binary .bytes asset
  assert.equal(r.raw, 1);
  assert.equal(r.noTypeTree, 1);         // Hidden texture in the stripped file
  assert.equal(r.failed, 0);
  assert.ok(r.items.find((i) => i.status === 'no-type-tree').note.includes('type tree'));
  assert.ok(rels.some((f) => f.includes('_json')) === false, 'only non-exportable classes get JSON, none exist in the fixture');
});

test('session: type filter and id selection', () => {
  const s = new Session();
  s.load(makeGameDir());
  const out = mkdtempSync(join(tmpdir(), 'xera-out-'));
  const r = s.export({ outDir: out, types: ['TextAsset'] });
  assert.equal(r.written, 2);
  assert.ok(walk(out).every((f) => f.includes('TextAsset')));
  const out2 = mkdtempSync(join(tmpdir(), 'xera-out-'));
  const r2 = s.export({ outDir: out2, ids: [s.assets.find((a) => a.name === 'Hero').id] });
  assert.equal(r2.written, 1);
});

test('safeSegment neutralises traversal and odd names', () => {
  for (const bad of ['.', '..', '...', '../../evil', '/etc/passwd', '..\\..\\win']) {
    const seg = safeSegment(bad);
    assert.ok(seg !== '.' && seg !== '..' && !/[\\/]/.test(seg), `${bad} -> ${seg}`);
  }
  assert.equal(safeSegment('..'), '_');
  assert.equal(safeSegment(''), 'unnamed');
  assert.equal(safeSegment('a/b\\c:d'), 'a_b_c_d');
  assert.ok(safeSegment('x'.repeat(500)).length <= 100);
});

test('zip: reads stored + deflated entries and validates CRC / size', () => {
  const dir = mkdtempSync(join(tmpdir(), 'xera-zip-'));
  const p = join(dir, 'a.zip');
  const big = Buffer.alloc(100000, 'abc');
  writeFileSync(p, buildZip([{ name: 'a.txt', data: 'hello' }, { name: 'dir/big.bin', data: big, deflate: true }, { name: 'dir/', data: '' }]));
  const z = new ZipArchive(p);
  assert.deepEqual(z.entries.map((e) => e.name), ['a.txt', 'dir/big.bin']);
  assert.equal(z.read('a.txt').toString(), 'hello');
  assert.deepEqual(z.read('dir/big.bin'), big);
  assert.throws(() => z.read('nope'), /no such entry/);
  z.close();

  const corrupt = Buffer.from(readFileSync(p));
  corrupt[corrupt.indexOf('hello')] ^= 0xff;
  writeFileSync(join(dir, 'bad.zip'), corrupt);
  const bad = new ZipArchive(join(dir, 'bad.zip'));
  assert.throws(() => bad.read('a.txt'), /CRC mismatch/);
  bad.close();
  writeFileSync(join(dir, 'junk.zip'), Buffer.alloc(100));
  assert.throws(() => new ZipArchive(join(dir, 'junk.zip')), /not a zip/);
});

test('zip: agrees with the real `zip` tool', { skip: (() => { try { execFileSync('zip', ['-v'], { stdio: 'ignore' }); return false; } catch { return 'zip not installed'; } })() }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'xera-zip2-'));
  mkdirSync(join(dir, 'src/sub'), { recursive: true });
  writeFileSync(join(dir, 'src/one.txt'), 'one');
  writeFileSync(join(dir, 'src/sub/two.bin'), Buffer.alloc(50000, 7));
  execFileSync('zip', ['-qr', join(dir, 'real.zip'), '.'], { cwd: join(dir, 'src') });
  const z = new ZipArchive(join(dir, 'real.zip'));
  assert.deepEqual(z.entries.map((e) => e.name).sort(), ['one.txt', 'sub/two.bin']);
  assert.equal(z.read('one.txt').toString(), 'one');
  assert.equal(z.read('sub/two.bin').length, 50000);
  z.close();
});

test('apk: a zip of a Unity player is scanned in place, resources resolved from inside the archive', () => {
  const root = makeGameDir();
  const data = join(root, 'Game_Data');
  const entries = [];
  for (const name of ['scene.unity3d', 'level0', 'level0.resS', 'sharedassets0.assets', 'libfoo.so']) {
    entries.push({ name: `assets/bin/Data/${name}`, data: readFileSync(join(data, name)), deflate: name !== 'level0.resS' });
  }
  entries.push({ name: 'META-INF/MANIFEST.MF', data: 'x' }, { name: 'AndroidManifest.xml', data: '<x/>' }, { name: '../../traversal/level9', data: Buffer.alloc(64) });
  const apk = join(mkdtempSync(join(tmpdir(), 'xera-apk-')), 'game.apk');
  writeFileSync(apk, buildZip(entries));

  const s = new Session();
  const sum = s.load(apk);
  assert.equal(sum.assetCount, 8);
  const out = mkdtempSync(join(tmpdir(), 'xera-out-'));
  const r = s.export({ outDir: out });
  assert.equal(r.failed, 0);
  assert.ok(walk(out).some((f) => f.endsWith('LooseDxt_10.png')), 'level0.resS resolved from the apk');
  for (const f of walk(out)) assert.ok(!relative(out, f).startsWith('..'));
});

test('session: reset clears everything and a bad path is a clean error', () => {
  const s = new Session();
  s.load(makeGameDir());
  assert.ok(s.loaded);
  s.reset();
  assert.equal(s.loaded, false);
  assert.equal(s.assets.length, 0);
  assert.throws(() => s.load('/definitely/not/here'), /ENOENT/);
  assert.throws(() => s.export({}), /outDir/);
});

test('folder scan probes headers only: a huge unrelated file is never loaded, junk is ignored', () => {
  const root = makeGameDir();
  const big = join(root, 'movie.bin');
  writeFileSync(big, Buffer.alloc(8 * 1024 * 1024, 0x5a)); // 8 MiB of non-Unity data with a non-skipped extension
  const s = new Session();
  s.load(root);
  assert.equal(s.assets.length, 8);
  assert.ok(!s.skipped.some((x) => x.name.includes('movie.bin')), 'unrelated files are ignored without noise');
});

test('sources: head() returns only the requested prefix and refuses to escape the folder', async () => {
  const { DirSource, FileSource } = await import('../src/sources.js');
  const root = makeGameDir();
  const d = new DirSource(root);
  assert.equal(d.head('readme.txt', 3).toString(), 'hel');
  assert.equal(d.head('readme.txt', 100).toString(), 'hello');
  assert.throws(() => d.head('../../etc/passwd', 10), /escapes/);
  assert.throws(() => d.read('../../etc/passwd'), /escapes/);
  assert.equal(new FileSource(join(root, 'readme.txt')).head('readme.txt', 2).toString(), 'he');
});
