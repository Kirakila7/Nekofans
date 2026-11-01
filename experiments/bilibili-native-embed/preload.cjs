const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('nativeTrial', {
  action: action => ipcRenderer.invoke('native-action', action),
  onStatus: listener => ipcRenderer.on('native-status', (_event, value) => listener(value))
});
