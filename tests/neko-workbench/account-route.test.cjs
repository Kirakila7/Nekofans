'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const {pathToFileURL}=require('node:url');
const {ACCOUNT_ROUTE,accountRoute,isAccountRoute}=require('../../apps/neko-workbench/account-route.cjs');
const {buildDshPatch}=require('../../apps/neko-workbench/runtime-config.cjs');
const installer=require('../../apps/neko-workbench/vendor/dsh-qqbot-workbench/install.cjs');
const lib=path.join(__dirname,'../../apps/neko-workbench/vendor/dsh-bili-whale/lib');
const ROUTE={provider:'deepseek-account',model:'deepseek-flash',reasoningEffort:'high'};
function extract(tmp){fs.copyFileSync(installer.ARCHIVE,path.join(tmp,'qqbot.tgz'));cp.execFileSync('tar',['-xzf','qqbot.tgz'],{cwd:tmp});fs.rmSync(path.join(tmp,'qqbot.tgz'));}

test('one frozen account route is shared by the host default model',()=>{
  assert.deepEqual(accountRoute(),ROUTE);assert(Object.isFrozen(ACCOUNT_ROUTE));
  const copy=accountRoute();copy.model='other';assert.equal(ACCOUNT_ROUTE.model,'deepseek-flash');
  assert(isAccountRoute({provider:'deepseek-account',model:'deepseek-flash'}));
  assert(!isAccountRoute({provider:'deepseek-official',model:'deepseek-flash'}));assert(!isAccountRoute(null));
  const rows=buildDshPatch({dshHomeDir:'/tmp/neko-route',credentialsFile:null},{baseDir:'/tmp/neko-route'});
  assert.deepEqual(rows.find(row=>row.id==='agent-default-model').config,ROUTE);
});

async function delivery(t,controller,extra={}){
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'neko-fish-route-'));t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
  const {createSessionDelivery}=await import(pathToFileURL(path.join(lib,'session-delivery.js')).href);
  return createSessionDelivery({controller,dshHome:home,cwd:home,sessionId:'bili-whale',route:accountRoute(),config:()=>({}),persona:()=>'persona',...extra});
}

test('fish pins the account route before each new or resumed session prompt',async t=>{
  const calls=[];let selected={provider:'other-key',model:'old-model'};
  const controller={resolveAgent:async id=>{calls.push(['resolve',id]);return{agent:{}}},create:async()=>{assert.fail('resuming an existing session must not create a new one')},selectModel:async r=>{selected={...r};calls.push(['select',r])},prompt:async r=>{assert.equal(selected.provider,ROUTE.provider);assert.equal(selected.model,ROUTE.model);calls.push(['prompt',r.sessionId])}};
  const d=await delivery(t,controller);
  await d.send({content:[{type:'text',text:'a'}]});selected={provider:'other-key',model:'changed-live-model'};await d.send({content:[{type:'text',text:'b'}]});
  assert.deepEqual(calls.map(c=>c[0]),['resolve','select','prompt','select','prompt']);
  assert.deepEqual(calls[1][1],{sessionId:'bili-whale',...ROUTE});
});

test('fish does not prompt when the account route cannot be selected',async t=>{
  let prompted=0;
  const controller={resolveAgent:async()=>({agent:{}}),selectModel:async()=>{throw Error('provider secret-test-value is unavailable')},prompt:async()=>{prompted++}};
  const d=await delivery(t,controller);
  await assert.rejects(d.send({content:[{type:'text',text:'a'}]}),e=>e.code==='MODEL_ROUTE_UNAVAILABLE'&&/工作台账号/.test(e.message)&&!String(e.stack).includes('secret-test-value'));
  assert.equal(prompted,0);
});

test('fish records the actual new session and resumes it after restart without another create',async t=>{
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'neko-fish-resume-'));t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
  const {createSessionDelivery}=await import(pathToFileURL(path.join(lib,'session-delivery.js')).href);
  const calls=[];let exists=false;
  const controller={resolveAgent:async id=>{calls.push(['resolve',id]);return exists?{agent:{}}:{error:{code:'session/not-found'}}},create:async request=>{exists=true;calls.push(['create',request.sessionId]);return{sessionId:'host-assigned-fish'}},selectModel:async r=>{assert.equal(r.sessionId,'host-assigned-fish');assert.equal(r.provider,ROUTE.provider);calls.push(['select',r.sessionId])},prompt:async r=>{assert.equal(r.sessionId,'host-assigned-fish');calls.push(['prompt',r.sessionId])}};
  const make=()=>createSessionDelivery({controller,dshHome:home,cwd:home,sessionId:'bili-whale',route:accountRoute(),config:()=>({}),persona:()=>'persona'});
  await make().send({content:[{type:'text',text:'first'}]});
  assert.equal(JSON.parse(fs.readFileSync(path.join(home,'whale-session.json'))).id,'host-assigned-fish');
  await make().send({content:[{type:'text',text:'resumed'}]});
  assert.deepEqual(calls.map(c=>c[0]),['resolve','create','select','prompt','resolve','select','prompt']);
  assert.deepEqual(calls[4],['resolve','host-assigned-fish']);
});

test('fish does not recreate a busy or inaccessible saved session',async t=>{
  let creates=0,prompts=0;
  const d=await delivery(t,{resolveAgent:async()=>({error:{code:'session/writer-held',message:'private host detail'}}),create:async()=>{creates++},selectModel:async()=>{},prompt:async()=>{prompts++}});
  await assert.rejects(d.send({content:[]}),e=>e.code==='SESSION_UNAVAILABLE'&&!e.message.includes('private'));
  assert.equal(creates,0);assert.equal(prompts,0);
});

test('fish cancellation during model selection prevents delivery, and provider rejection is redacted',async t=>{
  let release,prompts=0;const gate=new Promise(resolve=>release=resolve),controller=new AbortController();
  const d=await delivery(t,{resolveAgent:async()=>({agent:{}}),selectModel:()=>gate,prompt:async()=>{prompts++}});
  const pending=d.send({content:[]},controller.signal);await new Promise(resolve=>setImmediate(resolve));controller.abort();release();await assert.rejects(pending,{name:'AbortError'});assert.equal(prompts,0);
  const failed=await delivery(t,{resolveAgent:async()=>({agent:{}}),selectModel:async()=>{},prompt:async()=>{throw Error('sensitive provider token')}});
  await assert.rejects(failed.send({content:[]}),e=>e.code==='MODEL_DELIVERY_FAILED'&&!String(e.stack).includes('sensitive'));
});

test('fish refuses to start without a route',async t=>{
  const {createSessionDelivery}=await import(pathToFileURL(path.join(lib,'session-delivery.js')).href);
  assert.throws(()=>createSessionDelivery({controller:{},dshHome:os.tmpdir(),cwd:os.tmpdir(),sessionId:'x',config:()=>({}),persona:()=>''}),/模型路线/);
});

test('QQ ignores stale peer, config, settings and upstream fallback routes',async t=>{
  const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'neko-qq-route-'));t.after(()=>fs.rmSync(tmp,{recursive:true,force:true}));
  extract(tmp);const pkg=path.join(tmp,'package');
  fs.mkdirSync(path.join(pkg,'node_modules/js-yaml'),{recursive:true});
  fs.writeFileSync(path.join(pkg,'node_modules/js-yaml/package.json'),'{"name":"js-yaml","main":"index.js"}');
  fs.writeFileSync(path.join(pkg,'node_modules/js-yaml/index.js'),'module.exports={load:s=>JSON.parse(s),dump:v=>JSON.stringify(v)}');
  installer.adaptPlugin(tmp,pkg);
  const source=fs.readFileSync(path.join(pkg,'dist/session/session-manager.js'),'utf8');
  assert.match(source,/agent\.model\.select\(__nekoRoute\);\n        const record = \{/);
  const resolverSource=fs.readFileSync(path.join(pkg,'dist/model/model-resolver.js'),'utf8');
  for(const name of ['getEffectiveRoute','getResumeRoute','resolveDefault'])assert.match(resolverSource,new RegExp(`    ${name}\\([^)]*\\) \\{\\n        return __nekoAccountRoute\\(\\);`));
  const {ModelResolver}=await import(pathToFileURL(path.join(pkg,'dist/model/model-resolver.js')).href);
  const before={data:process.env.NEKO_WORKBENCH_DATA_DIR,profile:process.env.NEKO_WORKBENCH_QQBOT_PROFILE};
  const profile=path.join(tmp,'qqbot-runtime');fs.mkdirSync(profile,{recursive:true,mode:0o700});
  process.env.NEKO_WORKBENCH_DATA_DIR=tmp;process.env.NEKO_WORKBENCH_QQBOT_PROFILE=profile;
  t.after(()=>{for(const [key,value] of [['NEKO_WORKBENCH_DATA_DIR',before.data],['NEKO_WORKBENCH_QQBOT_PROFILE',before.profile]]){if(value===undefined)delete process.env[key];else process.env[key]=value;}});
  const resolver=new ModelResolver({get:()=>({currentSelection:()=>({provider:'other-key',model:'other'})})},{provider:'deepseek-official',model:'deepseek-v4-flash'});
  resolver.prefs.setOverride('c2c:peer',{provider:'deepseek-official',model:'deepseek-v4-pro'});
  assert.deepEqual(resolver.getEffectiveRoute('c2c:peer'),ROUTE);assert.deepEqual(resolver.getResumeRoute('c2c:peer'),ROUTE);assert.deepEqual(resolver.resolveDefault(),ROUTE);
  const marker=JSON.parse(fs.readFileSync(path.join(tmp,'installed-adapter.json'),'utf8'));assert.equal(marker.revision,17);
});
