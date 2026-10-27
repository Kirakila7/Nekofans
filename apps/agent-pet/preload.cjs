const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("dshPet", Object.freeze({
  command: (command) => ipcRenderer.invoke("bigfish-dsh:command", command),
  onSnapshot: (listener) => {
    const handler = (_event, snapshot) => listener(snapshot);
    ipcRenderer.on("bigfish-dsh:snapshot", handler);
    return () => ipcRenderer.removeListener("bigfish-dsh:snapshot", handler);
  },
}));
