import { readdirSync, lstatSync, readFileSync, openSync, readSync, closeSync, statSync } from 'node:fs';
import { join, resolve, relative, basename, dirname, sep, isAbsolute } from 'node:path';
import { ZipArchive } from './zip.js';

const MAX_ENTRIES = 300_000;
const posix = (p) => p.split(sep).join('/');

function readHead(full, n) {
  const fd = openSync(full, 'r');
  try {
    const b = Buffer.alloc(n);
    const got = readSync(fd, b, 0, n, 0);
    return b.subarray(0, got);
  } finally { closeSync(fd); }
}
const baseOf = (name) => name.slice(name.lastIndexOf('/') + 1);

// A big streamed-resource file (.resS / .resource) that stays on disk: the exporters only ever ask for `length` and a byte range
// (`subarray`), so each texture/audio read costs its own bytes instead of re-reading a multi-GB file once per asset.
export class DiskFile {
  constructor(full, size) { this.full = full; this.length = size; }
  subarray(start = 0, end = this.length) {
    const from = Math.max(0, Math.min(start, this.length));
    const to = Math.max(from, Math.min(end, this.length));
    const out = Buffer.alloc(to - from);
    if (out.length === 0) return out;
    const fd = openSync(this.full, 'r');
    try {
      let got = 0;
      while (got < out.length) {
        const n = readSync(fd, out, got, out.length - got, from + got);
        if (n === 0) break; // the file shrank since it was listed
        got += n;
      }
      return got === out.length ? out : out.subarray(0, got);
    } finally { closeSync(fd); }
  }
}

const CACHE_BYTES = 256 * 1024 * 1024;

// A "source" is anything that can enumerate and read named byte blobs: a directory tree, a single file, or a zip/apk.
class BaseSource {
  // Look a streamed-resource file (.resS / .resource) up by basename, case-insensitively as a fallback.
  find(name) {
    if (!this._index) {
      this._index = new Map();
      for (const e of this.list()) {
        const b = baseOf(e.name);
        if (!this._index.has(b)) this._index.set(b, e.name);
        if (!this._index.has(b.toLowerCase())) this._index.set(b.toLowerCase(), e.name);
      }
    }
    const b = baseOf(name);
    const hit = this._index.get(b) ?? this._index.get(b.toLowerCase());
    return hit ? this._openResource(hit) : null;
  }
  // Default: the whole blob, remembered for a while (a zip entry would otherwise be inflated again for every texture that streams from it).
  _openResource(name) {
    this._cache ??= new Map();
    const hit = this._cache.get(name);
    if (hit) return hit;
    const buf = this.read(name);
    if (buf.length <= CACHE_BYTES) {
      let total = buf.length;
      for (const v of this._cache.values()) total += v.length;
      for (const k of this._cache.keys()) { if (total <= CACHE_BYTES) break; total -= this._cache.get(k).length; this._cache.delete(k); }
      this._cache.set(name, buf);
    }
    return buf;
  }
  close() { this._cache = null; }
}

export class DirSource extends BaseSource {
  constructor(root, io = { readdirSync, lstatSync }) { // `io` is injectable so a locked folder can be simulated in tests
    super();
    this.io = io;
    this.root = resolve(root);
    this.label = basename(this.root) || this.root;
    this._list = null;
    this.problems = []; // things that could not be read while walking (a locked folder must not stop the rest from opening)
  }

  list() {
    if (this._list) return this._list;
    const out = [];
    const problem = (path, e) => this.problems.push({ name: posix(relative(this.root, path)) || '.', reason: `could not be read: ${e.code ?? e.message}` });
    const walk = (dir) => {
      let names;
      try { names = this.io.readdirSync(dir); } catch (e) { problem(dir, e); return; }
      for (const ent of names) {
        const full = join(dir, ent);
        let st;
        try { st = this.io.lstatSync(full); } catch (e) { problem(full, e); continue; }
        if (st.isSymbolicLink()) continue; // never follow links: avoids loops and escaping the chosen folder
        if (st.isDirectory()) walk(full);
        else if (st.isFile()) {
          out.push({ name: posix(relative(this.root, full)), size: st.size });
          if (out.length > MAX_ENTRIES) throw new Error(`folder has more than ${MAX_ENTRIES} files; open the game's data folder instead of a huge parent folder`);
        }
      }
    };
    walk(this.root);
    out.sort((a, b) => (a.name < b.name ? -1 : 1));
    return (this._list = out);
  }

  _resolve(name) {
    const full = resolve(this.root, name);
    const rel = relative(this.root, full);
    if (rel.startsWith('..') || isAbsolute(rel)) throw new Error(`path escapes the source folder: ${name}`);
    return full;
  }

  read(name) { return readFileSync(this._resolve(name)); }
  _openResource(name) { return new DiskFile(this._resolve(name), statSync(this._resolve(name)).size); }

  // First n bytes only, so scanning a big folder never loads unrelated multi-GB files into memory.
  head(name, n) { return readHead(this._resolve(name), n); }
}

// One file on disk; sibling files in the same folder (e.g. level0 + level0.resS) are still resolvable.
export class FileSource extends BaseSource {
  constructor(path) {
    super();
    this.path = resolve(path);
    this.label = basename(this.path);
    this._dir = new DirSource(dirname(this.path));
  }
  list() { return [{ name: this.label, size: statSync(this.path).size }]; }
  read(name) { return name === this.label ? readFileSync(this.path) : this._dir.read(name); }
  head(name, n) { return name === this.label ? readHead(this.path, n) : this._dir.head(name, n); }
  // Sibling resource (level0 + level0.resS): looked up in this file's own folder only. Walking the whole folder tree would be slow in
  // a big parent folder and would fail on any subfolder we are not allowed to read.
  find(name) {
    const wanted = baseOf(name.replaceAll('\\', '/'));
    const dir = dirname(this.path);
    let hit = null;
    try {
      const names = readdirSync(dir);
      hit = names.find((n) => n === wanted) ?? names.find((n) => n.toLowerCase() === wanted.toLowerCase()) ?? null;
    } catch { /* unreadable folder: no sibling */ }
    if (!hit) return null;
    const full = join(dir, hit);
    try { const st = statSync(full); return st.isFile() ? new DiskFile(full, st.size) : null; } catch { return null; }
  }
}

export class ZipSource extends BaseSource {
  constructor(path) {
    super();
    this.zip = new ZipArchive(path);
    this.label = basename(path);
  }
  list() { return this.zip.entries.map((e) => ({ name: e.name, size: e.size })); }
  read(name) { return this.zip.read(name); }
  close() { this.zip.close(); }
}

export function openSource(inputPath) {
  const st = statSync(inputPath);
  if (st.isDirectory()) return new DirSource(inputPath);
  const fd = openSync(inputPath, 'r');
  const head = Buffer.alloc(4);
  try { readSync(fd, head, 0, 4, 0); } finally { closeSync(fd); }
  if (head.readUInt32LE(0) === 0x04034b50) return new ZipSource(inputPath);
  return new FileSource(inputPath);
}
