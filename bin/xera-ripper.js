#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { Session } from '../src/session.js';
import { EXPORTABLE } from '../src/exporters.js';
import { createApp } from '../src/server.js';
import { toJsonSafe } from '../src/typeTree.js';
import { isSea } from '../src/assets.js';
import { openBrowser } from '../src/openBrowser.js';
import { resolveCommand, shouldOpenBrowser } from '../src/cli.js';

const VERSION = '0.1.1';

const HELP = `Xera Ripper: Unity asset extractor

Usage
  xera-ripper                                   (the .exe, double-clicked) start the web UI and open your browser
  xera-ripper <file-or-folder>                  (drag a game file onto the .exe) start the UI with it loaded
  xera-ripper serve [path] [--port 8765] [--open|--no-open]
                                                start the web UI (optionally pre-loading a path)
  xera-ripper list <path> [--type T] [--filter text] [--limit N]
  xera-ripper rip  <path> -o <dir> [--types Texture2D,TextAsset,AudioClip] [--json]
  xera-ripper project <path> -o <dir> [--name ExportedProject]
                                                build a Unity project (Assets/, ProjectSettings/, .meta, scenes, prefabs)
  xera-ripper dump <path> --id N                print one object's decoded fields as JSON

<path> may be a UnityFS bundle, a serialized file (level0, *.assets), a folder, or an .apk/.zip.
Use this on games and content you own or have the rights to extract.
`;

const { values: o, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    out: { type: 'string', short: 'o' }, types: { type: 'string' }, json: { type: 'boolean', default: false },
    type: { type: 'string' }, filter: { type: 'string' }, limit: { type: 'string' }, id: { type: 'string' },
    port: { type: 'string' }, name: { type: 'string' }, help: { type: 'boolean', short: 'h' },
    open: { type: 'boolean', default: false }, 'no-open': { type: 'boolean', default: false }, version: { type: 'boolean', short: 'v' },
  },
});

if (o.version) { process.stdout.write(`xera-ripper ${VERSION}${isSea ? ' (single-file build)' : ''}\n`); process.exit(0); }
const resolved = resolveCommand(positionals, { isSea, exists: (p) => existsSync(p) });
const { cmd, target } = resolved;
if (o.help || !cmd) { process.stdout.write(HELP); process.exit(cmd || o.help ? 0 : 1); }

// A double-clicked .exe lives in its own console window that vanishes on exit; keep errors readable there.
async function pauseIfDoubleClicked() {
  if (!(isSea && process.platform === 'win32' && process.stdin.isTTY)) return;
  process.stdout.write('\nPress Enter to close this window...');
  await new Promise((resolve) => { process.stdin.resume(); process.stdin.once('data', resolve); });
}

class Fatal extends Error {}
// Stops the command with a one-line message (no stack trace); handled once, at the bottom of this file.
function die(msg) { throw new Fatal(msg); }

function load(path) {
  if (!path) die(`"${cmd}" needs a <path>`);
  const s = new Session();
  try { s.load(path); } catch (e) { die(e.code === 'ENOENT' ? `no such file or folder: ${path}` : e.message); }
  for (const x of s.skipped) process.stderr.write(`skipped ${x.name}: ${x.reason}\n`);
  if (!s.loaded) die('no Unity serialized files or bundles found');
  return s;
}

async function main() {
switch (cmd) {
  case 'serve': {
    const app = createApp({ defaultOutDir: join(homedir(), 'xera-ripper-out') });
    if (target) {
      try { app.session.load(target); } catch (e) { die(e.message); }
    }
    const port = o.port === undefined ? 8765 : Number(o.port);
    if (!Number.isInteger(port) || port < 0 || port > 65535) die('invalid --port');
    // default port first; if it is taken (e.g. a second copy is open) fall back to any free one
    const started = await app.start({ port }).catch(async (e) => {
      if (e.code === 'EADDRINUSE' && o.port === undefined) return app.start({ port: 0 });
      return die(e.code === 'EADDRINUSE' ? `port ${port} is in use (try --port 0 for a free one)` : e.message);
    });
    const { url } = started;
    const open = shouldOpenBrowser({ autoOpen: resolved.autoOpen, open: o.open, noOpen: o['no-open'] });
    process.stdout.write(`\n  =(X)=  Xera Ripper ${VERSION}\n\n  Your browser should open by itself. If it does not, open this link:\n  ${url}\n\n`
      + `  (listens on 127.0.0.1 only; the link carries a one-time access token)\n  ${isSea ? 'Close this window to stop Xera Ripper.' : 'Ctrl+C to stop.'}\n\n`);
    if (resolved.dropped && target) process.stdout.write(`  Loaded: ${target}\n${resolved.extra?.length ? `  (only the first of ${1 + resolved.extra.length} dropped items was loaded)\n` : ''}\n`);
    if (open) openBrowser(url);
    process.on('SIGINT', () => app.stop().then(() => process.exit(0)));
    break;
  }
  case 'list': {
    const s = load(target);
    const { rows, total } = s.list({ type: o.type ?? '', q: o.filter ?? '', limit: Number(o.limit ?? 1000) });
    const w = (v, n) => String(v).padEnd(n).slice(0, n);
    process.stdout.write(`${w('ID', 7)}${w('TYPE', 18)}${w('PATH ID', 22)}${w('SIZE', 12)}NAME\n`);
    for (const r of rows) process.stdout.write(`${w(r.id, 7)}${w(r.type, 18)}${w(r.pathId, 22)}${w(r.size, 12)}${r.name}\n`);
    process.stdout.write(`\n${total} object(s) matched${total > rows.length ? ` (showing ${rows.length})` : ''}\n`);
    break;
  }
  case 'rip': {
    if (!o.out) die('rip needs -o <output folder>');
    const s = load(target);
    const types = o.types ? o.types.split(',').map((x) => x.trim()).filter(Boolean) : EXPORTABLE;
    const bad = types.filter((t) => !EXPORTABLE.includes(t));
    if (bad.length) die(`cannot export ${bad.join(', ')} yet (supported: ${EXPORTABLE.join(', ')})`);
    const r = s.export({ outDir: o.out, types, json: o.json });
    for (const i of r.items) if (i.status !== 'ok') process.stderr.write(`${i.status}: ${i.type} ${i.name} ${i.note ?? ''}\n`);
    process.stdout.write(`\nwritten ${r.written}, raw ${r.raw}, without type tree ${r.noTypeTree}, failed ${r.failed}\n-> ${r.outDir}\n`);
    process.exit(r.failed ? 2 : 0);
    break;
  }
  case 'project': {
    if (!o.out) die('project needs -o <output folder>');
    const s = load(target);
    let r;
    try { r = s.exportProject({ outDir: o.out, projectName: o.name ?? 'ExportedProject' }); } catch (e) { die(e.message); }
    const reasons = Object.entries(r.skippedByReason).sort((a, b) => b[1] - a[1]);
    process.stdout.write(`\nUnity project (${r.unityVersion || 'unknown version'}): ${r.textures} textures, ${r.text} text, ${r.audio} audio, `
      + `${r.scenes} scenes, ${r.prefabs} prefabs, ${r.yamlAssets} other assets\n`);
    if (reasons.length) process.stdout.write(`not exported: ${r.skipped.length}\n${reasons.map(([why, n]) => `  ${n} x ${why}`).join('\n')}\n`);
    process.stdout.write(`-> ${r.projectDir}\nOpen that folder with Unity ${r.unityVersion || '(the matching version)'}. See XeraRipper-Report.md inside it.\n`);
    break;
  }
  case 'dump': {
    const s = load(target);
    if (o.id === undefined) die('dump needs --id N (see `list`)');
    const id = Number(o.id);
    if (!Number.isInteger(id) || !s.assets[id]) die(`no object with id ${o.id}`);
    const a = s.assets[id];
    try { process.stdout.write(`${JSON.stringify(toJsonSafe(s.files[a.fileIndex].sf.readObject(a.obj)), null, 2)}\n`); } catch (e) { die(e.message); }
    break;
  }
  default:
    process.stderr.write(`unknown command "${cmd}"\n\n${HELP}`);
    process.exit(1);
}
}

main().catch(async (e) => {
  process.stderr.write(`xera-ripper: ${e?.message ?? e}\n`);
  if (!(e instanceof Fatal) && process.env.XERA_DEBUG) process.stderr.write(`${e?.stack ?? ''}\n`);
  await pauseIfDoubleClicked();
  process.exit(1);
});
