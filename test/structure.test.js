import { test } from 'node:test';
import assert from 'node:assert/strict';
import { COMMON_BY_OFFSET } from '../src/commonStrings.js';
import { TypeTree, parseTypeTreeBlob, toJsonSafe } from '../src/typeTree.js';
import { SerializedFile, looksLikeSerializedFile, NoTypeTreeError } from '../src/serializedFile.js';
import { BinaryReader } from '../src/binaryReader.js';
import { parseUnityFs, isUnityFs } from '../src/unityFs.js';
import {
  Writer, GENERIC_TREE, TEXTURE2D_TREE, TEXTASSET_TREE, AUDIOCLIP_TREE, typeTreeBlob, buildSerializedFile,
  buildUnityFs, texture2DData, textAssetData, audioClipData,
} from './helpers/builders.js';

test('common string table matches known Unity offsets', () => {
  const known = { 0: 'AABB', 49: 'Array', 106: 'data', 222: 'int', 427: 'm_Name', 795: 'size', 840: 'string', 894: 'TypelessData', 981: 'vector' };
  for (const [off, s] of Object.entries(known)) assert.equal(COMMON_BY_OFFSET.get(Number(off)), s);
});

test('type tree blob round-trips (common + local strings, ref-type hash on v19+)', () => {
  for (const v of [17, 19]) {
    const nodes = parseTypeTreeBlob(new BinaryReader(typeTreeBlob(GENERIC_TREE, v), 0, true), v);
    assert.equal(nodes.length, GENERIC_TREE.length);
    assert.deepEqual(nodes.map((n) => [n.level, n.type, n.name]), GENERIC_TREE.map((n) => [n.level, n.type, n.name]));
  }
});

test('type tree value reader handles vectors, maps, structs, byte arrays and alignment', () => {
  const tree = new TypeTree(parseTypeTreeBlob(new BinaryReader(typeTreeBlob(GENERIC_TREE, 19), 0, true), 19));
  const w = new Writer(true);
  w.i32(3).i32(10).i32(-20).i32(30);                       // m_Ints
  w.i32(2).string('alpha').i32(1).string('be').i32(2);     // m_Map
  w.f32(1.5).f32(-2).f32(0.25);                            // m_Pos
  w.i32(5).bytes([1, 2, 3, 4, 5]).align(4);                // m_Bytes (padded)
  w.u8(1).align(4);                                        // m_Flag, aligned by its flag
  w.i32(0x1234);                                           // m_Tail proves alignment was right
  const v = tree.read(w.toBuffer());
  assert.deepEqual(v.m_Ints, [10, -20, 30]);
  assert.deepEqual(v.m_Map, [{ first: 'alpha', second: 1 }, { first: 'be', second: 2 }]);
  assert.deepEqual(v.m_Pos, { x: 1.5, y: -2, z: 0.25 });
  assert.deepEqual([...v.m_Bytes], [1, 2, 3, 4, 5]);
  assert.equal(v.m_Flag, true);
  assert.equal(v.m_Tail, 0x1234);
  assert.deepEqual(toJsonSafe(v).m_Bytes, { $bytes: 5 });
});

test('type tree reader rejects implausible lengths instead of allocating', () => {
  const tree = new TypeTree(parseTypeTreeBlob(new BinaryReader(typeTreeBlob(TEXTASSET_TREE, 19), 0, true), 19));
  const evil = new Writer(true).i32(0x7fffffff).toBuffer();
  assert.throws(() => tree.read(evil), /implausible length/);
  assert.throws(() => tree.read(new Writer(true).i32(-5).toBuffer()), /implausible length/);
});

const TYPES = [
  { classId: 28, tree: TEXTURE2D_TREE }, { classId: 49, tree: TEXTASSET_TREE }, { classId: 83, tree: AUDIOCLIP_TREE },
];
function sampleObjects(little = true) {
  return [
    { pathId: 1, typeIndex: 0, data: texture2DData({ name: 'Hero', width: 2, height: 2, format: 4, image: Buffer.alloc(16, 9) }) },
    { pathId: -7, typeIndex: 1, data: textAssetData('config', 'hello\nworld', little) },
    { pathId: 300, typeIndex: 2, data: audioClipData({ name: 'boom', source: 'archive:/CAB-1/CAB-1.resS', offset: 16, size: 32 }) },
  ];
}

for (const version of [17, 19, 21, 22]) {
  for (const little of [true, false]) {
    test(`serialized file v${version} (${little ? 'LE' : 'BE'}): parses header, types and objects`, () => {
      const buf = buildSerializedFile({ version, little, types: TYPES, objects: sampleObjects(little) });
      assert.ok(looksLikeSerializedFile(buf));
      const sf = new SerializedFile(buf, 'test');
      assert.equal(sf.version, version);
      assert.equal(sf.unityVersion, '2019.4.31f1');
      assert.equal(sf.hasTypeTree, true);
      assert.deepEqual(sf.objects.map((o) => [o.pathId, o.classId, o.className]), [[1, 28, 'Texture2D'], [-7, 49, 'TextAsset'], [300, 83, 'AudioClip']]);
      assert.equal(sf.little, little);
      // payloads of the texture/audio samples are LE-only, so only the text object (written in file endianness) is name-checked
      assert.equal(sf.peekName(sf.objects[1]), 'config');
      if (little) assert.deepEqual(sf.objects.map((o) => sf.peekName(o)), ['Hero', 'config', 'boom']);
    });
  }
}

test('serialized file: decodes typed objects through the type tree', () => {
  const sf = new SerializedFile(buildSerializedFile({ version: 21, types: TYPES, objects: sampleObjects() }));
  const tex = sf.readObject(sf.objects[0]);
  assert.equal(tex.m_Width, 2);
  assert.equal(tex.m_TextureFormat, 4);
  assert.equal(tex['image data'].length, 16);
  assert.equal(tex.m_StreamData.path, '');
  const txt = sf.readObject(sf.objects[1], { rawStrings: true });
  assert.equal(txt.m_Script.toString(), 'hello\nworld');
  const clip = sf.readObject(sf.objects[2]);
  assert.deepEqual(clip.m_Resource, { m_Source: 'archive:/CAB-1/CAB-1.resS', m_Offset: 16, m_Size: 32 });
  assert.equal(clip.m_CompressionFormat, 1);
});

test('serialized file: stripped type trees give a clear NoTypeTreeError but still list objects', () => {
  const buf = buildSerializedFile({ version: 19, enableTypeTree: false, types: TYPES, objects: sampleObjects() });
  const sf = new SerializedFile(buf);
  assert.equal(sf.hasTypeTree, false);
  assert.equal(sf.objects.length, 3);
  assert.equal(sf.peekName(sf.objects[0]), null);
  assert.throws(() => sf.readObject(sf.objects[0]), NoTypeTreeError);
});

test('serialized file: garbage and truncation are rejected, not mis-parsed', () => {
  assert.equal(looksLikeSerializedFile(Buffer.alloc(100)), false);
  assert.equal(looksLikeSerializedFile(Buffer.from('UnityFS\0 this is not a serialized file at all......')), false);
  const good = buildSerializedFile({ version: 19, types: TYPES, objects: sampleObjects() });
  assert.throws(() => new SerializedFile(good.subarray(0, 90)));
  const sf = new SerializedFile(good);
  sf.objects[0].byteSize = 1e9;
  assert.throws(() => sf.objectBytes(sf.objects[0]), /outside the file/);
});

function bundleFiles() {
  const sf = buildSerializedFile({ version: 19, types: TYPES, objects: sampleObjects() });
  const res = Buffer.from(Array.from({ length: 300 }, (_, i) => i & 0xff));
  return [
    { path: 'CAB-1', data: sf, serialized: true },
    { path: 'CAB-1.resS', data: res },
  ];
}

const bundleCases = [
  { name: 'stored', opts: {} },
  { name: 'lz4 blocks, stored info', opts: { compression: 'lz4' } },
  { name: 'lz4 blocks + lz4 info', opts: { compression: 'lz4', infoCompression: 'lz4' } },
  { name: 'info at end (flag 0x80)', opts: { compression: 'lz4', infoAtEnd: true } },
  { name: 'padding flag (0x200)', opts: { compression: 'lz4', pad: true } },
  { name: 'format version 6 (no header alignment)', opts: { version: 6, compression: 'lz4' } },
];
for (const c of bundleCases) {
  test(`unityfs: ${c.name}`, () => {
    const files = bundleFiles();
    const buf = buildUnityFs({ ...c.opts, files });
    assert.ok(isUnityFs(buf));
    const b = parseUnityFs(buf);
    assert.equal(b.unityRevision, '2019.4.31f1');
    assert.deepEqual(b.files.map((f) => f.path), ['CAB-1', 'CAB-1.resS']);
    assert.deepEqual(b.files[0].data, files[0].data);
    assert.deepEqual(b.files[1].data, files[1].data);
    assert.equal(new SerializedFile(b.files[0].data).objects.length, 3);
  });
}

test('unityfs: truncated and corrupt bundles throw', () => {
  const buf = buildUnityFs({ compression: 'lz4', files: bundleFiles() });
  assert.throws(() => parseUnityFs(buf.subarray(0, buf.length - 40)));
  assert.throws(() => parseUnityFs(buf.subarray(0, 30)));
  const bad = Buffer.from(buf);
  bad.writeUInt32BE(0xffffffff, bad.indexOf(Buffer.from('2019.4.31f1')) + 12 + 8); // compressed info size
  assert.throws(() => parseUnityFs(bad));
});

test('type tree reader refuses arrays of zero-width elements (cheap DoS guard)', () => {
  const emptyStructArray = [
    ...[{ level: 0, type: 'Evil', name: 'Base', metaFlags: 0 }, { level: 1, type: 'vector', name: 'm_Items', metaFlags: 0 },
      { level: 2, type: 'Array', name: 'Array', metaFlags: 0 }, { level: 3, type: 'int', name: 'size', metaFlags: 0 },
      { level: 3, type: 'Empty', name: 'data', metaFlags: 0 }],
  ];
  const tree = new TypeTree(parseTypeTreeBlob(new BinaryReader(typeTreeBlob(emptyStructArray, 19), 0, true), 19));
  const body = Buffer.concat([new Writer(true).i32(1_000_000).toBuffer(), Buffer.alloc(2_000_000)]);
  assert.throws(() => tree.read(body), /zero-width/);
  assert.deepEqual(tree.read(Buffer.concat([new Writer(true).i32(1).toBuffer(), Buffer.alloc(4)])), { m_Items: [{}] }, 'a single empty element is still legal');
});
