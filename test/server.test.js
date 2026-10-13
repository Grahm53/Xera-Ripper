import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/server.js';
import { makeGameDir } from './helpers/fixture.js';

let app, base, token, port, gameDir, outDir;
const H = (extra = {}) => ({ 'X-Xera-Token': token, ...extra });

before(async () => {
  outDir = mkdtempSync(join(tmpdir(), 'xera-srv-out-'));
  app = createApp({ defaultOutDir: outDir });
  const r = await app.start({ port: 0 });
  port = r.port; token = app.token; base = `http://127.0.0.1:${port}`;
  gameDir = makeGameDir();
});
after(() => app.stop());

// raw request so we can forge the Host header (fetch will not let us)
function raw({ path = '/', method = 'GET', headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end(body);
  });
}
const get = (p, headers = H()) => fetch(base + p, { headers });
const post = (p, body, headers = H({ 'Content-Type': 'application/json' })) => fetch(base + p, { method: 'POST', headers, body: JSON.stringify(body) });

test('index needs the token, then serves the app with a strict CSP and the token injected', async () => {
  assert.equal((await fetch(base + '/')).status, 403);
  assert.equal((await fetch(base + '/?t=wrong')).status, 403);
  const ok = await fetch(`${base}/?t=${token}`);
  assert.equal(ok.status, 200);
  const html = await ok.text();
  assert.ok(html.includes(`content="${token}"`));
  assert.ok(!html.includes('__XERA_TOKEN__'));
  const csp = ok.headers.get('content-security-policy');
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /script-src 'self'/);
  assert.ok(!/unsafe-inline|unsafe-eval/.test(csp));
  assert.equal(ok.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(ok.headers.get('access-control-allow-origin'), null, 'no CORS: other sites must not be able to read responses');
});

test('static files: only the allow-listed UI assets are served', async () => {
  for (const [p, type] of [['/ui/app.js', 'javascript'], ['/ui/style.css', 'css'], ['/ui/fonts/KodeMono-VariableFont_wght.ttf', 'ttf']]) {
    const r = await fetch(base + p);
    assert.equal(r.status, 200, p);
    assert.match(r.headers.get('content-type'), new RegExp(type));
  }
  for (const p of ['/ui/../src/server.js', '/ui/%2e%2e/package.json', '/ui/index.html', '/package.json', '/src/session.js', '/ui/fonts/']) {
    assert.equal((await raw({ path: p })).status, 404, p);
  }
  assert.equal((await fetch(base + '/ui/app.js', { method: 'POST' })).status, 405);
});

test('DNS-rebinding guard: a forged Host header is refused everywhere', async () => {
  for (const host of ['evil.example.com', `evil.example.com:${port}`, '127.0.0.1', `127.0.0.1:${port + 1}`, `localhost.evil.com:${port}`]) {
    assert.equal((await raw({ path: `/?t=${token}`, headers: { host } })).status, 403, host);
    assert.equal((await raw({ path: '/api/state', headers: { host, 'x-xera-token': token } })).status, 403, host);
  }
  assert.equal((await raw({ path: '/api/state', headers: { host: `localhost:${port}`, 'x-xera-token': token } })).status, 200);
});

test('API requires the token', async () => {
  for (const headers of [{}, { 'X-Xera-Token': 'nope' }, { 'X-Xera-Token': token.slice(0, -1) }, { 'X-Xera-Token': token + 'x' }]) {
    const r = await get('/api/state', headers);
    assert.equal(r.status, 401);
    assert.equal((await r.json()).error, 'missing or invalid token');
  }
  assert.equal((await get('/api/state')).status, 200);
  assert.equal((await fetch(`${base}/api/state?t=${token}`)).status, 401, 'token in the query string is not accepted for the API');
});

test('empty state, bad loads and bad requests are clean errors', async () => {
  const st = await (await get('/api/state')).json();
  assert.equal(st.loaded, false);
  assert.deepEqual(st.exportable, ['Texture2D', 'TextAsset', 'AudioClip']);
  assert.equal((await post('/api/load', {})).status, 400);
  const missing = await post('/api/load', { path: '/definitely/not/here' });
  assert.equal(missing.status, 400);
  assert.match((await missing.json()).error, /no such file or folder/);
  assert.equal((await post('/api/export', { outDir: outDir })).status, 409);
  assert.equal((await fetch(base + '/api/load', { method: 'POST', headers: H(), body: '{nope' })).status, 400);
  assert.equal((await fetch(base + '/api/load', { method: 'POST', headers: H(), body: JSON.stringify({ path: 'x'.repeat(2 * 1024 * 1024) }) })).status, 413);
  assert.equal((await get('/api/nope')).status, 404);
  assert.equal((await get('/api/asset/99999')).status, 404);
  assert.equal((await get('/api/asset/abc')).status, 404);
});

test('load -> list -> detail -> preview -> export over HTTP', async () => {
  const loaded = await post('/api/load', { path: gameDir });
  assert.equal(loaded.status, 200);
  const sum = await loaded.json();
  assert.equal(sum.assetCount, 8);
  assert.equal(sum.counts.Texture2D, 5);

  const all = await (await get('/api/assets?limit=3')).json();
  assert.equal(all.total, 8);
  assert.equal(all.rows.length, 3);
  assert.deepEqual((await (await get('/api/assets?q=hero')).json()).rows.map((r) => r.name), ['Hero']);
  assert.equal((await (await get('/api/assets?type=TextAsset')).json()).total, 2);
  assert.equal((await (await get('/api/assets?type=Texture2D&file=0')).json()).total, 1);
  assert.equal((await get('/api/assets?limit=999999&offset=-5')).status, 200, 'out-of-range paging params are clamped');

  const hero = (await (await get('/api/assets?q=hero')).json()).rows[0];
  const detail = await (await get(`/api/asset/${hero.id}`)).json();
  assert.equal(detail.data.m_Width, 2);
  assert.equal(detail.fileName, 'Game_Data/scene.unity3d/CAB-abc');

  const prev = await get(`/api/asset/${hero.id}/preview`);
  assert.equal(prev.status, 200);
  assert.equal(prev.headers.get('content-type'), 'image/png');
  assert.deepEqual([...Buffer.from(await prev.arrayBuffer()).subarray(1, 4)], [0x50, 0x4e, 0x47]);

  const astc = (await (await get('/api/assets?q=astc')).json()).rows[0];
  const bad = await get(`/api/asset/${astc.id}/preview`);
  assert.equal(bad.status, 422);
  assert.match((await bad.json()).error, /ASTC_6x6/);

  const exp = await post('/api/export', { outDir, types: ['Texture2D', 'NotAType'], filter: { type: 'Texture2D' }, json: false });
  assert.equal(exp.status, 200);
  const r = await exp.json();
  assert.equal(r.written, 3);
  assert.equal(r.raw, 1);
  assert.equal(r.noTypeTree, 1);
  assert.ok(r.problemCount >= 2);
  assert.ok(existsSync(join(outDir, 'Game_Data/scene.unity3d/CAB-abc/Texture2D/Hero_1.png')));

  const one = await post('/api/export', { outDir: join(outDir, 'single'), ids: [hero.id, 'x', 1.5] });
  assert.equal((await one.json()).written, 1);
  assert.equal((await post('/api/export', {})).status, 400);

  const log = await (await get('/api/log')).json();
  assert.ok(log.lines.some((l) => l.includes('loaded 3 serialized file(s)')));
  assert.equal((await post('/api/reset', {})).status, 200);
  assert.equal((await (await get('/api/state')).json()).loaded, false);
});

test('file browser lists dirs first, resolves files to their folder, and fails cleanly', async () => {
  const r = await (await get(`/api/browse?path=${encodeURIComponent(gameDir)}`)).json();
  assert.equal(r.entries[0].type, 'dir');
  assert.equal(r.entries[0].name, 'Game_Data');
  assert.ok(r.entries.some((e) => e.type === 'file' && e.name === 'readme.txt'));
  const f = await (await get(`/api/browse?path=${encodeURIComponent(join(gameDir, 'readme.txt'))}`)).json();
  assert.equal(f.path, gameDir);
  assert.equal(f.selected, 'readme.txt');
  assert.equal((await get('/api/browse?path=/no/such/dir')).status, 404);
  assert.ok((await (await get('/api/browse')).json()).path.length > 0, 'defaults to the home folder');
});
