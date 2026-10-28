const {contextBridge,ipcRenderer}=require('electron');
// Dedicated to the authenticated local workbench. No file paths, pet state,
// credentials, shell commands or arbitrary IPC are exposed to the web page.
const call=(method,value)=>ipcRenderer.invoke('workbench:call',method,value);
contextBridge.exposeInMainWorld('nekoWorkbench',Object.freeze({
  getState:()=>call('state'),
  screenShare:method=>method==='hide'?ipcRenderer.invoke('workbench:screen-share','hide'):Promise.reject(new Error('未知屏幕操作')),
  setAvatar:id=>call('avatar',id),
  uploadAvatar:()=>call('upload-avatar'),
  action:name=>call('action',name),
  fish:action=>call('fish',action),
  qqbot:action=>call('qqbot',action),
  codex:Object.freeze({
    start:options=>ipcRenderer.invoke('workbench:codex','start',options),
    send:options=>ipcRenderer.invoke('workbench:codex','send',options),
    cancel:()=>ipcRenderer.invoke('workbench:codex','cancel'),
    approval:options=>ipcRenderer.invoke('workbench:codex','approval',options),
    accountStatus:()=>ipcRenderer.invoke('workbench:codex','account-status'),
    onAccountStatus:callback=>{if(typeof callback!=='function')throw new TypeError('callback must be a function');const listener=(_event,value)=>callback(value);ipcRenderer.on('workbench:codex-account',listener);return()=>ipcRenderer.removeListener('workbench:codex-account',listener);},
    onEvent:callback=>{if(typeof callback!=='function')throw new TypeError('callback must be a function');const listener=(_event,value)=>callback(value);ipcRenderer.on('workbench:codex-event',listener);return()=>ipcRenderer.removeListener('workbench:codex-event',listener);}
  }),
  community:request=>ipcRenderer.invoke('workbench:community',request),
  subscribeCommunity:callback=>{const listener=(_event,state)=>callback(state);ipcRenderer.on('workbench:community-state',listener);return()=>ipcRenderer.removeListener('workbench:community-state',listener);},
  communityAccount:action=>ipcRenderer.invoke('workbench:community-account',action),
  subscribeCommunityAccount:callback=>{if(typeof callback!=='function')throw new TypeError('callback must be a function');const listener=(_event,state)=>callback(state);ipcRenderer.on('workbench:community-account-state',listener);return()=>ipcRenderer.removeListener('workbench:community-account-state',listener);},
  subscribe:callback=>{const listener=(_event,state)=>callback(state);ipcRenderer.on('workbench:state',listener);return()=>ipcRenderer.removeListener('workbench:state',listener);}
}));
contextBridge.exposeInMainWorld('nekoRoles',Object.freeze({
  getState:()=>ipcRenderer.invoke('workbench:roles','state'),
  selectRole:id=>ipcRenderer.invoke('workbench:roles','select',{id}),
  updateRole:(id,patch)=>ipcRenderer.invoke('workbench:roles','update',{id,patch}),
  uploadAvatar:id=>ipcRenderer.invoke('workbench:roles','upload',{id}),
  subscribe:callback=>{const listener=(_event,state)=>callback(state);ipcRenderer.on('workbench:roles-state',listener);return()=>ipcRenderer.removeListener('workbench:roles-state',listener);}
}));
