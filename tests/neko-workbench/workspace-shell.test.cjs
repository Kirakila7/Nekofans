'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),vm=require('node:vm'),{spawn}=require('node:child_process');
const {createWorkspaceLayout}=require('../../apps/neko-workbench/workspace-layout.cjs');
const {readDshWorkspaceCatalog}=require('../../apps/neko-workbench/dsh-workspace-catalog.cjs');
const {createWorkspaceController,companionSnapshot}=require('../../apps/neko-workbench/workspace-controller.cjs');
const {createCodexWorkspace}=require('../../apps/neko-workbench/codex-workspace.cjs');
const base=path.resolve(__dirname,'../../apps/neko-workbench');
const tick=()=>new Promise(r=>setTimeout(r,15));
// Child-process fixtures reply asynchronously; wait for the observable condition instead of a fixed delay.
const until=async(check,ms=3000)=>{const end=Date.now()+ms;while(!check()&&Date.now()<end)await tick();};
function temp(t){const p=fs.mkdtempSync(path.join(os.tmpdir(),'neko-workspace-test-'));t.after(()=>fs.rmSync(p,{recursive:true,force:true}));return p;}
let JSDOM;try{({JSDOM}=require(path.join(process.env.NEKO_DOM_DEPS||'/private/tmp/neko-sidebar-dom-20261026','node_modules/jsdom')));}catch{}
test('project directory shortcut uses the current native session and preserves the draft',{skip:!JSDOM},async t=>{
 const dom=new JSDOM('<body><aside data-neko-side-rail><div class="neko-side-rail__theme"></div></aside><aside data-slot="sidebar"><div data-slot="settings.launcher"></div></aside><main data-neko-chat-center><div data-composer-seat><div data-composer-card><textarea>未发送草稿</textarea></div></div></main></body>',{runScripts:'outside-only',pretendToBeVisual:true});t.after(()=>dom.window.close());
 const w=dom.window,d=w.document,sidebar=d.querySelector('[data-slot="sidebar"]'),center=d.querySelector('main'),composer=d.querySelector('[data-composer-card]'),store=createWorkspaceLayout(path.join(temp(t),'layout.json'));let active=false,opened=0,fail=false;
 sidebar.getBoundingClientRect=()=>({left:64,top:0,right:304,bottom:800,width:240,height:800});center.getBoundingClientRect=()=>({left:304,top:0,right:1024,bottom:800,width:720,height:800});composer.getBoundingClientRect=()=>({left:320,top:600,right:1000,bottom:760,width:680,height:160});
 const bridge={getState:async()=>({workspaceRoot:'/p',workspaceRevision:0,companion:{ready:true,messages:[]}}),companion:async()=>({}),workspace:async r=>{if(r.action==='state')return {...store.get(),codexAvailable:false};if(r.action==='codex-state')return {items:[],approvals:[]};if(r.action==='catalog')return {sessions:[],projects:[],providers:{dsh:'ready',codex:'testing'}};return null;}};
 w.eval(fs.readFileSync(path.join(base,'embedded-dsh/workspace-shell-source.js'),'utf8')+'\nwindow.install=installWorkspaceShell');const stop=w.install({window:w,document:d,bridge,avatar:()=>'',locateSidebar:()=>({root:sidebar,slot:sidebar}),hasDshActiveSession:()=>active,openDshFiles:el=>{assert.equal(el,d.querySelector('.neko-workspace-directory__button'));opened++;if(fail)throw Error('no native target');}});await tick();
 const control=d.querySelector('.neko-workspace-directory'),button=control.querySelector('button'),status=control.querySelector('[role=status]');assert(!control.hidden);assert.equal(button.getAttribute('aria-label'),'打开当前项目目录');button.click();assert.match(status.textContent,/先打开工作会话/);assert.equal(opened,0);
 active=true;w.dispatchEvent(new w.Event('resize'));await tick();button.click();assert.equal(opened,1);assert(status.hidden);assert.equal(d.querySelector('main textarea').value,'未发送草稿');
 fail=true;button.click();assert.equal(opened,2);assert.match(status.textContent,/暂未打开/);assert.equal(d.querySelector('main textarea').value,'未发送草稿');
 center.setAttribute('data-neko-unified-coding','');d.body.setAttribute('data-neko-unified-enabled','');await tick();assert(!control.hidden);assert.equal(control.style.left,'980px');assert.equal(control.style.top,'560px');center.setAttribute('data-neko-unified-coding','hidden');await tick();assert(control.hidden,'directory shortcut follows coding visibility');center.setAttribute('data-neko-unified-coding','');d.body.removeAttribute('data-neko-unified-enabled');await tick();
 d.body.setAttribute('data-neko-workspace-collapsed','');await tick();assert(control.hidden,'directory shortcut must not cover the compact composer');d.body.removeAttribute('data-neko-workspace-collapsed');await tick();assert(!control.hidden);stop();assert(!d.querySelector('.neko-workspace-directory'));
});
test('leaving dark mode releases the palette aliases the shell mirrors',{skip:!JSDOM},async t=>{
 const dom=new JSDOM('<body><aside data-slot="sidebar"><div data-slot="settings.launcher"></div></aside><main data-neko-chat-center><div data-composer-seat><div data-composer-card><textarea></textarea></div></div></main></body>',{runScripts:'outside-only',pretendToBeVisual:true});t.after(()=>dom.window.close());
 const w=dom.window,d=w.document,sidebar=d.querySelector('[data-slot="sidebar"]'),center=d.querySelector('main'),store=createWorkspaceLayout(path.join(temp(t),'layout.json'));
 sidebar.getBoundingClientRect=()=>({left:64,top:0,right:304,bottom:800,width:240,height:800});center.getBoundingClientRect=()=>({left:304,top:0,right:1024,bottom:800,width:720,height:800});
 const bridge={getState:async()=>({workspaceRoot:'/p',workspaceRevision:0,companion:{ready:true,messages:[]}}),companion:async()=>({}),workspace:async r=>{if(r.action==='state')return {...store.get(),codexAvailable:false};if(r.action==='codex-state')return {items:[],approvals:[]};if(r.action==='catalog')return {sessions:[],projects:[],providers:{dsh:'ready',codex:'testing'}};return null;}};
 w.eval(fs.readFileSync(path.join(base,'embedded-dsh/workspace-shell-source.js'),'utf8')+'\nwindow.install=installWorkspaceShell');const stop=w.install({window:w,document:d,bridge,avatar:()=>'',locateSidebar:()=>({root:sidebar,slot:sidebar}),hasDshActiveSession:()=>false,openDshFiles:()=>{}});await tick();
 d.body.setAttribute('data-ds-dark-theme','');await until(()=>d.body.style.getPropertyValue('--dsw-alias-interactive-bg-hover')==='#262830');
 d.body.removeAttribute('data-ds-dark-theme');await until(()=>d.body.style.getPropertyValue('--dsw-alias-interactive-bg-hover')==='');
 for(const name of ['--dsw-alias-bg-base','--dsw-alias-bg-layer-1','--dsw-alias-label-primary','--dsw-alias-interactive-bg-hover']){assert.equal(d.body.style.getPropertyValue(name),'',name+' must not stay inline after light mode');}
 stop();
});
test('three seats persist independent names, avatars, platform and project scopes without changing sessions',t=>{
 const p=path.join(temp(t),'layout.json'),s=createWorkspaceLayout(p);assert.equal(s.get().seats.length,3);assert.equal(s.get().companionHistoryOpen,false);
 s.updateSeat('seat-3',{name:'设计小助手',provider:'codex',avatarId:'gemini',projectRoot:'/my/project'});s.update({activeSeatId:'seat-3',companionCollapsed:true,companionHistoryOpen:true,officeMode:'codex'});
 const saved=createWorkspaceLayout(p).get();assert.equal(saved.seats[2].name,'设计小助手');assert.equal(saved.seats[2].provider,'codex');assert.equal(saved.seats[2].projectRoot,'/my/project');assert.equal(saved.activeSeatId,'seat-3');assert.equal(saved.companionHistoryOpen,true);
 assert.throws(()=>s.update({token:'no'}));assert.throws(()=>s.updateSeat('seat-3',{provider:'shell'}));assert.throws(()=>s.updateSeat('seat-1',{name:'x\u202ey'}));assert.throws(()=>s.updateSeat('seat-1',{projectRoot:'../private'}));
 assert.equal(fs.statSync(p).mode&0o777,0o600);saved.seats[0].name='tampered';assert.notEqual(s.get().seats[0].name,'tampered');
});
test('DSH catalog lists native roots and disposes observations with bounded concurrency',async()=>{
 let active=0,max=0,disposed=0;const rows=Array.from({length:12},(_,i)=>({header:{id:'s'+i,cwd:'/p',createdAt:i,parentSession:i===11?'parent':null}}));
 const r=await readDshWorkspaceCatalog({sessionQuery:{listSessions:async()=>rows,observeSession:async id=>{max=Math.max(max,++active);await tick();return {projections:{values:{title:id+' title'}},[Symbol.dispose](){active--;disposed++;}};}},agents:new Map([['s1',{status:'running'}]])},{offset:0,limit:6});
 assert.equal(r.sessions.length,6);assert.equal(r.nextOffset,6);assert.equal(r.sessions[1].status,'active');assert.equal(disposed,6);assert(max<=4);assert.equal(active,0);
});
test('merged catalog reports partial failures and scopes only to known projects',async t=>{
 const s=createWorkspaceLayout(path.join(temp(t),'layout.json'));let count=0;
 const c=createWorkspaceController({layout:s,codexAvailable:true,codex:{list:async()=>{count++;return {status:'ready',sessions:[{id:'c',provider:'codex',cwd:'/p',updatedAt:1}]};}},readDsh:async()=>{throw Error('private diagnostic');}});
 const r=await c.catalog();assert.equal(r.providers.dsh,'unavailable');assert.equal(r.providers.codex,'ready');assert.equal(r.sessions.length,1);assert.equal(r.projects[0].cwd,'/p');await c.catalog();assert.equal(count,1);assert(!JSON.stringify(r).includes('diagnostic'));
 c.updateSeat('seat-1',{projectRoot:'/p'});assert.throws(()=>c.updateSeat('seat-1',{projectRoot:'/unknown'}));
});
test('companion snapshot is main-only, strips settings and deduplicates final streaming message',()=>{
 const s=companionSnapshot({actors:[{id:'other',messages:[{role:'assistant',text:'private-other'}]},{id:'main',name:'main',messages:[{role:'assistant',text:'hello'}],chatReply:{text:'hello'},chatBackend:'chat-api'}],mainChat:{ready:true,hasKey:true,settings:{baseUrl:'https://api.example',model:'model',key:'SECRET'}}});assert.equal(s.messages.length,1);assert.equal(s.ready,true);assert(!JSON.stringify(s).includes('SECRET'));assert(!JSON.stringify(s).includes('private-other'));
});
function nativeFixture(t,mode='normal'){
 const dir=temp(t),file=path.join(dir,'server.cjs'),log=path.join(dir,'rpc.jsonl');
 fs.writeFileSync(file,`const rl=require('node:readline').createInterface({input:process.stdin}),fs=require('node:fs');
 const out=m=>process.stdout.write(JSON.stringify(m)+'\\n');const row=id=>({id,cwd:${JSON.stringify(dir)},name:'Native '+id,status:{type:'idle'},updatedAt:1});let approval;
 rl.on('line',line=>{const m=JSON.parse(line);fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(m)+'\\n');if(!m.method){approval=m;return;}if(m.id==null)return;
 let result={};if(m.method==='thread/list')result={data:[row('one'),row('two'),{...row('child'),parentThreadId:'one'}],nextCursor:null};
 if(m.method==='model/list'){
  if(${JSON.stringify(mode)}==='models-error'){out({id:m.id,error:{message:'private upstream token'}});return;}
  result=m.params.cursor?{data:[{model:'fixture-fast',displayName:'Fixture Fast',defaultReasoningEffort:'low',supportedReasoningEfforts:[{reasoningEffort:'low',description:'Quick'}]}],nextCursor:null}:{data:[{model:'fixture-deep',displayName:'Fixture Deep',isDefault:true,defaultReasoningEffort:'medium',supportedReasoningEfforts:[{reasoningEffort:'medium',description:'Balanced'},{reasoningEffort:'high',description:'Thorough'}]},{model:'hidden-model',hidden:true},{displayName:'malformed'}],nextCursor:'page-2'};
 }
 if(m.method==='thread/read')result={thread:row(m.params.threadId)};
 if(m.method==='thread/turns/list')result={data:[{id:'old-turn',items:[{id:'user',type:'userMessage',content:[{type:'text',text:'hello'}]},{id:'a',type:'agentMessage',text:'native reply'}]}]};
 if(m.method==='thread/start')result={thread:row('new')};if(m.method==='thread/resume')result={thread:row(m.params.threadId)};
 if(m.method==='turn/start'){result={turn:{id:'turn',status:'inProgress',items:[]}};out({method:'turn/started',params:{threadId:m.params.threadId,turn:result.turn}});
 ${mode==='fast' ? "out({method:'turn/completed',params:{threadId:m.params.threadId,turn:{id:'turn',status:'completed',items:[]}}});" : "setTimeout(()=>out({id:900,method:'item/commandExecution/requestApproval',params:{threadId:m.params.threadId,turnId:'turn',command:'echo test',cwd:"+JSON.stringify(dir)+"}}),5);"}
 }out({id:m.id,result});});`);
 const c=createCodexWorkspace({defaultCwd:dir,resolveExecutable:()=>'/native/codex',spawnProcess:(exe,args,opts)=>{assert.equal(exe,'/native/codex');assert.deepEqual(args,['app-server','--listen','stdio://']);assert.equal(opts.shell,false);return spawn(process.execPath,[file],opts);},timeoutMs:5000});t.after(()=>c.dispose());return {c,dir,messages:()=>fs.existsSync(log)?fs.readFileSync(log,'utf8').trim().split('\n').map(JSON.parse):[]};
}
test('Codex browsing is read-only; explicit send retains native defaults and requires per-operation approval',async t=>{
 const f=nativeFixture(t);assert.equal((await f.c.list()).sessions.length,2);await f.c.read('one');assert.equal(f.c.snapshot().items[1].text,'native reply');assert(!f.messages().some(m=>/resume|start/.test(m.method)));
 await f.c.send({id:'one',cwd:f.dir,message:'work'});await until(()=>f.c.snapshot().approvals.length>0);assert.equal(f.c.snapshot().approvals.length,1);assert(!f.messages().some(m=>m.id===900),'no automatic approval');
 const start=f.messages().find(m=>m.method==='thread/resume');assert.deepEqual(Object.keys(start.params).sort(),['excludeTurns','threadId']);
 const turn=f.messages().find(m=>m.method==='turn/start');assert.deepEqual(Object.keys(turn.params).sort(),['input','threadId']);
 const key=f.c.snapshot().approvals[0].key;f.c.approve(key,'decline');await until(()=>f.messages().some(m=>m.id===900));assert.deepEqual(f.messages().find(m=>m.id===900).result,{decision:'decline'});await f.c.stop();assert(f.messages().some(m=>m.method==='turn/interrupt'));
 await assert.rejects(f.c.send({cwd:'/unknown',message:'work'}));await assert.rejects(f.c.read('secret-id'));
});
test('a turn completing before the start reply never leaves a phantom working task',async t=>{
 const f=nativeFixture(t,'fast');await f.c.list();await f.c.read('one');await f.c.send({id:'one',cwd:f.dir,message:'quick'});assert.equal(f.c.snapshot().status,'idle');await assert.rejects(f.c.stop(),/没有/);
});
test('Codex model selection discovers all visible pages and applies model and effort to both new and existing tasks',async t=>{
 const f=nativeFixture(t,'fast');
 const catalog=await f.c.models();assert.deepEqual(catalog.models.map(m=>m.model),['fixture-deep','fixture-fast']);
 catalog.models[0].displayName='tampered';assert.equal((await f.c.models()).models[0].displayName,'Fixture Deep');
 assert.equal(f.messages().filter(m=>m.method==='model/list').length,2,'concurrent UI and send use the cached native catalog');
 assert(!f.messages().some(m=>/thread\/(start|resume)|turn\/start/.test(m.method)),'listing models never starts a task');
 await f.c.list();await f.c.read('one');
 await f.c.send({id:'one',cwd:f.dir,message:'existing',model:'fixture-deep',effort:'high'});
 let turns=f.messages().filter(m=>m.method==='turn/start');assert.equal(turns[0].params.model,'fixture-deep');assert.equal(turns[0].params.effort,'high');
 assert.equal(f.c.snapshot().thread.model,'fixture-deep');assert.equal(f.c.snapshot().thread.reasoningEffort,'high');
 await f.c.send({cwd:f.dir,message:'new',model:'fixture-fast'});
 const start=f.messages().find(m=>m.method==='thread/start');assert.equal(start.params.model,'fixture-fast');
 turns=f.messages().filter(m=>m.method==='turn/start');assert.equal(turns[1].params.effort,'low','a model switch uses that model default rather than inheriting an incompatible effort');
 assert(!f.messages().some(m=>/config\//.test(m.method)),'model choice does not rewrite native global configuration');
 await f.c.models({force:true});assert.equal(f.messages().filter(m=>m.method==='model/list').length,4);
});
test('unsupported model/effort combinations are rejected before creating or resuming any task',async t=>{
 const f=nativeFixture(t,'fast');
 for(const choice of [{model:'hidden-model'},{model:'missing'},{model:'fixture-fast',effort:'high'},{effort:'high'},{model:42},{model:'fixture-deep',effort:{}}]) await assert.rejects(f.c.send({cwd:f.dir,message:'do not start',...choice}));
 assert(!f.messages().some(m=>/thread\/(start|resume)|turn\/start/.test(m.method)));
});
test('native catalog errors stay sanitized and native-default tasks can still run',async t=>{
 const f=nativeFixture(t,'models-error');await assert.rejects(f.c.models(),e=>!e.message.includes('private upstream token'));
 await f.c.send({cwd:f.dir,message:'use native config'});const turn=f.messages().find(m=>m.method==='turn/start');assert(!('model'in turn.params));assert(!('effort'in turn.params));
});
test('catalog status preserves failed refresh and discloses partially loaded search results',{skip:!JSDOM},async t=>{
 const dom=new JSDOM('<body><aside data-neko-side-rail><div class="neko-side-rail__theme"></div></aside><div data-slot="sidebar"><div data-neko-seat-mount></div><div data-slot="sidebar.workspaces"></div><div data-slot="settings.launcher"></div></div><main></main></body>',{runScripts:'outside-only',pretendToBeVisual:true});t.after(()=>dom.window.close());
 const w=dom.window,d=w.document,sidebar=d.querySelector('[data-slot="sidebar"]'),store=createWorkspaceLayout(path.join(temp(t),'layout.json'));sidebar.getBoundingClientRect=()=>({right:300});let fail=false;
 const bridge={action:async()=>({}),getState:async()=>({workspaceRoot:'/p',workspaceRevision:0}),companion:async()=>({}),workspace:async r=>{if(r.action==='state')return {...store.get(),codexAvailable:false};if(r.action==='update')return {...store.update(r.patch),codexAvailable:false};if(r.action==='codex-state')return {items:[],approvals:[]};if(r.action==='catalog'){if(fail)throw Error('unavailable');return {sessions:[{id:'one',provider:'dsh',cwd:'/p/fish',title:'会话一'}],projects:[],providers:{dsh:'ready',codex:'testing'},nextDshOffset:80};}}};
 w.eval(fs.readFileSync(path.join(base,'embedded-dsh/workspace-shell-source.js'),'utf8')+'\nwindow.install=installWorkspaceShell');const stop=w.install({window:w,document:d,bridge,avatar:()=>'',locateSidebar:()=>({root:sidebar,slot:sidebar})});await tick();
 const heading=()=>d.querySelector('.neko-workspace-project__name');assert.equal(heading().getAttribute('aria-expanded'),'true');assert.match(heading().textContent,/^▾/);heading().click();assert.equal(heading().getAttribute('aria-expanded'),'false');assert.match(heading().textContent,/^▸/);assert.equal(d.querySelectorAll('.neko-workspace-session').length,0);
 const search=d.querySelector('.neko-session-search');search.value=' 会话一 ';search.dispatchEvent(new w.Event('input'));assert.equal(d.querySelectorAll('.neko-workspace-session').length,1,'search expands collapsed matching projects');heading().click();assert.equal(d.querySelectorAll('.neko-workspace-session').length,0,'search matches can be collapsed');search.value='';search.dispatchEvent(new w.Event('input'));assert.equal(heading().getAttribute('aria-expanded'),'false','clearing search restores original collapse state');heading().click();assert.equal(d.querySelectorAll('.neko-workspace-session').length,1);
 search.value='不存在';search.dispatchEvent(new w.Event('input'));assert.match(d.querySelector('.neko-session-status').textContent,/暂无匹配/);assert.match(d.querySelector('.neko-session-status').textContent,/仅搜索已加载的会话/);
 search.value='';search.dispatchEvent(new w.Event('input'));fail=true;d.querySelector('.neko-session-refresh').click();await tick();assert.match(d.querySelector('.neko-session-status').textContent,/工作会话读取失败/);assert.equal(d.querySelectorAll('.neko-workspace-session').length,1,'failed refresh retains the previous list');
 fail=false;d.querySelector('.neko-session-refresh').click();await tick();assert.doesNotMatch(d.querySelector('.neko-session-status').textContent,/读取失败/);stop();
});
test('sidebar session opening shows progress and follows only the native DSH selection',{skip:!JSDOM},async t=>{
 const dom=new JSDOM('<body><aside data-neko-side-rail><div class="neko-side-rail__theme"></div></aside><aside data-slot="sidebar"><div data-neko-seat-mount></div><div data-slot="sidebar.workspaces"></div><div data-slot="settings.launcher"></div></aside><main><textarea>保留草稿</textarea></main></body>',{runScripts:'outside-only',pretendToBeVisual:true});t.after(()=>dom.window.close());
 const w=dom.window,d=w.document,sidebar=d.querySelector('[data-slot="sidebar"]'),store=createWorkspaceLayout(path.join(temp(t),'layout.json'));sidebar.getBoundingClientRect=()=>({right:300});let selection={sessionId:'one'},listener,release,fail=true,opened=[];
 const sessions=[{id:'one',provider:'dsh',cwd:'/p/fish',title:'会话一'},{id:'two',provider:'dsh',cwd:'/p/fish',title:'会话二'}];
 const bridge={action:async()=>({}),getState:async()=>({workspaceRoot:'/p',workspaceRevision:0}),companion:async()=>({}),workspace:async r=>{if(r.action==='state')return {...store.get(),codexAvailable:false};if(r.action==='update')return {...store.update(r.patch),codexAvailable:false};if(r.action==='codex-state')return {items:[],approvals:[]};if(r.action==='catalog')return {sessions,projects:[],providers:{dsh:'ready',codex:'testing'}};}};
 w.eval(fs.readFileSync(path.join(base,'embedded-dsh/workspace-shell-source.js'),'utf8')+'\nwindow.install=installWorkspaceShell');const stop=w.install({window:w,document:d,bridge,avatar:()=>'',locateSidebar:()=>({root:sidebar,slot:sidebar}),getDshSelection:()=>selection,subscribeDshSelection:fn=>{listener=fn;return()=>{};},openDshSession:async id=>{opened.push(id);await new Promise(resolve=>{release=resolve;});if(fail)throw Error('打开失败');}});await tick();
 const rows=()=>[...d.querySelectorAll('.neko-workspace-session')];assert.equal(rows()[0].dataset.selected,'true');assert.equal(rows()[0].getAttribute('aria-current'),'page');assert.equal(rows()[1].dataset.selected,'false');
 rows()[1].click();await tick();assert.match(d.querySelector('.neko-session-status').textContent,/正在打开会话/);assert.equal(d.querySelector('.neko-project-list').getAttribute('aria-busy'),'true');assert(rows().every(row=>row.disabled));assert.match(rows()[1].textContent,/正在打开/);rows()[0].click();assert.deepEqual(opened,['two']);assert.equal(rows()[0].dataset.selected,'true','a pending request is not a confirmed selection');
 release();await tick();assert.match(d.querySelector('.neko-session-status').textContent,/打开失败/);assert.equal(rows()[0].dataset.selected,'true');assert.equal(d.querySelector('main textarea').value,'保留草稿');
 fail=false;rows()[1].click();await tick();selection={sessionId:'two'};listener();assert.equal(rows()[1].dataset.selected,'true');assert.equal(rows()[0].dataset.selected,'false');release();await tick();assert.doesNotMatch(d.querySelector('.neko-session-status').textContent,/打开失败/);assert.equal(d.querySelector('main textarea').value,'保留草稿');
 selection={};listener();assert(rows().every(row=>row.dataset.selected==='false'),'missing native selection must not claim an active session');stop();
});

test('collapsed workspace keeps the native composer mounted and restores its draft',{skip:!JSDOM},async t=>{
 const dom=new JSDOM('<body><aside data-neko-side-rail><div class="neko-side-rail__theme"></div></aside><aside data-slot="sidebar"><div data-slot="settings.launcher"></div></aside><main data-neko-chat-center><div data-composer-seat><textarea>原有草稿</textarea><button>发送</button></div></main></body>',{runScripts:'outside-only',pretendToBeVisual:true});t.after(()=>dom.window.close());
 const w=dom.window,d=w.document,sidebar=d.querySelector('[data-slot="sidebar"]'),store=createWorkspaceLayout(path.join(temp(t),'layout.json'));sidebar.getBoundingClientRect=()=>({left:64,top:0,right:304,bottom:800,width:240,height:800});
 const bridge={action:async()=>({}),getState:async()=>({workspaceRoot:'/p',workspaceRevision:0,companion:{ready:true,messages:[]}}),companion:async()=>({}),workspace:async r=>{if(r.action==='state')return {...store.get(),codexAvailable:false};if(r.action==='codex-state')return {items:[],approvals:[]};if(r.action==='catalog')return {sessions:[],projects:[],providers:{dsh:'ready',codex:'testing'}};return null;}};
 w.eval(fs.readFileSync(path.join(base,'embedded-dsh/workspace-shell-source.js'),'utf8')+'\nwindow.install=installWorkspaceShell');
 const stop=w.install({window:w,document:d,bridge,avatar:()=>'',locateSidebar:()=>({root:sidebar,slot:sidebar}),hasDshActiveSession:()=>true});await tick();
 let expands=0;d.addEventListener('neko-workspace-expand',()=>{expands++;d.body.removeAttribute('data-neko-workspace-collapsed')});
 const seat=d.querySelector('[data-composer-seat]'),parent=seat.parentElement,input=seat.querySelector('textarea');
 d.body.setAttribute('data-neko-workspace-collapsed','');await tick();
 assert.equal(seat.parentElement,parent);assert(seat.hasAttribute('data-neko-collapsed-composer'));assert.equal(input.value,'原有草稿');assert(!d.querySelector('[data-neko-workspace-expand-control]').hidden);
 d.querySelector('[data-neko-workspace-expand-control]').click();await tick();assert.equal(expands,1);assert(!seat.hasAttribute('data-neko-collapsed-composer'));assert.equal(input.value,'原有草稿');
 input.remove();const inertEditor=d.createElement('div');inertEditor.setAttribute('role','textbox');inertEditor.setAttribute('contenteditable','false');seat.prepend(inertEditor);
 d.body.setAttribute('data-neko-workspace-collapsed','');await tick();assert(seat.hasAttribute('data-neko-collapsed-composer'),'unselected native workspace picker input is still shown');assert.equal(expands,1);
 d.querySelector('[data-neko-workspace-expand-control]').click();await tick();assert.equal(expands,2);
 seat.remove();d.body.setAttribute('data-neko-workspace-collapsed','');await tick();assert.equal(expands,3,'missing composer must expand instead of leaving an unusable workspace');assert(!d.body.hasAttribute('data-neko-workspace-collapsed'));stop();
});

test('compact native composer keeps the input and original controls together',{skip:!JSDOM},async t=>{
 const dom=new JSDOM('<body data-neko-workspace-collapsed><div data-neko-collapsed-composer><div class="test_composerStack"><div class="hero"><div class="neko-gallery"></div></div><div class="test_heroWorkspaceRow"><button>选择工作区</button><button>标准模式</button></div><div><div data-composer-card><div data-input-scroll><div role="textbox" contenteditable="true" data-composer-input>草稿</div></div><div class="test_row"><button>附件</button><button>发送</button></div></div></div></div></div></body>',{pretendToBeVisual:true});t.after(()=>dom.window.close());const w=dom.window,d=w.document,style=d.createElement('style');style.textContent=fs.readFileSync(path.join(base,'embedded-dsh/workspace-shell-source.css'),'utf8');d.head.appendChild(style);
 const seat=d.querySelector('[data-neko-collapsed-composer]'),card=d.querySelector('[data-composer-card]'),input=d.querySelector('[data-composer-input]'),row=d.querySelector('.test_row');
 assert.equal(w.getComputedStyle(card).flexDirection,'row');assert.equal(w.getComputedStyle(input).minHeight,'32px');assert.equal(w.getComputedStyle(row).flexWrap,'wrap');assert.equal(w.getComputedStyle(row).overflow,'visible');assert.equal(w.getComputedStyle(row).flex,'0 0 auto');assert.equal(input.textContent,'草稿');assert.equal(row.querySelectorAll('button').length,2);
 d.body.removeAttribute('data-neko-workspace-collapsed');assert.equal(input.textContent,'草稿');assert.equal(seat.querySelector('.test_heroWorkspaceRow button').textContent,'选择工作区');
});




test('chatroom opens in sidebar by default and workspace switch preserves footer and drafts',{skip:!JSDOM},async t=>{
 const dom=new JSDOM('<body><aside data-neko-side-rail><div class="neko-side-rail__theme"></div><div class="neko-side-rail__space"></div></aside><div id="frame"><div id="track"><aside data-slot="sidebar"><div id="native-group"><button id="unrelated">新会话</button><nav data-neko-tools="folded"><button id="native-plugin">插件</button></nav></div><div data-neko-seat-mount></div><div data-slot="sidebar.workspaces"></div><div id="footer"><div data-slot="settings.launcher"></div></div></aside></div><div class="dsh_centerCol_x"><textarea>工作草稿</textarea></div></div></body>',{runScripts:'outside-only',pretendToBeVisual:true});t.after(()=>dom.window.close());
 const w=dom.window,d=w.document,sidebar=d.querySelector('[data-slot="sidebar"]'), footer=d.querySelector('#footer');
 sidebar.getBoundingClientRect=()=>({left:64,top:0,right:304,bottom:800,width:240,height:800});
 footer.getBoundingClientRect=()=>({left:64,top:640,right:304,bottom:800,width:240,height:160});
 const store=createWorkspaceLayout(path.join(temp(t),'layout.json')),events=[],homeCalls=[];
 const bridge={action:async()=>({}),getState:async()=>({workspaceRoot:'/p',workspaceRevision:0,companion:{ready:true,messages:[]}}),companion:async()=>({}),workspace:async r=>{if(r.action==='state')return store.get();if(r.action==='codex-state')return {items:[],approvals:[]};if(r.action==='catalog')return {sessions:[],projects:[],providers:{}};return null;}};
 d.addEventListener('neko-chatroom-mode-change',()=>events.push(d.body.hasAttribute('data-neko-chatroom-active')));
 w.eval(fs.readFileSync(path.join(base,'embedded-dsh/chatroom-preview-source.js'),'utf8')+'\n'+fs.readFileSync(path.join(base,'embedded-dsh/workspace-shell-source.js'),'utf8')+'\nwindow.install=installWorkspaceShell');
 let communityCalls=0;const stop=w.install({window:w,document:d,bridge,avatar:()=>'',mountHome:stage=>{homeCalls.push(stage);return ()=>homeCalls.push('release');},openCommunity:async()=>{communityCalls++;},cssText:fs.readFileSync(path.join(base,'embedded-dsh/workspace-shell-source.css'),'utf8'),locateSidebar:()=>({root:sidebar,slot:sidebar})});await tick();
 const preview=d.querySelector('[data-neko-chatroom-preview]'),dock=d.querySelector('.neko-companion-dock');
 assert(preview&&!preview.hidden);assert.match(preview.textContent,/聊天功能尚未开放/);
 const home=preview.querySelector('button[aria-label*="我的小窝"]');assert(home);home.click();await tick();assert.equal(homeCalls[0],preview.querySelector('[data-neko-home-stage]'));assert.match(preview.textContent,/工作台本地存档 · 尚未同步/);assert(!preview.hidden);assert.equal(d.querySelector('.dsh_centerCol_x textarea').value,'工作草稿');preview.querySelector('.neko-chatroom-preview__home-back').click();
 const nativeSessions=d.querySelector('[data-slot="sidebar.workspaces"]');
 assert(nativeSessions.hasAttribute('inert'));assert(nativeSessions.hasAttribute('data-neko-room-masked'));assert.equal(w.getComputedStyle(nativeSessions).visibility,'hidden','covered session list cannot bleed through the room footer');assert(!dock.hasAttribute('inert'));assert(!dock.closest('[data-neko-room-masked]'));assert(!footer.hasAttribute('inert'));assert(!footer.closest('[data-neko-room-masked]'));
 const nav=d.querySelector('nav[data-neko-tools]'),group=d.querySelector('#native-group');assert(group.hasAttribute('inert'));
 d.querySelector('.neko-community-yui').click();await tick();assert.equal(communityCalls,1);
 let socialClosed=0;d.addEventListener('neko-side-surface-close',()=>{socialClosed++;d.body.removeAttribute('data-neko-side-social-active');d.dispatchEvent(new w.CustomEvent('neko-side-surface-change',{detail:{surface:'hidden'}}));});
 d.body.setAttribute('data-neko-side-social-active','');d.dispatchEvent(new w.CustomEvent('neko-side-surface-change',{detail:{surface:'community'}}));await tick();
 assert(preview.hidden,'community replaces the room preview');assert(group.hasAttribute('inert'),'covered sidebar controls remain inert');assert(!dock.hasAttribute('inert'),'companion remains accessible');assert.equal(d.querySelector('.neko-room-entry').getAttribute('aria-pressed'),'false');
 d.querySelector('.neko-room-entry').click();await tick();assert.equal(socialClosed,1);assert(!preview.hidden,'room returns after leaving community');assert.equal(d.querySelector('.dsh_centerCol_x textarea').value,'工作草稿');
 home.click();await tick();assert.equal(homeCalls.length,1,'the local home remains mounted');const homeView=preview.querySelector('.neko-chatroom-preview__home-view');assert(!homeView.hidden);
 d.body.setAttribute('data-neko-side-social-active','');d.dispatchEvent(new w.CustomEvent('neko-side-surface-change',{detail:{surface:'youtube'}}));await tick();assert(preview.hidden,'YouTube replaces the social sidebar just like B站');assert(group.hasAttribute('inert'));assert(!dock.hasAttribute('inert'));d.querySelector('.neko-room-entry').click();await tick();assert(!preview.hidden,'room returns after leaving YouTube');assert(!homeView.hidden,'local home stays open across video replacement');assert.equal(homeCalls.length,1,'video switching does not remount or destroy the local home');assert.equal(d.querySelector('.dsh_centerCol_x textarea').value,'工作草稿');preview.querySelector('.neko-chatroom-preview__home-back').click();
 events.length=0;
 nav.setAttribute('data-neko-tools','open');await tick();assert(!nav.closest('[inert]'),'the visible original menu and its ancestors are interactive');assert(!nav.closest('[data-neko-room-masked]'),'opening tools restores visibility on their path');assert(d.querySelector('#unrelated').hasAttribute('inert'),'other controls behind the preview remain inert');assert(d.querySelector('#unrelated').hasAttribute('data-neko-room-masked'));assert(nativeSessions.hasAttribute('inert'));
 d.querySelector('#native-plugin').addEventListener('click',()=>d.dispatchEvent(new w.Event('neko-native-tools-navigate')));d.querySelector('#native-plugin').click();
 nav.setAttribute('data-neko-tools','folded');await tick();assert(group.hasAttribute('inert'),'folded native tools become inert behind the preview again');
 d.querySelector('.neko-room-workspace').click();await tick();assert(preview.hidden);assert(!nativeSessions.hasAttribute('inert'));assert(!nativeSessions.hasAttribute('data-neko-room-masked'));assert.notEqual(w.getComputedStyle(nativeSessions).visibility,'hidden');assert.equal(d.querySelector('.dsh_centerCol_x textarea').value,'工作草稿');assert.deepEqual(events,[false]);
 d.querySelector('.neko-room-entry').click();await tick();assert(!preview.hidden);assert.deepEqual(events,[false,true]);
 stop();assert.equal(homeCalls.at(-1),'release');assert(!d.body.hasAttribute('data-neko-chatroom-active'));assert(!nativeSessions.hasAttribute('inert'));assert(!nativeSessions.hasAttribute('data-neko-room-masked'));assert(!d.querySelector('[data-neko-chatroom-preview]'));
});
test('room companion follows the visible left track and restores its original footer without losing the draft',{skip:!JSDOM},async t=>{
 const dom=new JSDOM('<body><aside data-neko-side-rail><div class="neko-side-rail__theme"></div></aside><div><aside data-slot="sidebar"><div data-slot="sidebar.workspaces"></div><div id="footer"><div data-slot="settings.launcher"></div></div></aside><main data-neko-chat-center></main></div></body>',{runScripts:'outside-only',pretendToBeVisual:true});t.after(()=>dom.window.close());
 const w=dom.window,d=w.document,sidebar=d.querySelector('[data-slot="sidebar"]'),rail=d.querySelector('[data-neko-side-rail]'),center=d.querySelector('main'),account=d.querySelector('[data-slot="settings.launcher"]');let edge=700;
 rail.getBoundingClientRect=()=>({left:0,right:64,width:64});sidebar.getBoundingClientRect=()=>({left:64,right:304,top:0,bottom:768,width:240,height:768});center.getBoundingClientRect=()=>({left:edge,right:1024,top:0,bottom:768,width:1024-edge,height:768});account.getBoundingClientRect=()=>({left:64,right:304,top:700,bottom:768,width:240,height:68});
 const store=createWorkspaceLayout(path.join(temp(t),'layout.json'));const bridge={action:async()=>({}),getState:async()=>({workspaceRoot:'/p',workspaceRevision:0,companion:{ready:true,messages:[]}}),companion:async()=>({}),nativeComposer:async()=>({ok:true}),subscribeNativeComposer:()=>()=>{},workspace:async r=>r.action==='state'?store.get():r.action==='codex-state'?{items:[],approvals:[]}:r.action==='catalog'?{sessions:[],projects:[],providers:{}}:null};
 w.eval(fs.readFileSync(path.join(base,'embedded-dsh/chatroom-preview-source.js'),'utf8')+'\n'+fs.readFileSync(path.join(base,'embedded-dsh/workspace-shell-source.js'),'utf8')+'\nwindow.install=installWorkspaceShell');
 const stop=w.install({window:w,document:d,bridge,avatar:()=>'',locateSidebar:()=>({root:sidebar,slot:sidebar})});await tick();const dock=d.querySelector('.neko-companion-dock'),input=dock.querySelector('textarea');dock.getBoundingClientRect=()=>({left:64,right:edge,top:500,bottom:700,width:edge-64,height:200});w.dispatchEvent(new w.Event('resize'));await tick();input.value='还没发送';
 assert.equal(dock.parentElement,d.body);assert.equal(d.body.style.getPropertyValue('--neko-companion-left'),'64px');assert.equal(d.body.style.getPropertyValue('--neko-companion-width'),'636px');assert.equal(d.body.style.getPropertyValue('--neko-companion-bottom'),'68px');
 edge=450;w.dispatchEvent(new w.Event('resize'));await tick();assert.equal(d.body.style.getPropertyValue('--neko-companion-width'),'386px');
 edge=950;d.body.setAttribute('data-neko-workspace-collapsed','');await tick();assert.equal(d.body.style.getPropertyValue('--neko-companion-width'),'452px','main-agent chat avoids the floating work composer');d.body.removeAttribute('data-neko-workspace-collapsed');edge=450;w.dispatchEvent(new w.Event('resize'));await tick();
 const sprite=dock.querySelector('.neko-companion-character');const pointer=(target,type,x,buttons=1)=>{const e=new w.MouseEvent(type,{bubbles:true,button:0,buttons,clientX:x});Object.defineProperties(e,{pointerId:{value:1},pointerType:{value:'mouse'}});target.dispatchEvent(e);};
 pointer(sprite,'pointerdown',100);assert(Number(sprite.getAttribute('aria-valuemax')) > 48,'expanded dock permits more than the original narrow range');pointer(sprite,'pointermove',130);assert(sprite.hasAttribute('data-dragging'));pointer(d.body,'pointerup',900,0);assert(!sprite.hasAttribute('data-dragging'),'release outside the pet clears drag');sprite.click();assert(d.querySelector('.neko-companion-menu').hidden,'outside release after dragging does not open menu');
 pointer(sprite,'pointerdown',100);w.dispatchEvent(new w.Event('blur'));assert(!sprite.hasAttribute('data-dragging'),'window blur clears drag');pointer(sprite,'pointerdown',100);pointer(d.body,'pointermove',900,0);assert(!sprite.hasAttribute('data-dragging'),'an unpressed mouse clears a missed release');
 const railCompanion=d.querySelector('.neko-rail-companion');
 for(const surface of ['community','bilibili','youtube']) {
  d.dispatchEvent(new w.CustomEvent('neko-side-surface-change',{detail:{surface}}));await tick();
  assert.equal(dock.parentElement,account.parentElement);assert(!dock.hasAttribute('data-neko-companion-expanded'));
  assert(rail.contains(railCompanion));assert(!railCompanion.hidden);assert.equal(sprite.parentElement,railCompanion,`${surface} moves the companion to the narrow rail`);
  assert.equal(input.value,'还没发送');
  d.dispatchEvent(new w.CustomEvent('neko-side-surface-change',{detail:{surface:'hidden'}}));await tick();
  assert.equal(dock.parentElement,d.body);assert(dock.hasAttribute('data-neko-companion-expanded'));assert.equal(sprite.parentElement,dock,`${surface} restores the companion to the room`);assert.equal(input.value,'还没发送');
 }
 stop();
});
test('workspace DOM keeps three configurable filters, all sessions reset, collapsible private chat and native UI restoration',{skip:!JSDOM},async t=>{
 const dom=new JSDOM('<body><aside data-neko-side-rail><div class="neko-side-rail__theme" aria-hidden="true"></div></aside><div data-slot="sidebar"><button data-neko-new-session="plus">+</button><div class="neko-mode-switch">工作区 休闲区</div><div data-neko-seat-mount></div><div data-slot="sidebar.workspaces">native sessions</div><div data-slot="settings.launcher"></div></div><main><textarea>native draft</textarea></main></body>',{runScripts:'outside-only'});t.after(()=>dom.window.close());
 const {window:w}=dom,doc=w.document; const boundsRoot=doc.querySelector('[data-slot="sidebar"]'); boundsRoot.getBoundingClientRect=()=>({right:300}); const store=createWorkspaceLayout(path.join(temp(t),'layout.json'));const calls=[];let subscriber,releaseAction;const state={workspaceRoot:'/p',workspaceRevision:0,companion:{name:'主agent',ready:true,messages:[{role:'assistant',text:'实际历史'}]}};
 const bridge={action:async action=>{calls.push({action});if(action==='task-notes')await new Promise(r=>releaseAction=r);if(action==='open-neko')throw Error('本机服务未启动');return {ok:true};},getState:async()=>state,subscribe:fn=>{subscriber=fn;return ()=>{};},companion:async x=>{calls.push(x);return {};},workspace:async r=>{calls.push(r);if(r.action==='state')return store.get();if(r.action==='update')return store.update(r.patch);if(r.action==='update-seat')return store.updateSeat(r.id,r.patch);if(r.action==='codex-state')return {items:[],approvals:[]};if(r.action==='catalog')return {sessions:[{id:'c',provider:'codex',cwd:'/p',title:'Codex任务'},{id:'d',provider:'dsh',cwd:'/p',title:'DSH任务'}],projects:[{cwd:'/p'}],providers:{dsh:'ready',codex:'ready'}};}};
 w.eval(fs.readFileSync(path.join(base,'embedded-dsh/workspace-shell-source.js'),'utf8')+'\nwindow.install=installWorkspaceShell');
 const cleanup=w.install({window:w,document:doc,bridge,avatar:()=>'',openDshNew:root=>calls.push({action:'dsh-new',root}),companionPosterSrc:'data:image/png;base64,iVBORw0KGgo=',settingsActions:[['open-neko','打开 N.E.K.O.'],['task-notes','任务备注'],['connect-neko','连接 N.E.K.O.'],['reconnect-workbench','重新连接工作台'],['connection-status','连接详情']],cssText:fs.readFileSync(path.join(base,'embedded-dsh/workspace-shell-source.css'),'utf8'),locateSidebar:()=>({root:boundsRoot,slot:doc.createElement('div')})});await tick();
 assert.equal(doc.querySelectorAll('.neko-custom-seat').length,3);assert.equal(doc.querySelectorAll('.neko-workspace-session').length,2);assert.equal(doc.querySelector('.neko-companion-history').textContent,'回复：实际历史');assert(doc.querySelector('.neko-companion-history').hidden);assert.equal(doc.querySelector('.neko-companion-header'),null);assert.equal(doc.querySelector('.neko-companion-connect'),null);assert(doc.querySelector('.neko-companion-status').hidden);
 assert.equal(w.getComputedStyle(doc.querySelector('.neko-mode-switch')).display,'none');assert.equal(w.getComputedStyle(doc.querySelector('.neko-home-work-switch')).display,'flex');assert.equal(w.getComputedStyle(doc.querySelector('[data-neko-new-session]')).visibility,'hidden');
 assert.equal(doc.querySelectorAll('.neko-custom-seat__new').length,3);assert([...doc.querySelectorAll('.neko-custom-seat__new')].every(b=>b.nextElementSibling.classList.contains('neko-custom-seat__provider')));
 doc.querySelectorAll('.neko-custom-seat__new')[1].click();await tick();assert.equal(store.get().officeMode,'codex');assert.equal(store.get().activeSeatId,'seat-2');assert(!doc.querySelector('.neko-office-panel').hidden);
 doc.querySelectorAll('.neko-custom-seat__new')[0].click();await tick();assert.equal(store.get().officeMode,'dsh');assert.equal(store.get().activeSeatId,'seat-1');assert.equal(calls.filter(r=>r.action==='dsh-new').length,0);
 doc.querySelectorAll('.neko-custom-seat__new')[2].click();assert(!doc.querySelector('.neko-workspace-modal').hidden);assert(doc.querySelector('.neko-seat-editor'));assert.equal(store.get().activeSeatId,'seat-1');doc.querySelector('.neko-workspace-modal__close').click();
 await bridge.workspace({action:'update',patch:{activeSeatId:null}});subscriber({...state,workspaceRevision:99});await tick();
 const dock=doc.querySelector('.neko-companion-dock'),sprite=doc.querySelector('.neko-companion-character');let dockWidth=260;Object.defineProperty(dock,'clientWidth',{get:()=>dockWidth});Object.defineProperty(sprite,'offsetWidth',{value:76});dock.getBoundingClientRect=()=>({left:64,right:324,top:400,bottom:520,width:260,height:120});w.dispatchEvent(new w.Event('resize'));await tick();
 const pointer=(type,x,y=0)=>{const event=new w.MouseEvent(type,{bubbles:true,button:0,clientX:x,clientY:y});Object.defineProperty(event,'pointerId',{value:1});sprite.dispatchEvent(event);};
 sprite.dispatchEvent(new w.KeyboardEvent('keydown',{key:'Home'}));assert.equal(sprite.getAttribute('aria-valuenow'),'0');
 pointer('pointerdown',100);pointer('pointermove',1000,1000);assert.equal(sprite.getAttribute('aria-valuenow'),'48','right drag clamps in the small bottom region');pointer('pointermove',-1000,-1000);assert.equal(sprite.getAttribute('aria-valuenow'),'-48','vertical pointer movement never escapes the horizontal track');pointer('pointerup',-1000);assert(!sprite.hasAttribute('data-dragging'));
 dockWidth=100;pointer('pointerdown',0);pointer('pointermove',1000);assert.equal(sprite.getAttribute('aria-valuenow'),'4','narrow sidebars constrain dragging further');pointer('pointercancel',1000);dockWidth=260;sprite.dispatchEvent(new w.KeyboardEvent('keydown',{key:'Home'}));assert.equal(sprite.getAttribute('aria-valuenow'),'0');
 const seatMount=doc.querySelector('.neko-custom-seats').parentElement,officeSwitchMount=doc.querySelector('.neko-office-switch').parentElement;
 doc.querySelectorAll('.neko-custom-seat__pick')[1].click();await tick();
 assert.equal(doc.querySelectorAll('.neko-workspace-session').length,1);assert.equal(doc.querySelector('.neko-workspace-session').textContent,'Codex任务');
 assert.equal(store.get().officeMode,'codex','choosing the Codex seat switches the right-hand engine in the same update');
 assert.deepEqual(structuredClone(calls.find(r=>r.action==='update'&&r.patch.activeSeatId==='seat-2').patch),{activeSeatId:'seat-2',officeMode:'codex'});
 assert(!doc.querySelector('.neko-office-panel').hidden);assert(doc.querySelector('main').hasAttribute('inert'),'the DSH composer cannot receive input under the Codex view');
 assert.match(doc.querySelector('.neko-office-switch').getAttribute('aria-label'),/工作界面：Codex/);
 const codexDraft=doc.querySelector('.neko-office-form textarea');codexDraft.value='Codex 未发送草稿';codexDraft.dispatchEvent(new w.Event('input',{bubbles:true}));
 doc.querySelectorAll('.neko-custom-seat__pick')[0].click();await tick();
 assert.equal(store.get().officeMode,'dsh');assert(doc.querySelector('.neko-office-panel').hidden);assert(!doc.querySelector('main').hasAttribute('inert'));
 assert.equal(doc.querySelector('main textarea').value,'native draft','switching back preserves the DSH draft');
 assert.equal(doc.querySelector('.neko-workspace-session').textContent,'DSH任务');
 doc.querySelectorAll('.neko-custom-seat__pick')[1].click();await tick();
 assert(!doc.querySelector('.neko-office-panel').hidden);assert.equal(codexDraft.value,'Codex 未发送草稿');
 assert.equal(doc.querySelector('.neko-custom-seats').parentElement,seatMount,'existing seat entrance stays in its original mount');
 assert.equal(doc.querySelector('.neko-office-switch').parentElement,officeSwitchMount,'the existing rail switch stays in its original mount');
 doc.querySelector('.neko-session-all').click();await tick();assert.equal(doc.querySelectorAll('.neko-workspace-session').length,2);assert.equal(store.get().officeMode,'codex','all sessions only resets the filter');
 const chatDraft=doc.querySelector('.neko-companion-form textarea'),historyButton=doc.querySelector('.neko-companion-history-toggle');chatDraft.value='保留未发送内容';
 assert.equal(doc.querySelector('.neko-companion-form').firstElementChild,historyButton,'history button is to the left of the input');
 historyButton.click();await tick();assert(!doc.querySelector('.neko-companion-history').hidden);assert(store.get().companionHistoryOpen);assert(!doc.querySelector('.neko-companion-form').hidden);assert.equal(chatDraft.value,'保留未发送内容');assert.equal(historyButton.getAttribute('aria-expanded'),'true');
 doc.querySelector('.neko-companion-history').focus();doc.dispatchEvent(new w.KeyboardEvent('keydown',{key:'Escape',bubbles:true}));await tick();assert(doc.querySelector('.neko-companion-history').hidden);assert(!store.get().companionHistoryOpen);assert.equal(chatDraft.value,'保留未发送内容');

 doc.querySelectorAll('.neko-custom-seat__settings')[2].click();doc.querySelector('.neko-seat-editor input').value='开发二号';doc.querySelector('.neko-seat-editor').dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));await tick();assert.equal(store.get().seats[2].name,'开发二号');assert.match(doc.querySelector('.neko-custom-seats').textContent,/开发二号/);
 await bridge.workspace({action:'update',patch:{officeMode:'codex'}});subscriber({...state,workspaceRevision:1});await tick();assert(!doc.querySelector('.neko-office-panel').hidden);assert.equal(doc.querySelector('.neko-office-panel').style.left,'300px');assert(doc.querySelector('main').hasAttribute('inert'));assert.equal(doc.querySelector('main textarea').value,'native draft');
 const settingsTrigger=doc.querySelector('.neko-workspace-settings');settingsTrigger.focus();settingsTrigger.click();
 const moreSettings=doc.querySelector('.neko-workspace-more-settings');assert(moreSettings&&!moreSettings.open,'additional tools are collapsed initially');assert.match(moreSettings.querySelector('summary').textContent,/更多工具/);
 assert.match(doc.querySelector('.neko-workspace-common').textContent,/账号、隐私 \/ 高级设置/,'privacy and advanced settings remain accessible');
 assert.equal(doc.querySelector('.neko-workspace-layout-setting'),null,'unwanted multi-column layout configuration is removed');doc.querySelector('.neko-workspace-modal__card > header button').click();assert(doc.querySelector('.neko-workspace-modal').hidden);assert.equal(doc.activeElement,settingsTrigger,'close returns focus to its opener');
 settingsTrigger.click();doc.querySelector('.neko-workspace-more-settings').open=true;
 assert.equal(doc.querySelectorAll('[data-workbench-action]').length,5,'all bottom options move to the top-left settings');
 doc.querySelector('[data-workbench-action="open-neko"]').click();await tick();assert.match(doc.querySelector('.neko-workspace-modal').textContent,/本机服务未启动/);
 doc.querySelector('[data-workbench-action="task-notes"]').click();await tick();assert([...doc.querySelectorAll('[data-workbench-action]')].every(b=>b.disabled));releaseAction();await tick();assert(doc.querySelector('.neko-workspace-modal').hidden);
 subscriber({...state,workspaceRevision:1,companion:{...state.companion,ready:false}});await tick();doc.querySelector('.neko-companion-form').requestSubmit();await tick();assert.equal(calls.at(-1).action,'chat-settings','an unconnected send opens the existing settings');assert.equal(chatDraft.value,'保留未发送内容');
 assert.equal(doc.querySelector('.neko-companion-poster').getAttribute('src'),'data:image/png;base64,iVBORw0KGgo=','companion uses the full-body Q figure rather than the head avatar');
 cleanup();assert(!doc.querySelector('main').hasAttribute('inert'));assert(!doc.querySelector('[data-neko-session-browser-original]'));assert.equal(doc.querySelector('.neko-side-rail__theme').getAttribute('aria-hidden'),'true');assert(!doc.querySelector('.neko-companion-dock'));assert(!doc.querySelector('[data-neko-companion-footer]'),'native footer layout is restored on unload');
});

test('installed UI bundle contains the canonical workspace implementation and accessible hero labels',()=>{
 const code=fs.readFileSync(path.join(base,'embedded-dsh/b0-skin/packages/dsh-client-ui-white-label/lib/client.js'),'utf8');
 const source=fs.readFileSync(path.join(base,'embedded-dsh/workspace-shell-source.js'),'utf8');
 const css=fs.readFileSync(path.join(base,'embedded-dsh/workspace-shell-source.css'),'utf8');
 const accountCss=fs.readFileSync(path.join(base,'embedded-dsh/account-habitat-source.css'),'utf8');
 assert(code.includes(source));assert(code.includes(JSON.stringify(css)));
 assert(code.includes('const ACCOUNT_HABITAT_CSS = '+JSON.stringify(accountCss)+';'));
 assert.match(code,/'aria-label': a.name/);assert.match(css,/\.neko-hero-pick__name \{ display:none !important/);
});
