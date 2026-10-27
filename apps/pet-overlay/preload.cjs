// F09 pet overlay preload (sandboxed, contextIsolation). Exposes a narrow bridge:
// read the overlay snapshot, send a command, receive snapshot pushes.
// Channel names mirror OVERLAY_CHANNELS in packages/app-coordinator/src/overlay-protocol.ts.
"use strict";

const { contextBridge, ipcRenderer } = require("electron");

const CHANNELS = Object.freeze({
  getSnapshot: "neko-pet:get-snapshot",
  command: "neko-pet:command",
  snapshot: "neko-pet:snapshot",
  showHistory: "neko-pet:show-history",
});

contextBridge.exposeInMainWorld("nekoPet", {
  getSnapshot: () => ipcRenderer.invoke(CHANNELS.getSnapshot),
  send: (command) => ipcRenderer.send(CHANNELS.command, command),
  onShowHistory: (fn) => {
    if (typeof fn !== "function") return () => {};
    const listener = () => fn();
    ipcRenderer.on(CHANNELS.showHistory, listener);
    return () => ipcRenderer.removeListener(CHANNELS.showHistory, listener);
  },
  onSnapshot: (fn) => {
    if (typeof fn !== "function") return () => {};
    const listener = (_event, snapshot) => fn(snapshot);
    ipcRenderer.on(CHANNELS.snapshot, listener);
    return () => ipcRenderer.removeListener(CHANNELS.snapshot, listener);
  },
});
