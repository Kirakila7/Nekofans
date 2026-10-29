'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
let JSDOM; try { ({ JSDOM } = require(path.join(process.env.NEKO_DOM_DEPS || '/private/tmp/neko-sidebar-dom-20261026', 'node_modules/jsdom'))); } catch {}
const sleep = () => new Promise(resolve => setTimeout(resolve, 40));
async function waitFor(check, label) {
  const deadline = Date.now() + 5000;
  while (!check()) {
    if (Date.now() >= deadline) assert.fail(`Timed out waiting for ${label}`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
async function nextFrame(w) {
  // Observer callbacks themselves enqueue microtasks. Wait two frames so an
  // update scheduled behind the first sentinel has also had a chance to run.
  await Promise.resolve();
  for (let i=0;i<2;i++) {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Timed out waiting for an animation frame')), 5000);
      w.requestAnimationFrame(() => { clearTimeout(timer); resolve(); });
    });
    await Promise.resolve();
  }
}
const source = fs.readFileSync(path.join(__dirname, '../../apps/neko-workbench/embedded-dsh/unified-layout-source.js'), 'utf8');
function fixture(t, { accountBridge = false, savedLayout = null } = {}) {
  const dom = new JSDOM('<body><aside data-neko-side-rail><div class="neko-workspace-rail-controls"></div><button class="neko-community-yui">社区</button><button class="neko-side-rail__bilibili">B站</button></aside><div id="frame" style="display:grid;grid-template-columns:220px 800px 0px"><div id="track"><aside data-slot="sidebar"><section class="neko-companion-dock"><textarea>personal draft</textarea></section><div data-slot="settings.launcher"></div></aside></div><div class="some_centerCol_HASH_42"><textarea id="draft">coding draft</textarea></div><div></div></div></body>', { runScripts:'outside-only', pretendToBeVisual:true });
  t.after(() => dom.window.close()); const w=dom.window, d=w.document;
  d.querySelector('#frame').getBoundingClientRect=()=>({left:64,top:0,right:1084,bottom:780,width:1020,height:780});
  d.querySelector('[data-slot="sidebar"]').getBoundingClientRect=()=>({left:64,top:0,right:284,bottom:780,width:220,height:780});
  d.querySelector('.neko-companion-dock').getBoundingClientRect=()=>({left:64,top:640,right:284,bottom:730,width:220,height:90});
  let saved=savedLayout || {enabled:false,side:'workspace',left:'coding',right:null,ratio:.5}, listener=null, accountListener=null, legacyClosed=0, releaseAccount;
  const calls=[];
  const bridge={ workspace: async r => { calls.push(r); if(r.action==='pane-layout')return {...saved}; if(r.action==='set-pane-layout'){saved={...r.layout};return {...saved};} throw Error('bad request'); }, community: async r=>{calls.push(r);return {ok:true};}, subscribeCommunity:fn=>{listener=fn;return()=>{listener=null;};} };
  if (accountBridge) {
    bridge.communityAccount = action => { calls.push({action:'account-'+action}); if (action==='connect') return new Promise(resolve=>{releaseAccount=resolve;}); return Promise.resolve({status:'idle',message:'已取消连接'}); };
    bridge.subscribeCommunityAccount = fn => { accountListener=fn; return()=>{accountListener=null;}; };
  }
  w.eval(source+'\nwindow.startUnified=installUnifiedLayout;');
  const cleanup=w.startUnified({document:d,window:w,bridge,hideLegacy:()=>legacyClosed++,cssText:''});
  return {w,d,bridge,calls,cleanup,get saved(){return saved},get listener(){return listener},get accountListener(){return accountListener},get releaseAccount(){return releaseAccount},get legacyClosed(){return legacyClosed}};
}
async function openConfig(f) { f.d.querySelector('.neko-layout-entry').click(); await sleep(); }
function select(f, type, value) { f.d.querySelector(`[data-${type}="${value}"]`).click(); }
test('startup uses two areas without overwriting saved multi-pane layout and can restore it', {skip:!JSDOM}, async t=>{
  const previous={enabled:true,side:'workspace',left:'community',right:'bilibili',ratio:.4};
  const f=fixture(t,{savedLayout:previous}); await sleep();
  assert.deepEqual(f.saved,previous); assert.equal(f.calls.filter(x=>x.action==='set-pane-layout').length,0);
  assert.equal(f.calls.filter(x=>x.action==='open').length,0,'no native site opens by default');
  assert.equal(f.d.querySelector('#draft').value,'coding draft');
  await openConfig(f); const restore=[...f.d.querySelectorAll('.neko-unified-config button')].find(b=>b.textContent==='恢复上次多栏布局');
  assert(restore && !restore.hidden); restore.click(); f.d.querySelector('.neko-unified-config .close').click();
  await waitFor(()=>f.calls.some(x=>x.action==='open'&&x.slot==='left'&&x.site==='community')&&f.calls.some(x=>x.action==='open'&&x.slot==='right'&&x.site==='bilibili'),'restored native views');
  assert.deepEqual(f.saved,previous); assert.equal(f.calls.filter(x=>x.action==='set-pane-layout').length,0,'restore reuses saved layout without rewriting');
  f.cleanup();
});
test('rail shortcuts open an optional middle panel while preserving coding and can close it', {skip:!JSDOM}, async t=>{
  for (const [selector,site] of [['.neko-side-rail__bilibili','bilibili'],['.neko-community-yui','community']]) {
    const f=fixture(t); await sleep(); f.d.querySelector(selector).click();
    await waitFor(()=>f.calls.some(x=>x.action==='open'&&x.slot==='left'&&x.site===site),'shortcut opens adjacent pane');
    assert.equal(f.saved.left,site); assert.equal(f.saved.right,'coding'); assert.equal(f.d.querySelector('#draft').value,'coding draft');
    const panel=f.d.querySelector('[data-neko-unified-slot="left"]');
    const back=[...panel.querySelectorAll('button')].find(b=>b.textContent==='返回工作区');
    assert(back && !back.disabled); back.click();
    await waitFor(()=>f.calls.some(x=>x.action==='hide'&&x.slot==='left'),'optional pane closes');
    assert.equal(f.saved.left,null); assert.equal(f.saved.right,'coding');
    assert.equal(f.calls.filter(x=>x.action==='open'&&x.slot==='right'&&x.site===site).length,0,'site does not move into coding pane');
    f.cleanup();
  }
});
test('community identity entry works in a multi-pane layout without affecting Bilibili', {skip:!JSDOM}, async t=>{
  const f=fixture(t,{accountBridge:true}); await sleep(); await openConfig(f);
  select(f,'target','side'); select(f,'content','community'); await sleep();
  select(f,'target','right'); select(f,'content','bilibili'); await sleep(); f.d.querySelector('.neko-unified-config .close').click();
  await waitFor(()=>f.calls.some(x=>x.action==='open'&&x.slot==='side')&&f.calls.some(x=>x.action==='open'&&x.slot==='right'),'both site views');
  const account=f.d.querySelector('[data-neko-unified-slot="side"] .neko-unified-account');
  const biliAccount=f.d.querySelector('[data-neko-unified-slot="right"] .neko-unified-account');
  assert.equal(account.hidden,false); assert.equal(account.disabled,true); assert.equal(biliAccount.hidden,true);
  f.listener({slot:'side',site:'community',status:'ready'}); assert.equal(account.disabled,false);
  account.click(); assert.equal(account.textContent,'取消连接'); assert(f.calls.some(x=>x.action==='account-connect'));
  f.accountListener({status:'authorizing',message:'请在系统浏览器完成官方授权'});
  assert.match(f.d.querySelector('[data-neko-unified-slot="side"] .note').textContent,/官方授权/);
  account.click(); await sleep(); assert(f.calls.some(x=>x.action==='account-cancel')); assert.equal(account.textContent,'连接桌面身份');
  f.releaseAccount({status:'handed-off',message:'过期响应'}); await sleep();
  assert.doesNotMatch(f.d.querySelector('[data-neko-unified-slot="side"] .note').textContent,/过期响应/);
  assert.equal(f.calls.filter(x=>x.action==='hide'&&x.slot==='right').length,0);
  f.cleanup(); assert.equal(f.accountListener,null,'identity subscription is released');
});
test('chatroom temporarily hides only side native view and restores saved placement', {skip:!JSDOM}, async t=>{
  const f=fixture(t); await sleep(); await openConfig(f); select(f,'target','side'); select(f,'content','community'); await sleep();
  select(f,'target','right'); select(f,'content','bilibili'); await sleep(); f.d.querySelector('.neko-unified-config .close').click();
  await waitFor(()=>f.calls.some(x=>x.action==='open'&&x.slot==='side')&&f.calls.some(x=>x.action==='open'&&x.slot==='right'),'native side and right views');
  const before={...f.saved}, rightHides=()=>f.calls.filter(x=>x.action==='hide'&&x.slot==='right').length;
  const beforeRightHides=rightHides(); f.d.body.setAttribute('data-neko-chatroom-active',''); f.d.dispatchEvent(new f.w.Event('neko-chatroom-mode-change'));
  await waitFor(()=>f.calls.some(x=>x.action==='hide'&&x.slot==='side'),'chatroom hides side view');
  assert.equal(rightHides(),beforeRightHides); assert.deepEqual(f.saved,before,'preview does not alter persisted layout');
  const opens=f.calls.filter(x=>x.action==='open'&&x.slot==='side').length;
  f.d.body.removeAttribute('data-neko-chatroom-active'); f.d.dispatchEvent(new f.w.Event('neko-chatroom-mode-change'));
  await waitFor(()=>f.calls.filter(x=>x.action==='open'&&x.slot==='side').length>opens,'side view restored');
  assert.equal(rightHides(),beforeRightHides); assert.deepEqual(f.saved,before); f.cleanup();
});
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
test('hidden overlay and account ancestors neither block panels nor miss later visibility changes', {skip:!JSDOM}, async t=>{
  const f=fixture(t); await sleep(); await openConfig(f); select(f,'target','right'); select(f,'content','community'); await sleep();
  f.d.querySelector('.neko-unified-config .close').click();
  const count=action=>f.calls.filter(x=>x.action===action && x.slot==='right').length;
  const expectCount=async (action, expected, label)=>{ await waitFor(()=>count(action)>=expected,label); assert.equal(count(action),expected,label); };
  await expectCount('open',1,'initial native view');
  assert.equal(count('open'),1);
  const style=f.d.createElement('style'); style.textContent='.qa-hidden-overlay { display:none }'; f.d.head.appendChild(style);
  const parent=f.d.createElement('div'); parent.className='qa-hidden-overlay';
  const dialog=f.d.createElement('div'); dialog.setAttribute('role','dialog'); parent.appendChild(dialog); f.d.body.appendChild(parent); await nextFrame(f.w);
  assert.equal(count('hide'),0,'dialog under display:none ancestor is not visible');
  parent.classList.remove('qa-hidden-overlay'); await expectCount('hide',1,'showing ancestor suspends native view');
  parent.style.display='none'; await expectCount('open',2,'hiding ancestor restores native view');
  parent.style.display=''; parent.style.visibility='collapse'; await nextFrame(f.w); assert.equal(count('hide'),1,'visibility:collapse ancestor is hidden');
  parent.style.visibility='visible'; await expectCount('hide',2,'visibility change on ancestor suspends again');
  parent.hidden=true; await expectCount('open',3,'hidden ancestor restores view');
  parent.remove();
  const accountWrap=f.d.createElement('div'); accountWrap.style.display='none';
  const account=f.d.createElement('button'); account.setAttribute('aria-expanded','true'); accountWrap.appendChild(account);
  f.d.querySelector('[data-slot="settings.launcher"]').appendChild(accountWrap); await nextFrame(f.w);
  assert.equal(count('hide'),2,'hidden expanded account is not an overlay');
  // Simulate a delayed renderer frame: a fixed sleep may fire before it even
  // though the actual overlay observer and transition are functioning.
  const nativeRaf=f.w.requestAnimationFrame.bind(f.w); f.w.requestAnimationFrame=cb=>f.w.setTimeout(()=>nativeRaf(cb),150);
  accountWrap.style.display=''; await expectCount('hide',3,'showing expanded account ancestor suspends view');
  accountWrap.setAttribute('hidden',''); await expectCount('open',4,'hiding account ancestor restores view');
  account.removeAttribute('aria-expanded'); accountWrap.removeAttribute('hidden'); await nextFrame(f.w);
  assert.equal(count('hide'),3,'account without expanded state does not suspend view');
  account.setAttribute('aria-expanded','true'); await expectCount('hide',4,'newly added expanded state is observed');
  account.setAttribute('aria-expanded','false'); await expectCount('open',5,'newly observed account closes cleanly');
  const lateRole=f.d.createElement('div'); f.d.body.appendChild(lateRole); await nextFrame(f.w);
  lateRole.setAttribute('role','dialog'); await expectCount('hide',5,'newly added dialog role is observed');
  lateRole.removeAttribute('role'); await expectCount('open',6,'removing dialog role restores the view');
  f.cleanup();
});
test('display:contents sidebar uses the grid track and preserves the companion and settings footer', {skip:!JSDOM}, async t=>{
  const f=fixture(t); await sleep();
  const sidebar=f.d.querySelector('[data-slot="sidebar"]'), track=f.d.querySelector('#track');
  sidebar.style.display='contents';
  sidebar.getBoundingClientRect=()=>({left:0,top:0,right:0,bottom:0,width:0,height:0});
  track.getBoundingClientRect=()=>({left:64,top:0,right:284,bottom:780,width:220,height:780});
  const area=f.d.createElement('div'), slot=f.d.createElement('div'); slot.dataset.slot='sidebar.settings';
  const dock=f.d.querySelector('.neko-companion-dock'), launcher=f.d.querySelector('[data-slot="settings.launcher"]');
  area.getBoundingClientRect=()=>({left:64,top:635,right:284,bottom:780,width:220,height:145});
  area.appendChild(slot); slot.append(dock,launcher); sidebar.appendChild(area);
  await openConfig(f); select(f,'target','side');select(f,'content','community');await sleep();
  f.d.querySelector('.neko-unified-config .close').click();await sleep();
  const opened=f.calls.find(x=>x.action==='open'&&x.slot==='side'); assert(opened, 'side view is not hidden when slot has no layout box');
  assert.equal(opened.site,'community');assert.equal(opened.bounds.x,64);assert.equal(opened.bounds.width,220);
  assert(opened.bounds.y+opened.bounds.height<=635,'native view ends before account and companion footer');
  assert.equal(dock.querySelector('textarea').value,'personal draft'); assert.equal(f.d.querySelector('#draft').value,'coding draft');
  f.cleanup();
});
