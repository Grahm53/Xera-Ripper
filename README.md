# =(X)= Xera Ripper

Xera's asset ripper, by Xera Games LLC.

Dependency-free Unity asset extractor with a local web UI (neon-cyan, Kode Mono) and a CLI.
Point it at a **UnityFS bundle, a serialized file (`level0`, `*.assets`), a game folder, or an `.apk`/`.zip`**,
browse every object inside, preview it, export it, or **export a whole Unity project**.

> Use it on games and content **you own or have the rights to extract** (modding your own builds, preservation,
> analysing your own projects). Re-releasing someone else's art/audio is a copyright problem, not a tool problem.
> This is an independent implementation written from the public file-format behaviour; it contains no code from AssetRipper.

## Windows: just double-click `xera-ripper.exe`

**Download:** https://github.com/Grahm53/Xera-Ripper/releases/latest/download/xera-ripper.exe

No Node.js and no install: **`xera-ripper.exe` is one file** with everything inside it.

- **Double-click it.** A black window opens and your browser opens Xera Ripper by itself (if it doesn't, copy the link shown in the window).
  Close the window to stop it.
- **Or drag a game file/folder onto the `.exe`** (an `.apk`, a bundle, a `level0` file, a game's `_Data` folder): it starts with that loaded.
- Command line works too: `xera-ripper.exe project "C:\Games\MyGame.apk" -o "C:\out"`.

**Windows will warn you** ("Windows protected your PC" / SmartScreen) because the file is not code-signed: click **More info → Run anyway**.
Some antivirus programs also distrust any freshly built, unsigned program. You can check the file you got against the `xera-ripper.exe.sha256`
that is published with it.

How it is built: Node.js "Single Executable Application" (the official `node.exe` with this app embedded; `node tools/build-exe.mjs --target win32`).
The GitHub workflow `Windows exe` builds it on a real Windows runner and smoke-tests the result (starts the UI, serves the embedded files,
exports a Unity project, loads a dropped folder) before publishing it as an artifact, and as a GitHub Release when you run the workflow from the Actions tab with a release tag.

## Run it (with Node.js, any OS)

```bash
node bin/xera-ripper.js serve            # prints a link like http://127.0.0.1:8765/?t=<token>
node bin/xera-ripper.js serve ~/MyGame   # same, with a path pre-loaded
```

Open the printed link (the `.exe` does this for you). **File → Open File… / Open Folder…** (or paste a path), browse and preview assets, then
**Export → Export Unity project…** (or **Export all…** for loose files). Requires Node 20+. No `npm install` (zero dependencies).

CLI:

```
xera-ripper list    <path> [--type Texture2D] [--filter hero]
xera-ripper rip     <path> -o out [--types Texture2D,TextAsset,AudioClip] [--json]
xera-ripper project <path> -o out [--name ExportedProject]   # a Unity project: open the folder with Unity
xera-ripper dump    <path> --id 12                           # one object's decoded fields as JSON
```

## Using the web UI

The page works like AssetRipper's: open something, then move between views with the **tab bar** (also in the **View** menu).
Every view has its own address (`#/assets?type=Texture2D&sel=12&tab=hex`), so **Back, Forward, reload and copied links all work**.

| View | What it shows |
|---|---|
| **Home** | What is loaded (assets, collections, bundles, scenes, Unity version), what is inside (click a type to list it), and the export buttons |
| **Assets** | Searchable, filterable list of every object (by name, path ID, type or file). Click one for its tabs: **Overview** (preview of textures / audio / text, **Download**, export), **Data** (decoded fields as JSON), **Unity YAML** (the object in Unity's text format), **Hex** (raw bytes, paged, jump to an offset) |
| **Collections** | One row per serialized file: container, Unity version, platform, object count, what is in it, and whether its type trees are embedded or come from the built-in database. Click to list that file's assets |
| **Bundles** | Each UnityFS bundle and the files packed inside it, with links to their assets |
| **Scenes** | Files that hold GameObjects; open one for its **hierarchy** (expand/collapse, find by name, components as links to the component's asset) |
| **Credits** | Under Help |

**Export → Export Unity project…** has an **export settings** list (textures, text, audio, scenes, prefabs, materials/meshes/other assets); your
choices are remembered. On **Windows** the file dialog has a **This PC** button for switching drives, and a path pasted with quotes
(`"C:\Games\MyGame"`, as Explorer's *Copy as path* gives it) is accepted everywhere a path can be typed.

## Export a Unity project

`project` builds `<out>/<name>/` with `Assets/`, `ProjectSettings/ProjectVersion.txt`, `Packages/manifest.json`, a `.meta` file with a
stable GUID for every asset, and `XeraRipper-Report.md` listing everything that could not be exported and why.
Open that folder with the Unity version printed at the end (it is the version the game was built with).

| What | Becomes |
|---|---|
| Texture2D | `.png` + `.meta` carrying sRGB / mip / filter / wrap settings (Unity 2019+) |
| TextAsset | `.txt` / `.bytes` |
| AudioClip | `.ogg` / `.wav` / `.mp3` (FMOD `.fsb` banks cannot be imported by Unity: reported, not written) |
| A file with GameObjects (a level) | a `.unity` scene with the full hierarchy |
| A prefab bundle | one `.prefab` per hierarchy, placed at its **original path** when the bundle's `AssetBundle` container knows it |
| `Resources.Load` content | `Assets/Resources/...` from the `ResourceManager` path table |
| Materials, meshes, animation clips and every other class that can be decoded | Unity text-serialised `.mat` / `.anim` / `.asset`, written in the editor's own layout (`serializedVersion`, editor-only fields defaulted) |

References between objects are rewritten to Unity's `{fileID, guid, type}` form (built-in resources included), so exported
materials point at exported textures, scenes at materials, and so on. A reference to something that could not be exported becomes
`{fileID: 0}` rather than a dangling pointer; a test checks that no exported file has a dangling local ID or an unknown GUID.

### What the project export does **not** do (read this)

- **Scripts are not decompiled.** MonoBehaviours keep their base fields but show a *missing script*; their script-specific fields
  are not written. (AssetRipper needs IL2CPP metadata for this; not implemented.)
- **Not verified in a Unity editor.** The YAML is generated from decoded data in the format the editor writes and is machine-checked
  (see below), but nobody has opened these projects in Unity yet. Meshes, animation clips and similar native classes are written
  straight from the decoded runtime data and **may need fixing**. Report what breaks.
- **Textures in ASTC / ETC / PVRTC / BC4-BC7 / Crunch / float formats are not exported** (no decoder yet), and neither are the
  materials' links to them. Quest and other Android games use ASTC/ETC2 heavily, so expect many missing textures there.
- **No shaders** (compiled platform bytecode), **no ProjectSettings / tags / layers / quality settings** reconstruction, no lightmaps,
  no sprite atlases / sprite metadata, no terrain.
- Custom tags become `Untagged` (only Unity's built-in tags are mapped).
- Everything is held in memory (hard cap 3 GiB per bundle). Unity-CN encrypted bundles, legacy `UnityWeb`/`UnityRaw` bundles and
  zip64 archives are not supported.

## What is supported

| Area | Status |
|---|---|
| Inputs | UnityFS bundles (format 6-8; stored, LZ4, LZ4HC, **LZMA**), serialized files (versions 9-40 headers), folders, `.apk`/`.zip` (read in place) |
| Stripped release builds | Retail player files (`level*`, `sharedassets*.assets`) have no type trees; Xera Ripper decodes them with a **built-in per-Unity-version type-tree database** (Unity 3.x to 6000, ~415 classes). Decoded bytes are checked against the object size, so a wrong layout is refused rather than mis-decoded |
| 64-bit path IDs | Exact (hashed bundle IDs such as `-6291524532174903347` are common in real AssetBundles) |
| Streamed data | `.resS` / `.resource` resolved from the same bundle, folder or APK |
| Texture2D → PNG | Alpha8, R8, R16, RGB24, RGBA32, ARGB32, BGRA32, RGB565, RGBA4444, ARGB4444, **DXT1, DXT5** (pixel-exact against a reference decoder) |
| Everything else | listed, previewed and dumped as JSON through its type tree |

## Verification status (honest)

`npm test`: **142 tests**. On top of that, `tools/crosscheck/` compares against **independent implementations**
(UnityPy, `texture2ddecoder`, Pillow, liblz4, PyYAML) — see its README for how to re-run them:

- 27 generated files (serialized v17-22, little/big endian, hashed IDs, 8 bundle layouts, 154 real-layout objects across Unity 2017-6000)
  decode **identically** in UnityPy.
- The type-tree database reader yields identical trees to UnityPy for all 3,320 class × version pairs.
- DXT1/DXT5 and the linear texture formats match the reference decoders pixel for pixel (RGB565 within 1).
- The web UI (every tab, view, menu item and the Windows-style file dialog) is exercised with a **real mouse in Chromium at 11 window widths**
  (`tools/crosscheck/ui_views.mjs`, `ui_menus.mjs`), failing on console errors, unreachable controls and horizontal page scroll. This is Chromium on Linux:
  the Windows file dialog is tested against simulated Windows answers, and the `.exe` itself is smoke-tested on a real Windows runner in CI.
- 1,437 generated Unity YAML documents (every class with an editor layout × 5 Unity versions, with deliberately awkward strings) parse with
  a real YAML parser and match the values they were generated from.

**Not covered:** files from real shipped games (none could be obtained in the development sandbox) and opening the exported projects in
a Unity editor. This cross-checking already found real bugs (the meaning of bundle flag `0x200` depends on the Unity version; format-6 bundles
from Unity 2019.4.15+ are 16-byte aligned; DXT1 must decode as opaque; 64-bit path IDs). If a real bundle fails, that is worth reporting
with its Unity version.

## Security model of the web UI

It reads and writes your disk on request, so it is locked down: it listens on **127.0.0.1 only**; every API call needs a random
per-run token; requests with a foreign `Host` header are refused (DNS-rebinding); there are no CORS headers; the page is served with a
strict CSP (no inline script/style) and builds its DOM with `textContent` only, because asset names come from untrusted files;
exports are confined to the chosen folder and file names are sanitised.

## Tests

```bash
npm test                                   # unit tests (no browser needed)
node tools/crosscheck/ui_views.mjs  "$(npm root -g)"   # every tab and view with a real mouse at 11 window widths (needs Playwright + Chromium)
node tools/crosscheck/ui_menus.mjs  "$(npm root -g)"   # every menu item, same idea
node tools/build-exe.mjs                   # single-file build for this OS  (npm install first: esbuild + postject are build-time only)
node tools/build-exe.mjs --target win32    # xera-ripper.exe from any OS
node tools/smoke-exe.mjs dist/xera-ripper.exe   # runs the real executable end to end
```

## Credits

UI font: **Kode Mono** (SIL Open Font License 1.1, https://fonts.google.com/specimen/Kode+Mono).
Type-tree database: `data/lzma.tpk` from UnityPy (MIT) / the AssetRipper Tpk project, see `data/NOTICE.md`.
