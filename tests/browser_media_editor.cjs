'use strict';

// Uses only a newly-created QA data directory. Never reuses the normal instance.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '..');
const python = path.join(root, 'runtime', 'python.exe');
const dataDir = path.join(root, '.qa', `media-editor-${Date.now()}`);
const output = path.join(root, '.qa', 'browser');
const port = 8899;
const base = `http://127.0.0.1:${port}`;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let server, browser, page, context;
const errors = [];
const result = { ok: false, data_dir: dataDir, checks: [] };
fs.mkdirSync(output, { recursive: true });

function wav(seconds = 8) {
  const sampleRate = 8000, bytes = seconds * sampleRate * 2;
  const buffer = Buffer.alloc(44 + bytes);
  buffer.write('RIFF', 0); buffer.writeUInt32LE(36 + bytes, 4); buffer.write('WAVEfmt ', 8);
  buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(1, 20); buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24); buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32); buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36); buffer.writeUInt32LE(bytes, 40);
  return buffer;
}
async function library() { return (await context.request.get(base + '/api/library')).json(); }
async function api(url, method = 'GET', data) {
  const csrf = (await library()).csrf_token;
  const response = await context.request.fetch(base + url, {
    method, headers: { 'X-CSRF-Token': csrf }, ...(data === undefined ? {} : { data }),
  });
  const body = await response.json();
  assert(response.ok(), `${method} ${url}: ${response.status()} ${JSON.stringify(body)}`);
  return body;
}
async function stored(id) { return (await library()).scripts.find(script => script.id === id); }
async function waitFor(predicate, label, timeout = 10000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await predicate()) return; await sleep(100); }
  throw new Error(`Timed out: ${label}`);
}
async function confirmModal(accept) {
  const dialog = page.locator('#media-confirm-dialog');
  await dialog.waitFor({ state: 'visible' });
  if (accept) await page.locator('#media-confirm-yes').click();
  else await dialog.getByRole('button', { name: '取消', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
}
async function seek(seconds) {
  await page.locator('#media-player').evaluate((player, at) => { player.pause(); player.currentTime = at; }, seconds);
  await page.waitForFunction(at => Math.abs(document.querySelector('#media-player').currentTime - at) < .03, seconds);
}
async function mark(seconds) { await seek(seconds); await page.locator('#media-mark-cue').click(); }
async function save(id, count) {
  const responsePromise = page.waitForResponse(response => response.request().method() === 'PUT' && response.url().endsWith(`/api/scripts/${id}/media/cues`));
  await page.locator('#media-save-cues').click();
  const response = await responsePromise;
  assert(response.ok(), await response.text());
  await page.waitForFunction(() => document.querySelector('#media-editor').getAttribute('aria-busy') === 'false');
  assert.equal((await stored(id)).media.cues.length, count);
  assert(await page.locator('#media-editor-error').isHidden());
  assert(await page.locator('#media-reset-cues').isDisabled());
}
async function expectInvalidSave(pattern) {
  await page.locator('#media-save-cues').click();
  await page.locator('#media-editor-error').waitFor({ state: 'visible' });
  assert.match(await page.locator('#media-editor-error').textContent(), pattern);
  await page.waitForFunction(() => document.querySelector('#media-editor').getAttribute('aria-busy') === 'false');
}
async function main() {
  try {
    let occupied = false;
    try { await fetch(`${base}/api/health`); occupied = true; } catch (_) {}
    assert(!occupied, `Port ${port} is occupied; refusing to reuse it.`);
    server = spawn(python, ['-X', 'utf8', 'run.py', '--no-browser', '--port', String(port), '--data-dir', dataDir], {
      cwd: root, windowsHide: true, stdio: 'ignore',
    });
    await waitFor(async () => {
      try {
        const response = await fetch(`${base}/api/health`), health = await response.json();
        return health.app === 'xiwa-workbench' && path.resolve(health.data_dir) === dataDir;
      } catch { return false; }
    }, 'isolated app health', 30000);
    browser = await chromium.launch({ channel: 'msedge', headless: true });
    context = await browser.newContext({ viewport: { width: 1600, height: 1100 } });
    page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    const initial = await library();
    const imageBlock = initial.scripts.flatMap(script => script.blocks).find(block => block.kind === 'image');
    assert(imageBlock && imageBlock.image_path, 'Seed has a real original illustration for image-cue verification');
    const script = await api('/api/scripts', 'POST', {
      title: '音视频配本编辑测试', category_id: initial.categories[0].id, author: 'QA',
      blocks: [
        { kind: 'text', text: '小明：先听音乐，再开始这一句。', role: '小明', color: '#175C3A' },
        { kind: 'image', text: '', image_path: imageBlock.image_path },
        { kind: 'text', text: '小红：第二个时间点对应这一段。', role: '小红', color: '#9F2F4E' },
      ],
    });
    assert(script.id, 'Create script returns id');
    const id = script.id, blocks = script.blocks;
    const stateBefore = await api('/api/state');
    let cueWrites = 0;
    page.on('request', request => { if (request.method() === 'PUT' && request.url().endsWith(`/api/scripts/${id}/media/cues`)) cueWrites++; });
    await page.goto(`${base}/script/${encodeURIComponent(id)}/media`);
    await page.locator('#media-editor').waitFor();
    assert.equal(await page.locator('#media-player').count(), 0);
    assert(await page.locator('#media-mark-cue').isDisabled());
    assert(await page.locator('#media-control-link').isHidden());
    result.checks.push('无媒体引导与禁用标记');

    await page.locator('#media-upload-file').setInputFiles({ name: '配本音乐.wav', mimeType: 'audio/wav', buffer: wav() });
    await page.locator('#media-upload').click();
    await page.waitForFunction(() => document.querySelector('#media-player')?.duration > 7.9);
    assert.equal(await page.locator('audio#media-player').count(), 1);
    assert.deepEqual((await stored(id)).media.cues, []);
    assert.equal(await page.locator('#media-control-link').getAttribute('href'), `/control?script=${id}&body=media`);
    result.checks.push('真实 WAV 上传、原生播放时长、播控链接');

    await mark(1.25);
    assert.equal(await page.locator('#media-cue-time').inputValue(), '00:01.250');
    await page.locator('#media-cue-label').fill('音乐结束后，小明与图片台词');
    await page.locator(`[data-cue-block="${blocks[0].id}"]`).check();
    await page.locator(`[data-cue-block="${blocks[1].id}"]`).check();
    assert.equal(await page.locator('#media-selected-preview [data-preview-block]').count(), 2);
    assert.equal(await page.locator('#media-selected-preview img').count(), 1);
    assert.deepEqual((await stored(id)).media.cues, []);
    assert.equal(cueWrites, 0, 'Mark/select/edit stay local until Save');
    await save(id, 1);
    let saved = await stored(id);
    assert.equal(saved.media.cues[0].at, 1.25);
    assert.deepEqual(saved.media.cues[0].block_ids, [blocks[0].id, blocks[1].id]);
    assert(Math.abs(saved.media.duration - 8) < .05);
    const firstId = saved.media.cues[0].id;
    result.checks.push('手工时间点、文字与图片多选、保存前不写入、时长保存');

    await page.locator('#media-cue-time').fill('00:02.500');
    await save(id, 1);
    assert.equal((await stored(id)).media.cues[0].at, 2.5);
    await mark(2.5);
    assert.equal(await page.locator('[data-cue-id]').count(), 1, 'Marking existing instant selects existing cue');
    await page.locator(`[data-cue-seek="${firstId}"]`).click();
    await page.waitForFunction(() => !document.querySelector('#media-player').paused);
    await page.locator('#media-player').evaluate(player => player.pause());
    result.checks.push('分秒输入、同一时刻选已有标记、跳转试听');

    await mark(4);
    const secondId = await page.locator('[data-cue-id]').last().getAttribute('data-cue-id');
    await expectInvalidSave(/至少需要选择/);
    assert.equal((await stored(id)).media.cues.length, 1, 'Cue without blocks is never persisted');
    await page.locator(`[data-cue-block="${blocks[2].id}"]`).check();
    await page.locator('#media-cue-time').fill('2.5');
    const writesBeforeInvalid = cueWrites;
    await expectInvalidSave(/相同时间/);
    await page.locator('#media-cue-time').fill('9'); await expectInvalidSave(/超过/);
    await page.locator('#media-cue-time').fill('-1'); await expectInvalidSave(/时间格式/);
    assert.equal(cueWrites, writesBeforeInvalid, 'Invalid timestamps rejected before request');
    await page.locator('#media-cue-time').fill('4.5');
    await save(id, 2);
    assert.equal((await stored(id)).media.cues[1].at, 4.5);
    result.checks.push('无台词、重复、超时长、负数校验；秒数输入');

    await page.locator(`[data-cue-select="${firstId}"]`).click();
    await page.locator('#media-cue-label').fill('尚未保存的修改');
    await page.locator('#media-back').click(); await confirmModal(false);
    assert(page.url().endsWith('/media'));
    await page.locator('#media-reset-cues').click(); await confirmModal(false);
    assert.equal(await page.locator('#media-cue-label').inputValue(), '尚未保存的修改');
    await page.locator('#media-reset-cues').click(); await confirmModal(true);
    await page.waitForFunction(() => document.querySelector('#media-reset-cues').disabled);
    assert.notEqual(await page.locator('#media-cue-label').inputValue(), '尚未保存的修改');
    await page.screenshot({ path: path.join(output, 'media-editor-desktop.png'), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('#media-mark-cue').scrollIntoViewIfNeeded();
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    const markBox = await page.locator('#media-mark-cue').boundingBox();
    assert(markBox.width >= 44 && markBox.height >= 44);
    await page.screenshot({ path: path.join(output, 'media-editor-mobile.png'), fullPage: true });
    await page.locator('#media-cue-label').fill('手机草稿尚未保存');
    assert.notEqual((await stored(id)).media.cues[0].label, '手机草稿尚未保存');
    await page.locator('#media-reset-cues').click(); await confirmModal(true);
    await page.waitForFunction(() => document.querySelector('#media-reset-cues').disabled);
    result.checks.push('离开与放弃提示可取消、手机无横向溢出、大按钮与草稿隔离');

    const retainedMedia = (await stored(id)).media;
    await page.locator('#media-cue-label').fill('上传异常时保留这份草稿');
    await page.locator('#media-upload-file').setInputFiles({ name: '错误文件.txt', mimeType: 'text/plain', buffer: Buffer.from('This is not a media container.') });
    const rejectedUpload = page.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith(`/api/scripts/${id}/media`));
    await page.locator('#media-upload').click(); await confirmModal(true);
    assert((await rejectedUpload).status() >= 400);
    await page.locator('#media-editor-error').waitFor({ state: 'visible' });
    await page.waitForFunction(() => document.querySelector('#media-editor').getAttribute('aria-busy') === 'false');
    assert.equal(await page.locator('#media-cue-label').inputValue(), '上传异常时保留这份草稿');
    assert.deepEqual((await stored(id)).media, retainedMedia);
    assert.equal(await page.locator('audio#media-player').count(), 1);
    assert.match(await page.locator('#media-upload-status').textContent(), /未确认成功/);
    await page.locator('#media-reset-cues').click(); await confirmModal(true);
    await page.waitForFunction(() => document.querySelector('#media-reset-cues').disabled);
    await page.locator('#media-upload-file').setInputFiles([]);
    result.checks.push('上传异常保留原关联、保存的时间点及当前未保存草稿');

    await page.locator(`[data-cue-delete="${secondId}"]`).click();
    assert.equal((await stored(id)).media.cues.length, 2, 'Deletion remains local draft');
    await page.locator(`[data-cue-delete="${firstId}"]`).click();
    await save(id, 0);
    await page.reload();
    assert.equal(await page.locator('[data-cue-id]').count(), 0);
    result.checks.push('删除标记保存后生效、允许保存空列表、重载一致');

    // A genuine local WebM generated in the test browser, with no external files.
    await page.setViewportSize({ width: 1600, height: 1100 });
    const webm = await page.evaluate(async () => {
      const canvas = document.createElement('canvas'); canvas.width = 320; canvas.height = 180;
      const ctx = canvas.getContext('2d'); ctx.fillStyle = '#8e4560'; ctx.fillRect(0, 0, 320, 180);
      const stream = canvas.captureStream(8), chunks = [];
      const recorder = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp8' });
      const done = new Promise(resolve => { recorder.onstop = resolve; });
      recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
      recorder.start();
      for (let n = 0; n < 5; n++) { await new Promise(resolve => setTimeout(resolve, 100)); ctx.fillStyle = n % 2 ? '#8e4560' : '#416853'; ctx.fillRect(0, 0, 320, 180); }
      recorder.stop(); await done; stream.getTracks().forEach(track => track.stop());
      return Array.from(new Uint8Array(await new Blob(chunks, { type: 'video/webm' }).arrayBuffer()));
    });
    await page.locator('#media-upload-file').setInputFiles({ name: '视频配本.webm', mimeType: 'video/webm', buffer: Buffer.from(webm) });
    await page.locator('#media-upload').click(); await confirmModal(false);
    assert.equal((await stored(id)).media.kind, 'audio');
    await page.locator('#media-upload').click(); await confirmModal(true);
    await page.locator('video#media-player').waitFor();
    await page.waitForFunction(() => document.querySelector('#media-player').readyState >= 1);
    assert.equal((await stored(id)).media.kind, 'video');
    assert.deepEqual((await stored(id)).media.cues, []);
    await page.locator('#media-remove').click(); await confirmModal(false);
    assert((await stored(id)).media);
    await page.locator('#media-remove').click(); await confirmModal(true);
    await waitFor(async () => !(await stored(id)).media, 'detach media');
    assert.equal(await page.locator('#media-player').count(), 0);
    result.checks.push('真实 WebM 视频、替换与解除关联确认、替换清空时间点');
    assert.deepEqual((await stored(id)).blocks, blocks, 'Cue editing never alters source text/image blocks');
    assert.equal((await api('/api/state')).revision, stateBefore.revision, 'Cue editing never changes live state');
    assert.deepEqual(errors, []);
    result.checks.push('原正文保真、直播状态不变、浏览器无脚本异常');
    result.ok = true;
  } catch (error) {
    result.error = error.stack || String(error);
    if (page && !page.isClosed()) {
      result.visible_error = await page.locator('#media-editor-error').textContent().catch(() => null);
      await page.screenshot({ path: path.join(output, 'media-editor-failure.png'), fullPage: true }).catch(() => {});
    }
    throw error;
  } finally {
    fs.writeFileSync(path.join(output, 'media-editor-result.json'), JSON.stringify(result, null, 2));
    if (browser) await browser.close();
    if (server) {
      try { execFileSync(python, ['-X', 'utf8', 'tools/stop.py', '--data-dir', dataDir], { cwd: root, windowsHide: true, timeout: 15000, stdio: 'ignore' }); }
      catch { server.kill(); }
    }
  }
}
main().then(() => console.log(JSON.stringify(result))).catch(error => { console.error(error); process.exitCode = 1; });
