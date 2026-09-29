"use strict";

/* 喜娃剧本粉丝编辑器 · 桌面窗口
 * 简化版桌面壳：单窗口加载本地编辑页；服务停止时自动退出；
 * 关闭窗口即退出（由 exe 入口负责关停本地服务）。 */

const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index++) {
    const item = argv[index];
    if (item === '--no-show') { values.noShow = true; continue; }
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
      url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('--url must be a loopback HTTP address ending in /');
  }
  if (!path.isAbsolute(values['data-dir'])) throw new Error('--data-dir must be absolute');
  const dataDir = path.resolve(values['data-dir']);
  return Object.freeze({origin: url.origin, mainUrl: url.origin + '/', dataDir,
    userData: path.join(dataDir, 'desktop-user-data'), noShow: Boolean(values.noShow)});
}

function directoryKey(value) {
  let resolved = path.resolve(value);
  try { resolved = fs.realpathSync.native(resolved); } catch { /* not-yet-created directory */ }
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function requestHealth(options, timeoutMs = 1500) {
  return new Promise((resolve, reject) => {
    let settled = false, timer;
    const finish = (error, result) => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolve(result); };
    const request = http.get(new URL('/api/health', options.origin), {agent: false}, response => {
      const chunks = []; let size = 0;
      response.on('data', chunk => { size += chunk.length; if (size > 16384) { response.destroy(); finish(new Error('Health response too large')); } else chunks.push(chunk); });
      response.on('error', () => finish(new Error('Local service connection failed')));
      response.on('aborted', () => finish(new Error('Local service interrupted')));
      response.on('end', () => {
        try {
          if (response.statusCode !== 200) throw new Error('Local service not ready');
          const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (result.app !== 'xiwa-fan-editor' || typeof result.data_dir !== 'string' ||
              directoryKey(result.data_dir) !== directoryKey(options.dataDir)) throw new Error('Local service does not match this data directory');
          finish(null, result);
        } catch (error) { finish(error); }
      });
    });
    request.on('error', () => finish(new Error('Local service connection failed')));
    timer = setTimeout(() => { request.destroy(); finish(new Error('Local service health check timed out')); }, timeoutMs);
  });
}

async function startDesktop(argv = process.argv.slice(1)) {
  const options = parseArgs(argv);
  const {app, BrowserWindow} = require('electron');
  fs.mkdirSync(options.userData, {recursive: true});
  app.setName('喜娃剧本粉丝编辑器');
  app.setPath('userData', options.userData);
  app.setPath('sessionData', options.userData);
  if (!app.requestSingleInstanceLock({data_dir: options.dataDir, url: options.mainUrl})) { app.quit(); return null; }

  let mainWindow = null, closing = false, healthTimer = null, healthFailures = 0;
  const alive = win => Boolean(win && !win.isDestroyed());

  function createWindow() {
    mainWindow = new BrowserWindow({
      width: 1280, height: 840, minWidth: 960, minHeight: 640,
      title: '喜娃剧本粉丝编辑器 · 桌面版',
      backgroundColor: '#f5f1e8',
      show: false,
      webPreferences: {sandbox: true, contextIsolation: true, nodeIntegration: false,
        nodeIntegrationInWorker: false, nodeIntegrationInSubFrames: false, webviewTag: false,
        webSecurity: true, allowRunningInsecureContent: false, navigateOnDragDrop: false,
        backgroundThrottling: false}
    });
    mainWindow.on('closed', () => { mainWindow = null; });
    mainWindow.on('close', () => { closing = true; });
    mainWindow.loadURL(options.mainUrl);
    if (!options.noShow) mainWindow.show();
    return mainWindow;
  }

  function stopHealthMonitor() {
    if (healthTimer) { clearInterval(healthTimer); healthTimer = null; }
  }

  function startHealthMonitor() {
    // 页面点「安全退出」后服务停止，这里感知到就关窗退出；窗口本身关闭时由 exe 入口关停服务。
    healthTimer = setInterval(() => {
      if (closing || !alive(mainWindow)) { stopHealthMonitor(); return; }
      requestHealth(options).then(() => { healthFailures = 0; }).catch(() => {
        healthFailures += 1;
        if (healthFailures >= 3 && alive(mainWindow)) {
          stopHealthMonitor();
          try { mainWindow.close(); } catch { app.quit(); }
        }
      });
    }, 1500);
  }

  app.on('second-instance', () => { if (alive(mainWindow)) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.focus(); } });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', () => { stopHealthMonitor(); closing = true; });

  try {
    await requestHealth(options);
  } catch (error) {
    // 服务未就绪：给窗口一个可读的失败页，不无限重试。
    app.whenReady().then(() => {
      const win = createWindow();
      win.webContents.on('did-finish-load', () => {});
    });
    return null;
  }
  app.whenReady().then(() => {
    createWindow();
    startHealthMonitor();
  });
  return mainWindow;
}

module.exports = {parseArgs, requestHealth, startDesktop};
// Electron 与自动化加载器以模块方式引入入口文件时不会赋值 require.main，
// 此时以“运行于 Electron 主进程”作为判定；Symbol.for 防止重复启动。
const electronMainProcess = Boolean(process.versions.electron && process.type === 'browser');
const startupKey = Symbol.for('xiwa-fan.desktop.started');
if ((require.main === module || electronMainProcess) && !globalThis[startupKey]) {
  globalThis[startupKey] = true;
  startDesktop().catch(error => {
    try { console.error('[desktop] ' + String(error && error.stack || error)); } catch { /* noop */ }
    try { require('electron').app.exit(1); } catch { process.exit(1); }
  });
}
