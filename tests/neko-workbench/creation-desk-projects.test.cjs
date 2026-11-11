'use strict';
// Creation desk project chooser, current-project details, real work content,
// and the desktop/host wiring. Synthetic data only; no account or model.
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{EventEmitter}=require('node:events');
const {createNativeComposerController}=require('../../apps/neko-workbench/native-composer-controller.cjs');
const {createNativeComposerAdapter}=require('../../apps/neko-workbench/embedded-dsh/native-composer-source.js');
let JSDOM;try{({JSDOM}=require(path.join(process.env.NEKO_DOM_DEPS||'/private/tmp/neko-sidebar-dom-20261026','node_modules/jsdom')));}catch{}
const base=path.join(__dirname,'../../apps/neko-workbench');
const tick=()=>new Promise(r=>setTimeout(r,20));

function ui(t,initial={}){
 const dom=new JSDOM(fs.readFileSync(path.join(base,'native-composer.html'),'utf8'),{runScripts:'outside-only',url:'https://native-workbench.invalid/'});t.after(()=>dom.window.close());
 const w=dom.window,d=w.document,events=[];let receive;w.nativeComposer={send:x=>events.push(x),onState:cb=>{receive=cb;}};
 w.eval(fs.readFileSync(path.join(base,'hold-drag.js'),'utf8'));w.eval(fs.readFileSync(path.join(base,'native-composer.js'),'utf8'));
 const snap=(revision,value,extra={})=>receive({enabled:true,busy:false,sessionToken:'s1',revision,value,chatOnly:true,...extra});snap(1,'',initial);
 const pointer=(node,type,y,extra={})=>{const e=new w.MouseEvent(type,{bubbles:true,cancelable:true,button:0,screenX:300,screenY:y,...extra});Object.defineProperty(e,'pointerId',{value:5});node.dispatchEvent(e);};
 return {w,d,events,snap,pointer,byId:id=>d.getElementById(id)};
}
const projects=[{id:'p-fish',name:'fish',path:'C:/work/fish',sessions:2,current:true,registered:true},{id:'p-home',name:'home',path:'C:/work/home',sessions:0,current:false,registered:true}];
const currentProject={id:'p-fish',name:'fish',path:'C:/work/fish',registered:true,sessions:[{id:'dsh:s1',title:'当前任务',updatedAt:Date.now()-120000,active:false,current:true},{id:'dsh:s0',title:'较早任务',updatedAt:Date.now()-7200000,active:false,current:false}]};

test('model and project entries are icon-only with hover/focus labels, and the project list selects only real rows',{skip:!JSDOM},t=>{
 const x=ui(t,{projects,currentProject}),model=x.byId('model-toggle'),project=x.byId('project-toggle');
 for(const node of [model,project]){assert.equal(node.textContent.trim(),'','no visible button text');assert(node.querySelector('svg'));assert(node.title);assert(node.getAttribute('aria-label'));}
 assert.equal(x.byId('composer').firstElementChild,model);assert.match(project.title,/fish/);
 project.click();assert(!x.byId('project-panel').hidden);assert.equal(x.events.at(-1).type,'project-toggle');assert.equal(x.events.at(-1).open,true);
 const rows=[...x.byId('project-list').querySelectorAll('button')];assert.deepEqual(rows.map(r=>r.dataset.projectId),['p-fish','p-home']);assert.equal(rows[0].getAttribute('aria-current'),'true');
 rows[1].click();const select=x.events.at(-1);assert.equal(select.type,'project-select');assert.equal(select.projectId,'p-home');assert.equal(select.sessionToken,'s1');assert.equal(select.revision,1);assert(select.selectId>0);
 assert(x.byId('send').disabled,'no send while switching');assert.equal(x.events.filter(e=>e.type==='submit').length,0);
 x.snap(1,'',{projects,currentProject,projectOpen:true,settledProjectSelectId:select.selectId,status:'当前工作输入已变化，请保留草稿后重新选择项目'});assert.match(x.byId('status').textContent,/草稿/);
});

test('a draft blocks switching projects locally and nothing is submitted',{skip:!JSDOM},t=>{
 const x=ui(t,{projects,currentProject});x.snap(2,'未发送草稿',{projects,currentProject});
 x.byId('project-toggle').click();const before=x.events.length;x.byId('project-list').querySelectorAll('button')[1].click();
 assert.equal(x.events.length,before,'no select request while a draft exists');assert.match(x.byId('project-status').textContent,/草稿/);assert.equal(x.byId('message').value,'未发送草稿');
});

test('details arrow toggles on click, resizes on drag or hold without toggling, moving or submitting',{skip:!JSDOM},async t=>{
 const x=ui(t,{projects,currentProject}),arrow=x.byId('details-toggle');
 assert(!x.byId('composer').contains(arrow),'the arrow is outside the form');assert.equal(arrow.type,'button');
 arrow.click();assert(!x.byId('details').hidden);assert.equal(x.events.at(-1).type,'details-toggle');assert.equal(x.events.at(-1).open,true);
 assert.match(x.byId('details-name').textContent,/fish/);assert.equal(x.byId('details-path').textContent,'C:/work/fish');
 assert.equal(x.byId('details-sessions'),null,'history content has no duplicate project-session list');
 x.snap(1,'',{projects,currentProject,detailsOpen:true});
 // Drag: resize events only, and the trailing click does not fold the panel.
 const before=x.events.length;x.pointer(arrow,'pointerdown',500);x.pointer(arrow,'pointermove',470);x.pointer(arrow,'pointermove',440);x.pointer(arrow,'pointerup',440);arrow.click();
 const after=x.events.slice(before);assert.deepEqual(after.map(e=>e.type),['details-resize','details-resize']);assert.deepEqual(after.map(e=>e.delta),[30,30]);assert(!x.byId('details').hidden);
 // Hold without moving: no window move (hold-drag is excluded), no toggle.
 const held=x.events.length;x.pointer(arrow,'pointerdown',440);await new Promise(r=>setTimeout(r,420));x.pointer(arrow,'pointermove',440);x.pointer(arrow,'pointerup',440);arrow.click();
 assert.equal(x.events.slice(held).length,0,'a long press neither moves the window nor toggles');assert(!x.byId('details').hidden);
 arrow.click();assert(x.byId('details').hidden);assert.equal(x.events.at(-1).open,false);assert.equal(x.events.filter(e=>['submit','edit','move'].includes(e.type)).length,0);
 arrow.dispatchEvent(new x.w.KeyboardEvent('keydown',{key:'ArrowUp',bubbles:true}));assert.deepEqual([x.events.at(-1).type,x.events.at(-1).delta],['details-resize',40]);
});

test('details show only the current session real text and never a stale session snapshot',{skip:!JSDOM},t=>{
 const x=ui(t,{projects,currentProject});x.byId('details-toggle').click();
 const items=[{id:'u1',role:'user',text:'整理鱼缸日志'},{id:'a1',role:'assistant',text:'已经整理好了。'}];
 x.snap(1,'',{projects,currentProject,detailsOpen:true,workContent:{sessionId:'other',status:'ready',source:'chat',items}});
 assert.equal(x.byId('details-content').querySelectorAll('.work-item').length,0);assert.match(x.byId('details-content').textContent,/正在读取/);
 x.snap(1,'',{projects,currentProject,detailsOpen:true,workContent:{sessionId:'s1',status:'ready',source:'chat',items}});
 const rows=[...x.byId('details-content').querySelectorAll('.work-item')];assert.deepEqual(rows.map(r=>r.dataset.role),['user','assistant']);assert.match(rows[1].textContent,/已经整理好了/);
 x.snap(1,'',{projects,currentProject,detailsOpen:true,workContent:{sessionId:'s1',status:'ready',source:'outline',items}});assert.match(x.byId('details-content').textContent,/概要/);
 x.snap(1,'',{projects,currentProject,detailsOpen:true,workContent:{sessionId:'s1',status:'empty',source:'chat',items:[]}});assert.match(x.byId('details-content').textContent,/还没有对话内容/);
});

test('adapter reads only user/assistant text from the official chat target and releases it on close and session switch',async()=>{
 let selection={sessionId:'s1'},main='s1';const subs=[],listeners=new Set();
 const shellFor=()=>({state:{getSnapshot:()=>({draft:'',draftRev:1,phase:'plain',attachmentIds:[],occurrences:[]}),subscribe:fn=>{listeners.add(fn);return()=>listeners.delete(fn);}},actions:{setDraft(){},persistDraft(){},submit(){throw Error('never')}}});
 const shells={s1:shellFor(),s2:shellFor()},bindings={s1:{sessionId:'s1',session:{sessionId:'s1'}},s2:{sessionId:'s2',session:{sessionId:'s2'}}};
 const nodes=new Map([['n1',{kind:'user',data:{content:[{type:'text',text:'帮我检查'},{type:'image',url:'x'}]}}],['n2',{kind:'assistant-step',data:{blocks:[{kind:'reasoning',text:'内部推理'},{kind:'tool-call',name:'shell',args:'{"secret":1}'},{kind:'text',text:'检查完毕'}]}}],['n3',{kind:'tool-call',data:{name:'shell'}}]]);
 const target=id=>({subscribe(fn){const s={id,fn,active:true};subs.push(s);return()=>{s.active=false;};},getSnapshot:()=>id==='s1'?{order:['n1','n2','n3'],nodes}:{order:[],nodes:new Map()}});
 const changes=[];const adapter=createNativeComposerAdapter({getSelection:()=>selection,getMainSessionId:()=>main,getBinding:id=>bindings[id],getShell:(_b,id)=>shells[id],getWorkContentTarget:target,onChange:s=>changes.push(s)});
 assert.equal(adapter.snapshot().workContent,undefined,'nothing is read while details are closed');assert.equal(subs.length,0);
 adapter.watchWorkContent(true);const work=adapter.snapshot().workContent;
 assert.equal(subs.length,1);assert.equal(subs[0].id,'s1');assert.equal(work.sessionId,'s1');assert.equal(work.source,'chat');
 assert.deepEqual(work.items.map(i=>[i.role,i.text]),[['user','帮我检查'],['assistant','检查完毕']]);assert(!JSON.stringify(work).includes('内部推理'));assert(!JSON.stringify(work).includes('secret'));
 selection={sessionId:'s2'};main='s2';const next=adapter.snapshot().workContent;assert.equal(subs[0].active,false,'old session subscription released');assert.equal(subs[1].id,'s2');assert.equal(next.sessionId,'s2');assert.equal(next.status,'empty');
 const count=changes.length;subs[0].fn();assert.equal(changes.length,count,'late callbacks of the old session are ignored');
 adapter.watchWorkContent(false);assert.equal(subs[1].active,false,'closing details releases the target');assert.equal(adapter.snapshot().workContent,undefined);
 adapter.dispose();
});

test('adapter switches workspace only from a clean unchanged session',async()=>{
 let draft={draft:'',draftRev:3,phase:'plain',attachmentIds:[],occurrences:[]};const opened=[];
 const shell={state:{getSnapshot:()=>({...draft}),subscribe:()=>()=>{}},actions:{setDraft(){},persistDraft(){},submit(){}}},binding={sessionId:'s1',session:{sessionId:'s1'}};
 const adapter=createNativeComposerAdapter({getSelection:()=>({sessionId:'s1'}),getMainSessionId:()=>'s1',getBinding:()=>binding,getShell:()=>shell,openWorkspace:async id=>{opened.push(id);}});
 await assert.rejects(adapter.openWorkspace({sessionToken:'s1',revision:2,workspaceId:'w2'}),/变化/);
 draft={...draft,draft:'保留'};await assert.rejects(adapter.openWorkspace({sessionToken:'s1',revision:3,workspaceId:'w2'}),/草稿/);
 draft={...draft,draft:''};assert.deepEqual(await adapter.openWorkspace({sessionToken:'s1',revision:3,workspaceId:'w2'}),{ok:true,workspaceId:'w2'});assert.deepEqual(opened,['w2']);
 adapter.dispose();
});

class Contents extends EventEmitter{constructor(){super();this.mainFrame={};this.sent=[];}isDestroyed(){return false;}getZoomFactor(){return 1;}setWindowOpenHandler(){}loadFile(){return Promise.resolve();}send(...args){this.sent.push(args);}}
class Desktop extends EventEmitter{constructor(options){super();this.options=options;this.webContents=new Contents();this.rect={x:0,y:0,width:480,height:120};this.visible=false;Desktop.latest=this;}isDestroyed(){return !!this.destroyed;}destroy(){this.destroyed=true;}isVisible(){return this.visible;}hide(){this.visible=false;}showInactive(){this.visible=true;}moveTop(){}setShape(){}setMenu(){}getBounds(){return {...this.rect};}setBounds(rect){this.rect={...rect};this.emit('move');}}
async function desktop(t){
 const ipc=new EventEmitter(),host=new EventEmitter();host.webContents=new Contents();host.isDestroyed=()=>false;host.isVisible=()=>true;host.isMinimized=()=>false;host.getContentSize=()=>[1000,800];host.getContentBounds=()=>({x:100,y:100,width:1000,height:800});
 const c=createNativeComposerController({BrowserWindow:Desktop,ipcMain:ipc,screen:{getDisplayMatching:()=>({workArea:{x:0,y:0,width:2560,height:1440}})}});t.after(()=>c.dispose());
 c.place(host,{action:'place',rect:{x:500,y:600,width:400,height:64}});c.setEnabled(true);await Promise.resolve();const w=Desktop.latest,event={sender:w.webContents,senderFrame:w.webContents.mainFrame};
 return {c,host,w,input:m=>ipc.emit('neko-composer-input',event,m),forged:m=>ipc.emit('neko-composer-input',{sender:new Contents(),senderFrame:{}},m),hostEvents:()=>host.webContents.sent.filter(([ch])=>ch==='workbench:native-composer-event').map(([,e])=>e)};
}
test('controller forwards project and details events only from the trusted child and validates selection',async t=>{
 const f=await desktop(t);f.c.update({value:'',sessionToken:'s1',revision:4,enabled:true,chatOnly:true,projects:[{id:'p1',name:'p',path:'/p',sessions:1,current:false}],currentProject:{id:'p0',name:'p0',path:'/p0',sessions:[{id:'dsh:old',title:'旧',current:false}]}});
 f.forged({type:'project-select',projectId:'p1',sessionToken:'s1',revision:4,selectId:1});assert.equal(f.hostEvents().length,0,'forged sender ignored');
 f.input({type:'project-select',projectId:'missing',sessionToken:'s1',revision:4,selectId:2});assert.equal(f.hostEvents().length,0);assert.equal(f.w.webContents.sent.at(-1)[1].settledProjectSelectId,2);
 f.input({type:'project-select',projectId:'p1',sessionToken:'s1',revision:3,selectId:3});assert.equal(f.hostEvents().length,0,'stale revision rejected');
 f.input({type:'project-select',projectId:'p1',sessionToken:'s1',revision:4,selectId:4});assert.deepEqual(f.hostEvents().at(-1),{type:'project-select',projectId:'p1',sessionToken:'s1',revision:4,selectId:4});
 f.input({type:'project-select',projectId:'p1',sessionToken:'s1',revision:4,selectId:5});assert.equal(f.hostEvents().filter(e=>e.type==='project-select').length,1,'one switch in flight');
 f.c.update({value:'草稿',sessionToken:'s1',revision:5,enabled:true,projects:[{id:'p1',name:'p',path:'/p',sessions:1}],settledProjectSelectId:4});
 f.input({type:'project-select',projectId:'p1',sessionToken:'s1',revision:5,selectId:6});assert.match(f.w.webContents.sent.at(-1)[1].status,/草稿/);assert.equal(f.hostEvents().filter(e=>e.type==='project-select').length,1);
 f.c.update({value:'',sessionToken:'s1',revision:5,enabled:true,currentProject:{id:'p0',name:'p0',path:'/p0',sessions:[{id:'dsh:old',title:'旧',current:false}]}});
 f.input({type:'record-open',id:'dsh:old',sessionToken:'s1',revision:5,openId:9});assert.equal(f.hostEvents().at(-1).type,'record-open','details sessions may be reopened');
 f.input({type:'details-toggle',open:true});f.input({type:'details-resize',delta:120});f.input({type:'details-resize',delta:99999});f.input({type:'project-refresh'});
 assert.deepEqual(f.hostEvents().slice(-3),[{type:'details-toggle',open:true},{type:'details-resize',delta:120},{type:'project-refresh'}]);
});
test('controller bounds work content and keeps a dragged desk bottom-anchored while a panel grows',async t=>{
 const f=await desktop(t);const long='字'.repeat(5000);
 f.c.update({value:'',sessionToken:'s1',revision:1,enabled:true,workContent:{sessionId:'s1',status:'ready',source:'chat',items:[...Array.from({length:80},(_,i)=>({id:'n'+i,role:i%2?'assistant':'user',text:i===79?long:'t'+i})),{id:'x',role:'tool',text:'args'}]}});
 const work=f.w.webContents.sent.at(-1)[1].workContent;assert.equal(work.items.length<=60,true);assert(work.items.every(i=>['user','assistant'].includes(i.role)));assert(work.items.at(-1).text.length<=2001);
 f.input({type:'move',dx:-100,dy:-200});const compact={...f.w.rect};
 f.c.place(f.host,{action:'place',rect:{x:500,y:600,width:400,height:300}});assert.equal(f.w.rect.y+f.w.rect.height,compact.y+compact.height,'details grow upward from the dragged bottom edge');f.c.place(f.host,{action:'place',rect:{x:500,y:600,width:400,height:900}});assert.equal(f.w.rect.y,100,'a taller panel stops at the owner content top');
 f.c.place(f.host,{action:'place',rect:{x:500,y:600,width:400,height:64}});assert.deepEqual(f.w.rect,compact,'closing details returns the input where it was');
});
test('controller authorizes question identity independently of the work draft and serializes answers',async t=>{
 const f=await desktop(t),question={sessionId:'s1',key:'question:s1:c',revision:7,kind:'question',canAnswer:true,questions:[{id:'q',question:'选择任务',options:[{label:'整理'}]}]},state={value:'原有草稿',sessionToken:'s1',revision:4,enabled:true,question};f.c.update(state);
 const answer={type:'question-action',questionAction:'answer',sessionId:'s1',key:question.key,revision:7,questionSelectionId:1,answers:[{id:'q',selected:['整理']}]};
 f.forged(answer);f.input({...answer,key:'old'});f.input({...answer,answers:[{id:'q',selected:['伪造']}]});assert.equal(f.hostEvents().length,0);
 f.input({type:'submit',value:'原有草稿',sessionToken:'s1',revision:4,submissionId:1});assert.equal(f.hostEvents().length,0,'a pending question never becomes a normal prompt');
 f.input(answer);assert.equal(f.hostEvents().length,1);assert.equal(f.hostEvents()[0].revision,7,'question revision does not use the draft revision');f.input({...answer,questionSelectionId:2});assert.equal(f.hostEvents().length,1);
 f.c.update({...state,settledQuestionSelectionId:1,settledQuestionKey:question.key,settledQuestionRevision:7,question:{...question,submitted:true}});f.input({...answer,questionSelectionId:3});assert.equal(f.hostEvents().length,1);
 f.c.update({...state,question:{...question,key:'question:s1:next',revision:8}});f.input({...answer,key:'question:s1:next',revision:8,questionSelectionId:4});assert.equal(f.hostEvents().length,2,'a new request is not locked by the old answer');
});

function shell(t,{edition='daily',catalog,questionSource=null}={}){
 const dom=new JSDOM('<body><aside data-neko-side-rail></aside><aside data-slot="sidebar"><div data-slot="settings.launcher"></div></aside><main></main></body>',{runScripts:'outside-only',pretendToBeVisual:true});
 const w=dom.window,d=w.document,sidebar=d.querySelector('[data-slot="sidebar"]'),rail=d.querySelector('[data-neko-side-rail]');sidebar.getBoundingClientRect=()=>({left:64,top:0,right:344,bottom:768,width:280,height:768});rail.getBoundingClientRect=()=>({left:0,right:64,top:0,bottom:768,width:64,height:768});
 let handler,layout={workbenchEdition:edition,officeMode:'dsh',seats:[]},selection={sessionId:'s1'},main='s1';const states=[],placements=[],calls=[],opened=[],targets=[];
 const draft={draft:'',draftRev:1,phase:'plain',attachmentIds:[],occurrences:[]},shellState={state:{getSnapshot:()=>({...draft}),subscribe:()=>()=>{}},actions:{setDraft(){},persistDraft(){},submit(){}}};
 const bindings={s1:{sessionId:'s1',session:{sessionId:'s1'}},s9:{sessionId:'s9',session:{sessionId:'s9'}}};let selectionListener;
 let subscriber,revision=0,questionHandler;const questionCalls=[];const bridge={questions:async request=>{questionCalls.push(request);return {ok:true};},subscribeQuestionEvents:fn=>{questionHandler=fn;return()=>{};},subscribe:fn=>{subscriber=fn;return()=>{};},getState:async()=>({workspaceRoot:'/w',workspaceRevision:0,companion:{ready:true,messages:[]}}),companion:async()=>({}),lobby:async()=>({state:{connection:'unconfigured'}}),
  nativeComposer:async r=>{(r.action==='update'?states:placements).push(r.action==='update'?r.state:r);return {ok:true};},subscribeNativeComposer:fn=>{handler=fn;return()=>{};},
  workspace:async r=>{calls.push(r);if(r.action==='state')return layout;if(r.action==='update'){layout={...layout,...r.patch};return layout;}if(r.action==='catalog')return catalog;if(r.action==='resolve-project')return {projectId:r.projectId,workspaceId:'w-'+r.projectId,path:'/x',name:'x'};if(r.action==='codex-state')return {items:[],approvals:[]};return null;}};
 const source=name=>fs.readFileSync(path.join(base,'embedded-dsh',name),'utf8');w.eval(fs.readFileSync(path.join(base,'compact-questions.js'),'utf8')+'\nconst WORKBENCH_QUESTION_FORMS=window.WorkbenchQuestions;\n'+source('question-bridge-source.js')+'\n'+source('native-composer-source.js')+'\n'+source('chatroom-preview-source.js')+'\n'+source('workspace-shell-source.js')+'\nwindow.install=installWorkspaceShell');
 const stop=w.install({window:w,document:d,bridge,avatar:id=>'avatar:'+id,locateSidebar:()=>({root:sidebar}),getDshSelection:()=>selection,hasDshActiveSession:()=>!!main,nativeComposerBindings:{...(questionSource?{getQuestionStatusSource:()=>questionSource}:{}),getSelection:()=>selection,getMainSessionId:()=>main,getBinding:id=>bindings[id],getShell:()=>shellState,subscribeSelection:fn=>{selectionListener=fn;return()=>{};},
  getWorkContentTarget:id=>({subscribe(fn){const s={id,fn,active:true};targets.push(s);return()=>{s.active=false;};},getSnapshot:()=>({order:['u'],nodes:new Map([['u',{kind:'user',data:{content:[{type:'text',text:'会话 '+id+' 的问题'}]}}]])})}),
  async openWorkspace(id){opened.push(id);selection={sessionId:'s9'};main='s9';selectionListener?.();}}});
 t.after(async()=>{stop();await tick();dom.window.close();});
 return {w,d,states,placements,calls,opened,targets,questionCalls,questionHandler:()=>questionHandler,handler:()=>handler,setEdition:async value=>{layout={...layout,workbenchEdition:value};subscriber({workspaceRoot:'/w',workspaceRevision:++revision,companion:{ready:true,messages:[]}});await tick();await tick();}};
}
const catalog={revision:1,sessions:[{id:'s1',provider:'dsh',title:'鱼缸',cwd:'/w/fish',updatedAt:1},{id:'s0',provider:'dsh',title:'旧鱼缸',cwd:'/w/fish',updatedAt:0}],workspaces:[],projects:[{id:'wp:fish',provider:'dsh',cwd:'/w/fish',name:'fish',workspaceId:'wf',needsRegistration:false,sessions:[{id:'s1',provider:'dsh',title:'鱼缸',cwd:'/w/fish',updatedAt:1,status:'idle'},{id:'s0',provider:'dsh',title:'旧鱼缸',cwd:'/w/fish',updatedAt:0,status:'idle'}]},{id:'wp:home',provider:'dsh',cwd:'/w/home',name:'home',workspaceId:'wh',needsRegistration:false,sessions:[]}],providers:{dsh:'ready'}};

test('shell routes creator and nonselected task answers to their actual pending carriers and restores history size',{skip:!JSDOM},async t=>{
 let statuses=new Map();const listeners=new Set(),questionSource={getSnapshot:()=>statuses,subscribe:fn=>{listeners.add(fn);return()=>listeners.delete(fn);}},answers=[];
 const carrier=id=>({sessionId:id,key:'question:'+id+':c',kind:'question',questions:[{id:'q',question:'选择任务',options:[{label:'整理'}]}],getSnapshot:()=>({state:'open',channel:'waterfall',closed:false}),subscribe:()=>()=>{},answer:async value=>{answers.push({id,value});}});
 const f=shell(t,{catalog,questionSource});await tick();await tick();f.handler()({type:'details-toggle',open:true});await tick();assert.equal(f.placements.filter(p=>p.action==='place').at(-1).rect.height,320);
 statuses=new Map([['s1',{pendingInteraction:carrier('s1')}],['s2',{pendingInteraction:carrier('s2')}]]);for(const fn of [...listeners])fn();await tick();
 const published=f.questionCalls.filter(c=>c.action==='publish').at(-1).items;assert.equal(published.length,2);assert.equal(f.states.at(-1).question.sessionId,'s1');assert.equal(f.placements.filter(p=>p.action==='place').at(-1).rect.height,360);
 const pet=published.find(q=>q.sessionId==='s2');await f.questionHandler()({requestId:17,type:'answer',sessionId:'s2',key:pet.key,revision:pet.revision,answers:[{id:'q',selected:['整理']}]});assert.equal(answers[0].id,'s2');assert(f.questionCalls.some(c=>c.action==='result'&&c.requestId===17&&c.ok));
 const own=f.states.at(-1).question;f.handler()({type:'question-action',questionAction:'answer',sessionId:'s1',key:own.key,revision:own.revision,questionSelectionId:9,answers:[{id:'q',selected:['整理']}]});await tick();assert.equal(answers[1].id,'s1');assert(f.states.some(s=>s.settledQuestionSelectionId===9&&s.settledQuestionKey===own.key));
 statuses=new Map();for(const fn of [...listeners])fn();await tick();assert.equal(f.states.at(-1).question,null);assert.equal(f.placements.filter(p=>p.action==='place').at(-1).rect.height,320,'the existing history view returns, not a full-height panel');
});

test('shell publishes real projects, resolves a selection through the host and opens it via the bindings',{skip:!JSDOM},async t=>{
 const f=shell(t,{catalog});await tick();await tick();
 const last=()=>f.states.at(-1);assert.equal(JSON.stringify(last().projects.map(p=>[p.id,p.current])),JSON.stringify([['wp:fish',true],['wp:home',false]]));assert.equal(last().currentProject.name,'fish');assert.equal(JSON.stringify(last().currentProject.sessions.map(s=>[s.id,s.current])),JSON.stringify([['dsh:s1',true],['dsh:s0',false]]));
 f.handler()({type:'project-select',projectId:'wp:home',sessionToken:'s1',revision:1,selectId:7});await tick();await tick();
 assert(f.calls.some(r=>r.action==='resolve-project'&&r.projectId==='wp:home'&&!('path' in r)),'renderer sends only the catalog id');assert.equal(JSON.stringify(f.opened),JSON.stringify(['w-wp:home']));
 assert(f.states.some(s=>s.settledProjectSelectId===7&&!s.status),'selection settles without error');
 f.handler()({type:'project-select',projectId:'unknown',sessionToken:'s9',revision:1,selectId:8});await tick();assert(f.states.some(s=>s.settledProjectSelectId===8&&/刷新/.test(s.status)));assert.equal(f.opened.length,1);
});

test('details default to a compact scrolling panel and still resize; office hides the daily desk and daily restores it',{skip:!JSDOM},async t=>{
 const f=shell(t,{catalog});await tick();await tick();const places=()=>f.placements.filter(p=>p.action==='place');
 f.handler()({type:'details-toggle',open:true});await tick();let rect=places().at(-1).rect;assert.equal(rect.height,320);assert(rect.y>8,'does not fill the whole window');assert.equal(f.states.at(-1).detailsOpen,true);
 const bottom=rect.y+rect.height;f.handler()({type:'details-resize',delta:120});await tick();rect=places().at(-1).rect;assert.equal(rect.height,440);assert.equal(rect.y+rect.height,bottom,'bottom stays anchored');
 f.handler()({type:'details-toggle',open:false});await tick();rect=places().at(-1).rect;assert.equal(rect.height,64);
 const removes=()=>f.placements.filter(p=>p.action==='remove').length,before=removes();
 await f.setEdition('office');assert.equal(f.d.body.dataset.nekoWorkbenchEdition,'office');assert(removes()>before,'office removes the daily creation desk');const count=places().length;
 await f.setEdition('daily');assert(places().length>count,'daily places the desk again');assert.equal(JSON.stringify(places().at(-1).rect),JSON.stringify(rect),'same position on return');
});

test('daily room selector grows proportionally with the window instead of stopping at 300px',{skip:!JSDOM},async t=>{
 const f=shell(t,{catalog});await tick();
 const width=()=>parseFloat(f.d.querySelector('.neko-chatroom-preview')?.style.getPropertyValue('--neko-room-selector-width'));
 Object.defineProperty(f.w,'innerWidth',{value:1186,configurable:true});f.w.dispatchEvent(new f.w.Event('resize'));await tick();const small=width();
 Object.defineProperty(f.w,'innerWidth',{value:2560,configurable:true});f.w.dispatchEvent(new f.w.Event('resize'));await tick();const large=width();
 assert(small>=280&&small<=320,'about the former width at a normal window: '+small);assert(large>600,'maximized selector keeps its share: '+large);
 assert(Math.abs(small/(1186-64)-large/(2560-64))<.02,'roughly the same proportion of the content width');
});

function lobbyView(t,snap,extra={}){
 const dom=new JSDOM('<body></body>',{runScripts:'outside-only',pretendToBeVisual:true});t.after(()=>dom.window.close());const w=dom.window,d=w.document;
 w.eval(fs.readFileSync(path.join(base,'embedded-dsh/workspace-shell-source.js'),'utf8')+'\nwindow.createLobbyView=createLobbyView');
 const el=(tag,className,text)=>{const n=d.createElement(tag);if(className)n.className=className;if(text!==undefined)n.textContent=text;return n;},button=(label,className,click)=>{const n=el('button',className,label);n.type='button';if(click)n.addEventListener('click',click);return n;},image=src=>{const n=el('img');n.src=src||'';return n;};
 const calls=[];let changes=0,neko;const bridge={lobby:async r=>{calls.push(r);return {ok:true,state:snap};},subscribeLobby:()=>()=>{},...extra};
 const view=w.createLobbyView({doc:d,bridge,el,button,image,avatar:()=>'',composer:null,companion:()=>({ready:true}),onOpen:()=>{},onBack:()=>{},onChange:()=>{changes++;}});
 t.after(()=>view.dispose());return {w,d,view,calls,changes:()=>changes};
}
const online={connection:'online',auth:{status:'signed-in'},me:{user_id:'u',display_name:'测试'},channel:{id:'c',cats_enabled:true},messages:[],members:[],catSettings:{}};
test('a ready main-agent route unlocks participation and 猫猫设置 before the first server cat exists, and an unchanged save still creates it',{skip:!JSDOM},async t=>{
 const snap={...online,participation:{mode:'assist',providerAvailable:true,available:false,reason:'先在猫猫设置里保存她'}};
 const f=lobbyView(t,snap);f.view.show();await tick();
 const modes=[...f.d.querySelectorAll('.neko-lobby-mode')];assert.deepEqual(modes.map(b=>b.disabled),[false,false,false]);assert.match(f.d.querySelector('.neko-lobby-reason').textContent,/保存她/);
 f.d.querySelector('.neko-lobby-cat-settings').click();assert(f.view.dialogOpen());assert(f.changes()>0,'the shell is told so it can move her chat aside');
 assert.deepEqual([...f.d.querySelectorAll('.neko-lobby-cat-mode .neko-lobby-choice')].map(b=>b.disabled),[false,false,false]);assert.match(f.d.querySelector('.neko-lobby-cat-api').textContent,/已连接/);
 f.d.querySelector('.neko-lobby-dialog__card').dispatchEvent(new f.w.Event('submit',{cancelable:true}));await tick();
 assert.equal(JSON.stringify(f.calls.filter(r=>r.action==='cat-save')),JSON.stringify([{action:'cat-save'}]),'unchanged save is an idempotent first creation');assert(!f.view.dialogOpen());
});
test('a missing route still only allows 她不参与 and states the reason; legacy snapshots fall back to cat.available',{skip:!JSDOM},async t=>{
 const f=lobbyView(t,{...online,participation:{mode:'off',providerAvailable:false,available:false,reason:'主 agent 未登录 DeepSeek'}});f.view.show();await tick();
 assert.deepEqual([...f.d.querySelectorAll('.neko-lobby-mode')].map(b=>b.disabled),[false,true,true]);
 f.d.querySelector('.neko-lobby-cat-settings').click();assert.match(f.d.querySelector('.neko-lobby-cat-api').textContent,/未登录 DeepSeek/);f.d.querySelector('.neko-lobby-dialog__card').dispatchEvent(new f.w.Event('submit',{cancelable:true}));await tick();assert.equal(f.calls.filter(r=>r.action==='cat-save').length,0);
 const g=lobbyView(t,{...online,cat:{available:true},participation:{mode:'off',available:false,reason:'先在猫猫设置里保存她'}});g.view.show();await tick();assert.deepEqual([...g.d.querySelectorAll('.neko-lobby-mode')].map(b=>b.disabled),[false,false,false]);
});
test('connected is a usable login end state that rejoins the lobby without an error',{skip:!JSDOM},async t=>{
 let notify;const snap={connection:'signed-out',auth:{status:'signed-out'},messages:[],members:[],participation:{mode:'off',available:false}};
 const f=lobbyView(t,snap,{nekoSignIn:async()=>({ok:true,state:{status:'community',source:'lobby',flowId:3}}),subscribeNekoAccount:fn=>{notify=fn;return()=>{};}});
 f.d.addEventListener('neko-account-open-community',e=>{e.detail.handled=true;e.detail.promise=Promise.resolve();});
 f.view.show();await tick();f.d.querySelector('.neko-lobby-sign-in').click();await tick();await tick();
 Object.assign(snap,{connection:'online',auth:{status:'signed-in'},me:{user_id:'u'},channel:{id:'c'}});
 notify({login:{status:'connected',source:'lobby',flowId:3,lobbyAvailable:true,identityStatus:'unverified',message:'社区和聊天室均已登录，可直接使用。'}});await tick();await tick();
 assert.equal(f.d.querySelector('.neko-lobby-error').textContent,'','connected message is not shown as an error');
});

test('details subscribe to the current session work content only while open and release it on close',{skip:!JSDOM},async t=>{
 const f=shell(t,{catalog});await tick();await tick();assert.equal(f.targets.length,0,'closed details read nothing');
 f.handler()({type:'details-toggle',open:true});await tick();await tick();
 assert.equal(f.targets.filter(s=>s.active).length,1);const work=f.states.at(-1).workContent;assert.equal(work.sessionId,'s1');assert.equal(JSON.stringify(work.items.map(i=>i.text)),JSON.stringify(['会话 s1 的问题']));
 f.handler()({type:'details-toggle',open:false});await tick();await tick();assert.equal(f.targets.filter(s=>s.active).length,0,'closing releases the subscription');
});
test('猫猫设置 opened by account A is discarded after switching to B and never saves through B',{skip:!JSDOM},async t=>{
 let push;const a={...online,me:{user_id:'user-a',display_name:'A'},participation:{mode:'assist',providerAvailable:true,available:true}};
 const f=lobbyView(t,a,{subscribeLobby:fn=>{push=fn;return()=>{};}});f.view.show();await tick();
 f.d.querySelector('.neko-lobby-cat-settings').click();assert(f.view.dialogOpen());const nameInput=f.d.querySelector('.neko-lobby-cat-name');nameInput.value='A 的猫';
 const card=f.d.querySelector('.neko-lobby-dialog__card');
 push({...a,me:{user_id:'user-b',display_name:'B'}});await tick();
 assert(!f.view.dialogOpen(),'identity change closes the old form');assert.equal(f.d.querySelector('.neko-lobby-dialog'),null);
 card.dispatchEvent(new f.w.Event('submit',{cancelable:true}));await tick();
 assert.equal(f.calls.filter(r=>r.action==='cat-save').length,0,'a detached A form cannot be submitted');
 // A form whose owner changes before any render is still refused at submit.
 const shared={...a,me:{user_id:'user-a'}},g=lobbyView(t,shared);g.view.show();await tick();g.d.querySelector('.neko-lobby-cat-settings').click();
 const live=g.d.querySelector('.neko-lobby-dialog__card');assert(g.view.dialogOpen());
 shared.me={user_id:'user-b'};// the held snapshot now names B, without a render in between
 live.dispatchEvent(new g.w.Event('submit',{cancelable:true}));await tick();
 assert.equal(g.calls.filter(r=>r.action==='cat-save').length,0,'owner mismatch is refused at submit');assert(!g.view.dialogOpen());
});
