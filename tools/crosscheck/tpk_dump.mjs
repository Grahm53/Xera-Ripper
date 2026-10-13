// Dump every class's runtime type tree for a list of Unity versions, so tpk_compare.py can diff it against UnityPy.
import { defaultTypeDatabase } from '../../src/tpk.js';
const versions = process.argv.slice(2);
const db = defaultTypeDatabase();
const out = {};
for (const v of versions) {
  out[v] = {};
  for (const id of [...db.classes.keys()].sort((a, b) => a - b)) {
    const t = db.treeFor(id, v);
    if (t) out[v][id] = t.nodes.map((n) => [n.level, n.type, n.name, n.metaFlags]);
  }
}
process.stdout.write(JSON.stringify(out));
