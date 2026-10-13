import { BinaryReader } from './binaryReader.js';
import { lz4DecodeBlock } from './lz4.js';
import { lzmaDecode } from './lzma.js';
import { UnsupportedError } from './typeTree.js';

const COMP_NONE = 0, COMP_LZMA = 1, COMP_LZ4 = 2, COMP_LZ4HC = 3;
const FLAG_INFO_AT_END = 0x80;
const FLAG_PAD_AT_START = 0x200;
const MAX_TOTAL = 3 * 1024 ** 3; // refuse to inflate more than 3 GiB into memory

export function isUnityFs(buf) {
  return buf.length >= 8 && buf.toString('latin1', 0, 7) === 'UnityFS' && buf[7] === 0;
}

export function legacyBundleKind(buf) {
  const head = buf.toString('latin1', 0, 12);
  for (const sig of ['UnityWeb', 'UnityRaw', 'UnityArchive']) if (head.startsWith(sig)) return sig;
  return null;
}

function decompress(src, method, size) {
  switch (method) {
    case COMP_NONE: if (src.length !== size) throw new Error('stored block size mismatch'); return src;
    case COMP_LZMA: return lzmaDecode(src, size);
    case COMP_LZ4: case COMP_LZ4HC: return lz4DecodeBlock(src, size);
    default: throw new UnsupportedError(`unsupported bundle compression type ${method} (custom or encrypted bundle?)`);
  }
}

// Parses a UnityFS archive (format versions 6-8) fully into memory.
// Returns { version, unityVersion, unityRevision, files: [{ path, flags, data }] }.
export function parseUnityFs(buf) {
  if (!isUnityFs(buf)) throw new Error('not a UnityFS bundle');
  const r = new BinaryReader(buf, 0, false);
  r.cstring();
  const version = r.u32();
  const unityVersion = r.cstring();
  const unityRevision = r.cstring();
  const declaredSize = r.i64();
  const compressedInfoSize = r.u32();
  const uncompressedInfoSize = r.u32();
  const flags = r.u32();
  if (version < 6 || version > 8) throw new UnsupportedError(`unsupported UnityFS format version ${version}`);
  if (version >= 7) r.align(16);

  let infoStart;
  if (flags & FLAG_INFO_AT_END) {
    infoStart = buf.length - compressedInfoSize;
    if (infoStart < r.pos) throw new RangeError('blocks info overlaps header');
  } else {
    infoStart = r.pos;
  }
  if (infoStart + compressedInfoSize > buf.length) throw new RangeError('blocks info runs past end of file');
  if (uncompressedInfoSize > 64 * 1024 * 1024) throw new RangeError('implausible blocks info size');

  const info = decompress(buf.subarray(infoStart, infoStart + compressedInfoSize), flags & 0x3f, uncompressedInfoSize);
  const ir = new BinaryReader(info, 0, false);
  ir.bytes(16); // uncompressed data hash

  const blockCount = ir.i32();
  if (blockCount < 0 || blockCount > 1_000_000) throw new RangeError(`implausible block count ${blockCount}`);
  const blocks = [];
  let total = 0;
  for (let i = 0; i < blockCount; i++) {
    const b = { size: ir.u32(), compressed: ir.u32(), flags: ir.u16() };
    total += b.size;
    blocks.push(b);
  }
  if (total > MAX_TOTAL) throw new RangeError(`bundle would inflate to ${total} bytes (limit ${MAX_TOTAL})`);

  const nodeCount = ir.i32();
  if (nodeCount < 0 || nodeCount > 1_000_000) throw new RangeError(`implausible directory size ${nodeCount}`);
  const nodes = [];
  for (let i = 0; i < nodeCount; i++) {
    nodes.push({ offset: ir.i64(), size: ir.i64(), flags: ir.u32(), path: ir.cstring(1024) });
  }

  let dataPos = flags & FLAG_INFO_AT_END ? r.pos : infoStart + compressedInfoSize;
  if (flags & FLAG_PAD_AT_START) dataPos = Math.ceil(dataPos / 16) * 16;

  const data = Buffer.allocUnsafe(total);
  let inPos = dataPos;
  let outPos = 0;
  for (const b of blocks) {
    if (inPos + b.compressed > buf.length) throw new RangeError('block data runs past end of file');
    const chunk = decompress(buf.subarray(inPos, inPos + b.compressed), b.flags & 0x3f, b.size);
    chunk.copy(data, outPos);
    inPos += b.compressed;
    outPos += b.size;
  }

  const files = nodes.map((n) => {
    if (n.offset < 0 || n.size < 0 || n.offset + n.size > data.length) throw new RangeError(`directory entry "${n.path}" lies outside the data`);
    return { path: n.path, flags: n.flags, data: data.subarray(n.offset, n.offset + n.size) };
  });
  return { version, unityVersion, unityRevision, declaredSize, files };
}
