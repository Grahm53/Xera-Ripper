import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultTypeDatabase, encodeUnityVersion, TypeTreeDatabase } from '../src/tpk.js';
import { SerializedFile } from '../src/serializedFile.js';
import { buildSerializedFile } from './helpers/builders.js';
import { defaultValue, randomValue, serializeObject, mergeDeep, rng } from './helpers/treeWriter.js';

const db = defaultTypeDatabase();

test('unity version encoding matches the database scheme', () => {
  const v = encodeUnityVersion('2019.4.31f1');
  assert.deepEqual([v >> 48n, (v >> 32n) & 0xffffn, (v >> 16n) & 0xffffn, (v >> 8n) & 0xffn, v & 0xffn], [2019n, 4n, 31n, 3n, 1n]);
  assert.equal(encodeUnityVersion('2022.3.5b2') >> 8n & 0xffn, 1n, 'b = beta');
  assert.equal((encodeUnityVersion('5.6.7') >> 8n) & 0xffn, 3n, 'no letter means final');
  assert.equal((encodeUnityVersion('2020.1.0a12') >> 8n) & 0xffn, 0n);
  assert.equal(encodeUnityVersion('nonsense'), null);
  assert.ok(encodeUnityVersion('2021.3.10f1') > encodeUnityVersion('2019.4.31f1'));
});

test('database loads and knows the core engine classes', () => {
  assert.ok(db, 'data/lzma.tpk must be present');
  assert.ok(db.classes.size > 400);
  const tex = db.treeFor(28, '2019.4.31f1');
  assert.equal(tex.rootType, 'Texture2D');
  assert.deepEqual(tex.nodes.slice(1, 3).map((n) => [n.type, n.name]), [['string', 'm_Name'], ['Array', 'Array']]);
  assert.ok(tex.nodes.some((n) => n.name === 'image data' && n.type === 'TypelessData'));
  assert.ok(tex.nodes.some((n) => n.name === 'm_StreamData'));
  assert.equal(db.treeFor(28, '2019.4.31f1'), db.treeFor(28, '2019.4.31f1'), 'trees are cached');
  assert.equal(db.treeFor(999999, '2019.4.31f1'), null, 'unknown class');
  assert.equal(db.treeFor(28, '1.0.0'), null, 'version older than the database');
  assert.equal(db.treeFor(28, 'garbage'), null);
});

test('layouts differ between Unity versions where the engine changed', () => {
  const a = db.treeFor(28, '5.6.7f1').nodes.length;
  const b = db.treeFor(28, '2019.4.31f1').nodes.length;
  const c = db.treeFor(28, '2022.3.20f1').nodes.length;
  assert.ok(new Set([a, b, c]).size > 1, `Texture2D layout should change across versions (${a}, ${b}, ${c})`);
});

test('corrupt or foreign data is rejected', () => {
  assert.throws(() => new TypeTreeDatabase(Buffer.alloc(10)), /too short/);
  assert.throws(() => new TypeTreeDatabase(Buffer.alloc(64)), /not a TPK/);
});

const CLASSES = {
  Texture2D: 28, TextAsset: 49, AudioClip: 83, Mesh: 43, Material: 21, AnimationClip: 74, GameObject: 1, Transform: 4,
  RectTransform: 224, AssetBundle: 142, Sprite: 213, Shader: 48, Font: 128, MeshRenderer: 23, SkinnedMeshRenderer: 137,
  Animator: 95, AudioSource: 82, Camera: 20, Light: 108, ParticleSystem: 198, MonoBehaviour: 114, Canvas: 223,
};
const VERSIONS = ['2017.4.40f1', '2018.4.36f1', '2019.4.31f1', '2020.3.48f1', '2021.3.10f1', '2022.3.20f1', '6000.0.23f1'];

test('real engine layouts round-trip exactly (serialise by tree -> parse by tree), every class x version', () => {
  let checked = 0;
  for (const version of VERSIONS) {
    for (const [name, id] of Object.entries(CLASSES)) {
      const tree = db.treeFor(id, version);
      if (!tree) continue;
      for (const seed of [1, 2, 3]) {
        const value = randomValue(tree, rng(seed * 1000 + id));
        const bytes = serializeObject(tree, value);
        const { value: back, consumed } = tree.readCounted(bytes);
        assert.deepEqual(back, value, `${name} @ ${version} seed ${seed}`);
        assert.equal(consumed, bytes.length, `${name} @ ${version}: reader must consume exactly the serialised bytes`);
        checked++;
      }
    }
  }
  assert.ok(checked > 300, `only ${checked} combinations were exercised`);
});

test('big-endian files decode with database layouts too', () => {
  const tree = db.treeFor(49, '2019.4.31f1');
  const value = mergeDeep(defaultValue(tree), { m_Name: 'be-name', m_Script: 'hello' });
  const sf = new SerializedFile(buildSerializedFile({
    version: 19, little: false, enableTypeTree: false, types: [{ classId: 49, tree: null }],
    objects: [{ pathId: 1, typeIndex: 0, data: serializeObject(tree, value, false) }],
  }));
  assert.deepEqual(sf.readObject(sf.objects[0]), value);
});

test('stripped file with REAL layouts: whole-file parse + database decode returns the original values', () => {
  const tree = (id) => db.treeFor(id, '2019.4.31f1');
  const tex = mergeDeep(defaultValue(tree(28)), {
    m_Name: 'RealTex', m_Width: 2, m_Height: 2, m_TextureFormat: 4, m_CompleteImageSize: 16,
    'image data': Buffer.from([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255]),
  });
  const txt = mergeDeep(defaultValue(tree(49)), { m_Name: 'RealText', m_Script: 'real script body' });
  const sf = new SerializedFile(buildSerializedFile({
    version: 19, enableTypeTree: false, types: [{ classId: 28, tree: null }, { classId: 49, tree: null }],
    objects: [
      { pathId: 7, typeIndex: 0, data: serializeObject(tree(28), tex) },
      { pathId: 8, typeIndex: 1, data: serializeObject(tree(49), txt) },
    ],
  }));
  assert.equal(sf.treeSource, 'database');
  assert.deepEqual(sf.objects.map((o) => sf.peekName(o)), ['RealTex', 'RealText']);
  assert.deepEqual(sf.readObject(sf.objects[0]), tex);
  assert.deepEqual(sf.readObject(sf.objects[1]), txt);
});

test('MonoBehaviour from the database decodes its base fields and keeps the script-specific tail', () => {
  const tree = db.treeFor(114, '2019.4.31f1');
  const base = mergeDeep(defaultValue(tree), { m_Name: 'Behaviour', m_Enabled: 1 });
  const tail = Buffer.from([9, 8, 7, 6, 5, 4, 3, 2, 1, 0, 1, 2]);
  const sf = new SerializedFile(buildSerializedFile({
    version: 19, enableTypeTree: false, types: [{ classId: 114, tree: null }],
    objects: [{ pathId: 3, typeIndex: 0, data: Buffer.concat([serializeObject(tree, base), tail]) }],
  }));
  const v = sf.readObject(sf.objects[0]);
  assert.equal(v.m_Name, 'Behaviour');
  assert.deepEqual(v.$unparsed, tail);
});
