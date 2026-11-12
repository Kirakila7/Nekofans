// Isolated process: fake accounts/transport; real bundled host, scheduler and routes.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {syncBuiltinESMExports} from 'node:module';
import childProcess from 'node:child_process';
const require=createRequire(import.meta.url),{prepareFishCare}=require('../../apps/neko-workbench/fish-care.cjs');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'fish-host-'));
const p=prepareFishCare({workspaceDir:root});
const modules=path.join(root,'modules');const executor=path.join(modules,'dsh-tool-executor-native');fs.mkdirSync(path.join(executor,'lib'),{recursive:true});fs.writeFileSync(path.join(executor,'package.json'),'{"type":"module"}');fs.writeFileSync(path.join(executor,'lib/index.js'),'export class NativeToolExecutor {}');
process.env.NEKO_WORKBENCH_DSH_MODULES=modules;
const externalPlugin=process.env.NEKO_QA_EXTERNAL_PLUGIN;
if(externalPlugin)delete process.env.NEKO_WORKBENCH_DATA_DIR;
else process.env.NEKO_WORKBENCH_DATA_DIR=root;
const originalExecFile=childProcess.execFile;let collections=0,restrictions=0,scopesReleased=0;
childProcess.execFile=(_node,args,_options,callback)=>{collections++;assert(['feed','debrief'].includes(args[1]));assert(!args.includes('--go'));callback(null,args[1]==='feed'?'BV1234567890':'fixture public reading material','');};syncBuiltinESMExports();
Object.assign(process.env,{BILI_WHALE_HOME:p.home,BILI_WHALE_DSH_HOME:p.profile,BILI_WHALE_CONFIG:p.config,DSH_HOME:path.join(root,'dsh'),DSH_NODE:process.execPath});
const timers=new Set(),rawTimeout=globalThis.setTimeout,rawInterval=globalThis.setInterval,rawClearTimeout=globalThis.clearTimeout,rawClearInterval=globalThis.clearInterval;
globalThis.setTimeout=(fn,...args)=>{let id=rawTimeout(()=>{timers.delete(id);fn()},...args);timers.add(id);return id};
globalThis.setInterval=(...args)=>{const id=rawInterval(...args);timers.add(id);return id};
globalThis.clearTimeout=id=>{timers.delete(id);return rawClearTimeout(id)};
globalThis.clearInterval=id=>{timers.delete(id);return rawClearInterval(id)};
let requests=0,created=0,prompted=0,lastPrompt,cancelled=0,killed=[],signedIn=false,wakeWatch,verificationWait;
const networkFetch=globalThis.fetch;
globalThis.fetch=async()=>{requests++;if(verificationWait)await verificationWait;return Response.json({code:0,data:{isLogin:true,mid:123,uname:'fixture'}})};
const account={getState:async()=>({status:signedIn?'credential-stored':'signed-out'}),async *watch(signal){while(!signal.aborted){yield await this.getState();await new Promise(resolve=>{wakeWatch=resolve;signal.addEventListener('abort',resolve,{once:true})})}}};
const routes=new Map(),effects=[],eventBus=new EventEmitter();
const events={get:name=>(...args)=>eventBus.emit(name,...args)};
const services={deepseekAccount:account,connection:{requestRejection:req=>req.headers.origin==='https://evil.invalid'?403:undefined},agents:{get:id=>{assert.equal(id,'bili-whale');return{cancel(){cancelled++},ctx:{inject(_names,fn){fn({tools:{restrict(value){assert.deepEqual(value.allow,['read','write','edit']);restrictions++},setExecutor(){},guard(fn){assert(fn({name:'pwsh',arguments:{}}));assert(fn({name:'write',arguments:{path:path.join(root,'outside.txt')}}));}}});return{state:2,dispose(){scopesReleased++}}}}}}},jobs:{list:()=>[{id:'fish-job',owner:'bili-whale',status:'running'},{id:'foreign-job',owner:'other-session',status:'running'},{id:'public-job',owner:null,status:'running'}],kill:(id,owner)=>{assert.equal(owner,'bili-whale');killed.push(id);return'requested'}}};
const ctx={get:name=>services[name],sessionController:{async resolveAgent(){return{error:{code:'session/not-found'}}},async create({sessionId}){created++;return{sessionId}},async selectModel(request){assert.equal(request.provider,'deepseek-account');assert.equal(request.model,'deepseek-flash');return{selected:request}},async prompt(request){prompted++;lastPrompt=request}},webServer:{register:route=>{routes.set(route.path,route.handler);return()=>routes.delete(route.path)}},inject:(names,fn)=>fn({deepseekAccount:account}),effect:fn=>effects.push(fn()),on:(name,fn)=>{eventBus.on(name,fn);return()=>eventBus.off(name,fn)}};
async function api(name,body,{origin='http://127.0.0.1',method='POST'}={}){const req=new EventEmitter();req.headers={host:'127.0.0.1',origin};req.method=method;let code,payload;const res={writeHead:value=>code=value,set statusCode(value){code=value},end:value=>payload=value};const job=routes.get('/dsh-bili/api/'+name)(req,res);process.nextTick(()=>{req.emit('data',Buffer.from(JSON.stringify(body||{})));req.emit('end')});await job;return{code,body:payload?JSON.parse(payload):null}}
try{
 const plugin=await import(externalPlugin?pathToFileURL(path.join(externalPlugin,'lib/index.js')).href:'../../apps/neko-workbench/vendor/dsh-bili-whale/lib/index.js');plugin.default.apply(ctx);await new Promise(resolve=>setImmediate(resolve));
 assert.equal((await plugin.workbenchAction('status')).phase,'paused');assert.equal(timers.size,0);assert.equal(requests,0);assert.equal(created,0);
 assert.equal((await api('settings',{}, {origin:'https://evil.invalid',method:'GET'})).code,403);
 const settings=await api('settings',{config:{enabled:true,persona:{name:'本地鱼'}}});assert.equal(settings.code,200);assert.equal(settings.body.config.enabled,false);assert.equal(settings.body.config.persona.name,'本地鱼');
 assert.equal((await plugin.workbenchAction('start')).phase,'model-login-required');assert.equal(requests,0);
 signedIn=true;wakeWatch();await new Promise(resolve=>setImmediate(resolve));assert.equal((await plugin.workbenchAction('status')).phase,'login-required');assert.equal(timers.size,0);
 const login=await api('cookie',{sessdata:'fixture-session-12345678901234567890',bili_jct:'a'.repeat(32)});assert.equal(login.code,200);assert.equal((await plugin.workbenchAction('status')).phase,'running');assert.equal(requests,1);assert(timers.size>0);assert.equal(created,0);assert.equal(prompted,0);
 assert.equal((await api('read-once',{}, {origin:'https://evil.invalid'})).code,403);
 const planPath=path.join(p.profile,'whale-night.json');const oldPlan=fs.existsSync(planPath)?fs.readFileSync(planPath,'utf8'):null;
 const one=await api('read-once');assert.equal(one.code,200,JSON.stringify(one.body));assert.equal(one.body.state.phase,'queued');assert.equal(created,1);assert.equal(prompted,1);
 assert(lastPrompt.content[0].text.includes('debrief --no-frames'));
 assert(lastPrompt.content[0].text.includes('不要评论、私信'));
 assert.equal(collections,2);assert.equal(restrictions,1);
 assert.equal((await api('read-once')).body.state.requestId,one.body.state.requestId);assert.equal(prompted,1,'duplicate click must not enqueue another reading');
 assert.equal(fs.existsSync(planPath)?fs.readFileSync(planPath,'utf8'):null,oldPlan,'manual reading must preserve the night plan');
 const session={header:{id:'bili-whale'}},event=events.get('session/event');
 event(session,{type:'turn/start',data:{turn:1}});
 event(session,{type:'turn/end',data:{turn:1,reason:{kind:'complete'}}});
 assert.equal(scopesReleased,0,'an earlier turn must not release the queued reading scope');
 assert.equal((await api('read-once',{}, {method:'GET'})).body.state.phase,'queued');
 event(session,{type:'turn/start',data:{turn:2}});
 event(session,{type:'user/message',data:{source:{kind:'user',rpcId:'unrelated-request'}}});
 event(session,{type:'turn/end',data:{turn:2,reason:{kind:'complete'}}});
 assert.equal(scopesReleased,0,'another RPC must not claim the reading scope');
 event(session,{type:'turn/start',data:{turn:3}});
 event(session,{type:'user/message',data:{source:{kind:'user',rpcId:one.body.state.requestId}}});
 assert.equal((await api('read-once',{}, {method:'GET'})).body.state.phase,'running');
 event(session,{type:'turn/end',data:{turn:2,reason:{kind:'complete'}}});
 assert.equal(scopesReleased,0,'a late end for another turn must not release restrictions');
 event(session,{type:'turn/end',data:{turn:3,reason:{kind:'complete'}}});
 assert.equal(scopesReleased,1,'the matching request turn releases its scope exactly once');
 const finished=(await api('read-once',{}, {method:'GET'})).body.state;assert.equal(finished.phase,'finished');assert.equal(finished.readingArtifact,false);assert.equal(finished.diaryUpdated,false,'a completed turn alone cannot prove reading or diary updates');
 // Default read-only gate rejects before transport, even while the scheduler runs.
 const {createTrafficGuard}=await import('../../apps/neko-workbench/vendor/dsh-bili-whale/tools/lib/traffic.mjs');let writes=0;const guard=createTrafficGuard({directory:path.join(root,'traffic'),transport:async()=>{writes++;return Response.json({code:0})}});
 await assert.rejects(guard.fetch('https://api.bilibili.com/x/v2/reply/add',{method:'POST',body:'message=test'}),/工作台/);assert.equal(writes,0);
 const cfg=JSON.parse(fs.readFileSync(p.config));cfg.workbench.allowExternalWrites=true;fs.writeFileSync(p.config,JSON.stringify(cfg));
 const queuedGuard=createTrafficGuard({directory:path.join(root,'queued-traffic'),sleep:async()=>{cfg.enabled=false;fs.writeFileSync(p.config,JSON.stringify(cfg))},transport:async()=>{writes++;return Response.json({code:0})}});
 await assert.rejects(queuedGuard.fetch('https://api.bilibili.com/x/v2/reply/add',{method:'POST',body:'message=queued'}),/工作台/);assert.equal(writes,0);
 await plugin.workbenchAction('pause');assert.equal(timers.size,0);assert.equal(cancelled,1);assert.deepEqual(killed,['fish-job']);assert.equal(JSON.parse(fs.readFileSync(p.config)).enabled,false);
 // A model failure in another session must not pause this scheduler.
 await plugin.workbenchAction('start');events.get('agent/error')({agent:{id:'unrelated'}});await new Promise(resolve=>setImmediate(resolve));assert.equal((await plugin.workbenchAction('status')).phase,'running');
 events.get('agent/error')({agent:{id:'bili-whale'}});await new Promise(resolve=>setImmediate(resolve));assert.equal((await plugin.workbenchAction('status')).phase,'error');assert.equal(timers.size,0);
 await plugin.workbenchAction('start');signedIn=false;wakeWatch();await new Promise(resolve=>setImmediate(resolve));assert.equal((await plugin.workbenchAction('status')).phase,'paused');assert.equal(timers.size,0);
 // A logout must still be consumed while auto-resume awaits B站 verification.
 assert.equal((await plugin.workbenchAction('start')).phase,'model-login-required');
 let releaseVerification;verificationWait=new Promise(resolve=>releaseVerification=resolve);
 signedIn=true;wakeWatch();await new Promise(resolve=>setImmediate(resolve));assert.equal((await plugin.workbenchAction('status')).phase,'checking');
 signedIn=false;wakeWatch();await new Promise(resolve=>setImmediate(resolve));releaseVerification();verificationWait=null;
 await new Promise(resolve=>setImmediate(resolve));assert.equal((await plugin.workbenchAction('status')).phase,'paused');assert.equal(timers.size,0);
 // Login alone cannot revive the intent cancelled by logout.
 signedIn=true;wakeWatch();await new Promise(resolve=>setImmediate(resolve));assert.equal((await plugin.workbenchAction('status')).phase,'paused');assert.equal(timers.size,0);
 assert.equal((await plugin.workbenchAction('start')).phase,'running');await plugin.workbenchAction('pause');
 assert.equal(created,1);assert.equal(prompted,1);
 // The due read-only night plan uses the same application collector and file scope.
 const scheduledCfg=JSON.parse(fs.readFileSync(p.config,'utf8'));scheduledCfg.enabled=true;scheduledCfg.workbench.allowExternalWrites=false;fs.writeFileSync(p.config,JSON.stringify(scheduledCfg));
 const {startScheduler}=await import('../../apps/neko-workbench/vendor/dsh-bili-whale/lib/scheduler.js');
 const scheduled=startScheduler(ctx,{dshHome:p.profile,biliMjs:path.join(p.root,'bili.mjs'),cwd:p.root,route:{provider:'deepseek-account',model:'deepseek-flash'},log(){}});
 try{
   await scheduled.tick();const due=JSON.parse(fs.readFileSync(planPath,'utf8'));due.action='wake';due.atMs=Date.now()-1;due.endsAt=Date.now()+60000;fs.writeFileSync(planPath,JSON.stringify(due));
   await scheduled.tick();assert.equal(collections,4);assert.equal(prompted,2);assert.equal(restrictions,2);assert(lastPrompt.content[0].text.includes('按已保存作息执行'));
 }finally{scheduled.stop()}
 services.sessionQuery={listSessions:async()=>[{header:{id:'bili-whale'}}]};
 ctx.sessionController.resolveAgent=async id=>{assert.equal(id,'bili-whale');return {agent:{}}};
 ctx.sessionController.prompt=async request=>{
   assert.equal(request.sessionId,'bili-whale');
   assert.match(request.content[0].text,/本地鱼/);
   assert.match(request.content[0].text,/测试角色续接/);
   const emit=(type,data)=>eventBus.emit('session/event',{header:{id:'bili-whale'}},{type,data});
   emit('turn/start',{turn:10});
   emit('user/message',{source:{rpcId:request.requestId}});
   emit('assistant/message',{turn:10,message:{content:[{type:'text',text:'原角色的回复'}]}});
   emit('turn/end',{turn:10,reason:{kind:'completed'}});
 };
 const role=await plugin.workbenchRoleAction('discover');
 assert.equal(role.name,'本地鱼');assert.equal(role.exists,true);assert.equal(role.running,false);
 if(externalPlugin){
   const {externalRoleRequest}=require(path.join(externalPlugin,'lib/role-connector.cjs'));
   assert.deepEqual(await externalRoleRequest(p.profile,'discover',undefined,networkFetch),role);
 }
 await assert.rejects(plugin.workbenchRoleAction('send',{id:role.id,text:'测试角色续接'}),/启动/);
 await plugin.workbenchAction('start');
 assert.equal((await plugin.workbenchRoleAction('discover')).id,role.id);
 await assert.rejects(plugin.workbenchRoleAction('send',{id:'other-profile',text:'测试角色续接'}),/未匹配/);
 const input={id:role.id,text:'测试角色续接'};
 const reply=externalPlugin
   ?await require(path.join(externalPlugin,'lib/role-connector.cjs')).externalRoleRequest(p.profile,'send',input,networkFetch)
   :await plugin.workbenchRoleAction('send',input);
 assert.deepEqual(reply,{text:'原角色的回复'});
 assert.equal(restrictions,3);assert.equal(eventBus.listenerCount('session/event'),1);
 await plugin.workbenchAction('pause');
}finally{childProcess.execFile=originalExecFile;syncBuiltinESMExports();for(const cleanup of effects.reverse())cleanup?.();for(const timer of timers){rawClearTimeout(timer);rawClearInterval(timer)}fs.rmSync(root,{recursive:true,force:true})}
