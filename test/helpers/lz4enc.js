// Tiny greedy LZ4 block *encoder*, test-only. Good enough to exercise literal runs, long lengths (>=15, >=255)
// and overlapping matches in the decoder. It obeys the LZ4 end-of-block rules (last match starts >= 12 bytes before
// the end and stops >= 5 bytes before it), because strict decoders such as liblz4 reject streams that break them.
export function lz4EncodeBlock(input) {
  const out = [];
  const table = new Map();
  let anchor = 0;
  let i = 0;
  const writeLen = (n) => { while (n >= 255) { out.push(255); n -= 255; } out.push(n); };
  const emit = (litStart, litEnd, matchLen, offset) => {
    const litLen = litEnd - litStart;
    const ml = matchLen === null ? 0 : matchLen - 4;
    out.push((Math.min(litLen, 15) << 4) | (matchLen === null ? 0 : Math.min(ml, 15)));
    if (litLen >= 15) writeLen(litLen - 15);
    for (let k = litStart; k < litEnd; k++) out.push(input[k]);
    if (matchLen !== null) {
      out.push(offset & 0xff, offset >>> 8);
      if (ml >= 15) writeLen(ml - 15);
    }
  };
  const matchStartLimit = input.length - 12;
  const matchEndLimit = input.length - 5;
  while (i <= matchStartLimit) {
    const key = input.readUInt32LE(i);
    const cand = table.get(key);
    table.set(key, i);
    if (cand !== undefined && i - cand <= 0xffff) {
      let len = 4;
      while (i + len < matchEndLimit && input[cand + len] === input[i + len]) len++;
      emit(anchor, i, len, i - cand);
      i += len;
      anchor = i;
    } else {
      i++;
    }
  }
  emit(anchor, input.length, null, 0);
  return Buffer.from(out);
}
