'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {homeBuildReceipt}=require('../../apps/neko-workbench/home-build-tracker.cjs');
const {sceneFingerprint}=require('../../apps/neko-workbench/our-home-scene.cjs');
const {createYuiHomeStorage,createYuiHomeFileStore}=require('../../apps/neko-workbench/yui-home-storage.cjs');
const {createOurHomeRuntime}=require('../../apps/neko-workbench/our-home-runtime.cjs');
const file=path.resolve('fixture/our-home/scene.json'),a=[{id:'lamp',kind:'lamp',x:1,z:0}],b=[{...a[0],x:2}];
const scene=items=>JSON.stringify({version:1,items});
function fixture({items=a,before=[],step=2,tokens=1234}={}){
 const session={id:'home',events:[{type:'assistant/message',data:{turn:1,step,usage:tokens===null?{}:{totalTokens:tokens,inputTokens:1000,outputTokens:234,cacheReadTokens:500}}},{type:'tool/call',data:{turn:1,step,callId:'call-'+step,name:'write'}}]};
 return {exec:{name:'write',callId:'call-'+step,agent:{session}},result:{isError:false,value:{path:file,before:scene(before),after:scene(items)}},options:{sessionId:'home',sceneFile:file}};
}
const receipt=f=>homeBuildReceipt(f.exec,f.result,f.options);
test('native final mutation binds to the home model step and uses reported total once',()=>{
 const f=fixture(),r=receipt(f);assert.equal(r.tokens,1234);assert.equal(r.afterHash,sceneFingerprint(a));assert.match(r.key,/^[a-f0-9]{64}$/);
 f.exec.callId='nested-write';f.exec.rootCallId='call-2';assert.deepEqual(receipt(f),r);
 f.options.sessionId='ordinary-chat';assert.equal(receipt(f),null);f.options.sessionId='home';f.result.isError=true;assert.equal(receipt(f),null);
 f.result.isError=false;f.exec.name='bash';assert.equal(receipt(f),null);f.exec.name='write';f.result.value.path=file+'.backup';assert.equal(receipt(f),null);
});
test('formatting, order, defaults and equivalent colors/rotations do not create value',()=>{
 const f=fixture({before:a});f.result.value.after=JSON.stringify({items:[{color:'#B7A18B',rotation:360,z:0,y:0,x:1,name:'lamp',id:'lamp',kind:'lamp',width:.5,height:2,depth:.5}],version:1},null,4);assert.equal(receipt(f),null);
 assert.equal(sceneFingerprint([...a,{id:'box',kind:'box',x:0,z:0}]),sceneFingerprint([{id:'box',kind:'box',x:0,z:0},...a]));
 f.result.value.after='{broken';assert.equal(receipt(f),null);
});
test('missing provider totals remain unknown instead of estimating cache or reasoning tokens',()=>{const f=fixture({tokens:null});f.exec.agent.session.events[0].data.usage={inputTokens:100,outputTokens:50,cacheReadTokens:25,reasoningTokens:10};assert.equal(receipt(f).tokens,null);});
test('scene and value save together; replay, restart, multiple writes per model call and manual actions do not inflate value',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'home-value-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));const store=createYuiHomeFileStore(dir),storage=await createYuiHomeStorage({store}),r=receipt(fixture());
 assert.equal(storage.state().homeValue.tokens,0);await storage.applyScene(a,[r]);assert.equal(storage.state().homeValue.tokens,1234);
 await storage.applyScene(a,[r]);await storage.command({action:'return-home'});await storage.command({action:'perspective',mode:'agent'});await storage.command({action:'furnish',items:b});assert.equal(storage.state().homeValue.tokens,1234);
 const restored=await createYuiHomeStorage({store});await restored.applyScene(a,[r]);assert.equal(restored.state().homeValue.tokens,1234);
 const secondWrite=receipt(fixture({items:b,before:a}));await restored.applyScene(b,[secondWrite]);assert.equal(restored.state().homeValue.tokens,1234);
 const nextCall=receipt(fixture({items:[],before:b,step:3,tokens:400}));await restored.applyScene([],[nextCall]);assert.equal(restored.state().homeValue.tokens,1634);
});
test('failed disk commits do not add value; retry commits once; unknown use can be resolved',async()=>{
 let saved=null,fail=false;const storage=await createYuiHomeStorage({store:{load:async()=>saved,save:async value=>{if(fail)throw Error('disk full');saved=value;}}}),r=receipt(fixture());fail=true;
 await assert.rejects(storage.applyScene(a,[r]),/尚未保存/);assert.equal(storage.state().homeValue.tokens,0);fail=false;await storage.applyScene(a,[r]);assert.equal(storage.state().homeValue.tokens,1234);
 const unknown=receipt(fixture({items:b,before:a,step:3,tokens:null}));await storage.applyScene(b,[unknown]);assert.equal(storage.state().homeValue.unknownCalls,1);
 await storage.applyScene(b,[{...unknown,tokens:50}]);assert.equal(storage.state().homeValue.unknownCalls,0);assert.equal(storage.state().homeValue.tokens,1284);
 const document=JSON.parse(saved);document.buildLedger.bad=99;const corrupted=await createYuiHomeStorage({store:{load:async()=>JSON.stringify(document),save:async()=>{throw Error('must preserve corrupt save');}}});assert.equal(corrupted.state().homeValue.status,'unavailable');
});
test('watcher counts only native receipts matching an accepted scene; poll before receipt and restart remain safe',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'home-value-watch-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));const storage=await createYuiHomeStorage({store:createYuiHomeFileStore(path.join(dir,'profile'))}),runtime=createOurHomeRuntime({workspaceDir:path.join(dir,'workspace'),getStorage:async()=>storage,intervalMs:100000});t.after(()=>runtime.dispose());const info=await runtime.start();
 await fs.writeFile(info.file,scene(a));await runtime.refresh();assert.equal(storage.state().homeValue.tokens,0);const r=receipt(fixture());await runtime.acceptBuild(r);assert.equal(storage.state().homeValue.tokens,1234);await runtime.acceptBuild(r);assert.equal(storage.state().homeValue.tokens,1234);
 await fs.writeFile(info.file,scene(b));await runtime.acceptBuild(receipt(fixture({items:a,before:[],step:4,tokens:500})));assert.equal(storage.state().homeValue.tokens,1234);assert.equal(storage.state().items[0].x,2);
 await fs.writeFile(info.file,JSON.stringify(JSON.parse(scene(b)),null,2));const revision=storage.state().revision;await runtime.refresh();assert.equal(storage.state().revision,revision);
});
test('fast sequential native writes form a verified chain and count each successful model call once',async()=>{const storage=await createYuiHomeStorage({store:{load:async()=>null,save:async()=>{}}});await storage.applyScene(b,[receipt(fixture()),receipt(fixture({items:b,before:a,step:3,tokens:20}))]);assert.equal(storage.state().homeValue.tokens,1254);});
test('a native receipt arriving during an in-flight watcher save is retained for the next refresh',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'home-value-race-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));let block=false,release,started;
 const waiting=new Promise(resolve=>started=resolve),storage=await createYuiHomeStorage({store:{load:async()=>null,save:async()=>{if(block){block=false;started();await new Promise(resolve=>release=resolve);}}}}),runtime=createOurHomeRuntime({workspaceDir:dir,getStorage:async()=>storage,intervalMs:100000});t.after(()=>runtime.dispose());const {file}=await runtime.start();
 await fs.writeFile(file,scene(a));block=true;const polling=runtime.refresh();await waiting;const accounting=runtime.acceptBuild(receipt(fixture()));release();await polling;await accounting;assert.equal(storage.state().homeValue.tokens,1234);
});
