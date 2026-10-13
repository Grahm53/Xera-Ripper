import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeTexture, textureToPng, formatName } from '../src/texture.js';
import { encodePng } from '../src/png.js';
import { UnsupportedError } from '../src/typeTree.js';
import { decodePng } from './helpers/pngdecode.js';

const px = (rgba, w, x, y) => [...rgba.subarray((y * w + x) * 4, (y * w + x) * 4 + 4)];

test('png: encode -> independent decode round-trips and CRCs verify', () => {
  const rgba = Buffer.from(Array.from({ length: 5 * 3 * 4 }, (_, i) => (i * 37) & 0xff));
  const out = decodePng(encodePng(5, 3, rgba));
  assert.equal(out.width, 5);
  assert.equal(out.height, 3);
  assert.deepEqual(out.rgba, rgba);
  assert.throws(() => encodePng(2, 2, Buffer.alloc(3)), /does not match/);
});

test('linear formats decode and Unity bottom-up rows are flipped', () => {
  // 2x2, rows stored bottom-first: bottom = red,green ; top = blue,white
  const rgba32 = Buffer.from([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 128]);
  const out = decodeTexture(2, 2, 4, rgba32);
  assert.deepEqual(px(out, 2, 0, 0), [0, 0, 255, 255]);   // top-left is the *second* stored row
  assert.deepEqual(px(out, 2, 1, 0), [255, 255, 255, 128]);
  assert.deepEqual(px(out, 2, 0, 1), [255, 0, 0, 255]);
  assert.deepEqual(px(out, 2, 1, 1), [0, 255, 0, 255]);
});

test('RGB24 / ARGB32 / BGRA32 / Alpha8 / R8 channel orders', () => {
  assert.deepEqual(px(decodeTexture(1, 1, 3, Buffer.from([1, 2, 3])), 1, 0, 0), [1, 2, 3, 255]);
  assert.deepEqual(px(decodeTexture(1, 1, 5, Buffer.from([9, 1, 2, 3])), 1, 0, 0), [1, 2, 3, 9]);
  assert.deepEqual(px(decodeTexture(1, 1, 14, Buffer.from([3, 2, 1, 9])), 1, 0, 0), [1, 2, 3, 9]);
  assert.deepEqual(px(decodeTexture(1, 1, 1, Buffer.from([77])), 1, 0, 0), [255, 255, 255, 77]);
  assert.deepEqual(px(decodeTexture(1, 1, 63, Buffer.from([77])), 1, 0, 0), [77, 0, 0, 255]);
});

test('16-bit formats expand to 8-bit correctly', () => {
  const le = (v) => Buffer.from([v & 0xff, v >> 8]);
  assert.deepEqual(px(decodeTexture(1, 1, 7, le(0xf800)), 1, 0, 0), [255, 0, 0, 255]);   // RGB565 red
  assert.deepEqual(px(decodeTexture(1, 1, 7, le(0x07e0)), 1, 0, 0), [0, 255, 0, 255]);   // green
  assert.deepEqual(px(decodeTexture(1, 1, 7, le(0x001f)), 1, 0, 0), [0, 0, 255, 255]);   // blue
  assert.deepEqual(px(decodeTexture(1, 1, 13, le(0xf00f)), 1, 0, 0), [255, 0, 0, 255]);  // RGBA4444 red, opaque
  assert.deepEqual(px(decodeTexture(1, 1, 2, le(0xf00f)), 1, 0, 0), [0, 0, 255, 255]);   // ARGB4444: A=f R=0 G=0 B=f
});

const dxt1Block = (c0, c1, indexRowByte) => {
  const b = Buffer.alloc(8);
  b.writeUInt16LE(c0, 0); b.writeUInt16LE(c1, 2);
  b.fill(indexRowByte, 4, 8);
  return b;
};

test('DXT1: 4-colour mode interpolation', () => {
  // each row of indices = 0,1,2,3 -> byte 0b11100100
  const out = decodeTexture(4, 4, 10, dxt1Block(0xf800, 0x001f, 0xe4));
  assert.deepEqual(px(out, 4, 0, 0), [255, 0, 0, 255]);
  assert.deepEqual(px(out, 4, 1, 0), [0, 0, 255, 255]);
  assert.deepEqual(px(out, 4, 2, 0), [170, 0, 85, 255]);
  assert.deepEqual(px(out, 4, 3, 0), [85, 0, 170, 255]);
});

test('DXT1: 3-colour mode; index 3 is opaque black (Unity DXT1 is an RGB format)', () => {
  const out = decodeTexture(4, 4, 10, dxt1Block(0x001f, 0xf800, 0xe4));
  assert.deepEqual(px(out, 4, 2, 3), [127, 0, 127, 255]); // (0+255)/2 truncated, like GPUs and reference decoders
  assert.deepEqual(px(out, 4, 3, 3), [0, 0, 0, 255]);
});

test('DXT1: non-multiple-of-4 sizes are cropped, not misread', () => {
  const blocks = Buffer.concat([dxt1Block(0xf800, 0xf800, 0), dxt1Block(0x001f, 0x001f, 0)]); // 5x3 -> 2x1 blocks
  const out = decodeTexture(5, 3, 10, blocks);
  assert.equal(out.length, 5 * 3 * 4);
  assert.deepEqual(px(out, 5, 3, 1), [255, 0, 0, 255]);
  assert.deepEqual(px(out, 5, 4, 2), [0, 0, 255, 255]);
});

function dxt5Block(a0, a1, alphaIdx, color) {
  let bits = 0n;
  for (let i = 0; i < 16; i++) bits |= BigInt(alphaIdx[i]) << BigInt(3 * i);
  const b = Buffer.alloc(16);
  b[0] = a0; b[1] = a1;
  for (let k = 0; k < 6; k++) b[2 + k] = Number((bits >> BigInt(8 * k)) & 0xffn);
  b.writeUInt16LE(color, 8); b.writeUInt16LE(color, 10);
  return b;
}

test('DXT5: 8-step alpha ramp and 6-step alpha with 0/255 endpoints', () => {
  const idx = Array.from({ length: 16 }, (_, i) => i % 8);
  const out = decodeTexture(4, 4, 12, dxt5Block(255, 0, idx, 0xffff));
  // a0>a1 palette (integer division): [255, 0, 218, 182, 145, 109, 72, 36]; the top output row is stored row 3 = codes 4,5,6,7
  assert.deepEqual([0, 1, 2, 3].map((x) => px(out, 4, x, 0)[3]), [145, 109, 72, 36]);
  assert.deepEqual([0, 1, 2, 3].map((x) => px(out, 4, x, 3)[3]), [255, 0, 218, 182]); // bottom row = stored row 0 = codes 0..3
  assert.deepEqual(px(out, 4, 0, 0).slice(0, 3), [255, 255, 255]);
  const out2 = decodeTexture(4, 4, 12, dxt5Block(0, 255, idx, 0xffff));
  // a0<=a1 palette: [0, 255, 51, 102, 153, 204, 0, 255]; codes 4,5,6,7 on the top row
  assert.deepEqual([0, 1, 2, 3].map((x) => px(out2, 4, x, 0)[3]), [153, 204, 0, 255]);
});

test('unsupported and truncated data fail loudly', () => {
  assert.throws(() => decodeTexture(4, 4, 50, Buffer.alloc(64)), UnsupportedError);
  assert.throws(() => decodeTexture(4, 4, 50, Buffer.alloc(64)), /ASTC_6x6/);
  assert.throws(() => decodeTexture(4, 4, 4, Buffer.alloc(10)), /truncated/);
  assert.throws(() => decodeTexture(8, 8, 10, Buffer.alloc(8)), /truncated/);
  assert.throws(() => decodeTexture(0, 4, 4, Buffer.alloc(0)), /implausible/);
  assert.throws(() => decodeTexture(100000, 100000, 4, Buffer.alloc(0)), /implausible/);
  assert.equal(formatName(48), 'ASTC_4x4');
  assert.equal(formatName(9999), 'TextureFormat_9999');
});

test('textureToPng produces a decodable PNG', () => {
  const png = textureToPng(2, 1, 4, Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]));
  assert.deepEqual([...decodePng(png).rgba], [1, 2, 3, 4, 5, 6, 7, 8]);
});
