'use strict';
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const { spawn, execFileSync } = require('node:child_process');
const path = require('node:path'), fs = require('node:fs');
const root = path.resolve(__dirname, '..'), python = path.join(root, 'runtime', 'python.exe');
const data = path.join(root, '.qa', 'preview-keyboard-' + Date.now()), base = 'http://127.0.0.1:8905';
const output = path.join(root, '.qa', 'browser');
const result = { ok: false, data_dir: data, checks: [], errors: [] };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let child, browser, context, page, frame;
const writes = [];
const check = label => { result.checks.push(label); console.log(label); };
async function until(check, label) { for (let i = 0; i < 160; i++) { if (await check()) return; await delay(100); } throw Error('Timed out: ' + label); }
const library = async () => (await context.request.get(base + '/api/library')).json();
const state = async () => (await context.request.get(base + '/api/state')).json();
async function send(url, data, method = 'POST', multipart) {
  const csrf = (await library()).csrf_token;
  const response = await context.request.fetch(base + url, { method, headers: { 'X-CSRF-Token': csrf }, ...(multipart ? { multipart } : { data }) });
  assert(response.ok(), await response.text()); return response.json();
}
function wav() {
  const sampleRate = 8000, bytes = 8 * sampleRate * 2, buffer = Buffer.alloc(44 + bytes);
  buffer.write('RIFF', 0); buffer.writeUInt32LE(36 + bytes, 4); buffer.write('WAVEfmt ', 8);
  buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(1, 20); buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24); buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32); buffer.writeUInt16LE(16, 34); buffer.write('data', 36); buffer.writeUInt32LE(bytes, 40); return buffer;
}
async function ready() {
  await page.waitForFunction(() => !document.querySelector('#apply-display').disabled);
  frame = page.frames().find(item => item.url().includes('preview=1'));
}
async function bodyFocus() { await frame.locator('body').evaluate(element => { element.tabIndex = -1; element.focus(); }); }
async function press(key) { await bodyFocus(); await page.keyboard.press(key); }
const selected = () => frame.evaluate(() => document.querySelector('.preview-selected')?.dataset.anchor || null);
const pageIndex = () => frame.locator('.stage-page.is-current').getAttribute('data-page-index').then(Number);
const interactions = () => page.evaluate(() => window.__qaMessages.filter(message => message.type === 'pia-preview-position' && message.reason === 'interaction').length);
async function forwarded(key, snapshotId) {
  const id = snapshotId || await frame.evaluate(() => window.__qaSnapshot.id);
  await page.evaluate(({ key, id }) => document.querySelector('#preview-frame').contentWindow.postMessage({ type: 'pia-preview-key', key, snapshot_id: id }, location.origin), { key, id });
}
async function boundary(key) {
  await bodyFocus(); await delay(80);
  const before = await interactions();
  const position = () => frame.evaluate(() => ({scroll:document.querySelector('#stage-scroll').scrollTop,windowY:scrollY,page:document.querySelector('.stage-page.is-current')?.dataset.pageIndex,active:document.activeElement?.dataset.anchor||null}));
  const start = await position(), parentY = await page.evaluate(() => scrollY);
  await page.keyboard.press(key); await delay(200);
  assert.equal(await interactions(), before, key+' boundary must not report interaction');
  assert.deepEqual(await position(), start, key+' boundary must not scroll');
  assert.equal(await page.evaluate(() => scrollY), parentY, key+' boundary must not scroll parent');
  assert(await frame.evaluate(() => window.__qaKeys.at(-1)?.prevented), key+' browser default consumed');
}
async function main() {
  try {
    let occupied = false; try { await fetch(base + '/api/health'); occupied = true; } catch (_) {} assert(!occupied, 'QA port already occupied');
    child = spawn(python, ['-X', 'utf8', 'run.py', '--no-browser', '--port', '8905', '--data-dir', data], { cwd: root, windowsHide: true, stdio: 'ignore' });
    await until(async () => { try { return (await (await fetch(base + '/api/health')).json()).data_dir === data; } catch { return false; } }, 'isolated server');
    browser = await chromium.launch({ channel: 'msedge', headless: true });
    context = await browser.newContext({ viewport: { width: 1600, height: 1120 } });
    context.setDefaultTimeout(7000);
    await context.addInitScript(() => {
      if (location.origin === 'http://127.0.0.1:8905') localStorage.setItem('pia-preview-preferences', JSON.stringify({ placement: 'outside', feedback: 'confirm' }));
      window.__qaMessages = []; window.__qaKeys = [];
      window.addEventListener('keydown', event => setTimeout(() => window.__qaKeys.push({key:event.key,target:event.target?.tagName,prevented:event.defaultPrevented}), 0));
      window.addEventListener('message', event => {
        if (event.origin !== location.origin) return;
        if (event.data?.type?.startsWith('pia-preview-')) window.__qaMessages.push(event.data);
        if (event.source === window.parent && event.data?.type === 'pia-preview') window.__qaSnapshot = event.data.snapshot;
      });
    });
    context.on('page', item => {
      item.on('pageerror', error => result.errors.push(error.message));
      item.on('request', request => { if (new URL(request.url()).pathname.startsWith('/api/') && !['GET', 'HEAD'].includes(request.method()) && !request.url().endsWith('/api/preview')) writes.push({ method: request.method(), url: request.url() }); });
    });
    const category = await send('/api/categories', { name: '快捷键验收', color: '#705080' });
    const fixture = await send('/api/scripts', { title: '方向键正文', category_id: category.id, blocks: Array.from({ length: 14 }, (_, index) => ({ kind: 'text', role: index % 2 ? '乙' : '甲', text: `第${index + 1}段。` + '这是一段用于真实排版和方向键定位的正文。'.repeat(24) })) });
    const second = await send('/api/scripts', { title: '第二篇快捷键正文', category_id: category.id, blocks: [{ kind: 'text', text: '目录卡片焦点与回车打开验证。' }] });
    await send(`/api/scripts/${fixture.id}/media`, undefined, 'POST', { file: { name: 'keyboard.wav', mimeType: 'audio/wav', buffer: wav() } });
    await send(`/api/scripts/${fixture.id}/media/cues`, { duration: 8, cues: [0, 1, 2].map(index => ({ id: 'keyboard-cue-' + index, at: index + 1, label: '第' + (index + 1) + '组', block_ids: [fixture.blocks[index].id] })) }, 'PUT');
    const initialState = await state();
    page = await context.newPage();
    await page.goto(base + '/control?script=' + fixture.id); await ready();
    await page.locator('#layout-body-mode').selectOption('pages'); await ready();
    assert(await frame.locator('.stage-page').count() > 3);
    await press('ArrowRight'); await until(async () => await pageIndex() === 1, 'right next page');
    await press('ArrowDown'); await until(async () => await pageIndex() === 2, 'down next page');
    await press('ArrowLeft'); await until(async () => await pageIndex() === 1, 'left previous page');
    await press('ArrowUp'); await until(async () => await pageIndex() === 0, 'up previous page');
    await boundary('ArrowLeft');
    await forwarded('ArrowDown'); await until(async () => await pageIndex() === 1, 'parent key message');
    const samePage = await pageIndex();
    await forwarded('ArrowDown', 'stale-id');
    await frame.evaluate(() => window.postMessage({ type: 'pia-preview-key', key: 'ArrowDown', snapshot_id: window.__qaSnapshot.id }, location.origin));
    await delay(220); assert.equal(await pageIndex(), samePage);
    const repeatPrevented = await frame.evaluate(() => { const event = new KeyboardEvent('keydown', { key: 'ArrowDown', repeat: true, bubbles: true, cancelable: true }); document.body.dispatchEvent(event); return event.defaultPrevented; });
    assert(repeatPrevented); assert.equal(await pageIndex(), samePage);
    check('分页四方向键、父页消息、拒绝陈旧和非父来源、忽略长按重复');

    const beforeGuards = await interactions();
    const guards = await frame.evaluate(() => {
      const results = [], holder = document.createElement('div'); document.body.append(holder);
      const probes = ['input', 'textarea', 'select', 'range', 'contenteditable', 'disabled'];
      for (const type of probes) {
        const element = document.createElement(type === 'range' ? 'input' : type === 'contenteditable' ? 'div' : type === 'disabled' ? 'button' : type);
        if (type === 'range') element.type = 'range'; if (type === 'contenteditable') element.contentEditable = 'true'; if (type === 'disabled') element.disabled = true;
        holder.append(element); element.focus();
        const event = new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }); element.dispatchEvent(event); results.push({ type, prevented: event.defaultPrevented });
      }
      for (const options of [{ isComposing: true }, { keyCode: 229 }, { ctrlKey: true }, { altKey: true }, { metaKey: true }, { shiftKey: true }]) {
        const event = new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true, ...options }); document.body.dispatchEvent(event); results.push({ type: JSON.stringify(options), prevented: event.defaultPrevented });
      }
      holder.remove(); return results;
    });
    assert(guards.every(item => !item.prevented), JSON.stringify(guards)); await delay(220);
    assert.equal(await interactions(), beforeGuards, 'Protected editing keys never schedule a second position report');
    assert.equal(await pageIndex(), samePage);
    check('input/textarea/select/range/contenteditable/disabled/IME/229及四种修饰键保护');
    const lastPage = await frame.locator('.stage-page').count() - 1;
    for(let index=await pageIndex();index<lastPage;index++){await forwarded('ArrowRight');await until(async()=>await pageIndex()===index+1,'page end navigation');}
    await boundary('ArrowRight');
    check('分页首尾方向键不滚动容器或父页，不产生重复interaction');

    await page.locator('#layout-body-mode').selectOption('scroll'); await ready();
    await page.locator('[data-preview-external="top"]').click();
    await until(()=>page.evaluate(()=>window.__qaMessages.filter(message=>message.type==='pia-preview-position').at(-1)?.anchor===null),'top command received');
    await press('ArrowRight'); await until(async () => await selected() === fixture.blocks[0].id, 'first block');
    await until(()=>page.evaluate(id=>window.__qaMessages.filter(message=>message.type==='pia-preview-position').at(-1)?.anchor===id,fixture.blocks[0].id),'first block report');
    const beforeOneKey = await interactions();
    await press('ArrowDown'); await until(async () => await selected() === fixture.blocks[1].id, 'next block');
    await delay(250); assert.equal(await interactions(), beforeOneKey + 1, 'One arrow emits exactly one interaction');
    await press('ArrowLeft'); await until(async () => await selected() === fixture.blocks[0].id, 'previous block');
    await press('ArrowUp'); await until(async () => await frame.locator('.preview-selected').count() === 0, 'return to top');
    await boundary('ArrowUp');
    await frame.locator(`[data-anchor="${fixture.blocks.at(-1).id}"]`).evaluate(element=>element.click());
    await until(()=>page.evaluate(id=>window.__qaMessages.filter(message=>message.type==='pia-preview-position').at(-1)?.anchor===id,fixture.blocks.at(-1).id),'last block report');
    await boundary('ArrowDown');
    check('滚动正文四方向按段定位，无150ms重复位置覆盖');

    await page.goto(base + '/control'); await ready();
    await press('ArrowRight');
    const cards = frame.locator('[data-preview-category]'), count = await cards.count(); assert(count >= 2);
    await until(() => cards.first().evaluate(element => element === document.activeElement), 'first category focus');
    const firstCategoryAnchor=await cards.first().getAttribute('data-anchor');
    await until(()=>page.evaluate(id=>window.__qaMessages.filter(message=>message.type==='pia-preview-position').at(-1)?.anchor===id,firstCategoryAnchor),'first category report');
    const directoryBefore=await interactions();await page.keyboard.press('ArrowLeft');await delay(220);
    assert(await cards.first().evaluate(element=>element===document.activeElement));assert.equal(await interactions(),directoryBefore);
    assert(await frame.evaluate(()=>window.__qaKeys.at(-1)?.prevented));
    await page.keyboard.press('ArrowRight'); assert(await cards.nth(1).evaluate(element => element === document.activeElement));
    await frame.locator(`[data-preview-category="${category.id}"]`).focus(); await page.keyboard.press('Enter'); await ready();
    await frame.locator(`[data-preview-script="${fixture.id}"]`).waitFor(); await ready();
    await bodyFocus(); await page.keyboard.press('ArrowRight');
    await until(() => frame.locator('[data-preview-script]').first().evaluate(element => element === document.activeElement), 'script focus first');
    await page.keyboard.press('ArrowRight');
    assert(await frame.locator('[data-preview-script]').nth(1).evaluate(element => element === document.activeElement));
    await page.keyboard.press('Enter');
    await frame.waitForFunction(id=>window.__qaSnapshot?.mode==='script'&&window.__qaSnapshot?.scripts?.[0]?.id===id,second.id); await ready();
    assert.equal(await frame.evaluate(() => window.__qaSnapshot.scripts[0].id), second.id);
    check('两级目录方向键焦点与原有Enter打开');

    await page.goto(base + '/control?script=' + fixture.id + '&body=media'); await ready();
    await page.locator('#layout-body-mode').selectOption('media'); await ready();
    await page.locator('#layout-media-caption-layout').selectOption('scroll'); await ready();
    await frame.waitForFunction(() => document.querySelector('.pia-media-element')?.duration > 7);
    const label = () => frame.locator('.pia-media-caption-label').textContent();
    const mediaPosition = () => frame.locator('.pia-media-element').evaluate(element => element.currentTime);
    const mediaStart = await mediaPosition();
    await press('ArrowRight'); await until(async () => (await label()).includes('2 / 3'), 'media next caption');
    await press('ArrowDown'); await until(async () => (await label()).includes('3 / 3'), 'media down caption');
    await press('ArrowLeft'); await until(async () => (await label()).includes('2 / 3'), 'media previous caption');
    await press('ArrowUp'); await until(async () => (await label()).includes('1 / 3'), 'media up caption');
    assert.equal(await mediaPosition(), mediaStart, 'Arrows must never seek audio/video');
    const rangeProtected = await frame.locator('.pia-media-progress').evaluate(element => { element.focus(); const event = new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }); element.dispatchEvent(event); return !event.defaultPrevented; });
    assert(rangeProtected);
    await until(()=>page.evaluate(()=>window.__qaMessages.filter(message=>message.type==='pia-preview-position'&&message.reason==='interaction').at(-1)?.media_state?.caption_index===0),'media first caption report');
    const beforeEscape = await interactions(); await press('Escape');
    await until(() => page.evaluate(() => window.__qaMessages.some(message => message.type === 'pia-preview-exit-focus')), 'escape exit focus message');
    assert.equal(await interactions(), beforeEscape, 'Escape does not play, seek, or publish');
    assert.equal(await mediaPosition(), mediaStart);
    assert.deepEqual(writes, [], 'All confirm keyboard operations remain isolated');
    assert.equal((await state()).revision, initialState.revision);
    check('媒体仅切台词、保留原生进度条；Esc仅发退出消息；确认全程无直播写入');

    await page.goto(base + '/control?script=' + fixture.id); await ready();
    await page.locator('#layout-body-mode').selectOption('pages'); await ready();
    await page.locator('#preview-feedback-mode').selectOption('realtime');
    await until(async () => (await state()).snapshot?.scripts?.[0]?.id === fixture.id, 'realtime binding'); await ready();
    const beforeRealtime = writes.filter(item => item.url.endsWith('/api/apply')).length;
    const liveBefore = await state();
    const nextPage = await pageIndex() + 1;
    await press('ArrowRight');
    await until(async () => (await state()).page_index === nextPage, 'realtime arrow page'); await ready(); await delay(300);
    assert.equal(writes.filter(item => item.url.endsWith('/api/apply')).length, beforeRealtime + 1, 'A realtime arrow publishes once');
    assert.equal((await state()).revision, liveBefore.revision + 1);
    check('实时方向键一次导航仅一次apply与一次revision更新');
    assert.deepEqual(result.errors, []);
    result.ok = true;
  } catch (error) {
    result.error = error.stack || String(error);
    if(frame)result.diagnostic=await frame.evaluate(()=>({mode:window.__qaSnapshot?.layout?.body_mode,snapshot:window.__qaSnapshot?.id,selected:[...document.querySelectorAll('.preview-selected')].map(n=>n.dataset.anchor),anchors:[...document.querySelectorAll('[data-anchor]')].slice(0,4).map(n=>n.dataset.anchor),keys:window.__qaKeys.slice(-6),active:document.activeElement?.outerHTML.slice(0,300)})).catch(()=>null);
    if(page)result.messages=await page.evaluate(()=>window.__qaMessages?.slice(-6)).catch(()=>null);
    if (page && !page.isClosed()) await page.screenshot({ path: path.join(output, 'preview-keyboard-failure.png'), fullPage: true }).catch(() => {});
    throw error;
  } finally {
    fs.mkdirSync(output, { recursive: true });
    fs.writeFileSync(path.join(output, 'preview-keyboard-result.json'), JSON.stringify(result, null, 2));
    if (browser) await browser.close();
    if (child) { try { execFileSync(python, ['-X', 'utf8', 'tools/stop.py', '--data-dir', data], { cwd: root, windowsHide: true, timeout: 15000, stdio: 'ignore' }); } catch { child.kill(); } }
  }
}
main().then(() => console.log(JSON.stringify(result))).catch(error => { console.error(error); process.exitCode = 1; });
