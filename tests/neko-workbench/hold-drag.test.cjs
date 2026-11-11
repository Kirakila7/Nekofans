'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),path=require('node:path');
const {JSDOM}=require(path.join(process.env.NEKO_DOM_DEPS,'node_modules/jsdom'));
const install=require('../../apps/neko-workbench/hold-drag.js');
const pause=()=>new Promise(r=>setTimeout(r,20));
function fixture(t){const dom=new JSDOM('<textarea>未发送内容</textarea><button>发送</button>',{pretendToBeVisual:true});t.after(()=>dom.window.close());const w=dom.window,sent=[];const release=install(w.document,value=>sent.push(value),{delay:10});t.after(release);const event=(target,type,x,y)=>target.dispatchEvent(new w.MouseEvent(type,{button:0,screenX:x,screenY:y,bubbles:true,cancelable:true}));return {w,sent,event,text:w.document.querySelector('textarea'),button:w.document.querySelector('button')};}
test('long hold anywhere moves the window and never also sends or edits a draft',async t=>{const f=fixture(t);let clicks=0;f.button.onclick=()=>clicks++;f.event(f.button,'pointerdown',100,100);await pause();f.event(f.button,'pointermove',145,120);f.event(f.button,'pointerup',145,120);f.button.click();assert.equal(clicks,0);assert.deepEqual(f.sent,[{dx:45,dy:20},{dx:0,dy:0,finished:true}]);assert.equal(f.text.value,'未发送内容');f.event(f.text,'pointerdown',200,150);await pause();f.event(f.text,'pointermove',170,145);assert.equal(f.sent.at(-1).dx,-30);});
test('ordinary clicks and text selection retain normal behavior; movement before threshold cancels window dragging',async t=>{const f=fixture(t);let clicks=0;f.button.onclick=()=>clicks++;f.event(f.button,'pointerdown',0,0);f.event(f.button,'pointerup',0,0);f.button.click();assert.equal(clicks,1);f.event(f.text,'pointerdown',0,0);f.event(f.text,'pointermove',20,0);await pause();f.event(f.text,'pointermove',40,0);assert.equal(f.sent.length,0);});
test('only a moved drag followed by normal release emits one snap completion',async t=>{
 const f=fixture(t);
 f.event(f.text,'pointerdown',0,0);await pause();f.event(f.text,'pointerup',0,0);assert.equal(f.sent.length,0,'holding without movement does not snap');
 for(const cancel of ['pointercancel','blur','Escape']){
  f.event(f.text,'pointerdown',0,0);await pause();f.event(f.text,'pointermove',4,5);
  if(cancel==='blur')f.w.dispatchEvent(new f.w.Event('blur'));else if(cancel==='Escape')f.w.document.dispatchEvent(new f.w.KeyboardEvent('keydown',{key:'Escape',bubbles:true}));else f.event(f.text,cancel,4,5);
  f.event(f.text,'pointerup',4,5);
 }
 assert.equal(f.sent.some(message=>message.finished),false,'cancel, focus loss and Escape never complete a snap');
 f.event(f.text,'pointerdown',0,0);await pause();f.event(f.text,'pointermove',12,8);f.event(f.text,'pointerup',12,8);f.event(f.text,'pointerup',12,8);
 assert.equal(f.sent.filter(message=>message.finished).length,1);
});
test('remote-site mode ignores script-generated gestures',async t=>{const dom=new JSDOM('<button>page</button>');t.after(()=>dom.window.close());const w=dom.window,sent=[],release=install(w.document,d=>sent.push(d),{delay:1,trustedOnly:true});t.after(release);const b=w.document.querySelector('button');b.dispatchEvent(new w.MouseEvent('pointerdown',{button:0,bubbles:true,screenX:0,screenY:0}));await pause();b.dispatchEvent(new w.MouseEvent('pointermove',{bubbles:true,screenX:100,screenY:100}));assert.equal(sent.length,0);});
test('remote preload runs in an Electron sandbox without a Node module global or page API exposure',async t=>{
 const fs=require('node:fs'),vm=require('node:vm'),dom=new JSDOM('<html><head></head><body></body></html>');t.after(()=>dom.window.close());const calls=[];let ready;
 const w=dom.window,environment={process:{isMainFrame:true},window:{addEventListener:(name,fn)=>{if(name==='DOMContentLoaded')ready=fn;}},document:w.document,require:name=>{assert.equal(name,'electron');return {ipcRenderer:{send:(...args)=>calls.push(args)}};}};
 vm.runInNewContext(fs.readFileSync(path.resolve(__dirname,'../../apps/neko-workbench/video-gesture-preload.cjs'),'utf8'),environment);assert.equal(typeof ready,'function');ready();assert(w.document.head.querySelector('style'));assert.equal(environment.module,undefined);assert.equal(environment.ipcRenderer,undefined);assert.equal(calls.length,0);
});
