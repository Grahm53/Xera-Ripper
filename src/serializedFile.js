import { BinaryReader, sizeNumber } from './binaryReader.js';
import { className } from './classIds.js';
import { parseTypeTreeBlob, TypeTree, UnsupportedError } from './typeTree.js';
import { defaultTypeDatabase } from './tpk.js';

export class NoTypeTreeError extends UnsupportedError {
  constructor(message) { super(message); this.name = 'NoTypeTreeError'; }
}

// The built-in database knew the class but its layout does not match the object's bytes (e.g. a patched engine).
export class TypeTreeMismatchError extends NoTypeTreeError {
  constructor(message) { super(message); this.name = 'TypeTreeMismatchError'; }
}

// Classes whose real layout depends on a user script (not in the engine database): only their base fields decode.
const SCRIPT_DRIVEN = new Set([114]);

const MIN_VERSION = 9;
const MAX_VERSION = 40;
const MAX_OBJECTS = 5_000_000;

// Cheap structural check used to decide whether an arbitrary file is a serialized file at all.
// `totalLength` lets callers pass just the first few dozen bytes plus the real file size.
export function looksLikeSerializedFile(buf, totalLength = buf.length) {
  if (buf.length < 32) return false;
  const r = new BinaryReader(buf, 0, false);
  const metadataSize = r.u32();
  let fileSize = r.u32();
  const version = r.u32();
  let dataOffset = r.u32();
  if (version < MIN_VERSION || version > MAX_VERSION) return false;
  if (version >= 22) {
    r.pos = 20;
    try { r.u32(); fileSize = r.i64(); dataOffset = r.i64(); } catch { return false; }
    if (typeof fileSize !== 'number' || typeof dataOffset !== 'number') return false;
  }
  return fileSize > 0 && fileSize <= totalLength && dataOffset <= fileSize && metadataSize <= fileSize && dataOffset >= 16;
}

function readType(r, version, hasTypeTree, isRef) {
  const t = {
    classId: r.i32(), isStripped: false, scriptTypeIndex: -1, scriptId: null, typeHash: null, tree: null,
  };
  if (version >= 16) t.isStripped = r.bool();
  if (version >= 17) t.scriptTypeIndex = r.i16();
  if (version >= 13) {
    const needsScriptId = (isRef && t.scriptTypeIndex >= 0) || (version < 16 && t.classId < 0) || (version >= 16 && t.classId === 114);
    if (needsScriptId) t.scriptId = Buffer.from(r.bytes(16));
    t.typeHash = Buffer.from(r.bytes(16));
  }
  if (hasTypeTree) {
    if (version >= 12 || version === 10) t.tree = new TypeTree(parseTypeTreeBlob(r, version));
    else throw new UnsupportedError(`legacy type-tree layout (serialized file version ${version}) is not supported`);
    if (version >= 21) {
      if (isRef) {
        t.refClass = r.cstring();
        t.refNamespace = r.cstring();
        t.refAssembly = r.cstring();
      } else {
        const deps = r.i32();
        if (deps < 0 || deps * 4 > r.remaining) throw new RangeError('implausible type dependency count');
        r.bytes(deps * 4);
      }
    }
  }
  return t;
}

export class SerializedFile {
  // `name` is only used for display. Throws on structurally invalid or unsupported files.
  constructor(buffer, name = '') {
    this.buffer = buffer;
    this.name = name;
    this._parse();
  }

  _parse() {
    const buf = this.buffer;
    const r = new BinaryReader(buf, 0, false); // the header is always big-endian
    r.u32(); // metadata size (recomputed below for v22+)
    r.u32(); // file size
    const version = r.u32();
    let dataOffset = r.u32();
    if (version < MIN_VERSION || version > MAX_VERSION) throw new UnsupportedError(`unsupported serialized file version ${version}`);

    const endian = r.u8();
    r.bytes(3);
    if (version >= 22) {
      r.u32();
      r.i64(); // file size
      dataOffset = sizeNumber(r.i64(), 'data offset');
      r.i64(); // unknown
    }
    r.little = endian === 0;

    this.version = version;
    this.little = r.little;
    this.dataOffset = dataOffset;
    this.unityVersion = version >= 7 ? r.cstring() : '';
    this.targetPlatform = version >= 8 ? r.i32() : 0;
    this.hasTypeTree = version >= 13 ? r.bool() : true;

    const typeCount = r.i32();
    if (typeCount < 0 || typeCount > 100_000) throw new RangeError(`implausible type count ${typeCount}`);
    this.types = [];
    for (let i = 0; i < typeCount; i++) this.types.push(readType(r, version, this.hasTypeTree, false));

    let bigId = false;
    if (version >= 7 && version < 14) bigId = r.i32() !== 0;

    const objectCount = r.i32();
    if (objectCount < 0 || objectCount > MAX_OBJECTS) throw new RangeError(`implausible object count ${objectCount}`);
    this.objects = [];
    for (let i = 0; i < objectCount; i++) {
      let pathId;
      if (bigId) pathId = r.i64();
      else if (version < 14) pathId = r.i32();
      else { r.align(4); pathId = r.i64(); }

      const byteStart = sizeNumber(version >= 22 ? r.i64() : r.u32(), 'object offset') + dataOffset;
      const byteSize = r.u32();
      const typeId = r.i32();
      let classId;
      let typeIndex;
      if (version < 16) {
        classId = r.u16();
        typeIndex = this.types.findIndex((t) => t.classId === typeId);
      } else {
        typeIndex = typeId;
        classId = this.types[typeId]?.classId ?? -1;
      }
      if (version < 11) r.u16();                    // isDestroyed
      if (version >= 11 && version < 17) r.i16();   // scriptTypeIndex
      if (version === 15 || version === 16) r.u8(); // stripped

      this.objects.push({ pathId, classId, className: className(classId), typeIndex, byteStart, byteSize, name: null });
    }

    if (version >= 11) {
      const scriptCount = r.i32();
      if (scriptCount < 0 || scriptCount > 1_000_000) throw new RangeError('implausible script type count');
      for (let i = 0; i < scriptCount; i++) {
        r.i32();
        if (version < 14) r.i32(); else { r.align(4); r.i64(); }
      }
    }

    const externalCount = r.i32();
    if (externalCount < 0 || externalCount > 100_000) throw new RangeError('implausible externals count');
    this.externals = [];
    for (let i = 0; i < externalCount; i++) {
      if (version >= 6) r.cstring();
      if (version >= 5) { r.bytes(16); r.i32(); }
      this.externals.push(r.cstring());
    }

    this.refTypes = [];
    if (version >= 20) {
      const refCount = r.i32();
      if (refCount < 0 || refCount > 100_000) throw new RangeError('implausible ref type count');
      for (let i = 0; i < refCount; i++) this.refTypes.push(readType(r, version, this.hasTypeTree, true));
    }
  }

  typeOf(obj) { return this.types[obj.typeIndex] ?? null; }

  objectBytes(obj) {
    const end = obj.byteStart + obj.byteSize;
    if (obj.byteStart < 0 || end > this.buffer.length) {
      throw new RangeError(`object ${obj.pathId} data (${obj.byteStart}..${end}) lies outside the file (${this.buffer.length} bytes)`);
    }
    return this.buffer.subarray(obj.byteStart, end);
  }

  // { tree, source } where source is 'file' (embedded) or 'database' (built-in per-Unity-version layouts); null if neither.
  treeFor(obj) {
    const embedded = this.typeOf(obj)?.tree;
    if (embedded) return { tree: embedded, source: 'file' };
    const tree = defaultTypeDatabase()?.treeFor(obj.classId, this.unityVersion);
    return tree ? { tree, source: 'database' } : null;
  }

  // How this file's objects get their field layouts: from the file, from the built-in database, or not at all.
  get treeSource() {
    if (this.hasTypeTree) return 'file';
    const db = defaultTypeDatabase();
    return db && db.treeFor(28, this.unityVersion) ? 'database' : 'none';
  }

  readObject(obj, opts = {}) {
    const found = this.treeFor(obj);
    if (!found) {
      throw new NoTypeTreeError(this.hasTypeTree
        ? `no type tree for ${obj.className} in this file`
        : `${obj.className} has no type tree in this file (release builds strip them) and the built-in database has no layout for Unity ${this.unityVersion || '?'}`);
    }
    const bytes = this.objectBytes(obj);
    let decoded;
    try {
      decoded = found.tree.readCounted(bytes, { little: this.little, ...opts });
    } catch (e) {
      // A wrong database layout typically runs off the end of the object or reads an absurd length.
      if (found.source === 'database' && e instanceof RangeError) {
        throw new TypeTreeMismatchError(`built-in layout of ${obj.className} for Unity ${this.unityVersion} does not fit this object (${e.message})`);
      }
      throw e;
    }
    const { value, consumed } = decoded;
    if (found.source === 'database') {
      const left = bytes.length - consumed;
      if (SCRIPT_DRIVEN.has(obj.classId)) {
        if (left > 0) value.$unparsed = Buffer.from(bytes.subarray(consumed)); // script fields we cannot name
      } else if (left < 0 || left > 3) { // up to 3 bytes of end padding is normal
        throw new TypeTreeMismatchError(`built-in layout of ${obj.className} for Unity ${this.unityVersion} consumed ${consumed} of ${bytes.length} bytes; the object does not match it`);
      }
    }
    return value;
  }

  peekName(obj) {
    const tree = this.treeFor(obj)?.tree;
    if (!tree) return null;
    try { return tree.peekName(this.objectBytes(obj), this.little); } catch { return null; }
  }
}
