'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {JSDOM}=require(path.join(process.env.NEKO_DOM_DEPS||'/private/tmp/neko-sidebar-dom-20261026','node_modules/jsdom'));
const base=path.resolve(__dirname,'../../apps/neko-workbench');
async function fixture(t,initial){const dom=new JSDOM(fs.readFileSync(path.join(base,'video-float.html'),'utf8'),{runScripts:'outside-only'});t.after(()=>dom.window.close());const w=dom.window,requests=[];let publish,drag;w.installNekoHoldDrag=(_doc,send)=>{drag=send;};w.videoFloat={action:async request=>{requests.push(request);return initial;},subscribe:fn=>{publish=fn;}};w.eval(fs.readFileSync(path.join(base,'video-float.js'),'utf8'));await Promise.resolve();return {w,d:w.document,requests,publish,drag:delta=>drag(delta)};}
test('video overlays expose a top-left close control and bottom-right expand control',async t=>{
 const f=await fixture(t,{site:'bilibili',expanded:false}),b=f.d.getElementById('expand'),close=f.d.getElementById('close');assert(close.hidden);assert(!b.hidden);b.click();assert.equal(f.requests.at(-1).action,'toggle-expanded');f.publish({expanded:true});assert.equal(b.getAttribute('aria-expanded'),'true');assert.equal(b.getAttribute('aria-label'),'收起视频浮窗');assert(!f.d.querySelector('header,footer,.surface'));
 const dom=new JSDOM(fs.readFileSync(path.join(base,'video-float.html'),'utf8'),{url:'https://local.invalid/?control=close',runScripts:'outside-only'});t.after(()=>dom.window.close());const calls=[];dom.window.videoFloat={action:async r=>{calls.push(r);return{};},subscribe(){}};dom.window.eval(fs.readFileSync(path.join(base,'video-float.js'),'utf8'));assert(!dom.window.document.getElementById('close').hidden);assert(dom.window.document.getElementById('expand').hidden);dom.window.document.getElementById('close').click();assert.equal(calls.at(-1).action,'close');
});

test('trusted video chrome forwards the final hold-drag marker separately from intermediate motion',async t=>{
 const f=await fixture(t,{site:'bilibili',expanded:false});
 f.drag({dx:7,dy:-4});f.drag({dx:0,dy:0,finished:true});await Promise.resolve();
 assert.deepEqual(JSON.parse(JSON.stringify(f.requests.slice(-2))),[{action:'move',dx:7,dy:-4},{action:'move',dx:0,dy:0,finished:true}]);
});
