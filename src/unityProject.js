// Unity project exporter: turns the objects of a Session into an Assets/ folder that the Unity editor can open.
//
//   textures   -> .png            (+ .meta with import settings)
//   TextAsset  -> .txt/.bytes/... (+ .meta)
//   AudioClip  -> .ogg/.wav/.mp3  (FMOD .fsb banks cannot be imported by Unity and are reported instead)
//   scenes     -> .unity          (a file that holds GameObjects but is not an asset bundle)
//   prefabs    -> .prefab         (hierarchies found in asset bundles)
//   all other classes that can be decoded -> text-serialised .asset/.mat/.anim ... (best effort, see README)
//
// Every exported asset gets a deterministic GUID; references between objects (PPtr) are rewritten to the Unity
// `{fileID, guid, type}` form so the exported assets point at each other.

import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, isAbsolute } from 'node:path';
import { defaultTypeDatabase } from './tpk.js';
import { toEditorValue, UnityYamlWriter, YAML_HEADER } from './unityYaml.js';
import { buildExport, canExport } from './exporters.js';
import { NoTypeTreeError } from './serializedFile.js';
import { safeSegment } from './names.js';

const BUILTIN_GUID = {
  'default resources': '0000000000000000e000000000000000',
  'builtin extra': '0000000000000000f000000000000000',
};
// Native class -> file extension Unity expects for a single-object asset of that class.
const EXTENSIONS = { 21: 'mat', 74: 'anim', 134: 'physicMaterial', 62: 'physicsMaterial2D', 91: 'controller', 221: 'overrideController' };
// Classes that are never exported as stand-alone assets, with the reason shown in the report.
const NOT_EXPORTED = {
  48: 'compiled shader (platform bytecode; ShaderLab source cannot be recovered)',
  72: 'compiled compute shader',
  115: 'MonoScript (scripts are not decompiled)',
  142: 'AssetBundle manifest (used to recover names and paths)',
  147: 'ResourceManager (used to recover Resources paths)',
  150: 'PreloadData',
  141: 'BuildSettings',
  290: 'AssetBundleManifest',
};
const MANAGER_FILE = /(^|\/)(globalgamemanagers(\.assets)?|unity default resources|unity_builtin_extra)$/i;
export const TAGS = { 0: 'Untagged', 1: 'Respawn', 2: 'Finish', 3: 'EditorOnly', 5: 'MainCamera', 6: 'Player', 7: 'GameController' };
const FALLBACK_SCENE_CLASSES = new Set([
  1, 4, 224, 20, 23, 33, 54, 64, 65, 108, 81, 82, 95, 111, 114, 135, 136, 137, 198, 199, 212, 222, 223, 225, 120, 96, 104, 157, 29, 196,
]);

const baseName = (p) => String(p).slice(String(p).lastIndexOf('/') + 1);
const guidFor = (...parts) => createHash('md5').update(`xera-ripper:${parts.join(':')}`).digest('hex');

class UnionFind {
  constructor() { this.p = new Map(); }
  find(x) {
    if (!this.p.has(x)) this.p.set(x, x);
    let r = x;
    while (this.p.get(r) !== r) r = this.p.get(r);
    for (let c = x; c !== r;) { const n = this.p.get(c); this.p.set(c, r); c = n; }
    return r;
  }
  union(a, b) { this.p.set(this.find(a), this.find(b)); }
}

export function unityMajor(version) {
  const m = /^(\d+)\./.exec(version ?? '');
  return m ? Number(m[1]) : 0;
}

function metaGuidOnly(guid) { return `fileFormatVersion: 2\nguid: ${guid}\n`; }

// TextureImporter block (Unity 2019+ layout, serializedVersion 11). Older editors get a guid-only meta and default settings.
function textureMeta(guid, tex, unityVersion) {
  if (unityMajor(unityVersion) < 2019) return metaGuidOnly(guid);
  const ts = tex.m_TextureSettings ?? {};
  const num = (v, d) => (typeof v === 'number' ? v : d);
  return `${metaGuidOnly(guid)}TextureImporter:
  internalIDToNameTable: []
  externalObjects: {}
  serializedVersion: 11
  mipmaps:
    mipMapMode: 0
    enableMipMap: ${num(tex.m_MipCount, 1) > 1 ? 1 : 0}
    sRGBTexture: ${num(tex.m_ColorSpace, 1) === 1 ? 1 : 0}
    linearTexture: 0
    fadeOut: 0
    borderMipMap: 0
    mipMapsPreserveCoverage: 0
    alphaTestReferenceValue: 0.5
    mipMapFadeDistanceStart: 1
    mipMapFadeDistanceEnd: 3
  isReadable: ${tex.m_IsReadable ? 1 : 0}
  streamingMipmaps: 0
  textureSettings:
    serializedVersion: 2
    filterMode: ${num(ts.m_FilterMode, 1)}
    aniso: ${num(ts.m_Aniso, 1)}
    mipBias: ${num(ts.m_MipBias, 0)}
    wrapU: ${num(ts.m_WrapU, 0)}
    wrapV: ${num(ts.m_WrapV, 0)}
    wrapW: ${num(ts.m_WrapW, 0)}
  alphaUsage: 1
  alphaIsTransparency: 0
  textureType: 0
  spriteMode: 0
  userData:
  assetBundleName:
  assetBundleVariant:
`;
}

export class ProjectExporter {
  constructor(session, { outDir, onProgress = null, projectName = 'ExportedProject', include = {} } = {}) {
    if (!outDir) throw new Error('outDir is required');
    this.session = session;
    // export settings: every kind is on unless switched off
    this.include = { textures: true, text: true, audio: true, scenes: true, prefabs: true, assets: true, ...include };
    this.root = resolve(outDir, projectName);
    this.onProgress = onProgress;
    this.db = defaultTypeDatabase();
    this.report = {
      projectDir: this.root, unityVersion: '', counts: {}, written: 0, scenes: 0, prefabs: 0, yamlAssets: 0, textures: 0, text: 0, audio: 0,
      skipped: [], skippedByReason: {},
    };
    this.usedPaths = new Set();
    this.refs = new Map();      // "fileIndex:pathId" -> { guid, fileID, type, group }
    this.values = new Map();    // asset id -> decoded runtime value
    this.containerPath = new Map();
    this.fileByBase = new Map();
  }

  // ---- helpers ----------------------------------------------------------------------------------------------------
  _skip(asset, reason) {
    this.report.skipped.push({ id: asset.id, type: asset.className, name: asset.name, reason });
    this.report.skippedByReason[reason] = (this.report.skippedByReason[reason] ?? 0) + 1;
  }

  _count(cls) { this.report.counts[cls] = (this.report.counts[cls] ?? 0) + 1; }

  _write(rel, data) {
    const full = resolve(this.root, rel);
    const check = relative(this.root, full);
    if (check.startsWith('..') || isAbsolute(check)) throw new Error('refusing to write outside the project folder');
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, data);
    this.report.written++;
  }

  // A project-relative path that nothing else has claimed (case-insensitively, as Unity requires).
  _claim(path) {
    let candidate = path;
    const dot = path.lastIndexOf('.');
    const stem = dot > path.lastIndexOf('/') ? path.slice(0, dot) : path;
    const ext = dot > path.lastIndexOf('/') ? path.slice(dot) : '';
    for (let n = 2; this.usedPaths.has(candidate.toLowerCase()); n++) candidate = `${stem}_${n}${ext}`;
    this.usedPaths.add(candidate.toLowerCase());
    return candidate;
  }

  _assetPath(fileLabel, className, name, pathId, ext, containerPath) {
    if (containerPath) {
      const parts = String(containerPath).replace(/\\/g, '/').split('/').filter(Boolean).map(safeSegment);
      if (parts[0]?.toLowerCase() !== 'assets') parts.unshift('Assets');
      else parts[0] = 'Assets';
      const last = parts[parts.length - 1];
      const dot = last.lastIndexOf('.');
      if (ext && (dot < 0 || last.slice(dot + 1).toLowerCase() !== ext.toLowerCase())) parts[parts.length - 1] = `${dot > 0 ? last.slice(0, dot) : last}.${ext}`;
      return this._claim(parts.join('/'));
    }
    const fileDir = fileLabel.split('/').map(safeSegment).join('/');
    return this._claim(`Assets/${fileDir}/${className}/${safeSegment(name || `${className}_${pathId}`)}${ext ? `.${ext}` : ''}`);
  }

  _isSceneClass(classId, unityVersion) {
    if (classId === 1) return true;
    if (this.db) {
      const chain = this.db.ancestry(classId, unityVersion);
      if (chain.length) return chain.includes('Component') || chain.includes('LevelGameManager');
    }
    return FALLBACK_SCENE_CLASSES.has(classId);
  }

  _readValue(asset) {
    if (this.values.has(asset.id)) return this.values.get(asset.id);
    const file = this.session.files[asset.fileIndex];
    const v = file.sf.readObject(asset.obj);
    this.values.set(asset.id, v);
    return v;
  }

  // Map an external-file reference of `file` to the loaded file it names.
  _externalFile(file, fileId) {
    const ext = file.sf.externals[fileId - 1];
    if (ext === undefined) return null;
    const low = String(ext).toLowerCase();
    if (low.includes('unity default resources')) return { builtin: 'default resources' };
    if (low.includes('unity_builtin_extra')) return { builtin: 'builtin extra' };
    const idx = this.fileByBase.get(baseName(low));
    return idx === undefined ? null : { index: idx };
  }

  _pptrTarget(file, ref) {
    if (!ref || String(ref.m_PathID) === '0') return null;
    const fid = Number(ref.m_FileID ?? 0);
    if (fid === 0) return { index: file.index, pathId: ref.m_PathID };
    const ext = this._externalFile(file, fid);
    if (!ext) return null;
    return ext.builtin ? { builtin: ext.builtin, pathId: ref.m_PathID } : { index: ext.index, pathId: ref.m_PathID };
  }

  _resolver(file, group) {
    return (fileId, pathId) => {
      const t = this._pptrTarget(file, { m_FileID: fileId, m_PathID: pathId });
      if (!t) return null;
      if (t.builtin) return { fileID: t.pathId, guid: BUILTIN_GUID[t.builtin], type: 0 };
      const dest = this.refs.get(`${t.index}:${t.pathId}`);
      if (!dest) return null;
      if (group && dest.group === group) return { fileID: t.pathId };
      return dest.guid ? { fileID: dest.fileID, guid: dest.guid, type: dest.type } : null;
    };
  }

  // ---- main ---------------------------------------------------------------------------------------------------------
  run() {
    const s = this.session;
    if (!s.loaded) throw new Error('nothing is loaded');
    const t0 = Date.now();
    for (const f of s.files) this.fileByBase.set(baseName(f.name).toLowerCase(), f.index);
    this.report.unityVersion = s.files.find((f) => f.sf.unityVersion)?.sf.unityVersion ?? '';

    this._collectContainers();

    const byFile = new Map();
    for (const a of s.assets) {
      if (!byFile.has(a.fileIndex)) byFile.set(a.fileIndex, []);
      byFile.get(a.fileIndex).push(a);
    }

    const pending = []; // { file, assets, kind }
    for (const [fi, assets] of byFile) {
      const file = s.files[fi];
      const version = file.sf.unityVersion;
      if (MANAGER_FILE.test(file.name)) {
        for (const a of assets) { this._count(a.className); this._skip(a, 'project/player settings (not exported yet)'); }
        continue;
      }
      const sceneish = [];
      const rest = [];
      for (const a of assets) (this._isSceneClass(a.obj.classId, version) ? sceneish : rest).push(a);
      for (const a of rest) this._exportStandalone(file, a);
      if (sceneish.length) pending.push({ file, sceneish });
    }
    for (const p of pending) this._exportHierarchy(p.file, p.sceneish);

    this._writeProjectFiles();
    this.report.ms = Date.now() - t0;
    this._writeReport();
    return this.report;
  }

  // m_Container (AssetBundle) and ResourceManager give original asset paths for objects.
  _collectContainers() {
    for (const a of this.session.assets) {
      if (a.obj.classId !== 142 && a.obj.classId !== 147) continue;
      const file = this.session.files[a.fileIndex];
      let v;
      try { v = this._readValue(a); } catch { continue; }
      const entries = Array.isArray(v.m_Container) ? v.m_Container : [];
      for (const e of entries) {
        if (!e || typeof e.first !== 'string') continue;
        const ref = a.obj.classId === 142 ? e.second?.asset : e.second;
        const t = this._pptrTarget(file, ref);
        if (!t || t.builtin) continue;
        const key = `${t.index}:${t.pathId}`;
        if (!this.containerPath.has(key)) {
          this.containerPath.set(key, a.obj.classId === 147 ? `Assets/Resources/${e.first}` : e.first);
        }
      }
      if (a.obj.classId === 142 && v.m_IsStreamedSceneAssetBundle) file.isSceneBundle = true;
    }
  }

  _exportStandalone(file, a) {
    const cls = a.className;
    this._count(cls);
    const version = file.sf.unityVersion;
    const key = `${file.index}:${a.pathId}`;
    const containerPath = this.containerPath.get(key);
    if (NOT_EXPORTED[a.obj.classId]) { this._skip(a, NOT_EXPORTED[a.obj.classId]); return; }
    const kind = cls === 'Texture2D' ? 'textures' : cls === 'TextAsset' ? 'text' : cls === 'AudioClip' ? 'audio' : 'assets';
    if (!this.include[kind]) { this._skip(a, 'turned off in the export settings'); return; }

    try {
      if (canExport(cls)) {
        const e = buildExport(file, a);
        if (e.status === 'raw') {
          this._skip(a, e.note?.startsWith('texture format') ? `${e.note} (Unity needs a decoded PNG)` : (e.note ?? 'raw data only'));
          return;
        }
        const path = this._assetPath(file.name, cls, a.name, a.pathId, e.ext, containerPath);
        const guid = guidFor(file.name, a.pathId);
        this._write(path, e.data);
        if (cls === 'Texture2D') {
          this._write(`${path}.meta`, textureMeta(guid, this._readValue(a), version));
          this.report.textures++;
          this.refs.set(key, { guid, fileID: 2800000, type: 3 });
        } else {
          this._write(`${path}.meta`, metaGuidOnly(guid));
          if (cls === 'TextAsset') { this.report.text++; this.refs.set(key, { guid, fileID: 4900000, type: 3 }); }
          else { this.report.audio++; this.refs.set(key, { guid, fileID: 8300000, type: 3 }); }
        }
        return;
      }
      // everything else: text-serialised native asset
      this._readValue(a); // fail early (and clearly) if it cannot be decoded
      const ext = EXTENSIONS[a.obj.classId] ?? 'asset';
      const path = this._assetPath(file.name, cls, a.name, a.pathId, ext, containerPath);
      const guid = guidFor(file.name, a.pathId);
      const fileID = a.obj.classId * 100000;
      // reserve the reference now; the document itself is written after all stand-alone assets exist (second pass below)
      this.refs.set(key, { guid, fileID, type: 2, group: `asset:${key}` });
      (this._yamlQueue ??= []).push({ file, a, path, guid, fileID });
    } catch (err) {
      this._skip(a, err instanceof NoTypeTreeError ? 'fields cannot be decoded (no usable type tree)' : `error: ${err.message}`);
    }
  }

  _flushYamlAssets() {
    for (const { file, a, path, guid, fileID } of this._yamlQueue ?? []) {
      try {
        const group = `asset:${file.index}:${a.pathId}`;
        const doc = this._document(file, a, fileID, group);
        this._write(path, `${YAML_HEADER}${doc}`);
        this._write(`${path}.meta`, metaGuidOnly(guid));
        this.report.yamlAssets++;
      } catch (err) {
        this.refs.delete(`${file.index}:${a.pathId}`);
        this._skip(a, `error: ${err.message}`);
      }
    }
    this._yamlQueue = [];
  }

  // One YAML document (editor layout when the database has it) for a decoded object.
  _document(file, a, fileID, group) {
    const version = file.sf.unityVersion;
    const classId = a.obj.classId;
    const runtimeValue = this._readValue(a);
    if (classId === 1 && typeof runtimeValue.m_Tag === 'number') runtimeValue.m_TagString = TAGS[runtimeValue.m_Tag] ?? 'Untagged';
    const resolver = this._resolver(file, group);
    const editor = this.db?.editorTreeFor(classId, version);
    if (editor) return new UnityYamlWriter(editor, resolver).document(classId, fileID, toEditorValue(editor, runtimeValue));
    const found = file.sf.treeFor(a.obj);
    return new UnityYamlWriter(found.tree, resolver).document(classId, fileID, runtimeValue);
  }

  // GameObjects, components and scene settings of one serialized file: a scene, or one prefab per hierarchy.
  _exportHierarchy(file, objs) {
    // Decode everything first; objects that cannot be decoded are reported and left out.
    const ok = [];
    for (const a of objs) {
      this._count(a.className);
      try { this._readValue(a); ok.push(a); } catch (err) { this._skip(a, err instanceof NoTypeTreeError ? 'fields cannot be decoded (no usable type tree)' : `error: ${err.message}`); }
    }
    if (!ok.length) return;
    const isBundle = file.sf.objects.some((o) => o.classId === 142);
    const asScene = !isBundle || file.isSceneBundle;
    const label = baseName(file.name);
    if (!this.include[asScene ? 'scenes' : 'prefabs']) { for (const a of ok) this._skip(a, 'turned off in the export settings'); return; }

    if (asScene) {
      const group = `scene:${file.index}`;
      const sceneName = (() => {
        for (const [k, p] of this.containerPath) if (k.startsWith(`${file.index}:`) && /\.unity$/i.test(p)) return p;
        return null;
      })();
      const path = sceneName ? this._assetPath(file.name, 'Scene', label, 0, 'unity', sceneName) : this._claim(`Assets/Scenes/${safeSegment(label)}.unity`);
      const guid = guidFor('scene', file.name);
      for (const a of ok) this.refs.set(`${file.index}:${a.pathId}`, { guid, fileID: a.pathId, type: 3, group });
      this._emitGroup(file, ok, group, path, guid, 'scene');
      return;
    }

    // prefab bundle: group by hierarchy links
    const uf = new UnionFind();
    const present = new Set(ok.map((a) => String(a.pathId)));
    const link = (a, b) => { if (present.has(String(b))) uf.union(String(a), String(b)); };
    for (const a of ok) {
      const v = this.values.get(a.id);
      uf.find(String(a.pathId));
      if (v.m_GameObject?.m_PathID !== undefined && String(v.m_GameObject.m_PathID) !== '0' && Number(v.m_GameObject.m_FileID) === 0) link(a.pathId, v.m_GameObject.m_PathID);
      if (a.obj.classId === 1 && Array.isArray(v.m_Component)) {
        for (const c of v.m_Component) { const r = c.component ?? c.second; if (r && Number(r.m_FileID) === 0) link(a.pathId, r.m_PathID); }
      }
      if (v.m_Father && Number(v.m_Father.m_FileID) === 0 && String(v.m_Father.m_PathID) !== '0') link(a.pathId, v.m_Father.m_PathID);
      if (Array.isArray(v.m_Children)) for (const c of v.m_Children) if (Number(c.m_FileID) === 0) link(a.pathId, c.m_PathID);
    }
    const groups = new Map();
    for (const a of ok) {
      const root = uf.find(String(a.pathId));
      if (!groups.has(root)) groups.set(root, []);
      groups.get(root).push(a);
    }
    for (const [root, members] of groups) {
      if (!members.some((m) => m.obj.classId === 1)) { for (const m of members) this._skip(m, 'component without a GameObject (not part of a hierarchy)'); continue; }
      const group = `prefab:${file.index}:${root}`;
      // name: the GameObject whose Transform has no parent
      let rootGo = null;
      for (const m of members) {
        const v = this.values.get(m.id);
        if (v.m_Father && String(v.m_Father.m_PathID) === '0' && v.m_GameObject) { rootGo = members.find((x) => String(x.pathId) === String(v.m_GameObject.m_PathID)) ?? null; break; }
      }
      rootGo ??= members.find((m) => m.obj.classId === 1);
      const path = this._assetPath(file.name, 'Prefabs', rootGo.name, rootGo.pathId, 'prefab', this.containerPath.get(`${file.index}:${rootGo.pathId}`));
      const guid = guidFor('prefab', file.name, rootGo.pathId);
      for (const m of members) this.refs.set(`${file.index}:${m.pathId}`, { guid, fileID: m.pathId, type: 3, group });
      this._emitGroup(file, members, group, path, guid, 'prefab');
    }
  }

  _emitGroup(file, members, group, path, guid, kind) {
    this._pendingGroups ??= [];
    this._pendingGroups.push({ file, members, group, path, guid, kind });
  }

  _flushGroups() {
    for (const { file, members, group, path, guid, kind } of this._pendingGroups ?? []) {
      const docs = [];
      for (const a of members) {
        try { docs.push(this._document(file, a, a.pathId, group)); } catch (err) { this._skip(a, `error: ${err.message}`); }
      }
      if (!docs.length) continue;
      this._write(path, YAML_HEADER + docs.join(''));
      this._write(`${path}.meta`, metaGuidOnly(guid));
      if (kind === 'scene') this.report.scenes++; else this.report.prefabs++;
    }
    this._pendingGroups = [];
  }

  _writeProjectFiles() {
    this._flushYamlAssets();
    this._flushGroups();
    this._write('ProjectSettings/ProjectVersion.txt', `m_EditorVersion: ${this.report.unityVersion || '2019.4.31f1'}\n`);
    this._write('Packages/manifest.json', `${JSON.stringify({ dependencies: {} }, null, 2)}\n`);
  }

  _writeReport() {
    const r = this.report;
    const lines = [
      '# Xera Ripper export report', '',
      `Unity version of the source: ${r.unityVersion || 'unknown'}`, '',
      `- textures: ${r.textures}`, `- text assets: ${r.text}`, `- audio clips: ${r.audio}`,
      `- scenes: ${r.scenes}`, `- prefabs: ${r.prefabs}`, `- other assets (text-serialised, best effort): ${r.yamlAssets}`,
      `- not exported: ${r.skipped.length}`, '', '## Why things were not exported', '',
      ...Object.entries(r.skippedByReason).sort((a, b) => b[1] - a[1]).map(([why, n]) => `- ${n} x ${why}`), '',
      '## Known limits', '',
      '- MonoBehaviour scripts are not decompiled, so components show a missing script and only their base fields are written.',
      '- Meshes, animations, materials and similar classes are written in Unity\'s text format straight from the decoded data;',
      '  they have not been opened in a Unity editor by this tool and may need fixing.',
    ];
    this._write('XeraRipper-Report.md', `${lines.join('\n')}\n`);
    writeFileSync(join(this.root, 'XeraRipper-Report.json'), JSON.stringify({ ...r, skipped: r.skipped.slice(0, 2000) }, null, 2));
  }
}

export function exportUnityProject(session, opts) {
  return new ProjectExporter(session, opts).run();
}
