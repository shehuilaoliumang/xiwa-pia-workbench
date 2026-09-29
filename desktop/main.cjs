"use strict";

const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const http = require('node:http');
const VERSION = '0.1.0';
const CHANNELS = Object.freeze({open: 'pia-desktop:open-display', restore: 'pia-desktop:restore-display', state: 'pia-desktop:window-state'});

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index++) {
    const item = argv[index];
    if (item === '--diagnostics' || item === '--no-show') { values[item.slice(2)] = true; continue; }
    for (const name of ['url', 'data-dir']) {
      if (item !== '--' + name && !item.startsWith('--' + name + '=')) continue;
      if (Object.hasOwn(values, name)) throw new Error('Duplicate --' + name);
      const value = item === '--' + name ? argv[++index] : item.slice(name.length + 3);
      if (!value || value.startsWith('--')) throw new Error('Missing --' + name);
      values[name] = value;
      break;
    }
  }
  if (!values.url || !values['data-dir']) throw new Error('--url and an absolute --data-dir are required');
  const url = new URL(values.url);
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
      url.username || url.password || url.search || url.hash || !['/', '/control'].includes(url.pathname)) {
    throw new Error('--url must be a loopback HTTP address ending in / or /control');
  }
  if (!path.isAbsolute(values['data-dir'])) throw new Error('--data-dir must be absolute');
  const dataDir = path.resolve(values['data-dir']);
  return Object.freeze({origin: url.origin, mainUrl: url.origin + '/control', displayUrl: url.origin + '/display',
    dataDir, userData: path.join(dataDir, 'desktop-user-data'), diagnostics: Boolean(values.diagnostics), noShow: Boolean(values['no-show'])});
}

function sameOriginUrl(value, origin) {
  if (typeof value !== 'string' || /[\u0000-\u0020\\]/.test(value)) return false;
  try { const url = new URL(value); return url.protocol === 'http:' && url.origin === origin && !url.username && !url.password; }
  catch { return false; }
}

function directoryKey(value) {
  let resolved = path.resolve(value);
  try { resolved = fs.realpathSync.native(resolved); } catch { /* A fixture or not-yet-created directory. */ }
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function servicePid(options) {
  try {
    const recordPath = path.join(options.dataDir, 'server.json');
    if (fs.statSync(recordPath).size > 8192) return null;
    const record = JSON.parse(fs.readFileSync(recordPath, 'utf8'));
    if (!Number.isSafeInteger(record.pid) || record.pid <= 0 || !sameOriginUrl(record.url, options.origin)) return null;
    return record.pid; // Never return or log the launcher's stop token.
  } catch { return null; }
}

function requestHealth(options, timeoutMs = 1200) {
  return new Promise((resolve, reject) => {
    let settled = false, timer;
    const finish = (error, result) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      if (error) reject(error); else resolve(result);
    };
    const request = http.get(new URL('/api/health', options.origin), {agent: false}, response => {
      const chunks = []; let size = 0;
      response.on('data', chunk => {
        size += chunk.length;
        if (size > 16384) { response.destroy(); finish(new Error('Local health response is too large')); }
        else chunks.push(chunk);
      });
      response.on('error', () => finish(new Error('Local service connection failed')));
      response.on('aborted', () => finish(new Error('Local service response was interrupted')));
      response.on('end', () => {
        try {
          if (response.statusCode !== 200) throw new Error('Local service is not ready');
          const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (result.app !== 'xiwa-workbench' || typeof result.data_dir !== 'string' ||
              directoryKey(result.data_dir) !== directoryKey(options.dataDir)) throw new Error('Local service does not match this data directory');
          finish(null, {app: result.app, data_dir: result.data_dir});
        } catch (error) { finish(error); }
      });
    });
    request.on('error', () => finish(new Error('Local service connection failed')));
    timer = setTimeout(() => { request.destroy(); finish(new Error('Local service health check timed out')); }, timeoutMs);
  });
}

async function startDesktop(argv = process.argv.slice(1)) {
  const options = parseArgs(argv);
  const {app, BrowserWindow, ipcMain, session, screen} = require('electron');
  fs.mkdirSync(options.userData, {recursive: true});
  app.setName('喜娃微PIA工作台');
  app.setPath('userData', options.userData);
  app.setPath('sessionData', options.userData);
  if (!app.requestSingleInstanceLock({data_dir: options.dataDir, url: options.mainUrl})) { app.quit(); return null; }

  let mainWindow = null, displayWindow = null, sessionHandle = null;
  let pendingSecondOptions = null, windowsReady = false, closing = false;
  let healthTimer = null, healthBusy = false, healthFailures = 0, knownServicePid = null;
  const paintStats = new Map();
  const preload = path.join(__dirname, 'preload.cjs');
  const alive = win => Boolean(win && !win.isDestroyed());
  const safeUrl = value => sameOriginUrl(value, options.origin);

  function preferences() {
    return {session: sessionHandle, preload, sandbox: true, contextIsolation: true, nodeIntegration: false,
      nodeIntegrationInWorker: false, nodeIntegrationInSubFrames: false, webviewTag: false,
      webSecurity: true, allowRunningInsecureContent: false, navigateOnDragDrop: false,
      backgroundThrottling: false, additionalArguments: ['--pia-desktop-origin=' + encodeURIComponent(options.origin)]};
  }

  function describe(win) {
    if (!alive(win)) return null;
    return {id: win.id, web_contents_id: win.webContents.id, url: win.webContents.getURL(), minimized: win.isMinimized(),
      visible: win.isVisible(), focused: win.isFocused(), bounds: win.getBounds(),
      background_throttling: win.webContents.getBackgroundThrottling(),
      paint: {...(paintStats.get(win.id) || {monitoring: false, count: 0, last_at: null, last_hash: null})}};
  }

  function getState() {
    return {is_desktop: true, version: VERSION, origin: options.origin,
      main: describe(mainWindow), display: describe(displayWindow)};
  }

  function restore(win) {
    if (!alive(win)) return false;
    if (win.isMinimized()) win.restore();
    if (!options.noShow) { win.show(); win.focus(); }
    return true;
  }

  function protect(win, role) {
    const wc = win.webContents, windowId = win.id;
    win.removeMenu();
    wc.setBackgroundThrottling(false);
    const fixedTitle = role === 'display' ? '喜娃微PIA · 独立展示' : '喜娃微PIA工作台 · 桌面版';
    win.setTitle(fixedTitle);
    wc.on('page-title-updated', event => { event.preventDefault(); win.setTitle(fixedTitle); });
    for (const eventName of ['will-navigate', 'will-frame-navigate', 'will-redirect']) {
      wc.on(eventName, (event, legacyUrl) => {
        const target = event.url || legacyUrl;
        if (!safeUrl(target)) event.preventDefault();
      });
    }
    wc.on('will-attach-webview', event => event.preventDefault());
    wc.on('render-process-gone', (_event, detail) => console.error('[desktop] Renderer stopped:', role, detail.reason));
    wc.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
      if (isMainFrame && code !== -3) console.error('[desktop] Page failed:', code, description, safeUrl(url) ? url : '<blocked>');
    });
    // No minimize handler restores or hides the window: QA must exercise a real minimized HWND.
    if (role === 'display') wc.setWindowOpenHandler(() => ({action: 'deny'}));
    win.on('closed', () => { paintStats.delete(windowId); if (role === 'display') displayWindow = null; else mainWindow = null; });
  }

  function displayOptions() {
    const area = screen.getPrimaryDisplay().workAreaSize;
    return {title: '喜娃微PIA · 独立展示', width: Math.min(620, area.width), height: Math.min(960, area.height),
      minWidth: 320, minHeight: 320, show: !options.noShow, autoHideMenuBar: true,
      backgroundColor: '#f7f1e8', webPreferences: preferences()};
  }

  function attachDisplayPopup() {
    mainWindow.webContents.setWindowOpenHandler(details => {
      const blank = details.url === 'about:blank';
      let displayUrl = false;
      if (safeUrl(details.url)) { const target = new URL(details.url); displayUrl = target.pathname === '/display' && !target.search && !target.hash; }
      if (details.frameName !== 'pia-display' || (!blank && !displayUrl) || details.postBody) return {action: 'deny'};
      if (alive(displayWindow)) { restore(displayWindow); return {action: 'deny'}; }
      return {action: 'allow', outlivesOpener: true, overrideBrowserWindowOptions: displayOptions(),
        createWindow: popupOptions => {
          // Preserve Electron's supplied webContents so named window.open and opener relationships work.
          displayWindow = new BrowserWindow(popupOptions);
          protect(displayWindow, 'display');
          return displayWindow.webContents;
        }};
    });
  }

  async function openDisplay() {
    if (alive(displayWindow)) { restore(displayWindow); return describe(displayWindow); }
    if (!alive(mainWindow) || !safeUrl(mainWindow.webContents.getURL())) throw new Error('The control window is not ready');
    // A fixed, argument-free operation preserves the same named popup as the browser-mode button.
    // No caller-supplied JavaScript or URL is executed.
    await mainWindow.webContents.executeJavaScript("window.open('/display', 'pia-display') !== null", true);
    if (!alive(displayWindow)) throw new Error('The display window could not be opened');
    restore(displayWindow);
    return describe(displayWindow);
  }

  async function restoreDisplay() { return openDisplay(); }

  function trustedSender(event, controlOnly = false) {
    const sender = event.sender;
    const owner = BrowserWindow.fromWebContents(sender);
    if (!alive(owner) || (owner !== mainWindow && owner !== displayWindow) ||
        (controlOnly && owner !== mainWindow) || event.senderFrame !== sender.mainFrame || !safeUrl(event.senderFrame?.url)) {
      throw new Error('This desktop operation is not available to this frame');
    }
  }

  function installIPC() {
    ipcMain.handle(CHANNELS.open, (event, ...args) => { trustedSender(event, true); if (args.length) throw new Error('No arguments allowed'); return openDisplay(); });
    ipcMain.handle(CHANNELS.restore, (event, ...args) => { trustedSender(event, true); if (args.length) throw new Error('No arguments allowed'); return restoreDisplay(); });
    ipcMain.handle(CHANNELS.state, (event, ...args) => { trustedSender(event); if (args.length) throw new Error('No arguments allowed'); return getState(); });
  }

  function installDiagnostics() {
    if (!options.diagnostics) return;
    function needDisplay() { if (!alive(displayWindow)) throw new Error('Display window is not open'); return displayWindow; }
    function stopFrameMonitor() {
      const win = needDisplay();
      win.webContents.endFrameSubscription();
      const stats = paintStats.get(win.id);
      if (stats) stats.monitoring = false;
      return describe(win);
    }
    function startFrameMonitor() {
      const win = needDisplay();
      stopFrameMonitor();
      const stats = {monitoring: true, count: 0, last_at: null, last_hash: null};
      paintStats.set(win.id, stats);
      win.webContents.beginFrameSubscription(false, image => {
        if (!alive(win)) return;
        stats.count++;
        const now = Date.now();
        // Hash only a sample of frames; this diagnostic must not become a PNG encoder each frame.
        if (!stats.last_at || now - stats.last_at >= 100) {
          stats.last_at = now;
          stats.last_hash = crypto.createHash('sha256').update(image.toBitmap()).digest('hex');
        }
      });
      return describe(win);
    }
    async function captureDisplay() {
      const win = needDisplay();
      const image = await win.webContents.capturePage(undefined, {stayHidden: true, stayAwake: false});
      const png = image.toPNG(), size = image.getSize();
      return {png_base64: png.toString('base64'), sha256: crypto.createHash('sha256').update(png).digest('hex'),
        width: size.width, height: size.height, minimized: win.isMinimized(), captured_at: Date.now()};
    }
    // Available only in the trusted main process, never through renderer IPC.
    globalThis.__piaDesktopDiagnostics = Object.freeze({getState, openDisplay, restoreDisplay, captureDisplay, startFrameMonitor, stopFrameMonitor,
      minimizeDisplay: () => { const win = needDisplay(); win.minimize(); return describe(win); }});
  }

  function createMainWindow() {
    const area = screen.getPrimaryDisplay().workAreaSize;
    mainWindow = new BrowserWindow({title: '喜娃微PIA工作台 · 桌面版', width: Math.min(1500, area.width),
      height: Math.min(1000, area.height), minWidth: 390, minHeight: 500, show: !options.noShow,
      autoHideMenuBar: true, backgroundColor: '#f7f1e8', webPreferences: preferences()});
    protect(mainWindow, 'main');
    attachDisplayPopup();
    void mainWindow.loadURL(options.mainUrl).catch(error => console.error('[desktop] Cannot load local service:', error.message));
    return mainWindow;
  }

  function endDesktop(reason, relaunchOptions = null) {
    if (closing) return;
    closing = true;
    clearInterval(healthTimer);
    console.error('[desktop] ' + reason);
    if (relaunchOptions) {
      const args = [__filename, '--url=' + relaunchOptions.origin + '/', '--data-dir=' + options.dataDir];
      if (options.diagnostics) args.push('--diagnostics');
      if (options.noShow) args.push('--no-show');
      app.relaunch({args});
    }
    // Destroy only our two windows; never call the Python shutdown endpoint or terminate another process.
    for (const win of [displayWindow, mainWindow]) if (alive(win)) win.destroy();
    app.quit();
  }

  async function handleSecondInstance(next) {
    if (closing || directoryKey(next.dataDir) !== directoryKey(options.dataDir)) return;
    try {
      await requestHealth(next);
      if (closing) return;
      const pid = servicePid(next);
      if (next.origin !== options.origin || (knownServicePid !== null && pid !== null && pid !== knownServicePid)) {
        endDesktop('Local service restarted; reopening the desktop interface.', next);
        return;
      }
      if (knownServicePid === null && pid !== null) knownServicePid = pid;
      if (!alive(mainWindow)) createMainWindow();
      restore(mainWindow); // A healthy duplicate launch must not reload or reconnect the display.
    } catch { console.error('[desktop] Duplicate launch did not match a ready local service.'); }
  }

  async function monitorHealth() {
    if (closing || healthBusy) return;
    healthBusy = true;
    try {
      await requestHealth(options);
      if (closing) return;
      healthFailures = 0;
      const pid = servicePid(options);
      if (knownServicePid !== null && pid !== null && knownServicePid !== pid) {
        endDesktop('Local service restarted; reopening the desktop interface.', options);
      } else if (knownServicePid === null && pid !== null) knownServicePid = pid;
    } catch {
      if (++healthFailures >= 3) endDesktop('Local service stopped responding; closing desktop windows.');
    } finally { healthBusy = false; }
  }

  app.on('second-instance', (_event, commandLine) => {
    let next;
    try { next = parseArgs(commandLine); } catch { return; }
    if (directoryKey(next.dataDir) !== directoryKey(options.dataDir)) return;
    if (!windowsReady) { pendingSecondOptions = next; return; }
    void handleSecondInstance(next);
  });
  app.on('window-all-closed', () => app.quit());
  app.on('activate', () => { if (!windowsReady || closing) return; if (!alive(mainWindow)) createMainWindow(); else restore(mainWindow); });
  app.on('will-quit', () => {
    closing = true; clearInterval(healthTimer);
    for (const name of Object.values(CHANNELS)) ipcMain.removeHandler(name);
    delete globalThis.__piaDesktopDiagnostics;
  });
  await app.whenReady();
  let serviceReady = false;
  for (let attempt = 0; attempt < 5 && !closing; attempt++) {
    try { await requestHealth(options); serviceReady = true; break; }
    catch { if (attempt < 4) await new Promise(resolve => setTimeout(resolve, 500)); }
  }
  if (!serviceReady || closing) { endDesktop('Local service is unavailable; no desktop window was opened.'); return null; }
  knownServicePid = servicePid(options);
  sessionHandle = session.fromPartition('persist:pia-workbench');
  // HTTP User-Agent is ASCII; keep Chromium/OS tokens while normalizing the localized app brand.
  sessionHandle.setUserAgent(sessionHandle.getUserAgent().replace(/[^\x20-\x7E]+/g, 'XiWa'));
  // This session is shared by both owned windows and isolated by the configured userData directory.
  sessionHandle.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  sessionHandle.setPermissionCheckHandler(() => false);
  sessionHandle.webRequest.onBeforeRequest((details, callback) => {
    let permitted = safeUrl(details.url) || details.url === 'about:blank' || details.url.startsWith('data:');
    if (details.url.startsWith('blob:')) { try { permitted = new URL(details.url).origin === options.origin; } catch { permitted = false; } }
    callback({cancel: !permitted});
  });
  installIPC();
  installDiagnostics();
  createMainWindow();
  windowsReady = true;
  healthTimer = setInterval(monitorHealth, 2000);
  if (pendingSecondOptions) void handleSecondInstance(pendingSecondOptions);
  return {getState, openDisplay, restoreDisplay};
}

module.exports = {parseArgs, sameOriginUrl, directoryKey, requestHealth, servicePid, startDesktop};
// Electron and automation loaders can import the application entry without assigning require.main.
// Ordinary Node imports still expose helpers only, without requiring Electron or touching userData.
const electronMainProcess = Boolean(process.versions.electron && process.type === 'browser');
const startupKey = Symbol.for('xiwa-pia.desktop.started');
if ((require.main === module || electronMainProcess) && !globalThis[startupKey]) {
  globalThis[startupKey] = true;
  startDesktop().catch(error => {
    console.error('[desktop] ' + error.message);
    require('electron').app.exit(1);
  });
}
