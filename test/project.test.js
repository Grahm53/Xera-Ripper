import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { Session } from '../src/session.js';
import { defaultTypeDatabase } from '../src/tpk.js';
import { buildSerializedFile } from './helpers/builders.js';
import { defaultValue, mergeDeep, serializeObject } from './helpers/treeWriter.js';
import { makeProjectGame, UNITY } from './helpers/projectFixture.js';
import { decodePng } from './helpers/pngdecode.js';

const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));
const read = (root, rel) => readFileSync(join(root, rel), 'utf8');
const guidOf = (root, rel) => /guid: ([0-9a-f]{32})/.exec(read(root, `${rel}.meta`))[1];

function exportFixture() {
  const s = new Session();
  s.load(makeProjectGame());
  const r = s.exportProject({ outDir: mkdtempSync(join(tmpdir(), 'xera-pout-')) });
  return { s, r, root: r.projectDir };
}

test('project: layout, skipped settings, original paths from AssetBundle containers', () => {
  const { r, root } = exportFixture();
  const files = walk(root).map((f) => relative(root, f)).sort();
  for (const f of [
    'Assets/Scenes/level1.unity', 'Assets/Scenes/level1.unity.meta',
    'Assets/prefabs/hero.prefab', 'Assets/prefabs/hero.prefab.meta',            // from m_Container, not from our naming scheme
    'Assets/materials/hero.mat', 'Assets/materials/hero.mat.meta',
    'Assets/Game_Data/sharedassets0.assets/Texture2D/Albedo.png', 'Assets/Game_Data/sharedassets0.assets/Texture2D/Albedo.png.meta',
    'Assets/Game_Data/sharedassets0.assets/Material/Wall.mat',
    'Assets/Game_Data/sharedassets0.assets/TextAsset/Notes.txt',
    'ProjectSettings/ProjectVersion.txt', 'Packages/manifest.json', 'XeraRipper-Report.md', 'XeraRipper-Report.json',
  ]) assert.ok(files.includes(f), `missing ${f}\n${files.join('\n')}`);
  assert.equal(read(root, 'ProjectSettings/ProjectVersion.txt'), `m_EditorVersion: ${UNITY}\n`);
  assert.deepEqual(JSON.parse(read(root, 'Packages/manifest.json')), { dependencies: {} });
  assert.deepEqual([r.scenes, r.prefabs, r.textures, r.text, r.yamlAssets], [1, 1, 1, 1, 2]);
  assert.equal(r.skippedByReason['project/player settings (not exported yet)'], 1);
  assert.equal(r.skippedByReason['AssetBundle manifest (used to recover names and paths)'], 1);
  assert.ok(files.every((f) => !f.startsWith('..')));
});

test('project: every exported asset has a deterministic, unique GUID, and the texture really is a PNG', () => {
  const a = exportFixture();
  const b = exportFixture();
  const metas = walk(a.root).filter((f) => f.endsWith('.meta'));
  const guids = metas.map((f) => /guid: ([0-9a-f]{32})/.exec(readFileSync(f, 'utf8'))[1]);
  assert.equal(new Set(guids).size, guids.length, 'GUIDs are unique');
  const rel = (root) => walk(root).filter((f) => f.endsWith('.meta')).map((f) => `${relative(root, f)}=${/guid: (\w+)/.exec(readFileSync(f, 'utf8'))[1]}`).sort();
  assert.deepEqual(rel(a.root), rel(b.root), 'two exports of the same input give the same GUIDs (stable across re-exports)');
  const png = decodePng(readFileSync(join(a.root, 'Assets/Game_Data/sharedassets0.assets/Texture2D/Albedo.png')));
  assert.deepEqual([png.width, png.height], [2, 2]);
  assert.deepEqual([...png.rgba.subarray(0, 4)], [0, 0, 255, 255], 'Unity bottom-up rows are flipped');
});

test('project: references between files are rewritten to {fileID, guid, type}', () => {
  const { root } = exportFixture();
  const matGuid = guidOf(root, 'Assets/Game_Data/sharedassets0.assets/Material/Wall.mat');
  const texGuid = guidOf(root, 'Assets/Game_Data/sharedassets0.assets/Texture2D/Albedo.png');
  const scene = read(root, 'Assets/Scenes/level1.unity');
  // scene MeshRenderer -> material in another file (native asset: fileID classId*100000, type 2); built-in -> builtin guid, type 0
  assert.match(scene, new RegExp(`- \\{fileID: 2100000, guid: ${matGuid}, type: 2\\}`));
  assert.match(scene, /- \{fileID: 5, guid: 0000000000000000e000000000000000, type: 0\}/);
  // material -> texture (imported asset: fileID 2800000, type 3)
  assert.match(read(root, 'Assets/Game_Data/sharedassets0.assets/Material/Wall.mat'), new RegExp(`m_Texture: \\{fileID: 2800000, guid: ${texGuid}, type: 3\\}`));
  // inside one scene, references are local fileIDs (the original path ids), not guids
  assert.match(scene, /m_GameObject: \{fileID: 10\}/);
  assert.match(scene, /m_Father: \{fileID: 11\}/);
});

test('project: scene keeps the hierarchy, tags, settings objects; documents carry class ids and path-id anchors', () => {
  const { root } = exportFixture();
  const scene = read(root, 'Assets/Scenes/level1.unity');
  assert.ok(scene.startsWith('%YAML 1.1\n%TAG !u! tag:unity3d.com,2011:\n--- !u!1 &10\nGameObject:\n'));
  for (const id of [['1', 10], ['4', 11], ['23', 12], ['1', 13], ['4', 14], ['114', 15], ['104', 16]]) {
    assert.ok(scene.includes(`--- !u!${id[0]} &${id[1]}\n`), `document ${id}`);
  }
  assert.match(scene, /m_Name: Cube\n {2}m_TagString: MainCamera\n/, 'runtime tag id 5 becomes MainCamera');
  assert.match(scene, /m_LocalPosition: \{x: 1, y: 2, z: 3\}/);
  assert.match(scene, /m_Children:\n {2}- \{fileID: 14\}/);
});

test('project: prefab bundle becomes a prefab per hierarchy, at its original path, and the manifest is not exported', () => {
  const { root } = exportFixture();
  const prefab = read(root, 'Assets/prefabs/hero.prefab');
  assert.match(prefab, /--- !u!1 &20\nGameObject:/);
  assert.match(prefab, /--- !u!4 &21\nTransform:/);
  assert.match(prefab, /m_LocalScale: \{x: 2, y: 2, z: 2\}/);
  assert.ok(!prefab.includes('AssetBundle:'));
  assert.match(read(root, 'Assets/materials/hero.mat'), /Material:\n {2}serializedVersion: 6/);
});

test('project: texture importer settings come from the texture, guid-only meta for plain assets', () => {
  const { root } = exportFixture();
  const meta = read(root, 'Assets/Game_Data/sharedassets0.assets/Texture2D/Albedo.png.meta');
  assert.match(meta, /TextureImporter:/);
  assert.match(meta, /sRGBTexture: 1/);
  assert.match(meta, /filterMode: 2\n\s+aniso: 4\n\s+mipBias: 0\n\s+wrapU: 1/);
  assert.match(meta, /enableMipMap: 0/);
  assert.equal(read(root, 'Assets/Scenes/level1.unity.meta'), `fileFormatVersion: 2\nguid: ${guidOf(root, 'Assets/Scenes/level1.unity')}\n`);
});

test('browsing: GameObjects are listed by name even though m_Name is not their first field', () => {
  const s = new Session();
  s.load(makeProjectGame());
  const names = s.list({ type: 'GameObject' }).rows.map((r) => r.name).sort();
  assert.deepEqual(names, ['Child', 'Cube', 'Hero']);
});

test('project: report explains what was left out and states the limits honestly', () => {
  const { root } = exportFixture();
  const md = read(root, 'XeraRipper-Report.md');
  assert.match(md, /textures: 1/);
  assert.match(md, /not exported: 2/);
  assert.match(md, /MonoBehaviour scripts are not decompiled/);
  assert.match(md, /have not been opened in a Unity editor/);
  const j = JSON.parse(read(root, 'XeraRipper-Report.json'));
  assert.equal(j.unityVersion, UNITY);
});

test('project: unsupported textures, FSB audio and undecodable objects are reported, never silently written as junk', () => {
  const db = defaultTypeDatabase();
  const t = (id) => db.treeFor(id, UNITY);
  const obj = (id, over) => serializeObject(t(id), mergeDeep(defaultValue(t(id)), over));
  const dir = mkdtempSync(join(tmpdir(), 'xera-pbad-'));
  mkdirSync(join(dir, 'D'));
  writeFileSync(join(dir, 'D', 'sharedassets1.assets'), buildSerializedFile({
    version: 19, unityVersion: UNITY, enableTypeTree: false,
    types: [{ classId: 28, tree: null }, { classId: 83, tree: null }, { classId: 49, tree: null }],
    objects: [
      { pathId: 1, typeIndex: 0, data: obj(28, { m_Name: 'Astc', m_Width: 4, m_Height: 4, m_TextureFormat: 50, 'image data': Buffer.alloc(16, 5) }) },
      { pathId: 2, typeIndex: 1, data: obj(83, { m_Name: 'Bank', m_Resource: { m_Source: 'archive:/x/sharedassets1.resS', m_Offset: 0, m_Size: 4 }, m_CompressionFormat: 1 }) },
      { pathId: 3, typeIndex: 2, data: obj(49, { m_Name: 'Ok', m_Script: 'fine' }) },
      { pathId: 4, typeIndex: 2, data: Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]) },  // garbage that does not fit TextAsset's layout
    ],
  }));
  writeFileSync(join(dir, 'D', 'sharedassets1.resS'), Buffer.from('FSB5'));
  const s = new Session();
  s.load(dir);
  const r = s.exportProject({ outDir: mkdtempSync(join(tmpdir(), 'xera-pout-')) });
  const why = Object.keys(r.skippedByReason).join(' | ');
  assert.match(why, /ASTC_6x6/);
  assert.match(why, /FSB5/);
  assert.equal(r.text, 1, 'only the valid TextAsset was exported');
  assert.equal(r.textures, 0);
  assert.ok(r.skipped.some((x) => x.name === 'Astc'));
  assert.ok(r.skipped.length >= 3, why);
  assert.ok(!walk(r.projectDir).some((f) => /\.(bin|fsb)$/.test(f)), 'no raw junk files in Assets/');
});

test('project: hostile names cannot escape the project folder; name collisions get distinct files', () => {
  const db = defaultTypeDatabase();
  const t = (id) => db.treeFor(id, UNITY);
  const obj = (id, over) => serializeObject(t(id), mergeDeep(defaultValue(t(id)), over));
  const dir = mkdtempSync(join(tmpdir(), 'xera-phost-'));
  mkdirSync(join(dir, 'D'));
  writeFileSync(join(dir, 'D', 'sharedassets0.assets'), buildSerializedFile({
    version: 19, unityVersion: UNITY, enableTypeTree: false, types: [{ classId: 49, tree: null }, { classId: 142, tree: null }],
    objects: [
      { pathId: 1, typeIndex: 0, data: obj(49, { m_Name: '../../../etc/passwd', m_Script: 'a' }) },
      { pathId: 2, typeIndex: 0, data: obj(49, { m_Name: 'same', m_Script: 'b' }) },
      { pathId: 3, typeIndex: 0, data: obj(49, { m_Name: 'same', m_Script: 'c' }) },
      { pathId: 4, typeIndex: 0, data: obj(49, { m_Name: 'viaContainer', m_Script: 'd' }) },
      { pathId: 9, typeIndex: 1, data: obj(142, { m_Container: [{ first: '../../../../evil/escape.txt', second: { preloadIndex: 0, preloadSize: 1, asset: { m_FileID: 0, m_PathID: 4 } } }] }) },
    ],
  }));
  const out = mkdtempSync(join(tmpdir(), 'xera-pout-'));
  const s = new Session();
  s.load(dir);
  const r = s.exportProject({ outDir: out });
  const files = walk(r.projectDir).map((f) => relative(r.projectDir, f));
  assert.ok(files.every((f) => !f.startsWith('..') && !f.includes('/../')), files.join('\n'));
  assert.ok(!existsSync(join(out, '..', 'evil')) && !existsSync(join(out, 'evil')));
  const txt = files.filter((f) => f.startsWith('Assets/') && f.endsWith('.txt'));
  assert.equal(txt.length, 4);
  assert.equal(new Set(txt.map((f) => f.toLowerCase())).size, 4, 'no two assets share a path (case-insensitively)');
});

test('project: nothing loaded is a clean error', () => {
  assert.throws(() => new Session().exportProject({ outDir: tmpdir() }), /nothing is loaded/);
  assert.throws(() => new Session().exportProject({}), /outDir is required/);
});

// Referential integrity of an exported project: no dangling local fileIDs, no unknown GUIDs.
export function checkIntegrity(root) {
  const files = walk(root);
  const guids = new Set(['0000000000000000e000000000000000', '0000000000000000f000000000000000', '0000000000000000d000000000000000']);
  for (const f of files.filter((x) => x.endsWith('.meta'))) guids.add(/guid: ([0-9a-f]{32})/.exec(readFileSync(f, 'utf8'))[1]);
  const problems = [];
  for (const f of files.filter((x) => /\.(unity|prefab|mat|asset|anim|controller)$/.test(x))) {
    const text = readFileSync(f, 'utf8');
    const anchors = new Set([...text.matchAll(/^--- !u!\d+ &(-?\d+)/gm)].map((m) => m[1]));
    for (const m of text.matchAll(/\{fileID: (-?\d+)(?:, guid: ([0-9a-f]+), type: (\d))?\}/g)) {
      const [, id, guid] = m;
      if (guid) { if (!guids.has(guid)) problems.push(`${relative(root, f)}: unknown guid ${guid}`); }
      else if (id !== '0' && !anchors.has(id)) problems.push(`${relative(root, f)}: dangling local fileID ${id}`);
    }
  }
  return problems;
}

test('project: referential integrity (no dangling fileIDs, every guid exists)', () => {
  const { root } = exportFixture();
  assert.deepEqual(checkIntegrity(root), []);
});

test('project: a reference to an object that could not be exported degrades to {fileID: 0} instead of dangling', () => {
  const db = defaultTypeDatabase();
  const t = (id) => db.treeFor(id, UNITY);
  const obj = (id, over) => serializeObject(t(id), mergeDeep(defaultValue(t(id)), over));
  const dir = mkdtempSync(join(tmpdir(), 'xera-pdang-'));
  mkdirSync(join(dir, 'D'));
  // a material whose texture is ASTC (cannot be exported) -> the material must not point at a missing PNG
  writeFileSync(join(dir, 'D', 'sharedassets0.assets'), buildSerializedFile({
    version: 19, unityVersion: UNITY, enableTypeTree: false, types: [{ classId: 21, tree: null }, { classId: 28, tree: null }],
    objects: [
      { pathId: 1, typeIndex: 0, data: obj(21, { m_Name: 'M', m_SavedProperties: { m_TexEnvs: [{ first: '_MainTex', second: { m_Texture: { m_FileID: 0, m_PathID: 2 }, m_Scale: { x: 1, y: 1 }, m_Offset: { x: 0, y: 0 } } }] } }) },
      { pathId: 2, typeIndex: 1, data: obj(28, { m_Name: 'Astc', m_Width: 4, m_Height: 4, m_TextureFormat: 50, 'image data': Buffer.alloc(16) }) },
    ],
  }));
  const s = new Session();
  s.load(dir);
  const r = s.exportProject({ outDir: mkdtempSync(join(tmpdir(), 'xera-pout-')) });
  const mat = walk(r.projectDir).find((f) => f.endsWith('M.mat'));
  assert.match(readFileSync(mat, 'utf8'), /m_Texture: \{fileID: 0\}/);
  assert.deepEqual(checkIntegrity(r.projectDir), []);
});
