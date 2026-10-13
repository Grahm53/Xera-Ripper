// Test-only writers that emit Unity-format byte streams (type-tree blobs, serialized files, UnityFS bundles).
import { COMMON_OFFSETS } from '../../src/commonStrings.js';
import { lz4EncodeBlock } from './lz4enc.js';

export class Writer {
  constructor(little = true) { this.little = little; this.parts = []; this.len = 0; }
  _push(b) { this.parts.push(b); this.len += b.length; return this; }
  u8(v) { return this._push(Buffer.from([v & 0xff])); }
  u16(v) { const b = Buffer.alloc(2); this.little ? b.writeUInt16LE(v) : b.writeUInt16BE(v); return this._push(b); }
  i16(v) { const b = Buffer.alloc(2); this.little ? b.writeInt16LE(v) : b.writeInt16BE(v); return this._push(b); }
  u32(v) { const b = Buffer.alloc(4); this.little ? b.writeUInt32LE(v) : b.writeUInt32BE(v); return this._push(b); }
  i32(v) { const b = Buffer.alloc(4); this.little ? b.writeInt32LE(v) : b.writeInt32BE(v); return this._push(b); }
  f32(v) { const b = Buffer.alloc(4); this.little ? b.writeFloatLE(v) : b.writeFloatBE(v); return this._push(b); }
  i64(v) { const b = Buffer.alloc(8); this.little ? b.writeBigInt64LE(BigInt(v)) : b.writeBigInt64BE(BigInt(v)); return this._push(b); }
  u64(v) { const b = Buffer.alloc(8); this.little ? b.writeBigUInt64LE(BigInt(v)) : b.writeBigUInt64BE(BigInt(v)); return this._push(b); }
  bytes(buf) { return this._push(Buffer.from(buf)); }
  cstring(s) { return this._push(Buffer.concat([Buffer.from(s, 'utf8'), Buffer.from([0])])); }
  align(n) { const rem = this.len % n; return rem ? this._push(Buffer.alloc(n - rem)) : this; }
  // Unity `string`: int32 length, bytes, pad to 4.
  string(s) { const b = Buffer.isBuffer(s) ? s : Buffer.from(s, 'utf8'); this.i32(b.length).bytes(b); return this.align(4); }
  toBuffer() { return Buffer.concat(this.parts); }
}

// ---- type trees -------------------------------------------------------------------------------------------------
export const ALIGN = 0x4000;
export const node = (level, type, name, metaFlags = 0) => ({ level, type, name, metaFlags });
export const stringNodes = (level, name) => [
  node(level, 'string', name, ALIGN), node(level + 1, 'Array', 'Array', ALIGN),
  node(level + 2, 'int', 'size'), node(level + 2, 'char', 'data'),
];
export const typelessNodes = (level, name) => [node(level, 'TypelessData', name), node(level + 1, 'int', 'size'), node(level + 1, 'UInt8', 'data')];

export const TEXTURE2D_TREE = [
  node(0, 'Texture2D', 'Base'),
  ...stringNodes(1, 'm_Name'),
  node(1, 'int', 'm_Width'), node(1, 'int', 'm_Height'), node(1, 'int', 'm_CompleteImageSize'), node(1, 'int', 'm_TextureFormat'),
  ...typelessNodes(1, 'image data'),
  node(1, 'StreamingInfo', 'm_StreamData'),
  node(2, 'UInt64', 'offset'), node(2, 'unsigned int', 'size'), ...stringNodes(2, 'path'),
];
export const TEXTASSET_TREE = [node(0, 'TextAsset', 'Base'), ...stringNodes(1, 'm_Name'), ...stringNodes(1, 'm_Script')];
export const AUDIOCLIP_TREE = [
  node(0, 'AudioClip', 'Base'), ...stringNodes(1, 'm_Name'),
  node(1, 'int', 'm_LoadType'), node(1, 'int', 'm_Channels'), node(1, 'int', 'm_Frequency'),
  node(1, 'bool', 'm_IsTrackerFormat'), node(1, 'bool', 'm_Legacy3D', ALIGN), // two bools, aligned once after the second
  node(1, 'StreamedResource', 'm_Resource'),
  ...stringNodes(2, 'm_Source'), node(2, 'UInt64', 'm_Offset'), node(2, 'UInt64', 'm_Size'),
  node(1, 'int', 'm_CompressionFormat'),
];
// vector<int>, map<string,int>, nested struct, vector<struct>, float: exercises every branch of the value reader.
export const GENERIC_TREE = [
  node(0, 'Generic', 'Base'),
  node(1, 'vector', 'm_Ints'), node(2, 'Array', 'Array', ALIGN), node(3, 'int', 'size'), node(3, 'int', 'data'),
  node(1, 'map', 'm_Map'), node(2, 'Array', 'Array', ALIGN), node(3, 'int', 'size'),
  node(3, 'pair', 'data'), ...stringNodes(4, 'first'), node(4, 'int', 'second'),
  node(1, 'Vector3f', 'm_Pos'), node(2, 'float', 'x'), node(2, 'float', 'y'), node(2, 'float', 'z'),
  node(1, 'vector', 'm_Bytes'), node(2, 'Array', 'Array', ALIGN), node(3, 'int', 'size'), node(3, 'UInt8', 'data'),
  node(1, 'bool', 'm_Flag', ALIGN),
  node(1, 'int', 'm_Tail'),
];

export function typeTreeBlob(nodes, serializedVersion, little = true) {
  const local = [];
  let localLen = 0;
  const strOff = (s) => {
    if (COMMON_OFFSETS.has(s)) return (0x80000000 | COMMON_OFFSETS.get(s)) >>> 0;
    const off = localLen;
    const b = Buffer.concat([Buffer.from(s), Buffer.from([0])]);
    local.push(b);
    localLen += b.length;
    return off;
  };
  const rows = nodes.map((n, index) => ({ n, index, t: strOff(n.type), nm: strOff(n.name) }));
  // string offsets are assigned while mapping above, so localLen is final by the time the header is written
  const w2 = new Writer(little);
  w2.i32(nodes.length).i32(localLen);
  for (const { n, index, t, nm } of rows) {
    w2.u16(1).u8(n.level).u8(0).u32(t).u32(nm).i32(-1).i32(index).i32(n.metaFlags);
    if (serializedVersion >= 19) w2.u64(0);
  }
  w2.bytes(Buffer.concat(local));
  return w2.toBuffer();
}

// ---- serialized file --------------------------------------------------------------------------------------------
// opts: { version, unityVersion, platform, little, enableTypeTree, types:[{classId, tree|null}], objects:[{pathId, typeIndex, data}] }
export function buildSerializedFile(opts) {
  const {
    version = 19, unityVersion = '2019.4.31f1', platform = 13, little = true, enableTypeTree = true, types, objects,
    externals = ['Library/unity default resources'],
  } = opts;
  const m = new Writer(little);
  // metadata starts right after the header; alignment inside it is relative to the start of the FILE, so we
  // track an absolute base offset equal to the header length.
  const headerLen = version >= 22 ? 48 : 20;
  const meta = new Writer(little);
  const abs = () => headerLen + meta.len;
  const alignAbs = (n) => { const rem = abs() % n; if (rem) meta.bytes(Buffer.alloc(n - rem)); };

  meta.cstring(unityVersion);
  meta.i32(platform);
  if (version >= 13) meta.u8(enableTypeTree ? 1 : 0);
  meta.i32(types.length);
  for (const t of types) {
    meta.i32(t.classId);
    if (version >= 16) meta.u8(0);
    if (version >= 17) meta.i16(-1);
    if (version >= 13) {
      if (version >= 16 && t.classId === 114) meta.bytes(Buffer.alloc(16, 0xab));
      meta.bytes(Buffer.alloc(16, 0xcd));
    }
    if (enableTypeTree) {
      meta.bytes(typeTreeBlob(t.tree, version, little));
      if (version >= 21) meta.i32(0); // type dependencies
    }
  }
  meta.i32(objects.length);
  // object data layout (8-aligned inside the data section)
  let dataLen = 0;
  const placed = objects.map((o) => {
    while (dataLen % 8) dataLen++;
    const start = dataLen;
    dataLen += o.data.length;
    return { ...o, start };
  });
  for (const o of placed) {
    if (version >= 14) alignAbs(4);
    version >= 14 ? meta.i64(o.pathId) : meta.i32(o.pathId);
    version >= 22 ? meta.i64(o.start) : meta.u32(o.start);
    meta.u32(o.data.length);
    meta.i32(o.typeIndex);
    if (version < 16) meta.u16(types[o.typeIndex].classId);
    if (version >= 11 && version < 17) meta.i16(-1);
    if (version === 15 || version === 16) meta.u8(0);
  }
  if (version >= 11) { meta.i32(0); } // script types
  meta.i32(externals.length); // externals
  for (const path of externals) {
    meta.cstring('');
    meta.bytes(Buffer.alloc(16)); meta.i32(0);
    meta.cstring(path);
  }
  if (version >= 20) meta.i32(0);      // ref types
  if (version >= 5) meta.cstring('');  // user information

  let dataOffset = headerLen + meta.len;
  dataOffset = Math.ceil(dataOffset / 16) * 16;
  const pad = Buffer.alloc(dataOffset - headerLen - meta.len);
  const dataSection = Buffer.alloc(dataLen);
  for (const o of placed) o.data.copy(dataSection, o.start);
  const fileSize = dataOffset + dataLen;

  const h = new Writer(false);
  h.u32(meta.len + pad.length).u32(fileSize).u32(version).u32(dataOffset);
  h.u8(little ? 0 : 1).bytes(Buffer.alloc(3));
  if (version >= 22) { h.u32(meta.len + pad.length).i64(fileSize).i64(dataOffset).i64(0); }
  return Buffer.concat([h.toBuffer(), meta.toBuffer(), pad, dataSection]);
}

// ---- object payload helpers (hand-written byte layouts, independent of the parser) ----------------------------------
export function texture2DData({ name = 'tex', width, height, format, image = Buffer.alloc(0), stream = { offset: 0, size: 0, path: '' } }) {
  const w = new Writer(true);
  w.string(name).i32(width).i32(height).i32(image.length).i32(format);
  w.i32(image.length).bytes(image).align(4);
  w.u64(stream.offset).u32(stream.size).string(stream.path);
  return w.toBuffer();
}
export const textAssetData = (name, script, little = true) => new Writer(little).string(name).string(script).toBuffer();
export function audioClipData({ name = 'clip', source = '', offset = 0, size = 0 }) {
  const w = new Writer(true);
  w.string(name).i32(0).i32(2).i32(48000);
  w.u8(0).u8(1).align(4); // two bools then padding
  w.string(source).u64(offset).u64(size).i32(1);
  return w.toBuffer();
}

// ---- UnityFS bundle ---------------------------------------------------------------------------------------------
// opts: { version=7, compression:'none'|'lz4', infoCompression:'none'|'lz4', infoAtEnd=false, pad=false, blockSize=64, files:[{path, data, serialized}] }
export function buildUnityFs(opts) {
  const {
    version = 7, revision = '2021.3.10f1', compression = 'none', infoCompression = 'none', infoAtEnd = false, pad = false, blockSize = 64,
    alignHeader = version >= 7, files,
  } = opts;
  const comp = (name) => ({ none: 0, lzma: 1, lz4: 2 }[name]);

  const all = Buffer.concat(files.map((f) => f.data));
  const blocks = [];
  const dataParts = [];
  for (let i = 0; i < all.length; i += blockSize) {
    const raw = all.subarray(i, i + blockSize);
    const packed = compression === 'lz4' ? lz4EncodeBlock(raw) : raw;
    // keep stored when "compression" would not help, as Unity does (flag 0 for that block)
    const useLz4 = compression === 'lz4' && packed.length < raw.length;
    const out = useLz4 ? packed : raw;
    blocks.push({ size: raw.length, compressed: out.length, flags: useLz4 ? 2 : 0 });
    dataParts.push(out);
  }
  const info = new Writer(false);
  info.bytes(Buffer.alloc(16, 7)).i32(blocks.length);
  for (const b of blocks) info.u32(b.size).u32(b.compressed).u16(b.flags);
  info.i32(files.length);
  let offset = 0;
  for (const f of files) {
    info.i64(offset).i64(f.data.length).u32(f.serialized ? 4 : 0).cstring(f.path);
    offset += f.data.length;
  }
  const infoRaw = info.toBuffer();
  const infoPacked = infoCompression === 'lz4' ? lz4EncodeBlock(infoRaw) : infoRaw;

  let flags = comp(infoCompression);
  if (infoAtEnd) flags |= 0x80;
  if (pad) flags |= 0x200;

  const dataBuf = Buffer.concat(dataParts);
  const head = new Writer(false);
  head.cstring('UnityFS').u32(version).cstring('5.x.x').cstring(revision);
  const sizeFieldPos = head.len;
  head.i64(0).u32(infoPacked.length).u32(infoRaw.length).u32(flags);
  if (alignHeader) head.align(16);

  let body;
  if (infoAtEnd) {
    const pre = head.toBuffer();
    body = Buffer.concat([pre, dataBuf, infoPacked]);
  } else {
    let pre = Buffer.concat([head.toBuffer(), infoPacked]);
    if (pad) pre = Buffer.concat([pre, Buffer.alloc((16 - (pre.length % 16)) % 16)]);
    body = Buffer.concat([pre, dataBuf]);
  }
  body.writeBigInt64BE(BigInt(body.length), sizeFieldPos);
  return body;
}
