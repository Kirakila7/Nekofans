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
// Relative paths keep GNU tar from reading Windows drive letters as remote hosts.
// Unprivileged Windows accounts cannot create symlinks; those cases are covered on POSIX.
function trySymlink(target,link){try{fs.symlinkSync(target,link);return true;}catch(e){if(e.code==='EPERM'&&process.platform==='win32')return false;throw e;}}
function extract(tmp){fs.copyFileSync(installer.ARCHIVE,path.join(tmp,'qqbot.tgz'));cp.execFileSync('tar',['-xzf','qqbot.tgz'],{cwd:tmp});fs.rmSync(path.join(tmp,'qqbot.tgz'));}

test('official archive is pinned for offline audit with its original bytes', () => {
  const actual = crypto.createHash('sha256').update(fs.readFileSync(installer.ARCHIVE)).digest('hex');
  assert.equal(actual, installer.SHA);
});

test('QQ model settings and session preferences stay in the selected private profile',async t=>{
  const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'neko-qq-profile-test-'));t.after(()=>fs.rmSync(tmp,{recursive:true,force:true}));
  extract(tmp);const pkg=path.join(tmp,'package');
  fs.mkdirSync(path.join(pkg,'node_modules/js-yaml'),{recursive:true});
  fs.writeFileSync(path.join(pkg,'node_modules/js-yaml/package.json'),'{"name":"js-yaml","main":"index.js"}');
  fs.writeFileSync(path.join(pkg,'node_modules/js-yaml/index.js'),'module.exports={load:s=>JSON.parse(s),dump:v=>JSON.stringify(v)}');
  installer.adaptPlugin(tmp,pkg);
  const readerSource=fs.readFileSync(path.join(pkg,'dist/model/settings-reader.js'),'utf8');
  const prefsSource=fs.readFileSync(path.join(pkg,'dist/model/prefs-store.js'),'utf8');
  assert(!readerSource.includes('homedir()'));assert(!prefsSource.includes('homedir()'));
  const {SettingsReader}=await import(pathToFileURL(path.join(pkg,'dist/model/settings-reader.js')).href);
  const {PrefsStore}=await import(pathToFileURL(path.join(pkg,'dist/model/prefs-store.js')).href);
  const previous={data:process.env.NEKO_WORKBENCH_DATA_DIR,profile:process.env.NEKO_WORKBENCH_QQBOT_PROFILE};
  t.after(()=>{for(const [key,value] of [['NEKO_WORKBENCH_DATA_DIR',previous.data],['NEKO_WORKBENCH_QQBOT_PROFILE',previous.profile]]){if(value===undefined)delete process.env[key];else process.env[key]=value;}});
  const fakeHome=path.join(tmp,'fake-home');fs.mkdirSync(path.join(fakeHome,'.dsh'),{recursive:true});fs.mkdirSync(path.join(fakeHome,'.dsh-qqbot'));
  const outsideSettings=path.join(fakeHome,'.dsh/settings.yaml'),outsidePrefs=path.join(fakeHome,'.dsh-qqbot/model-prefs.json');
  fs.writeFileSync(outsideSettings,JSON.stringify({'agent-default-model':{provider:'wrong-global',model:'wrong-global'}}));
  fs.writeFileSync(outsidePrefs,JSON.stringify({presets:{peer:'wrong-global'}}));
  const oldHomedir=os.homedir;os.homedir=()=>fakeHome;t.after(()=>{os.homedir=oldHomedir});
  const dataA=path.join(tmp,'a'),dataB=path.join(tmp,'b');
  const a=path.join(dataA,'qqbot-runtime'),b=path.join(dataB,'qqbot-runtime');
  fs.mkdirSync(a,{recursive:true,mode:0o700});fs.mkdirSync(b,{recursive:true,mode:0o700});
  const use=(data,profile)=>{process.env.NEKO_WORKBENCH_DATA_DIR=data;process.env.NEKO_WORKBENCH_QQBOT_PROFILE=profile;};
  use(dataA,a);assert.equal(new SettingsReader().readDefaultRoute(),undefined);
  const privateSettings=path.join(a,'settings.yaml');fs.writeFileSync(privateSettings,JSON.stringify({'agent-default-model':{provider:'private',model:'a'}}),{mode:0o600});
  assert.deepEqual(new SettingsReader().readDefaultRoute(),{provider:'private',model:'a'});
  const prefA=new PrefsStore();assert.equal(prefA.getPreset('peer'),undefined);prefA.setPreset('peer','from-a');
  const prefFile=path.join(a,'model-prefs.json');if(process.platform!=='win32')assert.equal(fs.statSync(prefFile).mode&0o777,0o600);
  assert.equal(new PrefsStore().getPreset('peer'),'from-a');
  use(dataB,b);assert.equal(new SettingsReader().readDefaultRoute(),undefined);assert.equal(new PrefsStore().getPreset('peer'),undefined);
  new PrefsStore().setPreset('peer','from-b');assert.equal(JSON.parse(fs.readFileSync(path.join(b,'model-prefs.json'),'utf8')).presets.peer,'from-b');
  assert.equal(JSON.parse(fs.readFileSync(prefFile,'utf8')).presets.peer,'from-a');
  assert.equal(JSON.parse(fs.readFileSync(outsidePrefs,'utf8')).presets.peer,'wrong-global');
  assert.equal(JSON.parse(fs.readFileSync(outsideSettings,'utf8'))['agent-default-model'].provider,'wrong-global');
  fs.unlinkSync(path.join(b,'model-prefs.json'));
  if(trySymlink(outsidePrefs,path.join(b,'model-prefs.json'))){
    new PrefsStore().setPreset('peer','must-not-write-through');
    assert.equal(JSON.parse(fs.readFileSync(outsidePrefs,'utf8')).presets.peer,'wrong-global');
    fs.unlinkSync(path.join(b,'model-prefs.json'));
  }
  if(trySymlink(outsideSettings,path.join(b,'settings.yaml')))assert.equal(new SettingsReader().readDefaultRoute(),undefined);
  fs.linkSync(outsidePrefs,path.join(b,'model-prefs.json'));
  new PrefsStore().setPreset('peer','must-not-write-hardlink');
  assert.equal(JSON.parse(fs.readFileSync(outsidePrefs,'utf8')).presets.peer,'wrong-global');
  process.env.NEKO_WORKBENCH_QQBOT_PROFILE=fakeHome;
  assert.throws(()=>new PrefsStore(),/QQ profile unavailable/);
  const alias=path.join(tmp,'data-alias');
  if(trySymlink(dataA,alias)){use(alias,path.join(alias,'qqbot-runtime'));assert.throws(()=>new PrefsStore(),/QQ profile unavailable/);}
});

test('official persistence adapter keeps credentials private and does not print them on failure',async t=>{
  const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'neko-qq-adapter-test-'));t.after(()=>fs.rmSync(tmp,{recursive:true,force:true}));
  extract(tmp);const pkg=path.join(tmp,'package');
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
  if(process.platform!=='win32')assert.equal(fs.statSync(p).mode&0o777,0o600);assert.equal(events,1);
});

test('QQ control remains stopped by default; a canceled start cannot load a plugin',async t=>{
  const saved=installer.install;let resolveInstall;installer.install=()=>new Promise(resolve=>{resolveInstall=resolve});
  const target=path.join(base,'index.cjs');delete require.cache[require.resolve(target)];const wrapper=require(target);
  const before={data:process.env.NEKO_WORKBENCH_DATA_DIR,modules:process.env.NEKO_WORKBENCH_DSH_MODULES};
  process.env.NEKO_WORKBENCH_DATA_DIR='/tmp/qq-test-data';process.env.NEKO_WORKBENCH_DSH_MODULES='/tmp/qq-test-modules';
  t.after(()=>{installer.install=saved;delete require.cache[require.resolve(target)];for(const [key,value] of [['NEKO_WORKBENCH_DATA_DIR',before.data],['NEKO_WORKBENCH_DSH_MODULES',before.modules]]){if(value===undefined)delete process.env[key];else process.env[key]=value;}});
  let created=0,dispose,handler;
  const ctx={loader:{create(){created++;throw Error('must not load')},remove(){},resolve(){},await(){}},get(name){return name==='deepseekAccount'?{getState:async()=>({status:'credential-stored'})}:null},on(event,fn){if(event==='dispose')dispose=fn},inject(_names,fn){fn({webServer:{register(spec){handler=spec.handler;return ()=>{}}},effect(){}})}};
  wrapper.apply(ctx);assert.equal((await wrapper.qqbotAction('status')).phase,'paused');
  const r={statusCode:0,end(){}};handler({method:'GET',headers:{}},r);assert.equal(r.statusCode,403);
  const starting=wrapper.qqbotAction('start');await new Promise(resolve=>setImmediate(resolve));const pausing=wrapper.qqbotAction('pause');resolveInstall({pkg:'/tmp/does-not-matter'});
  assert.equal((await starting).enabled,false);assert.equal((await pausing).phase,'paused');assert.equal(created,0);
  await assert.rejects(wrapper.qqbotAction('unknown'),/未知/);dispose();
});

test('runtime adds an inactive controller and preserves fish in the same patch',()=>{
  const runtime={dshHomeDir:'/tmp/neko-qq-fixture',credentialsFile:null};const rows=buildDshPatch(runtime,{baseDir:'/tmp/neko-qq-fixture'}).at(-1).insert;
  assert(rows.some(row=>row.id==='dsh-bili-whale'));assert.equal(rows.find(row=>row.id==='neko-qqbot-workbench').name,path.join('/tmp/neko-qq-fixture','vendor/dsh-qqbot-workbench/index.cjs'));
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
  const ctx={loader:{create:async()=> 'fixture',resolve:()=>({fiber}),await:async()=>{},update:async()=>{updateStarted();await gate},remove(){removed++}},get(name){return name==='deepseekAccount'?{getState:async()=>({status:'credential-stored'})}:null},on(event,fn){if(event==='dispose')dispose=fn},inject(_names,fn){fn({webServer:{register(){return ()=>{}}},effect(){}})}};
  wrapper.apply(ctx);assert.equal((await wrapper.qqbotAction('start')).enabled,true);
  process.emit('neko-qqbot-config-changed');await started;
  let done=false;const stopping=wrapper.qqbotAction('pause').then(v=>{done=true;return v});await new Promise(resolve=>setImmediate(resolve));
  assert.equal(done,false);assert.equal(removed,0);releaseUpdate();assert.equal((await stopping).phase,'paused');assert.equal(removed,1);dispose();
});
