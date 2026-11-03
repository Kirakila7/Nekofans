'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {createNativeComposerAdapter,createNativeComposerDshBindings} = require('../../apps/neko-workbench/embedded-dsh/native-composer-source.js');

function fixture(extra = {}) {
  let selection = {sessionId:'s1'}, main = 's1', selectionListener = null;
  const bindings = new Map(), shells = new Map(), changes = [];
  function add(id) {
    const listeners = new Set(), state = {draft:'old draft', draftRev:1, phase:'plain', attachmentIds:[], occurrences:[]};
    const shell = { sends:0, saves:0, state:{getSnapshot:()=>({...state}), subscribe(fn){listeners.add(fn);return()=>listeners.delete(fn);}}, actions:{
      setDraft(text){state.draft = text;state.draftRev++;for(const fn of listeners)fn();},
      persistDraft(){shell.saves++;}, submit(){shell.sends++;},
    }};
    bindings.set(id,{sessionId:id,session:{sessionId:id}}); shells.set(id,{shell,state,listeners});
    return shells.get(id);
  }
  const first = add('s1'); add('s2');
  const api = createNativeComposerAdapter({
    getSelection:()=>selection, getMainSessionId:()=>main, getBinding:id=>bindings.get(id),
    getShell:(_binding,id)=>shells.get(id)?.shell,
    subscribeSelection(fn){selectionListener=fn;return()=>{selectionListener=null;}},
    onChange:state=>changes.push(state),
    ...extra,
  });
  return {api,first,shells,bindings,changes,select(value){selection=value;selectionListener?.();}, main(value){main=value;}};
}

test('adapter updates and persists only the current retained native session draft', () => {
  const f=fixture(), initial=f.api.snapshot();
  assert.equal(initial.sessionId,'s1'); assert.equal(initial.draft,'old draft');
  const result=f.api.write({sessionId:'s1',revision:1,text:'new draft'});
  assert.equal(result.ok,true); assert.equal(result.state.draft,'new draft'); assert.equal(result.state.revision,2);
  assert.equal(f.first.shell.saves,1); assert.equal(f.shells.get('s2').state.draft,'old draft');
  f.api.dispose(); assert.equal(f.first.listeners.size,0);
});

test('stale revisions, session switches, missing binding and composition fail closed', async () => {
  const f=fixture();
  assert.equal(f.api.write({sessionId:'s1',revision:0,text:'bad'}).code,'draft_changed');
  assert.equal(f.api.write({sessionId:'s1',revision:1,text:'bad',composing:true}).code,'composing');
  assert.equal(f.api.submit({sessionId:'s1',revision:1,composing:true}).code,'composing');
  f.select({sessionId:'s2'}); // The official selection can lead the retained reference.
  assert.equal(f.api.snapshot().available,false);
  assert.equal(f.api.write({sessionId:'s1',revision:1,text:'bad'}).ok,false);
  f.main('s2'); await Promise.resolve();
  assert.equal(f.api.snapshot().sessionId,'s2');
  assert.equal(f.api.write({sessionId:'s1',revision:1,text:'bad'}).code,'session_changed');
  f.bindings.delete('s2'); assert.equal(f.api.snapshot().available,false);
  assert.equal(f.first.state.draft,'old draft'); assert.equal(f.first.shell.sends,0);
});

test('rich drafts, command claims and busy phases cannot be overwritten or sent', () => {
  const f=fixture();
  for (const mutation of [s=>{s.attachmentIds=['a']},s=>{s.occurrences=[{}]},s=>{s.claim={token:'/x'}},s=>{s.phase='adjudicating'}]) {
    Object.assign(f.first.state,{attachmentIds:[],occurrences:[],claim:undefined,phase:'plain'}); mutation(f.first.state);
    assert.equal(f.api.snapshot().available,false);
    assert.equal(f.api.write({sessionId:'s1',revision:1,text:'overwrite'}).ok,false);
    assert.equal(f.api.submit({sessionId:'s1',revision:1}).ok,false);
  }
  assert.equal(f.first.state.draft,'old draft');assert.equal(f.first.shell.sends,0);
});

test('submit is delivered to native input only once per revision, without claiming completion', () => {
  const f=fixture(); let result=f.api.submit({sessionId:'s1',revision:1});
  assert.equal(result.ok,true); assert.equal(result.code,'submitted_to_native'); assert.equal(f.first.shell.sends,1);
  assert.equal(f.api.submit({sessionId:'s1',revision:1}).code,'already_submitted');
  f.select({sessionId:'s2'});f.main('s2');f.api.snapshot();f.select({sessionId:'s1'});f.main('s1');f.api.snapshot();
  assert.equal(f.api.submit({sessionId:'s1',revision:1}).code,'already_submitted');
  assert.equal(f.first.shell.sends,1);
});

test('missing native API, unexpected snapshot or changed binding never sends', () => {
  const f=fixture(); f.first.state.draftRev=undefined;
  assert.equal(f.api.snapshot().available,false);
  assert.equal(f.api.submit({sessionId:'s1',revision:1}).ok,false);
  f.first.state.draftRev=1; delete f.first.shell.actions.submit;
  assert.equal(f.api.snapshot().available,false);
  assert.equal(f.first.shell.sends,0);
});

test('native session and input errors are surfaced without claiming send success', () => {
  const f=fixture(), listeners=new Set(); let session={sessionId:'s1',pendingSubmissions:[]};
  Object.assign(f.bindings.get('s1').session,{getSnapshot:()=>session,subscribe(fn){listeners.add(fn);return()=>listeners.delete(fn);}});
  f.api.snapshot(); session={...session,promptError:{error:'private native details'}};
  for(const fn of listeners)fn();
  const state=f.api.snapshot();assert.match(state.status,/会话出现错误/);assert(!state.status.includes('private'));
  assert.equal(f.changes.at(-1).status,state.status);f.api.dispose();assert.equal(listeners.size,0);
});

function modelFixture({explicit=false,high=true}={}) {
  const listeners=new Set(), calls=[];
  let raw={status:'ready',current:{provider:'deepseek-account',model:'deepseek-flash',reasoningEffort:'low'},groups:[{id:'deepseek-account',models:[{id:'deepseek-flash',name:'DeepSeek-V4.1-Flash',reasoning:{defaultEffort:'low',efforts:[{id:'low',name:'Low'},...(high?[{id:'high',name:'High'}]:[])]}}]}]};
  let f;
  const directory={store:{getSnapshot:()=>raw,subscribe(fn){listeners.add(fn);return()=>listeners.delete(fn);}},load:async()=>raw,async select(value){calls.push(value);raw={...raw,current:value};for(const fn of listeners)fn();return {ok:true};}};
  f=fixture({getModelDirectory:()=>directory,isDefaultSession:id=>id==='s1',hasExplicitModelSelection:()=>explicit,defaultReady:()=>true,ensureDefaultSession:async({stillUnbound})=>{
    if(!stillUnbound())return {skipped:true,sessionId:'s1'};
    f.main('s1');f.select({sessionId:'s1'});return {sessionId:'s1',workspaceId:'actual-default'};
  }});
  f.bindings.get('s1').session.getSnapshot=()=>({blank:true});
  return {...f,directory,calls,listeners,raw:()=>raw,setRaw:value=>{raw=value;for(const fn of listeners)fn();}};
}

test('model directory uses the provider-owned identity and validates real reasoning choices without touching drafts',async()=>{
  const f=modelFixture(), id=JSON.stringify(['deepseek-account','deepseek-flash']), initial=f.api.snapshot();
  assert.equal(initial.modelId,id);assert.equal(initial.modelLabel,'DeepSeek-V4.1-Flash');assert.equal(initial.reasoningId,'low');
  assert.equal((await f.api.selectModel({sessionId:'s1',revision:0,modelId:id,reasoningId:'high'})).code,'draft_changed');
  assert.equal((await f.api.selectModel({sessionId:'s1',revision:1,modelId:id,reasoningId:'invented'})).code,'invalid_model');
  assert.equal(f.calls.length,0);
  assert.equal((await f.api.selectModel({sessionId:'s1',revision:1,modelId:id,reasoningId:'high'})).ok,true);
  assert.deepEqual(f.calls,[{provider:'deepseek-account',model:'deepseek-flash',reasoningEffort:'high'}]);
  assert.equal(f.api.snapshot().reasoningId,'high');assert.equal(f.api.snapshot().modelBusy,false);assert.equal(f.first.state.draft,'old draft');assert.equal(f.first.shell.saves,0);assert.equal(f.first.shell.sends,0);
  f.api.dispose();assert.equal(f.listeners.size,0);
});

test('an in-flight model change blocks submission until its actual DSH operation settles',async()=>{
  const f=modelFixture(), id=f.api.snapshot().modelId;let settle;
  f.directory.select=value=>new Promise(resolve=>{settle=()=>{f.setRaw({...f.raw(),current:value});resolve({ok:true});};});
  const operation=f.api.selectModel({sessionId:'s1',revision:1,modelId:id,reasoningId:'high'});
  assert(f.api.snapshot().modelBusy);assert.equal(f.api.submit({sessionId:'s1',revision:1}).code,'model_unconfirmed');assert.equal(f.first.shell.sends,0);
  settle();await operation;assert(!f.api.snapshot().modelBusy);assert.equal(f.api.snapshot().reasoningId,'high');
  assert.equal(f.api.submit({sessionId:'s1',revision:1}).ok,true);assert.equal(f.first.shell.sends,1);f.api.dispose();
});

test('unconfigured default creation session selects catalog Flash High once while explicit saved choices remain intact',async()=>{
  const f=modelFixture();
  await f.api.ensureDefaultSession();await f.api.ensureDefaultSession();
  assert.deepEqual(f.calls,[{provider:'deepseek-account',model:'deepseek-flash',reasoningEffort:'high'}]);assert.equal(f.first.shell.sends,0);assert.equal(f.first.state.draft,'old draft');assert(f.api.snapshot().defaultWorkspace);f.api.dispose();
  const saved=modelFixture({explicit:true});await saved.api.ensureDefaultSession();assert.equal(saved.calls.length,0);assert.equal(saved.api.snapshot().reasoningId,'low');saved.api.dispose();
});

test('missing requested model capability reports an error and cannot silently send using another model',async()=>{
  const f=modelFixture({high:false});await f.api.ensureDefaultSession();
  assert.equal(f.calls.length,0);assert.match(f.api.snapshot().modelError,/未提供.*High/);assert.equal(f.api.snapshot().reasoningId,'low','display remains the actual catalog selection');
  assert.equal(f.api.submit({sessionId:'s1',revision:1}).code,'model_unconfirmed');assert.equal(f.first.shell.sends,0);
  await f.api.loadModels({refresh:true});assert.match(f.api.snapshot().modelError,/未提供.*High/,'refresh cannot silently discard the requested default');
  const raw=f.raw();raw.groups[0].models[0].reasoning.efforts.push({id:'high',name:'High'});f.setRaw({...raw});await f.api.loadModels({refresh:true});
  assert.equal(f.api.snapshot().reasoningId,'high');assert.equal(f.api.snapshot().modelError,'');assert.equal(f.calls.length,1,'newly available default is applied once after login/catalog refresh');f.api.dispose();
});

test('default session binding uses the authoritative default workspace and cancels navigation when the selection changes',async()=>{
  let selection={},main,resolveWorkspace;const opened=[],defaultWorkspace={workspaceId:'durable-default',sessionIds:[]};
  const workspace={list:{getSnapshot:()=>({phase:'ready',items:[{workspaceId:'arbitrary-project'},defaultWorkspace]}),subscribe:()=>()=>{}},initializeDefault:async()=>defaultWorkspace};
  const ctx={get:name=>name==='workspaces'?workspace:undefined,uiWorkspace:{selection:{getSnapshot:()=>selection},get mainReference(){return main;},sessions:{list:{getSnapshot:()=>({phase:'ready'})}},async openWorkspace(id,before){before('created');opened.push(id);selection={sessionId:'created'};main={sessionId:'created'};}}};
  const bindings=createNativeComposerDshBindings(ctx), signal=new AbortController().signal;
  const stillUnbound=()=>!selection.sessionId;
  const result=await bindings.ensureDefaultSession({signal,stillUnbound});assert.equal(result.sessionId,'created');assert.deepEqual(opened,['durable-default']);assert(bindings.isDefaultSession('created'));
  selection={};main=undefined;workspace.initializeDefault=()=>new Promise(resolve=>{resolveWorkspace=resolve;});
  const changed=bindings.ensureDefaultSession({signal,stillUnbound});selection={sessionId:'other'};resolveWorkspace(defaultWorkspace);assert.equal((await changed).skipped,true);assert.deepEqual(opened,['durable-default'],'no fallback or late overwrite of the user navigation');
});

test('an existing engine root does not prevent registering the exact host-configured default directory',async()=>{
 let selected,main;const registered=[],opened=[],row={workspaceId:'configured-default',sessionIds:[]};
 const workspaces={list:{getSnapshot:()=>({items:[{workspaceId:'unrelated-project',path:'C:/Another'}]})},initializeDefault:async()=>undefined,async create(request){registered.push(request);return row;}};
 const ctx={get:name=>name==='workspaces'?workspaces:undefined,uiWorkspace:{selection:{getSnapshot:()=>selected||{}},get mainReference(){return main;},async openWorkspace(id,before){before('created');opened.push(id);main={sessionId:'created'};selected={sessionId:'created'};}}};
 const bindings=createNativeComposerDshBindings(ctx),signal=new AbortController().signal;
 const result=await bindings.ensureDefaultSession({signal,stillUnbound:()=>!selected,workspaceRoot:'C:/Configured/Workbench'});
 assert.deepEqual(registered,[{path:'C:/Configured/Workbench'}]);assert.deepEqual(opened,['configured-default']);assert.equal(result.sessionId,'created');assert(bindings.isDefaultSession('created'));
 selected=undefined;main=undefined;
 await assert.rejects(bindings.ensureDefaultSession({signal,stillUnbound:()=>true}),error=>error.code==='default_root_unavailable');
 assert.equal(registered.length,1,'no catalog-first or guessed path fallback is permitted');
});

test('an empty real model catalog asks for login or configuration and never manufactures a Flash option',()=>{
 const f=modelFixture();f.setRaw({...f.raw(),groups:[]});const state=f.api.snapshot();
 assert.deepEqual(state.modelOptions,[]);assert.equal(state.modelId,'');assert.equal(state.modelLabel,'');assert.match(state.modelError,/暂无可用模型.*登录 DeepSeek.*刷新/);
 assert.equal(f.api.submit({sessionId:'s1',revision:1}).code,'model_unconfirmed');assert.equal(f.first.shell.sends,0);f.api.dispose();
});

function registeringFixture(create){
 let selected,main;const attempts=[],opened=[],workspaces={initializeDefault:async()=>undefined,async create(request){attempts.push(request);return create(request,attempts.length);}};
 const ctx={get:name=>name==='workspaces'?workspaces:undefined,uiWorkspace:{selection:{getSnapshot:()=>selected||{}},get mainReference(){return main;},async openWorkspace(id,before){before('created');opened.push(id);main={sessionId:'created'};selected={sessionId:'created'};}}};
 const bindings=createNativeComposerDshBindings(ctx),controller=new AbortController();
 return {attempts,opened,controller,select:id=>{selected={sessionId:id};main={sessionId:id};},run:()=>bindings.ensureDefaultSession({signal:controller.signal,stillUnbound:()=>!selected,workspaceRoot:'C:/Configured/Workbench'})};
}

test('first-start registration retries only the same configured directory and opens it once after recovery',async()=>{
 const f=registeringFixture((_request,attempt)=>{if(attempt===1)throw Error('synthetic registration failure');return {workspaceId:'configured',sessionIds:[]};});
 assert.equal((await f.run()).sessionId,'created');assert.equal(f.attempts.length,2);assert.deepEqual(f.attempts,[{path:'C:/Configured/Workbench'},{path:'C:/Configured/Workbench'}]);assert.deepEqual(f.opened,['configured']);
});

test('persistent registration failure is bounded and retains its explicit error without opening a session',async()=>{
 const f=registeringFixture(()=>{throw Error('synthetic persistent failure');});
 await assert.rejects(f.run(),error=>error.code==='default_registration_failed');assert.equal(f.attempts.length,3);assert.deepEqual(f.opened,[]);
});

test('cancellation during a registration delay prevents the retry and session navigation',async()=>{
 const f=registeringFixture(()=>{throw Error('synthetic failure');}),operation=f.run();
 setTimeout(()=>f.controller.abort(),20);assert.equal((await operation).skipped,true);assert.equal(f.attempts.length,1);assert.deepEqual(f.opened,[]);
});

test('a user selection made during a registration delay wins over automatic creation',async()=>{
 const f=registeringFixture(()=>{throw Error('synthetic failure');}),operation=f.run();
 setTimeout(()=>f.select('user-chosen'),20);assert.equal((await operation).skipped,true);assert.equal(f.attempts.length,1);assert.deepEqual(f.opened,[]);
});
