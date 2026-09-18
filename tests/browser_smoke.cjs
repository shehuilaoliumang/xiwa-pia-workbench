// Run against an isolated test instance, never the user's working database.
// Usage: NODE_PATH=<playwright location> node tests/browser_smoke.cjs <base URL>
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const base = process.argv[2] || 'http://127.0.0.1:8877';
const out = path.resolve('.qa/browser');

(async () => {
  await fs.mkdir(out, { recursive: true });
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
  const page = await context.newPage();
  const api = async (route, body, method = 'POST') => {
    const lib = await (await context.request.get(base + '/api/library')).json();
    const res = await context.request.fetch(base + route, { method, data: body, headers: { 'X-CSRF-Token': lib.csrf_token } });
    assert(res.ok(), route + ': ' + await res.text());
    return res.json();
  };
  const library = await (await context.request.get(base + '/api/library')).json();
  assert.equal(library.scripts.length, 14);
  await page.goto(base);
  await page.locator('#script-grid > *').first().waitFor();
  await page.screenshot({ path: path.join(out, 'catalog-desktop.png'), fullPage: true });
  await page.locator('#catalog-search').fill('万有引力');
  await page.waitForTimeout(350);
  assert((await page.locator('#script-grid').innerText()).includes('万有引力'));
  assert(!(await page.locator('#script-grid').innerText()).includes('平凡人生'));
  await page.goto(base + '/script/script-08');
  await page.locator('#reader-body img').first().waitFor();
  assert.equal(await page.locator('#reader-body img').count(), 7);
  assert(await page.locator('#reader-body img').evaluateAll(images => images.every(image => image.complete && image.naturalWidth > 0)));
  await page.screenshot({ path: path.join(out, 'reader-desktop.png'), fullPage: true });

  await api('/api/queue', { script_ids: ['script-01', 'script-02', 'script-08'] }, 'PUT');
  await page.goto(base + '/control');
  await page.locator('#apply-display').waitFor();
  await page.screenshot({ path: path.join(out, 'control-desktop.png'), fullPage: true });
  const applied = await api('/api/apply', { mode: 'script', script_id: 'script-01', orientation: 'portrait' });
  assert(!applied.playing);
  const display = await context.newPage();
  await display.setViewportSize({ width: 540, height: 960 });
  await display.goto(base + '/display');
  await display.locator('#stage-content').getByText('万有引力', { exact: false }).first().waitFor();
  await display.screenshot({ path: path.join(out, 'display-portrait.png') });
  const state = await (await context.request.get(base + '/api/state')).json();
  await api('/api/command', { action: 'play' });
  await display.waitForTimeout(1500);
  const scrolled = await display.locator('#stage-scroll').evaluate(el => el.scrollTop);
  assert(scrolled > 0, 'display must scroll while playing');
  await page.reload();
  assert((await (await context.request.get(base + '/api/state')).json()).playing, 'control refresh must not pause');
  await display.reload();
  await display.waitForTimeout(500);
  assert(!(await (await context.request.get(base + '/api/state')).json()).playing, 'display refresh must pause');
  await api('/api/apply', { mode: 'script', script_id: 'script-01', orientation: 'landscape' });
  await display.setViewportSize({ width: 1280, height: 720 });
  await display.waitForTimeout(1200);
  await display.screenshot({ path: path.join(out, 'display-landscape.png') });

  await page.goto(base + '/manage');
  await page.locator('#tab-categories').click();
  await page.locator('#new-category').click();
  await page.locator('#category-name').fill('浏览器验收分类');
  await page.locator('#category-form button[type=submit]').click();
  await page.locator('#category-dialog').waitFor({ state: 'hidden' });
  assert((await page.locator('#manage-category-list').innerText()).includes('浏览器验收分类'));
  await page.screenshot({ path: path.join(out, 'manage-desktop.png'), fullPage: true });

  for (let i = 0; i < 23; i++) {
    await api('/api/categories', { name: `扩展分类${i + 1}——较长分类名称测试`, color: '#54756a', visible: true });
  }
  for (const route of ['/', '/control', '/manage', '/script/script-01']) {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(base + route);
    await page.waitForTimeout(450);
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'mobile horizontal overflow at ' + route);
    await page.screenshot({ path: path.join(out, `mobile-${route.replace(/\W+/g, '-') || 'catalog'}.png`), fullPage: true });
  }
  assert.deepEqual(errors, [], 'browser runtime errors');
  await fs.writeFile(path.join(out, 'result.json'), JSON.stringify({ passed: true, scripts: library.scripts.length, browserErrors: errors, checked: ['search', 'source images', 'queue', 'control refresh', 'display refresh', 'smooth scrolling', 'portrait', 'landscape', 'category creation', '30 custom categories', 'mobile overflow'] }, null, 2));
  await browser.close();
  console.log('Browser acceptance passed. Screenshots: ' + out);
})().catch(error => { console.error(error); process.exit(1); });
