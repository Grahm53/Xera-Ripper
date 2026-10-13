# =(X)= Xera Ripper

Xera's asset ripper, by Xera Games LLC.

Dependency-free Unity asset extractor with a local web UI (neon-cyan, Kode Mono) and a CLI.
Point it at a **UnityFS bundle, a serialized file (`level0`, `*.assets`), a game folder, or an `.apk`/`.zip`**,
browse every object inside, preview it, and export it.

> Use it on games and content **you own or have the rights to extract** (modding your own builds, preservation,
> analysing your own projects). Re-releasing someone else's art/audio is a copyright problem, not a tool problem.
> This is an independent implementation written from the public file-format behaviour; it contains no code from AssetRipper.

## Run it

```bash
node bin/xera-ripper.js serve            # prints a link like http://127.0.0.1:8765/?t=<token>
node bin/xera-ripper.js serve ~/MyGame   # same, with a path pre-loaded
```

Open the printed link. **File → Open File… / Open Folder…** (or paste a path), then pick assets to preview,
or **Export → Export all…**. Requires Node 20+. No `npm install` (zero dependencies).

CLI:

```
xera-ripper list <path> [--type Texture2D] [--filter hero]
xera-ripper rip  <path> -o out [--types Texture2D,TextAsset,AudioClip] [--json]
xera-ripper dump <path> --id 12          # one object's decoded fields as JSON
```

Output layout: `out/<file>/<Class>/<name>_<pathId>.<ext>`. With `--json`, objects of every other class that have
a type tree are dumped as JSON under `_json/`.

## What works today

| Area | Status |
|---|---|
| Inputs | UnityFS bundles (format 6-8; stored, LZ4, LZ4HC, **LZMA**), serialized files (versions 9-40 headers, type-tree layouts of Unity 2017+), folders, `.apk`/`.zip` (read in place, not extracted) |
| Streamed data | `.resS` / `.resource` resolved from the same bundle, the same folder, or the same APK |
| Texture2D → PNG | Alpha8, R8, R16, RGB24, RGBA32, ARGB32, BGRA32, RGB565, RGBA4444, ARGB4444, **DXT1, DXT5** |
| TextAsset | exported as `.txt` (valid UTF-8) or `.bytes` |
| AudioClip | raw stream written as-is; Ogg/WAV/MP3 get the right extension, FMOD **FSB5** banks are written as `.fsb` (no decoder) |
| Everything else | listed, previewed and dumped as JSON through its type tree |

## What does **not** work yet (read this before pointing it at a Quest game)

- **No ASTC / ETC / PVRTC / BC4-BC7 / Crunch / float textures.** They are written as raw `<name>.<FORMAT>.bin` with a clear message.
  Quest and other Android games use ASTC/ETC2 heavily, so expect many textures to export raw until those decoders land.
- **Release player files have their type trees stripped.** Objects are still listed (id, class, size) but cannot be decoded:
  Xera Ripper reports `no-type-tree` for them. Bundles built with type trees (most Addressables/AssetBundles) work fully.
  A built-in per-Unity-version type-tree database is the planned fix.
- **No Mesh, Sprite, Material, Shader, AnimationClip, Scene or Prefab export, and no "rebuild a Unity project" mode** (AssetRipper's headline feature).
- Not supported: legacy `UnityWeb`/`UnityRaw` bundles, encrypted/custom-compressed bundles, zip64 archives (>4 GiB), IL2CPP metadata.
- Everything is held in memory (hard cap 3 GiB per bundle).

## Verification status (honest)

65 automated tests (`npm test`), covering the codecs, structure parsers, texture decoders, ZIP/APK reading, the export
pipeline, the HTTP API and its security checks. The LZMA decoder is checked against streams produced by `xz` (Python `lzma`),
and the ZIP reader against the system `zip` tool. **However, the bundle / serialized-file tests use synthetic files that I
generated from my knowledge of the format; I have not yet run Xera Ripper against a real shipped game.** If a real bundle fails
to open, that is a bug worth reporting with the file's Unity version.

## Security model of the web UI

It reads and writes your disk on request, so it is locked down: it listens on **127.0.0.1 only**; every API call needs a random
per-run token; requests with a foreign `Host` header are refused (DNS-rebinding); there are no CORS headers; the page is served with a
strict CSP (no inline script/style) and builds its DOM with `textContent` only, because asset names come from untrusted files;
exports are confined to the chosen folder and file names are sanitised.

## Tests

```bash
npm test
```

## Credits

UI font: **Kode Mono** (SIL Open Font License 1.1, https://fonts.google.com/specimen/Kode+Mono).
