'use strict';

// Manual body-image regression. All writes belong to a fresh QA instance on
// 8924. Image uploads are initiated by real UI clicks/filechooser events.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const {spawn, execFileSync} = require('node:child_process');
const {chromium} = require('playwright');
const root = path.resolve(__dirname, '..');
const python = path.join(root, 'runtime', 'python.exe');
const dataDir = path.join(root, '.qa', `script-images-${Date.now()}`);
const output = path.join(root, '.qa', 'browser');
const base = 'http://127.0.0.1:8924';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const result = {passed: false, base, data_dir: dataDir, checks: [], uploads: [], screenshots: [], page_errors: [], console_errors: [], http_errors: [], blocked_external: []};
let server, browser, context, page, releaseDelayed;
fs.mkdirSync(output, {recursive: true});

// Small valid RGB PNGs with distinct dimensions/pixels, without external files.
function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function png(width, height, color) {
  function chunk(type, data) {
    const name = Buffer.from(type), length = Buffer.alloc(4), crc = Buffer.alloc(4);
    length.writeUInt32BE(data.length); crc.writeUInt32BE(crc32(Buffer.concat([name, data])));
    return Buffer.concat([length, name, data, crc]);
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    const offset = y * (width * 3 + 1); raw[offset] = 0;
    for (let x = 0; x < width; x++) for (let c = 0; c < 3; c++) raw[offset + 1 + x * 3 + c] = Math.max(0, Math.min(255, color[c] + (((x >> 5) + (y >> 5)) % 2 ? 18 : -18)));
  }
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const imageA = {name: '追加风景.png', mimeType: 'image/png', buffer: png(720, 480, [92, 139, 111])};
const imageB = {name: '插入图.png', mimeType: 'image/png', buffer: png(680, 440, [183, 117, 87])};
const imageC = {name: '替换竖图.png', mimeType: 'image/png', buffer: png(480, 900, [92, 114, 165])};
const invalidImage = {name: '损坏图片.png', mimeType: 'image/png', buffer: Buffer.from('This is not a decodable image.')};

async function until(check, label, timeout = 15000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await check()) return; await delay(80); }
  throw new Error('Timed out: ' + label);
}
async function get(endpoint) {
  const response = await context.request.get(base + endpoint);
  assert(response.ok(), `GET ${endpoint}: ${response.status()}`);
  return response.json();
}
const library = () => get('/api/library');
const state = () => get('/api/state');
const draft = () => page.evaluate(() => window.wbEditor.getDraft());
const row = id => page.locator(`.body-editor-row[data-block-id="${id}"]`);
const ids = blocks => blocks.map(block => block.id);
async function stored(id) { return (await library()).scripts.find(script => script.id === id); }
async function openDetails() { await page.locator('#body-editor-details').evaluate(element => { element.open = true; }); }
async function newDraft(title) {
  await page.locator('#new-script').click();
  await page.locator('#script-dialog').waitFor({state: 'visible'});
  if (await page.locator('#editor-recovery').isVisible()) {
    await page.locator('#editor-discard').click();
    await page.locator('#confirm-yes').click();
    await page.locator('#editor-recovery').waitFor({state: 'hidden'});
  }
  await page.locator('#edit-title').fill(title);
  await openDetails();
}
async function addText(text) {
  await page.locator('#add-block').click();
  await page.locator('#body-editor textarea').last().fill(text);
  return (await draft()).blocks.at(-1).id;
}
async function selectFile(selector, file) {
  const pending = page.waitForEvent('filechooser');
  await page.locator(selector).click();
  const chooser = await pending;
  await chooser.setFiles(file);
}
async function upload(selector, file, expected = 201) {
  const pending = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/script-images');
  await selectFile(selector, file);
  const response = await pending, body = await response.json();
  result.uploads.push({file: file.name, status: response.status(), ...body});
  assert.equal(response.status(), expected, JSON.stringify(body));
  if (response.ok()) {
    assert(body.path && body.width > 0 && body.height > 0 && body.size > 0);
    await until(async () => (await draft()).blocks.some(block => block.image_path === body.path), 'uploaded image joins current draft');
    await until(async () => await page.locator('#body-editor img').evaluateAll(images => images.every(image => image.complete && image.naturalWidth > 0)), 'editor image decode');
  } else {
    await until(async () => (await page.locator('#script-image-status').textContent()).trim().length > 0, 'invalid image status');
  }
  return body;
}
async function closeDraft() {
  await page.locator('#script-dialog [data-close="script-dialog"]').first().click();
  if (await page.locator('#confirm-dialog').isVisible()) await page.locator('#confirm-yes').click();
  await page.locator('#script-dialog').waitFor({state: 'hidden'});
}
async function saveDraft(id) {
  const endpoint = '/api/scripts' + (id ? '/' + id : '');
  const pending = page.waitForResponse(response => new URL(response.url()).pathname === endpoint && response.request().method() === (id ? 'PATCH' : 'POST'));
  await page.locator('#script-form button[type="submit"]').click();
  const response = await pending;
  assert(response.ok(), await response.text());
  const script = await response.json();
  await page.locator('#script-dialog').waitFor({state: 'hidden'});
  await until(async () => Boolean((await library()).scripts.find(item => item.id === script.id)), 'saved script in library');
  return script;
}
async function screenshot(name, locator) {
  const filename = path.join(output, name + '.png');
  await (locator || page).screenshot({path: filename, ...(locator ? {} : {fullPage: true})});
  result.screenshots.push(filename);
}
async function previewReady() {
  await page.waitForFunction(() => document.querySelector('#apply-display') && !document.querySelector('#apply-display').disabled);
  const frame = page.frames().find(item => item.url().includes('preview=1'));
  assert(frame); await frame.locator('.stage-page.is-current').waitFor();
  return frame;
}

async function main() {
  try {
    let occupied = false;
    try { await fetch(base + '/api/health'); occupied = true; } catch (_) {}
    assert(!occupied, '8924 is occupied; refusing to reuse any existing server.');
    server = spawn(python, ['-X', 'utf8', 'run.py', '--no-browser', '--port', '8924', '--data-dir', dataDir], {cwd: root, windowsHide: true, stdio: 'ignore'});
    await until(async () => { try { return path.resolve((await (await fetch(base + '/api/health')).json()).data_dir) === dataDir; } catch (_) { return false; } }, 'isolated server', 30000);
    browser = await chromium.launch({channel: 'msedge', headless: true});
    context = await browser.newContext({viewport: {width: 1500, height: 1050}, serviceWorkers: 'block'});
    await context.addInitScript(() => { if (location.origin === 'http://127.0.0.1:8924') localStorage.setItem('wb-preview-preferences', JSON.stringify({placement: 'outside', feedback: 'confirm'})); });
    await context.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.protocol.startsWith('http') && url.origin !== base) { result.blocked_external.push(url.href); return route.abort('blockedbyclient'); }
      return route.continue();
    });
    context.on('page', item => { item.on('pageerror', error => result.page_errors.push(error.message)); item.on('console', message => { if (message.type() === 'error') result.console_errors.push(message.text()); }); });
    context.on('response', response => { if (response.status() >= 400) result.http_errors.push({status: response.status(), url: response.url()}); });
    page = await context.newPage();
    const original = await library(), originalState = await state();
    page.on('dialog', dialog => dialog.dismiss());
    await page.goto(base + '/manage');
    await newDraft('手动图片浏览器验收');
    const textA = '甲：新增图片必须与文字保持顺序。春风经过，我们继续核对完整的台词。\n'.repeat(24);
    const textB = '乙：最后一段仍保留原文，图片只是正文中的独立段落。';
    const a = await addText(textA);
    const firstUpload = await upload('#add-image-block', imageA);
    const firstImage = (await draft()).blocks.find(block => block.image_path === firstUpload.path).id;
    const b = await addText(textB);
    assert.deepEqual(ids((await draft()).blocks), [a, firstImage, b]);
    const insertedUpload = await upload(`[data-add-image-after="${a}"]`, imageB);
    const insertedImage = (await draft()).blocks.find(block => block.image_path === insertedUpload.path).id;
    assert.deepEqual(ids((await draft()).blocks), [a, insertedImage, firstImage, b]);
    const replaceUpload = await upload(`[data-replace-image="${firstImage}"]`, imageC);
    assert.notEqual(replaceUpload.path, firstUpload.path);
    assert.deepEqual(ids((await draft()).blocks), [a, insertedImage, firstImage, b]);
    assert.equal((await draft()).blocks.find(block => block.id === firstImage).image_path, replaceUpload.path);
    await page.locator(`[data-block-move="${firstImage}"][data-delta="-1"]`).click();
    assert.deepEqual(ids((await draft()).blocks), [a, firstImage, insertedImage, b]);
    await page.locator(`[data-block-move="${firstImage}"][data-delta="1"]`).click();
    assert.deepEqual(ids((await draft()).blocks), [a, insertedImage, firstImage, b]);
    assert.deepEqual(await page.locator('.body-editor-row').evaluateAll(rows => rows.map(row => Number(row.dataset.blockIndex))), [0, 1, 2, 3]);
    result.checks.push('Real filechooser append/insert uploads preserve text and order; replace preserves block ID; both move directions work');

    await page.locator(`[data-preview-script-image="${firstImage}"]`).click();
    await page.locator('#script-image-preview-dialog').waitFor({state: 'visible'});
    await page.waitForFunction(() => { const image = document.querySelector('#script-image-preview-dialog img'); return image?.complete && image.naturalWidth > 0; });
    const largeImage = await page.locator('#script-image-preview-dialog img').evaluate(image => ({width: image.naturalWidth, height: image.naturalHeight}));
    assert.deepEqual(largeImage, {width: 480, height: 900});
    await page.keyboard.press('Escape'); await page.locator('#script-image-preview-dialog').waitFor({state: 'hidden'});
    const beforeInvalid = await draft();
    const failure = await upload('#add-image-block', invalidImage, 400);
    assert.equal(failure.code, 'invalid_image');
    assert.deepEqual(await draft(), beforeInvalid, 'Invalid upload retains every existing draft block and value');
    assert.deepEqual((await library()).scripts, original.scripts, 'Upload alone never saves script data');
    assert.deepEqual(await state(), originalState, 'Draft image editing does not publish');
    result.checks.push('Full-size image dialog decodes; corrupt PNG is rejected without losing the draft or changing the library/live state');
    await screenshot('script-images-editor', page.locator('#script-dialog'));

    const saved = await saveDraft();
    result.script_id = saved.id;
    assert.deepEqual(ids(saved.blocks), [a, insertedImage, firstImage, b]);
    assert.equal(saved.blocks[0].text, textA); assert.equal(saved.blocks[3].text, textB);
    assert.equal(saved.blocks[1].image_path, insertedUpload.path); assert.equal(saved.blocks[2].image_path, replaceUpload.path);
    result.checks.push('Explicit Save persists exactly the checked mixed text/image order');

    await page.locator(`[data-edit-script="${saved.id}"]`).click(); await openDetails();
    await row(a).locator('textarea').fill('这项修改会被取消。');
    await upload(`[data-replace-image="${firstImage}"]`, imageA);
    await closeDraft();
    assert.deepEqual(await stored(saved.id), saved, 'Cancel never alters the stored script');
    result.checks.push('Cancel preserves the formal script byte-for-byte; unsaved changes are protected separately as a local draft');

    // Hold an actual upload response after the server has accepted the image.
    // Closing the first editor and opening another must invalidate its callback.
    await newDraft('旧会话上传不可串入新本'); await addText('旧会话正文。');
    let delayedCaptured = false;
    const delayedGate = new Promise(resolve => { releaseDelayed = resolve; });
    const uploadPattern = base + '/api/script-images';
    await page.route(uploadPattern, async route => {
      const response = await route.fetch(); delayedCaptured = true;
      await delayedGate;
      try { await route.fulfill({response}); } catch (_) { /* Closing a browser cancels pending routes during cleanup. */ }
    }, {times: 1});
    await selectFile('#add-image-block', imageB);
    await until(() => delayedCaptured, 'upload response held');
    assert(await page.locator('#script-dialog [data-close="script-dialog"]').first().isDisabled(), 'Normal closing is locked during image upload');
    // A nonstandard/programmatic close still must not leak its late response.
    await page.locator('#script-dialog').evaluate(dialog => dialog.close());
    await newDraft('新会话只保留自己的正文'); await addText('新会话不能收到之前的图片。');
    const newSession = await draft();
    releaseDelayed(); releaseDelayed = null;
    await page.unroute(uploadPattern);
    await delay(250);
    assert.deepEqual(await draft(), newSession, 'Late upload response is ignored after editor session changed');
    await upload('#add-image-block', imageA);
    assert.equal((await draft()).blocks.filter(block => block.kind === 'image').length, 1, 'A new session can still upload its own image');
    await closeDraft();
    assert.deepEqual(await stored(saved.id), saved); assert.equal((await library()).scripts.length, original.scripts.length + 1);
    result.checks.push('Delayed upload cannot leak into a new editor session; new-session upload still works and can be canceled');

    await page.goto(base + '/script/' + saved.id);
    await until(async () => await page.locator('#reader-body img').evaluateAll(images => images.length === 2 && images.every(image => image.complete && image.naturalWidth > 0)), 'reader images loaded');
    assert.deepEqual(await page.locator('#reader-body img').evaluateAll(images => images.map(image => new URL(image.src).pathname)), [insertedUpload.path, replaceUpload.path]);
    await screenshot('script-images-reader');
    result.checks.push('Reader displays both uploaded image assets in saved order');

    await page.goto(base + '/control?script=' + saved.id + '&body=pages');
    let frame = await previewReady();
    const pageAudit = await frame.evaluate(() => {
      const pages = [...document.querySelectorAll('.stage-page')], images = [], overflow = [], texts = {};
      for (const page of pages) {
        const hidden = page.hidden; page.hidden = false;
        const body = page.querySelector('.stage-page-body');
        if (body.scrollHeight > body.clientHeight + 1) overflow.push(Number(page.dataset.pageIndex));
        for (const block of page.querySelectorAll('[data-anchor]')) {
          const text = block.querySelector('.block-text'); if (text) (texts[block.dataset.anchor] ??= []).push(text.textContent);
          for (const image of block.querySelectorAll('img')) images.push({anchor: block.dataset.anchor, path: new URL(image.src).pathname, loaded: image.complete && image.naturalWidth > 0, page: Number(page.dataset.pageIndex)});
        }
        page.hidden = hidden;
      }
      return {count: pages.length, images, overflow, texts};
    });
    assert(pageAudit.count > 1); assert.deepEqual(pageAudit.overflow, []);
    assert.deepEqual(pageAudit.images.map(image => image.path), [insertedUpload.path, replaceUpload.path]);
    assert(pageAudit.images.every(image => image.loaded));
    assert.equal(pageAudit.texts[a].join(''), textA); assert.equal(pageAudit.texts[b].join(''), textB);
    const targetPage = pageAudit.images[1].page;
    for (let i = 0; i < targetPage; i++) {
      await page.locator('[data-preview-external="next-page"]').click();
      await frame.waitForFunction(expected => Number(document.querySelector('.stage-page.is-current').dataset.pageIndex) === expected, i + 1);
    }
    await screenshot('script-images-pagination', page.locator('.preview-panel'));
    result.pagination = pageAudit;
    result.checks.push('Measured body pagination retains every character and each image once; image page can be reached without overflow');

    await page.setViewportSize({width: 390, height: 844});
    await page.goto(base + '/manage'); await page.locator(`[data-edit-script="${saved.id}"]`).click(); await openDetails();
    await row(firstImage).scrollIntoViewIfNeeded();
    const mobile = await page.evaluate(() => {
      const dialog = document.querySelector('#script-dialog'), rect = dialog.getBoundingClientRect();
      return {viewport: innerWidth, document_width: document.documentElement.scrollWidth,
              dialog_left: rect.left, dialog_right: rect.right, dialog_width: dialog.clientWidth, dialog_scroll_width: dialog.scrollWidth};
    });
    assert(mobile.document_width <= mobile.viewport + 1, JSON.stringify(mobile));
    assert(mobile.dialog_left >= -1 && mobile.dialog_right <= mobile.viewport + 1, JSON.stringify(mobile));
    assert(mobile.dialog_scroll_width <= mobile.dialog_width + 1, JSON.stringify(mobile));
    await screenshot('script-images-mobile', page.locator('#script-dialog'));
    await page.locator(`[data-preview-script-image="${firstImage}"]`).click();
    await page.locator('#script-image-preview-dialog').waitFor({state: 'visible'});
    const imageDialogBounds = await page.locator('#script-image-preview-dialog').boundingBox();
    assert(imageDialogBounds.x >= -1 && imageDialogBounds.x + imageDialogBounds.width <= 391);
    await page.keyboard.press('Escape'); await closeDraft();
    result.mobile = mobile;
    result.checks.push('390px editor, image actions and large-image dialog stay within the viewport');

    const final = await library();
    assert.deepEqual(final.scripts.filter(script => script.id !== saved.id), original.scripts, 'Existing seed scripts unchanged');
    const categoryFields = categories => categories.map(({script_count, visible_count, ...fields}) => fields);
    assert.deepEqual(categoryFields(final.categories), categoryFields(original.categories), 'Image upload does not change category fields');
    for (const category of final.categories) {
      const before = original.categories.find(item => item.id === category.id);
      const added = category.id === saved.category_id ? 1 : 0;
      assert.equal(category.script_count, before.script_count + added);
      assert.equal(category.visible_count, before.visible_count + added);
    }
    assert.deepEqual(await state(), originalState, 'Reader/preview/drafts do not alter live state');
    assert.deepEqual(result.page_errors, []); assert.deepEqual(result.blocked_external, []);
    assert(result.http_errors.every(error => error.status === 400 && error.url === uploadPattern), JSON.stringify(result.http_errors));
    assert(result.console_errors.every(error => /400/.test(error)), JSON.stringify(result.console_errors));
    result.passed = true;
  } catch (error) {
    result.error = error.stack || String(error);
    if (page && !page.isClosed()) await page.screenshot({path: path.join(output, 'script-images-failure.png'), fullPage: true}).catch(() => {});
    throw error;
  } finally {
    if (releaseDelayed) releaseDelayed();
    if (browser) await browser.close();
    if (server) {
      try {
        const stopped = execFileSync(python, ['-X', 'utf8', 'tools/stop.py', '--data-dir', dataDir], {cwd: root, windowsHide: true, encoding: 'utf8', timeout: 20000});
        result.stop = stopped.trim();
      } catch (error) {
        result.stop_error = String(error); result.passed = false;
        if (server.exitCode === null) server.kill(); // Only our own child process.
      }
    }
    result.finished_at = new Date().toISOString();
    fs.writeFileSync(path.join(output, 'script-images-result.json'), JSON.stringify(result, null, 2));
  }
}
main().then(() => console.log(JSON.stringify({passed: result.passed, checks: result.checks, data_dir: dataDir}))).catch(error => {console.error(error); process.exitCode = 1;});
