// Cursor over a Buffer with switchable endianness. Every read is bounds-checked, because the inputs are
// untrusted game files: a corrupt length must produce an Error, not an out-of-range slice or a huge alloc.
export class BinaryReader {
  constructor(buffer, offset = 0, littleEndian = true) {
    this.buf = buffer;
    this.pos = offset;
    this.little = littleEndian;
  }

  get length() { return this.buf.length; }
  get remaining() { return this.buf.length - this.pos; }

  _need(n) {
    if (n < 0 || this.pos + n > this.buf.length) {
      throw new RangeError(`read of ${n} bytes at ${this.pos} runs past end of data (${this.buf.length})`);
    }
  }

  u8() { this._need(1); return this.buf[this.pos++]; }
  i8() { this._need(1); return this.buf.readInt8(this.pos++); }
  bool() { return this.u8() !== 0; }
  u16() { this._need(2); const v = this.little ? this.buf.readUInt16LE(this.pos) : this.buf.readUInt16BE(this.pos); this.pos += 2; return v; }
  i16() { this._need(2); const v = this.little ? this.buf.readInt16LE(this.pos) : this.buf.readInt16BE(this.pos); this.pos += 2; return v; }
  u32() { this._need(4); const v = this.little ? this.buf.readUInt32LE(this.pos) : this.buf.readUInt32BE(this.pos); this.pos += 4; return v; }
  i32() { this._need(4); const v = this.little ? this.buf.readInt32LE(this.pos) : this.buf.readInt32BE(this.pos); this.pos += 4; return v; }
  f32() { this._need(4); const v = this.little ? this.buf.readFloatLE(this.pos) : this.buf.readFloatBE(this.pos); this.pos += 4; return v; }
  f64() { this._need(8); const v = this.little ? this.buf.readDoubleLE(this.pos) : this.buf.readDoubleBE(this.pos); this.pos += 8; return v; }

  // 64-bit values come back as a Number when that is exact, and as a BigInt when it is not. Unity's hashed path IDs
  // (e.g. -6291524532174903347) routinely exceed 2^53, and rounding one would silently point at the wrong object.
  i64() {
    this._need(8);
    const v = this.little ? this.buf.readBigInt64LE(this.pos) : this.buf.readBigInt64BE(this.pos);
    this.pos += 8;
    return exactNumber(v);
  }
  u64() {
    this._need(8);
    const v = this.little ? this.buf.readBigUInt64LE(this.pos) : this.buf.readBigUInt64BE(this.pos);
    this.pos += 8;
    return exactNumber(v);
  }

  // Zero-copy view; callers that keep it past the lifetime of the source buffer must copy.
  bytes(n) {
    this._need(n);
    const out = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }

  cstring(maxLen = 4096) {
    const start = this.pos;
    const limit = Math.min(this.buf.length, start + maxLen);
    let end = start;
    while (end < limit && this.buf[end] !== 0) end++;
    if (end >= limit) throw new RangeError(`unterminated string at ${start}`);
    this.pos = end + 1;
    return this.buf.toString('utf8', start, end);
  }

  align(n) {
    const rem = this.pos % n;
    if (rem !== 0) {
      this._need(n - rem);
      this.pos += n - rem;
    }
  }
}

function exactNumber(big) {
  return big <= BigInt(Number.MAX_SAFE_INTEGER) && big >= BigInt(Number.MIN_SAFE_INTEGER) ? Number(big) : big;
}

// Sizes and offsets must be plain Numbers; a 64-bit value this large there means the file is corrupt.
export function sizeNumber(v, what = 'value') {
  if (typeof v !== 'number') throw new RangeError(`${what} ${v} is implausibly large`);
  return v;
}
