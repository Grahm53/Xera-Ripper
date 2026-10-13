# data/lzma.tpk

A compact database of Unity's runtime type trees (the field layout of every engine class, per Unity version),
used by Xera Ripper to decode objects in files whose type trees were stripped at build time.

* The file is the `lzma.tpk` distributed with **UnityPy** (MIT License, Copyright (c) K0lb3), which in turn is produced
  by the AssetRipper **Tpk** project from Unity's own class information. See https://github.com/K0lb3/UnityPy and
  https://github.com/AssetRipper/Tpk for the upstream data and its terms.
* Format: `TPK*` header, LZMA-compressed type-tree-information blob. Read by `src/tpk.js` (an independent JavaScript
  implementation written from the format's public structure; no code is copied).

UnityPy's MIT license text:

```
MIT License

Copyright (c) 2019-2026 K0lb3

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
