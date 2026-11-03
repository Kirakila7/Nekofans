'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../../apps/neko-workbench/main.cjs'),'utf8');
const start=source.indexOf('async function openDsh(){'),end=source.indexOf('\nfunction editMemory()',start);
function fixture({hidden=false,minimized=false,loading=false,workbenchOnly=false}={}){
  const calls=[];const main={id:'main'};
  const pet={visible:!hidden,isMinimized:()=>minimized,restore(){minimized=false;calls.push('restore');},showInactive(){this.visible=true;calls.push('pet-show');},webContents:{isLoading:()=>loading}};
  const host={isDestroyed:()=>false,show(){calls.push('workbench-show');},focus(){calls.push('workbench-focus');}};
  const context={workbenchOnly,state:{actors:[main]},dshWindow:host,createPetWindow(actor){assert.equal(actor,main);calls.push('pet-create');return pet;},app:{focus(){}}};
  vm.createContext(context);vm.runInContext(source.slice(start,end)+';globalThis.open=openDsh;',context);
  return {context,pet,calls};
}
test('reopening the existing workbench restores the hidden main pet before focusing the host',async()=>{
  const f=fixture({hidden:true});await f.context.open();assert.equal(f.pet.visible,true);assert.deepEqual(f.calls,['pet-create','pet-show','workbench-show','workbench-focus']);
});
test('a minimized pet is restored even when its window is already visible',async()=>{
  const f=fixture({minimized:true});await f.context.open();assert.deepEqual(f.calls,['pet-create','restore','pet-show','workbench-show','workbench-focus']);
});
test('a loading pet waits for its existing did-finish-load display handler',async()=>{
  const f=fixture({hidden:true,loading:true});await f.context.open();assert(!f.calls.includes('pet-show'));assert(f.calls.includes('workbench-show'));
});
test('workbench-only visual QA does not create or reveal desktop pets',async()=>{
  const f=fixture({hidden:true,workbenchOnly:true});await f.context.open();assert.deepEqual(f.calls,['workbench-show','workbench-focus']);
});
