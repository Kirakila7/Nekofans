'use strict';
const { contextBridge, ipcRenderer } = require('electron');
const id = process.argv.find((arg) => arg.startsWith('--neko-visit-rtc='))?.split('=')[1];
if (!/^[a-f0-9-]{36}$/.test(id || '')) throw new Error('visit_rtc_missing_id');
const channel = `neko-visit-rtc:${id}`;
contextBridge.exposeInMainWorld('visitRtc', {
  send: (message) => ipcRenderer.send(channel, message),
  listen: (callback) => ipcRenderer.on(channel, (_event, message) => callback(message)),
});
