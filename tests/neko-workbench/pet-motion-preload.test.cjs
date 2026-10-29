'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
test('pet motion bridge exposes only payloads, can unsubscribe, and keeps IPC invocation allowlisted',async()=>{
  let bridge;const listeners=new Map(),calls=[];
  const ipcRenderer={on:(channel,handler)=>listeners.set(channel,handler),removeListener:(channel,handler)=>{if(listeners.get(channel)===handler)listeners.delete(channel);},invoke:(...args)=>{calls.push(args);return Promise.resolve(true);}};
  vm.runInNewContext(fs.readFileSync(path.resolve(__dirname,'../../apps/neko-workbench/preload.cjs'),'utf8'),{require:name=>{assert.equal(name,'electron');return {contextBridge:{exposeInMainWorld:(name,value)=>{assert.equal(name,'pet');bridge=value;}},ipcRenderer};}});
  const received=[];const unsubscribe=bridge.onMotion((...args)=>received.push(args));
  const payload={phase:'exploring',moving:true},event={sender:'private'};
  listeners.get('pet:motion')(event,payload);
  assert.equal(received.length,1);assert.equal(received[0].length,1);assert.equal(received[0][0],payload);
  unsubscribe();assert.equal(listeners.has('pet:motion'),false);
  await bridge.call('motion-input',{active:true});await bridge.call('pass-through',{ignore:true});
  assert.equal(calls[0][0],'pet:call');assert.equal(calls[0][1],'motion-input');assert.equal(calls[1][1],'pass-through');
  await assert.rejects(bridge.call('arbitrary-channel'),/未知桌宠操作/);assert.equal(calls.length,2);
});
