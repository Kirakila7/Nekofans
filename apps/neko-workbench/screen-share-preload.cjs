'use strict';
const { contextBridge, ipcRenderer } = require('electron');
const methods = new Set(['state', 'sources', 'settings', 'start', 'pause', 'stop', 'frame', 'ask', 'capture-error', 'hide']);
contextBridge.exposeInMainWorld('screenShare', Object.freeze({
  call: (method, value) => methods.has(method) ? ipcRenderer.invoke('screen-share:call', method, value) : Promise.reject(new Error('未知操作')),
  subscribe: callback => { const fn = (_event, value) => callback(value); ipcRenderer.on('screen-share:state', fn); return () => ipcRenderer.removeListener('screen-share:state', fn); }
}));
