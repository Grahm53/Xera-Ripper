// A small but structurally realistic game, built from the engine's REAL layouts (type-tree database) with type trees stripped,
// like a shipped player build: a scene with a GameObject hierarchy referencing a material in another file, plus a prefab bundle
// whose AssetBundle container supplies original asset paths.
import { mkdirSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultTypeDatabase } from '../../src/tpk.js';
import { buildSerializedFile, buildUnityFs } from './builders.js';
import { defaultValue, mergeDeep, serializeObject } from './treeWriter.js';

export const UNITY = '2019.4.31f1';
const db = defaultTypeDatabase();
const tree = (id) => db.treeFor(id, UNITY);
const ptr = (pathId, fileId = 0) => ({ m_FileID: fileId, m_PathID: pathId });
const obj = (classId, over) => serializeObject(tree(classId), mergeDeep(defaultValue(tree(classId)), over));

export function makeProjectGame() {
  const root = mkdtempSync(join(tmpdir(), 'xera-proj-'));
  const data = join(root, 'Game_Data');
  mkdirSync(data, { recursive: true });
  const type = (classId) => ({ classId, tree: null });

  // ---- sharedassets0.assets: material -> texture, plus a text asset
  const shared = buildSerializedFile({
    version: 19, unityVersion: UNITY, enableTypeTree: false,
    types: [type(21), type(28), type(49)],
    objects: [
      {
        pathId: 1, typeIndex: 0, data: obj(21, {
          m_Name: 'Wall', m_Shader: ptr(0),
          m_SavedProperties: {
            m_TexEnvs: [{ first: '_MainTex', second: { m_Texture: ptr(2), m_Scale: { x: 1, y: 1 }, m_Offset: { x: 0, y: 0 } } }],
            m_Floats: [{ first: '_Glossiness', second: 0.5 }], m_Colors: [{ first: '_Color', second: { r: 1, g: 0.5, b: 0.25, a: 1 } }],
          },
        }),
      },
      {
        pathId: 2, typeIndex: 1, data: obj(28, {
          m_Name: 'Albedo', m_Width: 2, m_Height: 2, m_TextureFormat: 4, m_CompleteImageSize: 16, m_MipCount: 1, m_ColorSpace: 1,
          'image data': Buffer.from([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255]),
          m_TextureSettings: { m_FilterMode: 2, m_Aniso: 4, m_WrapU: 1, m_WrapV: 1, m_WrapW: 1 },
        }),
      },
      { pathId: 3, typeIndex: 2, data: obj(49, { m_Name: 'Notes', m_Script: 'level notes' }) },
    ],
  });
  writeFileSync(join(data, 'sharedassets0.assets'), shared);

  // ---- level1: a scene. Cube(10) { Transform 11, MeshRenderer 12 -> Wall material in sharedassets0, MonoBehaviour 15 }, child Child(13){Transform 14}
  const level = buildSerializedFile({
    version: 19, unityVersion: UNITY, enableTypeTree: false, externals: ['Library/unity default resources', 'sharedassets0.assets'],
    types: [type(1), type(4), type(23), type(114), type(104)],
    objects: [
      { pathId: 10, typeIndex: 0, data: obj(1, { m_Name: 'Cube', m_IsActive: true, m_Layer: 3, m_Tag: 5, m_Component: [{ component: ptr(11) }, { component: ptr(12) }, { component: ptr(15) }] }) },
      { pathId: 11, typeIndex: 1, data: obj(4, { m_GameObject: ptr(10), m_LocalRotation: { x: 0, y: 0, z: 0, w: 1 }, m_LocalPosition: { x: 1, y: 2, z: 3 }, m_LocalScale: { x: 1, y: 1, z: 1 }, m_Children: [ptr(14)], m_Father: ptr(0) }) },
      { pathId: 12, typeIndex: 2, data: obj(23, { m_GameObject: ptr(10), m_Enabled: true, m_Materials: [ptr(1, 2), ptr(5, 1)] }) }, // wall material (file 2), a built-in (file 1)
      { pathId: 13, typeIndex: 0, data: obj(1, { m_Name: 'Child', m_IsActive: true, m_Component: [{ component: ptr(14) }] }) },
      { pathId: 14, typeIndex: 1, data: obj(4, { m_GameObject: ptr(13), m_LocalRotation: { x: 0, y: 0, z: 0, w: 1 }, m_LocalScale: { x: 1, y: 1, z: 1 }, m_Children: [], m_Father: ptr(11) }) },
      { pathId: 15, typeIndex: 3, data: obj(114, { m_GameObject: ptr(10), m_Enabled: true, m_Name: '' }) },
      { pathId: 16, typeIndex: 4, data: obj(104, {}) },
    ],
  });
  writeFileSync(join(data, 'level1'), level);

  // ---- prefabs.bundle: AssetBundle manifest + prefab 'Hero' (GO 20, Transform 21) + a material, with original paths
  const inner = buildSerializedFile({
    version: 19, unityVersion: UNITY, enableTypeTree: false,
    types: [type(142), type(1), type(4), type(21)],
    objects: [
      {
        pathId: 1, typeIndex: 0, data: obj(142, {
          m_Name: 'prefabs',
          m_Container: [
            { first: 'assets/prefabs/hero.prefab', second: { preloadIndex: 0, preloadSize: 2, asset: ptr(20) } },
            { first: 'assets/materials/hero.mat', second: { preloadIndex: 2, preloadSize: 1, asset: ptr(30) } },
          ],
        }),
      },
      { pathId: 20, typeIndex: 1, data: obj(1, { m_Name: 'Hero', m_IsActive: true, m_Component: [{ component: ptr(21) }] }) },
      { pathId: 21, typeIndex: 2, data: obj(4, { m_GameObject: ptr(20), m_LocalRotation: { x: 0, y: 0, z: 0, w: 1 }, m_LocalScale: { x: 2, y: 2, z: 2 }, m_Children: [], m_Father: ptr(0) }) },
      { pathId: 30, typeIndex: 3, data: obj(21, { m_Name: 'HeroMat', m_Shader: ptr(0) }) },
    ],
  });
  writeFileSync(join(data, 'prefabs.bundle'), buildUnityFs({
    revision: UNITY, compression: 'lz4', blockSize: 128, files: [{ path: 'CAB-hero', data: inner, serialized: true }],
  }));

  // ---- globalgamemanagers: must be skipped as settings
  writeFileSync(join(data, 'globalgamemanagers'), buildSerializedFile({
    version: 19, unityVersion: UNITY, enableTypeTree: false, types: [type(49)],
    objects: [{ pathId: 1, typeIndex: 0, data: obj(49, { m_Name: 'x', m_Script: '' }) }],
  }));
  return root;
}
