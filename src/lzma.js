// LZMA decoder for Unity bundle blocks: 5 property bytes (lc/lp/pb + dictionary size) followed by the raw
// range-coded stream, with NO 8-byte size header (the size comes from the bundle's block table).
// Written from the public LZMA specification. Output is a single flat buffer, so the dictionary is simply
// "everything decoded so far" and the dictionary-size property is not needed.

const kNumPosBitsMax = 4;
const kNumStates = 12;
const kNumLenToPosStates = 4;
const kEndPosModelIndex = 14;
const kNumFullDistances = 1 << (kEndPosModelIndex >>> 1);
const kNumAlignBits = 4;
const kMatchMinLen = 2;

function probs(n) { return new Uint16Array(n).fill(1024); }

class LenDecoder {
  constructor() {
    this.choice = probs(2); // [choice, choice2]
    this.low = probs(8 << kNumPosBitsMax);
    this.mid = probs(8 << kNumPosBitsMax);
    this.high = probs(256);
  }
}

export function lzmaDecode(src, uncompressedSize) {
  if (src.length < 5) throw new Error('lzma: missing properties');
  const d = src[0];
  if (d >= 9 * 5 * 5) throw new Error('lzma: invalid properties byte');
  const lc = d % 9;
  const lp = Math.floor(d / 9) % 5;
  const pb = Math.floor(d / 45);

  const out = Buffer.allocUnsafe(uncompressedSize);
  if (uncompressedSize === 0) return out;

  // --- range decoder state ---
  let ip = 5;
  if (src.length < 10 || src[ip] !== 0) throw new Error('lzma: bad range coder header');
  let code = ((src[ip + 1] << 24) | (src[ip + 2] << 16) | (src[ip + 3] << 8) | src[ip + 4]) >>> 0;
  ip += 5;
  let range = 0xffffffff;

  const nextByte = () => {
    if (ip >= src.length) throw new Error('lzma: truncated input');
    return src[ip++];
  };

  function bit(p, i) {
    const v = p[i];
    const bound = (range >>> 11) * v;
    let b;
    if (code < bound) {
      range = bound;
      p[i] = v + ((2048 - v) >>> 5);
      b = 0;
    } else {
      range -= bound;
      code -= bound;
      p[i] = v - (v >>> 5);
      b = 1;
    }
    if (range < 0x1000000) {
      range = (range << 8) >>> 0;
      code = ((code << 8) | nextByte()) >>> 0;
    }
    return b;
  }

  function directBits(n) {
    let res = 0;
    for (; n > 0; n--) {
      range >>>= 1;
      code = (code - range) >>> 0;
      let b;
      if (code >>> 31) { code = (code + range) >>> 0; b = 0; } else { b = 1; }
      if (range < 0x1000000) {
        range = (range << 8) >>> 0;
        code = ((code << 8) | nextByte()) >>> 0;
      }
      res = ((res << 1) | b) >>> 0;
    }
    return res;
  }

  function bitTree(p, off, numBits) {
    let m = 1;
    for (let i = 0; i < numBits; i++) m = (m << 1) + bit(p, off + m);
    return m - (1 << numBits);
  }

  function bitTreeReverse(p, off, numBits) {
    let m = 1;
    let sym = 0;
    for (let i = 0; i < numBits; i++) {
      const b = bit(p, off + m);
      m = (m << 1) + b;
      sym |= b << i;
    }
    return sym;
  }

  function decodeLen(ld, posState) {
    if (bit(ld.choice, 0) === 0) return bitTree(ld.low, posState << 3, 3);
    if (bit(ld.choice, 1) === 0) return 8 + bitTree(ld.mid, posState << 3, 3);
    return 16 + bitTree(ld.high, 0, 8);
  }

  // --- model ---
  const literal = probs(0x300 << (lc + lp));
  const isMatch = probs(kNumStates << kNumPosBitsMax);
  const isRep = probs(kNumStates);
  const isRepG0 = probs(kNumStates);
  const isRepG1 = probs(kNumStates);
  const isRepG2 = probs(kNumStates);
  const isRep0Long = probs(kNumStates << kNumPosBitsMax);
  const posSlot = probs(kNumLenToPosStates << 6);
  const posSpecial = probs(1 + kNumFullDistances - kEndPosModelIndex);
  const align = probs(1 << kNumAlignBits);
  const lenDec = new LenDecoder();
  const repLenDec = new LenDecoder();

  function decodeDistance(len) {
    const lenState = len > kNumLenToPosStates - 1 ? kNumLenToPosStates - 1 : len;
    const slot = bitTree(posSlot, lenState << 6, 6);
    if (slot < 4) return slot;
    const numDirect = (slot >>> 1) - 1;
    let dist = (2 | (slot & 1)) * 2 ** numDirect; // multiply: (3 << 30) would overflow int32
    if (slot < kEndPosModelIndex) {
      dist += bitTreeReverse(posSpecial, dist - slot, numDirect);
    } else {
      dist += directBits(numDirect - kNumAlignBits) * (1 << kNumAlignBits);
      dist += bitTreeReverse(align, 0, kNumAlignBits);
    }
    return dist;
  }

  // --- main loop ---
  const pbMask = (1 << pb) - 1;
  const lpMask = (1 << lp) - 1;
  let state = 0;
  let rep0 = 0, rep1 = 0, rep2 = 0, rep3 = 0;
  let op = 0;

  while (op < uncompressedSize) {
    const posState = op & pbMask;

    if (bit(isMatch, (state << kNumPosBitsMax) + posState) === 0) {
      const prev = op > 0 ? out[op - 1] : 0;
      const base = 0x300 * (((op & lpMask) << lc) + (prev >>> (8 - lc)));
      let symbol = 1;
      if (state >= 7) {
        let matchByte = out[op - rep0 - 1];
        do {
          const matchBit = (matchByte >>> 7) & 1;
          matchByte = (matchByte << 1) & 0xff;
          const b = bit(literal, base + ((1 + matchBit) << 8) + symbol);
          symbol = (symbol << 1) | b;
          if (matchBit !== b) break;
        } while (symbol < 0x100);
      }
      while (symbol < 0x100) symbol = (symbol << 1) | bit(literal, base + symbol);
      out[op++] = symbol & 0xff;
      state = state < 4 ? 0 : state < 10 ? state - 3 : state - 6;
      continue;
    }

    let len;
    if (bit(isRep, state) !== 0) {
      if (op === 0) throw new Error('lzma: rep match with empty window');
      if (bit(isRepG0, state) === 0) {
        if (bit(isRep0Long, (state << kNumPosBitsMax) + posState) === 0) {
          state = state < 7 ? 9 : 11;
          out[op] = out[op - rep0 - 1];
          op++;
          continue;
        }
      } else {
        let dist;
        if (bit(isRepG1, state) === 0) {
          dist = rep1;
        } else {
          if (bit(isRepG2, state) === 0) {
            dist = rep2;
          } else {
            dist = rep3;
            rep3 = rep2;
          }
          rep2 = rep1;
        }
        rep1 = rep0;
        rep0 = dist;
      }
      len = decodeLen(repLenDec, posState);
      state = state < 7 ? 8 : 11;
    } else {
      rep3 = rep2; rep2 = rep1; rep1 = rep0;
      len = decodeLen(lenDec, posState);
      state = state < 7 ? 7 : 10;
      rep0 = decodeDistance(len);
      if (rep0 === 0xffffffff) break; // end-of-stream marker
    }

    len += kMatchMinLen;
    if (rep0 >= op) throw new Error('lzma: match distance beyond decoded data');
    if (op + len > uncompressedSize) throw new Error('lzma: match overflows output');
    for (let i = 0, from = op - rep0 - 1; i < len; i++) out[op++] = out[from++];
  }

  if (op !== uncompressedSize) throw new Error(`lzma: produced ${op} bytes, expected ${uncompressedSize}`);
  return out;
}
