// Isolated process: fake accounts/transport; real bundled host, scheduler and routes.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),{prepareFishCare}=require('../../apps/neko-workbench/fish-care.cjs');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'fish-host-'));
const p=prepareFishCare({workspaceDir:root});
Object.assign(process.env,{BILI_WHALE_HOME:p.home,BILI_WHALE_DSH_HOME:p.profile,BILI_WHALE_CONFIG:p.config,DSH_HOME:path.join(root,'dsh'),DSH_NODE:process.execPath});
const timers=new Set(),rawTimeout=globalThis.setTimeout,rawInterval=globalThis.setInterval,rawClearTimeout=globalThis.clearTimeout,rawClearInterval=globalThis.clearInterval;
globalThis.setTimeout=(fn,...args)=>{let id=rawTimeout(()=>{timers.delete(id);fn()},...args);timers.add(id);return id};
globalThis.setInterval=(...args)=>{const id=rawInterval(...args);timers.add(id);return id};
globalThis.clearTimeout=id=>{timers.delete(id);return rawClearTimeout(id)};
globalThis.clearInterval=id=>{timers.delete(id);return rawClearInterval(id)};
let requests=0,created=0,prompted=0,cancelled=0,killed=[],signedIn=false,wakeWatch;
globalThis.fetch=async()=>{requests++;return Response.json({code:0,data:{isLogin:true,mid:123,uname:'fixture'}})};
const account={getState:async()=>({status:signedIn?'credential-stored':'signed-out'}),async *watch(signal){while(!signal.aborted){yield await this.getState();await new Promise(resolve=>{wakeWatch=resolve;signal.addEventListener('abort',resolve,{once:true})})}}};
const routes=new Map(),effects=[],events=new Map();
const services={deepseekAccount:account,connection:{requestRejection:req=>req.headers.origin==='https://evil.invalid'?403:undefined},agents:{get:id=>{assert.equal(id,'bili-whale');return{cancel(){cancelled++}}}},jobs:{list:()=>[{id:'fish-job',owner:'bili-whale',status:'running'},{id:'foreign-job',owner:'other-session',status:'running'},{id:'public-job',owner:null,status:'running'}],kill:(id,owner)=>{assert.equal(owner,'bili-whale');killed.push(id);return'requested'}}};
const ctx={get:name=>services[name],sessionController:{async create(){created++},async prompt(){prompted++}},webServer:{register:route=>{routes.set(route.path,route.handler);return()=>routes.delete(route.path)}},inject:(names,fn)=>fn({deepseekAccount:account}),effect:fn=>effects.push(fn()),on:(name,fn)=>{events.set(name,fn);return()=>events.delete(name)}};
async function api(name,body,{origin='http://127.0.0.1',method='POST'}={}){const req=new EventEmitter();req.headers={host:'127.0.0.1',origin};req.method=method;let code,payload;const res={writeHead:value=>code=value,set statusCode(value){code=value},end:value=>payload=value};const job=routes.get('/dsh-bili/api/'+name)(req,res);process.nextTick(()=>{req.emit('data',Buffer.from(JSON.stringify(body||{})));req.emit('end')});await job;return{code,body:payload?JSON.parse(payload):null}}
try{
 const plugin=await import('../../apps/neko-workbench/vendor/dsh-bili-whale/lib/index.js');plugin.default.apply(ctx);await new Promise(resolve=>setImmediate(resolve));
 assert.equal((await plugin.workbenchAction('status')).phase,'paused');assert.equal(timers.size,0);assert.equal(requests,0);assert.equal(created,0);
 assert.equal((await api('settings',{}, {origin:'https://evil.invalid',method:'GET'})).code,403);
 const settings=await api('settings',{config:{enabled:true,persona:{name:'本地鱼'}}});assert.equal(settings.code,200);assert.equal(settings.body.config.enabled,false);assert.equal(settings.body.config.persona.name,'本地鱼');
 assert.equal((await plugin.workbenchAction('start')).phase,'model-login-required');assert.equal(requests,0);
 signedIn=true;wakeWatch();await new Promise(resolve=>setImmediate(resolve));assert.equal((await plugin.workbenchAction('status')).phase,'login-required');assert.equal(timers.size,0);
 const login=await api('cookie',{sessdata:'fixture-session-12345678901234567890',bili_jct:'a'.repeat(32)});assert.equal(login.code,200);assert.equal((await plugin.workbenchAction('status')).phase,'running');assert.equal(requests,1);assert(timers.size>0);assert.equal(created,0);assert.equal(prompted,0);
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
 assert.equal(created,0);assert.equal(prompted,0);
}finally{for(const cleanup of effects.reverse())cleanup?.();for(const timer of timers){rawClearTimeout(timer);rawClearInterval(timer)}fs.rmSync(root,{recursive:true,force:true})}
