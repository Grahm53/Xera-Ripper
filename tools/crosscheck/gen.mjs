// Writes a corpus of synthetic Unity files (built by the test builders) for an INDEPENDENT reader to open.
import { writeFileSync, mkdirSync } from 'node:fs';
import {
  Writer, GENERIC_TREE, buildSerializedFile, buildUnityFs, texture2DData, textAssetData, audioClipData,
  TEXTURE2D_TREE, TEXTASSET_TREE, AUDIOCLIP_TREE,
} from '../../test/helpers/builders.js';

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
