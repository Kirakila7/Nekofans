const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('taskQuestions',Object.freeze({action:value=>ipcRenderer.invoke('pet-question:action',value),subscribe:callback=>{const listener=(_event,value)=>callback(value);ipcRenderer.on('pet-question:state',listener);return()=>ipcRenderer.removeListener('pet-question:state',listener);}}));
