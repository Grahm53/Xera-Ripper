"""Parse every YAML file of an exported Unity project (and its .meta files) with PyYAML.
   usage: python yaml_project.py <ExportedProject folder>"""
import os, re, sys, yaml

class UnityLoader(yaml.BaseLoader): pass
UnityLoader.add_multi_constructor("tag:unity3d.com,2011:", lambda loader, suffix, node: loader.construct_mapping(node, deep=True))

HEADER = "%YAML 1.1\n%TAG !u! tag:unity3d.com,2011:\n"
root = sys.argv[1]

def parse(text):
    # Unity writes the %TAG header once; a strict parser applies it to the first document only (a well-known quirk of Unity
    # YAML), so give every document the header.
    if not text.startswith("%YAML"): return list(yaml.load_all(text, Loader=UnityLoader))
    body = text[len(HEADER):]
    return [yaml.load(HEADER + d, Loader=UnityLoader) for d in re.split(r"(?m)^(?=--- )", body) if d.strip()]
n = bad = 0
for dirpath, _, files in os.walk(root):
    for f in files:
        if not f.endswith((".unity", ".prefab", ".mat", ".asset", ".anim", ".controller", ".meta")): continue
        path = os.path.join(dirpath, f)
        try:
            docs = parse(open(path, encoding="utf-8").read())
            if f.endswith(".meta"): assert docs and "guid" in docs[0], "meta without guid"
            n += 1
        except Exception as e:
            bad += 1; print("FAIL", os.path.relpath(path, root), type(e).__name__, str(e)[:120])
print(f"{n} files parsed, failures: {bad}")
sys.exit(1 if bad else 0)
