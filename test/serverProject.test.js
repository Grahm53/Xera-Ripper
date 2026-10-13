import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/server.js';
import { makeProjectGame } from './helpers/projectFixture.js';

let app, base, token, out;
const H = () => ({ 'X-Xera-Token': token, 'Content-Type': 'application/json' });
const post = (p, body) => fetch(base + p, { method: 'POST', headers: H(), body: JSON.stringify(body) });

before(async () => {
  out = mkdtempSync(join(tmpdir(), 'xera-sp-'));
  app = createApp({ defaultOutDir: out });
  const { port } = await app.start({ port: 0 });
  base = `http://127.0.0.1:${port}`; token = app.token;
});
after(() => app.stop());

test('POST /api/project: needs the token, an output folder and a loaded game', async () => {
  assert.equal((await fetch(`${base}/api/project`, { method: 'POST', body: '{}' })).status, 401);
  assert.equal((await post('/api/project', {})).status, 400);
  assert.equal((await post('/api/project', { outDir: out })).status, 409, 'nothing loaded yet');
});

test('POST /api/project builds the project and returns the report; the folder name is sanitised', async () => {
  assert.equal((await post('/api/load', { path: makeProjectGame() })).status, 200);
  const res = await post('/api/project', { outDir: out, name: '../../Escape/Me' });
  assert.equal(res.status, 200);
  const r = await res.json();
  assert.deepEqual([r.scenes, r.prefabs, r.textures], [1, 1, 1]);
  assert.equal(r.skippedCount, 2);
  assert.ok(r.projectDir.startsWith(out), `project must stay under the chosen folder: ${r.projectDir}`);
  assert.ok(existsSync(join(r.projectDir, 'Assets/Scenes/level1.unity')));
  assert.ok(!existsSync(join(out, '..', 'Escape')));
  assert.ok(readdirSync(out).length >= 1);

  const again = await (await post('/api/project', { outDir: out })).json();
  assert.ok(again.projectDir.endsWith('ExportedProject'), 'default project name');
});
