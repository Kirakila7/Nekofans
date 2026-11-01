'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
let JSDOM;try{({JSDOM}=require(path.join(process.env.NEKO_DOM_DEPS||'/private/tmp/neko-sidebar-dom-20261026','node_modules/jsdom')));}catch{}
const source=fs.readFileSync(path.resolve(__dirname,'../../apps/neko-workbench/embedded-dsh/chatroom-preview-source.js'),'utf8');
const tick=()=>new Promise(resolve=>setTimeout(resolve,0));
function fixture(t,options){
 const dom=new JSDOM('<body><textarea>未发送草稿</textarea></body>',{runScripts:'outside-only'});t.after(()=>dom.window.close());
 const w=dom.window;w.eval(source+'\nwindow.createPreview=createChatroomPreview');const panel=w.createPreview(w.document,()=>'',options);w.document.body.append(panel);
 return {w,panel,home:panel.querySelector('button[aria-label*="我的小窝"]'),back:panel.querySelector('.neko-chatroom-preview__home-back'),stage:panel.querySelector('[data-neko-home-stage]'),view:panel.querySelector('.neko-chatroom-preview__home-view'),room:panel.querySelector('.neko-chatroom-preview__room-view'),status:panel.querySelector('[role=status]'),retry:panel.querySelector('.neko-chatroom-preview__home-retry')};
}
test('home opens in the main work area and stays mounted across return without changing drafts',{skip:!JSDOM},async t=>{
 let resolveMount,calls=0,cleanups=0;const f=fixture(t,{mountHome:stage=>{calls++;assert.equal(stage,f.stage);return new Promise(resolve=>{resolveMount=resolve;});}});
 assert(f.panel.querySelector('input').disabled);assert.match(f.panel.textContent,/聊天功能尚未开放/);f.home.click();assert(!f.room.hidden,'the room list stays visible while home opens on the right');assert(!f.view.hidden);assert.match(f.panel.textContent,/工作台本地存档 · 尚未同步/);assert.match(f.status.textContent,/正在准备/);assert.equal(f.w.document.activeElement,f.back);
 f.back.click();f.home.click();assert.equal(calls,1,'a pending mount is not duplicated');resolveMount(()=>{cleanups++;});await tick();assert(f.status.hidden);f.back.click();assert(!f.room.hidden);assert(f.view.hidden);assert.equal(f.w.document.activeElement,f.home);f.home.click();assert.equal(calls,1,'returning preserves the mounted home');assert.equal(f.w.document.querySelector('textarea').value,'未发送草稿');f.panel.disposeHome();assert.equal(cleanups,1);
});
test('unavailable or failed home mounting is visible and retryable',{skip:!JSDOM},async t=>{
 const missing=fixture(t,{});missing.home.click();await tick();assert.match(missing.status.textContent,/暂不可用/);assert(!missing.retry.hidden);
 let calls=0;const f=fixture(t,{mountHome:async()=>{calls++;if(calls===1)throw Error('家园资源无法加载');}});f.home.click();await tick();assert.match(f.status.textContent,/家园资源无法加载/);f.retry.click();await tick();assert(f.status.hidden);assert(f.retry.hidden);assert.equal(calls,2);
});
test('a late mount after disposal is cleaned up',{skip:!JSDOM},async t=>{
 let resolveMount,cleanups=0;const f=fixture(t,{mountHome:()=>new Promise(resolve=>{resolveMount=resolve;})});f.home.click();f.panel.disposeHome();resolveMount(()=>{cleanups++;});await tick();assert.equal(cleanups,1);
});
