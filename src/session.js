import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, relative, dirname, join, isAbsolute } from 'node:path';
import { openSource } from './sources.js';
import { isUnityFs, legacyBundleKind, parseUnityFs } from './unityFs.js';
import { SerializedFile, looksLikeSerializedFile, NoTypeTreeError } from './serializedFile.js';
import { buildExport, buildJson, canExport, EXPORTABLE } from './exporters.js';
import { toJsonSafe } from './typeTree.js';
import { safeSegment, safePath } from './names.js';
import { exportUnityProject } from './unityProject.js';

const PLATFORMS = { 2: 'macOS', 5: 'Windows', 9: 'iOS', 13: 'Android', 19: 'Windows64', 24: 'Linux64' };
const SKIP_EXT = /\.(so|dex|png|jpe?g|xml|json|txt|ogg|mp3|wav|mp4|ttf|otf|ress|resource|arsc|rsa|sf|mf|dll|pdb|dat|md|html?|js|css|cs|kotlin_module|properties|version|apk|obb)$/i;
const MAX_FILE = 3 * 1024 ** 3;

const baseOf = (n) => n.slice(n.lastIndexOf('/') + 1);

function isCandidate(entry) {
  if (/^(META-INF|res|lib)\//i.test(entry.name)) return false;
  if (SKIP_EXT.test(entry.name)) return false;
  return entry.size > 32 && entry.size <= MAX_FILE;
}

export { safeSegment };

// A GameObject's m_Name comes after its component list, so it cannot be peeked; they are small, so decode them in full.
function gameObjectName(sf, obj) {
  if (obj.classId !== 1) return '';
  try { const n = sf.readObject(obj).m_Name; return typeof n === 'string' ? n : ''; } catch { return ''; }
}

export class Session {
  constructor() { this.reset(); }

  reset() {
    this.source?.close();
    this.source = null;
    this.inputPath = null;
    this.files = [];
    this.assets = [];
    this.skipped = [];
    this.logLines = [];
    this.loadedAt = null;
  }

  log(msg) {
    this.logLines.push(`${new Date().toISOString().slice(11, 19)} ${msg}`);
    if (this.logLines.length > 500) this.logLines.shift();
  }

  get loaded() { return this.files.length > 0; }

  load(inputPath) {
    this.reset();
    this.inputPath = resolve(inputPath);
    this.source = openSource(inputPath);
    this.log(`opening ${this.inputPath}`);
    const t0 = Date.now();
    for (const entry of this.source.list()) {
      if (!isCandidate(entry)) continue;
      if (this.source.head) {
        let head;
        try { head = this.source.head(entry.name, 64); } catch (e) { this._skip(entry.name, `read failed: ${e.message}`); continue; }
        if (!isUnityFs(head) && !legacyBundleKind(head) && !looksLikeSerializedFile(head, entry.size)) continue;
      }
      let buf;
      try { buf = this.source.read(entry.name); } catch (e) { this._skip(entry.name, `read failed: ${e.message}`); continue; }
      try { this._ingest(entry.name, buf); } catch (e) { this._skip(entry.name, e.message); }
    }
    this.loadedAt = Date.now();
    this.log(`loaded ${this.files.length} serialized file(s), ${this.assets.length} object(s) in ${Date.now() - t0} ms`);
    return this.summary();
  }

  _skip(name, reason) {
    this.skipped.push({ name, reason });
    this.log(`skipped ${name}: ${reason}`);
  }

  _ingest(name, buf) {
    if (isUnityFs(buf)) {
      const bundle = parseUnityFs(buf);
      const resolveRes = (p) => {
        const b = baseOf(p).toLowerCase();
        const m = bundle.files.find((f) => baseOf(f.path).toLowerCase() === b);
        return m ? m.data : this.source.find(p);
      };
      let any = false;
      for (const m of bundle.files) {
        if ((m.flags & 4) === 0 && !looksLikeSerializedFile(m.data)) continue;
        try { this._addFile(`${name}/${m.path}`, m.data, resolveRes, `UnityFS ${bundle.unityRevision}`); any = true; }
        catch (e) { this._skip(`${name}/${m.path}`, e.message); }
      }
      if (!any) this.log(`${name}: bundle contains no serialized files`);
      return;
    }
    const legacy = legacyBundleKind(buf);
    if (legacy) { this._skip(name, `legacy ${legacy} web bundle is not supported`); return; }
    if (looksLikeSerializedFile(buf)) this._addFile(name, buf, (p) => this.source.find(p), 'serialized');
  }

  _addFile(name, data, resolveRes, container) {
    const sf = new SerializedFile(data, name);
    const file = { index: this.files.length, name, container, sf, resolve: resolveRes };
    this.files.push(file);
    for (const obj of sf.objects) {
      this.assets.push({
        id: this.assets.length, fileIndex: file.index, obj, className: obj.className, pathId: obj.pathId,
        size: obj.byteSize, name: sf.peekName(obj) ?? gameObjectName(sf, obj),
      });
    }
  }

  summary() {
    const counts = {};
    for (const a of this.assets) counts[a.className] = (counts[a.className] ?? 0) + 1;
    return {
      input: this.inputPath,
      files: this.files.map((f) => ({
        index: f.index, name: f.name, container: f.container, unityVersion: f.sf.unityVersion, serializedVersion: f.sf.version,
        platform: PLATFORMS[f.sf.targetPlatform] ?? `platform ${f.sf.targetPlatform}`, hasTypeTree: f.sf.hasTypeTree, treeSource: f.sf.treeSource,
        objects: f.sf.objects.length,
      })),
      assetCount: this.assets.length,
      counts,
      exportable: EXPORTABLE,
      skipped: this.skipped.slice(0, 50),
      skippedCount: this.skipped.length,
    };
  }

  asset(id) {
    const a = this.assets[id];
    if (!a) throw new RangeError(`no asset with id ${id}`);
    return a;
  }

  // Filtered, paged view for the UI / CLI. q matches name or path id (case-insensitive).
  list({ q = '', type = '', file = null, offset = 0, limit = 200 } = {}) {
    const needle = q.trim().toLowerCase();
    const rows = [];
    let total = 0;
    for (const a of this.assets) {
      if (type && a.className !== type) continue;
      if (file !== null && a.fileIndex !== file) continue;
      if (needle && !a.name.toLowerCase().includes(needle) && !String(a.pathId).includes(needle)) continue;
      if (total >= offset && rows.length < limit) rows.push(this._row(a));
      total++;
    }
    return { total, offset, rows };
  }

  // Ids matching a list() filter, without paging.
  ids({ q = '', type = '', file = null } = {}) {
    const needle = q.trim().toLowerCase();
    return this.assets
      .filter((a) => (!type || a.className === type) && (file === null || a.fileIndex === file)
        && (!needle || a.name.toLowerCase().includes(needle) || String(a.pathId).includes(needle)))
      .map((a) => a.id);
  }

  _row(a) {
    return { id: a.id, file: a.fileIndex, pathId: a.pathId, type: a.className, name: a.name, size: a.size, exportable: canExport(a.className) };
  }

  detail(id) {
    const a = this.asset(id);
    const file = this.files[a.fileIndex];
    const out = { ...this._row(a), fileName: file.name, hasTypeTree: file.sf.treeFor(a.obj) != null, data: null, error: null };
    try { out.data = toJsonSafe(file.sf.readObject(a.obj)); } catch (e) { out.error = e.message; }
    return out;
  }

  // Bytes + mime for the viewer. Textures are decoded to PNG, text/audio are passed through, anything else is JSON.
  preview(id) {
    const a = this.asset(id);
    const file = this.files[a.fileIndex];
    if (canExport(a.className)) {
      const e = buildExport(file, a);
      if (e.status === 'raw' && a.className === 'Texture2D') throw new Error(e.note);
      return { mime: e.mime, data: e.data.length > 4 * 1024 * 1024 && e.mime.startsWith('text') ? e.data.subarray(0, 4 * 1024 * 1024) : e.data, ext: e.ext };
    }
    return { mime: 'application/json', data: buildJson(file, a), ext: 'json' };
  }

  // Build a Unity project (Assets/, ProjectSettings/, .meta files, scenes, prefabs) under outDir/<projectName>.
  exportProject(opts) {
    const r = exportUnityProject(this, opts);
    this.log(`unity project at ${r.projectDir}: ${r.textures} textures, ${r.scenes} scenes, ${r.prefabs} prefabs, ${r.yamlAssets} other assets, ${r.skipped.length} not exported`);
    return r;
  }

  // Write assets under outDir/<file>/<Class>/<name>_<pathId>.<ext>. Never throws per asset: failures are reported.
  export({ outDir, types = EXPORTABLE, ids = null, json = false, onProgress = null } = {}) {
    if (!outDir) throw new Error('outDir is required');
    const root = resolve(outDir);
    const want = new Set(types);
    const idSet = ids ? new Set(ids) : null;
    const result = { outDir: root, written: 0, raw: 0, failed: 0, skipped: 0, noTypeTree: 0, items: [] };
    const targets = this.assets.filter((a) => (idSet ? idSet.has(a.id) : true));

    targets.forEach((a, n) => {
      const file = this.files[a.fileIndex];
      const exportable = canExport(a.className);
      const mode = exportable && want.has(a.className) ? 'asset' : !exportable && json ? 'json' : null;
      if (!mode) { result.skipped++; return; }
      const item = { id: a.id, type: a.className, name: a.name, status: 'ok' };
      try {
        const e = mode === 'json' ? { ext: 'json', data: buildJson(file, a), status: 'ok' } : buildExport(file, a);
        const dir = mode === 'json' ? join('_json', a.className) : a.className;
        const rel = `${safePath(file.name)}/${dir}/${safeSegment(a.name || a.className)}_${a.pathId}.${e.ext}`;
        const full = resolve(root, rel);
        const check = relative(root, full);
        if (check.startsWith('..') || isAbsolute(check)) throw new Error('refusing to write outside the output folder');
        mkdirSync(dirname(full), { recursive: true });
        writeFileSync(full, e.data);
        item.path = rel;
        item.status = e.status;
        if (e.note) item.note = e.note;
        if (e.status === 'raw') result.raw++; else result.written++;
      } catch (err) {
        item.note = err.message;
        if (err instanceof NoTypeTreeError) { item.status = 'no-type-tree'; result.noTypeTree++; }
        else { item.status = 'failed'; result.failed++; }
      }
      result.items.push(item);
      onProgress?.(n + 1, targets.length, item);
    });
    this.log(`export to ${root}: ${result.written} written, ${result.raw} raw, ${result.failed} failed, ${result.noTypeTree} without type tree, ${result.skipped} filtered out`);
    return result;
  }
}
