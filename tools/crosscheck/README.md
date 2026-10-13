# Cross-check against independent implementations

The unit tests use files that Xera Ripper's own test builders write, which alone could hide a shared misunderstanding of the
format. These scripts open the **same** files / bytes with **UnityPy** (MIT, battle-tested on real games) and
`texture2ddecoder` / Pillow, and require identical results.

```bash
python3 -m venv /tmp/xv && /tmp/xv/bin/pip install UnityPy
node tools/crosscheck/gen.mjs /tmp/xcorpus                 # synthetic bundles + serialized files
/tmp/xv/bin/python tools/crosscheck/compare.py /tmp/xcorpus  # object-by-object, byte-exact value comparison
/tmp/xv/bin/python tools/crosscheck/textures.py             # DXT1/DXT5 + linear formats vs the reference decoders
```

What this has caught so far: the meaning of bundle flag `0x200` depends on the Unity version (encryption vs padding),
format-6 bundles from Unity 2019.4.15+ are 16-byte aligned, DXT1 must decode as opaque, and DXT rounding must be
bit-replication + truncating division to be pixel-exact.

Still not covered: files from real shipped games (none could be obtained in the development sandbox).
