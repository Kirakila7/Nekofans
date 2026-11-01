'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
let JSDOM;
try { ({ JSDOM } = require(path.join(process.env.NEKO_DOM_DEPS || '/private/tmp/neko-sidebar-dom-20261026', 'node_modules/jsdom'))); } catch {}
const tick = () => new Promise(resolve => setTimeout(resolve, 5));

test('main companion moves to the highest rail position when its dock is hidden, then returns intact', {skip: !JSDOM}, async t => {
  const dom = new JSDOM('<body><aside data-neko-side-rail><div class="neko-side-rail__theme"></div><button class="neko-side-rail__expand" hidden>展开</button></aside><div id="frame" data-sidebar-collapsed="false"><aside data-slot="sidebar"><div data-neko-seat-mount></div><div data-slot="sidebar.workspaces"></div><div data-slot="settings.launcher"></div></aside></div><main></main></body>', {runScripts:'outside-only'});
  t.after(() => dom.window.close());
  const w = dom.window, d = w.document, root = d.querySelector('[data-slot="sidebar"]'), frame = d.querySelector('#frame'), expand = d.querySelector('.neko-side-rail__expand');
  let intersection;
  w.IntersectionObserver = class { constructor(callback) { this.callback=callback; intersection=this; } observe(target) { this.target=target; } disconnect() {} setVisible(visible) { this.callback([{target:this.target,isIntersecting:visible}]); } };
  root.getBoundingClientRect = () => ({right:300});
  const layout = {officeMode:'dsh',activeSeatId:null,seats:[],companionHistoryOpen:false};
  const state = {workspaceRoot:'/fixture',workspaceRevision:0,companion:{ready:true,messages:[{role:'assistant',text:'fixture'}]}};
  const bridge = {getState:async()=>state, companion:async()=>({}), action:async()=>({}), workspace:async r => r.action === 'state' ? layout : r.action === 'codex-state' ? {items:[],approvals:[]} : r.action === 'catalog' ? {sessions:[],projects:[],providers:{dsh:'ready'}} : {}};
  w.eval(fs.readFileSync(path.join(__dirname,'../../apps/neko-workbench/embedded-dsh/workspace-shell-source.js'),'utf8')+'\nwindow.install=installWorkspaceShell');
  const cleanup = w.install({window:w, document:d, bridge, avatar:()=>'', locateSidebar:()=>({root})});
  await tick();
  const dock=d.querySelector('.neko-companion-dock'), rail=d.querySelector('[data-neko-side-rail]'), fallback=d.querySelector('.neko-rail-companion'), character=d.querySelector('.neko-companion-character'), input=d.querySelector('.neko-companion-form textarea');
  dock.getBoundingClientRect=()=>({left:64,right:300,top:500,bottom:620,width:236,height:120});
  w.dispatchEvent(new w.Event('resize')); await tick();
  assert.equal(character.parentElement,dock); assert(fallback.hidden); assert.equal(rail.firstElementChild,fallback);
  input.value='unsent fixture';
  frame.setAttribute('data-sidebar-collapsed','true'); expand.hidden=false; await tick();
  assert.equal(character.parentElement,fallback); assert.equal(fallback.hidden,false); assert.equal(character.getAttribute('aria-hidden'),'true');
  expand.addEventListener('click',()=>{frame.setAttribute('data-sidebar-collapsed','false');expand.hidden=true;});
  fallback.click(); await tick();assert(!d.querySelector('.neko-companion-menu').hidden);
  d.querySelector('.neko-companion-menu__chat').click(); await tick();
  assert.equal(character.parentElement,dock); assert(fallback.hidden); assert.equal(character.getAttribute('aria-hidden'),null); assert.equal(input.value,'unsent fixture');
  root.style.display='none'; await tick(); assert.equal(character.parentElement,fallback);
  root.style.display=''; await tick(); assert.equal(character.parentElement,dock);
  intersection.setVisible(false); await tick(); assert.equal(character.parentElement,fallback);
  intersection.setVisible(true); await tick(); assert.equal(character.parentElement,dock);
  assert.equal(d.querySelectorAll('.neko-companion-character').length,1);
  cleanup(); assert.equal(d.querySelector('.neko-rail-companion'),null);
});

for (const surface of ['community', 'bilibili', 'youtube']) {
  test(`${surface} hides the bottom chat, keeps one rail fish and restores its draft`, {skip: !JSDOM}, async t => {
    const dom = new JSDOM('<body><aside data-neko-side-rail></aside><div id="frame" data-sidebar-collapsed="false"><aside data-slot="sidebar"><div data-neko-seat-mount></div><div data-slot="sidebar.workspaces"></div><div data-slot="settings.launcher"></div></aside></div></body>', {runScripts:'outside-only'});
    t.after(() => dom.window.close());
    const w=dom.window, d=w.document, root=d.querySelector('[data-slot="sidebar"]'), actions=[];
    root.getBoundingClientRect=()=>({right:300});
    const layout={officeMode:'dsh',activeSeatId:null,seats:[],companionHistoryOpen:true};
    const bridge={getState:async()=>({workspaceRoot:'/fixture',companion:{ready:true,messages:[]}}),companion:async()=>({}),action:async name=>actions.push(name),workspace:async r=>r.action==='state'?layout:r.action==='catalog'?{sessions:[],projects:[],providers:{dsh:'ready'}}:{items:[],approvals:[]}};
    const css=d.createElement('style'); css.textContent=fs.readFileSync(path.join(__dirname,'../../apps/neko-workbench/embedded-dsh/workspace-shell-source.css'),'utf8'); d.head.append(css);
    w.eval(fs.readFileSync(path.join(__dirname,'../../apps/neko-workbench/embedded-dsh/workspace-shell-source.js'),'utf8')+'\nwindow.install=installWorkspaceShell');
    const cleanup=w.install({window:w,document:d,bridge,avatar:()=>'',locateSidebar:()=>({root})});
    t.after(cleanup); await tick();
    const dock=d.querySelector('.neko-companion-dock'), fish=d.querySelector('.neko-companion-character'), rail=d.querySelector('.neko-rail-companion'), input=d.querySelector('.neko-companion-form textarea'), menu=d.querySelector('.neko-companion-menu');
    dock.getBoundingClientRect=()=>({left:64,right:300,top:500,bottom:620,width:236,height:120});
    w.dispatchEvent(new w.Event('resize')); await tick();
    assert.equal(fish.parentElement,dock); input.value='保留未发送草稿'; fish.click(); assert.equal(menu.hidden,false);
    const change=next=>d.dispatchEvent(new w.CustomEvent('neko-side-surface-change',{detail:{surface:next}}));
    change(surface); await tick();
    assert.equal(dock.hidden,true); assert.equal(w.getComputedStyle(dock).display,'none');
    assert.equal(fish.parentElement,rail); assert.equal(rail.hidden,false); assert.equal(menu.hidden,true);
    assert.equal(rail.getAttribute('aria-haspopup'),null); assert.match(rail.getAttribute('aria-label'),/点击聊天/);
    rail.click(); await tick(); assert.deepEqual(actions,[],'chat stays in the workbench'); assert.equal(menu.hidden,true);
    assert.equal(dock.hidden,false); assert(dock.hasAttribute('data-neko-companion-rail-chat')); assert.equal(dock.parentElement,d.body); assert.equal(d.activeElement,input);
    change(surface==='community'?'bilibili':'community'); await tick();
    assert.equal(dock.hidden,false); assert.equal(d.querySelectorAll('.neko-companion-character').length,1); assert.equal(input.value,'保留未发送草稿');
    d.querySelector('.neko-companion-rail-close').click(); await tick(); assert.equal(dock.hidden,true); assert(!dock.hasAttribute('data-neko-companion-rail-chat'));
    rail.click(); await tick(); d.dispatchEvent(new w.KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true})); await tick(); assert.equal(dock.hidden,true);
    change('hidden'); await tick();
    assert.equal(dock.hidden,false); assert.equal(fish.parentElement,dock); assert.equal(rail.hidden,true);
    assert.equal(input.value,'保留未发送草稿'); assert.equal(layout.companionHistoryOpen,true); assert.equal(rail.getAttribute('aria-haspopup'),'menu');
    // A social transition must also close a menu that was already in the rail.
    d.querySelector('#frame').setAttribute('data-sidebar-collapsed','true'); await tick(); rail.click(); assert.equal(menu.hidden,false);
    change(surface); await tick(); assert.equal(menu.hidden,true); assert.equal(dock.hidden,true);
  });
}
