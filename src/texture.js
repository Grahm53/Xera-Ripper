import { UnsupportedError } from './typeTree.js';
import { encodePng } from './png.js';

export const TEXTURE_FORMATS = {
  1: 'Alpha8', 2: 'ARGB4444', 3: 'RGB24', 4: 'RGBA32', 5: 'ARGB32', 7: 'RGB565', 9: 'R16', 10: 'DXT1', 12: 'DXT5',
  13: 'RGBA4444', 14: 'BGRA32', 15: 'RHalf', 16: 'RGHalf', 17: 'RGBAHalf', 18: 'RFloat', 19: 'RGFloat', 20: 'RGBAFloat',
  21: 'YUY2', 22: 'RGB9e5Float', 24: 'BC6H', 25: 'BC7', 26: 'BC4', 27: 'BC5', 28: 'DXT1Crunched', 29: 'DXT5Crunched',
  30: 'PVRTC_RGB2', 31: 'PVRTC_RGBA2', 32: 'PVRTC_RGB4', 33: 'PVRTC_RGBA4', 34: 'ETC_RGB4', 41: 'EAC_R', 42: 'EAC_R_SIGNED',
  43: 'EAC_RG', 44: 'EAC_RG_SIGNED', 45: 'ETC2_RGB', 46: 'ETC2_RGBA1', 47: 'ETC2_RGBA8',
  48: 'ASTC_4x4', 49: 'ASTC_5x5', 50: 'ASTC_6x6', 51: 'ASTC_8x8', 52: 'ASTC_10x10', 53: 'ASTC_12x12',
  54: 'ASTC_RGBA_4x4', 55: 'ASTC_RGBA_5x5', 56: 'ASTC_RGBA_6x6', 57: 'ASTC_RGBA_8x8', 58: 'ASTC_RGBA_10x10', 59: 'ASTC_RGBA_12x12',
  63: 'R8', 64: 'ETC_RGB4Crunched', 65: 'ETC2_RGBA8Crunched',
  66: 'ASTC_HDR_4x4', 67: 'ASTC_HDR_5x5', 68: 'ASTC_HDR_6x6', 69: 'ASTC_HDR_8x8', 70: 'ASTC_HDR_10x10', 71: 'ASTC_HDR_12x12',
};
export const formatName = (f) => TEXTURE_FORMATS[f] ?? `TextureFormat_${f}`;

const MAX_PIXELS = 16384 * 16384;

// Linear (uncompressed) formats: bytes per pixel and a per-pixel converter writing RGBA into `o`.
const LINEAR = {
  1: { bpp: 1, px: (d, i, o, j) => { o[j] = 255; o[j + 1] = 255; o[j + 2] = 255; o[j + 3] = d[i]; } },                          // Alpha8
  63: { bpp: 1, px: (d, i, o, j) => { o[j] = d[i]; o[j + 1] = 0; o[j + 2] = 0; o[j + 3] = 255; } },                             // R8
  9: { bpp: 2, px: (d, i, o, j) => { o[j] = d[i + 1]; o[j + 1] = 0; o[j + 2] = 0; o[j + 3] = 255; } },                        // R16 (high byte, red channel like R8)
  3: { bpp: 3, px: (d, i, o, j) => { o[j] = d[i]; o[j + 1] = d[i + 1]; o[j + 2] = d[i + 2]; o[j + 3] = 255; } },               // RGB24
  4: { bpp: 4, px: (d, i, o, j) => { o[j] = d[i]; o[j + 1] = d[i + 1]; o[j + 2] = d[i + 2]; o[j + 3] = d[i + 3]; } },           // RGBA32
  5: { bpp: 4, px: (d, i, o, j) => { o[j] = d[i + 1]; o[j + 1] = d[i + 2]; o[j + 2] = d[i + 3]; o[j + 3] = d[i]; } },           // ARGB32
  14: { bpp: 4, px: (d, i, o, j) => { o[j] = d[i + 2]; o[j + 1] = d[i + 1]; o[j + 2] = d[i]; o[j + 3] = d[i + 3]; } },          // BGRA32
  7: { bpp: 2, px: (d, i, o, j) => {                                                                                              // RGB565
    const v = d[i] | (d[i + 1] << 8);
    rgb565(v, o, j); o[j + 3] = 255;
  } },
  13: { bpp: 2, px: (d, i, o, j) => {                                                                                             // RGBA4444
    const v = d[i] | (d[i + 1] << 8);
    o[j] = ((v >> 12) & 15) * 17; o[j + 1] = ((v >> 8) & 15) * 17; o[j + 2] = ((v >> 4) & 15) * 17; o[j + 3] = (v & 15) * 17;
  } },
  2: { bpp: 2, px: (d, i, o, j) => {                                                                                              // ARGB4444
    const v = d[i] | (d[i + 1] << 8);
    o[j + 3] = ((v >> 12) & 15) * 17; o[j] = ((v >> 8) & 15) * 17; o[j + 1] = ((v >> 4) & 15) * 17; o[j + 2] = (v & 15) * 17;
  } },
};

// 5/6/5 -> 8/8/8 by bit replication, exactly as GPUs and the common reference decoders do.
function rgb565(v, out, k) {
  const r = (v >> 11) & 31, g = (v >> 5) & 63, b = v & 31;
  out[k] = (r << 3) | (r >> 2);
  out[k + 1] = (g << 2) | (g >> 4);
  out[k + 2] = (b << 3) | (b >> 2);
}

// One BC1 colour block -> 4 palette entries (RGBA). `forceFour` is true for DXT3/5 colour halves, which never use 1-bit alpha.
function bc1Palette(d, off, forceFour) {
  const c0 = d[off] | (d[off + 1] << 8);
  const c1 = d[off + 2] | (d[off + 3] << 8);
  const p = new Uint8Array(16);
  rgb565(c0, p, 0); rgb565(c1, p, 4);
  p[3] = 255; p[7] = 255;
  if (c0 > c1 || forceFour) {
    for (let k = 0; k < 3; k++) {
      p[8 + k] = ((2 * p[k] + p[4 + k]) / 3) | 0;
      p[12 + k] = ((p[k] + 2 * p[4 + k]) / 3) | 0;
    }
    p[11] = 255; p[15] = 255;
  } else {
    // Unity's DXT1 is an RGB format: the 1-bit-alpha "transparent" index is decoded as opaque black (as other decoders do).
    for (let k = 0; k < 3; k++) { p[8 + k] = ((p[k] + p[4 + k]) / 2) | 0; p[12 + k] = 0; }
    p[11] = 255; p[15] = 255;
  }
  return p;
}

function decodeBlocks(data, width, height, blockBytes, decodeBlock) {
  const bw = Math.ceil(width / 4);
  const bh = Math.ceil(height / 4);
  if (data.length < bw * bh * blockBytes) throw new RangeError('compressed texture data is truncated');
  const out = Buffer.alloc(width * height * 4);
  for (let by = 0; by < bh; by++) {
    for (let bx = 0; bx < bw; bx++) {
      const block = decodeBlock(data, (by * bw + bx) * blockBytes); // 16 RGBA pixels, row-major
      for (let y = 0; y < 4 && by * 4 + y < height; y++) {
        for (let x = 0; x < 4 && bx * 4 + x < width; x++) {
          const s = (y * 4 + x) * 4;
          const t = ((by * 4 + y) * width + bx * 4 + x) * 4;
          out[t] = block[s]; out[t + 1] = block[s + 1]; out[t + 2] = block[s + 2]; out[t + 3] = block[s + 3];
        }
      }
    }
  }
  return out;
}

function dxt1Block(d, off) {
  const pal = bc1Palette(d, off, false);
  const bits = d.readUInt32LE(off + 4);
  const px = new Uint8Array(64);
  for (let i = 0; i < 16; i++) {
    const idx = (bits >>> (2 * i)) & 3;
    px[i * 4] = pal[idx * 4]; px[i * 4 + 1] = pal[idx * 4 + 1]; px[i * 4 + 2] = pal[idx * 4 + 2]; px[i * 4 + 3] = pal[idx * 4 + 3];
  }
  return px;
}

function dxt5Block(d, off) {
  const a0 = d[off], a1 = d[off + 1];
  const alpha = [a0, a1];
  if (a0 > a1) for (let k = 1; k <= 6; k++) alpha.push(((7 - k) * a0 + k * a1) / 7 | 0);
  else { for (let k = 1; k <= 4; k++) alpha.push(((5 - k) * a0 + k * a1) / 5 | 0); alpha.push(0, 255); }
  // 48 bits of 3-bit indices, little-endian
  const lo = d.readUInt32LE(off + 2);
  const hi = d.readUInt16LE(off + 6);
  const bits = BigInt(lo) | (BigInt(hi) << 32n);
  const pal = bc1Palette(d, off + 8, true);
  const cbits = d.readUInt32LE(off + 12);
  const px = new Uint8Array(64);
  for (let i = 0; i < 16; i++) {
    const ci = (cbits >>> (2 * i)) & 3;
    px[i * 4] = pal[ci * 4]; px[i * 4 + 1] = pal[ci * 4 + 1]; px[i * 4 + 2] = pal[ci * 4 + 2];
    px[i * 4 + 3] = alpha[Number((bits >> BigInt(3 * i)) & 7n)];
  }
  return px;
}

// Returns RGBA pixels (top row first) for the largest mip of a Unity texture.
export function decodeTexture(width, height, format, data) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0 || width * height > MAX_PIXELS) {
    throw new RangeError(`implausible texture size ${width}x${height}`);
  }
  let rgba;
  const lin = LINEAR[format];
  if (lin) {
    if (data.length < width * height * lin.bpp) throw new RangeError('texture data is truncated');
    rgba = Buffer.alloc(width * height * 4);
    for (let p = 0, i = 0, j = 0; p < width * height; p++, i += lin.bpp, j += 4) lin.px(data, i, rgba, j);
  } else if (format === 10) {
    rgba = decodeBlocks(data, width, height, 8, dxt1Block);
  } else if (format === 12) {
    rgba = decodeBlocks(data, width, height, 16, dxt5Block);
  } else {
    throw new UnsupportedError(`texture format ${formatName(format)} is not supported yet`);
  }
  // Unity stores rows bottom-up.
  const stride = width * 4;
  const flipped = Buffer.alloc(rgba.length);
  for (let y = 0; y < height; y++) rgba.copy(flipped, y * stride, (height - 1 - y) * stride, (height - y) * stride);
  return flipped;
}

export function textureToPng(width, height, format, data) {
  return encodePng(width, height, decodeTexture(width, height, format, data));
}
