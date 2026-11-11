'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {createLobbyController,defaultSettings,ERR,REASON,validateLobbyRequest}=require('../../apps/neko-workbench/lobby-controller.cjs');
const {fakeProvider,flush}=require('./lobby-fixtures.cjs');
const OWNER='11111111-1111-4111-8111-111111111111',OTHER='22222222-2222-4222-8222-222222222222';
const CAT='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',OTHER_CAT='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const CHANNEL={id:'33333333-3333-4333-8333-333333333333',name:'fixture',cats_enabled:true,cat_free_mode_allowed:false};
const savedCat=(owner=OWNER,extra={})=>({id:owner===OWNER?CAT:OTHER_CAT,owner_user_id:owner,owner_name:'fixture owner',name:'大肥鱼',display_name:'fixture owner的大肥鱼',avatar_key:'bigfish',reply_mode:'mention',enabled:false,admin_disabled:false,deleted:false,...extra});
function fixture(t,{initialMode='assist',initialCat=null,providerReady=true,channel=CHANNEL,muted=false,banned=false,write}={}){
 let directory=null;
 if(initialMode!=='assist'){
  const temporaryRoot=path.resolve(os.tmpdir());directory=fs.mkdtempSync(path.join(temporaryRoot,'neko-cat-registration-'));
  fs.writeFileSync(path.join(directory,'cat.json'),JSON.stringify({...defaultSettings(),mode:initialMode}));
  t.after(()=>{assert.equal(path.dirname(path.resolve(directory)),temporaryRoot);assert(path.basename(directory).startsWith('neko-cat-registration-'));fs.rmSync(directory,{recursive:true,force:true});});
 }
 let currentOwner=OWNER,authStatus='signed-in',connection='idle',ready=providerReady,revision=1,clientEvent,changed,authChanged;
 const records=new Map(initialCat?[[OWNER,initialCat]]:[]),writes=[],sends=[],provider=fakeProvider('fixture reply');let hook=write,activeWrites=0,maxWrites=0;
 const me=()=>({user:{user_id:currentOwner,name:'fixture',display_name:'owner',avatar:{kind:'hue',hue:1,text:'O'}},cat:records.get(currentOwner)||null,role:'member',is_admin:false,muted_until:muted?Date.now()+60000:null,banned_at:banned?Date.now():null});
 const publish=()=>queueMicrotask(()=>changed?.());
 const controller=createLobbyController({config:{configured:true,chatUrl:'https://chat.fixture.invalid/',authUrl:'https://auth.fixture.invalid/',clientId:'fixture',oauthPorts:[17890]},
  dataDir:directory,getChatProvider:()=>ready?provider:null,getChatProviderState:()=>({backend:'deepseek-account',revision,reason:ready?'':'account-signed-out'}),getPersona:()=>({name:'大肥鱼',prompt:'synthetic public role'}),
  factories:{
   auth:options=>{authChanged=options.onState;return {get state(){return {status:authStatus,error:''};},async signIn(){authStatus='signed-in';authChanged();},async signOut(){authStatus='signed-out';authChanged();},dispose(){}};},
   avatars:()=>({get:()=>null,clear(){}}),experience:()=>null,
   client:options=>{clientEvent=options.onEvent;changed=options.onChange;return {
    snapshot:()=>({status:connection,channel,messages:[],members:[],outbox:[]}),connect(){connection='online';publish();},disconnect(){connection='idle';publish();},reset(){connection='idle';publish();},dispose(){},
    send:async value=>{sends.push(value);},sendCat:async value=>{sends.push(value);},setCatStatus(){},rest:{
     me:async()=>me(),
     putCat:async input=>{const owner=currentOwner;writes.push({...input,owner});activeWrites++;maxWrites=Math.max(maxWrites,activeWrites);
      try{const overridden=await hook?.(input,owner);const value=overridden||savedCat(owner,{name:input.name,avatar_key:input.avatarKey,reply_mode:input.replyMode,enabled:input.enabled,admin_disabled:records.get(owner)?.admin_disabled||false});records.set(owner,value);return value;}
      finally{activeWrites--;}
     },
    },
   };},
  }});
 t.after(()=>controller.dispose());
 return {controller,writes,sends,provider,directory,records,get maxWrites(){return maxWrites;},
  async open(){const result=await controller.request({action:'open'});await flush();return result;},
  setReady(value){ready=value;revision++;controller.refresh();},setWrite(fn){hook=fn;},setOwner(value){currentOwner=value;},
  event(type,payload){clientEvent(type,payload);},async settle(){await flush();}};
}

test('first assist entry registers the existing main companion disabled, once, without a model call or public message',async t=>{
 const f=fixture(t);await f.open();assert.equal(f.writes.length,1);
 assert.deepEqual(f.writes[0],{name:'大肥鱼',avatarKey:'bigfish',replyMode:'mention',enabled:false,owner:OWNER});
 const snapshot=f.controller.snapshot();assert.equal(snapshot.me.cat.id,CAT);assert.equal(snapshot.catSettings.mode,'assist');assert.equal(snapshot.participation.providerAvailable,true);assert.equal(snapshot.participation.available,true);
 await f.open();await f.controller.request({action:'state'});await f.settle();assert.equal(f.writes.length,1);assert.equal(f.provider.calls.length,0);assert.equal(f.sends.length,0);
});

test('off remains local and never creates a profile; an unchanged explicit Save can register disabled defaults',async t=>{
 const f=fixture(t,{initialMode:'off'});await f.open();assert.equal(f.writes.length,0);assert.equal((await f.controller.request({action:'mode-set',mode:'off'})).ok,true);assert.equal(f.writes.length,0);
 assert.deepEqual(validateLobbyRequest({action:'cat-save'}),{action:'cat-save'});
 const saved=await f.controller.request({action:'cat-save'});assert.equal(saved.ok,true);assert.equal(f.writes.length,1);assert.equal(f.writes[0].enabled,false);assert.equal(saved.state.catSettings.mode,'off');assert.equal(f.provider.calls.length,0);
});
test('the local off choice is still available when the optional lobby service is unconfigured',async()=>{
 const controller=createLobbyController({config:{configured:false}});try{const result=await controller.request({action:'mode-set',mode:'off'});assert.equal(result.ok,true);assert.equal(result.state.catSettings.mode,'off');assert.equal(result.state.connection,'unconfigured');}finally{controller.dispose();}
});
test('non-off participation cannot claim configuration success before the channel/account context is ready',async t=>{
 const f=fixture(t);const result=await f.controller.request({action:'mode-set',mode:'independent'});assert.equal(result.ok,false);assert.equal(result.error,ERR.loading);assert.equal(result.state.catSettings.mode,'assist');assert.equal(f.writes.length,0);
});

test('saving only local note/trigger fields also provisions a missing service profile',async t=>{
 const f=fixture(t,{initialMode:'off'});await f.open();const result=await f.controller.request({action:'cat-save',note:'public fixture note',independentTrigger:'owner_or_mention'});
 assert.equal(result.ok,true,result.error);assert.equal(f.writes.length,1);assert.equal(f.writes[0].replyMode,'owner_or_mention');assert.equal(f.writes[0].enabled,false);assert.equal(result.state.catSettings.note,'public fixture note');assert.equal(result.state.catSettings.serverCatId,CAT);
});

test('explicit independent/off choices map to acknowledged server enabled flags and never themselves generate speech',async t=>{
 const f=fixture(t);await f.open();let result=await f.controller.request({action:'mode-set',mode:'independent',trigger:'owner_or_mention'});
 assert.equal(result.ok,true);assert.equal(f.writes.at(-1).enabled,true);assert.equal(f.writes.at(-1).replyMode,'owner_or_mention');assert.equal(result.state.participation.available,true);
 result=await f.controller.request({action:'mode-set',mode:'off'});assert.equal(result.ok,true);assert.equal(f.writes.at(-1).enabled,false);assert.equal(result.state.cat.mode,'off');assert.equal(f.provider.calls.length,0);assert.equal(f.sends.length,0);
});

test('existing service name/avatar are preserved when only mode or local fields change',async t=>{
 const f=fixture(t,{initialCat:savedCat(OWNER,{name:'existing role',avatar_key:'existing-avatar'})});await f.open();assert.equal(f.writes.length,0);
 await f.controller.request({action:'cat-save',note:'note only'});assert.equal(f.writes.length,0);
 await f.controller.request({action:'mode-set',mode:'independent'});assert.equal(f.writes.at(-1).name,'existing role');assert.equal(f.writes.at(-1).avatarKey,'existing-avatar');
});

test('provider readiness is separate from a missing service profile and becomes available without another API key',async t=>{
 const f=fixture(t,{providerReady:false});await f.open();assert.equal(f.writes.length,0);assert.equal(f.controller.snapshot().participation.providerAvailable,false);
 assert.equal((await f.controller.request({action:'mode-set',mode:'independent'})).error,REASON.accountLogin);
 f.setReady(true);await f.settle();assert.equal(f.writes.length,1);assert.equal(f.writes[0].enabled,false);assert.equal(f.controller.snapshot().participation.providerAvailable,true);assert.equal(f.controller.snapshot().participation.available,true);assert.equal(f.provider.calls.length,0);
});

test('channel/admin/mute restrictions are never cleared or bypassed by cat provisioning',async t=>{
 for(const options of [{channel:{...CHANNEL,cats_enabled:false}},{muted:true},{initialCat:savedCat(OWNER,{admin_disabled:true})}]){
  const f=fixture(t,options);await f.open();await f.controller.request({action:'mode-set',mode:'independent'});assert(f.writes.every(input=>input.enabled===false));assert.equal(f.controller.snapshot().participation.available,false);assert.equal(f.provider.calls.length,0);assert.equal(f.sends.length,0);
 }
});

test('provisioning failures do not look like missing model credentials and can be retried by Save',async t=>{
 const f=fixture(t,{write:()=>{throw Error('private service response');}});await f.open();
 assert.equal(f.writes.length,1);assert.equal(f.controller.snapshot().participation.providerAvailable,true);assert.equal(f.controller.snapshot().participation.available,false);assert(!JSON.stringify(f.controller.snapshot()).includes('private service'));
 await f.controller.request({action:'state'});await f.settle();assert.equal(f.writes.length,1,'automatic first-use failure is not an endless write loop');
 f.setWrite(null);const result=await f.controller.request({action:'cat-save'});assert.equal(result.ok,true);assert.equal(f.writes.length,2);assert.equal(result.state.error,'');assert.equal(result.state.participation.available,true);
});

test('service responses for another owner cannot attach a foreign cat or claim setup success',async t=>{
 const f=fixture(t,{initialMode:'off',write:()=>savedCat(OTHER)});await f.open();const result=await f.controller.request({action:'cat-save'});
 assert.equal(result.ok,false);assert.equal(result.error,ERR.catSync);assert.equal(result.state.me.cat,null);assert.equal(result.state.catSettings.serverCatId,null);
});

test('sign-out/account replacement fences an old in-flight profile write and provisions the new account independently',async t=>{
 let release;const held=new Promise(resolve=>{release=resolve;});let first=true;
 const f=fixture(t,{write:async()=>{if(first){first=false;await held;}}});await f.open();assert.equal(f.writes.length,1);
 await f.controller.request({action:'sign-out'});f.setOwner(OTHER);await f.controller.request({action:'sign-in'});await f.controller.request({action:'open'});release();await f.settle();
 const snapshot=f.controller.snapshot();assert.equal(snapshot.me.user_id,OTHER);assert.equal(snapshot.me.cat.id,OTHER_CAT);assert.equal(snapshot.catSettings.serverCatId,OTHER_CAT);assert.equal(f.maxWrites,1);assert.equal(f.provider.calls.length,0);
});
test('a queued configuration intent from the previous account cannot execute against a newly signed-in owner',async t=>{
 const f=fixture(t,{initialMode:'off',initialCat:savedCat()});await f.open();let release;const held=new Promise(resolve=>{release=resolve;});f.setWrite(async()=>{await held;});
 const enabling=f.controller.request({action:'mode-set',mode:'independent'});await f.settle();const queued=f.controller.request({action:'cat-save',name:'previous owner pending name'});
 await f.controller.request({action:'sign-out'});f.setOwner(OTHER);await f.controller.request({action:'sign-in'});await f.controller.request({action:'open'});release();await enabling;
 const result=await queued;assert.equal(result.ok,false);assert.equal(result.error,ERR.accountChanged);assert.equal(f.writes.length,1);assert.equal(result.state.catSettings.name,null);assert.equal(result.state.me.user_id,OTHER);assert.equal(result.state.me.cat,null);
});

test('concurrent mode writes serialize, and an unacknowledged independent setting cannot start generation',async t=>{
 const f=fixture(t);await f.open();let release;const held=new Promise(resolve=>{release=resolve;});f.setWrite(async input=>{if(input.enabled)await held;});
 const enabling=f.controller.request({action:'mode-set',mode:'independent'});await f.settle();assert.equal(f.controller.snapshot().participation.available,false);
 const disabling=f.controller.request({action:'mode-set',mode:'off'});f.event('message.new',{live:true,message:{id:'44444444-4444-4444-8444-444444444444',seq:1,created_at:Date.now(),text:'@fixture',mentions:[{kind:'cat',id:CAT}],author:{kind:'human',user_id:OTHER}}});await f.settle();assert.equal(f.provider.calls.length,0);
 release();assert.equal((await enabling).ok,true);assert.equal((await disabling).ok,true);assert.equal(f.maxWrites,1);assert.equal(f.writes.at(-1).enabled,false);assert.equal(f.controller.snapshot().cat.mode,'off');assert.equal(f.sends.length,0);
});

test('failed local persistence keeps the previous mode/runtime and performs no remote mode write',async t=>{
 const f=fixture(t,{initialMode:'off',initialCat:savedCat()});await f.open();const file=path.join(f.directory,'cat.json'),backup=file+'.old';fs.renameSync(file,backup);fs.mkdirSync(file);const writes=f.writes.length;
 const result=await f.controller.request({action:'mode-set',mode:'independent'});
 assert.equal(result.ok,false);assert.equal(result.error,ERR.storage);assert.equal(result.state.catSettings.mode,'off');assert.equal(result.state.cat.mode,'off');assert.equal(f.writes.length,writes);assert.equal(JSON.parse(fs.readFileSync(backup,'utf8')).mode,'off');
});
