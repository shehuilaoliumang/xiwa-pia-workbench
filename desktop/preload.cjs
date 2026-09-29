"use strict";

const {contextBridge, ipcRenderer} = require('electron');
const flag = process.argv.find(value => value.startsWith('--pia-desktop-origin='));
let allowedOrigin = '';
try { allowedOrigin = flag ? decodeURIComponent(flag.slice('--pia-desktop-origin='.length)) : ''; } catch { /* Fail closed. */ }
if (process.isMainFrame && allowedOrigin && location.origin === allowedOrigin) {
  contextBridge.exposeInMainWorld('piaDesktop', Object.freeze({
    isDesktop: true,
    version: '0.1.0',
    openDisplay: () => ipcRenderer.invoke('pia-desktop:open-display'),
    restoreDisplay: () => ipcRenderer.invoke('pia-desktop:restore-display'),
    getWindowState: () => ipcRenderer.invoke('pia-desktop:window-state')
  }));
}
