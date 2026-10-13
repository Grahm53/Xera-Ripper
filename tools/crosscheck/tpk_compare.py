"""Compare Xera Ripper's type-tree database reader with UnityPy's, class by class, for several Unity versions."""
import json, os, subprocess, sys
from UnityPy.helpers import Tpk
from UnityPy.helpers.UnityVersion import UnityVersion
HERE = os.path.dirname(os.path.abspath(__file__))
versions = sys.argv[1:] or ["5.6.7f1", "2017.4.40f1", "2018.4.36f1", "2019.4.31f1", "2020.3.48f1", "2021.3.10f1", "2022.3.20f1", "6000.0.23f1"]
mine = json.loads(subprocess.check_output(["node", os.path.join(HERE, "tpk_dump.mjs"), *versions]))

def flat(node, out):
    out.append([node.m_Level, node.m_Type, node.m_Name, node.m_MetaFlag])
    for c in node.m_Children: flat(c, out)

bad = total = 0
for v in versions:
    uv = UnityVersion.from_str(v)
    ids = sorted(set(map(int, mine[v].keys())) | set(Tpk.get_typetree().ClassInformation.keys()))
    n_ok = n_missing_both = 0
    for cid in ids:
        try:
            node = Tpk.get_typetree_node(cid, uv); theirs = []; flat(node, theirs)
        except Exception:
            theirs = None
        m = mine[v].get(str(cid))
        total += 1
        if m == theirs:
            if m is None: n_missing_both += 1
            else: n_ok += 1
        else:
            bad += 1
            if bad <= 8: print(f"DIFF v={v} class={cid}: mine={None if m is None else len(m)} nodes, theirs={None if theirs is None else len(theirs)} nodes")
    print(f"{v:14s} identical trees: {n_ok:4d}   (absent in both: {n_missing_both})")
print("class/version pairs compared:", total, " mismatches:", bad)
raise SystemExit(1 if bad else 0)
