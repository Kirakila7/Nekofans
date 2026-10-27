const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("fishSettings", Object.freeze({
  read: () => ipcRenderer.invoke("neko-settings:read"),
  saveApi: (payload) => ipcRenderer.invoke("neko-settings:save-api", payload),
  savePersona: (payload) => ipcRenderer.invoke("neko-settings:save-persona", payload),
  onSection: (callback) => {
    if (typeof callback !== "function") return () => {};
    const listener = (_event, section) => {
      if (section === "api" || section === "persona") callback(section);
    };
    ipcRenderer.on("neko-settings:section", listener);
    return () => ipcRenderer.removeListener("neko-settings:section", listener);
  },
}));
