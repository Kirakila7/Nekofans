'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const {pathToFileURL}=require('node:url');
const base = path.join(__dirname,'../../apps/neko-workbench/vendor/dsh-qqbot-workbench');
const installer=require(path.join(base,'install.cjs'));
const {buildDshPatch}=require('../../apps/neko-workbench/runtime-config.cjs');

test('official archive is pinned for offline audit with its original bytes', () => {
  const actual = crypto.createHash('sha256').update(fs.readFileSync(installer.ARCHIVE)).digest('hex');
  assert.equal(actual, installer.SHA);
});

test('official persistence adapter keeps credentials private and does not print them on failure',async t=>{
  const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'neko-qq-adapter-test-'));t.after(()=>fs.rmSync(tmp,{recursive:true,force:true}));
  cp.execFileSync('tar',['-xzf',installer.ARCHIVE,'-C',tmp]);const pkg=path.join(tmp,'package');
  fs.mkdirSync(path.join(pkg,'node_modules/js-yaml'),{recursive:true});fs.writeFileSync(path.join(pkg,'node_modules/js-yaml/package.json'),'{"name":"js-yaml","main":"index.js"}');
  fs.writeFileSync(path.join(pkg,'node_modules/js-yaml/index.js'),"module.exports={load:()=>[],dump:v=>JSON.stringify(v)}");
  installer.adaptPlugin(tmp,pkg);
  const bootstrap=fs.readFileSync(path.join(pkg,'dist/gateway/bootstrap.js'),'utf8');
  assert(!bootstrap.includes('registerSendFileTool(ctx, mediaSender, manager, config, logger);'));
  assert(!bootstrap.includes('process.env.QQBOT_BASE_URL'));
  assert(!bootstrap.includes('process.env.QQBOT_TOKEN_BASE_URL'));
  const persist=await import(pathToFileURL(path.join(pkg,'dist/setup/persist.js')).href);
  const logs=[];const old=console.log;console.log=(...items)=>logs.push(items.join(' '));t.after(()=>{console.log=old});
  const logger={info(){},warn(s){logs.push(s)}};const creds={appId:'fixture-id',appSecret:'fixture-secret-not-for-logging'};
  assert.equal(persist.persistCredentialsToProfile(creds,undefined,logger),false);
  const impossible=path.join(tmp,'file-as-dir');fs.writeFileSync(impossible,'fixture');
  assert.equal(persist.persistCredentialsToProfile(creds,impossible,logger),false);
  assert(!logs.join('\n').includes(creds.appSecret));
  const profile=path.join(tmp,'profile');const p=installer.prepareProfile(profile);
  let events=0;const listener=()=>events++;process.on('neko-qqbot-config-changed',listener);t.after(()=>process.off('neko-qqbot-config-changed',listener));
  assert.equal(persist.persistCredentialsToProfile(creds,profile,logger),true);
  assert.equal(fs.statSync(p).mode&0o777,0o600);assert.equal(events,1);
});

test('QQ control remains stopped by default; a canceled start cannot load a plugin',async t=>{
  const saved=installer.install;let resolveInstall;installer.install=()=>new Promise(resolve=>{resolveInstall=resolve});
  const target=path.join(base,'index.cjs');delete require.cache[require.resolve(target)];const wrapper=require(target);
  const before={data:process.env.NEKO_WORKBENCH_DATA_DIR,modules:process.env.NEKO_WORKBENCH_DSH_MODULES};
  process.env.NEKO_WORKBENCH_DATA_DIR='/tmp/qq-test-data';process.env.NEKO_WORKBENCH_DSH_MODULES='/tmp/qq-test-modules';
  t.after(()=>{installer.install=saved;delete require.cache[require.resolve(target)];for(const [key,value] of [['NEKO_WORKBENCH_DATA_DIR',before.data],['NEKO_WORKBENCH_DSH_MODULES',before.modules]]){if(value===undefined)delete process.env[key];else process.env[key]=value;}});
  let created=0,dispose,handler;
  const ctx={loader:{create(){created++;throw Error('must not load')},remove(){},resolve(){},await(){}},get(){return null},on(event,fn){if(event==='dispose')dispose=fn},inject(_names,fn){fn({webServer:{register(spec){handler=spec.handler;return ()=>{}}},effect(){}})}};
  wrapper.apply(ctx);assert.equal((await wrapper.qqbotAction('status')).phase,'paused');
  const r={statusCode:0,end(){}};handler({method:'GET',headers:{}},r);assert.equal(r.statusCode,403);
  const starting=wrapper.qqbotAction('start');const pausing=wrapper.qqbotAction('pause');resolveInstall({pkg:'/tmp/does-not-matter'});
  assert.equal((await starting).enabled,false);assert.equal((await pausing).phase,'paused');assert.equal(created,0);
  await assert.rejects(wrapper.qqbotAction('unknown'),/未知/);dispose();
});

test('runtime adds an inactive controller and preserves fish in the same patch',()=>{
  const runtime={dshHomeDir:'/tmp/neko-qq-fixture',credentialsFile:null};const rows=buildDshPatch(runtime,{baseDir:'/tmp/neko-qq-fixture'}).at(-1).insert;
  assert(rows.some(row=>row.id==='dsh-bili-whale'));assert.equal(rows.find(row=>row.id==='neko-qqbot-workbench').name,'/tmp/neko-qq-fixture/vendor/dsh-qqbot-workbench/index.cjs');
});

test('pause waits for a configuration reload before removing the QQ plugin',async t=>{
  const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'neko-qq-reload-'));t.after(()=>fs.rmSync(tmp,{recursive:true,force:true}));
  const root=path.join(tmp,'qqbot-runtime');fs.mkdirSync(path.join(root,'node_modules/js-yaml'),{recursive:true});
  fs.writeFileSync(path.join(root,'node_modules/js-yaml/index.js'),"module.exports={load:()=>[]}");fs.writeFileSync(path.join(root,'cordis.patch.yml'),'[]');
  const saved=installer.install;installer.install=async()=>({pkg:tmp});
  const target=path.join(base,'index.cjs');delete require.cache[require.resolve(target)];const wrapper=require(target);
  const before={data:process.env.NEKO_WORKBENCH_DATA_DIR,modules:process.env.NEKO_WORKBENCH_DSH_MODULES};process.env.NEKO_WORKBENCH_DATA_DIR=tmp;process.env.NEKO_WORKBENCH_DSH_MODULES=tmp;
  t.after(()=>{installer.install=saved;delete require.cache[require.resolve(target)];for(const [key,value] of [['NEKO_WORKBENCH_DATA_DIR',before.data],['NEKO_WORKBENCH_DSH_MODULES',before.modules]]){if(value===undefined)delete process.env[key];else process.env[key]=value;}});
  let releaseUpdate,updateStarted,removed=0,dispose;const gate=new Promise(resolve=>{releaseUpdate=resolve});const started=new Promise(resolve=>{updateStarted=resolve});
  const fiber={state:2,dispose:async()=>{}};
  const ctx={loader:{create:async()=> 'fixture',resolve:()=>({fiber}),await:async()=>{},update:async()=>{updateStarted();await gate},remove(){removed++}},get(){return null},on(event,fn){if(event==='dispose')dispose=fn},inject(_names,fn){fn({webServer:{register(){return ()=>{}}},effect(){}})}};
  wrapper.apply(ctx);assert.equal((await wrapper.qqbotAction('start')).enabled,true);
  process.emit('neko-qqbot-config-changed');await started;
  let done=false;const stopping=wrapper.qqbotAction('pause').then(v=>{done=true;return v});await new Promise(resolve=>setImmediate(resolve));
  assert.equal(done,false);assert.equal(removed,0);releaseUpdate();assert.equal((await stopping).phase,'paused');assert.equal(removed,1);dispose();
});
