'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(path.resolve(__dirname,'../../apps/neko-workbench/main.cjs'),'utf8');

test('screen panel IPC delegates to its own authority; workbench may only hide from its trusted main frame',async()=>{
 const contents={mainFrame:{url:'http://127.0.0.1:59099/coding'}},host={webContents:contents,isDestroyed:()=>false};
 const handlers=new Map(),calls=[];
 const validation=source.slice(source.indexOf('function isWorkbenchOrigin'),source.indexOf('function rolesState'));
 const routes=source.slice(source.indexOf("ipcMain.handle('screen-share:call'"),source.indexOf("ipcMain.handle('workbench:community'"));
 vm.runInNewContext(validation+routes,{URL,dshWindow:host,dshLaunchUrl:'http://127.0.0.1:59099/',ipcMain:{handle:(name,fn)=>handlers.set(name,fn)},screenShare:{action:(...args)=>{calls.push(args);return {ok:true};},hide:()=>calls.push('hide')}});
 const caller={sender:contents,senderFrame:contents.mainFrame};
 assert.equal((await handlers.get('workbench:screen-share')(caller,'hide')).ok,true);
 await assert.rejects(handlers.get('workbench:screen-share')(caller,'start'),/未知屏幕操作/);
 await assert.rejects(handlers.get('workbench:screen-share')({...caller,senderFrame:{url:contents.mainFrame.url}},'hide'),/工作台/);
 contents.mainFrame.url='https://community.project-neko.cn/';
 await assert.rejects(handlers.get('workbench:screen-share')(caller,'hide'),/工作台/);
 assert.deepEqual(calls,['hide']);
 const panelCaller={sender:'panel'};handlers.get('screen-share:call')(panelCaller,'frame',{seq:1});
 assert.equal(calls[1][0],panelCaller);assert.equal(calls[1][1],'frame');
});

test('state serialization never persists screen feedback',()=>{
 const calls=[],saved={actors:[{id:'main',chatBackend:'neko',screenReply:{text:'PRIVATE_SCREEN'},name:'cat'}]};
 const save=source.slice(source.indexOf('function save(){'),source.indexOf('function broadcast(){'));
 const saveFn=vm.runInNewContext(save+';save',{state:saved,data:'/tmp/fixture',path,fs:{writeFileSync:(_file,value)=>calls.push(value),renameSync(){}}});
 saveFn();assert(!calls[0].includes('PRIVATE_SCREEN'));assert.equal(JSON.parse(calls[0]).actors[0].name,'cat');
});
