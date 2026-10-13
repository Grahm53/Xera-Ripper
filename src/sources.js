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
    return hit ? this.read(hit) : null;
  }
  close() {}
}

export class DirSource extends BaseSource {
  constructor(root) {
    super();
    this.root = resolve(root);
    this.label = basename(this.root) || this.root;
    this._list = null;
  }

  list() {
    if (this._list) return this._list;
    const out = [];
    const walk = (dir) => {
      for (const ent of readdirSync(dir)) {
        const full = join(dir, ent);
        const st = lstatSync(full);
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
  find(name) { return this._dir.find(name); }
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
