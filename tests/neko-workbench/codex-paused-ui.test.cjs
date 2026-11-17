'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
let JSDOM;try{({JSDOM}=require(path.join(process.env.NEKO_DOM_DEPS||'/private/tmp/neko-sidebar-dom-20261026','node_modules/jsdom')));}catch{}
const tick=()=>new Promise(r=>setTimeout(r,20));
const source=path.resolve(__dirname,'../../apps/neko-workbench/embedded-dsh/workspace-shell-source.js');
async function create(t, working=false){
 const dom=new JSDOM('<body><aside data-neko-side-rail><div class="neko-side-rail__theme"></div></aside><div data-slot="sidebar"><button data-neko-new-session="plus">+</button><div data-neko-seat-mount></div><div data-slot="sidebar.workspaces"></div><div data-slot="settings.launcher"></div></div><main><textarea>DSH draft</textarea></main></body>',{runScripts:'outside-only'});t.after(()=>dom.window.close());const {window:w}=dom,doc=w.document,calls=[];
 const layout={codexAvailable:false,officeMode:working?'codex':'dsh',activeSeatId:null,companionHistoryOpen:false,seats:[{id:'one',name:'大肥鱼',avatarId:'bigfish',provider:'dsh'}, {id:'two',name:'开发喵',avatarId:'devcat',provider:'codex'},{id:'three',name:'工作助手',avatarId:'claude',provider:null}]};
 const state={workspaceRoot:'/example',workspaceRevision:0,companion:{ready:false,messages:[]}};
 const office={status:working?'working':'idle',thread:working?{id:'existing',cwd:'/example',title:'Existing task'}:null,items:[],approvals:working?[{key:'approve1',title:'请求权限',command:'example'}]:[]};
 const bridge={getState:async()=>state,subscribe:()=>()=>{},subscribeOffice:()=>()=>{},companion:async()=>({}),action:async()=>({}),workspace:async r=>{calls.push(r);if(r.action==='state')return layout;if(r.action==='codex-state')return office;if(r.action==='catalog')return {sessions:[{id:'c',provider:'codex',cwd:'/example',title:'旧 Codex 会话'},{id:'d',provider:'dsh',cwd:'/example',title:'DSH 会话'}],projects:[{cwd:'/example'}],providers:{dsh:'ready',codex:'testing'}};if(r.action==='update'){Object.assign(layout,r.patch);return layout;}return {};}};
 w.eval(fs.readFileSync(source,'utf8')+'\nwindow.install=installWorkspaceShell');const stop=w.install({window:w,document:doc,bridge,avatar:()=>'',openDshNew:root=>calls.push({action:'dsh-new',root}),locateSidebar:()=>({root:doc.querySelector('[data-slot="sidebar"]')})});t.after(stop);await tick();return {w,doc,calls,layout};
}
test('retired engine seats, history and settings are absent while DSH remains usable',{skip:!JSDOM},async t=>{
 const {doc,calls,w,layout}=await create(t);assert.equal(doc.querySelectorAll('.neko-custom-seat__pick').length,2);assert(!/codex/i.test(doc.querySelector('.neko-custom-seats').textContent));assert.equal(doc.querySelector('.neko-office-panel'),null);assert.equal(layout.seats[1].provider,'codex','stored bindings remain intact');
 assert.equal(doc.querySelectorAll('.neko-workspace-session').length,1);assert.equal(doc.querySelector('.neko-workspace-session').textContent,'DSH 会话');assert(!calls.some(r=>/^codex-/.test(r.action)));
 doc.dispatchEvent(new w.CustomEvent('neko-workbench-open-settings',{detail:{tab:'general'}}));assert(!/codex/i.test(doc.querySelector('.neko-workspace-modal').textContent));assert.equal(doc.querySelector('.neko-office-choice').disabled,false);doc.querySelector('.neko-workspace-modal__close').click();
 doc.querySelectorAll('.neko-custom-seat__new')[0].click();await tick();assert(!doc.querySelector('.neko-startup').hidden,'DSH shortcut opens project selection');doc.querySelector('.neko-startup__project-new').click();await tick();assert(calls.some(r=>r.action==='dsh-new'&&r.root==='/example'),'a DSH project remains usable');
 assert.equal(doc.querySelector('main textarea').value,'DSH draft');assert(!doc.querySelector('main').hasAttribute('inert'));assert(doc.querySelector('.neko-companion-dock'));
});
test('a saved running legacy engine does not mount its UI, start or stop work, or rewrite its selection',{skip:!JSDOM},async t=>{
 const {doc,calls,layout}=await create(t,true);assert.equal(doc.querySelector('.neko-office-panel'),null);assert.equal(doc.body.dataset.nekoOfficeMode,'dsh');assert.equal(layout.officeMode,'codex');assert.equal(layout.seats[1].provider,'codex');assert(!calls.some(r=>/^codex-/.test(r.action)||r.action==='update'));assert.equal(doc.querySelector('main textarea').value,'DSH draft');assert(!doc.querySelector('main').hasAttribute('inert'));
});
