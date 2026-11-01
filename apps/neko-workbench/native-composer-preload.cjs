'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('nativeComposer', Object.freeze({
  platform:typeof process === 'undefined' ? undefined : process.platform,
  send(message) { ipcRenderer.send('neko-composer-input', message); },
  onState(callback) { if (typeof callback !== 'function') return; ipcRenderer.on('neko-composer-state', (_event, state) => callback(state)); }
}));
