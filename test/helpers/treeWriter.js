// Test-only: serialise a value to bytes *by walking a type tree*, mirroring Unity's layout rules (alignment flags,
// strings, vectors, maps, byte arrays). Lets the tests build objects with REAL engine layouts from the database.
import { Writer } from './builders.js';

const ALIGN = 0x4000;
const BYTE_TYPES = new Set(['UInt8', 'SInt8', 'char']);
const isByteVector = (nodes, ends, i) => nodes[i + 3] && BYTE_TYPES.has(nodes[i + 3].type) && ends[i + 3] === i + 4;
const isVector = (nodes, i) => nodes[i + 1] && nodes[i + 1].type === 'Array' && nodes[i + 1].level === nodes[i].level + 1;

export function defaultValue(tree, i = 0) {
  const { nodes, ends } = tree;
  const n = nodes[i];
  switch (n.type) {
    case 'bool': return false;
    case 'string': return '';
    case 'TypelessData': return Buffer.alloc(0);
    case 'map': return [];
    case 'float': case 'double': case 'SInt8': case 'UInt8': case 'char': case 'SInt16': case 'short': case 'UInt16': case 'unsigned short':
    case 'SInt32': case 'int': case 'UInt32': case 'unsigned int': case 'Type*': case 'SInt64': case 'long long':
    case 'UInt64': case 'unsigned long long': case 'FileSize': return 0;
    default:
      if (isVector(nodes, i)) return isByteVector(nodes, ends, i) ? Buffer.alloc(0) : [];
      return Object.fromEntries(childIndexes(tree, i).map((j) => [nodes[j].name, defaultValue(tree, j)]));
  }
}

function childIndexes({ nodes, ends }, i) {
  const out = [];
  for (let j = i + 1; j < ends[i]; j = ends[j]) out.push(j);
  return out;
}

// Deterministic pseudo-random value with every container exercised (0-3 elements; short byte blobs and strings so that
// alignment padding is hit at every offset).
export function randomValue(tree, rng, i = 0) {
  const { nodes, ends } = tree;
  const n = nodes[i];
  const int = (lo, hi) => lo + Math.floor(rng() * (hi - lo + 1));
  switch (n.type) {
    case 'bool': return rng() < 0.5;
    case 'string': return Array.from({ length: int(0, 9) }, () => String.fromCharCode(int(97, 122))).join('');
    case 'TypelessData': return Buffer.from(Array.from({ length: int(0, 11) }, () => int(0, 255)));
    case 'map': return Array.from({ length: int(0, 2) }, () => randomValue(tree, rng, i + 3));
    case 'float': return Math.fround(int(-40, 40) * 0.25);
    case 'double': return int(-40, 40) * 0.5;
    case 'SInt8': return int(-128, 127);
    case 'UInt8': case 'char': return int(0, 255);
    case 'SInt16': case 'short': return int(-30000, 30000);
    case 'UInt16': case 'unsigned short': return int(0, 65535);
    case 'SInt32': case 'int': return int(-1000000, 1000000);
    case 'UInt32': case 'unsigned int': case 'Type*': return int(0, 2 ** 31);
    case 'SInt64': case 'long long': return int(-1e9, 1e9);
    case 'UInt64': case 'unsigned long long': case 'FileSize': return int(0, 1e9);
    default:
      if (isVector(nodes, i)) {
        if (isByteVector(nodes, ends, i)) return Buffer.from(Array.from({ length: int(0, 9) }, () => int(0, 255)));
        return Array.from({ length: int(0, 3) }, () => randomValue(tree, rng, i + 3));
      }
      return Object.fromEntries(childIndexes(tree, i).map((j) => [nodes[j].name, randomValue(tree, rng, j)]));
  }
}

function write(tree, value, w, i) {
  const { nodes, ends } = tree;
  const n = nodes[i];
  let align = (n.metaFlags & ALIGN) !== 0;
  switch (n.type) {
    case 'SInt8': case 'UInt8': case 'char': w.u8(value & 0xff); break;
    case 'bool': w.u8(value ? 1 : 0); break;
    case 'SInt16': case 'short': w.i16(value); break;
    case 'UInt16': case 'unsigned short': w.u16(value); break;
    case 'SInt32': case 'int': w.i32(value); break;
    case 'UInt32': case 'unsigned int': case 'Type*': w.u32(value); break;
    case 'SInt64': case 'long long': w.i64(value); break;
    case 'UInt64': case 'unsigned long long': case 'FileSize': w.u64(value); break;
    case 'float': w.f32(value); break;
    case 'double': { const b = Buffer.alloc(8); w.little ? b.writeDoubleLE(value) : b.writeDoubleBE(value); w.bytes(b); break; }
    case 'string': { const b = Buffer.from(value, 'utf8'); w.i32(b.length).bytes(b); align = true; break; }
    case 'TypelessData': w.i32(value.length).bytes(value); break;
    case 'map':
      if (nodes[i + 1] && (nodes[i + 1].metaFlags & ALIGN)) align = true;
      w.i32(value.length);
      for (const el of value) write(tree, el, w, i + 3);
      break;
    default:
      if (isVector(nodes, i)) {
        if (nodes[i + 1].metaFlags & ALIGN) align = true;
        w.i32(value.length);
        if (isByteVector(nodes, ends, i)) w.bytes(value);
        else for (const el of value) write(tree, el, w, i + 3);
      } else {
        for (const j of childIndexes(tree, i)) write(tree, value[nodes[j].name], w, j);
      }
  }
  if (align) w.align(4);
}

export function serializeObject(tree, value, little = true) {
  const w = new Writer(little);
  write(tree, value, w, 0);
  return w.toBuffer();
}

export function mergeDeep(base, over) {
  if (over === undefined) return base;
  if (base && over && typeof base === 'object' && typeof over === 'object' && !Array.isArray(base) && !Buffer.isBuffer(base)) {
    return Object.fromEntries(Object.keys(base).map((k) => [k, mergeDeep(base[k], over[k])]));
  }
  return over;
}

// small deterministic PRNG (mulberry32)
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
