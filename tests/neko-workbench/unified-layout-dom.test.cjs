'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
let JSDOM; try { ({ JSDOM } = require(path.join(process.env.NEKO_DOM_DEPS || '/private/tmp/neko-sidebar-dom-20261026', 'node_modules/jsdom'))); } catch {}
const sleep = () => new Promise(resolve => setTimeout(resolve, 40));
const source = fs.readFileSync(path.join(__dirname, '../../apps/neko-workbench/embedded-dsh/unified-layout-source.js'), 'utf8');
function fixture(t) {
  const dom = new JSDOM('<body><aside data-neko-side-rail><div class="neko-workspace-rail-controls"></div></aside><div id="frame" style="display:grid;grid-template-columns:220px 800px 0px"><div id="track"><aside data-slot="sidebar"><section class="neko-companion-dock"><textarea>personal draft</textarea></section><div data-slot="settings.launcher"></div></aside></div><div class="some_centerCol_HASH_42"><textarea id="draft">coding draft</textarea></div><div></div></div></body>', { runScripts:'outside-only', pretendToBeVisual:true });
  t.after(() => dom.window.close()); const w=dom.window, d=w.document;
  d.querySelector('#frame').getBoundingClientRect=()=>({left:64,top:0,right:1084,bottom:780,width:1020,height:780});
  d.querySelector('[data-slot="sidebar"]').getBoundingClientRect=()=>({left:64,top:0,right:284,bottom:780,width:220,height:780});
  d.querySelector('.neko-companion-dock').getBoundingClientRect=()=>({left:64,top:640,right:284,bottom:730,width:220,height:90});
  let saved={enabled:false,side:'workspace',left:'coding',right:null,ratio:.5}, listener=null, legacyClosed=0;
  const calls=[];
  const bridge={ workspace: async r => { calls.push(r); if(r.action==='pane-layout')return {...saved}; if(r.action==='set-pane-layout'){saved={...r.layout};return {...saved};} throw Error('bad request'); }, community: async r=>{calls.push(r);return {ok:true};}, subscribeCommunity:fn=>{listener=fn;return()=>{listener=null;};} };
  w.eval(source+'\nwindow.startUnified=installUnifiedLayout;');
  const cleanup=w.startUnified({document:d,window:w,bridge,hideLegacy:()=>legacyClosed++,cssText:''});
  return {w,d,bridge,calls,cleanup,get saved(){return saved},get listener(){return listener},get legacyClosed(){return legacyClosed}};
}
async function openConfig(f) { f.d.querySelector('.neko-layout-entry').click(); await sleep(); }
function select(f, type, value) { f.d.querySelector(`[data-${type}="${value}"]`).click(); }
test('disabled-by-default layout preserves native DSH draft and configures real isolated slots', {skip:!JSDOM}, async t=>{
  const f=fixture(t);await sleep();assert.equal(f.saved.enabled,false);assert.equal(f.calls.filter(x=>x.action==='open').length,0);
  await openConfig(f); select(f,'target','side');select(f,'content','community');await sleep();
  assert.equal(f.saved.side,'community');assert.equal(f.saved.enabled,true);assert.equal(f.legacyClosed,1);
  assert.equal(f.calls.filter(x=>x.action==='open').length,0,'native views stay detached while settings overlay is open');
  f.d.querySelector('.neko-unified-config .close').click();await sleep();
  let opened=f.calls.find(x=>x.action==='open'&&x.slot==='side');assert(opened);assert.equal(opened.site,'community');
  assert.equal(opened.bounds.height,598,'side stops above companion and accounts, reserving the measured 42px toolbar');
  assert.equal(f.d.querySelector('#draft').value,'coding draft');
  await openConfig(f); select(f,'target','right');select(f,'content','bilibili');await sleep();f.d.querySelector('.neko-unified-config .close').click();await sleep();
  opened=f.calls.find(x=>x.action==='open'&&x.slot==='right');assert(opened);assert.equal(opened.site,'bilibili');
  const center=f.d.querySelector('.some_centerCol_HASH_42');assert(center.hasAttribute('data-neko-unified-coding'));
  assert.equal(center.style.getPropertyValue('--neko-code-width'),'400px');assert.equal(center.style.getPropertyValue('--neko-code-align'),'start');
  assert.equal(f.d.querySelector('#draft').value,'coding draft');assert.equal(f.d.querySelector('.neko-companion-dock textarea').value,'personal draft');
  f.listener({site:'bilibili',slot:'right',status:'ready',canPlayOfficial:true,canShare:true});
  assert.equal(f.d.querySelector('[data-neko-unified-slot="right"] button:nth-of-type(3)').disabled,false);
  f.cleanup(); assert(!center.hasAttribute('data-neko-unified-coding'));assert(!center.hasAttribute('inert'));assert(!f.d.querySelector('[data-neko-unified-config]'));
});
test('drag selection provides real drop targets even while social views are covered', {skip:!JSDOM}, async t=>{
  const f=fixture(t);await sleep();await openConfig(f);
  const source=f.d.querySelector('[data-content="community"]');const e=new f.w.Event('dragstart',{bubbles:true});Object.defineProperty(e,'dataTransfer',{value:{setData(){},effectAllowed:''}});source.dispatchEvent(e);
  const zone=f.d.querySelector('[data-neko-drop-slot="side"]');assert.equal(zone.hidden,false);
  zone.dispatchEvent(new f.w.Event('drop',{bubbles:true,cancelable:true}));await sleep();await sleep();
  assert.equal(f.saved.enabled,true);assert.equal(f.saved.side,'community');assert.equal(f.d.querySelector('.neko-unified-config').hidden,true);
  assert(f.calls.some(x=>x.action==='open'&&x.slot==='side'&&x.site==='community'));
  f.cleanup();
});
test('window hide and show restores native panels without opening views while hidden', {skip:!JSDOM}, async t=>{
  const f=fixture(t); await sleep(); await openConfig(f); select(f,'target','right'); select(f,'content','community'); await sleep();
  f.d.querySelector('.neko-unified-config .close').click(); await sleep();
  let opened=f.calls.filter(x=>x.action==='open' && x.slot==='right'); assert.equal(opened.length,1);
  let visibility='hidden'; Object.defineProperty(f.d,'visibilityState',{ configurable:true, get:()=>visibility });
  f.listener({slot:'right',site:'community',status:'hidden',requestId:opened[0].requestId});
  f.d.dispatchEvent(new f.w.Event('visibilitychange')); await new Promise(resolve=>setTimeout(resolve,260));
  assert.equal(f.calls.filter(x=>x.action==='open' && x.slot==='right').length,1,'must not reopen while window hidden');
  visibility='visible'; f.d.dispatchEvent(new f.w.Event('visibilitychange')); await sleep();
  opened=f.calls.filter(x=>x.action==='open' && x.slot==='right'); assert.equal(opened.length,2,'show reopens missing native view');
  assert.equal(f.d.querySelector('#draft').value,'coding draft'); f.cleanup();
});
test('account and settings overlays temporarily detach native views, then restore them', {skip:!JSDOM}, async t=>{
  const f=fixture(t); await sleep(); await openConfig(f); select(f,'target','right'); select(f,'content','community'); await sleep();
  f.d.querySelector('.neko-unified-config .close').click(); await sleep();
  const count=action=>f.calls.filter(x=>x.action===action && x.slot==='right').length;
  assert.equal(count('open'),1);
  const dialog=f.d.createElement('div'); dialog.className='neko-workspace-modal'; dialog.setAttribute('role','dialog'); f.d.body.appendChild(dialog); await sleep();
  assert.equal(count('hide'),1,'settings must not be covered by native view');
  dialog.hidden=true; await sleep(); assert.equal(count('open'),2,'native view comes back after settings closes');
  const account=f.d.createElement('button'); account.setAttribute('aria-expanded','false'); f.d.querySelector('[data-slot="settings.launcher"]').appendChild(account); await sleep();
  account.setAttribute('aria-expanded','true'); await sleep(); assert.equal(count('hide'),2,'account popup remains above content');
  account.setAttribute('aria-expanded','false'); await sleep(); assert.equal(count('open'),3,'native view comes back after account closes');
  f.cleanup();
});
