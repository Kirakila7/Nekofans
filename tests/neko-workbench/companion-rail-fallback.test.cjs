'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
let JSDOM;
try { ({ JSDOM } = require(path.join(process.env.NEKO_DOM_DEPS || '/private/tmp/neko-sidebar-dom-20261026', 'node_modules/jsdom'))); } catch {}
const tick = () => new Promise(resolve => setTimeout(resolve, 5));

test('hiding and restoring the sidebar preserves the main companion and draft without a rail pet', {skip: !JSDOM}, async t => {
  const dom = new JSDOM('<body><aside data-neko-side-rail><div class="neko-side-rail__theme"></div><button class="neko-side-rail__expand" hidden>展开</button></aside><div id="frame" data-sidebar-collapsed="false"><aside data-slot="sidebar"><div data-neko-seat-mount></div><div data-slot="sidebar.workspaces"></div><div data-slot="settings.launcher"></div></aside></div><main></main></body>', {runScripts:'outside-only'});
  t.after(() => dom.window.close());
  const w = dom.window, d = w.document, root = d.querySelector('[data-slot="sidebar"]'), frame = d.querySelector('#frame'), expand = d.querySelector('.neko-side-rail__expand');
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
  assert.equal(character.parentElement,dock); assert.equal(fallback,null); assert(!rail.contains(character));
  input.value='unsent fixture';
  frame.setAttribute('data-sidebar-collapsed','true'); expand.hidden=false; await tick();
  assert.equal(character.parentElement,dock); assert.equal(d.querySelector('.neko-rail-companion'),null);
  frame.setAttribute('data-sidebar-collapsed','false'); expand.hidden=true; await tick();
  character.click(); await tick(); assert(!d.querySelector('.neko-companion-menu').hidden);
  d.querySelector('.neko-companion-menu__chat').click(); await tick();
  assert.equal(character.parentElement,dock); assert.equal(character.getAttribute('aria-hidden'),null); assert.equal(input.value,'unsent fixture');
  root.style.display='none'; await tick(); assert.equal(character.parentElement,dock); assert(!rail.contains(character));
  root.style.display=''; await tick(); assert.equal(character.parentElement,dock); assert.equal(input.value,'unsent fixture');
  assert.equal(d.querySelectorAll('.neko-companion-character').length,1);
  cleanup(); assert.equal(d.querySelector('.neko-rail-companion'),null);
});
