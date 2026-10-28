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
 w.eval(fs.readFileSync(source,'utf8')+'\nwindow.install=installWorkspaceShell');const stop=w.install({window:w,document:doc,bridge,avatar:()=>'',locateSidebar:()=>({root:doc.querySelector('[data-slot="sidebar"]')})});t.after(stop);await tick();return {w,doc,calls,layout};
}
test('paused Codex is visibly disabled across seat, saved sessions and engine settings while DSH remains usable',{skip:!JSDOM},async t=>{
 const {doc,calls}=await create(t);const seat=doc.querySelectorAll('.neko-custom-seat__pick')[1];assert.equal(seat.disabled,true);assert.match(seat.textContent,/测试中/);seat.click();await tick();assert(!calls.some(r=>r.action==='update'&&r.patch?.officeMode==='codex'));
 const old=[...doc.querySelectorAll('.neko-workspace-session')].find(n=>n.textContent.includes('旧 Codex'));assert(old.disabled);assert.match(old.textContent,/测试中/);old.click();await tick();assert(!calls.some(r=>r.action==='codex-read'));
 doc.querySelector('.neko-office-switch').click();const codex=[...doc.querySelectorAll('.neko-office-choice')].find(n=>n.textContent.includes('Codex'));assert(codex.disabled);assert.match(codex.textContent,/测试中/);assert.equal(doc.querySelectorAll('.neko-office-choice')[0].disabled,false);
 assert.equal(doc.querySelector('main textarea').value,'DSH draft');assert(!doc.querySelector('main').hasAttribute('inert'));assert(doc.querySelector('.neko-companion-dock'));
});
test('an already running Codex task retains approval and stop while new sends remain disabled',{skip:!JSDOM},async t=>{
 const {doc,calls,w}=await create(t,true);assert(!doc.querySelector('.neko-office-panel').hidden);assert(doc.querySelector('.neko-office-send').disabled);assert(doc.querySelector('.neko-office-new').disabled);assert(doc.querySelector('.neko-office-form textarea').disabled);assert(!doc.querySelector('.neko-office-stop').hidden);
 doc.querySelector('.neko-office-form').dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));assert(!calls.some(r=>r.action==='codex-send'));doc.querySelector('.neko-office-stop').click();doc.querySelector('.neko-office-approval button').click();await tick();assert(calls.some(r=>r.action==='codex-stop'));assert(calls.some(r=>r.action==='codex-approve'));
});
