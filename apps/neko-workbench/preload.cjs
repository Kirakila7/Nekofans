const { contextBridge, ipcRenderer } = require('electron');
const methods=new Set(['state','neko-settings','rename','settings','menu','move','move-end','motion-input','pass-through','memory','prompt','open-task','open-workbench',
  'chat-settings-read','chat-settings-save','chat-use-deepseek-account','chat-open-neko-settings','chat-open-memory','chat-memory-read','chat-history','chat-memory-action','chat-cancel','question-reveal']);
contextBridge.exposeInMainWorld('pet', Object.freeze({
  call: (method, params={}) => methods.has(method)?ipcRenderer.invoke('pet:call',method,params):Promise.reject(new Error('未知桌宠操作')),
  onInput: callback => { const f=()=>callback(); ipcRenderer.on('pet:input',f); return ()=>ipcRenderer.removeListener('pet:input',f); },
  onMemoryOpen: callback => { const f=()=>callback(); ipcRenderer.on('pet:memory-open',f); return ()=>ipcRenderer.removeListener('pet:memory-open',f); },
  onMotion: callback => { const f=(_,value)=>callback(value); ipcRenderer.on('pet:motion',f); return ()=>ipcRenderer.removeListener('pet:motion',f); },
  onState: callback => { const f=(_,state)=>callback(state); ipcRenderer.on('pet:state',f); return ()=>ipcRenderer.removeListener('pet:state',f); }
}));
