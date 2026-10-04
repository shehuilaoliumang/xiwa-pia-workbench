'use strict';
// Formal-instance acceptance: fixed localhost target; every API mutation except
// POST /api/preview is aborted. Never opens the connecting /display audience page.
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const base = 'http://127.0.0.1:8765';
const root = path.resolve(__dirname, '..');
const output = path.join(root, '.qa', 'browser');
const result = { ok: false, base, started_at: new Date().toISOString(), blocked_writes: [], preview_posts: 0, page_errors: [], checks: [] };
let browser, page, context;
fs.mkdirSync(output, { recursive: true });
const get = async endpoint => {
  const response = await context.request.get(base + endpoint);
  assert(response.ok(), `GET ${endpoint}: ${response.status()}`);
  return response.json();
};
async function ready() {
  await page.waitForFunction(() => document.querySelector('#apply-display') && !document.querySelector('#apply-display').disabled);
  return page.frames().find(frame => frame.url().includes('/display?preview=1'));
}
async function seekPreview(frame, at) {
  const slider = frame.locator('.wb-media-progress');
  await slider.evaluate((element, value) => {
    element.value = String(value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
  }, at);
  await frame.waitForFunction(expected => {
    const player = document.querySelector('video.wb-media-element');
    return player && Math.abs(player.currentTime - expected) < .08 && !player.seeking && player.readyState >= 2 && player.paused;
  }, at);
}
async function main() {
  try {
    browser = await chromium.launch({ channel: 'msedge', headless: true });
    context = await browser.newContext({ viewport: { width: 1600, height: 1120 }, serviceWorkers: 'block' });
    await context.addInitScript(() => {
      if(location.origin==='http://127.0.0.1:8765')localStorage.setItem('wb-preview-preferences', JSON.stringify({ placement: 'outside', feedback: 'confirm' }));
      window.addEventListener('message', event => {
        if (event.origin === location.origin && event.source === window.parent && event.data?.type === 'wb-preview') window.__qaLastSnapshot = event.data.snapshot;
      });
    });
    await context.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url()), method = request.method();
      if (url.origin === base && url.pathname === '/display' && url.searchParams.get('preview') !== '1') {
        result.blocked_writes.push({ method, path: url.pathname, reason: 'audience connection prevented' });
        return route.abort('blockedbyclient');
      }
      if (url.origin === base && url.pathname.startsWith('/api/') && method !== 'GET') {
        if (url.pathname === '/api/preview' && method === 'POST') result.preview_posts++;
        else {
          result.blocked_writes.push({ method, path: url.pathname });
          return route.abort('blockedbyclient');
        }
      }
      return route.continue();
    });
    context.on('page', item => item.on('pageerror', error => result.page_errors.push(error.message)));
    const health = await get('/api/health');
    assert.equal(health.app, 'content-workbench'); result.health = health;
    const libraryBefore = await get('/api/library');
    const scriptBefore = libraryBefore.scripts.find(script => script.id === 'script-08');
    assert(scriptBefore?.media, 'Formal script-08 media association exists');
    assert.equal(scriptBefore.media.kind, 'video');
    assert(scriptBefore.media.sha256.startsWith('0880'), 'Expected already-associated sample, not a different media asset');
    assert.deepEqual(scriptBefore.media.cues, []);
    result.media = { script_id: scriptBefore.id, script_title: scriptBefore.title, ...scriptBefore.media };
    const stateBefore = await get('/api/state'); result.revision_before = stateBefore.revision;
    page = await context.newPage();
    await page.goto(base + '/script/script-08/media');
    await page.waitForFunction(() => document.querySelector('video#media-player')?.duration > 210);
    result.editor_metadata = await page.locator('video#media-player').evaluate(player => ({ duration: player.duration, width: player.videoWidth, height: player.videoHeight, currentTime: player.currentTime, paused: player.paused }));
    assert.match(await page.locator('#media-file-name').textContent(), new RegExp(scriptBefore.media.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert(Math.abs(result.editor_metadata.duration - 210.977007) < .1);
    assert(result.editor_metadata.width > 0 && result.editor_metadata.height > 0);
    assert.equal(await page.locator('[data-cue-id]').count(), 0);
    result.checks.push('正式配本页文件名、真实视频时长与画幅、空时间点');

    await page.goto(base + '/control');
    let frame = await ready();
    await frame.waitForFunction(() => window.__qaLastSnapshot?.directory_level === 'categories');
    const firstSnapshot = await frame.evaluate(() => window.__qaLastSnapshot);
    assert.equal(firstSnapshot.mode, 'list');
    assert.equal(firstSnapshot.directory_level, 'categories');
    assert.equal(await page.locator('#preview-feedback-mode').inputValue(), 'confirm');
    result.checks.push('普通播控首进为分组总览，使用确认模式');

    await page.goto(base + '/control?script=script-08&body=media');
    frame = await ready();
    assert.equal(await page.locator('#layout-body-mode').inputValue(), 'media');
    assert.equal(await page.locator('#preview-feedback-mode').inputValue(), 'confirm');
    await frame.waitForFunction(() => document.querySelector('video.wb-media-element')?.duration > 210);
    await page.locator('[data-orientation="portrait"]').click(); frame = await ready();
    await seekPreview(frame, 10);
    result.preview_metadata = await frame.locator('video.wb-media-element').evaluate(player => ({ duration: player.duration, width: player.videoWidth, height: player.videoHeight, currentTime: player.currentTime, paused: player.paused, muted: player.muted }));
    await page.locator('.preview-panel').scrollIntoViewIfNeeded();
    await page.locator('.preview-panel').screenshot({ path: path.join(output, 'formal-media-portrait.png') });
    result.checks.push('真实竖屏视频预览，进度条定位10秒仅在草稿内');

    await page.locator('[data-orientation="landscape"]').click(); frame = await ready();
    await seekPreview(frame, 10);
    await page.locator('#layout-media-side').selectOption('right'); frame = await ready();
    await seekPreview(frame, 10);
    assert.equal(await frame.locator('.wb-media-player').getAttribute('data-media-side'), 'right');
    await page.locator('.preview-panel').scrollIntoViewIfNeeded();
    await page.locator('.preview-panel').screenshot({ path: path.join(output, 'formal-media-landscape.png') });
    result.checks.push('横屏及左右位置仅更新预览，保留视频10秒定位');

    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('[data-orientation="portrait"]').click(); frame = await ready();
    await seekPreview(frame, 10);
    const bounds = await page.evaluate(() => ({ viewport: innerWidth, width: document.documentElement.scrollWidth }));
    assert(bounds.width <= bounds.viewport + 1, JSON.stringify(bounds));
    result.mobile_bounds = bounds;
    await page.locator('.preview-panel').scrollIntoViewIfNeeded();
    await page.locator('.preview-panel').screenshot({ path: path.join(output, 'formal-media-mobile.png') });
    result.checks.push('390像素手机无横向溢出');

    const libraryAfter = await get('/api/library'), stateAfter = await get('/api/state');
    const scriptAfter = libraryAfter.scripts.find(script => script.id === 'script-08');
    assert.deepEqual(scriptAfter.media, scriptBefore.media, 'Formal media/cues unchanged');
    assert.deepEqual(libraryAfter.scripts.map(script => ({ id: script.id, blocks: script.blocks })), libraryBefore.scripts.map(script => ({ id: script.id, blocks: script.blocks })), 'All source bodies unchanged');
    assert.deepEqual(scriptAfter.media.cues, []);
    result.revision_after = stateAfter.revision;
    result.revision_changed = stateAfter.revision !== stateBefore.revision;
    if (result.revision_changed) result.revision_note = 'State changed outside this read-only browser; no rollback performed.';
    assert.deepEqual(result.page_errors, []);
    assert.deepEqual(result.blocked_writes, [], 'The UI must not attempt any write beyond preview');
    result.checks.push('媒体、空cue与14篇正文保持不变；未尝试任何正式写入；页面无异常');
    result.ok = true;
  } catch (error) {
    result.error = error.stack || String(error);
    if (page && !page.isClosed()) await page.screenshot({ path: path.join(output, 'formal-media-failure.png'), fullPage: true }).catch(() => {});
    throw error;
  } finally {
    result.finished_at = new Date().toISOString();
    fs.writeFileSync(path.join(output, 'formal-media-result.json'), JSON.stringify(result, null, 2));
    if (browser) await browser.close();
  }
}
main().then(() => console.log(JSON.stringify(result))).catch(error => { console.error(error); process.exitCode = 1; });
