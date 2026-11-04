'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
const base=path.resolve(__dirname,'../../apps/neko-workbench'),main=fs.readFileSync(path.join(base,'main.cjs'),'utf8');
const entry=main.slice(main.indexOf('function editChatMemory(){'),main.indexOf('\nconst pinnedCount='));
test('workbench memory action opens the same memory window and rejects unknown actions',async()=>{
  let opened=0;const context={editChatMemory:()=>opened++};vm.createContext(context);
  vm.runInContext(main.slice(main.indexOf('async function workbenchAction('),main.indexOf('\nfunction workbenchOptions()')),context);
  assert.equal((await context.workbenchAction('chat-memory')).ok,true);assert.equal(opened,1);await assert.rejects(context.workbenchAction('unknown'),/未知/);
});
test('existing memory window is reused and receives a request to display stars',()=>{
  const calls=[],window={isDestroyed:()=>false,webContents:{send:event=>calls.push(event)},show:()=>calls.push('show'),focus:()=>calls.push('focus')};
  const context={chatMemoryWindow:window};vm.createContext(context);vm.runInContext(entry,context);context.editChatMemory();assert.deepEqual(calls,['pet:memory-open','show','focus']);
});
test('a new memory entry uses the fish-memory title and the existing protected memory renderer',()=>{
  let options,loaded,finished;const window={webContents:{on:(name,fn)=>{if(name==='did-finish-load')finished=fn;}},on:()=>{},show:()=>{}};
  const context={chatMemoryWindow:null,options:()=>({webPreferences:{sandbox:true,contextIsolation:true}}),BrowserWindow:function(value){options=value;return window;},loadLocalFile:(target,value)=>{assert.equal(target,window);loaded=value;},broadcast:()=>{}};
  vm.createContext(context);vm.runInContext(entry,context);context.editChatMemory();assert.equal(options.title,'鱼的记忆');assert.equal(options.webPreferences.sandbox,true);assert.equal(loaded.view,'chat-memory');assert.equal(context.chatMemoryWindow,window);assert.equal(typeof finished,'function');
});
test('preload memory-open subscription is scoped and disposable',()=>{
  let api,listener,removed,opened=0;const ipcRenderer={on:(event,fn)=>{assert.equal(event,'pet:memory-open');listener=fn;},removeListener:(event,fn)=>{removed=[event,fn];}};
  vm.runInNewContext(fs.readFileSync(path.join(base,'preload.cjs'),'utf8'),{require:()=>({ipcRenderer,contextBridge:{exposeInMainWorld:(_name,value)=>api=value}})});
  const off=api.onMemoryOpen(()=>opened++);listener();assert.equal(opened,1);off();assert.equal(removed[0],'pet:memory-open');assert.equal(removed[1],listener);
});
