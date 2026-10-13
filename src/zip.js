import { openSync, closeSync, readSync, fstatSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';
import { crc32 } from './crc32.js';

const MAX_ENTRY = 2 * 1024 ** 3;

function readAt(fd, pos, len) {
  const b = Buffer.alloc(len);
  let got = 0;
  while (got < len) {
    const n = readSync(fd, b, got, len - got, pos + got);
    if (n === 0) throw new RangeError('unexpected end of archive');
    got += n;
  }
  return b;
}

// Positional-read ZIP reader (APK / OBB / ZIP): entries are inflated on demand, nothing is loaded up front.
// Zip64 is not supported (Quest APKs are well under 4 GiB; the error says so rather than misreading).
export class ZipArchive {
  constructor(path) {
    this.fd = openSync(path, 'r');
    try { this._index(); } catch (e) { closeSync(this.fd); throw e; }
  }

  close() { closeSync(this.fd); }

  _index() {
    const size = fstatSync(this.fd).size;
    const tailLen = Math.min(size, 65535 + 22);
    const tail = readAt(this.fd, size - tailLen, tailLen);
    let e = tail.length - 22;
    while (e >= 0 && tail.readUInt32LE(e) !== 0x06054b50) e--;
    if (e < 0) throw new Error('not a zip archive (no end-of-central-directory record)');
    const total = tail.readUInt16LE(e + 10);
    const cdSize = tail.readUInt32LE(e + 12);
    const cdOffset = tail.readUInt32LE(e + 16);
    if (total === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) throw new Error('zip64 archives are not supported yet');
    if (cdOffset + cdSize > size) throw new RangeError('central directory lies outside the archive');

    const cd = readAt(this.fd, cdOffset, cdSize);
    this.entries = [];
    let p = 0;
    for (let i = 0; i < total; i++) {
      if (p + 46 > cd.length || cd.readUInt32LE(p) !== 0x02014b50) throw new Error('corrupt central directory');
      const flags = cd.readUInt16LE(p + 8);
      const method = cd.readUInt16LE(p + 10);
      const crc = cd.readUInt32LE(p + 16);
      const compSize = cd.readUInt32LE(p + 20);
      const size32 = cd.readUInt32LE(p + 24);
      const nameLen = cd.readUInt16LE(p + 28);
      const extraLen = cd.readUInt16LE(p + 30);
      const commentLen = cd.readUInt16LE(p + 32);
      const localOffset = cd.readUInt32LE(p + 42);
      const name = cd.toString(flags & 0x800 ? 'utf8' : 'latin1', p + 46, p + 46 + nameLen);
      p += 46 + nameLen + extraLen + commentLen;
      if (name.endsWith('/')) continue; // directory entry
      this.entries.push({ name, method, crc, compSize, size: size32, localOffset, encrypted: (flags & 1) !== 0 });
    }
    this._byName = new Map(this.entries.map((x) => [x.name, x]));
  }

  has(name) { return this._byName.has(name); }

  read(name) {
    const e = this._byName.get(name);
    if (!e) throw new Error(`no such entry: ${name}`);
    if (e.encrypted) throw new Error(`entry ${name} is encrypted`);
    if (e.size > MAX_ENTRY || e.compSize > MAX_ENTRY) throw new RangeError(`entry ${name} is too large (${e.size} bytes)`);
    const lh = readAt(this.fd, e.localOffset, 30);
    if (lh.readUInt32LE(0) !== 0x04034b50) throw new Error(`bad local header for ${name}`);
    const dataPos = e.localOffset + 30 + lh.readUInt16LE(26) + lh.readUInt16LE(28);
    const raw = readAt(this.fd, dataPos, e.compSize);
    let out;
    if (e.method === 0) out = raw;
    else if (e.method === 8) out = inflateRawSync(raw, { maxOutputLength: Math.max(e.size, 1) });
    else throw new Error(`entry ${name} uses unsupported compression method ${e.method}`);
    if (out.length !== e.size) throw new Error(`entry ${name}: size mismatch (${out.length} != ${e.size})`);
    if (crc32(out) !== e.crc) throw new Error(`entry ${name}: CRC mismatch`);
    return out;
  }
}
