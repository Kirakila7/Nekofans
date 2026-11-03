'use strict';
const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('communityDailySettings',Object.freeze({
 read:()=>ipcRenderer.invoke('workbench:community-daily-settings','read'),
 save:settings=>ipcRenderer.invoke('workbench:community-daily-settings','save',settings)
}));
