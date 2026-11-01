'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {createWorkspaceLayout}=require('../../apps/neko-workbench/workspace-layout.cjs');
const base=path.resolve(__dirname,'../../apps/neko-workbench');
let JSDOM;try{({JSDOM}=require(path.join(process.env.NEKO_DOM_DEPS||'/private/tmp/neko-sidebar-dom-20261026','node_modules/jsdom')));}catch{}
const tick=()=>new Promise(r=>setTimeout(r,20));
for (const mode of ['flex','social']) test(mode+' floating input routes only to the retained DSH shell and preserves stale drafts',{skip:!JSDOM},async t=>{
 const collapsedAttribute=mode==='social'?'data-neko-workspace-collapsed':'data-neko-flex-workspace-collapsed';
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'neko-native-composer-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const dom=new JSDOM('<body><aside data-neko-side-rail><span class="neko-side-rail__theme"></span></aside><aside data-slot="sidebar"><div data-slot="settings.launcher"></div></aside><main data-neko-flex-coding data-neko-chat-center><div data-composer-seat><textarea>native</textarea></div></main></body>',{runScripts:'outside-only',pretendToBeVisual:true});t.after(()=>dom.window.close());
 const w=dom.window,d=w.document,sidebar=d.querySelector('[data-slot="sidebar"]');sidebar.getBoundingClientRect=()=>({left:64,top:0,right:304,bottom:800,width:240,height:800});
 const store=createWorkspaceLayout(path.join(dir,'layout.json')),states=[],placements=[];let inputEvent,selection={sessionId:'s1'},main='s1',draft={draft:'original',draftRev:1,phase:'plain',attachmentIds:[],occurrences:[]},sends=0,saves=0;
 const fileCalls=[];d.addEventListener('neko-workspace-expand',()=>{d.body.removeAttribute('data-neko-flex-workspace-collapsed');d.body.removeAttribute('data-neko-workspace-collapsed')});
 const listeners=new Set(),shell={state:{getSnapshot:()=>({...draft}),subscribe:fn=>{listeners.add(fn);return()=>listeners.delete(fn)}},actions:{setDraft(value){draft={...draft,draft:value,draftRev:draft.draftRev+1};for(const fn of listeners)fn()},persistDraft(){saves++},submit(){sends++}}},binding={sessionId:'s1',session:{sessionId:'s1'}};
 const bridge={lobby:async()=>({state:{connection:'unconfigured'}}),getState:async()=>({workspaceRoot:'/p',workspaceRevision:0,companion:{ready:true,messages:[]}}),companion:async()=>({}),workspace:async r=>r.action==='state'?{...store.get(),codexAvailable:false}:r.action==='codex-state'?{items:[],approvals:[]}:r.action==='catalog'?{sessions:[],projects:[],providers:{dsh:'ready'}}:null,nativeComposer:async r=>{if(r.action==='update')states.push(r.state);else placements.push(r);return {ok:true}},subscribeNativeComposer:fn=>{inputEvent=fn;return()=>{inputEvent=null}}};
 w.eval(fs.readFileSync(path.join(base,'embedded-dsh/chatroom-preview-source.js'),'utf8')+'\n'+fs.readFileSync(path.join(base,'embedded-dsh/native-composer-source.js'),'utf8')+'\n'+fs.readFileSync(path.join(base,'embedded-dsh/workspace-shell-source.js'),'utf8')+'\nwindow.install=installWorkspaceShell');
 const stop=w.install({window:w,document:d,bridge,avatar:()=>'',locateSidebar:()=>({root:sidebar}),getDshSelection:()=>selection,hasDshActiveSession:()=>!!main,openDshFiles:(node,id)=>fileCalls.push(id),nativeComposerBindings:{getSelection:()=>selection,getMainSessionId:()=>main,getBinding:id=>id==='s1'?binding:null,getShell:()=>shell}});await tick();
 if(mode==='social')d.dispatchEvent(new w.CustomEvent('neko-side-surface-change',{detail:{surface:'bilibili'}}));
 d.body.style.setProperty('--neko-flex-compact-width','450px');d.body.style.setProperty('--neko-flex-compact-right','16px');d.body.style.setProperty('--neko-flex-compact-bottom','16px');d.body.setAttribute(collapsedAttribute,'');await tick();
 assert(placements.some(x=>x.action==='place'));assert.equal(states.at(-1).value,'original');assert.equal(states.at(-1).sessionToken,'s1');
 const lobbyButton=d.querySelector('.neko-lobby-switch'); assert(lobbyButton); const removedBefore=placements.filter(x=>x.action==='remove').length; d.querySelector('[data-neko-public-room]').click(); await tick(); assert.equal(placements.filter(x=>x.action==='remove').length,removedBefore,'left lobby retains the working float');
 inputEvent({type:'files',sessionToken:'s1',revision:0});await tick();assert.equal(fileCalls.length,0,'stale file request is rejected while lobby is open');
 inputEvent({type:'submit',value:'original',sessionToken:'old-session',revision:1,submissionId:77}); await tick(); assert.equal(sends,0,'wrong-session submit is rejected while lobby is active'); assert(states.some(x=>x.settledSubmitId===77&&x.status.includes('变化')));
 inputEvent({type:'edit',value:'new text',sessionToken:'s1',revision:1,editId:1}); await tick(); assert.equal(draft.draft,'new text','pending draft may settle into same original session');
 assert.equal(lobbyButton.getAttribute('aria-expanded'),'true'); assert.equal(states.at(-1).value,'new text'); assert(!d.querySelector('main').hasAttribute('inert'));
 inputEvent({type:'files',sessionToken:'s1',revision:1});await tick();assert.equal(fileCalls.length,0,'stale revision cannot open files');
 inputEvent({type:'files',sessionToken:'s1',revision:2});await new Promise(r=>setTimeout(r,80));assert.deepEqual(fileCalls,['s1']);assert(!d.body.hasAttribute(collapsedAttribute),'files expands first');assert.equal(draft.draft,'new text');
 d.body.setAttribute(collapsedAttribute,'');await tick();
 // Continue the original stale revision/session checks from revision 2.
 assert.equal(saves,1);assert(states.some(x=>x.settledEditId===1&&!x.editConflict&&x.revision===2));
 inputEvent({type:'submit',value:'new text',sessionToken:'s1',revision:1,submissionId:1});await tick();assert.equal(sends,0);assert(states.some(x=>x.settledSubmitId===1&&x.status.includes('变化')));
 inputEvent({type:'submit',value:'new text',sessionToken:'s1',revision:2,submissionId:2});await tick();assert.equal(sends,1);assert(states.some(x=>x.settledSubmitId===2&&x.status==='已交给工作区处理'));
 selection={sessionId:'s2'};main='s2';inputEvent({type:'edit',value:'overwrite',sessionToken:'s1',revision:2,editId:2});await tick();assert.equal(draft.draft,'new text');assert(states.some(x=>x.settledEditId===2&&x.editConflict));
 d.body.removeAttribute(collapsedAttribute);await tick();assert(placements.some(x=>x.action==='remove'));
 selection={sessionId:'s1'};main='s1';d.body.setAttribute('data-neko-workspace-collapsed','');await tick();
 inputEvent({type:'files',sessionToken:'s1',revision:2});await new Promise(r=>setTimeout(r,80));assert.deepEqual(fileCalls,['s1','s1'],'normal collapsed files expands and opens same session');
 d.body.setAttribute('data-neko-workspace-collapsed','');await tick();const before=placements.filter(x=>x.action==='remove').length;
 Object.defineProperty(w,'innerWidth',{value:300,configurable:true});w.dispatchEvent(new w.Event('resize'));await tick();
 if(mode==='social'){
  assert(d.body.hasAttribute('data-neko-workspace-collapsed'),'narrow video view stays in place');
  const expand=d.querySelector('[data-neko-workspace-expand-control]');assert(!expand.hidden,'unavailable float retains an explicit way back');expand.click();await tick();
 }
 assert(!d.body.hasAttribute('data-neko-workspace-collapsed'),'narrow window restores usable workspace');assert(placements.filter(x=>x.action==='remove').length>before,'stale native float is removed');assert.equal(draft.draft,'new text');
 stop();assert.equal(inputEvent,null);assert.equal(listeners.size,0);
});
