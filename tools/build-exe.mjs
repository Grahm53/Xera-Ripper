#!/usr/bin/env node
// Builds a single-file executable of Xera Ripper using Node's Single Executable Applications feature:
//   1. bundle bin/xera-ripper.js + src/ into one CommonJS file (esbuild; the only build-time dependency besides postject)
//   2. embed the UI, font, images and the type-tree database as SEA assets
//   3. inject the blob into a copy of the official Node binary (postject)
//
//   node tools/build-exe.mjs                       build for the machine you are on
//   node tools/build-exe.mjs --target win32        build xera-ripper.exe from any OS (downloads + verifies Node's official node.exe)
//   options: --out <file>  --node-binary <path to a node binary of the SAME version as the one running this script>
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { BUNDLED_ASSETS } from '../src/server.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SENTINEL = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2'; // fixed by Node; postject flips ":0" to ":1"
const { values: o } = parseArgs({ options: { target: { type: 'string' }, out: { type: 'string' }, 'node-binary': { type: 'string' } } });
const target = o.target ?? process.platform;
if (!['win32', 'linux'].includes(target)) throw new Error(`unsupported --target ${target} (win32 and linux; macOS needs code-signing steps this script does not do)`);
const exeName = target === 'win32' ? 'xera-ripper.exe' : 'xera-ripper';
const out = resolve(ROOT, o.out ?? join('dist', exeName));
const BUILD = join(ROOT, 'build');
const log = (m) => process.stdout.write(`${m}\n`);

mkdirSync(BUILD, { recursive: true });
mkdirSync(dirname(out), { recursive: true });

// ---- 1. bundle -------------------------------------------------------------------------------------------------------
const bundle = join(BUILD, 'xera-ripper.cjs');
await build({
  entryPoints: [join(ROOT, 'bin/xera-ripper.js')],
  outfile: bundle, bundle: true, platform: 'node', format: 'cjs', target: 'node22', legalComments: 'none', logLevel: 'warning',
  // sources use import.meta.url only on the non-embedded code path; give the CJS bundle an equivalent value
  define: { 'import.meta.url': '__import_meta_url' },
  banner: { js: "const __import_meta_url = typeof __filename === 'string' ? require('node:url').pathToFileURL(__filename).href : 'file:///';" },
});
// the entry file's #! line is not valid after the banner; drop any hashbang that survived
const bundled = readFileSync(bundle, 'utf8').replace(/^#!.*\n/m, '');
writeFileSync(bundle, bundled);
log(`bundled: ${(bundled.length / 1024).toFixed(0)} KB of JavaScript`);

// ---- 2. SEA blob ---------------------------------------------------------------------------------------------------
const assets = Object.fromEntries(BUNDLED_ASSETS.map((key) => [key, join(ROOT, key)]));
for (const [key, p] of Object.entries(assets)) if (!existsSync(p)) throw new Error(`missing asset ${key}`);
const blob = join(BUILD, 'sea-prep.blob');
const seaConfig = join(BUILD, 'sea-config.json');
writeFileSync(seaConfig, JSON.stringify({ main: bundle, output: blob, disableExperimentalSEAWarning: true, useCodeCache: false, useSnapshot: false, assets }, null, 2));
let r = spawnSync(process.execPath, ['--experimental-sea-config', seaConfig], { cwd: ROOT, stdio: 'inherit' });
if (r.status !== 0) throw new Error('could not create the SEA blob');
log(`blob: ${(statSync(blob).size / 1048576).toFixed(2)} MB with ${BUNDLED_ASSETS.length} embedded assets`);

// ---- 3. base node binary --------------------------------------------------------------------------------------------
async function officialWindowsNode() {
  const v = process.version; // the blob was made by THIS node, so the binary must be exactly this version
  const cache = join(BUILD, 'cache', v);
  mkdirSync(cache, { recursive: true });
  const file = join(cache, 'node.exe');
  const base = `https://nodejs.org/dist/${v}`;
  const sums = await (await fetch(`${base}/SHASUMS256.txt`)).text();
  const want = sums.split('\n').map((l) => l.trim().split(/\s+/)).find(([, name]) => name === 'win-x64/node.exe')?.[0];
  if (!want) throw new Error(`no checksum for win-x64/node.exe in ${base}/SHASUMS256.txt`);
  const sha = (b) => createHash('sha256').update(b).digest('hex');
  if (!existsSync(file) || sha(readFileSync(file)) !== want) {
    log(`downloading ${base}/win-x64/node.exe ...`);
    const res = await fetch(`${base}/win-x64/node.exe`);
    if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
    writeFileSync(file, Buffer.from(await res.arrayBuffer()));
  }
  const got = sha(readFileSync(file));
  if (got !== want) throw new Error(`checksum mismatch for node.exe: expected ${want}, got ${got}`);
  log(`node.exe ${v}: sha256 verified (${want.slice(0, 16)}...)`);
  return file;
}

// Remove the Authenticode signature (it cannot stay valid once the file is modified): the result is "unsigned" rather than "tampered".
function stripSignature(buf) {
  const pe = buf.readUInt32LE(0x3c);
  if (buf.toString('latin1', pe, pe + 4) !== 'PE\0\0') throw new Error('not a PE file');
  const opt = pe + 24;
  const magic = buf.readUInt16LE(opt);
  const dir = opt + (magic === 0x20b ? 112 : 96);
  const certOffset = buf.readUInt32LE(dir + 4 * 8);
  const certSize = buf.readUInt32LE(dir + 4 * 8 + 4);
  if (certOffset === 0 || certSize === 0) return buf;
  if (certOffset + certSize < buf.length - 8) throw new Error('certificate table is not at the end of the file; refusing to guess');
  buf.writeUInt32LE(0, dir + 4 * 8);
  buf.writeUInt32LE(0, dir + 4 * 8 + 4);
  buf.writeUInt32LE(0, opt + 64); // checksum (not verified for executables)
  return buf.subarray(0, certOffset);
}

let nodeBinary = o['node-binary'];
if (!nodeBinary) nodeBinary = target === process.platform ? process.execPath : target === 'win32' ? await officialWindowsNode() : null;
if (!nodeBinary) throw new Error('pass --node-binary for a cross build to this target');
let base = readFileSync(nodeBinary);
if (target === 'win32') { const before = base.length; base = stripSignature(Buffer.from(base)); if (base.length !== before) log(`removed the ${before - base.length} byte Authenticode signature`); }
rmSync(out, { force: true });
writeFileSync(out, base);
if (target !== 'win32') chmodSync(out, 0o755);

// ---- 4. inject -------------------------------------------------------------------------------------------------------
const { inject } = createRequire(import.meta.url)('postject');
await inject(out, 'NODE_SEA_BLOB', readFileSync(blob), { sentinelFuse: SENTINEL });
const final = readFileSync(out);
if (!final.includes(`${SENTINEL}:1`)) throw new Error('injection did not flip the SEA fuse; the binary would not run the embedded app');
const sha = createHash('sha256').update(final).digest('hex');
writeFileSync(`${out}.sha256`, `${sha}  ${exeName}\n`);
log(`\nbuilt ${out}\n  ${(final.length / 1048576).toFixed(1)} MB, sha256 ${sha}`);
