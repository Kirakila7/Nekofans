'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
let JSDOM;
try { ({ JSDOM } = createRequire(path.join(process.env.NEKO_DOM_DEPS || __dirname, 'package.json'))('jsdom')); } catch {}
const source = fs.readFileSync(path.join(__dirname, '../../apps/neko-workbench/embedded-dsh/side-rail-source.js'), 'utf8');
const tick = w => new Promise(resolve => w.setTimeout(resolve, 0));

function fixture(t) {
  const dom = new JSDOM('<body><div id="app"><div id="frame" style="display:grid;grid-template-columns:280px minmax(0px, 1fr) 0px"><aside data-slot="sidebar"><div data-slot="settings.launcher"></div></aside><main class="native_centerCol_hash"><textarea>unsent draft</textarea></main></div></div></body>', {url:'http://127.0.0.1/',runScripts:'outside-only',pretendToBeVisual:true});
  t.after(() => dom.window.close());
  const w = dom.window, d = w.document, frame = d.querySelector('#frame'), center = d.querySelector('main');
  let frameWidth = 1000, reserved = 0;
  frame.getBoundingClientRect = () => ({ left:64, right:64+frameWidth, top:0, bottom:700, width:frameWidth, height:700 });
  center.getBoundingClientRect = () => ({ left:344, right:64+frameWidth-reserved, top:0, bottom:700, width:Math.max(1,frameWidth-280-reserved), height:700 });
  w.eval(source+'\nwindow.install=installWorkbenchSideRail');
  const cleanup = w.install({document:d,window:w,bridge:{action:async()=>{}},openBilibiliHome:async()=>{}});
  return {w,d,frame,center,cleanup,setWidth:n=>{frameWidth=n;w.dispatchEvent(new w.Event('resize'));},setReserved:n=>{reserved=n;w.dispatchEvent(new w.Event('resize'));}};
}
function pointer(w, target, type, x) {
  const e = new w.MouseEvent(type,{bubbles:true,button:0,clientX:x}); Object.defineProperty(e,'pointerId',{value:8}); target.dispatchEvent(e);
}

test('chatroom starts 3:1, drags widely, retains its session ratio and keeps coding draft', {skip:!JSDOM}, async t => {
  const f = fixture(t); f.d.body.setAttribute('data-neko-chatroom-active',''); await tick(f.w);
  const handle = f.d.querySelector('.neko-chat-sidebar-divider'); assert(!handle.hidden);
  assert.equal(f.frame.style.getPropertyValue('--neko-chat-sidebar-grid'), '750px minmax(0px, 1fr) 0px');
  assert.equal(handle.getAttribute('aria-valuenow'),'75');
  assert(f.center.hasAttribute('data-neko-chat-center'));
  pointer(f.w,handle,'pointerdown',814); pointer(f.w,handle,'pointermove',264); await tick(f.w);
  assert.equal(f.frame.style.getPropertyValue('--neko-chat-sidebar-grid'), '200px minmax(0px, 1fr) 0px');
  pointer(f.w,handle,'pointerup',264); await tick(f.w);
  assert.equal(f.d.querySelector('textarea').value,'unsent draft');
  f.d.body.removeAttribute('data-neko-chatroom-active'); await tick(f.w);
  assert(handle.hidden); assert(!f.frame.hasAttribute('data-neko-chat-sidebar-grid'));
  assert(!f.center.hasAttribute('data-neko-chat-center')); assert.equal(f.frame.style.gridTemplateColumns,'280px minmax(0px, 1fr) 0px');
  f.d.body.setAttribute('data-neko-chatroom-active',''); await tick(f.w); assert.equal(handle.getAttribute('aria-valuenow'),'20');
  f.cleanup(); assert(!f.d.querySelector('.neko-chat-sidebar-divider'));
  const again=f.w.install({document:f.d,window:f.w,bridge:{action:async()=>{}},openBilibiliHome:async()=>{}}); await tick(f.w);
  assert.equal(f.d.querySelector('.neko-chat-sidebar-divider').getAttribute('aria-valuenow'),'75','a fresh workbench uses the requested 3:1 default'); again();
});

test('width adapts on resize, keyboard and reset, and cancelled drags do not persist', {skip:!JSDOM}, async t => {
  const f=fixture(t); f.d.body.setAttribute('data-neko-chatroom-active',''); await tick(f.w);
  const h=f.d.querySelector('.neko-chat-sidebar-divider');
  f.setWidth(800); await tick(f.w);
  pointer(f.w,h,'pointerdown',664); pointer(f.w,h,'pointermove',544); pointer(f.w,h,'pointerup',544); await tick(f.w);
  assert.equal(f.frame.style.getPropertyValue('--neko-chat-sidebar-grid'),'480px minmax(0px, 1fr) 0px');
  pointer(f.w,h,'pointerdown',544); pointer(f.w,h,'pointermove',700); await tick(f.w); pointer(f.w,h,'pointercancel',700); await tick(f.w);
  assert.equal(h.getAttribute('aria-valuenow'),'60');
  h.dispatchEvent(new f.w.KeyboardEvent('keydown',{key:'End',bubbles:true})); await tick(f.w); assert.equal(h.getAttribute('aria-valuenow'),'75');
  h.dispatchEvent(new f.w.MouseEvent('dblclick',{bubbles:true})); await tick(f.w); assert.equal(h.getAttribute('aria-valuenow'),'75');
  f.setReserved(160); await tick(f.w); assert.equal(f.frame.style.getPropertyValue('--neko-chat-sidebar-grid'),'480px minmax(0px, 1fr) 0px');
  f.frame.setAttribute('data-sidebar-collapsed','true'); await tick(f.w); assert(h.hidden); assert(!f.frame.hasAttribute('data-neko-chat-sidebar-grid'));
  f.frame.removeAttribute('data-sidebar-collapsed'); await tick(f.w); assert(!h.hidden);
  f.cleanup();
});

test('community and B站 retain the left width when replacing the chatroom', {skip:!JSDOM}, async t => {
  const f=fixture(t); f.d.body.setAttribute('data-neko-chatroom-active',''); await tick(f.w);
  const h=f.d.querySelector('.neko-chat-sidebar-divider');
  pointer(f.w,h,'pointerdown',814); pointer(f.w,h,'pointermove',564); pointer(f.w,h,'pointerup',564); await tick(f.w);
  assert.equal(f.frame.style.getPropertyValue('--neko-chat-sidebar-grid'),'500px minmax(0px, 1fr) 0px');
  f.d.body.setAttribute('data-neko-side-social-active','community'); f.d.body.removeAttribute('data-neko-chatroom-active'); await tick(f.w);
  assert(!h.hidden); assert.equal(f.frame.style.getPropertyValue('--neko-chat-sidebar-grid'),'500px minmax(0px, 1fr) 0px');
  assert.match(h.getAttribute('aria-valuetext'), /左侧内容 50%.*工作区 50%/);
  f.d.body.setAttribute('data-neko-side-social-active','bilibili'); await tick(f.w);
  assert.equal(f.frame.style.getPropertyValue('--neko-chat-sidebar-grid'),'500px minmax(0px, 1fr) 0px');
  f.d.body.setAttribute('data-neko-chatroom-active',''); f.d.body.removeAttribute('data-neko-side-social-active'); await tick(f.w);
  assert(!h.hidden); assert.equal(h.getAttribute('aria-valuenow'),'50');
  f.d.body.removeAttribute('data-neko-chatroom-active'); await tick(f.w);
  assert(h.hidden); assert(!f.frame.hasAttribute('data-neko-chat-sidebar-grid'));
  assert.equal(f.d.querySelector('textarea').value,'unsent draft'); f.cleanup();
});
