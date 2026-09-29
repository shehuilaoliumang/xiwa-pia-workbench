'use strict';

// Real Electron windows, no visibility mocks and no rAF throttling overrides.
// This checks renderer/application behavior, not Douyin's window-capture output.
const {_electron: electron} = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {createHash} = require('node:crypto');
const {spawn, execFileSync} = require('node:child_process');
const root = path.resolve(__dirname, '..');
const python = process.env.PIA_TEST_PYTHON || path.join(root, 'runtime', 'python.exe');
const executablePath = process.env.PIA_ELECTRON_PATH || process.env.ELECTRON_PATH || path.join(root, 'desktop', 'runtime', 'electron.exe');
const base = 'http://127.0.0.1:8935';
const dataDir = path.join(root, '.qa', 'desktop-display-' + Date.now());
const output = path.join(root, '.qa', 'desktop');
const result = {passed: false, base, data_dir: dataDir, executable_path: executablePath,
  checks: [], page_errors: [], console_errors: [], http_errors: [], requests_failed: [], external_requests: [],
  writes: [], captures: [], scroll_samples: [], scope: 'Actual Electron BrowserWindow minimize/restore and renderer rAF/DOM; capturePage evidence is separate and does not validate Douyin capture.'};
let server, secondary, app, electronProcess, controller, display, context, closing = false, serviceStopped = false, desktopExited = false;
const responseReads = [];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
fs.mkdirSync(output, {recursive: true});

async function until(check, label, timeout = 16000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await check()) return; await delay(90); }
  throw new Error('Timed out: ' + label);
}
async function api(endpoint, body, method = 'POST') {
  const headers = {'Content-Type': 'application/json'};
  if (body !== undefined) headers['X-CSRF-Token'] = (await api('/api/library', undefined, 'GET')).csrf_token;
  const response = await fetch(base + endpoint, {method, headers, ...(body === undefined ? {} : {body: JSON.stringify(body)})});
  const data = await response.json(); assert(response.ok, endpoint + ': ' + JSON.stringify(data)); return data;
}
const state = () => api('/api/state', undefined, 'GET');
async function apply(payload, position = {}) {
  const preview = await api('/api/preview', payload);
  return api('/api/apply', {...payload, preview_token: preview.content_token, ...position});
}
const nativeState = () => app.evaluate(() => globalThis.__piaDesktopDiagnostics.getState());
const connectCount = () => result.writes.filter(request => request.path === '/api/display/connect').length;
const currentPage = target => target.locator('.stage-page.is-current').getAttribute('data-page-index').then(Number);
const scrollTop = target => target.locator('#stage-scroll').evaluate(element => element.scrollTop);
const ready = () => controller.waitForFunction(() => !document.querySelector('#apply-display').disabled);
const ext = action => controller.locator(`[data-preview-external="${action}"]`);
async function minimize() {
  await app.evaluate(() => globalThis.__piaDesktopDiagnostics.minimizeDisplay());
  await until(async () => (await nativeState()).display?.minimized === true, 'native display minimized');
}
async function restore() {
  await controller.evaluate(() => window.piaDesktop.restoreDisplay());
  await until(async () => (await nativeState()).display?.minimized === false, 'native display restored');
}
async function rafSample() {
  return display.evaluate(() => ({count: window.__desktopRafProbe.count,
    last_at: window.__desktopRafProbe.last_at, sampled_at: performance.now(), hidden: document.hidden,
    visibility: document.visibilityState, scroll_top: document.querySelector('#stage-scroll').scrollTop}));
}
async function capture(name) {
  const item = await app.evaluate(() => globalThis.__piaDesktopDiagnostics.captureDisplay());
  const bytes = Buffer.from(item.png_base64, 'base64');
  assert.equal(createHash('sha256').update(bytes).digest('hex'), item.sha256);
  assert(item.width > 0 && item.height > 0 && bytes.length > 100);
  const file = path.join(output, name + '.png'); fs.writeFileSync(file, bytes);
  const {png_base64, ...metadata} = item; result.captures.push({...metadata, file}); return item;
}
function observePage(page) {
  page.on('pageerror', error => result.page_errors.push({url: page.url(), message: error.message}));
  page.on('console', message => { if (message.type() === 'error') result.console_errors.push({url: page.url(), message: message.text()}); });
}

async function main() {
  try {
    assert(fs.existsSync(executablePath), 'Electron runtime missing; set PIA_ELECTRON_PATH to the verified electron.exe.');
    let occupied = false; try { await fetch(base + '/api/health'); occupied = true; } catch (_) {}
    assert(!occupied, '8935 is occupied; refusing to reuse another instance.');
    server = spawn(python, ['-X', 'utf8', 'run.py', '--no-browser', '--port', '8935', '--data-dir', dataDir],
      {cwd: root, windowsHide: true, stdio: 'ignore', env: {...process.env, PYTHONUTF8: '1'}});
    await until(async () => { try { const health = await (await fetch(base + '/api/health')).json(); return path.resolve(health.data_dir) === dataDir; } catch (_) { return false; } }, 'isolated Python service', 30000);
    const category = await api('/api/categories', {name: '桌面最小化验收分类', description: '独立测试资料', color: '#825c40'});
    const fixture = await api('/api/scripts', {title: '桌面持续展示验收', category_id: category.id, author: '测试资料', synopsis: '检查后台滚动、分页和悬停同步。',
      blocks: Array.from({length: 54}, (_, i) => ({kind: 'text', role: i % 2 ? '乙' : '甲', text: `第${i + 1}段：窗口最小化后，预览与展示仍应保持同一段内容。` + '远处传来熟悉的声音，故事继续向前。'.repeat(5)}))});
    await api('/api/scripts', {title: '桌面目录短篇', category_id: category.id, synopsis: '用于目录层级和摘要验收。', blocks: [{kind: 'text', text: '短篇正文。'}]});
    const env = {...process.env}; delete env.ELECTRON_RUN_AS_NODE;
    app = await electron.launch({executablePath, args: [path.join(root, 'desktop', 'main.cjs'), '--url=' + base + '/', '--data-dir=' + dataDir, '--diagnostics'], cwd: root, env, timeout: 30000});
    electronProcess = app.process();
    result.main_process = await app.evaluate(({app, BrowserWindow}) => ({
      argv: process.argv, versions: process.versions, type: process.type, app_path: app.getAppPath(),
      main_module: process.mainModule?.filename || null,
      require_main: typeof require === 'function' ? require.main?.filename || null : null,
      diagnostics: Boolean(globalThis.__piaDesktopDiagnostics), windows: BrowserWindow.getAllWindows().length,
      background_switches: Object.fromEntries(['disable-background-timer-throttling', 'disable-backgrounding-occluded-windows', 'disable-renderer-backgrounding'].map(flag => [flag, app.commandLine.hasSwitch(flag)]))
    }));
    assert(Object.values(result.main_process.background_switches).every(value => value === false), 'QA must not enable tool-supplied background throttle bypass flags');
    result.process_output = [];
    for (const stream of ['stdout', 'stderr']) electronProcess[stream]?.on('data', chunk => {
      result.process_output.push({stream, text: String(chunk).slice(0, 6000)});
      if (result.process_output.length > 60) result.process_output.shift();
    });
    context = app.context();
    for (const page of app.windows()) observePage(page);
    context.on('page', observePage);
    context.on('request', request => {
      const url = new URL(request.url());
      if (/^https?:$/.test(url.protocol) && url.origin !== base) result.external_requests.push(request.url());
      if (request.method() !== 'GET') result.writes.push({method: request.method(), path: url.pathname, at: Date.now()});
    });
    context.on('requestfailed', request => { if (!closing) result.requests_failed.push({url: request.url(), error: request.failure()?.errorText}); });
    context.on('response', response => {
      if (response.status() < 400) return;
      const item = {url: response.url(), status: response.status()}; result.http_errors.push(item);
      responseReads.push(response.json().then(body => {item.code = body.code;}).catch(() => {}));
    });
    controller = await app.firstWindow();
    await controller.waitForURL(base + '/control');
    assert(await controller.evaluate(() => window.piaDesktop?.isDesktop));
    result.renderer_user_agent = await controller.evaluate(() => navigator.userAgent);
    assert(/^[\x20-\x7e]+$/.test(result.renderer_user_agent), 'Electron renderer User-Agent must be ASCII');
    await controller.evaluate(() => localStorage.setItem('pia-preview-preferences', JSON.stringify({placement: 'outside', feedback: 'confirm'})));
    await controller.goto(base + '/control?script=' + fixture.id); await ready();
    const frame = controller.frames().find(item => item.url().includes('/display?preview=1')); assert(frame);
    await controller.locator('#preview-toolbar-placement').selectOption('outside');
    await controller.locator('#layout-body-mode').selectOption('pages'); await ready();
    await controller.locator('#apply-display').click();
    await until(async () => (await state()).snapshot?.scripts?.[0]?.id === fixture.id, 'first applied page');
    await controller.evaluate(() => window.piaDesktop.openDisplay());
    await until(() => Boolean(app.windows().find(page => page.url() === base + '/display')), 'native audience window');
    display = app.windows().find(page => page.url() === base + '/display');
    await display.locator('.stage-page.is-current').waitFor();
    await until(() => connectCount() === 1, 'one display connection');
    await display.evaluate(() => {
      window.__desktopRafProbe = {count: 0, last_at: 0};
      function tick(timestamp) { window.__desktopRafProbe.count++; window.__desktopRafProbe.last_at = timestamp; requestAnimationFrame(tick); }
      requestAnimationFrame(tick);
    });
    const initialNative = await nativeState(); result.initial_native = initialNative;
    assert.equal(initialNative.main.background_throttling, false);
    assert.equal(initialNative.display.background_throttling, false);
    assert.equal(initialNative.display.paint.monitoring, false);
    const originalDisplayId = initialNative.display.web_contents_id;
    let before = await rafSample(); await delay(750); let after = await rafSample();
    assert(after.count > before.count + 5, 'visible display rAF must be running');
    result.visible_raf = {before, after};

    // No capturePage, screenshot or beginFrameSubscription calls in this block.
    const noCaptureStarted = Date.now(); await minimize();
    before = await rafSample(); await delay(1600); after = await rafSample();
    assert(after.count > before.count + 5, 'real minimized display must continue native rAF without capture assistance');
    assert((await nativeState()).display.minimized);
    result.minimized_raf_without_capture = {before, after};
    await until(async () => await controller.locator('#display-health').getAttribute('data-state') === 'minimized', 'desktop health distinguishes actual minimized window');
    result.minimized_health = await controller.locator('#display-health').innerText();
    await controller.locator('#preview-feedback-mode').selectOption('realtime'); await ready();
    await until(async () => (await state()).snapshot?.layout.body_mode === 'pages', 'realtime pages');
    await ext('next-page').click();
    await until(async () => await currentPage(frame) === 1 && await currentPage(display) === 1 && (await state()).page_index === 1, 'minimized realtime next page');
    await controller.locator('.preview-panel').scrollIntoViewIfNeeded();
    const paragraph = frame.locator('.stage-page.is-current [data-anchor]').first();
    const bodyAnchor = await paragraph.getAttribute('data-anchor'); await paragraph.hover();
    await until(async () => await display.locator(`.stage-page.is-current [data-anchor="${bodyAnchor}"].content-hover`).count() > 0, 'minimized body hover motion');
    await ext('return-list').click(); await frame.locator('.stage-list').waitFor(); await ready();
    await frame.locator(`[data-preview-script="${fixture.id}"]`).hover();
    await until(async () => await display.locator(`[data-anchor="script:${fixture.id}"].content-hover`).count() === 1, 'minimized script-card hover motion');
    await ext('return-list').click(); await frame.locator('[data-preview-category]').first().waitFor(); await ready();
    await controller.locator('#layout-category-columns').selectOption('1'); await ready();
    await frame.locator(`[data-preview-category="${category.id}"]`).hover();
    await until(async () => await display.locator(`[data-anchor="category:${category.id}"].content-hover`).count() === 1 && await display.locator('#stage-category-peek').isVisible(), 'minimized category hover and summary motion');
    await frame.locator(`[data-preview-category="${category.id}"]`).click(); await frame.locator('.stage-list').waitFor(); await ready();
    await frame.locator(`[data-preview-script="${fixture.id}"]`).click(); await frame.locator('.stage-body').waitFor(); await ready();
    await controller.locator('#layout-body-mode').selectOption('scroll'); await ready();
    await until(async () => (await state()).snapshot?.layout.body_mode === 'scroll' && await display.locator('.stage-body').count() === 1 && await display.locator('.stage-page').count() === 0, 'minimized body changes to scrolling');
    await controller.locator('#layout-speed').fill('100'); await controller.locator('#layout-speed').dispatchEvent('input'); await controller.locator('#layout-speed').dispatchEvent('change'); await ready();
    await ext('top').click(); await ready(); await ext('play').click();
    await until(async () => (await state()).playing && await scrollTop(frame) > 20, 'preview playing while audience minimized');
    for (let i = 0; i < 15; i++) {
      const [preview, audience] = await Promise.all([scrollTop(frame), scrollTop(display)]);
      result.scroll_samples.push({at: Date.now(), preview, audience, difference: Math.abs(preview - audience)}); await delay(90);
    }
    assert(result.scroll_samples.at(-1).audience - result.scroll_samples[0].audience > 25, 'minimized live motion must advance');
    const maxDrift = Math.max(...result.scroll_samples.map(item => item.difference));
    assert(maxDrift < 40, 'minimized continuous motion drift: ' + maxDrift);
    await ext('play').click(); await until(async () => !(await state()).playing, 'minimized pause'); await delay(400);
    const pausedPosition = await scrollTop(display); await delay(450);
    assert(Math.abs(await scrollTop(display) - pausedPosition) <= 2, 'minimized paused display must stay still');
    await controller.locator('#layout-body-mode').selectOption('pages'); await ready();
    await until(async () => await display.locator('.stage-page.is-current').count() === 1, 'minimized returns to pages');
    await ext('top').click(); await ready(); await ext('next-page').click();
    await until(async () => await currentPage(frame) === 1 && await currentPage(display) === 1, 'page before restore');
    const savedPageText = await display.locator('.stage-page.is-current').textContent();
    result.no_capture_period = {started_at: noCaptureStarted, ended_at: Date.now(), capture_calls: result.captures.length,
      paint: (await nativeState()).display.paint, max_logical_scroll_drift: maxDrift};
    assert.equal(result.captures.length, 0); assert.equal(result.no_capture_period.paint.monitoring, false);
    assert((await nativeState()).display.minimized, 'all no-capture synchronization checks must remain genuinely minimized');
    result.checks.push('Visible and actually minimized rAF runs without capture assistance; BC page, three hover types, directory changes, continuous scroll and pause remain synchronized');

    const pausedState = await state(); await restore(); await delay(800);
    assert.equal((await nativeState()).display.web_contents_id, originalDisplayId);
    assert.equal(connectCount(), 1); assert.equal(await currentPage(display), 1);
    assert.equal(await display.locator('.stage-page.is-current').textContent(), savedPageText);
    assert.equal((await state()).playing, pausedState.playing);
    result.checks.push('Restore reuses the same native display and connection without resetting exact page/text or play state');

    // Separate capture-interface evidence: it is allowed to influence painting.
    await minimize(); const firstCapture = await capture('desktop-minimized-page-2');
    await ext('next-page').click(); await until(async () => await currentPage(display) === 2, 'next page before minimized capture');
    let secondCapture = await capture('desktop-minimized-page-3');
    const paintDeadline = Date.now() + 1800;
    let paintAttempt = 0;
    while (firstCapture.sha256 === secondCapture.sha256 && Date.now() < paintDeadline) {
      assert((await nativeState()).display.minimized, 'capture retry must never restore the native window');
      await delay(250); secondCapture = await capture('desktop-minimized-page-3-retry-' + (++paintAttempt));
    }
    assert(firstCapture.minimized && secondCapture.minimized && (await nativeState()).display.minimized);
    result.minimized_capture = {changed: firstCapture.sha256 !== secondCapture.sha256, retries: paintAttempt,
      first_sha256: firstCapture.sha256, final_sha256: secondCapture.sha256, current_dom_page: await currentPage(display)};
    if (result.minimized_capture.changed) result.checks.push('Separate capturePage calls reflect changed minimized content without restoring the window; no claim about live capture output');
    else result.capture_failure = 'DOM page changed but minimized capturePage still returned the old pixels after bounded retries; later functional checks continue, overall result remains failed.';

    // Cover the real native display with an opaque test-owned foreground window.
    // Geometry demonstrates coverage; this does not prove a DWM occlusion classification.
    await restore();
    await controller.locator('#preview-feedback-mode').selectOption('confirm');
    await apply({mode: 'script', script_id: fixture.id, orientation: 'portrait', layout: {body_mode: 'scroll', font_size: 40, line_height: 1.8, padding: 72, speed: 100}}, {preview_anchor: null});
    await until(async () => await display.locator('.stage-page').count() === 0 && await display.locator('.stage-body').count() === 1, 'covered test scroll layout');
    await api('/api/command', {action: 'speed', speed: 100}); await api('/api/command', {action: 'play'});
    await until(async () => await scrollTop(display) > 10, 'autonomous scroll before cover');
    const cover = await app.evaluate(async ({BrowserWindow}) => {
      const state = globalThis.__piaDesktopDiagnostics.getState();
      const window = new BrowserWindow({...state.display.bounds, frame: false, show: false, alwaysOnTop: true, skipTaskbar: true,
        backgroundColor: '#26332b', webPreferences: {sandbox: true, contextIsolation: true, nodeIntegration: false}});
      globalThis.__desktopQaCover = window;
      await window.loadURL('data:text/html;charset=utf-8,<body style="margin:0;background:%2326332b;color:white;font:24px sans-serif;padding:32px">桌面展示遮挡验收</body>');
      window.show(); window.setAlwaysOnTop(true); window.moveTop(); window.focus();
      await new Promise(resolve => setTimeout(resolve, 250));
      return {bounds: window.getBounds(), visible: window.isVisible(), focused: window.isFocused(), always_on_top: window.isAlwaysOnTop(), display_always_on_top: BrowserWindow.fromId(state.display.id).isAlwaysOnTop(), display: state.display.bounds};
    });
    result.cover_setup = cover;
    assert(cover.visible && cover.focused && !cover.display_always_on_top, JSON.stringify(cover)); assert.deepEqual(cover.bounds, cover.display);
    before = await rafSample(); await delay(1350); after = await rafSample();
    assert(after.count > before.count + 5 && after.scroll_top > before.scroll_top + 25, 'covered renderer must continue rAF and autonomous scroll');
    result.covered = {native_cover: cover, before, after, caveat: 'Opaque native window covers display bounds; OS compositor occlusion classification was not queried.'};
    await api('/api/command', {action: 'pause'});
    await app.evaluate(() => { globalThis.__desktopQaCover?.destroy(); delete globalThis.__desktopQaCover; });
    result.checks.push('A test-owned opaque foreground native window covers display bounds while rAF and autonomous scrolling continue');

    // Generate a small local VP8 video. No user video or network media is read.
    const videoBytes = await controller.evaluate(async () => {
      const canvas = document.createElement('canvas'); canvas.width = 320; canvas.height = 180;
      const draw = canvas.getContext('2d'), stream = canvas.captureStream(15), chunks = [];
      const mime = MediaRecorder.isTypeSupported('video/webm;codecs=vp8') ? 'video/webm;codecs=vp8' : 'video/webm';
      const recorder = new MediaRecorder(stream, {mimeType: mime});
      const stopped = new Promise((resolve, reject) => {
        recorder.ondataavailable = event => chunks.push(event.data);
        recorder.onerror = event => reject(Error(event.error?.message || 'MediaRecorder failed'));
        recorder.onstop = resolve;
      });
      recorder.start();
      for (let i = 0; i < 64; i++) {
        draw.fillStyle = i % 2 ? '#765a41' : '#2b5949'; draw.fillRect(0, 0, 320, 180);
        draw.fillStyle = 'white'; draw.font = '28px sans-serif'; draw.fillText('Local frame ' + i, 25, 98);
        await new Promise(resolve => setTimeout(resolve, 75));
      }
      recorder.stop(); await stopped; stream.getTracks().forEach(track => track.stop());
      return Array.from(new Uint8Array(await new Blob(chunks, {type: 'video/webm'}).arrayBuffer()));
    });
    const mediaFixture = await api('/api/scripts', {title: '桌面本地视频暂停点', category_id: category.id,
      blocks: [{kind: 'text', role: '甲', text: '第一组台词：在一秒处暂停，等待手动继续。'.repeat(40)},
        {kind: 'text', role: '乙', text: '第二组台词：在第二个时间点显示这一句。'}]});
    const csrf = (await api('/api/library', undefined, 'GET')).csrf_token;
    // Electron's application name can contain Chinese; Playwright's request
    // context copies that into a Node HTTP User-Agent, which rejects it.
    // Node fetch uses its own valid ASCII UA for this fixture-only upload.
    const mediaForm = new FormData();
    mediaForm.append('file', new Blob([Buffer.from(videoBytes)], {type: 'video/webm'}), 'desktop-fixture.webm');
    const uploaded = await fetch(base + '/api/scripts/' + mediaFixture.id + '/media', {
      method: 'POST', headers: {'X-CSRF-Token': csrf}, body: mediaForm});
    assert(uploaded.ok, await uploaded.text());
    await api('/api/scripts/' + mediaFixture.id + '/media/cues', {duration: 5.5, cues: [
      {id: 'desktop-cue-1', at: 1, label: '第一暂停点', block_ids: [mediaFixture.blocks[0].id]},
      {id: 'desktop-cue-2', at: 2.4, label: '第二暂停点', block_ids: [mediaFixture.blocks[1].id]},
    ]}, 'PUT');
    await controller.goto(base + '/control?script=' + mediaFixture.id + '&body=media'); await ready();
    await controller.locator('#layout-media-caption').selectOption('auto');
    await controller.locator('#layout-media-caption-layout').selectOption('pages'); await ready();
    const mediaFrame = controller.frames().find(item => item.url().includes('/display?preview=1'));
    await mediaFrame.locator('video.pia-media-element').waitFor();
    await controller.locator('#apply-display').click();
    await until(async () => (await state()).snapshot?.scripts?.[0]?.id === mediaFixture.id, 'video applied');
    await display.locator('video.pia-media-element').waitFor();
    await display.waitForFunction(() => {const video = document.querySelector('video.pia-media-element'); return video?.readyState >= 2 && video.videoWidth === 320;});
    const mediaStatus = target => target.locator('video.pia-media-element').evaluate(video => ({position: video.currentTime, paused: video.paused,
      width: video.videoWidth, height: video.videoHeight, ready_state: video.readyState}));
    const cuePause = (at, cue, label) => until(async () => {
      const status = await mediaStatus(display), live = await state();
      return status.paused && Math.abs(status.position - at) < .16 && !live.playing && live.media_state.cue_id === cue;
    }, label);
    await minimize();
    const mediaCapturesBefore = result.captures.length;
    await controller.locator('.live-details').evaluate(element => element.open = true);
    await controller.locator('#live-play').click(); await cuePause(1, 'desktop-cue-1', 'minimized video reaches first pause point');
    assert((await display.locator('.pia-media-caption-scroll').textContent()).includes('第一组台词'));
    const cue1 = await mediaStatus(display);
    await controller.locator('#live-play').click(); await cuePause(2.4, 'desktop-cue-2', 'manual continue reaches second video pause point');
    assert((await display.locator('.pia-media-caption-scroll').textContent()).includes('第二组台词'));
    const cue2 = await mediaStatus(display);
    await controller.locator('#preview-feedback-mode').selectOption('realtime'); await ready();
    await until(async () => (await state()).snapshot?.layout.body_mode === 'media', 'video realtime binding');
    await mediaFrame.locator('.pia-media-player').hover();
    const seek = mediaFrame.locator('.pia-media-progress');
    await seek.fill('3.2'); await seek.dispatchEvent('input'); await seek.dispatchEvent('change');
    await until(async () => {const media = await mediaStatus(display); return media.paused && Math.abs(media.position - 3.2) < .16;}, 'minimized video follows preview seek');
    assert((await nativeState()).display.minimized);
    assert.equal(result.captures.length, mediaCapturesBefore, 'video minimized test must not rely on capturePage');
    const mediaBeforeRestore = await mediaStatus(display); await restore(); await delay(700);
    const mediaAfterRestore = await mediaStatus(display);
    assert(mediaAfterRestore.paused && Math.abs(mediaAfterRestore.position - mediaBeforeRestore.position) < .16);
    assert.equal(connectCount(), 1);
    result.media = {fixture_sha256: createHash('sha256').update(Buffer.from(videoBytes)).digest('hex'), generated_bytes: videoBytes.length,
      cue_1: cue1, cue_2: cue2, before_restore: mediaBeforeRestore, after_restore: mediaAfterRestore};
    result.checks.push('Synthetic local VP8 video decodes, pauses at two cue points, displays matching captions, continues manually and seeks while truly minimized; restore preserves media time without reconnecting');

    // The same data directory must reuse its existing desktop, without reload.
    const beforeSecond = await nativeState();
    secondary = spawn(python, ['-X', 'utf8', 'run.py', '--data-dir', dataDir, '--port', '8935'],
      {cwd: root, env: {...process.env, PYTHONUTF8: '1'}, windowsHide: true, stdio: 'ignore'});
    let secondaryError; secondary.on('error', error => {secondaryError = error;});
    await until(() => Boolean(secondaryError) || secondary.exitCode !== null, 'second desktop process exits after reusing the first', 12000);
    if (secondaryError) throw secondaryError;
    assert.equal(secondary.exitCode, 0); await delay(1200);
    const afterSecond = await nativeState();
    assert.equal(afterSecond.main.web_contents_id, beforeSecond.main.web_contents_id);
    assert.equal(afterSecond.display.web_contents_id, originalDisplayId);
    assert.equal(connectCount(), 1);
    assert(Math.abs((await mediaStatus(display)).position - mediaAfterRestore.position) < .16);
    result.second_instance = {launcher: 'python run.py --data-dir <same QA> --port 8935', exit_code: secondary.exitCode, before: beforeSecond, after: afterSecond};
    result.checks.push('A second launch for the same data directory reuses existing native windows without display reload or media reset');
    await Promise.all(responseReads);
    const expected = result.http_errors.filter(item => item.status === 409 && item.code === 'stale_revision' && item.url === base + '/api/checkpoint');
    result.expected_stale_checkpoints = expected; assert.deepEqual(result.http_errors, expected);
    assert.deepEqual(result.page_errors, []); assert.deepEqual(result.external_requests, []);
    result.connect_count = connectCount(); assert.equal(result.connect_count, 1);
    result.final_native = await nativeState();
    result.sources = Object.fromEntries(['desktop/main.cjs', 'desktop/preload.cjs', 'static/display.js'].map(file => [file, createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex')]));
    closing = true;
    const shutdownStarted = Date.now();
    result.stop = execFileSync(python, ['-X', 'utf8', 'tools/stop.py', '--data-dir', dataDir], {cwd: root, windowsHide: true, encoding: 'utf8', timeout: 20000}).trim();
    serviceStopped = true;
    await until(() => electronProcess.exitCode !== null, 'desktop exits after its own service stops', 16000);
    desktopExited = true;
    result.service_shutdown = {elapsed_ms: Date.now() - shutdownStarted, electron_exit_code: electronProcess.exitCode};
    assert.equal(electronProcess.exitCode, 0);
    result.checks.push('Stopping only the test Python service with its own token makes the associated desktop exit after health checks; no stale window remains');
    result.passed = result.minimized_capture.changed;
  } catch (error) {
    result.error = error.stack || String(error);
    if (app) result.failure_native = await nativeState().catch(() => null);
    if (display && !display.isClosed()) {
      result.failure_renderer = await display.evaluate(() => ({hidden: document.hidden, visibility: document.visibilityState, probe: window.__desktopRafProbe,
        scroll_top: document.querySelector('#stage-scroll')?.scrollTop, current_page: document.querySelector('.stage-page.is-current')?.dataset.pageIndex})).catch(() => null);
    }
    throw error;
  } finally {
    closing = true;
    if (secondary && secondary.exitCode === null) secondary.kill();
    if (app && !desktopExited) await app.close().catch(error => {result.close_error = String(error); result.passed = false;});
    if (server && !serviceStopped) {
      try { result.stop = execFileSync(python, ['-X', 'utf8', 'tools/stop.py', '--data-dir', dataDir], {cwd: root, windowsHide: true, encoding: 'utf8', timeout: 20000}).trim(); }
      catch (error) { result.stop_error = String(error); result.passed = false; if (server.exitCode === null) server.kill(); }
    }
    result.finished_at = new Date().toISOString();
    fs.writeFileSync(path.join(output, 'desktop-display-result.json'), JSON.stringify(result, null, 2));
  }
}
main().then(() => {console.log(JSON.stringify({passed: result.passed, checks: result.checks, evidence: path.join(output, 'desktop-display-result.json')})); if (!result.passed) process.exitCode = 1;})
  .catch(error => {console.error(error); process.exitCode = 1;});
