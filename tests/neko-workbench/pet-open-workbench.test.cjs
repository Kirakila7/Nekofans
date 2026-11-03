'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../../apps/neko-workbench/main.cjs'),'utf8');
const start=source.indexOf("ipcMain.handle('pet:call'"),end=source.indexOf('\nif(process.env.PET_CAPTURE_SIGNAL',start);
function fixture(){
  let handler,opened=0;const pet={webContents:{}},settings={webContents:{}};
  const context={ipcMain:{handle(_name,fn){handler=fn;}},BrowserWindow:{fromWebContents:contents=>contents===pet.webContents?pet:settings},petWindows:new Map([['main',pet]]),renameWindows:new Map(),memoryWindow:null,settingsWindow:settings,nekoSettingsWindow:null,chatSettingsWindow:null,chatMemoryWindow:null,assertLocalCaller(event,window){if(event.senderFrame!==window.webContents.mainFrame)throw Error('untrusted');},openDsh:async()=>{opened++;}};
  pet.webContents.mainFrame={};settings.webContents.mainFrame={};vm.createContext(context);vm.runInContext(source.slice(start,end),context);
  return {pet,settings,invoke:(window,frame=window.webContents.mainFrame)=>handler({sender:window.webContents,senderFrame:frame},'open-workbench'),count:()=>opened};
}
test('trusted desktop pet opens the workbench through its narrow IPC method',async()=>{const f=fixture();assert.equal(await f.invoke(f.pet),true);assert.equal(f.count(),1);});
test('settings windows and subframes cannot use the pet opening action',async()=>{const f=fixture();await assert.rejects(f.invoke(f.settings),/桌宠/);await assert.rejects(f.invoke(f.pet,{}),/untrusted/);assert.equal(f.count(),0);});

test('merged pet preload retains both workbench opening and native-question reopening',async()=>{
 let api;const calls=[];
 const context={require:name=>{
   assert.equal(name,'electron');
   return {contextBridge:{exposeInMainWorld(_name,value){api=value;}},ipcRenderer:{invoke:async(...args)=>{calls.push(args);return true;}}};
 }};
 vm.createContext(context);vm.runInContext(fs.readFileSync(path.join(__dirname,'../../apps/neko-workbench/preload.cjs'),'utf8'),context);
 assert.equal(await api.call('open-workbench'),true);assert.equal(await api.call('question-reveal'),true);
 assert.deepEqual(calls.map(args=>args.slice(0,2)),[['pet:call','open-workbench'],['pet:call','question-reveal']]);
 await assert.rejects(api.call('arbitrary-action'),/未知桌宠操作/);assert.equal(calls.length,2);
});
