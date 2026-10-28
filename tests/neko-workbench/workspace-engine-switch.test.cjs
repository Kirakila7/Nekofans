'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
let JSDOM;try{({JSDOM}=require(path.join(process.env.NEKO_DOM_DEPS||'/private/tmp/neko-sidebar-dom-20261026','node_modules/jsdom')));}catch{}
const shellRoot=process.env.NEKO_WORKSPACE_SHELL_ROOT||path.resolve(__dirname,'../../apps/neko-workbench/embedded-dsh');
const tick=()=>new Promise(resolve=>setTimeout(resolve,20));

test('existing assistant entries switch the visible engine and preserve independent unsent drafts',{skip:!JSDOM},async t=>{
 const dom=new JSDOM('<body><aside data-neko-side-rail><div class="neko-side-rail__theme"></div></aside><div data-slot="sidebar"><div data-neko-seat-mount></div><div data-slot="sidebar.workspaces"></div><div data-slot="settings.launcher"></div></div><main><textarea>DSH draft</textarea></main></body>',{runScripts:'outside-only'});
 t.after(()=>dom.window.close());const w=dom.window,doc=w.document,updates=[];
 let layout={officeMode:'dsh',activeSeatId:'dsh-seat',seats:[{id:'dsh-seat',name:'DSH',provider:'dsh'},{id:'codex-seat',name:'Codex',provider:'codex'},{id:'empty-seat',name:'工作助手',provider:null}]},community,hideCount=0;
 const bridge={getState:async()=>({workspaceRoot:'/project',companion:{messages:[]}}),companion:async()=>{},subscribeCommunity:callback=>{community=callback;return()=>{};},workspace:async request=>{
  if(request.action==='state')return structuredClone(layout);
  if(request.action==='update'){updates.push(structuredClone(request.patch));layout={...layout,...request.patch};return structuredClone(layout);}
  if(request.action==='codex-state')return {status:'idle',thread:null,items:[],approvals:[]};
  if(request.action==='catalog')return {providers:{dsh:'ready',codex:'ready'},sessions:[{provider:'dsh',id:'d',cwd:'/project',title:'DSH task'},{provider:'codex',id:'c',cwd:'/project',title:'Codex task'}]};
  throw Error('Switching views must not start a model or task: '+request.action);
 }};
 const root=doc.querySelector('[data-slot="sidebar"]');root.getBoundingClientRect=()=>({right:280});
 w.eval(fs.readFileSync(path.join(shellRoot,'workspace-shell-source.js'),'utf8')+'\nwindow.install=installWorkspaceShell');
 const cleanup=w.install({window:w,document:doc,bridge,avatar:()=>'',hideSocial:()=>{hideCount++;community?.({status:'hidden'});},locateSidebar:()=>({root})});t.after(cleanup);await tick();
 const seats=doc.querySelector('.neko-custom-seats'),railSwitch=doc.querySelector('.neko-office-switch'),panel=doc.querySelector('.neko-office-panel'),codexInput=doc.querySelector('.neko-office-form textarea'),main=doc.querySelector('main');
 const seatParent=seats.parentElement,railParent=railSwitch.parentElement;
 community({status:'ready'});
 doc.querySelectorAll('.neko-custom-seat__pick')[1].click();await tick();
 assert.deepEqual(updates.at(-1),{activeSeatId:'codex-seat',officeMode:'codex'});assert.equal(hideCount,1);
 assert.equal(panel.hidden,false);assert.equal(doc.body.dataset.nekoOfficeMode,'codex');assert.match(railSwitch.getAttribute('aria-label'),/Codex/);assert(main.hasAttribute('inert'));
 assert.match(codexInput.getAttribute('aria-label'),/Codex/);assert.equal(doc.querySelector('.neko-workspace-session').textContent,'Codex task');
 codexInput.value='Codex draft';codexInput.dispatchEvent(new w.Event('input',{bubbles:true}));
 doc.querySelectorAll('.neko-custom-seat__pick')[0].click();await tick();
 assert.equal(panel.hidden,true);assert(!main.hasAttribute('inert'));assert.equal(main.querySelector('textarea').value,'DSH draft');assert.equal(layout.officeMode,'dsh');
 doc.querySelectorAll('.neko-custom-seat__pick')[1].click();await tick();assert.equal(panel.hidden,false);assert.equal(codexInput.value,'Codex draft');
 assert.equal(seats.parentElement,seatParent);assert.equal(railSwitch.parentElement,railParent);
 doc.querySelectorAll('.neko-custom-seat__pick')[2].click();await tick();assert.equal(layout.officeMode,'codex');assert.equal(layout.activeSeatId,'codex-seat');assert.equal(doc.querySelector('.neko-workspace-modal').hidden,false);
});
