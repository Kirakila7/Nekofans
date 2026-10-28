'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),vm=require('node:vm'),{spawn}=require('node:child_process');
const {createWorkspaceLayout}=require('../../apps/neko-workbench/workspace-layout.cjs');
const {readDshWorkspaceCatalog}=require('../../apps/neko-workbench/dsh-workspace-catalog.cjs');
const {createWorkspaceController,companionSnapshot}=require('../../apps/neko-workbench/workspace-controller.cjs');
const {createCodexWorkspace}=require('../../apps/neko-workbench/codex-workspace.cjs');
const base=path.resolve(__dirname,'../../apps/neko-workbench');
const tick=()=>new Promise(r=>setTimeout(r,15));
function temp(t){const p=fs.mkdtempSync(path.join(os.tmpdir(),'neko-workspace-test-'));t.after(()=>fs.rmSync(p,{recursive:true,force:true}));return p;}
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
 await f.c.send({id:'one',cwd:f.dir,message:'work'});await tick();assert.equal(f.c.snapshot().approvals.length,1);assert(!f.messages().some(m=>m.id===900),'no automatic approval');
 const start=f.messages().find(m=>m.method==='thread/resume');assert.deepEqual(Object.keys(start.params).sort(),['excludeTurns','threadId']);
 const turn=f.messages().find(m=>m.method==='turn/start');assert.deepEqual(Object.keys(turn.params).sort(),['input','threadId']);
 const key=f.c.snapshot().approvals[0].key;f.c.approve(key,'decline');await tick();assert.deepEqual(f.messages().find(m=>m.id===900).result,{decision:'decline'});await f.c.stop();assert(f.messages().some(m=>m.method==='turn/interrupt'));
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
let JSDOM;try{({JSDOM}=require(path.join(process.env.NEKO_DOM_DEPS||'/private/tmp/neko-sidebar-dom-20261026','node_modules/jsdom')));}catch{}
test('workspace DOM keeps three configurable filters, all sessions reset, collapsible private chat and native UI restoration',{skip:!JSDOM},async t=>{
 const dom=new JSDOM('<body><aside data-neko-side-rail><div class="neko-side-rail__theme" aria-hidden="true"></div></aside><div data-slot="sidebar"><button data-neko-new-session="plus">+</button><div class="neko-mode-switch">工作区 休闲区</div><div data-neko-seat-mount></div><div data-slot="sidebar.workspaces">native sessions</div><div data-slot="settings.launcher"></div></div><main><textarea>native draft</textarea></main></body>',{runScripts:'outside-only'});t.after(()=>dom.window.close());
 const {window:w}=dom,doc=w.document; const boundsRoot=doc.querySelector('[data-slot="sidebar"]'); boundsRoot.getBoundingClientRect=()=>({right:300}); const store=createWorkspaceLayout(path.join(temp(t),'layout.json'));const calls=[];let subscriber,releaseAction;const state={workspaceRoot:'/p',workspaceRevision:0,companion:{name:'主agent',ready:true,messages:[{role:'assistant',text:'实际历史'}]}};
 const bridge={action:async action=>{calls.push({action});if(action==='task-notes')await new Promise(r=>releaseAction=r);if(action==='open-neko')throw Error('本机服务未启动');return {ok:true};},getState:async()=>state,subscribe:fn=>{subscriber=fn;return ()=>{};},companion:async x=>{calls.push(x);return {};},workspace:async r=>{calls.push(r);if(r.action==='state')return store.get();if(r.action==='update')return store.update(r.patch);if(r.action==='update-seat')return store.updateSeat(r.id,r.patch);if(r.action==='codex-state')return {items:[],approvals:[]};if(r.action==='catalog')return {sessions:[{id:'c',provider:'codex',cwd:'/p',title:'Codex任务'},{id:'d',provider:'dsh',cwd:'/p',title:'DSH任务'}],projects:[{cwd:'/p'}],providers:{dsh:'ready',codex:'ready'}};}};
 w.eval(fs.readFileSync(path.join(base,'embedded-dsh/workspace-shell-source.js'),'utf8')+'\nwindow.install=installWorkspaceShell');
 const cleanup=w.install({window:w,document:doc,bridge,avatar:()=>'',openDshNew:root=>calls.push({action:'dsh-new',root}),companionPosterSrc:'data:image/png;base64,iVBORw0KGgo=',settingsActions:[['open-neko','打开 N.E.K.O.'],['task-notes','任务备注'],['connect-neko','连接 N.E.K.O.'],['reconnect-workbench','重新连接工作台'],['connection-status','连接详情']],cssText:fs.readFileSync(path.join(base,'embedded-dsh/workspace-shell-source.css'),'utf8'),locateSidebar:()=>({root:boundsRoot,slot:doc.createElement('div')})});await tick();
 assert.equal(doc.querySelectorAll('.neko-custom-seat').length,3);assert.equal(doc.querySelectorAll('.neko-workspace-session').length,2);assert.equal(doc.querySelector('.neko-companion-history').textContent,'回复：实际历史');assert(doc.querySelector('.neko-companion-history').hidden);assert.equal(doc.querySelector('.neko-companion-header'),null);assert.equal(doc.querySelector('.neko-companion-connect'),null);assert(doc.querySelector('.neko-companion-status').hidden);
 assert.equal(w.getComputedStyle(doc.querySelector('.neko-mode-switch')).display,'none');assert.equal(w.getComputedStyle(doc.querySelector('[data-neko-new-session]')).visibility,'hidden');
 assert.equal(doc.querySelectorAll('.neko-custom-seat__new').length,3);assert([...doc.querySelectorAll('.neko-custom-seat__new')].every(b=>b.nextElementSibling.classList.contains('neko-custom-seat__provider')));
 doc.querySelectorAll('.neko-custom-seat__new')[1].click();await tick();assert.equal(store.get().officeMode,'codex');assert.equal(store.get().activeSeatId,'seat-2');assert(!doc.querySelector('.neko-office-panel').hidden);
 doc.querySelectorAll('.neko-custom-seat__new')[0].click();await tick();assert.equal(store.get().officeMode,'dsh');assert.equal(store.get().activeSeatId,'seat-1');assert.equal(calls.filter(r=>r.action==='dsh-new').length,1);
 doc.querySelectorAll('.neko-custom-seat__new')[2].click();assert(!doc.querySelector('.neko-workspace-modal').hidden);assert(doc.querySelector('.neko-seat-editor'));assert.equal(store.get().activeSeatId,'seat-1');doc.querySelector('.neko-workspace-modal__close').click();
 await bridge.workspace({action:'update',patch:{activeSeatId:null}});subscriber({...state,workspaceRevision:99});await tick();
 const dock=doc.querySelector('.neko-companion-dock'),sprite=doc.querySelector('.neko-companion-character');let dockWidth=260;Object.defineProperty(dock,'clientWidth',{get:()=>dockWidth});Object.defineProperty(sprite,'offsetWidth',{value:76});
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
 doc.querySelector('.neko-workspace-settings').click();
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
 assert(code.includes(source));assert(code.includes(JSON.stringify(css)));
 assert.match(code,/'aria-label': a.name/);assert.match(css,/\.neko-hero-pick__name \{ display:none !important/);
});
