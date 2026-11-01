'use strict';
// Issues #43, #45, #46: the public chatroom opens the real channel in the room
// column, community/video pages keep the user in place while the floating
// input binds a session, and the rail companion parks beside its chat box.
// The real shell sources run in jsdom against fake bridges. Synthetic data only.
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const base=path.resolve(__dirname,'../../apps/neko-workbench');
const read=file=>fs.readFileSync(path.join(base,file),'utf8');
const tick=(ms=20)=>new Promise(r=>setTimeout(r,ms));
let JSDOM;
for(const dir of [process.env.NEKO_DOM_DEPS,'/private/tmp/neko-sidebar-dom-20261026','/private/tmp/neko-lobby-dom-7mKS'].filter(Boolean)){try{({JSDOM}=require(path.join(dir,'node_modules/jsdom')));break;}catch{}}
const DOM_SKIP=JSDOM?false:'set NEKO_DOM_DEPS to a directory with jsdom installed';
const surface=(w,d,name)=>d.dispatchEvent(new w.CustomEvent('neko-side-surface-change',{detail:{surface:name}}));

test('choosing a session on a social page binds the floating input without leaving the page',{skip:DOM_SKIP},async t=>{
 const {createWorkspaceLayout}=require(path.join(base,'workspace-layout.cjs'));
 const dom=new JSDOM('<body data-neko-workspace-collapsed><aside data-neko-side-rail><div class="neko-side-rail__theme"></div></aside><aside data-slot="sidebar"><div data-slot="settings.launcher"></div></aside><main data-neko-chat-center><div data-composer-seat><textarea></textarea></div></main></body>',{runScripts:'outside-only',pretendToBeVisual:true});
 t.after(()=>dom.window.close());const w=dom.window,d=w.document,side=d.querySelector('[data-slot="sidebar"]');
 side.getBoundingClientRect=()=>({left:64,top:0,right:304,bottom:800,width:240,height:800});w.setInterval=()=>1;w.clearInterval=()=>{};
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'neko-social-work-test-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const layout=createWorkspaceLayout(path.join(dir,'layout.json'));
 const sessions=[{id:'s0',provider:'dsh',cwd:'/fish',title:'界面工作会话'},{id:'s1',provider:'dsh',cwd:'/fish/pond',title:'视频旁的会话'}];
 let callback,selection='s0',opened=[],calls=[],socialClosed=0,expands=0,running=false,draft='';
 const session={sessionId:'s0',subscribe(){return()=>{}},getSnapshot:()=>({running})},binding={sessionId:'s0',session};
 const shell={state:{getSnapshot:()=>({draft,draftRev:1,phase:'plain',occurrences:[],attachmentIds:[]}),subscribe(){return()=>{}}},actions:{setDraft(v){draft=v},persistDraft(){},submit(){}}};
 const bridge={getState:async()=>({workspaceRoot:'/fish',workspaceRevision:0,companion:{ready:true,messages:[]}}),companion:async()=>({}),action:async()=>({}),
  nativeComposer:async request=>{calls.push(request);return {ok:true};},subscribeNativeComposer:fn=>{callback=fn;return()=>{}},
  workspace:async r=>{if(r.action==='state')return layout.get();if(r.action==='update')return layout.update(r.patch);if(r.action==='catalog')return {sessions,projects:[],providers:{dsh:'ready'}};if(r.action==='codex-state')return {items:[],approvals:[]};return null;}};
 d.addEventListener('neko-workspace-expand',()=>expands++);
 w.eval(read('embedded-dsh/native-composer-source.js')+'\n'+read('embedded-dsh/workspace-shell-source.js')+'\nwindow.install=installWorkspaceShell');
 const stop=w.install({window:w,document:d,bridge,avatar:()=>'',hideSocial:()=>{socialClosed++},locateSidebar:()=>({root:side,slot:side}),getDshSelection:()=>({sessionId:selection}),hasDshActiveSession:()=>true,
  openDshSession:async id=>{opened.push(id);selection=id;binding.sessionId=id;session.sessionId=id;},nativeComposerBindings:{getSelection:()=>({sessionId:selection}),getMainSessionId:()=>selection,getBinding:()=>binding,getShell:()=>shell}});
 t.after(stop);await tick();
 for(const page of ['community','bilibili','youtube']){
  surface(w,d,page);d.body.setAttribute('data-neko-side-social-active','');await tick();
  const target=selection==='s0'?'s1':'s0',before=expands;
  callback({type:'record-open',id:'dsh:'+target,sessionToken:selection,revision:1,openId:opened.length+1});await tick();
  assert.equal(opened.at(-1),target,page+': the chosen real session is opened');
  assert.equal(expands,before,page+': the page is not replaced by the workspace');
  assert.equal(socialClosed,0,page+': the social page is not closed');
  const latest=calls.filter(x=>x.action==='update').at(-1).state;
  assert.equal(latest.recordsOpen,false);assert.match(latest.context,target==='s1'?/pond · 视频旁的会话/:/fish · 界面工作会话/,page+': the input names the bound project and session');
 }
 running=true;callback({type:'records-refresh'});await tick();
 assert.equal(calls.filter(x=>x.action==='update').at(-1).state.running,true,'progress comes from the real session');
 running=false;callback({type:'records-refresh'});await tick();
 assert.match(calls.filter(x=>x.action==='update').at(-1).state.status,/已完成/,'an observed run that ends without error reports completion');
 draft='未发送草稿';const before=opened.length;callback({type:'record-open',id:'dsh:s0',sessionToken:selection,revision:1,openId:99});await tick();
 assert.equal(opened.length,before,'a pending draft blocks switching so it is not lost or sent elsewhere');
});

test('on a social page the rail companion parks beside its chat box, drags freely and keeps the draft',{skip:DOM_SKIP},async t=>{
 const dom=new JSDOM('<body><aside data-neko-side-rail><div class="neko-side-rail__theme"></div><div class="neko-side-rail__space" aria-hidden="true"></div><div class="neko-side-rail__bottom"></div></aside><div id="frame" data-sidebar-collapsed="false"><aside data-slot="sidebar"><div data-neko-seat-mount></div><div data-slot="sidebar.workspaces"></div><div data-slot="settings.launcher"></div></aside></div><main></main></body>',{runScripts:'outside-only'});
 t.after(()=>dom.window.close());const w=dom.window,d=w.document,root=d.querySelector('[data-slot="sidebar"]'),space=d.querySelector('.neko-side-rail__space');
 w.matchMedia=()=>({matches:false,addEventListener(){},removeEventListener(){}});
 const timers=new Map(),nativeTimeout=w.setTimeout.bind(w),nativeClear=w.clearTimeout.bind(w);let serial=10000;
 w.setTimeout=(fn,ms,...args)=>{if(ms<1000)return nativeTimeout(fn,ms,...args);const id=++serial;timers.set(id,fn);return id;};w.clearTimeout=id=>{if(!timers.delete(id))nativeClear(id);};
 space.getBoundingClientRect=()=>({left:0,top:200,right:64,bottom:500,width:64,height:300});root.getBoundingClientRect=()=>({right:300});
 const layout={officeMode:'dsh',activeSeatId:null,seats:[],companionHistoryOpen:false};
 const bridge={getState:async()=>({workspaceRoot:'/fixture',workspaceRevision:0,companion:{ready:true,messages:[]}}),companion:async()=>({}),action:async()=>({}),workspace:async r=>r.action==='state'?layout:r.action==='codex-state'?{items:[],approvals:[]}:r.action==='catalog'?{sessions:[],projects:[],providers:{dsh:'ready'}}:{}};
 w.eval(read('embedded-dsh/workspace-shell-source.js')+'\nwindow.install=installWorkspaceShell');
 const cleanup=w.install({window:w,document:d,bridge,avatar:()=>'',locateSidebar:()=>({root})});t.after(()=>cleanup());await tick();
 const pet=d.querySelector('.neko-rail-companion'),character=d.querySelector('.neko-companion-character'),form=d.querySelector('.neko-companion-form'),input=form.querySelector('textarea');
 let boxTop=420;form.getBoundingClientRect=()=>({left:76,right:290,top:boxTop,bottom:boxTop+34,width:214,height:34});
 pet.getBoundingClientRect=()=>({left:parseFloat(pet.style.left)||0,top:200+(parseFloat(pet.style.top)||0),width:44,height:52,right:(parseFloat(pet.style.left)||0)+44,bottom:252+(parseFloat(pet.style.top)||0)});
 input.value='unsent fixture';
 for(const page of ['community','bilibili','youtube']){
  surface(w,d,page);w.dispatchEvent(new w.Event('resize'));await tick();
  assert.equal(character.parentElement,pet,page+': the character sits in the rail');assert(pet.hasAttribute('data-neko-rail-parked'),page+': parked, not roaming');
  assert.equal(timers.size,0,page+': no random walk while parked');
  const top=200+parseFloat(pet.style.top);assert(Math.abs((top+26)-(boxTop+17))<=1,page+': centred on the chat box');
 }
 boxTop=380;w.dispatchEvent(new w.Event('resize'));await tick();
 assert(Math.abs((200+parseFloat(pet.style.top)+26)-(boxTop+17))<=1,'the character follows the box when the window resizes');
 const pointer=(type,x,y)=>{const e=new w.MouseEvent(type,{bubbles:true,cancelable:true,button:0,clientX:x,clientY:y});Object.defineProperty(e,'pointerId',{value:1});pet.dispatchEvent(e);};
 pointer('pointerdown',20,400);pointer('pointermove',20,260);pointer('pointerup',20,260);const dragged=pet.style.top;
 pet.click();assert(d.querySelector('.neko-companion-menu').hidden,'dragging must not open the menu');
 boxTop=360;w.dispatchEvent(new w.Event('resize'));await tick();assert.equal(pet.style.top,dragged,'a manual drag holds while the page stays');
 await tick();pet.click();await tick();assert(d.querySelector('.neko-companion-dock').hasAttribute('data-neko-companion-rail-chat'),'a plain click opens the existing private chat');assert.equal(input.value,'unsent fixture');
 d.querySelector('.neko-companion-menu').hidden=true;
 surface(w,d,'hidden');w.dispatchEvent(new w.Event('resize'));await tick();
 assert.equal(pet.hasAttribute('data-neko-rail-parked'),false,'leaving the page releases the parking');
 assert.equal(input.value,'unsent fixture','the companion draft survives page switches');
});

test('「公共聊天室」 opens the real channel in the main work area and stays selected',{skip:DOM_SKIP},async t=>{
 const dom=new JSDOM('<body><aside data-neko-side-rail><div class="neko-side-rail__theme"></div></aside><div data-slot="sidebar"><div data-neko-seat-mount></div><div data-slot="sidebar.workspaces">native</div><div data-slot="settings.launcher"></div></div><main><textarea>native draft</textarea></main></body>',{runScripts:'outside-only'});
 t.after(()=>dom.window.close());const w=dom.window,d=w.document;d.querySelector('[data-slot="sidebar"]').getBoundingClientRect=()=>({left:64,top:0,right:300,bottom:800,width:236,height:800});
 const calls=[];let layout={seats:[],activeSeatId:null,officeMode:'dsh',companionCollapsed:false,companionHistoryOpen:false};
 const snap={connection:'offline',auth:{status:'signed-out',message:'尚未登录频道。',error:'',signingIn:false},participation:{mode:'off',available:false,reason:''},loading:false,me:null,channel:null,messages:[],hasMore:false,members:[],outbox:[],catSettings:{},cat:{},suggestion:null,nudge:null,error:''};
 const bridge={getState:async()=>({workspaceRoot:'/fixture',workspaceRevision:0,companion:{ready:true,messages:[]}}),action:async()=>({ok:true}),subscribe:()=>()=>{},companion:async()=>({}),
  workspace:async r=>{if(r.action==='update')layout={...layout,...r.patch};if(r.action==='codex-state')return {items:[],approvals:[]};if(r.action==='catalog')return {sessions:[],projects:[],providers:{dsh:'ready'}};return structuredClone(layout);},
  lobby:async r=>{calls.push(r.action);return {ok:true,state:snap};},subscribeLobby:()=>()=>{}};
 w.eval(read('embedded-dsh/chatroom-preview-source.js'));w.eval(read('embedded-dsh/workspace-shell-source.js')+'\nwindow.install=installWorkspaceShell');
 let hidden=0;const cleanup=w.install({window:w,document:d,bridge,avatar:()=>'',hideSocial:()=>{hidden++;}});t.after(()=>cleanup());await tick();
 const row=[...d.querySelectorAll('.neko-chatroom-preview__room')].find(n=>/公共聊天室/.test(n.textContent));
 assert.equal(row.tagName,'BUTTON','the public room row is actionable');
 row.click();await tick();
 const panel=d.querySelector('.neko-lobby-panel');
 assert.equal(panel.hidden,false);assert(panel.hasAttribute('data-neko-lobby-in-room'),'opens inside the room column');
 assert.equal(hidden,0,'does not close other pages');assert(d.querySelector('.neko-companion-dock textarea'),'companion dock stays');
 assert.match(panel.textContent,/尚未登录频道|登录频道/,'shows the real sign-in state, no demo messages');
 assert.equal(d.querySelectorAll('.neko-lobby-message').length,0);
 
 assert.equal(panel.hidden,false,'the room conversation stays in the main area');assert.equal(d.querySelector('.neko-chatroom-preview').hidden,false);
 assert.equal(d.querySelector('main textarea').value,'native draft');
});
