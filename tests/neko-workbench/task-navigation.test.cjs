'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
function bundle(){let entry;const sandbox={window:{__ModuleLoader__:{load:x=>entry=x}},setTimeout,clearTimeout};vm.runInNewContext(fs.readFileSync(path.resolve(__dirname,'../../apps/neko-workbench/embedded-dsh/b0-skin/packages/dsh-client-ui-white-label/lib/client.js'),'utf8'),sandbox);return entry.factory(name=>name==='react'?{createElement(){}}:{createPortal(){}});}
const tick=()=>new Promise(resolve=>setImmediate(resolve));
test('task navigation uses native session identity, deduplicates broadcasts, and ignores late initial state',async()=>{
 const api=bundle(),opened=[],listeners=new Set();let finish;
 const bridge={getState:()=>new Promise(resolve=>finish=resolve),subscribe:callback=>{listeners.add(callback);return()=>listeners.delete(callback);}};
 const dispose=api.subscribeSessionNavigation(bridge,id=>opened.push(id));
 const emit=value=>{for(const callback of listeners)callback({navigation:value});};
 emit({revision:2,sessionId:'actual-task'});emit({revision:2,sessionId:'actual-task'});
 finish({navigation:{revision:1,sessionId:'old-task'}});await tick();assert.deepEqual(opened,['actual-task']);
 emit({revision:3,sessionId:'invalid id'});assert.deepEqual(opened,['actual-task']);
 dispose();emit({revision:4,sessionId:'gone'});assert.equal(listeners.size,0);assert.equal(opened.length,1);
});
test('navigation failures report only for the current request and never after unload',async()=>{
 const api=bundle(),listeners=new Set(),errors=[];let fail;
 const bridge={getState:async()=>({}),subscribe:callback=>{listeners.add(callback);return()=>listeners.delete(callback);}};
 const dispose=api.subscribeSessionNavigation(bridge,()=>new Promise((_resolve,reject)=>fail=reject),()=>errors.push('failed'));
 for(const callback of listeners)callback({navigation:{revision:1,sessionId:'real-task'}});
 fail(new Error('private upstream detail'));await tick();assert.deepEqual(errors,['failed']);
 for(const callback of listeners)callback({navigation:{revision:2,sessionId:'next-task'}});
 dispose();fail(new Error('late error'));await tick();assert.deepEqual(errors,['failed']);
});
