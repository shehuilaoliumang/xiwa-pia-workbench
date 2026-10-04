"use strict";

const {contextBridge, ipcRenderer} = require('electron');
const flag = process.argv.find(value => value.startsWith('--wb-desktop-origin='));
let allowedOrigin = '';
try { allowedOrigin = flag ? decodeURIComponent(flag.slice('--wb-desktop-origin='.length)) : ''; } catch { /* Fail closed. */ }
if (process.isMainFrame && allowedOrigin && location.origin === allowedOrigin) {
  contextBridge.exposeInMainWorld('wbDesktop', Object.freeze({
    isDesktop: true,
    version: '0.1.0',
    openDisplay: () => ipcRenderer.invoke('wb-desktop:open-display'),
    restoreDisplay: () => ipcRenderer.invoke('wb-desktop:restore-display'),
    getWindowState: () => ipcRenderer.invoke('wb-desktop:window-state')
  }));
}
