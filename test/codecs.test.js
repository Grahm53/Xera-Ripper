import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { lz4DecodeBlock } from '../src/lz4.js';
import { lzmaDecode } from '../src/lzma.js';
import { lz4EncodeBlock } from './helpers/lz4enc.js';

test('lz4: round-trips text, runs and incompressible data', () => {
  const samples = [
    Buffer.from('hello hello hello hello hello world'),
    Buffer.alloc(5000, 0x61),                                   // long overlapping run (offset 1)
    Buffer.from(Array.from({ length: 3000 }, (_, i) => (i * 131 + (i >> 3)) & 0xff)),
    Buffer.from('x'),
    Buffer.alloc(0),
  ];
  for (const s of samples) assert.deepEqual(lz4DecodeBlock(lz4EncodeBlock(s), s.length), s);
});

test('lz4: known literal-only block', () => {
  assert.deepEqual(lz4DecodeBlock(Buffer.from([0x50, 0x68, 0x65, 0x6c, 0x6c, 0x6f]), 5), Buffer.from('hello'));
});

test('lz4: rejects corrupt input instead of reading out of bounds', () => {
  assert.throws(() => lz4DecodeBlock(Buffer.from([0x11, 0x61, 0x09, 0x00]), 100), /invalid match offset/);
  assert.throws(() => lz4DecodeBlock(Buffer.from([0xf0]), 100), /truncated literal length/);
  assert.throws(() => lz4DecodeBlock(Buffer.from([0x50, 1, 2, 3, 4, 5]), 3), /overflow/);
  assert.throws(() => lz4DecodeBlock(lz4EncodeBlock(Buffer.alloc(100, 7)), 99), /overflow/);
});

const vectors = JSON.parse(readFileSync(new URL('./fixtures/lzma-vectors.json', import.meta.url), 'utf8'));
for (const v of vectors) {
  test(`lzma: decodes a real xz-produced stream (${v.name})`, () => {
    const out = lzmaDecode(Buffer.from(v.b64, 'base64'), v.size);
    assert.equal(createHash('sha256').update(out).digest('hex'), v.sha256);
  });
}

test('lzma: rejects truncated and malformed input', () => {
  const v = vectors[0];
  const raw = Buffer.from(v.b64, 'base64');
  assert.throws(() => lzmaDecode(raw.subarray(0, 100), v.size));
  assert.throws(() => lzmaDecode(Buffer.from([0xff, 0, 0, 1, 0, 0, 0, 0, 0, 0]), 10), /invalid properties/);
  assert.throws(() => lzmaDecode(Buffer.from([0x5d, 0, 0, 1, 0, 1, 0, 0, 0, 0]), 10), /range coder header/);
});
