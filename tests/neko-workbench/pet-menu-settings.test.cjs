'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../../apps/neko-workbench/main.cjs'),'utf8');
test('speech duration menu defaults to one minute and applies saved duration through update',()=>{
 let updates=0;const context={state:{preferences:{}},update:()=>updates++};vm.createContext(context);
 vm.runInContext(source.slice(source.indexOf('function speechDurationMenu(){'),source.indexOf('\nfunction mainMenu()')),context);
 let menu=context.speechDurationMenu();assert.match(menu.find(x=>x.checked).label,/1 分钟/);menu.find(x=>x.label==='2 分钟').click();
 assert.equal(context.state.preferences.petSpeechDurationMs,120000);assert.equal(updates,1);assert.equal(context.speechDurationMenu().find(x=>x.checked).label,'2 分钟');
});
test('settings IPC validates the original settings window before read or save',async()=>{
 let handler,saved;const window={},context={ipcMain:{handle:(_name,h)=>handler=h},communityDailySettingsWindow:window,
 assertLocalCaller:(event,w)=>{assert.equal(w,window);if(event.sender!=='trusted')throw Error('untrusted');},communityDaily:{status:()=>({sendTime:'21:30',style:'轻松'}),saveSettings:p=>saved=p}};
 vm.runInNewContext(source.slice(source.indexOf("ipcMain.handle('workbench:community-daily-settings'"),source.indexOf('function ensureVisitsController()')),context);
 await assert.rejects(handler({sender:'foreign'},'save',{sendTime:'01:00'}),/untrusted/);assert.equal(saved,undefined);
 const value={sendTime:'21:30',style:'轻松'};assert.equal((await handler({sender:'trusted'},'read')).sendTime,'21:30');await handler({sender:'trusted'},'save',value);assert.equal(saved,value);await assert.rejects(handler({sender:'trusted'},'publish'),/未知/);
});
test('desktop menu exposes visits and memory without removed task/reply/artifact entries',()=>{
 const menu=source.slice(source.indexOf('function mainMenu(){'),source.indexOf('\nfunction createPetWindow'));
 for(const label of ['工作台选项','产出文件','停止任务','最近回复','停止聊天回复'])assert(!menu.includes(`label:'${label}'`),label);
 assert(menu.includes("label:'串门',click:openVisits"));assert(menu.includes("label:'记忆',submenu:memoryMenu()"));assert(menu.includes("label:'说话显示时长'"));
});
