'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
let JSDOM;try{({JSDOM}=require(path.join(process.env.NEKO_DOM_DEPS||'/private/tmp/neko-sidebar-dom-20261026','node_modules/jsdom')));}catch{}
const shellRoot=process.env.NEKO_WORKSPACE_SHELL_ROOT||path.resolve(__dirname,'../../apps/neko-workbench/embedded-dsh');
const tick=()=>new Promise(resolve=>setTimeout(resolve,20));

test('DSH entries stay usable while retired engine UI is omitted and saved bindings are retained',{skip:!JSDOM},async t=>{
 const dom=new JSDOM('<body><aside data-neko-side-rail><div class="neko-side-rail__theme"></div></aside><div data-slot="sidebar"><div data-neko-seat-mount></div><div data-slot="sidebar.workspaces"></div><div data-slot="settings.launcher"></div></div><main><textarea>DSH draft</textarea></main></body>',{runScripts:'outside-only'});
 t.after(()=>dom.window.close());const w=dom.window,doc=w.document,updates=[];
 let layout={officeMode:'codex',activeSeatId:'codex-seat',seats:[{id:'dsh-seat',name:'DSH',provider:'dsh'},{id:'codex-seat',name:'Codex',provider:'codex'},{id:'empty-seat',name:'工作助手',provider:null}]},community,hideCount=0;
 const saved=structuredClone(layout),requests=[];
 const bridge={getState:async()=>({workspaceRoot:'/project',companion:{messages:[]}}),companion:async()=>{},subscribeCommunity:callback=>{community=callback;return()=>{};},workspace:async request=>{
  requests.push(request.action);if(request.action==='state')return structuredClone(layout);
  if(request.action==='update'){updates.push(structuredClone(request.patch));layout={...layout,...request.patch};return structuredClone(layout);}
  if(request.action==='codex-state')return {status:'idle',thread:null,items:[],approvals:[]};
  if(request.action==='codex-models')return {models:[]};
  if(request.action==='catalog')return {providers:{dsh:'ready',codex:'ready'},sessions:[{provider:'dsh',id:'d',cwd:'/project',title:'DSH task'},{provider:'codex',id:'c',cwd:'/project',title:'Codex task'}]};
  throw Error('Switching views must not start a model or task: '+request.action);
 }};
 const root=doc.querySelector('[data-slot="sidebar"]');root.getBoundingClientRect=()=>({right:280});
 w.eval(fs.readFileSync(path.join(shellRoot,'workspace-shell-source.js'),'utf8')+'\nwindow.install=installWorkspaceShell');
 const cleanup=w.install({window:w,document:doc,bridge,avatar:()=>'',hideSocial:()=>{hideCount++;community?.({status:'hidden'});},locateSidebar:()=>({root})});t.after(cleanup);await tick();
 const seats=doc.querySelector('.neko-custom-seats'),railSwitch=doc.querySelector('.neko-office-switch'),main=doc.querySelector('main');
 const seatParent=seats.parentElement,railParent=railSwitch.parentElement;
 assert.deepEqual(layout,saved,'mounting the current UI never migrates saved bindings or engine selections');assert.equal(updates.length,0);assert.equal(doc.querySelector('.neko-office-panel'),null);assert.equal(doc.body.dataset.nekoOfficeMode,'dsh');assert.equal(doc.querySelectorAll('.neko-custom-seat').length,2);assert(!/codex/i.test(seats.textContent));assert.equal(doc.querySelector('.neko-workspace-session').textContent,'DSH task');assert(!requests.some(action=>/^codex-/.test(action)));assert(!main.hasAttribute('inert'));
 community({status:'ready'});
 doc.querySelectorAll('.neko-custom-seat__pick')[0].click();await tick();
 assert.deepEqual(updates.at(-1),{activeSeatId:'dsh-seat',officeMode:'dsh'});assert.equal(hideCount,1);assert.equal(doc.querySelector('.neko-office-panel'),null);assert(!main.hasAttribute('inert'));assert.equal(main.querySelector('textarea').value,'DSH draft');assert.equal(layout.officeMode,'dsh');assert.deepEqual(layout.seats,saved.seats,'an explicit DSH switch does not alter other bindings');assert.match(railSwitch.getAttribute('aria-label'),/当前日常版/);
 assert.equal(seats.parentElement,seatParent);assert.equal(railSwitch.parentElement,railParent);
 doc.querySelectorAll('.neko-custom-seat__pick')[1].click();await tick();assert.equal(layout.officeMode,'dsh');assert.equal(layout.activeSeatId,'dsh-seat');assert.equal(doc.querySelector('.neko-workspace-modal').hidden,false);assert(!/codex/i.test(doc.querySelector('.neko-seat-editor').textContent));assert.equal(main.querySelector('textarea').value,'DSH draft');
});
