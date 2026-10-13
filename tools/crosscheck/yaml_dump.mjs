// For every engine class and several Unity versions: a randomised object -> editor layout -> Unity YAML text, plus the value the
// text is expected to parse back to. yaml_check.py parses the text with a real YAML parser and compares.
import { writeFileSync } from 'node:fs';
import { defaultTypeDatabase } from '../../src/tpk.js';
import { UnityYamlWriter, toEditorValue } from '../../src/unityYaml.js';
import { randomValue, rng } from '../../test/helpers/treeWriter.js';

const db = defaultTypeDatabase();
const versions = process.argv.slice(3).length ? process.argv.slice(3) : ['2017.4.40f1', '2019.4.31f1', '2021.3.10f1', '2022.3.20f1', '6000.0.23f1'];
const FLOW = new Set(['Vector2f', 'Vector3f', 'Vector4f', 'Quaternionf', 'ColorRGBA', 'Rectf', 'Vector2Int', 'Vector3Int', 'RectInt']);
const INTS = new Set(['SInt8', 'UInt8', 'char', 'SInt16', 'short', 'UInt16', 'unsigned short', 'SInt32', 'int', 'UInt32', 'unsigned int', 'Type*', 'SInt64', 'long long', 'UInt64', 'unsigned long long', 'FileSize']);

// What the YAML text should parse back to, derived from the tree + value WITHOUT going through the text writer.
function expected(tree, i, v) {
  const { nodes, ends } = tree;
  const n = nodes[i];
  const kids = () => { const o = []; for (let j = i + 1; j < ends[i]; j = ends[j]) o.push(j); return o; };
  const isVec = nodes[i + 1] && nodes[i + 1].type === 'Array' && nodes[i + 1].level === n.level + 1;
  if (n.type === 'bool') return v ? 1 : 0;
  if (INTS.has(n.type) || n.type === 'float' || n.type === 'double') return Number(v);
  if (n.type === 'string') return v;
  if (n.type === 'TypelessData') return Buffer.from(v).toString('hex');
  if (n.type.startsWith('PPtr<')) return { fileID: Number(v.m_PathID) };
  if (n.type === 'Hash128') return Array.from({ length: 16 }, (_, k) => Number(v[`bytes[${k}]`]).toString(16).padStart(2, '0')).join('');
  if (n.type === 'map' || isVec) {
    if (isVec && nodes[i + 3] && ['UInt8', 'SInt8', 'char'].includes(nodes[i + 3].type) && ends[i + 3] === i + 4) return Buffer.from(v).toString('hex');
    return v.map((el) => {
      const e = nodes[i + 3];
      const ek = []; for (let j = i + 4; j < ends[i + 3]; j = ends[j]) ek.push(j);
      if (e.type === 'pair' && ek.length === 2 && (nodes[ek[0]].type === 'string' || nodes[ek[0]].type === 'FastPropertyName')) {
        const k = nodes[ek[0]].type === 'string' ? el.first : el.first.name;
        return { [k]: expected(tree, ek[1], el.second) };
      }
      return expected(tree, i + 3, el);
    });
  }
  const out = {};
  if (n.version > 1) out.serializedVersion = n.version;
  for (const j of kids()) out[nodes[j].name] = expected(tree, j, v[nodes[j].name]);
  return out;
}

const docs = [];
for (const version of versions) {
  for (const id of [...db.classes.keys()].sort((a, b) => a - b)) {
    const ed = db.editorTreeFor(id, version);
    const rel = db.treeFor(id, version);
    if (!ed || !rel) continue;
    const runtime = randomValue(rel, rng(id * 31 + 7));
    if (id === 1) runtime.m_TagString = 'Untagged';
    const value = toEditorValue(ed, runtime);
    // make strings awkward on purpose: quotes, colons, hash, unicode, numbers, bool words
    const awkward = ['plain', "it's", 'a: b', '#hash', 'true', 'null', '123', '1e5', ' lead', 'trail ', 'multi\nline', 'ünï', '- dash', '{brace}', 'tab\there', ''];
    let k = 0;
    const patch = (node, val, idx) => {
      if (node.type === 'string' && typeof val === 'string' && val.length > 0 && rng(idx + k++)() < 0.8) return awkward[(k * 7 + idx) % awkward.length];
      return val;
    };
    // walk value patching strings (shape is known from the tree, so patch by traversal)
    const walk = (i, v) => {
      const { nodes, ends } = ed;
      const n = nodes[i];
      const isVec = nodes[i + 1] && nodes[i + 1].type === 'Array' && nodes[i + 1].level === n.level + 1;
      if (n.type === 'string') return patch(n, v, i);
      if (n.type === 'map' || (isVec && !(nodes[i + 3] && ['UInt8', 'SInt8', 'char'].includes(nodes[i + 3].type) && ends[i + 3] === i + 4))) return v.map((el) => walk(i + 3, el));
      if (n.type === 'TypelessData' || isVec || n.type === 'bool' || n.type === 'float' || n.type === 'double' || n.type.startsWith('PPtr<') || n.type === 'Hash128') return v;
      if (v && typeof v === 'object' && !Array.isArray(v) && !Buffer.isBuffer(v)) {
        const o = {};
        for (let j = i + 1; j < ends[i]; j = ends[j]) o[nodes[j].name] = walk(j, v[nodes[j].name]);
        return o;
      }
      return v;
    };
    const patched = walk(0, value);
    const w = new UnityYamlWriter(ed, (fileId, pathId) => (String(pathId) === '0' ? null : { fileID: pathId }));
    docs.push({ version, classId: id, root: ed.nodes[0].type, text: w.document(id, 1000 + id, patched), expected: expected(ed, 0, patched) });
  }
}
writeFileSync(process.argv[2], JSON.stringify(docs));
console.log(`${docs.length} documents`);
