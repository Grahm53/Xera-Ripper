// Builds a realistic game folder in a temp dir: a bundle with streamed resources, loose levels, a stripped file, junk.
import { mkdirSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildSerializedFile, buildUnityFs, texture2DData, textAssetData, audioClipData,
  TEXTURE2D_TREE, TEXTASSET_TREE, AUDIOCLIP_TREE,
} from './builders.js';

export const TYPES = [{ classId: 28, tree: TEXTURE2D_TREE }, { classId: 49, tree: TEXTASSET_TREE }, { classId: 83, tree: AUDIOCLIP_TREE }];

// 4x4 DXT1 block: left half red, right half blue
export const DXT1_BLOCK = Buffer.concat([Buffer.from([0x00, 0xf8, 0x1f, 0x00]), Buffer.from([0x44, 0x44, 0x44, 0x44])]);
export const OGG = Buffer.concat([Buffer.from('OggS'), Buffer.alloc(60, 3)]);

export function makeGameDir() {
  const root = mkdtempSync(join(tmpdir(), 'xera-ripper-'));
  const data = join(root, 'Game_Data');
  mkdirSync(data, { recursive: true });

  // resS: DXT1 texture at offset 0 (8 bytes), ogg at offset 16
  const res = Buffer.alloc(16 + OGG.length);
  DXT1_BLOCK.copy(res, 0);
  OGG.copy(res, 16);

  const inBundle = buildSerializedFile({
    version: 19, types: TYPES,
    objects: [
      { pathId: 1, typeIndex: 0, data: texture2DData({ name: 'Hero', width: 2, height: 2, format: 4, image: Buffer.from([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255]) }) },
      { pathId: 2, typeIndex: 0, data: texture2DData({ name: 'Streamed', width: 4, height: 4, format: 10, stream: { offset: 0, size: 8, path: 'archive:/CAB-abc/CAB-abc.resS' } }) },
      { pathId: 3, typeIndex: 0, data: texture2DData({ name: 'AstcTex', width: 4, height: 4, format: 50, image: Buffer.alloc(16, 5) }) },
      { pathId: 4, typeIndex: 1, data: textAssetData('../../evil', 'owned? no.') },
      { pathId: 5, typeIndex: 2, data: audioClipData({ name: 'Boom', source: 'archive:/CAB-abc/CAB-abc.resS', offset: 16, size: OGG.length }) },
    ],
  });
  const bundle = buildUnityFs({
    compression: 'lz4', infoCompression: 'lz4', blockSize: 48,
    files: [{ path: 'CAB-abc', data: inBundle, serialized: true }, { path: 'CAB-abc.resS', data: res }],
  });
  writeFileSync(join(data, 'scene.unity3d'), bundle);

  // loose level + sibling .resS, resolved by basename
  const level = buildSerializedFile({
    version: 22, types: TYPES,
    objects: [
      { pathId: 10, typeIndex: 0, data: texture2DData({ name: 'LooseDxt', width: 4, height: 4, format: 10, stream: { offset: 0, size: 8, path: 'archive:/x/level0.resS' } }) },
      { pathId: 11, typeIndex: 1, data: Buffer.concat([textAssetData('binary', Buffer.from([0, 1, 2, 255, 254]))]) },
    ],
  });
  writeFileSync(join(data, 'level0'), level);
  writeFileSync(join(data, 'level0.resS'), DXT1_BLOCK);

  // release-style file with its type trees stripped
  const stripped = buildSerializedFile({
    version: 19, enableTypeTree: false, types: TYPES,
    objects: [{ pathId: 20, typeIndex: 0, data: texture2DData({ name: 'Hidden', width: 1, height: 1, format: 4, image: Buffer.alloc(4) }) }],
  });
  writeFileSync(join(data, 'sharedassets0.assets'), stripped);

  // things the scanner must ignore or survive
  writeFileSync(join(root, 'readme.txt'), 'hello');
  writeFileSync(join(data, 'libfoo.so'), Buffer.alloc(100, 1));
  writeFileSync(join(data, 'corrupt.bundle'), Buffer.concat([bundle.subarray(0, 60), Buffer.alloc(80)]));
  return root;
}
