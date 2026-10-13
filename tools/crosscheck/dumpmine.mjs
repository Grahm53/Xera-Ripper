// Dump what Xera Ripper decodes (byte arrays as int lists, map entries as pairs) so compare.py can diff it with UnityPy.
import { readdirSync } from 'node:fs';
import { Session } from '../../src/session.js';

function full(v) {
  if (Buffer.isBuffer(v)) return Array.from(v);
  if (Array.isArray(v)) return v.map(full);
  if (v && typeof v === 'object') {
    const keys = Object.keys(v);
    if (keys.length === 2 && keys[0] === 'first' && keys[1] === 'second') return [full(v.first), full(v.second)];
    return Object.fromEntries(keys.map((k) => [k, full(v[k])]));
  }
  return v;
}
const dir = process.argv[2];
const out = {};
for (const f of readdirSync(dir).filter((n) => /\.(assets|bundle)$/.test(n))) {
  const s = new Session();
  try {
    s.load(`${dir}/${f}`);
    out[f] = {};
    for (const a of s.assets) out[f][a.pathId] = { type: a.className, value: full(s.files[a.fileIndex].sf.readObject(a.obj)) };
    if (!s.assets.length) out[f] = { error: s.skipped.map((x) => x.reason).join('; ') || 'no assets' };
  } catch (e) { out[f] = { error: e.message }; }
}
process.stdout.write(JSON.stringify(out));
