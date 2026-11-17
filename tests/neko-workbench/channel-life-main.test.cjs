'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../../apps/neko-workbench/main.cjs'),'utf8');
test('desktop context menu offers separate memory/proactive toggles and does not generate on configuration',()=>{
  const saved=[],snapshot={memoryEnabled:true,proactiveEnabled:false,pending:2,remembered:3};let checked=0;
  const context={channelLife:{status:()=>snapshot,configure:p=>saved.push(p),tick:()=>checked++}};
  const start=source.indexOf('function channelLifeMenu(){'),end=source.indexOf('\nfunction mainMenu()',start);vm.createContext(context);vm.runInContext(source.slice(start,end),context);const menu=context.channelLifeMenu();
  assert.equal(menu[0].checked,true);assert.equal(menu[1].checked,false);menu[1].click({checked:true});assert.equal(saved[0].proactiveEnabled,true);assert.equal(checked,0);menu[2].click();assert.equal(checked,1);
});
test('channel experience frames bypass raw event logging and replay never reingests them',()=>{
  const accepted=[];const context={channelLife:{accept:e=>accepted.push(e)},fs:{appendFileSync(){throw Error('raw channel text must not be logged');}}};
  const start=source.indexOf('function receive(message,replay=false){'),end=source.indexOf('\nasync function connect(',start);assert(end>start);vm.createContext(context);vm.runInContext(source.slice(start,end),context);
  const entry={channel:'qq',text:'private synthetic text'};context.receive({method:'channel-experience',params:entry});context.receive({method:'channel-experience',params:entry},true);assert.equal(accepted.length,1);assert.equal(accepted[0],entry);
});
