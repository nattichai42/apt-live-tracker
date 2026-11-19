// Every page in a phone-sized browser: no script errors, no broken text (NaN, undefined, ...), nothing wider than the
// screen, and its tabs, an event and a player open. Live pages read the data branches on GitHub, so this needs network.
//   node --test tests/pages.test.js            (needs Playwright with Chromium: npm i --no-save playwright && npx playwright install chromium)
//   REPO=owner/name node --test tests/pages.test.js   (another copy's data branches; default: this repository's origin)
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { execFileSync } = require('child_process');
const { chromium } = require('playwright');

const DOCS = path.join(__dirname, '../docs');
const REPO = process.env.REPO || process.env.GITHUB_REPOSITORY || (() => {
  try { return execFileSync('git', ['remote', 'get-url', 'origin'], { encoding: 'utf8' }).match(/github\.com[/:]([^/]+\/[^/.\s]+)/)[1]; } catch { return 'nattichai42/apt-live-tracker'; }
})();
const BADTEXT = /.{0,40}(\bNaN\b|\bundefined\b|\bInfinity\b|\[object Object\]).{0,20}/;
const first = (f, list) => { try { return JSON.parse(fs.readFileSync(path.join(DOCS, f), 'utf8'))[list][0].id; } catch { return null; } };
const aptPast = first('apt/archive/index.json', 'series'), tritonPast = first('triton/archive/index.json', 'festivals');

// [url, what shows it has loaded]
const PAGES = [
  ['', '.banner'],
  ['apt/', '#done-count'],
  aptPast && [`apt/?f=${aptPast}`, '#done-count'],
  ['glpc/', '#done-count'],
  ['triton/', '#done-count'],
  tritonPast && [`triton/?f=${tritonPast}`, '#done-count'],
  ['triton/?view=all', '#done-count'],
  ['all/', '#players-count'],
].filter(Boolean);

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' };
let server, base, browser;
test.before(async () => {
  server = http.createServer((req, res) => {
    let f = path.join(DOCS, decodeURIComponent(new URL(req.url, 'http://x').pathname));
    if (!f.startsWith(DOCS)) { res.writeHead(403).end(); return; }
    if (fs.existsSync(f) && fs.statSync(f).isDirectory()) f = path.join(f, 'index.html');
    fs.readFile(f, (err, data) => {
      if (err) { res.writeHead(404).end(); return; }
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(f)] || 'application/octet-stream' }).end(data);
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}/`;
  const proxy = process.env.HTTPS_PROXY || process.env.https_proxy;
  browser = await chromium.launch(proxy ? { proxy: { server: proxy, bypass: 'localhost,127.0.0.1' } } : {});
});
test.after(async () => { await browser?.close(); server?.close(); });

for (const [url, ready] of PAGES) {
  test(`page /${url}`, { timeout: 180000 }, async () => {
    const ctx = await browser.newContext({ viewport: { width: 375, height: 800 } });
    const page = await ctx.newPage();
    const errors = [], bad = [], wide = [];
    page.on('pageerror', (e) => errors.push(e.message.slice(0, 160)));
    const look = async (where) => {
      const r = await page.evaluate(() => {
        const w = document.documentElement.clientWidth, sheet = document.querySelector('#sheet');
        const open = sheet && !sheet.hidden && getComputedStyle(sheet).display !== 'none' && sheet.getBoundingClientRect().width > 0;
        return { text: document.body.innerText, page: document.documentElement.scrollWidth - w, sheet: open ? sheet.scrollWidth - sheet.clientWidth : 0 };
      });
      const m = r.text.match(BADTEXT); if (m) bad.push(`${where}: "${m[0].replace(/\s+/g, ' ')}"`);
      if (r.page > 1) wide.push(`${where}: page ${r.page}px wider than the screen`);
      if (r.sheet > 1) wide.push(`${where}: panel ${r.sheet}px wider than itself`);
    };
    await page.goto(base + url + (url.includes('?') ? '&' : '?') + 'repo=' + REPO);
    await page.waitForFunction((sel) => { const e = document.querySelector(sel); return e && /\d/.test(e.textContent); }, ready, { timeout: 120000 });
    await page.waitForTimeout(1500);
    await look('loaded');
    if (url) {
      for (const tab of await page.$$('.tab[data-tab]:not([hidden])')) {
        const name = await tab.getAttribute('data-tab');
        if (!(await tab.isVisible())) continue;
        await tab.click(); await page.waitForTimeout(400); await look(`tab ${name}`);
        // the first thing on it that opens the panel: an event card, a finished event, a player
        const item = await page.$(`#${name} .card, #${name} li[role="button"], #${name} .row`);
        if (item && await item.isVisible()) {
          await item.click(); await page.waitForTimeout(500); await look(`tab ${name}, first item opened`);
          const close = await page.$('#sheet-close'); if (close && await close.isVisible()) { await close.click(); await page.waitForTimeout(200); }
        }
      }
    }
    await ctx.close();
    assert.deepEqual(errors, [], 'script errors');
    assert.deepEqual(bad, [], 'broken text');
    assert.deepEqual(wide, [], 'wider than a phone');
  });
}
