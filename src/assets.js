import { readFileSync } from 'node:fs';

// Read a bundled resource by its repo-relative key (e.g. 'ui/app.js', 'data/lzma.tpk').
// Normally that is a file next to the sources; inside a Node single-executable build the same keys are embedded in the
// binary (see tools/build-exe.mjs), so nothing has to be unpacked next to the .exe.
//
// process.getBuiltinModule (Node 20.16+/22.3+) is used instead of `import 'node:sea'` so that older Node 20 releases, which
// have no node:sea module, still load this file.
const sea = process.getBuiltinModule?.('node:sea');
export const isSea = Boolean(sea?.isSea?.());

export function readAsset(key) {
  if (isSea) return Buffer.from(new Uint8Array(sea.getRawAsset(key)));
  return readFileSync(new URL(`../${key}`, import.meta.url));
}
