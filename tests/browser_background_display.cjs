'use strict';

// Background display regression: freeze every requestAnimationFrame callback,
// including callbacks already queued before visibilitychange. This verifies
// application state/layout progress, not the OS capture compositor's pixels.
const {chromium} = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {createHash} = require('node:crypto');
const {spawn, execFileSync} = require('node:child_process');
const root = path.resolve(__dirname, '..');
const python = path.join(root, 'runtime', 'python.exe');
const dataDir = path.join(root, '.qa', `background-display-${Date.now()}`);
const output = path.join(root, '.qa', 'browser');
const base = 'http://127.0.0.1:8925';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const result = {passed: false, base, data_dir: dataDir, checks: [], raf_audits: [], scroll_samples: [], page_errors: [], http_errors: [], writes: [], screenshots: []};
let server, browser, context, audience, controller;
const responseReads = [];
fs.mkdirSync(output, {recursive: true});

function installRafGate() {
  if (window.__qaRaf) return;
  if (location.origin === 'http://127.0.0.1:8925') localStorage.setItem('wb-preview-preferences', JSON.stringify({placement: 'outside', feedback: 'confirm'}));
  const nativeRaf = window.requestAnimationFrame.bind(window);
  const nativeCancel = window.cancelAnimationFrame.bind(window);
  const pending = new Map();
  let sequence = 0, frozen = false, forcedVisibility = 'visible', executed = 0;
  function schedule(id, item) {
    if (frozen || item.native !== null) return;
    item.native = nativeRaf(timestamp => {
      item.native = null;
      if (frozen || !pending.has(id)) return;
      pending.delete(id); executed++; item.callback(timestamp);
    });
  }
  window.requestAnimationFrame = callback => {
    const id = ++sequence, item = {callback, native: null};
    pending.set(id, item); schedule(id, item); return id;
  };
  window.cancelAnimationFrame = id => {
    const item = pending.get(id);
    if (item?.native !== null && item?.native !== undefined) nativeCancel(item.native);
    pending.delete(id);
  };
  Object.defineProperty(document, 'visibilityState', {configurable: true, get: () => forcedVisibility});
  Object.defineProperty(document, 'hidden', {configurable: true, get: () => forcedVisibility === 'hidden'});
  function freeze() {
    frozen = true;
    for (const item of pending.values()) {
      if (item.native !== null) nativeCancel(item.native);
      item.native = null;
    }
  }
  function resume() { frozen = false; for (const [id, item] of pending) schedule(id, item); }
  function visibility(value) {
    forcedVisibility = value;
    // A named popup can reuse its Window while replacing about:blank Document.
    // Install the getters on the current document, not only that first document.
    Object.defineProperty(document, 'visibilityState', {configurable: true, get: () => forcedVisibility});
    Object.defineProperty(document, 'hidden', {configurable: true, get: () => forcedVisibility === 'hidden'});
    document.dispatchEvent(new Event('visibilitychange'));
  }
  window.__qaRaf = {
    freeze, resume,
    hide() { freeze(); visibility('hidden'); },
    show() { visibility('visible'); resume(); },
    visibility,
    stats() { return {frozen, visibility: forcedVisibility, actual_hidden: document.hidden, actual_visibility: document.visibilityState, executed, pending: pending.size}; },
  };
}

async function until(check, label, timeout = 12000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await check()) return; await delay(80); }
  throw new Error('Timed out: ' + label);
}
async function get(endpoint) {
  const response = await context.request.get(base + endpoint);
  assert(response.ok(), endpoint + ': ' + response.status());
  return response.json();
}
const library = () => get('/api/library');
const state = () => get('/api/state');
async function send(endpoint, data, method = 'POST') {
  const csrf = (await library()).csrf_token;
  const response = await context.request.fetch(base + endpoint, {method, data, headers: {'X-CSRF-Token': csrf}});
  const body = await response.json(); assert(response.ok(), endpoint + ': ' + JSON.stringify(body)); return body;
}
async function apply(payload, position = {}) {
  const preview = await send('/api/preview', payload);
  return send('/api/apply', {...payload, preview_token: preview.content_token, ...position});
}
const scrollTop = () => audience.locator('#stage-scroll').evaluate(element => element.scrollTop);
const pageIndex = () => audience.locator('.stage-page.is-current').getAttribute('data-page-index').then(Number);
const captionIndex = () => audience.locator('.wb-media-caption-page.is-current').getAttribute('data-caption-page-index').then(Number);
const rafStats = () => audience.evaluate(() => window.__qaRaf.stats());
async function auditFrozen(label, before, visibility = 'hidden') {
  const after = await rafStats();
  assert.equal(after.actual_hidden, visibility === 'hidden', label + ': document.hidden must match simulated visibility');
  assert.equal(after.actual_visibility, visibility, label + ': document.visibilityState must match');
  assert(after.frozen && after.visibility === visibility, label + ': must remain frozen with expected visibility');
  assert.equal(after.executed, before.executed, label + ': no rAF callback may run while frozen');
  result.raf_audits.push({label, before, after});
}
async function diagnostic() {
  return audience.evaluate(async () => {
    const element = document.querySelector('#stage-scroll');
    const channel = new BroadcastChannel('wb-live-display-v1');
    const health = await new Promise(resolve => {
      const timeout = setTimeout(() => resolve(null), 1200);
      channel.onmessage = event => {
        if (event.data?.type !== 'display-health') return;
        clearTimeout(timeout); resolve(event.data);
      };
      channel.postMessage({type: 'display-health-request'});
    });
    channel.close();
    return {health, scroll_top: element.scrollTop, scroll_height: element.scrollHeight,
      client_height: element.clientHeight, advance_trace: window.__qaAdvance || [], footer: document.querySelector('#stage-footer')?.textContent,
      title: document.querySelector('#stage-content h1')?.textContent, raf: window.__qaRaf.stats()};
  });
}
async function contentOpaque() {
  return audience.locator('#stage-content').evaluate(element => Number(getComputedStyle(element).opacity) > .99);
}
async function expectBody(title, mode, index = 0) {
  await until(async () => {
    if (!(await audience.locator('#stage-content').textContent()).includes(title)) return false;
    if (!(await contentOpaque())) return false;
    if (mode === 'pages') return await audience.locator('.stage-page.is-current').count() === 1 && await pageIndex() === index;
    return await audience.locator('.stage-body').count() === 1 && await audience.locator('.stage-page').count() === 0;
  }, title + ' visible with completed ' + mode + ' layout');
}
function wav(seconds = 12) {
  const rate = 8000, bytes = seconds * rate * 2, buffer = Buffer.alloc(44 + bytes);
  buffer.write('RIFF'); buffer.writeUInt32LE(buffer.length - 8, 4); buffer.write('WAVEfmt ', 8); buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20); buffer.writeUInt16LE(1, 22); buffer.writeUInt32LE(rate, 24); buffer.writeUInt32LE(rate * 2, 28);
  buffer.writeUInt16LE(2, 32); buffer.writeUInt16LE(16, 34); buffer.write('data', 36); buffer.writeUInt32LE(bytes, 40); return buffer;
}
async function screenshot(name) {
  const filename = path.join(output, name + '.png');
  await audience.screenshot({path: filename}); result.screenshots.push(filename);
}

async function main() {
  try {
    let occupied = false; try { await fetch(base + '/api/health'); occupied = true; } catch (_) {}
    assert(!occupied, '8925 is occupied; refusing to reuse an existing instance.');
    server = spawn(python, ['-X', 'utf8', 'run.py', '--no-browser', '--port', '8925', '--data-dir', dataDir], {cwd: root, windowsHide: true, stdio: 'ignore'});
    await until(async () => { try { return path.resolve((await (await fetch(base + '/api/health')).json()).data_dir) === dataDir; } catch (_) { return false; } }, 'isolated server', 30000);
    browser = await chromium.launch({channel: 'msedge', headless: true});
    context = await browser.newContext({viewport: {width: 1080, height: 1000}, serviceWorkers: 'block'});
    await context.addInitScript(installRafGate);
    // Observe closure-only timing guards without changing product behavior.
    // This route inserts bounded diagnostic data, never changes a branch/value.
    if (process.env._QA_TRACE === '1') await context.route('**/static/display.js', async route => {
      const response = await route.fetch(); let source = await response.text();
      const marker = '  function advanceAudience(timestamp, backgroundTick = false) {';
      assert(source.includes(marker), 'advanceAudience diagnostic marker');
      source = source.replace(marker, marker + `
        if (!preview && backgroundTick) {
          (window.__qaAdvance ||= []).push({at:Date.now(),timestamp,lastFrame,lastAudiencePaint,lastStateReceivedAt,
            hidden:document.hidden,playing:state?.playing,revision:state?.revision,positioning,connected,connectionLost,
            locallyAtEnd,motion:recentLiveMotion(),manualHoldUntil,top:scroll.scrollTop,max:scroll.scrollHeight-scroll.clientHeight});
          if(window.__qaAdvance.length>80)window.__qaAdvance.shift();
        }
      `);
      await route.fulfill({response, body: source});
    });
    context.on('page', page => page.on('pageerror', error => result.page_errors.push(error.message)));
    context.on('response', response => {
      if (response.url() === base + '/api/state') {
        const poll = {at: Date.now()}; (result.poll_trace ||= []).push(poll);
        responseReads.push(response.json().then(body => {poll.revision=body.revision;poll.playing=body.playing;}).catch(() => {}));
      }
      if (response.status() < 400) return;
      const error = {status: response.status(), url: response.url()}; result.http_errors.push(error);
      responseReads.push(response.json().then(body => { error.code = body.code; }).catch(() => {}));
    });
    context.on('request', request => { if (request.method() !== 'GET') result.writes.push({method: request.method(), path: new URL(request.url()).pathname}); });
    const initial = await library();
    const image = initial.scripts.flatMap(script => script.blocks).find(block => block.kind === 'image'); assert(image);
    const category = await send('/api/categories', {name: '后台冻结回归分组', description: '只在隔离资料目录中存在', color: '#705544'});
    const scriptA = await send('/api/scripts', {title: '后台长正文 A', category_id: category.id,
      blocks: Array.from({length: 50}, (_, i) => ({kind: 'text', role: i % 2 ? '乙' : '甲', text: `第${i + 1}段：后台切换和连续滚动应继续处理最新状态，不依赖浏览器的动画帧。` + '灯光照着，声音沿着长廊传来。'.repeat(4)}))});
    const scriptB = await send('/api/scripts', {title: '后台最新正文 B', category_id: category.id,
      blocks: [{kind: 'text', role: '丙', text: '最新正文必须覆盖较早的布局结果。'.repeat(170)}, {kind: 'image', image_path: image.image_path, text: '后台插图'}, {kind: 'text', text: '最后一段：状态已经更新。'}]});
    const mediaScript = await send('/api/scripts', {title: '后台媒体分页', category_id: category.id,
      blocks: [{kind: 'text', role: '甲', text: '媒体第一组：长台词分成多页，隐藏后仍应完成组内页面定位。\n'.repeat(100)}, {kind: 'image', image_path: image.image_path}, {kind: 'text', role: '乙', text: '媒体第二组：短台词。'}]});
    const csrf = (await library()).csrf_token;
    const upload = await context.request.post(base + '/api/scripts/' + mediaScript.id + '/media', {headers: {'X-CSRF-Token': csrf}, multipart: {file: {name: 'background.wav', mimeType: 'audio/wav', buffer: wav()}}});
    assert(upload.ok(), await upload.text());
    await send('/api/scripts/' + mediaScript.id + '/media/cues', {duration: 12, cues: [
      {id: 'bg-cue-1', at: 1, label: '长组', block_ids: mediaScript.blocks.slice(0, 2).map(block => block.id)},
      {id: 'bg-cue-2', at: 6, label: '短组', block_ids: [mediaScript.blocks[2].id]},
    ]}, 'PUT');
    // Use a related named window so the real Restore Display button can reuse
    // it later. The opener stays on management during the core poll tests.
    controller = await context.newPage(); await controller.goto(base + '/manage');
    const popup = context.waitForEvent('page');
    await controller.evaluate(() => window.open('/display', 'wb-display', 'popup=yes,width=560,height=960'));
    audience = await popup; await audience.waitForLoadState();
    await until(() => result.writes.filter(item => item.path === '/api/display/connect').length === 1, 'one audience connection');
    result.connect_count_initial = 1;
    await until(async () => (await rafStats()).executed > 3, 'native rAF wrapper active');
    const listPayload = {mode: 'list', list_source: 'categories', category_ids: [category.id], directory_level: 'categories', orientation: 'portrait'};
    await apply(listPayload);
    await audience.locator(`[data-anchor="category:${category.id}"]`).waitFor();
    await until(contentOpaque, 'initial directory is visible');

    // Hidden before a new snapshot: no rendering/layout wait may depend on rAF.
    await audience.evaluate(() => window.__qaRaf.hide()); const hiddenStart = await rafStats();
    const pagesA = {mode: 'script', script_id: scriptA.id, orientation: 'portrait', layout: {body_mode: 'pages', font_size: 40, line_height: 1.8, padding: 72}};
    let applied = await apply(pagesA, {preview_page_index: 0, preview_anchor: null});
    await expectBody(scriptA.title, 'pages');
    assert(await audience.locator('.stage-page').count() > 3);
    const anchor2 = await audience.locator('.stage-page[data-page-index="2"] [data-anchor]').first().getAttribute('data-anchor');
    await send('/api/command', {action: 'page', snapshot_id: applied.snapshot.id, page_index: 2, anchor: anchor2});
    await until(async () => await pageIndex() === 2, 'hidden exact body page');
    await apply(listPayload); await audience.locator(`[data-anchor="category:${category.id}"]`).waitFor(); await until(contentOpaque, 'hidden return directory');
    const pagesB = {...pagesA, script_id: scriptB.id};
    applied = await apply(pagesB, {preview_page_index: 1, preview_anchor: scriptB.blocks[0].id});
    await expectBody(scriptB.title, 'pages', 1);
    // Publish two snapshots without waiting for either render; the newer one wins.
    await apply({...pagesA, orientation: 'landscape'}, {preview_page_index: 2, preview_anchor: scriptA.blocks[5].id});
    await apply(pagesB, {preview_page_index: 1, preview_anchor: scriptB.blocks[0].id});
    await expectBody(scriptB.title, 'pages', 1);
    await auditFrozen('hidden directory/body/page changes', hiddenStart);
    result.checks.push('With all rAF callbacks frozen, hidden directory/body changes and exact page commands complete and content remains opaque');

    // Flush all old callbacks only after the latest snapshot/page has won.
    const latestText = await audience.locator('.stage-page.is-current').textContent();
    await audience.evaluate(() => window.__qaRaf.show());
    await delay(1000); assert.equal(await pageIndex(), 1); assert.equal(await audience.locator('.stage-page.is-current').textContent(), latestText);
    result.checks.push('Resuming queued rAF callbacks does not restore an older body or page');

    // Freeze while still reported visible, start a new layout, then hide during
    // that operation. This catches nextFrame promises queued before the event.
    await audience.evaluate(() => window.__qaRaf.freeze());
    const midStart = await rafStats();
    const landscapeA = {...pagesA, orientation: 'landscape'};
    applied = await apply(landscapeA, {preview_page_index: 2, preview_anchor: scriptA.blocks[5].id});
    await until(async () => await audience.locator('#stage.landscape').count() === 1, 'new layout begins before hide');
    await audience.evaluate(() => window.__qaRaf.visibility('hidden'));
    await expectBody(scriptA.title, 'pages', 2);
    await apply({...pagesB, orientation: 'landscape'}, {preview_page_index: 1, preview_anchor: scriptB.blocks[0].id});
    await expectBody(scriptB.title, 'pages', 1);
    await auditFrozen('freeze visible layout then hide', midStart);
    await audience.evaluate(() => window.__qaRaf.show()); await delay(900);
    assert.equal(await pageIndex(), 1); assert((await audience.locator('#stage-content').textContent()).includes(scriptB.title));
    await screenshot('background-display-pages');
    result.checks.push('An already-pending visible layout survives rAF freeze followed by hiding; latest snapshot wins after recovery');

    // No controller/BroadcastChannel motion is running. Hidden autonomous
    // scrolling must advance by a timer/elapsed-time fallback, then stop.
    const scrolling = {...pagesA, layout: {...pagesA.layout, body_mode: 'scroll', speed: 120}};
    await apply(scrolling, {preview_anchor: null}); await expectBody(scriptA.title, 'scroll');
    await audience.evaluate(() => window.__qaRaf.hide()); const scrollRafStart = await rafStats();
    await send('/api/command', {action: 'speed', speed: 120}); await send('/api/command', {action: 'play'});
    await until(async () => await scrollTop() > 10, 'background continuous scroll starts');
    const start = await scrollTop(), started = Date.now();
    for (let i = 0; i < 9; i++) { await delay(200); result.scroll_samples.push({elapsed: Date.now() - started, scroll_top: await scrollTop()}); }
    const advanced = await scrollTop(), elapsed = Date.now() - started;
    assert(advanced - start > 100, 'hidden scroll did not advance sufficiently');
    assert(advanced - start < elapsed / 1000 * 180 + 80, 'hidden scroll advanced twice or jumped');
    await send('/api/command', {action: 'pause'});
    await delay(950); const paused = await scrollTop(); await delay(650);
    assert(Math.abs(await scrollTop() - paused) <= 1, 'hidden pause did not stop timer scrolling');
    await auditFrozen('hidden scroll and pause', scrollRafStart);
    await audience.evaluate(() => window.__qaRaf.show()); await delay(1000);
    assert(Math.abs(await scrollTop() - paused) <= 2, 'restoring visible page jumped to stale scroll checkpoint');
    result.scroll_summary = {start, advanced, elapsed_ms: elapsed, paused, resumed: await scrollTop()};
    result.checks.push('Hidden autonomous scroll advances with frozen rAF, pauses, and resumes visibility without jumping to a stale checkpoint');
    // A compositor may stop rAF without changing document.visibilityState.
    // Layout and the low-frequency fallback must also survive this condition.
    await audience.evaluate(() => window.__qaRaf.freeze());
    const visibleFrozen = await rafStats();
    await apply({...scrolling, script_id: scriptB.id, orientation: 'landscape'}, {preview_anchor: null});
    await expectBody(scriptB.title, 'scroll');
    await until(async () => !(await diagnostic()).health?.positioning, 'visible frozen layout has finished positioning');
    await send('/api/command', {action: 'play'});
    await until(async () => await scrollTop() > 10, 'visible frozen-rAF scrolling starts');
    const frozenVisibleStart = await scrollTop(), frozenVisibleAt = Date.now();
    await delay(1350);
    const frozenVisibleEnd = await scrollTop(), frozenVisibleElapsed = Date.now() - frozenVisibleAt;
    result.visible_frozen_summary = {start:frozenVisibleStart,end:frozenVisibleEnd,elapsed_ms:frozenVisibleElapsed};
    assert(frozenVisibleEnd - frozenVisibleStart > 70, 'visible rAF starvation must keep low-frequency scrolling');
    assert(frozenVisibleEnd - frozenVisibleStart < frozenVisibleElapsed / 1000 * 180 + 70, 'visible fallback must not double count');
    await auditFrozen('visible rAF starvation layout and scroll', visibleFrozen, 'visible');
    await audience.evaluate(() => window.__qaRaf.resume());
    const resumedAt = Date.now(); await delay(650); const resumedPosition = await scrollTop();
    assert(resumedPosition >= frozenVisibleEnd - 2);
    assert(resumedPosition - frozenVisibleEnd < (Date.now() - resumedAt) / 1000 * 180 + 70, 'restored rAF and timer must share one time baseline');
    await send('/api/command', {action: 'pause'}); await delay(800);
    result.visible_frozen_summary = {start: frozenVisibleStart, end: frozenVisibleEnd, elapsed_ms: frozenVisibleElapsed, resumed: resumedPosition};
    result.checks.push('Visible-but-starved rAF completes layout and continues low-frequency scrolling; resuming rAF does not double-count elapsed time');
    await audience.evaluate(() => { window.__qaRaf.hide(); const scroll = document.querySelector('#stage-scroll'); scroll.scrollTop = scroll.scrollHeight - scroll.clientHeight - 35; });
    const endRafStart = await rafStats();
    await send('/api/command', {action: 'play'});
    await until(async () => {
      const atEnd = await audience.locator('#stage-scroll').evaluate(element => element.scrollTop >= element.scrollHeight - element.clientHeight - 1);
      return atEnd && !(await state()).playing;
    }, 'hidden end automatically pauses');
    await auditFrozen('hidden end automatic pause', endRafStart);
    const atEndPosition = await scrollTop();
    await audience.evaluate(() => window.__qaRaf.show()); await delay(600);
    assert(Math.abs(await scrollTop() - atEndPosition) <= 2);
    result.checks.push('Hidden scrolling automatically pauses at the bottom and visibility recovery stays at the bottom');

    // Hidden media layout plus same-group page and different-group changes.
    await audience.evaluate(() => window.__qaRaf.hide()); const mediaRafStart = await rafStats();
    const mediaPayload = {mode: 'script', script_id: mediaScript.id, orientation: 'portrait', layout: {body_mode: 'media', media_caption_layout: 'pages', media_caption_mode: 'manual', font_size: 40}};
    applied = await apply(mediaPayload, {preview_media_state: {position: 1, caption_index: 0, caption_page_index: 0, cue_id: 'bg-cue-1'}});
    await until(async () => await audience.locator('.wb-media-caption-page').count() > 3 && await audience.locator('.wb-media-caption-page.is-current').count() === 1, 'hidden media caption pagination');
    const mediaPages = await audience.locator('.wb-media-caption-page').count();
    let currentState = await state();
    await send('/api/command', {action: 'media', snapshot_id: currentState.snapshot.id, revision: currentState.revision, playing: false, media_state: {position: 2, caption_index: 0, caption_page_index: 2, cue_id: 'bg-cue-1'}});
    await until(async () => await captionIndex() === 2, 'hidden media same-group page 3');
    currentState = await state();
    await send('/api/command', {action: 'media', snapshot_id: currentState.snapshot.id, revision: currentState.revision, playing: false, media_state: {position: 6, caption_index: 1, caption_page_index: 0, cue_id: 'bg-cue-2'}});
    await until(async () => await audience.locator('.wb-media-caption-page').count() === 1 && (await audience.locator('.wb-media-caption-scroll').textContent()).includes('媒体第二组'), 'hidden media changes group');
    currentState = await state();
    await send('/api/command', {action: 'media', snapshot_id: currentState.snapshot.id, revision: currentState.revision, playing: false, media_state: {position: 2, caption_index: 0, caption_page_index: 1, cue_id: 'bg-cue-1'}});
    await until(async () => await audience.locator('.wb-media-caption-page').count() === mediaPages && await captionIndex() === 1, 'hidden media returns to selected group/page');
    const captionText = await audience.locator('.wb-media-caption-page.is-current').textContent();
    await auditFrozen('hidden media groups and pages', mediaRafStart);
    await audience.evaluate(() => window.__qaRaf.show()); await delay(1000);
    assert.equal(await captionIndex(), 1); assert.equal(await audience.locator('.wb-media-caption-page.is-current').textContent(), captionText);
    const mediaState = await audience.locator('.wb-media-element').evaluate(element => ({position: element.currentTime, paused: element.paused}));
    assert(mediaState.paused && Math.abs(mediaState.position - 2) < .1);
    result.media_summary = {caption_pages: mediaPages, current_page_index: await captionIndex(), ...mediaState};
    await screenshot('background-display-media');
    result.checks.push('Frozen-rAF hidden media completes measured pagination and group/page commands; visibility recovery preserves exact page/text/media time');

    // Real control health UI and its existing-window recovery action.
    await controller.setViewportSize({width: 1440, height: 1000});
    await controller.goto(base + '/control');
    await until(async () => await controller.locator('#display-health').getAttribute('data-state') === 'visible', 'control detects visible audience');
    const mediaBeforeRestore = await state(), restorePage = await captionIndex();
    await audience.evaluate(() => window.__qaRaf.hide());
    await until(async () => await controller.locator('#display-health').getAttribute('data-state') === 'hidden', 'control detects frozen hidden audience');
    assert((await controller.locator('#display-health-detail').textContent()).includes('采集停帧'));
    assert((await controller.locator('#open-display').textContent()).includes('恢复'));
    for (const width of [1440, 390]) {
      await controller.setViewportSize({width, height: 1000});
      await controller.locator('#display-health').scrollIntoViewIfNeeded();
      const sizes = await controller.evaluate(() => ({scroll: document.documentElement.scrollWidth, inner: innerWidth}));
      assert(sizes.scroll <= sizes.inner + 1, 'control health layout must not overflow at ' + width);
      const filename = path.join(output, `background-display-health-${width}.png`);
      await controller.screenshot({path: filename}); result.screenshots.push(filename);
    }
    await controller.setViewportSize({width: 1440, height: 1000});
    await controller.locator('#open-display').click(); await delay(350);
    assert.equal(result.writes.filter(item => item.path === '/api/display/connect').length, 1, 'Restore must reuse the existing window without reconnecting');
    assert.equal(await captionIndex(), restorePage); assert.equal((await state()).playing, mediaBeforeRestore.playing);
    assert.deepEqual((await state()).media_state, mediaBeforeRestore.media_state);
    await audience.evaluate(() => window.__qaRaf.show());
    await until(async () => await controller.locator('#display-health').getAttribute('data-state') === 'visible', 'health returns to visible');
    await apply(scrolling, {preview_anchor: null}); await expectBody(scriptA.title, 'scroll');
    await send('/api/command', {action: 'play'}); await until(async () => await scrollTop() > 10, 'playing before restore-button test');
    await audience.evaluate(() => window.__qaRaf.hide());
    await until(async () => await controller.locator('#display-health').getAttribute('data-state') === 'hidden', 'playing audience hidden health');
    const positionBeforeRestore = await scrollTop();
    await controller.locator('#open-display').click(); await delay(350);
    assert((await state()).playing, 'Restore button must not pause a playing display');
    assert.equal(result.writes.filter(item => item.path === '/api/display/connect').length, 1);
    await audience.evaluate(() => window.__qaRaf.show()); await delay(450);
    assert(await scrollTop() >= positionBeforeRestore - 2, 'Restore must not rewind running content');
    await send('/api/command', {action: 'pause'});
    result.connect_count_final = result.writes.filter(item => item.path === '/api/display/connect').length;
    result.checks.push('Health UI reports visible/hidden and capture caveat; Restore reuses one named window without resetting media page/time or active playback');
    result.scope = 'Simulated hidden visibility plus genuinely intercepted/canceled rAF callbacks; not a test of actual OS minimization or Douyin capture-compositor frames.';
    const checkpoints = result.writes.filter(item => item.path === '/api/checkpoint').length;
    result.checkpoints = checkpoints; assert(checkpoints < 45, 'Background fallback generated excessive checkpoints');
    await Promise.all(responseReads);
    assert.deepEqual(result.page_errors, []);
    result.expected_stale_checkpoints = result.http_errors.filter(error => error.status === 409 && error.code === 'stale_revision' && error.url === base + '/api/checkpoint');
    assert.deepEqual(result.http_errors, result.expected_stale_checkpoints, 'Only explicitly rejected stale-revision checkpoints are expected during rapid state changes');
    result.diagnostic_source_injection = process.env._QA_TRACE === '1';
    result.display_sha256 = createHash('sha256').update(fs.readFileSync(path.join(root,'static','display.js'))).digest('hex');
    result.passed = true;
  } catch (error) {
    result.error = error.stack || String(error);
    if (audience && !audience.isClosed()) {
      result.failure_raf = await rafStats().catch(() => null);
      result.failure_diagnostic = await diagnostic().catch(error => ({error: String(error)}));
      result.failure_state = await state().catch(() => null);
      await audience.screenshot({path: path.join(output, 'background-display-failure.png')}).catch(() => {});
    }
    throw error;
  } finally {
    if (browser) await browser.close();
    if (server) {
      try { result.stop = execFileSync(python, ['-X', 'utf8', 'tools/stop.py', '--data-dir', dataDir], {cwd: root, windowsHide: true, encoding: 'utf8', timeout: 20000}).trim(); }
      catch (error) { result.stop_error = String(error); result.passed = false; if (server.exitCode === null) server.kill(); }
    }
    result.finished_at = new Date().toISOString();
    fs.writeFileSync(path.join(output, 'background-display-result.json'), JSON.stringify(result, null, 2));
  }
}
main().then(() => console.log(JSON.stringify({passed: result.passed, checks: result.checks, scroll_summary: result.scroll_summary, media_summary: result.media_summary}))).catch(error => {console.error(error); process.exitCode = 1;});
