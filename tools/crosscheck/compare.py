import sys, glob, os, json, subprocess, UnityPy
HERE = os.path.dirname(os.path.abspath(__file__))
UnityPy.config.FALLBACK_UNITY_VERSION = "2019.4.31f1"
d = sys.argv[1]
mine = json.loads(subprocess.check_output(["node", os.path.join(HERE, "dumpmine.mjs"), d]))

def norm(v):
    if isinstance(v, (bytes, bytearray)): return list(v)
    if isinstance(v, dict): return {k: norm(x) for k, x in v.items()}
    if isinstance(v, (list, tuple)): return [norm(x) for x in v]
    if isinstance(v, float): return round(v, 4)
    return v

bad = 0
for path in sorted(glob.glob(os.path.join(d, "*.assets")) + glob.glob(os.path.join(d, "*.bundle"))):
    name = os.path.basename(path)
    m = mine[name]
    try:
        env = UnityPy.load(path)
        theirs = {}
        for obj in env.objects:
            theirs[str(obj.path_id)] = {"type": obj.type.name, "value": norm(obj.read_typetree())}
    except Exception as e:
        print(f"UNITYPY-FAIL {name}: {type(e).__name__}: {str(e)[:150]}"); bad += 1; continue
    if "error" in m:
        print(f"MINE-FAIL    {name}: {m['error']}"); bad += 1; continue
    mm = {k: {"type": v["type"], "value": norm(v["value"])} for k, v in m.items()}
    if mm == theirs:
        print(f"MATCH        {name}: {len(theirs)} objects identical")
    else:
        bad += 1
        print(f"DIFF         {name}")
        for k in sorted(set(mm) | set(theirs)):
            if mm.get(k) != theirs.get(k):
                print("   id", k, "\n     mine  :", json.dumps(mm.get(k))[:300], "\n     theirs:", json.dumps(theirs.get(k))[:300])
print("mismatches/failures:", bad)
