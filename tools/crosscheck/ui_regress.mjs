#!/usr/bin/env node
// Regression checks for bugs an independent review found in the UI. Each scenario drives a real Chromium with real mouse/keyboard input.
//
//   node tools/crosscheck/ui_regress.mjs <folder containing node_modules/playwright>      e.g. "$(npm root -g)"
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../../src/server.js';
import { makeProjectGame } from '../../test/helpers/projectFixture.js';
import { buildSerializedFile, textAssetData, texture2DData, TEXTASSET_TREE, TEXTURE2D_TREE } from '../../test/helpers/builders.js';

const root = process.argv[2];
if (!root) { console.error('usage: node tools/crosscheck/ui_regress.mjs <npm root containing playwright>'); process.exit(2); }
const { chromium } = createRequire(`${root}/`)('playwright');
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/opt/pw-browsers/chromium' });
const problems = [];
let checks = 0;
const tmp = () => mkdtempSync(join(tmpdir(), 'xera-reg-'));

async function scenario(name, { width = 1280, height = 800, notice = null, setup }, body) {
  const app = createApp({});
  if (notice) app.setNotice(notice);
  const { url } = await app.start({ port: 0 });
  const page = await browser.newPage({ viewport: { width, height }, acceptDownloads: true });
  const fail = (msg) => problems.push(`${name} (${width}px): ${msg}`);
  const check = (ok, msg) => { checks++; if (!ok) fail(msg); };
  page.on('pageerror', (e) => fail(`page error: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !/status of 4\d\d|status of 500/.test(m.text())) fail(`console: ${m.text()}`); }); // failed API calls are expected in some scenarios
  try {
    const ctx = setup ? await setup() : {};
    await page.goto(url);
    await page.waitForSelector('#menubar .menu');
    await body({ page, check, fail, ctx, url, app });
  } catch (e) { fail(`threw ${e.message.split('\n')[0]}`); }
  await page.close();
  await app.stop();
}

// click the centre-left of an element with the raw mouse after scrolling it into view like a person would; confirms what is under the pointer
async function realClick(page, selector, { dbl = false } = {}) {
  const pt = await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    el.scrollIntoView({ block: 'center', inline: 'center' });
    const r = el.getBoundingClientRect();
    const x = r.x + Math.min(r.width / 2, 40); const y = r.y + r.height / 2;
    const hit = document.elementFromPoint(x, y);
    return hit === el || el.contains(hit) || hit?.contains(el) ? { x, y } : { blocked: `${hit?.tagName}.${hit?.className}` };
  }, selector);
  if (!pt) throw new Error(`${selector} not found`);
  if (pt.blocked) throw new Error(`${selector} is covered by ${pt.blocked}`);
  await (dbl ? page.mouse.dblclick(pt.x, pt.y) : page.mouse.click(pt.x, pt.y));
}
const menuItem = async (page, menu, text) => {
  await realClick(page, `#menu-${menu}`);
  const pt = await page.evaluate((t) => { const el = [...document.querySelectorAll('.dropdown button')].find((x) => x.textContent.includes(t)); if (!el) return null; el.scrollIntoView({ block: 'center' }); const r = el.getBoundingClientRect(); return { x: r.x + 20, y: r.y + r.height / 2 }; }, text);
  if (!pt) throw new Error(`menu item ${text} not found`);
  await page.mouse.click(pt.x, pt.y);
};
const loadViaWelcome = async (page, path) => { await page.fill('.pathrow input', path); await realClick(page, '.pathrow .btn'); await page.waitForSelector('tbody tr[data-id]'); };

// 1. a failed Open must leave the loaded game fully usable, and report why --------------------------------------------------
await scenario('failed load', { setup: () => ({ game: makeProjectGame(), empty: tmp() }) }, async ({ page, check, ctx }) => {
  await loadViaWelcome(page, ctx.game);
  const before = await page.$$eval('tbody tr[data-id]', (e) => e.length);
  for (let i = 0; i < 2; i++) { // twice: also exercises stacking toasts
    await menuItem(page, 'file', 'Open Folder');
    await page.waitForSelector('.modal');
    await page.fill('.modal input[aria-label=Path]', ctx.empty);
    await page.waitForFunction(() => !document.getElementById('browser-confirm').disabled);
    await page.waitForTimeout(350);
    await realClick(page, '#browser-confirm');
    await page.waitForSelector('.toast.error >> nth=' + i);
  }
  check((await page.$$eval('.toast.error', (e) => e.length)) === 2, 'two error toasts expected');
  const rects = await page.$$eval('.toast', (els) => els.map((e) => { const r = e.getBoundingClientRect(); return [r.top, r.bottom]; }));
  check(rects.length === 2 && (rects[0][1] <= rects[1][0] + 0.5 || rects[1][1] <= rects[0][0] + 0.5), `toasts overlap: ${JSON.stringify(rects)}`);
  check(/No Unity files were found/.test(await page.$eval('.toast.error', (e) => e.textContent)), 'the toast says why');
  check((await page.$eval('#status', (e) => e.textContent)).startsWith('15 assets'), 'status bar still shows the loaded game');
  check((await page.$$eval('tbody tr[data-id]', (e) => e.length)) === before, 'the asset list is still there');
  await realClick(page, 'tbody tr[data-id] a');
  await page.waitForSelector('.dtabs');
  check(!/no such asset/i.test(await page.$eval('.detail', (e) => e.textContent)), 'selecting an asset still works (the server still has the game)');
});

// 2. double-click on a folder goes exactly one level --------------------------------------------------------------------------
await scenario('double-click folder', { setup: () => { const r = tmp(); mkdirSync(join(r, 'a', 'b', 'c'), { recursive: true }); return { r }; } }, async ({ page, check, ctx }) => {
  await menuItem(page, 'file', 'Open File');
  await page.waitForSelector('.modal');
  await page.fill('.modal input[aria-label=Path]', ctx.r);
  await realClick(page, '#browser-go');
  await page.waitForFunction(() => [...document.querySelectorAll('.browser-list button')].some((b) => b.textContent.includes('a')));
  await page.waitForTimeout(400);
  const sel = await page.evaluate(() => { const b = [...document.querySelectorAll('.browser-list button')].find((x) => x.textContent === '▸a'); b.dataset.t = 'target'; return 'button[data-t=target]'; });
  await realClick(page, sel, { dbl: true });
  await page.waitForTimeout(600);
  const now = await page.$eval('.modal input[aria-label=Path]', (e) => e.value);
  check(now === join(ctx.r, 'a'), `double-click should enter "a" only, but the path is ${now}`);
});

// 3. keyboard: menus follow the menu-bar pattern; dialogs trap focus and give it back ---------------------------------------
await scenario('keyboard', {}, async ({ page, check }) => {
  const active = () => page.evaluate(() => document.activeElement?.id || document.activeElement?.textContent?.trim().slice(0, 30));
  await page.focus('#menu-file');
  await page.keyboard.press('ArrowDown');
  check((await page.$$('.dropdown')).length === 1, 'ArrowDown on a menu button opens the menu');
  check((await active()).startsWith('Open File'), `focus moves to the first enabled item, got ${await active()}`);
  await page.keyboard.press('ArrowDown');
  check((await active()).startsWith('Open Folder'), 'ArrowDown moves to the next item');
  await page.keyboard.press('ArrowDown'); // Reset is disabled (nothing loaded): skipped, wraps to the first item
  check((await active()).startsWith('Open File'), `disabled items are skipped and the list wraps, got ${await active()}`);
  await page.keyboard.press('ArrowRight');
  check((await page.$$eval('.menu.open > button', (e) => e.map((x) => x.id)))[0] === 'menu-view', 'ArrowRight opens the next menu');
  await page.keyboard.press('Escape');
  check((await page.$$('.dropdown')).length === 0 && (await active()) === 'menu-view', `Escape closes the menu and returns focus to its button, got ${await active()}`);
  // dialog: focus trap, Escape, focus returns to the menu that opened it
  await page.focus('#menu-file');
  await page.keyboard.press('Enter'); await page.keyboard.press('Enter'); // open the menu (focus on first item), activate "Open File..."
  await page.waitForSelector('.modal');
  let inside = true;
  for (let i = 0; i < 14; i++) { await page.keyboard.press(i % 2 ? 'Tab' : 'Tab'); inside &&= await page.evaluate(() => !!document.activeElement.closest('.modal')); }
  for (let i = 0; i < 6; i++) { await page.keyboard.press('Shift+Tab'); inside &&= await page.evaluate(() => !!document.activeElement.closest('.modal')); }
  check(inside, 'Tab / Shift+Tab never leave the dialog');
  check(await page.evaluate(() => document.querySelector('#view').inert === true), 'the page behind the dialog is inert');
  await page.keyboard.press('Escape');
  check((await page.$$('.modal')).length === 0, 'Escape closes the dialog');
  check(await page.evaluate(() => document.querySelector('#view').inert === false), 'the page is usable again');
  check((await active()) === 'menu-file', `focus goes back to the menu that opened the dialog, got ${await active()}`);
});

// 4. the logo is a link that keeps the access token; a startup notice is shown ----------------------------------------------
await scenario('logo + notice', { notice: 'Could not open C:\\Games\\x: No Unity files were found in it.' }, async ({ page, check }) => {
  check(/\?t=[\w-]+#\/home$/.test(await page.$eval('#logo', (e) => e.href)), 'logo href keeps ?t=<token>');
  await page.waitForSelector('.toast.error');
  check(/Could not open C:\\Games\\x/.test(await page.$eval('.toast.error', (e) => e.textContent)), 'the startup notice is shown');
});

// 5. a menu the user opened stays open while the search box debounces ---------------------------------------------------------
await scenario('menu survives background updates', { setup: () => ({ game: makeProjectGame() }) }, async ({ page, check, ctx }) => {
  await loadViaWelcome(page, ctx.game);
  await realClick(page, '#menu-export');
  await page.evaluate(() => { const q = document.querySelector('input[type=search]'); q.value = 'Cube'; q.dispatchEvent(new Event('input')); }); // typed earlier, fires while the menu is open
  await page.waitForFunction(() => document.querySelectorAll('tbody tr[data-id]').length === 1, null, { timeout: 3000 });
  check((await page.$$('.menu.open .dropdown')).length === 1, 'the open dropdown survived the list refresh');
});

// 6. paging: the new page starts at the top and keyboard focus stays on Next -------------------------------------------------
await scenario('paging', {
  setup: () => {
    const dir = tmp(); mkdirSync(join(dir, 'G'));
    const objects = Array.from({ length: 450 }, (_, i) => ({ pathId: i + 1, typeIndex: 0, data: textAssetData(`Text_${String(i).padStart(3, '0')}`, 'hello') }));
    writeFileSync(join(dir, 'G', 'level0'), buildSerializedFile({ version: 19, types: [{ classId: 49, tree: TEXTASSET_TREE }], objects }));
    return { dir };
  },
}, async ({ page, check, ctx }) => {
  await loadViaWelcome(page, ctx.dir);
  await page.evaluate(() => { const s = document.querySelector('.tablescroll'); s.scrollTop = s.scrollHeight; });
  await page.focus('[data-pg=next]');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => /page 2 \//.test(document.querySelector('.pager').textContent));
  check((await page.evaluate(() => document.querySelector('.tablescroll').scrollTop)) === 0, 'the new page starts at the top of the list');
  check((await page.evaluate(() => document.activeElement.dataset.pg)) === 'next', 'keyboard focus stays on the Next button');
});

// 7. previews: portrait textures keep their proportions; text downloads are byte-exact -------------------------------------
const BAD = Buffer.concat([Buffer.from('plain text before, '), Buffer.from([0xff, 0xfe, 0xc3, 0x28]), Buffer.from(', and plain text after the odd bytes')]);
await scenario('preview + download', {
  setup: () => {
    const dir = tmp(); mkdirSync(join(dir, 'G'));
    writeFileSync(join(dir, 'G', 'level0'), buildSerializedFile({
      version: 19, types: [{ classId: 28, tree: TEXTURE2D_TREE }, { classId: 49, tree: TEXTASSET_TREE }],
      objects: [
        { pathId: 1, typeIndex: 0, data: texture2DData({ name: 'Tall', width: 2, height: 8, format: 4, image: Buffer.alloc(64, 200) }) },
        { pathId: 2, typeIndex: 1, data: textAssetData('Odd', BAD) },
      ],
    }));
    return { dir };
  },
}, async ({ page, check, ctx }) => {
  await loadViaWelcome(page, ctx.dir);
  await page.evaluate(() => { [...document.querySelectorAll('tbody tr')].find((r) => r.children[1].textContent === 'Texture2D').querySelector('a').dataset.t = 'tex'; [...document.querySelectorAll('tbody tr')].find((r) => r.children[1].textContent === 'TextAsset').querySelector('a').dataset.t = 'txt'; });
  await realClick(page, 'a[data-t=tex]');
  await page.waitForFunction(() => { const i = document.querySelector('.preview img'); return i && i.complete && i.naturalWidth > 0 && i.style.height; });
  const img = await page.$eval('.preview img', (i) => ({ ratio: i.naturalWidth / i.naturalHeight, w: i.style.width, h: i.style.height, fit: getComputedStyle(i).objectFit }));
  check(img.fit === 'contain' && !!img.w && !!img.h, `the image gets explicit proportional sizes and object-fit: contain: ${JSON.stringify(img)}`);
  check(Math.abs(parseFloat(img.w) / parseFloat(img.h) - img.ratio) < 0.01, `displayed size keeps the texture's proportions: ${JSON.stringify(img)}`);
  await realClick(page, 'a[data-t=txt]');
  await page.waitForSelector('a.btn[download]');
  const [dl] = await Promise.all([page.waitForEvent('download'), realClick(page, 'a.btn[download]')]);
  const got = readFileSync(await dl.path());
  check(got.equals(BAD), `downloaded text asset is not byte-exact (${got.length} bytes vs ${BAD.length}): ${got.toString('hex').slice(0, 80)}`);
});

// 8. narrow screens: picking an asset brings its pane into view, with a way back; the dialog fits ----------------------------
await scenario('narrow layout', {
  width: 320, height: 640,
  setup: () => { const r = tmp(); const long = 'a_really_long_folder_name_'.repeat(5); mkdirSync(join(r, long)); writeFileSync(join(r, `${long}.assets`), 'x'.repeat(100)); return { game: makeProjectGame(), r }; },
}, async ({ page, check, ctx }) => {
  await menuItem(page, 'file', 'Open File');
  await page.waitForSelector('.modal');
  await page.fill('.modal input[aria-label=Path]', ctx.r);
  await realClick(page, '#browser-go');
  await page.waitForSelector('.browser-list button >> text=a_really');
  const fit = await page.evaluate(() => { const m = document.querySelector('.modal').getBoundingClientRect(); return { right: m.right, left: m.left, w: innerWidth, hs: document.documentElement.scrollWidth > innerWidth }; });
  check(fit.right <= fit.w + 0.5 && fit.left >= -0.5 && !fit.hs, `the dialog fits the screen with very long names: ${JSON.stringify(fit)}`);
  await page.keyboard.press('Escape');
  await loadViaWelcome(page, ctx.game);
  await realClick(page, 'tbody tr[data-id] a');
  await page.waitForSelector('.dtabs');
  await page.waitForTimeout(300);
  const top = await page.evaluate(() => document.querySelector('.detail').getBoundingClientRect().top);
  check(top >= -2 && top < 640 / 2, `the detail pane is scrolled into view after picking an asset (top ${Math.round(top)}px)`);
  await realClick(page, '.back-to-list');
  await page.waitForTimeout(300);
  const listTop = await page.evaluate(() => document.querySelector('.tablewrap').getBoundingClientRect().top);
  check(listTop >= -2 && listTop < 640 / 2, `"Back to the list" returns to the list (top ${Math.round(listTop)}px)`);
});

await browser.close();
console.log(problems.length ? `FAIL\n  ${problems.join('\n  ')}` : `${checks} regression checks passed (real mouse, keyboard and download)`);
process.exit(problems.length ? 1 : 0);
