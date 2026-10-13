import { BinaryReader } from './binaryReader.js';
import { COMMON_BY_OFFSET } from './commonStrings.js';

const ALIGN_FLAG = 0x4000;
const MAX_NODES = 200_000;
const MAX_STRING_BUFFER = 16 * 1024 * 1024;

export class UnsupportedError extends Error {
  constructor(message) { super(message); this.name = 'UnsupportedError'; }
}

// Reads the blob type-tree layout used by serialized-file versions 10 and 12+.
export function parseTypeTreeBlob(r, serializedVersion) {
  const nodeCount = r.i32();
  const stringSize = r.i32();
  if (nodeCount < 0 || nodeCount > MAX_NODES) throw new RangeError(`implausible type tree node count ${nodeCount}`);
  if (stringSize < 0 || stringSize > MAX_STRING_BUFFER) throw new RangeError(`implausible type tree string size ${stringSize}`);

  const raw = [];
  for (let i = 0; i < nodeCount; i++) {
    const n = {
      version: r.u16(), level: r.u8(), typeFlags: r.u8(),
      typeOffset: r.u32(), nameOffset: r.u32(),
      byteSize: r.i32(), index: r.i32(), metaFlags: r.i32(),
    };
    if (serializedVersion >= 19) n.refTypeHash = r.u64();
    raw.push(n);
  }
  const strings = Buffer.from(r.bytes(stringSize));
  const lookup = (offset) => {
    if (offset & 0x80000000) return COMMON_BY_OFFSET.get(offset & 0x7fffffff) ?? `?common@${offset & 0x7fffffff}`;
    if (offset >= strings.length) return `?local@${offset}`;
    const end = strings.indexOf(0, offset);
    return strings.toString('utf8', offset, end < 0 ? strings.length : end);
  };
  return raw.map((n) => ({ ...n, type: lookup(n.typeOffset), name: lookup(n.nameOffset) }));
}

// Exclusive end index of each node's subtree, computed once per tree with a level stack.
function computeEnds(nodes) {
  const ends = new Array(nodes.length).fill(nodes.length);
  const stack = [];
  for (let i = 0; i < nodes.length; i++) {
    while (stack.length && nodes[stack[stack.length - 1]].level >= nodes[i].level) ends[stack.pop()] = i;
    stack.push(i);
  }
  return ends;
}

export class TypeTree {
  constructor(nodes) {
    this.nodes = nodes;
    this.ends = computeEnds(nodes);
  }

  get rootType() { return this.nodes[0]?.type ?? ''; }

  // Decode one object's bytes into plain JS values using this tree as the schema.
  //   rawStrings: keep `string` fields as Buffers (TextAsset scripts are frequently binary)
  read(buffer, opts) { return this.readCounted(buffer, opts).value; }

  // Like read(), but also reports how many bytes the tree consumed (used to validate database-supplied trees).
  readCounted(buffer, { little = true, rawStrings = false } = {}) {
    if (!this.nodes.length) throw new Error('empty type tree');
    const r = new BinaryReader(buffer, 0, little);
    const value = this._value(r, 0, rawStrings);
    return { value, consumed: r.pos };
  }

  // Cheap name lookup for listings: only decodes the first field, and only if it is m_Name.
  peekName(buffer, little = true) {
    const first = this.nodes[1];
    if (!first || first.name !== 'm_Name' || first.type !== 'string') return null;
    try {
      const r = new BinaryReader(buffer, 0, little);
      const len = r.i32();
      if (len < 0 || len > r.remaining) return null;
      return r.bytes(len).toString('utf8');
    } catch { return null; }
  }

  _value(r, i, raw) {
    const nodes = this.nodes;
    const n = nodes[i];
    let align = (n.metaFlags & ALIGN_FLAG) !== 0;
    let value;

    switch (n.type) {
      case 'SInt8': value = r.i8(); break;
      case 'UInt8': case 'char': value = r.u8(); break;
      case 'bool': value = r.bool(); break;
      case 'SInt16': case 'short': value = r.i16(); break;
      case 'UInt16': case 'unsigned short': value = r.u16(); break;
      case 'SInt32': case 'int': value = r.i32(); break;
      case 'UInt32': case 'unsigned int': case 'Type*': value = r.u32(); break;
      case 'SInt64': case 'long long': value = r.i64(); break;
      case 'UInt64': case 'unsigned long long': case 'FileSize': value = r.u64(); break;
      case 'float': value = r.f32(); break;
      case 'double': value = r.f64(); break;
      case 'string': {
        const len = this._length(r);
        const bytes = r.bytes(len);
        value = raw ? Buffer.from(bytes) : bytes.toString('utf8');
        align = true;
        break;
      }
      case 'TypelessData': {
        value = r.bytes(this._length(r));
        break;
      }
      case 'map': {
        if (nodes[i + 1] && (nodes[i + 1].metaFlags & ALIGN_FLAG)) align = true;
        const count = this._length(r);
        value = [];
        for (let k = 0; k < count; k++) value.push(this._value(r, i + 3, raw));
        break;
      }
      default: {
        const child = nodes[i + 1];
        if (child && child.type === 'Array' && child.level === n.level + 1) {
          // vector / array: [Array -> size, data]
          if (child.metaFlags & ALIGN_FLAG) align = true;
          const count = this._length(r);
          const elem = nodes[i + 3];
          if (elem && (elem.type === 'UInt8' || elem.type === 'SInt8' || elem.type === 'char') && this.ends[i + 3] === i + 4) {
            value = Buffer.from(r.bytes(count)); // byte arrays stay compact
          } else {
            value = [];
            for (let k = 0; k < count; k++) {
              const before = r.pos;
              value.push(this._value(r, i + 3, raw));
              // An element that consumes no bytes would let a tiny object claim billions of elements.
              if (k === 0 && r.pos === before && count > 1) throw new RangeError(`array of ${count} zero-width elements`);
            }
          }
        } else {
          value = {};
          for (let j = i + 1; j < this.ends[i]; j = this.ends[j]) value[nodes[j].name] = this._value(r, j, raw);
        }
      }
    }

    if (align) r.align(4);
    return value;
  }

  // An array/string/blob length must be non-negative and cannot exceed what is left in the object.
  _length(r) {
    const len = r.i32();
    if (len < 0 || len > r.remaining) throw new RangeError(`implausible length ${len} at ${r.pos - 4}`);
    return len;
  }
}

// JSON-safe view of a decoded object (Buffers become {$bytes:n}); used by the dump command and the web UI.
export function toJsonSafe(value) {
  if (typeof value === 'bigint') return value.toString();
  if (Buffer.isBuffer(value)) return { $bytes: value.length };
  if (Array.isArray(value)) return value.map(toJsonSafe);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = toJsonSafe(v);
    return out;
  }
  return value;
}

// JSON.stringify replacer for payloads that may carry BigInt path IDs.
export const bigintReplacer = (_k, v) => (typeof v === 'bigint' ? v.toString() : v);
