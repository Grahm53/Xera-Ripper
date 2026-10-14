# Cross-check against independent implementations

The unit tests use files that Xera Ripper's own test builders write, which alone could hide a shared misunderstanding of the
format. These scripts check the **same** files / bytes against implementations written by other people and require identical
results: **UnityPy** (MIT, used on real games), `texture2ddecoder` (C), Pillow, `lz4` (liblz4) and PyYAML.

```bash
python3 -m venv /tmp/xv && /tmp/xv/bin/pip install UnityPy pyyaml     # pulls texture2ddecoder, Pillow, lz4

# 1. file formats: synthetic bundles + serialized files, object-by-object byte-exact comparison with UnityPy
node tools/crosscheck/gen.mjs /tmp/xcorpus && /tmp/xv/bin/python tools/crosscheck/compare.py /tmp/xcorpus

# 2. the built-in type-tree database: every class x several Unity versions vs UnityPy's own database reader
/tmp/xv/bin/python tools/crosscheck/tpk_compare.py

# 3. texture decoders: DXT1/DXT5 vs texture2ddecoder, linear formats vs Pillow's raw decoders
/tmp/xv/bin/python tools/crosscheck/textures.py

# 4. Unity YAML: every engine class x 5 Unity versions -> YAML text -> real YAML parser -> compare with the source values
node tools/crosscheck/yaml_dump.mjs /tmp/yamldocs.json && /tmp/xv/bin/python tools/crosscheck/yaml_check.py /tmp/yamldocs.json

# 5. a whole exported project parses (scenes, prefabs, materials, every .meta)
node bin/xera-ripper.js project <game> -o /tmp/proj && /tmp/xv/bin/python tools/crosscheck/yaml_project.py /tmp/proj/ExportedProject

# 6. the web UI: every menu item is reachable with a REAL mouse at 11 window widths (needs Playwright + Chromium)
node tools/crosscheck/ui_menus.mjs "$(npm root -g)"
```

Why check 6 exists: the menu bar once clipped every dropdown (`overflow-x: auto`), and Playwright's own `click()` scrolls hidden containers
into view, so ordinary UI tests passed while a person could not click any menu item. It asks the browser what is under the pointer and clicks
with raw coordinates; it fails on the old stylesheet.

What this has caught so far: the meaning of bundle flag `0x200` depends on the Unity version (encryption vs padding); format-6
bundles from Unity 2019.4.15+ are 16-byte aligned; DXT1 must decode as opaque; DXT rounding must be bit-replication + truncating
division to be pixel-exact; 64-bit hashed path IDs must not be rounded.

Notes on the YAML check: it uses PyYAML's text-preserving loader because Unity's own reader is schema-driven (all-digit hex strings and keys
like `4:3` are legal Unity YAML but would be mistyped by a YAML 1.1 resolver), and the project check re-applies the `%TAG !u!` header per
document because Unity writes it once, which strict parsers only honour for the first document.

Still not covered: files from real shipped games (none could be obtained in the development sandbox) and opening exported projects in a Unity editor.
