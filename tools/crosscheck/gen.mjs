// Writes a corpus of synthetic Unity files (built by the test builders) for an INDEPENDENT reader to open.
import { writeFileSync, mkdirSync } from 'node:fs';
import {
  Writer, GENERIC_TREE, buildSerializedFile, buildUnityFs, texture2DData, textAssetData, audioClipData,
  TEXTURE2D_TREE, TEXTASSET_TREE, AUDIOCLIP_TREE,
} from '../../test/helpers/builders.js';
import { defaultTypeDatabase } from '../../src/tpk.js';
import { randomValue, serializeObject, rng } from '../../test/helpers/treeWriter.js';

const out = process.argv[2];
if (!out) { console.error('usage: node gen.mjs <outdir>'); process.exit(1); }
mkdirSync(out, { recursive: true });

const TYPES = [{ classId: 28, tree: TEXTURE2D_TREE }, { classId: 49, tree: TEXTASSET_TREE }, { classId: 83, tree: AUDIOCLIP_TREE }];
const img = Buffer.from([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 128]);
const objects = () => [
  { pathId: 1, typeIndex: 0, data: texture2DData({ name: 'Hero', width: 2, height: 2, format: 4, image: img }) },
  { pathId: 2, typeIndex: 1, data: textAssetData('config', 'hello world') },
  { pathId: 3, typeIndex: 2, data: audioClipData({ name: 'boom', source: 'archive:/CAB-1/CAB-1.resS', offset: 0, size: 4 }) },
];
for (const version of [17, 19, 21, 22]) writeFileSync(`${out}/ser_v${version}.assets`, buildSerializedFile({ version, types: TYPES, objects: objects() }));

const sf = buildSerializedFile({ version: 19, types: TYPES, objects: objects() });
const bundles = {
  fs_stored: {}, fs_lz4: { compression: 'lz4' }, fs_lz4_info: { compression: 'lz4', infoCompression: 'lz4' },
  fs_end: { compression: 'lz4', infoAtEnd: true },
  fs_v6_2019: { version: 6, revision: '2019.4.31f1', alignHeader: true, compression: 'lz4' },
  fs_v6_old: { version: 6, revision: '2018.4.20f1', alignHeader: false, compression: 'lz4' },
  fs_pad: { revision: '2021.3.10f1', compression: 'lz4', pad: true },
};
for (const [name, opts] of Object.entries(bundles)) {
  writeFileSync(`${out}/${name}.bundle`, buildUnityFs({ ...opts, blockSize: 40, files: [{ path: 'CAB-1', data: sf, serialized: true }, { path: 'CAB-1.resS', data: Buffer.from('OggS') }] }));
}

// real AssetBundles use hashed 64-bit path IDs
const HASHED = [-6291524532174903347n, 9223372036854775807n, -9223372036854775808n, 5821097400184312345n];
for (const version of [17, 19, 22]) {
  writeFileSync(`${out}/bigid_v${version}.assets`, buildSerializedFile({
    version, types: TYPES,
    objects: [
      { pathId: HASHED[0], typeIndex: 1, data: textAssetData('a', 'first') },
      { pathId: HASHED[1], typeIndex: 1, data: textAssetData('b', 'second') },
      { pathId: HASHED[2], typeIndex: 1, data: textAssetData('c', 'third') },
      { pathId: HASHED[3], typeIndex: 0, data: texture2DData({ name: 'T', width: 2, height: 2, format: 4, image: img }) },
    ],
  }));
}

function generic(little) {
  const w = new Writer(little);
  w.i32(3).i32(10).i32(-20).i32(30);
  w.i32(2).string('alpha').i32(1).string('be').i32(2);
  w.f32(1.5).f32(-2).f32(0.25);
  w.i32(5).bytes([1, 2, 3, 4, 5]).align(4);
  w.u8(1).align(4);
  w.i32(0x1234);
  return w.toBuffer();
}
for (const little of [true, false]) {
  for (const version of [17, 19, 22]) {
    writeFileSync(`${out}/gen_${little ? 'le' : 'be'}_v${version}.assets`, buildSerializedFile({
      version, little,
      types: [{ classId: 114, tree: GENERIC_TREE }, { classId: 49, tree: TEXTASSET_TREE }],
      objects: [{ pathId: 5, typeIndex: 0, data: generic(little) }, { pathId: -9, typeIndex: 1, data: textAssetData('t', 'héllo wörld ✓', little) }],
    }));
  }
}

// Stripped files (no embedded type trees) with REAL engine layouts, one randomised object per class, for several Unity
// versions. The independent reader decodes these with its own copy of the type-tree database.
const db = defaultTypeDatabase();
const CLASSES = [28, 49, 83, 43, 21, 74, 1, 4, 224, 142, 213, 48, 128, 23, 137, 95, 82, 20, 108, 198, 114, 223];
const SERIALIZED_VERSION = { 2017: 17, 2018: 17, 2019: 19, 2020: 21, 2021: 22, 2022: 22, 6000: 22 };
for (const unityVersion of ['2017.4.40f1', '2018.4.36f1', '2019.4.31f1', '2020.3.48f1', '2021.3.10f1', '2022.3.20f1', '6000.0.23f1']) {
  const objs = [];
  const types = [];
  for (const id of CLASSES) {
    const tree = db.treeFor(id, unityVersion);
    if (!tree) continue;
    types.push({ classId: id, tree: null });
    objs.push({ pathId: 100 + id, typeIndex: types.length - 1, data: serializeObject(tree, randomValue(tree, rng(id * 7 + 1))) });
  }
  writeFileSync(`${out}/db_${unityVersion}.assets`, buildSerializedFile({
    version: SERIALIZED_VERSION[Number(unityVersion.split('.')[0])], unityVersion, enableTypeTree: false, types, objects: objs,
  }));
}
