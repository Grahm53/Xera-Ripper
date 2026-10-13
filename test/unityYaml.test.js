import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultTypeDatabase } from '../src/tpk.js';
import { formatFloat32, formatDouble, yamlString, UnityYamlWriter, toEditorValue, YAML_HEADER } from '../src/unityYaml.js';
import { defaultValue, mergeDeep, rng } from './helpers/treeWriter.js';

const db = defaultTypeDatabase();
const V = '2019.4.31f1';
const ptr = (p, f = 0) => ({ m_FileID: f, m_PathID: p });
function doc(classId, over, resolve = (f, p) => (String(p) === '0' ? null : { fileID: p })) {
  const rel = db.treeFor(classId, V);
  const ed = db.editorTreeFor(classId, V);
  return new UnityYamlWriter(ed, resolve).document(classId, 100, toEditorValue(ed, mergeDeep(defaultValue(rel), over)));
}

test('float32 formatting is shortest-round-trip and handles special values', () => {
  assert.equal(formatFloat32(Math.fround(0.1)), '0.1');
  assert.equal(formatFloat32(Math.fround(1 / 3)), '0.33333334');
  assert.equal(formatFloat32(0), '0');
  assert.equal(formatFloat32(-0), '-0');
  assert.equal(formatFloat32(Infinity), 'Infinity');
  assert.equal(formatFloat32(-Infinity), '-Infinity');
  assert.equal(formatFloat32(NaN), 'NaN');
  assert.equal(formatFloat32(1.5), '1.5');
  const r = rng(5);
  for (let i = 0; i < 2000; i++) {
    const x = Math.fround((r() - 0.5) * 10 ** Math.floor(r() * 20 - 10));
    assert.equal(Math.fround(Number(formatFloat32(x))), x, `float ${x}`);
    assert.ok(formatFloat32(x).length <= 16, `${x} -> ${formatFloat32(x)} is not short`);
  }
  assert.equal(formatDouble(0.1), '0.1');
  assert.equal(formatDouble(-2.5e-7), '-2.5e-7');
});

test('string scalars are quoted exactly when YAML needs it', () => {
  for (const s of ['Cube', 'Main Camera', 'a_b-c', 'path/to/thing', 'Assets/x.png', 'v1.2.3', 'a:b', "it's", 'x-y', 'a.b']) {
    assert.equal(yamlString(s), s, `${s} is a valid plain scalar and is written as-is, like Unity does`);
  }
  for (const s of ['', 'true', 'False', 'null', '~', 'yes', 'No', '123', '-5', '1e5', '0x1f', '.5', ' lead', 'trail ', 'a: b', '#hash', 'x #y', '- dash', '{b}', '[a]', 'a,b', '@at', '`tick', '*star', '&amp', '!bang', '%pct', '|pipe', '>gt', '?q', 'ends:']) {
    assert.match(yamlString(s), /^['"]/, `${JSON.stringify(s)} must be quoted`);
  }
  assert.equal(yamlString("it's: x"), "'it''s: x'");
  assert.equal(yamlString('multi\nline'), '"multi\\nline"');
  assert.equal(yamlString('tab\there'), '"tab\\there"');
  assert.equal(yamlString('quote"back\\slashé'), '"quote\\"back\\\\slash\\u00E9"');
  assert.equal(yamlString('smile \u{1F600}'), '"smile \\U0001F600"');
  assert.equal(yamlString('\u0000\u001f'), '"\\u0000\\u001F"');
});

test('GameObject document matches the Unity editor format (serializedVersion, flow refs, sequences at key indent, 0/1 bools)', () => {
  const text = doc(1, {
    m_Name: 'Cube', m_IsActive: true, m_Layer: 3, m_TagString: 'MainCamera',
    m_Component: [{ component: ptr(11) }, { component: ptr(12) }],
  });
  assert.equal(text, `--- !u!1 &100
GameObject:
  serializedVersion: 6
  m_ObjectHideFlags: 0
  m_CorrespondingSourceObject: {fileID: 0}
  m_PrefabInstance: {fileID: 0}
  m_PrefabAsset: {fileID: 0}
  m_Component:
  - component: {fileID: 11}
  - component: {fileID: 12}
  m_Layer: 3
  m_Name: Cube
  m_TagString: Untagged
  m_Icon: {fileID: 0}
  m_NavMeshLayer: 0
  m_StaticEditorFlags: 0
  m_IsActive: 1
`.replace('m_TagString: Untagged', 'm_TagString: \'\''), 'runtime objects carry m_Tag, not m_TagString; the exporter patches it in');
});

test('Transform document: no serializedVersion (layout version 1), flow vectors, empty and non-empty child lists', () => {
  const text = doc(4, {
    m_GameObject: ptr(10), m_LocalRotation: { x: 0, y: 0, z: 0, w: 1 }, m_LocalPosition: { x: 1.5, y: -2, z: 0.25 }, m_LocalScale: { x: 1, y: 1, z: 1 },
    m_Children: [ptr(14), ptr(15)], m_Father: ptr(0),
  });
  assert.ok(!text.includes('serializedVersion'));
  assert.match(text, /m_LocalPosition: \{x: 1\.5, y: -2, z: 0\.25\}\n/);
  assert.match(text, /m_Children:\n  - \{fileID: 14\}\n  - \{fileID: 15\}\n  m_Father: \{fileID: 0\}\n/);
  assert.match(doc(4, { m_Children: [] }), /m_Children: \[\]\n/);
});

test('Material document: map<string,T> is written as "- key: value", references carry guid+type, nested serializedVersion', () => {
  const text = doc(21, {
    m_Name: "it's: tricky", m_Shader: ptr(5, 2),
    m_SavedProperties: {
      m_TexEnvs: [{ first: '_MainTex', second: { m_Texture: ptr(2, 2), m_Scale: { x: 1, y: 1 }, m_Offset: { x: 0, y: 0 } } }],
      m_Floats: [{ first: '_Cutoff', second: 0.5 }, { first: '_Glossiness', second: Math.fround(0.1) }],
      m_Colors: [{ first: '_Color', second: { r: 1, g: 0.5, b: 0.25, a: 1 } }],
    },
  }, (f, p) => (String(p) === '0' ? null : { fileID: 2800000, guid: 'abcdef0123456789abcdef0123456789', type: 3 }));
  assert.match(text, /m_Name: 'it''s: tricky'\n/);
  assert.match(text, /m_Shader: \{fileID: 2800000, guid: abcdef0123456789abcdef0123456789, type: 3\}\n/);
  assert.match(text, / {2}m_SavedProperties:\n {4}serializedVersion: 3\n {4}m_TexEnvs:\n {4}- _MainTex:\n {8}m_Texture: \{fileID: 2800000, guid: abcdef0123456789abcdef0123456789, type: 3\}\n {8}m_Scale: \{x: 1, y: 1\}\n {8}m_Offset: \{x: 0, y: 0\}\n {4}m_Floats:\n {4}- _Cutoff: 0.5\n {4}- _Glossiness: 0.1\n {4}m_Colors:\n {4}- _Color: \{r: 1, g: 0.5, b: 0.25, a: 1\}\n/);
});

test('editor conversion keeps shared fields, defaults editor-only ones, and drops runtime-only ones', () => {
  const tex = toEditorValue(db.editorTreeFor(28, V), mergeDeep(defaultValue(db.treeFor(28, V)), { m_Name: 'Tex', m_Width: 64, 'image data': Buffer.from([1, 2, 3]) }));
  assert.equal(tex.m_Name, 'Tex');
  assert.equal(tex.m_Width, 64);
  assert.deepEqual(tex['image data'], Buffer.from([1, 2, 3]), 'shared fields keep their values');
  assert.equal(tex.m_ObjectHideFlags, 0, 'editor-only field defaulted');
  assert.deepEqual(tex.m_CorrespondingSourceObject, { m_FileID: 0, m_PathID: 0 });
  assert.equal(tex.m_AlphaIsTransparency, false, 'editor-only bool defaults to false (written as 0)');
  // GameObject: the runtime tag id has no editor field (m_TagString replaces it) and is dropped
  const go = toEditorValue(db.editorTreeFor(1, V), mergeDeep(defaultValue(db.treeFor(1, V)), { m_Name: 'G', m_Tag: 5 }));
  assert.ok(!('m_Tag' in go));
  assert.equal(go.m_TagString, '');
  assert.equal(go.m_Name, 'G');
});

test('class ancestry identifies scene objects', () => {
  assert.deepEqual(db.ancestry(114, V).slice(0, 3), ['MonoBehaviour', 'Behaviour', 'Component']);
  assert.ok(db.ancestry(23, V).includes('Component'));
  assert.ok(db.ancestry(104, V).includes('LevelGameManager'));
  assert.ok(!db.ancestry(28, V).includes('Component'));
  assert.ok(!db.ancestry(21, V).includes('Component'));
});

test('header constant', () => {
  assert.equal(YAML_HEADER, '%YAML 1.1\n%TAG !u! tag:unity3d.com,2011:\n');
});
