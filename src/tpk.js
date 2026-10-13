import { readFileSync } from 'node:fs';
import { BinaryReader } from './binaryReader.js';
import { lzmaDecode } from './lzma.js';
import { TypeTree } from './typeTree.js';

// Reader for the TPK type-tree database (see data/NOTICE.md): per Unity version, the runtime field layout of every
// engine class. Used when a serialized file has no embedded type trees (release player builds strip them).

const TPK_MAGIC = 0x2a4b5054; // "TPK*"
const FLAG_EDITOR_ROOT = 64;
const FLAG_RELEASE_ROOT = 128;
const TYPE_LETTERS = { a: 0n, b: 1n, c: 2n, f: 3n, p: 4n, x: 5n };

// "2019.4.31f1" -> numeric version used by the database ((major<<48)|(minor<<32)|(build<<16)|(type<<8)|number); null if unparsable.
export function encodeUnityVersion(s) {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:([a-zA-Z]+?)(\d+)?)?/.exec(String(s ?? ''));
  if (!m) return null;
  const type = m[4] === undefined ? 3n : TYPE_LETTERS[m[4].toLowerCase()] ?? 255n;
  return (BigInt(m[1]) << 48n) | (BigInt(m[2]) << 32n) | (BigInt(m[3]) << 16n) | (type << 8n) | BigInt(m[5] ?? 0);
}

function readString(r) {
  let len = 0;
  for (let shift = 0; ; shift += 7) {
    const b = r.u8();
    len |= (b & 0x7f) << shift;
    if (!(b & 0x80)) break;
    if (shift > 28) throw new RangeError('bad varint in TPK string table');
  }
  return r.bytes(len).toString('utf8');
}

export class TypeTreeDatabase {
  // `file` is the raw .tpk file contents.
  constructor(file) {
    if (file.length < 20) throw new Error('TPK file is too short');
    const h = new BinaryReader(file, 0, true);
    if (h.u32() !== TPK_MAGIC) throw new Error('not a TPK file');
    const tpkVersion = h.u8();
    const compression = h.u8();
    const dataType = h.u8();
    h.u8(); h.u32();
    const compressedSize = h.u32();
    const uncompressedSize = h.u32();
    if (tpkVersion !== 1 && tpkVersion !== 2) throw new Error(`unsupported TPK version ${tpkVersion}`);
    if (dataType !== 0) throw new Error(`unsupported TPK data type ${dataType} (need type-tree information)`);
    if (uncompressedSize > 256 * 1024 * 1024) throw new RangeError('implausible TPK size');
    const packed = h.bytes(compressedSize);
    let blob;
    if (compression === 0) blob = packed;
    else if (compression === 2) blob = lzmaDecode(packed, uncompressedSize);
    else throw new Error(`unsupported TPK compression ${compression}`);
    this._parse(new BinaryReader(blob, 0, true), tpkVersion);
    this._trees = new Map();
  }

  _parse(r, tpkVersion) {
    r.i64(); // creation time
    const versionCount = r.i32();
    this.versions = Array.from({ length: versionCount }, () => BigInt(r.u64()));

    const classCount = r.i32();
    this.classes = new Map();
    for (let i = 0; i < classCount; i++) {
      const id = r.i32();
      const n = r.i32();
      const entries = [];
      for (let k = 0; k < n; k++) {
        const version = BigInt(r.u64());
        let cls = null;
        if (r.u8()) {
          const name = r.u16(); const base = r.u16(); const flags = r.u8();
          cls = { name, base, flags, editorRoot: null, releaseRoot: null };
          if (flags & FLAG_EDITOR_ROOT) cls.editorRoot = r.u16();
          if (flags & FLAG_RELEASE_ROOT) cls.releaseRoot = r.u16();
        }
        entries.push({ version, cls });
      }
      this.classes.set(id, entries);
    }

    // common-string table: not needed (nodes reference the string buffer directly), but it must be skipped
    if (tpkVersion === 2) {
      const vc = r.i32();
      for (let i = 0; i < vc; i++) { r.u64(); const ec = r.i32(); r.bytes(ec * 4); }
    } else {
      const vc = r.i32();
      for (let i = 0; i < vc; i++) { r.u64(); r.u8(); }
      const ic = r.i32();
      r.bytes(ic * 2);
    }

    const nodeCount = r.i32();
    if (nodeCount < 0 || nodeCount > 5_000_000) throw new RangeError('implausible TPK node count');
    this.nodes = new Array(nodeCount);
    for (let i = 0; i < nodeCount; i++) {
      const typeName = r.u16(); const name = r.u16(); const byteSize = r.i32(); const version = r.i16();
      const typeFlags = r.u8(); const metaFlags = r.u32(); const subCount = r.u16();
      const subs = new Array(subCount);
      for (let k = 0; k < subCount; k++) subs[k] = r.u16();
      this.nodes[i] = { typeName, name, byteSize, version, typeFlags, metaFlags, subs };
    }

    const stringCount = r.i32();
    if (stringCount < 0 || stringCount > 5_000_000) throw new RangeError('implausible TPK string count');
    this.strings = new Array(stringCount);
    for (let i = 0; i < stringCount; i++) this.strings[i] = readString(r);
  }

  hasClass(classId) { return this.classes.has(classId); }

  // The newest entry whose version is <= the file's version, as the database defines it.
  _classFor(classId, version) {
    const entries = this.classes.get(classId);
    if (!entries) return null;
    let found = null;
    for (const e of entries) { if (version >= e.version) found = e; else break; }
    return found?.cls ?? null;
  }

  // Runtime ("release") type tree for a class at a given Unity version string, or null when unknown.
  treeFor(classId, unityVersion) {
    const v = encodeUnityVersion(unityVersion);
    if (v === null) return null;
    const cls = this._classFor(classId, v);
    if (!cls || cls.releaseRoot === null) return null;
    if (this._trees.has(cls)) return this._trees.get(cls);

    const out = [];
    const walk = (id, level) => {
      const n = this.nodes[id];
      out.push({
        version: n.version, level, typeFlags: n.typeFlags, byteSize: n.byteSize, index: out.length, metaFlags: n.metaFlags,
        type: this.strings[n.typeName] ?? '', name: this.strings[n.name] ?? '',
      });
      for (const sub of n.subs) walk(sub, level + 1);
    };
    walk(cls.releaseRoot, 0);
    const tree = new TypeTree(out);
    this._trees.set(cls, tree);
    return tree;
  }
}

let shared;
// The bundled database, loaded once on first use. Returns null if the data file is missing or unreadable.
export function defaultTypeDatabase() {
  if (shared === undefined) {
    try { shared = new TypeTreeDatabase(readFileSync(new URL('../data/lzma.tpk', import.meta.url))); } catch { shared = null; }
  }
  return shared;
}
