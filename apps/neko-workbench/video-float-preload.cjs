'use strict';
const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('videoFloat',Object.freeze({action:request=>ipcRenderer.invoke('neko-video-float',request),subscribe:callback=>{if(typeof callback!=='function')return;ipcRenderer.on('neko-video-float-state',(_event,state)=>callback(state));}}));
