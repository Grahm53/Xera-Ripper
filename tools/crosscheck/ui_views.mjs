#!/usr/bin/env node
// The tabs and views must work with a REAL mouse at every screen width, not just with Playwright's auto-scrolling click().
//
// For every click this asks the browser what is under the pointer (elementFromPoint) after scrolling like a person would, then clicks
// with raw mouse coordinates. It also fails on any console error, any horizontal page scroll, and any element hanging off the window.
//
//   node tools/crosscheck/ui_views.mjs <folder containing node_modules/playwright>      e.g. "$(npm root -g)"
import { createRequire } from 'node:module';
import { createApp } from '../../src/server.js';
import { makeProjectGame } from '../../test/helpers/projectFixture.js';

const root = process.argv[2];
if (!root) { console.error('usage: node tools/crosscheck/ui_views.mjs <npm root containing playwright>'); process.exit(2); }
const { chromium } = createRequire(`${root}/`)('playwright');
const game = makeProjectGame();
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/opt/pw-browsers/chromium' });

const WIDTHS = [[1920, 1000], [1480, 860], [1280, 720], [1024, 700], [961, 800], [960, 800], [768, 800], [601, 800], [600, 800], [390, 800], [320, 700]];
const problems = [];
let checks = 0;

for (const [w, hgt] of WIDTHS.filter(([x]) => !process.env.ONLY || String(x) === process.env.ONLY)) {
  const app = createApp({}); // a fresh server per width: loaded files live in the server session
  const { url } = await app.start({ port: 0 });
  const page = await browser.newPage({ viewport: { width: w, height: hgt } });
  const at = (what) => `${w}px ${what}`;
  page.on('console', (m) => { if (['error', 'warning'].includes(m.type())) problems.push(`${at('console')}: ${m.text()}`); });
  page.on('pageerror', (e) => problems.push(`${at('page error')}: ${e.message}`));
  const hash = () => page.evaluate(() => location.hash);

  // Scroll the element to the middle of the window (what a person does), then click the exact pixel with the raw mouse.
  async function click(selector, label, { expectHit = null } = {}) {
    checks++;
    const info = await page.evaluate(({ selector: sel }) => {
      const el = document.querySelector(sel);
      if (!el) return { found: false };
      el.scrollIntoView({ block: 'center', inline: 'center' });
      const r = el.getBoundingClientRect();
      const cx = r.x + Math.min(r.width / 2, 40), cy = r.y + r.height / 2; // a point near the left of long elements, always inside
      const hit = document.elementFromPoint(cx, cy);
      return { found: true, cx, cy, reachable: !!hit && (hit === el || el.contains(hit) || hit.contains(el)), hit: hit ? `${hit.tagName}.${hit.className}` : 'nothing', disabled: el.disabled === true };
    }, { selector });
    if (!info.found) { problems.push(`${at(label)}: ${selector} not found`); return false; }
    if (!info.reachable) { problems.push(`${at(label)}: a real click would hit ${info.hit}`); return false; }
    await page.mouse.click(info.cx, info.cy);
    if (expectHit) await page.waitForTimeout(150);
    return true;
  }
  async function noOverflow(label) {
    checks++;
    const r = await page.evaluate(() => ({ h: document.documentElement.scrollWidth > document.documentElement.clientWidth, sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
    if (r.h) problems.push(`${at(label)}: page scrolls horizontally (${r.sw} > ${r.cw})`);
  }
  const viewIs = (name) => page.waitForFunction((n) => document.body.dataset.view === n, name, { timeout: 3000 }).catch(() => problems.push(`${at('navigation')}: the ${name} view never rendered`));
  async function expectHash(re, label) {
    checks++;
    await page.waitForFunction((src) => new RegExp(src).test(location.hash), re.source, { timeout: 2000 }).catch(() => {});
    const hsh = await hash();
    if (!re.test(hsh)) problems.push(`${at(label)}: expected hash ${re} but it is ${hsh}`);
  }

  await page.goto(url);
  await page.waitForSelector('.welcome');
  await noOverflow('welcome');

  // tabs are disabled (not links) until something is loaded
  checks++;
  const disabledTabs = await page.$$eval('#tabs .tab.disabled', (e) => e.length);
  if (disabledTabs !== 4) problems.push(`${at('tabs before load')}: expected 4 disabled tabs, got ${disabledTabs}`);

  await page.fill('.pathrow input', game);
  await click('.pathrow .btn', 'Load button');
  await page.waitForSelector('tbody tr[data-id]');
  await expectHash(/^#\/assets/, 'after loading');
  await noOverflow('assets');

  // every top-level tab, by real click
  for (const [name, h1, re] of [['home', 'Home', /#\/home/], ['collections', 'Collections', /#\/collections/], ['bundles', 'Bundles', /#\/bundles/], ['scenes', 'Scenes', /#\/scenes$/], ['assets', null, /#\/assets/]]) {
    if (await click(`#tab-${name}`, `tab ${name}`)) {
      await expectHash(re, `tab ${name}`);
      await viewIs(name);
      if (h1) {
        checks++;
        await page.waitForFunction((t) => document.querySelector('#view h1')?.textContent.startsWith(t), h1, { timeout: 2000 }).catch(() => {}); // hashchange is async
        const got = await page.$eval('#view h1', (e) => e.textContent).catch(() => '');
        if (!got.startsWith(h1)) problems.push(`${at(`tab ${name}`)}: heading is "${got}", expected "${h1}"`);
      }
      await page.waitForTimeout(150);
      await noOverflow(`view ${name}`);
    }
  }

  // asset list: click a row, then every detail tab
  if (await click('tbody tr[data-id] a', 'first asset row')) {
    await page.waitForSelector('.dtabs');
    await expectHash(/sel=\d+/, 'selecting an asset');
    for (const tab of ['data', 'yaml', 'hex', 'overview']) {
      if (await click(`#dtab-${tab}`, `detail tab ${tab}`)) {
        await expectHash(tab === 'overview' ? /^#\/assets\?(?!.*tab=)/ : new RegExp(`tab=${tab}`), `detail tab ${tab}`);
        await page.waitForTimeout(150);
        checks++;
        const sel = await page.$eval('[role=tab][aria-selected=true]', (e) => e.dataset.tab);
        if (sel !== tab) problems.push(`${at(`detail tab ${tab}`)}: tab ${sel} is selected instead`);
        await noOverflow(`detail ${tab}`);
      }
    }
    // a texture shows a real image preview with a Download link; a text asset shows its text
    await click('.chips .chip[data-type=""]', 'All chip');
    await page.waitForFunction(() => document.querySelectorAll('tbody tr[data-id]').length > 5, null, { timeout: 3000 }).catch(() => {});
    const rowOf = (type) => page.evaluate((ty) => { const tr = [...document.querySelectorAll('tbody tr[data-id]')].find((r) => r.children[1].textContent === ty); return tr ? tr.dataset.id : null; }, type);
    for (const [type, sel] of [['Texture2D', '.preview img'], ['TextAsset', '.preview pre']]) {
      const id = await rowOf(type);
      checks++;
      if (id === null) { problems.push(`${at('preview')}: no ${type} row in the list`); continue; }
      await click(`tbody tr[data-id="${id}"] a`, `${type} row`);
      await page.waitForFunction((q) => document.querySelector(q), sel, { timeout: 4000 }).catch(() => problems.push(`${at('preview')}: ${type} shows no ${sel}`));
      if (type === 'Texture2D') {
        checks++;
        await page.waitForFunction(() => { const i = document.querySelector('.preview img'); return i && i.complete && i.naturalWidth > 0; }, null, { timeout: 4000 }).catch(() => problems.push(`${at('preview')}: the texture image did not decode`));
        const dl = await page.$eval('a.btn[download]', (a) => a.getAttribute('download')).catch(() => null);
        if (!dl || !dl.endsWith('.png')) problems.push(`${at('preview')}: expected a .png Download link, got ${dl}`);
      }
    }
    // the asset list is filterable by the chips, by real click
    if (await click('.chips .chip[data-type="TextAsset"]', 'type chip')) {
      await expectHash(/type=TextAsset/, 'type chip');
      await page.waitForTimeout(250);
      checks++;
      const rows = await page.$$eval('tbody tr[data-id] td:nth-child(2)', (e) => e.map((x) => x.textContent));
      if (!rows.length || rows.some((r) => r !== 'TextAsset')) problems.push(`${at('type chip')}: list is not filtered to TextAsset: ${rows}`);
    }
  }

  // collections -> assets of that file
  await click('#tab-collections', 'tab collections');
  await viewIs('collections');
  await page.waitForSelector('table.auto a.rowlink');
  if (await click('table.auto a.rowlink', 'collection link')) { await expectHash(/#\/assets\?.*file=\d+/, 'collection opens its assets'); await viewIs('assets'); }

  // scene: list -> tree -> toggle -> asset link
  await click('#tab-scenes', 'tab scenes');
  await viewIs('scenes');
  await page.waitForSelector('table.auto a.rowlink');
  if (await click('table.auto a.rowlink', 'scene link')) {
    if (!(await page.waitForSelector('ul.tree', { timeout: 4000 }).catch(() => null))) {
      problems.push(`${at('scene link')}: the scene page did not show a tree (hash ${await hash()}; page says: ${JSON.stringify((await page.$eval('#view', (e) => e.innerText)).slice(0, 160))})`);
      await page.close(); await app.stop(); continue;
    }
    await expectHash(/#\/scenes\/\d+/, 'scene opens');
    await noOverflow('scene tree');
    if (await click('#scene-collapse', 'collapse all')) {
      checks++;
      const expanded = await page.$$eval('button.tog[aria-expanded=true]', (e) => e.length);
      if (expanded !== 0) problems.push(`${at('collapse all')}: ${expanded} nodes still expanded`);
    }
    if (await click('button.tog', 'expand one node')) {
      checks++;
      const expanded = await page.$$eval('button.tog[aria-expanded=true]', (e) => e.length);
      if (expanded !== 1) problems.push(`${at('expand one node')}: expected 1 expanded node, got ${expanded}`);
    }
    if (await click('a.goname', 'GameObject link')) await expectHash(/#\/assets\?.*sel=\d+/, 'GameObject opens its asset');
  }

  // Back / Forward / reload
  checks++;
  await page.goBack(); await page.waitForTimeout(200);
  const back = await hash();
  if (!/#\/scenes\/\d+/.test(back)) problems.push(`${at('Back')}: expected the scene page, got ${back}`);
  await page.reload(); await page.waitForSelector('ul.tree').catch(() => {});
  checks++;
  if (!/#\/scenes\/\d+/.test(await hash()) || !(await page.$('ul.tree'))) problems.push(`${at('reload')}: the page did not come back to the scene`);

  // bundles: expandable, links to assets
  if (process.env.DEBUG) console.log(w, 'before bundles', await hash());
  await click('#tab-bundles', 'tab bundles');
  await viewIs('bundles');
  await page.waitForSelector('details.card');
  if (process.env.DEBUG) console.log(w, 'on bundles', await hash(), await page.$$eval('details.card a.rowlink', (e) => e.length));
  if (await click('details.card a.rowlink', 'bundle member link')) await expectHash(/#\/assets\?.*file=\d+/, 'bundle member opens its assets');

  await viewIs('assets');
  // project export dialog with settings: toggle a box with the real mouse and check it is sent
  await click('#menu-export', 'Export menu');
  const item = await page.evaluate(() => { const el = [...document.querySelectorAll('.dropdown button')].find((x) => x.textContent.includes('Export Unity project')); if (!el) return null; el.scrollIntoView({ block: 'center' }); const r = el.getBoundingClientRect(); const hit = document.elementFromPoint(r.x + 20, r.y + r.height / 2); return { x: r.x + 20, y: r.y + r.height / 2, ok: hit === el || el.contains(hit) }; });
  checks++;
  if (!item?.ok) problems.push(`${at('Export menu')}: "Export Unity project" is not clickable: ${JSON.stringify(item)} ${JSON.stringify(await page.evaluate(() => { const d = document.querySelector('.dropdown'); const el = [...document.querySelectorAll('.dropdown button')].find((x) => x.textContent.includes('Export Unity project')); const r = el?.getBoundingClientRect(); const hit = r && document.elementFromPoint(r.x + 20, r.y + r.height / 2); return { dropdown: !!d, scrollY, hit: hit ? hit.tagName + '.' + hit.className + ' ' + (hit.textContent || '').slice(0, 30) : null, rect: r && [r.x, r.y, r.width, r.height] }; }))}`);
  else {
    await page.mouse.click(item.x, item.y);
    if (!(await page.waitForSelector('fieldset.settings', { timeout: 3000 }).catch(() => null))) { problems.push(`${at('Export menu')}: clicking "Export Unity project" did not open the dialog (hash ${await hash()})`); await page.close(); await app.stop(); continue; }
    await noOverflow('export dialog');
    if (await click('fieldset.settings label:nth-of-type(1) input', 'textures checkbox')) {
      checks++;
      const on = await page.$eval('fieldset.settings label:nth-of-type(1) input', (e) => e.checked);
      if (on) problems.push(`${at('export settings')}: clicking the Textures checkbox did not turn it off`);
    }
    await page.keyboard.press('Escape');
  }
  await page.close();
  await app.stop();
}

// ---- the file dialog as it behaves on Windows: drive list, "C:\\" style paths, quoted paths. The server is told it is on win32 and
// answers /api/browse with Windows-shaped data; this checks the dialog's own logic (joining names, "This PC", Up from a drive root).
{
  const app = createApp({});
  const { url } = await app.start({ port: 0 });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.on('pageerror', (e) => problems.push(`windows dialog: page error ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') problems.push(`windows dialog: console ${m.text()}`); });
  const seen = [];
  await page.route('**/api/state', async (route) => { const r = await route.fetch(); const j = await r.json(); j.platform = 'win32'; j.home = 'C:\\Users\\Graham'; await route.fulfill({ json: j }); });
  await page.route('**/api/browse*', async (route) => {
    const p = new URL(route.request().url()).searchParams.get('path');
    seen.push(p);
    const dir = (path, parent, entries) => ({ path, parent, sep: '\\', selected: null, entries, truncated: false });
    if (p === 'drives:') return route.fulfill({ json: { ...dir('drives:', null, [{ name: 'C:\\', type: 'dir' }, { name: 'D:\\', type: 'dir' }]), drives: true } });
    if (p === 'D:\\') return route.fulfill({ json: dir('D:\\', 'drives:', [{ name: 'Games', type: 'dir' }, { name: 'level0', type: 'file', size: 10 }]) });
    return route.fulfill({ json: dir('C:\\Users\\Graham', 'C:\\Users', [{ name: 'MyGame', type: 'dir' }, { name: 'data.assets', type: 'file', size: 2048 }]) });
  });
  await page.goto(url);
  await page.waitForSelector('.welcome');
  await page.click('.welcome .btn.primary'); // Open File...
  await page.waitForSelector('.browser-list button');
  const winCheck = async (label, ok, detail = '') => { checks++; if (!ok) problems.push(`windows dialog: ${label}${detail ? ` (${detail})` : ''}`); };
  await winCheck('starts in the Windows home folder', (await page.$eval('.modal input[aria-label=Path]', (e) => e.value)) === 'C:\\Users\\Graham');
  await winCheck('shows a This PC button on Windows', !!(await page.$('.modal .row button:text-is("This PC")')));
  const labels = () => page.$$eval('.browser-list button', (e) => e.map((x) => x.textContent));
  const clickLabel = async (text) => { // real mouse on the list entry whose label contains `text`
    await page.waitForTimeout(350); // a person needs longer than the dialog's double-click guard (300 ms) to aim at the next entry
    const pt = await page.evaluate((t) => { const el = [...document.querySelectorAll('.browser-list button')].find((x) => x.textContent.includes(t)); if (!el) return null; el.scrollIntoView({ block: 'center' }); const r = el.getBoundingClientRect(); const hit = document.elementFromPoint(r.x + 20, r.y + r.height / 2); return hit === el || el.contains(hit) ? { x: r.x + 20, y: r.y + r.height / 2 } : null; }, text);
    if (!pt) { problems.push(`windows dialog: cannot click "${text}"`); return false; }
    await page.mouse.click(pt.x, pt.y); await page.waitForTimeout(200); return true;
  };
  await page.click('#browser-drives');
  await page.waitForFunction(() => [...document.querySelectorAll('.browser-list button')].some((x) => x.textContent.includes('D:')));
  const drives = await labels();
  await winCheck('lists the drives', drives.some((x) => x.includes('C:')) && drives.some((x) => x.includes('D:')), drives.join('|'));
  await clickLabel('D:');
  await winCheck('opens a drive as D:\\ (not drives:\\D:\\)', seen.at(-1) === 'D:\\', String(seen.at(-1)));
  await clickLabel('level0');
  const picked = await page.$eval('.modal input[aria-label=Path]', (e) => e.value);
  await winCheck('picking a file at a drive root gives D:\\level0 (no doubled backslash)', picked === 'D:\\level0', picked);
  await winCheck('the Open button is enabled once a file is picked', !(await page.$eval('#browser-confirm', (e) => e.disabled)));
  await clickLabel('↑');
  await winCheck('Up from a drive root goes to the drive list', seen.at(-1) === 'drives:', String(seen.at(-1)));
  // folder mode: the drive list itself is not a folder you can open, a folder inside a drive is
  await page.keyboard.press('Escape');
  await page.click('.welcome .actions .btn:not(.primary)'); // Open Folder...
  await page.waitForSelector('.modal');
  await page.click('#browser-drives');
  await page.waitForFunction(() => [...document.querySelectorAll('.browser-list button')].some((x) => x.textContent.includes('D:')));
  await winCheck('"Open this folder" is disabled on the drive list', await page.$eval('#browser-confirm', (e) => e.disabled));
  await clickLabel('D:');
  await winCheck('"Open this folder" is enabled inside a drive', !(await page.$eval('#browser-confirm', (e) => e.disabled)));
  await page.close();
  await app.stop();
}

await browser.close();
console.log(problems.length ? `FAIL\n  ${problems.join('\n  ')}` : `${checks} view checks passed (${WIDTHS.filter(([x]) => !process.env.ONLY || String(x) === process.env.ONLY).length} window width(s), real mouse, no console errors)`);
process.exit(problems.length ? 1 : 0);
