// LZ4 *block* decoder (the format Unity uses for LZ4 and LZ4HC bundle blocks; no frame header).
// The output size is known up front from the bundle's block table, so we decode straight into a
// fixed buffer and bounds-check every copy against it.
export function lz4DecodeBlock(src, uncompressedSize) {
  const out = Buffer.allocUnsafe(uncompressedSize);
  let ip = 0;
  let op = 0;
  const n = src.length;

  while (ip < n) {
    const token = src[ip++];

    let litLen = token >>> 4;
    if (litLen === 15) {
      let b;
      do {
        if (ip >= n) throw new Error('lz4: truncated literal length');
        b = src[ip++];
        litLen += b;
      } while (b === 255);
    }
    if (ip + litLen > n) throw new Error('lz4: literals run past end of input');
    if (op + litLen > uncompressedSize) throw new Error('lz4: literals overflow output');
    src.copy(out, op, ip, ip + litLen);
    ip += litLen;
    op += litLen;

    if (ip >= n) break; // the final sequence carries literals only

    if (ip + 2 > n) throw new Error('lz4: truncated match offset');
    const offset = src[ip] | (src[ip + 1] << 8);
    ip += 2;
    if (offset === 0 || offset > op) throw new Error('lz4: invalid match offset');

    let matchLen = token & 15;
    if (matchLen === 15) {
      let b;
      do {
        if (ip >= n) throw new Error('lz4: truncated match length');
        b = src[ip++];
        matchLen += b;
      } while (b === 255);
    }
    matchLen += 4;
    if (op + matchLen > uncompressedSize) throw new Error('lz4: match overflows output');

    // Byte-wise on purpose: matches may overlap their own output (offset < length) to express runs.
    for (let i = 0, from = op - offset; i < matchLen; i++) out[op++] = out[from++];
  }

  if (op !== uncompressedSize) throw new Error(`lz4: produced ${op} bytes, expected ${uncompressedSize}`);
  return out;
}
