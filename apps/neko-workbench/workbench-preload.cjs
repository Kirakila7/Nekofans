const {contextBridge,ipcRenderer}=require('electron');
// Dedicated to the authenticated local workbench. No arbitrary filesystem access, pet state,
// credentials, shell commands or arbitrary IPC are exposed to the web page.
const call=(method,value)=>ipcRenderer.invoke('workbench:call',method,value);
contextBridge.exposeInMainWorld('nekoWorkbench',Object.freeze({
  getState:()=>call('state'),
  getAccounts:({includeQuota=false,force=false}={})=>call('accounts',{includeQuota:includeQuota===true,force:force===true}),
  workspace:request=>call('workspace',request),
  companion:request=>call('companion',request),
  subscribeOffice:callback=>{const listener=(_event,state)=>callback(state);ipcRenderer.on('workbench:office-state',listener);return()=>ipcRenderer.removeListener('workbench:office-state',listener);},
  setAvatar:id=>call('avatar',id),
  uploadAvatar:()=>call('upload-avatar'),
  action:name=>call('action',name),
  fish:action=>call('fish',action),
  qqbot:action=>call('qqbot',action),
  fishQq:request=>call('fish-qq',request),
  community:request=>ipcRenderer.invoke('workbench:community',request),
  subscribeCommunity:callback=>{const listener=(_event,state)=>callback(state);ipcRenderer.on('workbench:community-state',listener);return()=>ipcRenderer.removeListener('workbench:community-state',listener);},
  subscribe:callback=>{const listener=(_event,state)=>callback(state);ipcRenderer.on('workbench:state',listener);return()=>ipcRenderer.removeListener('workbench:state',listener);}
}));
contextBridge.exposeInMainWorld('nekoRoles',Object.freeze({
  getState:()=>ipcRenderer.invoke('workbench:roles','state'),
  selectRole:id=>ipcRenderer.invoke('workbench:roles','select',{id}),
  updateRole:(id,patch)=>ipcRenderer.invoke('workbench:roles','update',{id,patch}),
  uploadAvatar:id=>ipcRenderer.invoke('workbench:roles','upload',{id}),
  subscribe:callback=>{const listener=(_event,state)=>callback(state);ipcRenderer.on('workbench:roles-state',listener);return()=>ipcRenderer.removeListener('workbench:roles-state',listener);}
}));
