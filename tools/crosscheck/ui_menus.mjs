#!/usr/bin/env node
// Every menu item must be reachable by a REAL mouse at every screen width.
//
// Why this exists: the menu bar once had `overflow-x: auto`, which silently clipped every dropdown. Playwright's own click() scrolls
// hidden containers into view, so ordinary UI tests still passed while a person could not click any menu item. This check asks the
// browser what is under the pointer (elementFromPoint) and clicks with raw mouse coordinates.
//
//   node tools/crosscheck/ui_menus.mjs <folder containing node_modules/playwright>      e.g. "$(npm root -g)"
import { createRequire } from 'node:module';
import { createApp } from '../../src/server.js';

const root = process.argv[2];
if (!root) { console.error('usage: node tools/crosscheck/ui_menus.mjs <npm root containing playwright>'); process.exit(2); }
const { chromium } = createRequire(`${root}/`)('playwright');
const app = createApp({});
const { url } = await app.start({ port: 0 });
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/opt/pw-browsers/chromium' });

const WIDTHS = [[1920, 1000], [1480, 860], [1280, 720], [1024, 700], [961, 800], [960, 800], [768, 800], [601, 800], [600, 800], [390, 800], [320, 700]];
const MENUS = [['file', 'Open File…', '.modal'], ['view', 'Assets', null], ['export', 'Export Unity project…', null], ['language', 'English', null],
  ['dev', 'Server log', '.modal'], ['help', 'Credits', '.credits']];
let checks = 0;
const problems = [];

for (const [w, h] of WIDTHS) {
  const page = await browser.newPage({ viewport: { width: w, height: h } });
  await page.goto(url);
  await page.waitForSelector('.welcome');
  for (const [menu, item, opens] of MENUS) {
    await page.mouse.click(1, 1);
    const b = await page.$eval(`#menu-${menu}`, (e) => { const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
    await page.mouse.click(b.x, b.y);
    const t = await page.evaluate((text) => {
      const el = [...document.querySelectorAll('.dropdown button')].find((x) => x.textContent.includes(text));
      if (!el) return { found: false };
      const r = el.getBoundingClientRect();
      const cx = r.x + r.width / 2, cy = r.y + r.height / 2;
      const hit = document.elementFromPoint(cx, cy);
      const dd = el.closest('.dropdown').getBoundingClientRect();
      return { found: true, cx, cy, disabled: el.disabled, reachable: hit === el || el.contains(hit), hit: hit ? `${hit.tagName}.${hit.className}` : 'nothing',
        inside: dd.left >= -0.5 && dd.right <= innerWidth + 0.5, hscroll: document.documentElement.scrollWidth > document.documentElement.clientWidth };
    }, item);
    const label = `${w}px ${menu} -> "${item}"`;
    checks++;
    if (!t.found) { problems.push(`${label}: item not found`); continue; }
    if (!t.reachable) problems.push(`${label}: a real click would hit ${t.hit}, not the menu item`);
    if (!t.inside) problems.push(`${label}: dropdown extends outside the window`);
    if (t.hscroll) problems.push(`${label}: page gets a horizontal scrollbar`);
    if (opens && t.reachable && !t.disabled) {
      await page.mouse.click(t.cx, t.cy);
      if (!(await page.waitForSelector(opens, { timeout: 1500 }).catch(() => null))) problems.push(`${label}: clicking did not open ${opens}`);
      else if (opens === '.credits') await page.click('.credits-head .btn'); else await page.keyboard.press('Escape');
    }
  }
  await page.close();
}
await browser.close();
await app.stop();
console.log(problems.length ? `FAIL\n  ${problems.join('\n  ')}` : `${checks} menu checks passed (${MENUS.length} menus x ${WIDTHS.length} window widths, real mouse)`);
process.exit(problems.length ? 1 : 0);
