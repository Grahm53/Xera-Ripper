#!/usr/bin/env node
// Smoke test for a built single-file executable:  node tools/smoke-exe.mjs dist/xera-ripper[.exe]
// Runs the REAL binary: version/help, the web UI (embedded files), a Unity-project export (needs the embedded type-tree
// database), and "drag a folder onto the program".
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { makeProjectGame } from '../test/helpers/projectFixture.js';

const exe = resolve(process.argv[2] ?? '');
if (!process.argv[2] || !existsSync(exe)) { console.error('usage: node tools/smoke-exe.mjs <path to xera-ripper executable>'); process.exit(2); }
let failures = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  ${detail}`}`); if (!ok) failures++; };

const run = (...args) => spawnSync(exe, args, { encoding: 'utf8', timeout: 60000 });

// 1. basics
let r = run('--version');
check('--version says single-file build', r.status === 0 && /single-file build/.test(r.stdout), `${r.status} ${r.stdout} ${r.stderr}`);
r = run('--help');
check('--help lists the project command', r.status === 0 && /project <path>/.test(r.stdout) && /drag a game file/.test(r.stdout), r.stderr);
r = run('list', join(tmpdir(), 'definitely-not-here'));
check('a bad path is a one-line error, exit code 1', r.status === 1 && /no such file or folder/.test(r.stderr) && !/\n\s+at /.test(r.stderr), r.stderr);

// 2. a real game folder: project export (stripped files => needs the embedded type-tree database)
const game = makeProjectGame();
const outDir = mkdtempSync(join(tmpdir(), 'xera-smoke-'));
r = run('project', game, '-o', outDir, '--name', 'SmokeProject');
const proj = join(outDir, 'SmokeProject');
check('project export succeeds', r.status === 0, `${r.status}\n${r.stdout}\n${r.stderr}`);
check('  scene written (type-tree database works inside the exe)', existsSync(join(proj, 'Assets/Scenes/level1.unity')));
check('  prefab written at its original path', existsSync(join(proj, 'Assets/prefabs/hero.prefab')));
check('  scene YAML is Unity text format', existsSync(join(proj, 'Assets/Scenes/level1.unity')) && readFileSync(join(proj, 'Assets/Scenes/level1.unity'), 'utf8').startsWith('%YAML 1.1\n%TAG !u!'));

// 3. the web UI, with the folder "dropped" on the program
function startUi(args) {
  const child = spawn(exe, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  const url = new Promise((resolveUrl, reject) => {
    const timer = setTimeout(() => reject(new Error(`no URL printed within 20s:\n${out}`)), 20000);
    child.stdout.on('data', (d) => { out += d; const m = /(http:\/\/127\.0\.0\.1:\d+\/\?t=[\w-]+)/.exec(out); if (m) { clearTimeout(timer); resolveUrl(m[1]); } });
    child.on('exit', (c) => reject(new Error(`exited early (${c}):\n${out}`)));
  });
  return { child, url, output: () => out };
}
const ui = startUi([game, '--no-open', '--port', '0']);
try {
  const url = await ui.url;
  const u = new URL(url);
  const get = (path, headers = {}) => fetch(u.origin + path, { headers });
  const page = await fetch(url);
  const html = await page.text();
  check('UI page is served with the token injected', page.status === 200 && html.includes('<title>Xera Ripper</title>') && !html.includes('__XERA_TOKEN__'));
  for (const [path, type, minBytes] of [['/ui/app.js', 'javascript', 5000], ['/ui/style.css', 'css', 2000], ['/ui/fonts/KodeMono-VariableFont_wght.ttf', 'ttf', 30000],
    ['/ui/img/banner.jpg', 'jpeg', 5000], ['/ui/img/banner2.jpg', 'jpeg', 5000], ['/ui/img/pfp.jpg', 'jpeg', 5000]]) {
    const res = await get(path);
    const body = Buffer.from(await res.arrayBuffer());
    check(`embedded file ${path}`, res.status === 200 && res.headers.get('content-type').includes(type) && body.length > minBytes, `${res.status} ${body.length}B`);
  }
  const state = await (await get('/api/state', { 'X-Xera-Token': u.searchParams.get('t') })).json();
  check('dropped folder is already loaded (15 objects)', state.loaded && state.summary.assetCount === 15, JSON.stringify(state.summary?.assetCount));
  check('files use the built-in type-tree database', state.summary.files.some((f) => f.treeSource === 'database'));
  check('no token -> API refused', (await get('/api/state')).status === 401);
  check('printed "Loaded:" line', /Loaded: /.test(ui.output()));
} catch (e) {
  check('web UI started and answered', false, e.message);
} finally {
  ui.child.kill();
}

console.log(failures ? `\n${failures} check(s) FAILED` : '\nall smoke checks passed');
process.exit(failures ? 1 : 0);
