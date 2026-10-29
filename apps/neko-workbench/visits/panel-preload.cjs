'use strict';
const { contextBridge, ipcRenderer } = require('electron');
const actions = new Set(['getState', 'login', 'logout', 'refresh', 'savePersona', 'invite', 'accept', 'decline', 'stop', 'history']);
contextBridge.exposeInMainWorld('nekoVisits', Object.freeze({
  call(action, payload = {}) {
    if (!actions.has(action)) return Promise.reject(new Error('Unsupported visit action'));
    return ipcRenderer.invoke('workbench:visits', { ...payload, action });
  },
  subscribe(listener) {
    if (typeof listener !== 'function') throw new TypeError('Expected listener');
    const handler = (_event, state) => listener(state);
    ipcRenderer.on('workbench:visits-state', handler);
    return () => ipcRenderer.removeListener('workbench:visits-state', handler);
  }
}));
