'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {fishPaths,prepareFishCare,fishEnvironment,createFishControl}=require('../../apps/neko-workbench/fish-care.cjs');
test('fish defaults stay in the isolated workspace and preserve existing settings and persona',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fish-defaults-'));
  try{const runtime={workspaceDir:path.join(dir,'workspace')},before=process.env.HOME,p=prepareFishCare(runtime),cfg=JSON.parse(fs.readFileSync(p.config));
    assert.equal(cfg.enabled,false);assert.equal(cfg.share.enabled,false);assert.equal(cfg.workbench.allowExternalWrites,false);assert.equal(cfg.home,p.root);
    const env=fishEnvironment(runtime,{DSH_NODE:'/bundled/node'});assert.equal(env.BILI_WHALE_CONFIG,p.config);assert.equal(env.DSH_NODE,'/bundled/node');assert(!('HOME'in env));assert.equal(process.env.HOME,before);
    cfg.persona.name='我的鱼';fs.writeFileSync(p.config,JSON.stringify(cfg));const persona=path.join(p.home,'.bili-ai/persona.md');fs.writeFileSync(persona,'custom persona');prepareFishCare(runtime);
    assert.equal(JSON.parse(fs.readFileSync(p.config)).persona.name,'我的鱼');assert.equal(fs.readFileSync(persona,'utf8'),'custom persona');assert(fs.readFileSync(path.join(p.root,'bili.mjs'),'utf8').includes('vendor/dsh-bili-whale'));
    const launcher=path.join(p.root,'bili.mjs');fs.utimesSync(launcher,new Date(1000000),new Date(1000000));prepareFishCare(runtime);assert.equal(fs.statSync(launcher).mtimeMs,1000000,'startup leaves an unchanged launcher untouched');
    prepareFishCare(runtime,{baseDir:'/new/install'});assert(fs.readFileSync(launcher,'utf8').includes('/new/install/vendor/dsh-bili-whale'),'a changed installation still updates the launcher');
    assert.deepEqual(fishPaths(runtime),p);
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
function fixture(){let config={enabled:false},has=false,verifications=0,starts=0,stops=0;const states=[];let fail;
 const control=createFishControl({read:()=>config,write:value=>{config=value;},hasCredentials:()=>has,verify:async()=>{verifications++;if(fail)throw fail;},start:()=>{starts++;return{stop(){stops++;}};},notify:value=>states.push(value)});
 return {control,states,credentials(value){has=value;},fail(error){fail=error;},get counters(){return{verifications,starts,stops};},get config(){return config;}};
}
test('a menu start waits for login, verified QR completion resumes once, and pause stops the live scheduler',async()=>{
 const f=fixture();let s=await f.control.action('start');assert.equal(s.phase,'login-required');assert.equal(f.counters.starts,0);assert.equal(f.config.enabled,false);
 f.credentials(true);s=await f.control.afterLogin();assert.equal(s.enabled,true);assert.deepEqual(f.counters,{verifications:0,starts:1,stops:0});assert.equal(f.config.enabled,true);
 await f.control.action('start');assert.equal(f.counters.starts,1);s=await f.control.action('pause');assert.equal(s.phase,'paused');assert.equal(f.counters.stops,1);assert.equal(f.config.enabled,false);assert(!JSON.stringify(s).includes('cookie'));f.control.dispose();
});
test('concurrent starts serialize and cancelled login never starts a scheduler',async()=>{
 const f=fixture();f.credentials(true);await Promise.all([f.control.action('start'),f.control.action('start')]);assert.deepEqual(f.counters,{verifications:1,starts:1,stops:0});await f.control.action('pause');
 f.credentials(false);await f.control.action('start');await f.control.action('cancel-login');f.credentials(true);await f.control.afterLogin();assert.equal(f.counters.starts,1);f.control.dispose();
});
test('failed verification stays paused, invalid login is actionable, and dispose prevents future work',async()=>{
 const f=fixture();f.credentials(true);f.fail(Error('network private details'));let s=await f.control.action('start');assert.equal(s.phase,'error');assert.equal(f.config.enabled,false);assert(!s.reason.includes('private'));
 const error=Error('expired');error.code='AUTH_INVALID';f.fail(error);s=await f.control.action('start');assert.equal(s.phase,'login-required');assert.equal(f.counters.starts,0);f.control.dispose();await assert.rejects(f.control.action('start'),/关闭/);
});
test('QR dependency is bundled offline and produces an actual PNG without network access',async()=>{
 const qr=require('../../apps/neko-workbench/vendor/dsh-bili-whale/deps/qrcode.cjs'),bytes=await qr.toBuffer('https://passport.bilibili.com/test',{width:200});assert.equal(bytes.subarray(1,4).toString(),'PNG');assert(bytes.length>500);
});
test('missing model login blocks B站 work, and pausing an in-flight verification fences automatic resume',async()=>{
 let model=false,config={enabled:false},starts=0,release;const gate=new Promise(resolve=>release=resolve);
 const control=createFishControl({read:()=>config,write:value=>config=value,modelReady:async()=>model,hasCredentials:()=>true,verify:()=>gate,start:()=>{starts++;return{stop(){}};}});
 assert.equal((await control.action('start')).phase,'model-login-required');assert.equal(starts,0);
 model=true;const resume=control.afterModelLogin();await new Promise(resolve=>setImmediate(resolve));const paused=control.action('pause');release();await resume;await paused;
 assert.equal(control.snapshot().phase,'paused');assert.equal(config.enabled,false);assert.equal(starts,0);await control.afterModelLogin();assert.equal(starts,0);control.dispose();
});
test('execution failures stop the scheduler and retain only safe actionable status',async()=>{
 const f=fixture();f.credentials(true);await f.control.action('start');const state=await f.control.reportFailure();assert.equal(state.phase,'error');assert.equal(f.counters.stops,1);assert.equal(f.config.enabled,false);assert.match(state.reason,/余额/);f.control.dispose();
});
test('pause fences starts already queued before they execute, while later explicit starts remain usable',async()=>{
 const f=fixture();f.credentials(true);
 await Promise.all([f.control.action('start'),f.control.action('start'),f.control.action('pause')]);
 assert.equal(f.counters.starts,0);assert.equal(f.control.snapshot().phase,'paused');assert.equal(f.config.enabled,false);
 await f.control.action('start');assert.equal(f.counters.starts,1);f.control.dispose();
});
test('cancelled verification failures cannot restore login intent or publish stale errors',async()=>{
 for(const action of ['pause','cancel-login']){
  let config={enabled:true},rejectVerify,starts=0;
  const verification=new Promise((_,reject)=>rejectVerify=reject);
  const states=[];
  const control=createFishControl({read:()=>config,write:value=>config=value,hasCredentials:()=>true,verify:()=>verification,start:()=>{starts++;return{stop(){}}},notify:state=>states.push(state)});
  const started=control.restore();await new Promise(resolve=>setImmediate(resolve));
  assert.equal((await control.action('status')).phase,'checking');
  const cancelled=control.action(action);const error=Error('expired private credential');error.code='AUTH_INVALID';rejectVerify(error);
  await started;await cancelled;await control.afterLogin();
  assert.equal(starts,0);assert.equal(config.enabled,false);assert.equal(control.snapshot().phase,'paused');
  assert(!states.some(state=>state.phase==='login-required'||state.phase==='error'));control.dispose();
 }
});
test('late rejected model checks stay cancelled and expose no provider error text',async()=>{
 let config={enabled:false},rejectModel;const gate=new Promise((_,reject)=>rejectModel=reject);
 const states=[],control=createFishControl({read:()=>config,write:value=>config=value,modelReady:()=>gate,hasCredentials:()=>true,verify:async()=>{},start:()=>{throw Error('must not start')},notify:state=>states.push(state)});
 const started=control.action('start');await new Promise(resolve=>setImmediate(resolve));const paused=control.action('pause');rejectModel(Error('provider secret-test-value'));
 await started;await paused;assert.equal(control.snapshot().phase,'paused');assert(!JSON.stringify(states).includes('secret-test-value'));assert(!states.some(state=>state.phase==='error'));control.dispose();
});
test('bundled host stays paused, fences untrusted requests, starts after both logins and cancels only its own work',()=>{
 const {spawnSync}=require('node:child_process');const result=spawnSync(process.execPath,[path.join(__dirname,'fish-host-fixture.mjs')],{encoding:'utf8',timeout:15000});assert.equal(result.status,0,result.stderr+'\n'+result.stdout);
});
