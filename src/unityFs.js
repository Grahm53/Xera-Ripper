import { BinaryReader, sizeNumber } from './binaryReader.js';
import { lz4DecodeBlock } from './lz4.js';
import { lzmaDecode } from './lzma.js';
import { UnsupportedError } from './typeTree.js';

const COMP_NONE = 0, COMP_LZMA = 1, COMP_LZ4 = 2, COMP_LZ4HC = 3;
const FLAG_INFO_AT_END = 0x80;
const FLAG_BIT_0X200 = 0x200;
const FLAG_ENCRYPTED_NEW = 0x1400; // Unity 2020.3.34+/2021.3.2+/2022.1.1+: 0x400 (CN) or 0x1000
const MAX_TOTAL = 3 * 1024 ** 3; // refuse to inflate more than 3 GiB into memory

export function isUnityFs(buf) {
  return buf.length >= 8 && buf.toString('latin1', 0, 7) === 'UnityFS' && buf[7] === 0;
}

export function legacyBundleKind(buf) {
  const head = buf.toString('latin1', 0, 12);
  for (const sig of ['UnityWeb', 'UnityRaw', 'UnityArchive']) if (head.startsWith(sig)) return sig;
  return null;
}

// "2019.4.31f1" -> [2019, 4, 31]; null when the revision string is not a Unity version (treated as modern).
export function parseUnityRevision(s) {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(s ?? '');
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}
const cmp = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

// The meaning of header flag 0x200 changed: in older Unity (and always in Unity CN) it marks an ENCRYPTED bundle,
// from 2020.3.34 / 2021.3.2 / 2022.1.1 on it means "block info needs 16-byte padding".
function usesOldFlagSet(v) {
  if (!v) return false;
  if (v[0] < 2020) return true;
  if (v[0] === 2020) return cmp(v, [2020, 3, 34]) < 0;
  if (v[0] === 2021) return cmp(v, [2021, 3, 2]) < 0;
  if (v[0] === 2022) return cmp(v, [2022, 1, 1]) < 0;
  return false;
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
  const declaredSize = sizeNumber(r.i64(), 'bundle size');
  const compressedInfoSize = r.u32();
  const uncompressedInfoSize = r.u32();
  const flags = r.u32();
  if (version < 6 || version > 8) throw new UnsupportedError(`unsupported UnityFS format version ${version}`);

  const rev = parseUnityRevision(unityRevision);
  const oldFlags = usesOldFlagSet(rev);
  const encrypted = oldFlags ? (flags & FLAG_BIT_0X200) !== 0 : (flags & FLAG_ENCRYPTED_NEW) !== 0;
  if (encrypted) throw new UnsupportedError('bundle is encrypted (Unity CN / custom asset bundle encryption); it cannot be read without the game\'s key');
  const padAtStart = !oldFlags && (flags & FLAG_BIT_0X200) !== 0;

  // Format 7+ aligns the header to 16 bytes; Unity 2019.4.15+ does too even when it still writes format 6.
  if (version >= 7 || (rev && rev[0] === 2019 && cmp(rev, [2019, 4, 15]) >= 0)) r.align(16);

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
    nodes.push({ offset: sizeNumber(ir.i64(), 'entry offset'), size: sizeNumber(ir.i64(), 'entry size'), flags: ir.u32(), path: ir.cstring(1024) });
  }

  let dataPos = flags & FLAG_INFO_AT_END ? r.pos : infoStart + compressedInfoSize;
  if (padAtStart) dataPos = Math.ceil(dataPos / 16) * 16;

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
