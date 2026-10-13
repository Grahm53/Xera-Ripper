// Test-only PNG decoder for the exact subset our encoder emits (8-bit RGBA, filter 0), with chunk CRC verification.
import { inflateSync } from 'node:zlib';
import { crc32 } from '../../src/crc32.js';

export function decodePng(buf) {
  if (!buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) throw new Error('bad PNG signature');
  let p = 8;
  let width = 0, height = 0;
  const idat = [];
  while (p < buf.length) {
    const len = buf.readUInt32BE(p);
    const type = buf.toString('latin1', p + 4, p + 8);
    const body = buf.subarray(p + 8, p + 8 + len);
    if (buf.readUInt32BE(p + 8 + len) !== crc32(buf.subarray(p + 4, p + 8 + len))) throw new Error(`bad CRC in ${type}`);
    if (type === 'IHDR') { width = body.readUInt32BE(0); height = body.readUInt32BE(4); if (body[8] !== 8 || body[9] !== 6) throw new Error('unexpected PNG format'); }
    if (type === 'IDAT') idat.push(body);
    p += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * 4;
  const rgba = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    if (raw[y * (stride + 1)] !== 0) throw new Error('unexpected filter');
    raw.copy(rgba, y * stride, y * (stride + 1) + 1, (y + 1) * (stride + 1));
  }
  return { width, height, rgba };
}
