"""Cross-check Xera Ripper's texture decoders against reference implementations on random data.
   DXT1/DXT5 -> texture2ddecoder (C), linear formats -> Pillow raw decoders (as used by UnityPy)."""
import os, random, subprocess, tempfile
import texture2ddecoder as t2d
from PIL import Image
HERE = os.path.dirname(os.path.abspath(__file__))
TMP = tempfile.mkdtemp(prefix="xera-tex-")
random.seed(5)

def mine(data, w, h, fmt):
    i, o = os.path.join(TMP, "in.bin"), os.path.join(TMP, "out.bin")
    open(i, "wb").write(data)
    subprocess.check_call(["node", os.path.join(HERE, "texdec.mjs"), i, o, str(w), str(h), str(fmt)])
    return open(o, "rb").read()

def flip(buf, w, h):
    s = w * 4
    return b"".join(buf[(h - 1 - y) * s:(h - y) * s] for y in range(h))

def bgra_to_rgba(b):
    out = bytearray(len(b))
    for i in range(0, len(b), 4): out[i:i+4] = bytes((b[i+2], b[i+1], b[i], b[i+3]))
    return bytes(out)

bad = 0
def report(name, worst, tol):
    global bad
    ok = worst <= tol
    bad += not ok
    print(f"{'OK ' if ok else 'BAD'} {name}: max channel diff {worst} (tolerance {tol})")

# --- block-compressed: must be pixel-exact
for name, fmt, bs, fn in [("DXT1", 10, 8, t2d.decode_bc1), ("DXT5", 12, 16, t2d.decode_bc3)]:
    for (w, h) in [(4, 4), (8, 8), (16, 12), (64, 64), (5, 3), (13, 7), (1, 1), (33, 17)]:
        n = ((w + 3) // 4) * ((h + 3) // 4) * bs
        data = bytearray(random.randrange(256) for _ in range(n))
        if fmt == 12:  # BC3 colour blocks are always 4-colour: emit c0 > c1 like a real encoder
            for off in range(0, n, 16):
                c0 = data[off+8] | data[off+9] << 8; c1 = data[off+10] | data[off+11] << 8
                if c0 <= c1:
                    c0, c1 = (c1, c0) if c1 != c0 else (c0 | 1, c1 & ~1)
                    data[off+8:off+12] = bytes((c0 & 255, c0 >> 8, c1 & 255, c1 >> 8))
        data = bytes(data)
        ref = flip(bgra_to_rgba(fn(data, w, h)), w, h)
        report(f"{name} {w}x{h}", max(abs(a - b) for a, b in zip(mine(data, w, h, fmt), ref)), 0)

# --- linear formats (Pillow raw modes, as in UnityPy's converter table)
W, H = 4, 3
for name, fmt, bpp, (mode, raw, rm), swap, tol in [
    ("RGB24", 3, 3, ("RGB", "raw", "RGB"), None, 0), ("ARGB32", 5, 4, ("RGBA", "raw", "ARGB"), None, 0),
    ("BGRA32", 14, 4, ("RGBA", "raw", "BGRA"), None, 0), ("RGBA32", 4, 4, ("RGBA", "raw", "RGBA"), None, 0),
    ("R8", 63, 1, ("RGB", "raw", "R"), None, 0), ("RGB565", 7, 2, ("RGB", "raw", "BGR;16"), None, 1),
    ("RGBA4444", 13, 2, ("RGBA", "raw", "RGBA;4B"), (3, 2, 1, 0), 0), ("ARGB4444", 2, 2, ("RGBA", "raw", "RGBA;4B"), (2, 1, 0, 3), 0),
]:
    data = bytes(random.randrange(256) for _ in range(W * H * bpp))
    im = Image.frombytes(mode, (W, H), data, raw, rm)
    if swap:
        ch = im.split(); im = Image.merge("RGBA", [ch[i] for i in swap])
    ref = im.convert("RGBA").tobytes()
    report(name, max(abs(a - b) for a, b in zip(flip(mine(data, W, H, fmt), W, H), ref)), tol)

print("failures:", bad)
raise SystemExit(1 if bad else 0)
