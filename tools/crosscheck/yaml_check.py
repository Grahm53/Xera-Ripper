"""Parse Xera Ripper's Unity-YAML output with PyYAML and compare it with the value it was generated from.

Uses BaseLoader, i.e. every plain scalar stays text (Unity's own reader is schema-driven, so all-digit hex strings, `4:3`
keys etc. are fine for it but would be mistyped by a YAML 1.1 resolver). Numbers are compared by value, strings exactly."""
import json, math, sys
from collections import Counter
import yaml

class UnityLoader(yaml.BaseLoader): pass
UnityLoader.add_multi_constructor("tag:unity3d.com,2011:", lambda loader, suffix, node: loader.construct_mapping(node, deep=True))
HEADER = "%YAML 1.1\n%TAG !u! tag:unity3d.com,2011:\n"   # written once at the top of every exported file

def same(a, b):
    if isinstance(b, dict):
        return isinstance(a, dict) and a.keys() == b.keys() and all(same(a[k], b[k]) for k in b)
    if isinstance(b, list):
        return isinstance(a, list) and len(a) == len(b) and all(same(x, y) for x, y in zip(a, b))
    if isinstance(b, bool): b = int(b)
    if isinstance(b, (int, float)):
        try: x = float(a)
        except (TypeError, ValueError): return False
        return x == b or math.isclose(x, b, rel_tol=1e-6, abs_tol=1e-9) or (math.isnan(x) and math.isnan(b))
    return (a or "") == (b or "")

def first_diff(a, b, path=""):
    if isinstance(b, dict) and isinstance(a, dict):
        for k in sorted(set(a) | set(b), key=str):
            if k not in a or k not in b: return f"{path}/{k} (key missing on one side)", a.get(k), b.get(k)
            r = first_diff(a[k], b[k], f"{path}/{k}")
            if r: return r
        return None
    if isinstance(b, list) and isinstance(a, list):
        if len(a) != len(b): return f"{path} (length)", a, b
        for i, (x, y) in enumerate(zip(a, b)):
            r = first_diff(x, y, f"{path}[{i}]")
            if r: return r
        return None
    return None if same(a, b) else (path, a, b)

docs = json.load(open(sys.argv[1]))
bad, causes = 0, Counter()
for d in docs:
    try:
        parsed = list(yaml.load_all(HEADER + d["text"], Loader=UnityLoader))
        assert len(parsed) == 1, f"expected 1 document, got {len(parsed)}"
        body = parsed[0][d["root"]]
        ok = same(body if body not in (None, "") else {}, d["expected"])
        err = None if ok else "differs"
    except Exception as e:
        ok, err = False, f"{type(e).__name__}: {str(e)[:120]}"
    if ok: continue
    bad += 1
    if err == "differs":
        path, pa, pb = first_diff(body or {}, d["expected"]) or ("?", None, None)
        key = (d["root"], path.split("/")[-1].split("[")[0])
        causes[key] += 1
        if causes[key] == 1 and len(causes) <= 8:
            print(f"FAIL {d['version']} {d['root']} {path}\n     parsed  : {json.dumps(pa)[:170]}\n     expected: {json.dumps(pb)[:170]}")
    else:
        causes[err[:70]] += 1
        if causes[err[:70]] == 1 and len(causes) <= 8: print(f"FAIL {d['version']} {d['root']}: {err}")
if causes: print("causes:", dict(causes.most_common(10)))
print(f"{len(docs)} documents parsed and compared, failures: {bad}")
sys.exit(1 if bad else 0)
