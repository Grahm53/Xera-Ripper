import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// The page is served with a strict CSP and renders names that come from untrusted game files. These checks keep the UI code inside
// those rules: a violation here would either break the page in a browser (blocked by the CSP) or open an injection hole.
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(root, p), 'utf8');
const app = read('ui/app.js');
const html = read('ui/index.html');
const css = read('ui/style.css');
const server = read('src/server.js');

// strip comments so a comment that mentions a forbidden API does not trip the check
const code = app.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');

test('ui/app.js never parses markup or runs strings as code', () => {
  for (const bad of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write', 'eval(', 'new Function', 'srcdoc', 'DOMParser', 'createContextualFragment']) {
    assert.ok(!code.includes(bad), `ui/app.js uses ${bad}`);
  }
});

test('no inline style or script: the CSP (style-src self, script-src self) would block them', () => {
  assert.ok(!/setAttribute\(\s*['"]style['"]/.test(code), 'setAttribute("style") is blocked by the CSP');
  assert.ok(!/cssText/.test(code), 'cssText is blocked by the CSP');
  assert.ok(!/<\s*style[\s>]/i.test(html), 'inline <style> in index.html');
  assert.ok(!/\sstyle\s*=/i.test(html), 'style= attribute in index.html');
  assert.ok(!/\son[a-z]+\s*=/i.test(html), 'inline event handler attribute in index.html');
  assert.equal([...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].filter((m) => m[1].trim()).length, 0, 'inline script body in index.html');
  assert.ok(!/@import\s+url\(\s*['"]?https?:/i.test(css), 'the stylesheet must not pull in remote CSS');
});

test('external links all carry rel=noopener (credits and Help menu)', () => {
  for (const m of code.matchAll(/target:\s*'_blank'([^}]*)/g)) assert.match(m[1], /noopener/, 'target=_blank without rel=noopener');
  for (const m of code.matchAll(/window\.open\(([^)]*)\)/g)) assert.match(m[1], /noopener/, 'window.open without noopener');
});

test('every API path the UI calls exists on the server', () => {
  const used = new Set([...app.matchAll(/['"`](\/api\/[a-z]+)/g)].map((m) => m[1]));
  assert.ok(used.size >= 12, `expected the UI to use many API routes, found ${[...used]}`);
  // routes are written either as 'GET /api/state' or as a regexp literal like /^\/api\/asset\/(\d+)/
  for (const p of used) assert.ok(server.includes(`${p}'`) || server.includes(p.replaceAll('/', '\\/')), `UI calls ${p} but the server has no such route`);
});

test('router: every view the tab bar and View menu link to is a known route, and unknown hashes fall back to Home', () => {
  const tabs = [...app.matchAll(/\['(home|assets|collections|bundles|scenes)', 'view\.\w+'\]/g)].map((m) => m[1]);
  assert.deepEqual(tabs, ['home', 'assets', 'collections', 'bundles', 'scenes']);
  // the strings the menu and tab bar use must all exist in the English table
  for (const k of ['view.home', 'view.assets', 'view.collections', 'view.bundles', 'view.scenes', 'help.credits', 'help.github', 'help.issue']) {
    assert.ok(app.includes(`'${k}':`), `missing UI string ${k}`);
  }
});
