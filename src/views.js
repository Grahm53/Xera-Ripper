// Read-only "views" over a loaded Session, in the spirit of AssetRipper's pages: collections (serialized files), bundles,
// scenes (with their GameObject hierarchy), and per-asset hex / Unity-YAML. Everything returns plain JSON-able data.
import { defaultTypeDatabase } from './tpk.js';
import { UnityYamlWriter, toEditorValue, YAML_HEADER } from './unityYaml.js';
import { TAGS } from './unityProject.js';

const PLATFORMS = { 2: 'macOS', 5: 'Windows', 9: 'iOS', 13: 'Android', 19: 'Windows64', 24: 'Linux64' };
const baseOf = (n) => String(n).slice(String(n).lastIndexOf('/') + 1);
const MAX_SCENE_OBJECTS = 40_000;
export const MAX_HEX_CHUNK = 64 * 1024;

function isTransform(session, file, classId) {
  const db = defaultTypeDatabase();
  const chain = db?.ancestry(classId, file.sf.unityVersion) ?? [];
  return chain.length ? chain.includes('Transform') : classId === 4 || classId === 224;
}

function fileFacts(session, file) {
  if (file._facts) return file._facts;
  const counts = {};
  let gameObjects = 0;
  let manifest = null;
  for (const o of file.sf.objects) {
    counts[o.className] = (counts[o.className] ?? 0) + 1;
    if (o.classId === 1) gameObjects++;
    if (o.classId === 142 && !manifest) manifest = o;
  }
  let streamedScene = false;
  let sceneNames = [];
  if (manifest) {
    try {
      const v = file.sf.readObject(manifest);
      streamedScene = Boolean(v.m_IsStreamedSceneAssetBundle);
      sceneNames = (v.m_Container ?? []).map((e) => e?.first).filter((p) => typeof p === 'string' && /\.unity$/i.test(p));
    } catch { /* a manifest we cannot decode only means we cannot name the scene */ }
  }
  return (file._facts = { counts, gameObjects, hasManifest: Boolean(manifest), streamedScene, sceneNames });
}

// A file is a "scene" when it holds GameObjects and is not a regular asset bundle (those hold prefabs).
function isScene(f) { return f.gameObjects > 0 && (!f.hasManifest || f.streamedScene); }

export function collections(session) {
  return session.files.map((file) => {
    const f = fileFacts(session, file);
    return {
      index: file.index, name: file.name, container: file.container, bundleIndex: file.bundleIndex,
      unityVersion: file.sf.unityVersion, serializedVersion: file.sf.version, platform: PLATFORMS[file.sf.targetPlatform] ?? `platform ${file.sf.targetPlatform}`,
      treeSource: file.sf.treeSource, objects: file.sf.objects.length, counts: f.counts, gameObjects: f.gameObjects, scene: isScene(f),
    };
  });
}

export function bundles(session) {
  return session.bundles.map((b) => ({
    ...b,
    members: b.members.map((m) => ({ ...m, collection: m.fileIndex === null ? null : session.files[m.fileIndex].name })),
  }));
}

export function scenes(session) {
  const out = [];
  for (const file of session.files) {
    const f = fileFacts(session, file);
    if (!isScene(f)) continue;
    const named = f.sceneNames[0];
    out.push({ fileIndex: file.index, name: named ? baseOf(named).replace(/\.unity$/i, '') : baseOf(file.name), path: named ?? file.name, gameObjects: f.gameObjects, objects: file.sf.objects.length });
  }
  return out;
}

const refPath = (r) => (r && typeof r === 'object' && Number(r.m_FileID) === 0 ? String(r.m_PathID) : null);
const list = (x) => (Array.isArray(x) ? x : []); // a decoded field is not guaranteed to have the shape the class normally has

// GameObject hierarchy of one file: [{ id, name, active, components: [{id, type}], children: [...] }]
export function sceneTree(session, fileIndex) {
  const file = session.files[fileIndex];
  if (!file) throw new RangeError(`no such collection: ${fileIndex}`);
  const mine = session.assets.filter((a) => a.fileIndex === fileIndex);
  const gos = mine.filter((a) => a.obj.classId === 1);
  const trs = mine.filter((a) => isTransform(session, file, a.obj.classId));
  if (gos.length + trs.length > MAX_SCENE_OBJECTS) {
    throw new RangeError(`this scene has ${gos.length} GameObjects, too many to show as a tree; use the Assets tab instead`);
  }
  const byPath = new Map(mine.map((a) => [String(a.pathId), a]));

  const goValues = new Map();
  for (const a of gos) { try { goValues.set(String(a.pathId), file.sf.readObject(a.obj)); } catch { goValues.set(String(a.pathId), null); } }
  const node = new Map();
  for (const a of gos) {
    const v = goValues.get(String(a.pathId));
    const comps = [];
    for (const c of list(v?.m_Component)) {
      const p = refPath(c?.component ?? c?.second);
      const target = p === null ? null : byPath.get(p);
      if (target) comps.push({ id: target.id, type: target.className });
    }
    node.set(String(a.pathId), { id: a.id, name: v?.m_Name || a.name || `GameObject ${a.pathId}`, active: v ? v.m_IsActive !== false && v.m_IsActive !== 0 : true, components: comps, children: [] });
  }

  // Transform links: m_GameObject (owner), m_Father, m_Children
  const owner = new Map(); // transform path -> go path
  const father = new Map(); // transform path -> father transform path | null
  const kids = new Map(); // transform path -> [child transform paths]
  for (const a of trs) {
    let v;
    try { v = file.sf.readObject(a.obj); } catch { continue; }
    const tp = String(a.pathId);
    owner.set(tp, refPath(v.m_GameObject));
    father.set(tp, refPath(v.m_Father));
    kids.set(tp, list(v.m_Children).map(refPath).filter((x) => x !== null));
  }
  const goOfTransform = (tp) => node.get(owner.get(tp) ?? '');
  const placed = new Set();
  const build = (tp, depth = 0) => {
    const n = goOfTransform(tp);
    if (!n || depth > 200 || placed.has(tp)) return null;
    placed.add(tp);
    for (const c of kids.get(tp) ?? []) { const cn = build(c, depth + 1); if (cn) n.children.push(cn); }
    return n;
  };
  const roots = [];
  for (const tp of owner.keys()) {
    const f = father.get(tp);
    if (f === null || f === undefined || !owner.has(f)) { const n = build(tp); if (n) roots.push(n); }
  }
  // GameObjects without a usable Transform (stripped / undecodable) are listed flat at the end
  const shown = new Set();
  const mark = (n) => { shown.add(n.id); n.children.forEach(mark); };
  roots.forEach(mark);
  for (const n of node.values()) if (!shown.has(n.id)) roots.push(n);
  return { fileIndex, name: file.name, total: gos.length, roots };
}

export function hex(session, id, offset = 0, limit = 4096) {
  const a = session.asset(id);
  const bytes = session.files[a.fileIndex].sf.objectBytes(a.obj);
  const start = Math.max(0, Math.min(Number.isFinite(offset) ? Math.trunc(offset) : 0, bytes.length));
  const n = Math.max(0, Math.min(Number.isFinite(limit) ? Math.trunc(limit) : 4096, MAX_HEX_CHUNK, bytes.length - start));
  return { total: bytes.length, offset: start, length: n, data: bytes.subarray(start, start + n).toString('base64') };
}

// Unity text-serialisation of one object for display. References show the original path ids (the project export is what
// rewrites them to GUIDs), so this is a viewer, not something to paste into a project.
export function yaml(session, id) {
  const a = session.asset(id);
  const file = session.files[a.fileIndex];
  const found = file.sf.treeFor(a.obj);
  if (!found) throw new Error(`${a.className} cannot be decoded (no usable type tree), so it has no text view`);
  const runtime = file.sf.readObject(a.obj);
  if (a.obj.classId === 1 && typeof runtime.m_Tag === 'number') runtime.m_TagString = TAGS[runtime.m_Tag] ?? 'Untagged';
  const resolver = (fileId, pathId) => {
    if (String(pathId) === '0') return null;
    if (Number(fileId) === 0) return { fileID: pathId };
    return { fileID: pathId, guid: `external-file-${fileId}`, type: 0 };
  };
  const editor = defaultTypeDatabase()?.editorTreeFor(a.obj.classId, file.sf.unityVersion);
  const doc = editor
    ? new UnityYamlWriter(editor, resolver).document(a.obj.classId, a.pathId, toEditorValue(editor, runtime))
    : new UnityYamlWriter(found.tree, resolver).document(a.obj.classId, a.pathId, runtime);
  return `${YAML_HEADER}${doc}`;
}
