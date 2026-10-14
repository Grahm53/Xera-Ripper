import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Session } from '../src/session.js';
import * as views from '../src/views.js';
import { browse, createApp } from '../src/server.js';
import { cleanPath } from '../src/paths.js';
import { makeProjectGame } from './helpers/projectFixture.js';
import { makeGameDir } from './helpers/fixture.js';

function loaded() { const s = new Session(); s.load(makeProjectGame()); return s; }

test('collections: one entry per serialized file, with per-class counts and scene detection', () => {
  const s = loaded();
  const c = views.collections(s);
  assert.equal(c.length, 4);
  const level = c.find((x) => x.name.endsWith('/level1'));
  assert.equal(level.scene, true);
  assert.equal(level.gameObjects, 2);
  assert.equal(level.counts.GameObject, 2);
  assert.equal(level.counts.MeshRenderer, 1);
  const prefabs = c.find((x) => x.name.includes('prefabs.bundle'));
  assert.equal(prefabs.scene, false, 'a normal asset bundle holds prefabs, not a scene');
  assert.equal(prefabs.bundleIndex, 0);
  assert.equal(level.bundleIndex, null);
  assert.equal(c.find((x) => x.name.endsWith('sharedassets0.assets')).scene, false);
  assert.equal(level.treeSource, 'database');
});

test('bundles: members are listed, serialized ones link to their collection', () => {
  const s = loaded();
  const b = views.bundles(s);
  assert.equal(b.length, 1);
  assert.equal(b[0].name, 'Game_Data/prefabs.bundle');
  assert.equal(b[0].unityRevision, '2019.4.31f1');
  assert.deepEqual(b[0].members.map((m) => [m.path, m.kind, m.collection]), [['CAB-hero', 'serialized', 'Game_Data/prefabs.bundle/CAB-hero']]);
});

test('bundles: streamed resource members are listed too', () => {
  const s = new Session();
  s.load(makeGameDir()); // scene.unity3d has CAB-abc + CAB-abc.resS
  const b = views.bundles(s).find((x) => x.name.endsWith('scene.unity3d'));
  assert.deepEqual(b.members.map((m) => [m.path, m.kind]), [['CAB-abc', 'serialized'], ['CAB-abc.resS', 'resource']]);
  assert.equal(b.members[1].collection, null);
});

test('scenes: only files with GameObjects that are not prefab bundles', () => {
  const s = loaded();
  const sc = views.scenes(s);
  assert.deepEqual(sc.map((x) => [x.name, x.gameObjects]), [['level1', 2]]);
});

test('scene tree: hierarchy, components and ids that open the asset', () => {
  const s = loaded();
  const t = views.sceneTree(s, views.scenes(s)[0].fileIndex);
  assert.equal(t.total, 2);
  assert.equal(t.roots.length, 1);
  const cube = t.roots[0];
  assert.equal(cube.name, 'Cube');
  assert.equal(cube.active, true);
  assert.deepEqual(cube.components.map((c) => c.type), ['Transform', 'MeshRenderer', 'MonoBehaviour']);
  assert.deepEqual(cube.children.map((c) => c.name), ['Child']);
  assert.equal(s.asset(cube.id).className, 'GameObject');
  assert.equal(s.asset(cube.components[1].id).className, 'MeshRenderer');
  assert.throws(() => views.sceneTree(s, 99), /no such collection/);
});

test('hex: slices of the raw object bytes, clamped, base64', () => {
  const s = loaded();
  const a = s.assets.find((x) => x.name === 'Cube');
  const raw = s.files[a.fileIndex].sf.objectBytes(a.obj);
  const all = views.hex(s, a.id, 0, 100000);
  assert.equal(all.total, raw.length);
  assert.equal(all.length, Math.min(raw.length, views.MAX_HEX_CHUNK));
  assert.deepEqual(Buffer.from(all.data, 'base64'), raw.subarray(0, all.length));
  const mid = views.hex(s, a.id, 4, 8);
  assert.deepEqual(Buffer.from(mid.data, 'base64'), raw.subarray(4, 12));
  assert.deepEqual(views.hex(s, a.id, 10 ** 9, 8), { total: raw.length, offset: raw.length, length: 0, data: '' });
  assert.equal(views.hex(s, a.id, -5, 4).offset, 0);
  assert.equal(views.hex(s, a.id, NaN, NaN).offset, 0);
});

test('yaml view: Unity text format with original path ids; undecodable objects explain themselves', () => {
  const s = loaded();
  const go = s.assets.find((x) => x.name === 'Cube');
  const y = views.yaml(s, go.id);
  assert.ok(y.startsWith('%YAML 1.1\n%TAG !u! tag:unity3d.com,2011:\n--- !u!1 &10\nGameObject:\n'));
  assert.match(y, /m_TagString: MainCamera/);
  assert.match(y, /- component: \{fileID: 11\}/);
  const mr = s.assets.find((x) => x.className === 'MeshRenderer');
  assert.match(views.yaml(s, mr.id), /m_Materials:\n {2}- \{fileID: 1, guid: external-file-2, type: 0\}/);
});

test('project export switches: turned-off kinds are skipped with a clear reason and not written', () => {
  const s = loaded();
  const out = mkdtempSync(join(tmpdir(), 'xera-sw-'));
  const r = s.exportProject({ outDir: out, include: { textures: false, scenes: false, assets: false } });
  assert.equal(r.textures, 0);
  assert.equal(r.scenes, 0);
  assert.equal(r.yamlAssets, 0);
  assert.equal(r.prefabs, 1, 'prefabs were left on');
  assert.equal(r.text, 1);
  assert.ok(r.skippedByReason['turned off in the export settings'] >= 5);
  assert.ok(!existsSync(join(r.projectDir, 'Assets/Scenes/level1.unity')));
  assert.ok(existsSync(join(r.projectDir, 'Assets/prefabs/hero.prefab')));
  const md = readFileSync(join(r.projectDir, 'XeraRipper-Report.md'), 'utf8');
  assert.match(md, /turned off in the export settings/);
});

test('cleanPath: quotes pasted from Explorer, spaces, ~', () => {
  assert.equal(cleanPath('  "C:\\Users\\Me\\My Games\\game.apk"  '), 'C:\\Users\\Me\\My Games\\game.apk');
  assert.equal(cleanPath("'/tmp/x y'"), '/tmp/x y');
  assert.equal(cleanPath('~', { home: '/h' }), '/h');
  assert.equal(cleanPath('~/games', { home: '/h' }), '/h/games');
  assert.equal(cleanPath('~\\games', { home: 'C:\\h' }), 'C:\\h\\games');
  assert.equal(cleanPath('"unterminated'), '"unterminated');
  assert.equal(cleanPath(undefined), '');
});

// ---- Windows browsing, simulated: a fake file system and path.win32
function fakeFs(tree) {
  const key = (p) => p.replace(/[\\/]+$/, '');
  return {
    exists: (p) => ['C:\\', 'D:\\'].includes(p),
    stat: (p) => { const e = tree[key(p)] ?? tree[p]; if (!e) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); return { isFile: () => e.file === true, size: e.size ?? 0 }; },
    readdir: (p) => {
      const kids = tree[key(p)]?.kids;
      if (!kids) throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
      return kids.map((k) => ({ name: k.name, isSymbolicLink: () => false, isDirectory: () => !k.file, isFile: () => Boolean(k.file) }));
    },
  };
}
const WIN = {
  pathMod: path.win32, platform: 'win32', home: () => 'C:\\Users\\Me',
  ...fakeFs({
    'C:': { kids: [{ name: 'Users' }] }, 'C:\\Users': { kids: [{ name: 'Me' }] },
    'C:\\Users\\Me': { kids: [{ name: 'Downloads' }, { name: 'notes.txt', file: true }, { name: 'locked' }] },
    'C:\\Users\\Me\\Downloads': { kids: [{ name: 'Game.apk', file: true, size: 5 }] }, 'C:\\Users\\Me\\Downloads\\Game.apk': { file: true, size: 5 },
    'C:\\Users\\Me\\locked': {}, 'D:': { kids: [{ name: 'Games' }] },
  }),
};

test('Windows browsing: home, pasted quotes, a file selects it in its folder, forward slashes', () => {
  assert.equal(browse('', WIN).path, 'C:\\Users\\Me');
  assert.equal(browse('"C:\\Users\\Me\\Downloads"', WIN).path, 'C:\\Users\\Me\\Downloads');
  const f = browse('C:\\Users\\Me\\Downloads\\Game.apk', WIN);
  assert.deepEqual([f.path, f.selected, f.sep], ['C:\\Users\\Me\\Downloads', 'Game.apk', '\\']);
  assert.equal(browse('C:/Users/Me', WIN).path, 'C:\\Users\\Me');
  assert.deepEqual(browse('C:\\Users\\Me', WIN).entries.map((e) => [e.name, e.type]), [['Downloads', 'dir'], ['locked', 'dir'], ['notes.txt', 'file']]);
});

test('Windows browsing: other drives are reachable (drive root -> list of drives -> D:\\)', () => {
  const root = browse('C:\\', WIN);
  assert.equal(root.parent, 'drives:', 'above a drive root is the list of drives, not a dead end');
  assert.equal(browse('C:', WIN).path, 'C:\\', '"C:" alone means the drive');
  const drives = browse('drives:', WIN);
  assert.deepEqual(drives.entries.map((e) => e.name), ['C:\\', 'D:\\']);
  assert.equal(drives.parent, null);
  assert.equal(browse('D:\\', WIN).entries[0].name, 'Games');
});

test('browsing errors are clear: missing path, unreadable folder', () => {
  assert.throws(() => browse('C:\\nope', WIN), /no such path/);
  assert.throws(() => browse('C:\\Users\\Me\\locked', WIN), /cannot read .*EACCES/);
  assert.equal(browse('/', { platform: 'linux', pathMod: path.posix, home: () => '/home/u', ...fakeFs({ '': { kids: [{ name: 'home' }] }, '/': { kids: [{ name: 'home' }] } }) }).parent, null, 'POSIX root has no parent');
});

// ---- HTTP API
let app, base, token;
before(async () => {
  app = createApp({ defaultOutDir: mkdtempSync(join(tmpdir(), 'xera-vo-')) });
  const r = await app.start({ port: 0 });
  base = `http://127.0.0.1:${r.port}`; token = app.token;
});
after(() => app.stop());
const api = (p, opts = {}) => fetch(base + p, { ...opts, headers: { 'X-Xera-Token': token, 'Content-Type': 'application/json', ...(opts.headers ?? {}) } });

test('API: views, hex, yaml, drives and settings over HTTP', async () => {
  assert.equal((await api('/api/collections')).status, 200, 'empty before loading');
  assert.deepEqual(await (await api('/api/scenes')).json(), []);
  assert.equal((await api('/api/load', { method: 'POST', body: JSON.stringify({ path: `"${makeProjectGame()}"` }) })).status, 200, 'a quoted path loads');

  const cols = await (await api('/api/collections')).json();
  assert.equal(cols.length, 4);
  assert.equal((await (await api('/api/bundles')).json()).length, 1);
  const sc = await (await api('/api/scenes')).json();
  assert.equal(sc.length, 1);
  const tree = await (await api(`/api/scene/${sc[0].fileIndex}`)).json();
  assert.equal(tree.roots[0].name, 'Cube');
  assert.equal((await api('/api/scene/999')).status, 422);
  assert.equal((await api('/api/scene/abc')).status, 404);

  const cube = tree.roots[0];
  const hexRes = await (await api(`/api/asset/${cube.id}/hex?offset=0&limit=16`)).json();
  assert.equal(hexRes.length, 16);
  assert.equal(Buffer.from(hexRes.data, 'base64').length, 16);
  assert.equal((await (await api(`/api/asset/${cube.id}/hex?offset=-3&limit=99999999`)).json()).offset, 0);
  const yamlRes = await api(`/api/asset/${cube.id}/yaml`);
  assert.equal(yamlRes.status, 200);
  assert.match(yamlRes.headers.get('content-type'), /text\/plain/);
  assert.match(await yamlRes.text(), /^%YAML 1.1/);
  assert.equal((await api('/api/asset/99999/hex')).status, 404);
  assert.equal((await api('/api/asset/99999/yaml')).status, 404);

  const proj = await (await api('/api/project', { method: 'POST', body: JSON.stringify({ outDir: mkdtempSync(join(tmpdir(), 'xera-vo2-')), include: { scenes: false, textures: 'yes' } }) })).json();
  assert.equal(proj.scenes, 0, 'scenes switched off');
  assert.equal(proj.textures, 1, 'a non-boolean switch is ignored, not obeyed');
  const quoted = await api('/api/browse?path=' + encodeURIComponent(`"${tmpdir()}"`));
  assert.equal(quoted.status, 200);
});
