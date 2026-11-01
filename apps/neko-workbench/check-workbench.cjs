const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),vm=require('node:vm');
const {createAppearanceStore}=require('./workbench-appearance.cjs');
async function run(){
const folder=fs.mkdtempSync(path.join(os.tmpdir(),'neko-workbench-'));
try{
  const file=path.join(folder,'appearance.json'),store=createAppearanceStore(file);
  assert.deepEqual(store.get(),{builtinId:'yui',customDataUrl:null});
  store.select('gemini');assert.equal(createAppearanceStore(file).get().builtinId,'gemini');
  assert.throws(()=>store.select('custom'));assert.throws(()=>store.select('../../private'));
  assert.throws(()=>store.upload('https://example.com/avatar.png'));
  assert.throws(()=>store.upload('data:image/svg+xml;base64,PHN2Zz4='));
  const png='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jhfkAAAAASUVORK5CYII=';
  store.upload(png);assert.deepEqual(createAppearanceStore(file).get(),{builtinId:'custom',customDataUrl:png});
  store.select('claude');const restarted=createAppearanceStore(file);assert.equal(restarted.get().builtinId,'claude');restarted.select('custom');assert.equal(restarted.get().customDataUrl,png);
  fs.writeFileSync(file,JSON.stringify({builtinId:'custom',customDataUrl:'file:///private/secret'}));assert.deepEqual(createAppearanceStore(file).get(),{builtinId:'yui',customDataUrl:null});
  fs.writeFileSync(file,'broken');assert.equal(createAppearanceStore(file).get().builtinId,'yui');
  const calls=[],listeners=new Map(),bridges=new Map();
  const ipcRenderer={
    invoke:(...args)=>{calls.push(args);return Promise.resolve({});},
    on:(event,fn)=>{if(!listeners.has(event))listeners.set(event,new Set());listeners.get(event).add(fn);},
    removeListener:(event,fn)=>{const group=listeners.get(event);if(group){group.delete(fn);if(!group.size)listeners.delete(event);}}
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'workbench-preload.cjs'),'utf8'),{require:name=>{
    assert.equal(name,'electron');
    return {contextBridge:{exposeInMainWorld:(name,value)=>{assert(!bridges.has(name),'bridge exposed twice');bridges.set(name,value);}},ipcRenderer};
  }});
  assert.deepEqual([...bridges.keys()].sort(),['nekoRoles','nekoWorkbench']);
  const bridge=bridges.get('nekoWorkbench'),roles=bridges.get('nekoRoles');
  assert.deepEqual(Object.keys(bridge).sort(),['action','community','communityAccount','companion','divider','fish','fishQq','getAccounts','getState','home','lobby','nativeComposer','qqbot','screenShare','setAvatar','setWindowTheme','subscribe','subscribeCommunity','subscribeCommunityAccount','subscribeDivider','subscribeHome','subscribeLobby','subscribeNativeComposer','subscribeOffice','toggleFullscreen','uploadAvatar','windowChrome','workspace']);assert(Object.isFrozen(bridge));
  assert.deepEqual(Object.keys(roles).sort(),['getState','selectRole','subscribe','updateRole','uploadAvatar']);assert(Object.isFrozen(roles));

  bridge.getState();bridge.setAvatar('yui');bridge.uploadAvatar();bridge.action('neko-settings');bridge.home({action:'status'});
  const patch={name:'自定义结衣',avatarId:'gemini'};
  roles.getState();roles.selectRole('bigfish');roles.updateRole('yui',patch);roles.uploadAvatar('claude');
  // Object payloads cross a VM realm; compare serialized values while retaining undefined call arguments.
  const recorded=calls.map(args=>args.map(value=>value&&typeof value==='object'?JSON.parse(JSON.stringify(value)):value));
  assert.deepEqual(recorded,[
    ['workbench:call','state',undefined],
    ['workbench:call','avatar','yui'],
    ['workbench:call','upload-avatar',undefined],
    ['workbench:call','action','neko-settings'],
    ['workbench:home',{action:'status'}],
    ['workbench:roles','state'],
    ['workbench:roles','select',{id:'bigfish'}],
    ['workbench:roles','update',{id:'yui',patch}],
    ['workbench:roles','upload',{id:'claude'}]
  ]);
  assert.equal(calls[7][2].patch,patch,'update forwards the supplied patch without changing it');

  const workbenchUpdates=[],roleUpdates=[],otherRoleUpdates=[];
  const stopWorkbench=bridge.subscribe(value=>workbenchUpdates.push(value));
  const stopRoles=roles.subscribe(value=>roleUpdates.push(value));
  const stopOtherRoles=roles.subscribe(value=>otherRoleUpdates.push(value));
  assert.deepEqual([...listeners.keys()].sort(),['workbench:roles-state','workbench:state']);
  assert.equal(listeners.get('workbench:state').size,1);assert.equal(listeners.get('workbench:roles-state').size,2);
  const emit=(event,state)=>{for(const listener of [...(listeners.get(event)||[])])listener({sender:'private-native-event'},state);};
  const workbenchState={avatar:'safe'},roleState={activeId:'bigfish',roles:[{id:'yui',enabled:false}]};
  emit('workbench:state',workbenchState);
  assert.deepEqual(workbenchUpdates,[workbenchState]);assert.deepEqual(roleUpdates,[]);assert.deepEqual(otherRoleUpdates,[]);
  emit('workbench:roles-state',roleState);
  assert.deepEqual(workbenchUpdates,[workbenchState]);assert.deepEqual(roleUpdates,[roleState]);assert.deepEqual(otherRoleUpdates,[roleState]);
  stopWorkbench();stopWorkbench();
  assert(!listeners.has('workbench:state'));assert.equal(listeners.get('workbench:roles-state').size,2);
  emit('workbench:state',{avatar:'must-not-arrive'});emit('workbench:roles-state',roleState);
  assert.equal(workbenchUpdates.length,1);assert.equal(roleUpdates.length,2);assert.equal(otherRoleUpdates.length,2);
  stopRoles();stopRoles();
  assert.equal(listeners.get('workbench:roles-state').size,1);
  emit('workbench:roles-state',roleState);
  assert.equal(roleUpdates.length,2);assert.equal(otherRoleUpdates.length,3);
  stopOtherRoles();assert.equal(listeners.size,0);
  emit('workbench:roles-state',roleState);assert.equal(otherRoleUpdates.length,3);
  assert.equal(calls.length,recorded.length,'subscriptions must not invoke either command channel');
  const communityRequest={action:'open',bounds:{x:300,y:80,width:800,height:650}};
  bridge.community(communityRequest);
  assert.deepEqual(calls.at(-1),['workbench:community',communityRequest]);
  assert.equal(calls.length,recorded.length+1,'community uses its dedicated channel rather than a generic action');
  bridge.communityAccount('connect');assert.deepEqual(calls.at(-1),['workbench:community-account','connect']);
  bridge.communityAccount('cancel');assert.deepEqual(calls.at(-1),['workbench:community-account','cancel']);
  const dividerRequest={action:'place',id:'chat',rect:{x:300,y:0,width:12,height:600}};
  bridge.divider(dividerRequest);assert.deepEqual(calls.at(-1),['workbench:divider',dividerRequest]);
  const dividerEvents=[];const stopDivider=bridge.subscribeDivider(value=>dividerEvents.push(value));
  const dividerEvent={id:'chat',type:'move',x:300};emit('workbench:divider-event',dividerEvent);assert.deepEqual(dividerEvents,[dividerEvent]);
  stopDivider();stopDivider();assert(!listeners.has('workbench:divider-event'));emit('workbench:divider-event',dividerEvent);assert.equal(dividerEvents.length,1);
  assert.throws(()=>bridge.subscribeDivider(null));
  const communityAccounts=[];const stopCommunityAccount=bridge.subscribeCommunityAccount(value=>communityAccounts.push(value));
  const communityAccountState={status:'checking',message:'正在检查桌面社区连接…'};
  emit('workbench:community-account-state',communityAccountState);assert.deepEqual(communityAccounts,[communityAccountState]);
  stopCommunityAccount();stopCommunityAccount();assert(!listeners.has('workbench:community-account-state'));
  emit('workbench:community-account-state',communityAccountState);assert.equal(communityAccounts.length,1);
  assert.throws(()=>bridge.subscribeCommunityAccount(null));
  bridge.screenShare('hide');assert.deepEqual(calls.at(-1),['workbench:screen-share','hide']);
  const countBeforeInvalidScreenShare=calls.length;
  await assert.rejects(bridge.screenShare('show'),/未知屏幕操作/);
  assert.equal(calls.length,countBeforeInvalidScreenShare,'unknown screen actions must not reach IPC');
  bridge.fish('pause');assert.deepEqual(calls.at(-1),['workbench:call','fish','pause']);
  bridge.qqbot('status');assert.deepEqual(calls.at(-1),['workbench:call','qqbot','status']);
  bridge.getAccounts({includeQuota:true,force:'yes',command:'arbitrary',path:'/private'});
  assert.deepEqual(JSON.parse(JSON.stringify(calls.at(-1))),['workbench:call','accounts',{includeQuota:true,force:false}],'account bridge only forwards boolean read options');
  bridge.getAccounts();assert.deepEqual(JSON.parse(JSON.stringify(calls.at(-1))),['workbench:call','accounts',{includeQuota:false,force:false}]);
  const fishQqRequest={action:'select',selection:{fish:false,qqbot:true}};
  bridge.fishQq(fishQqRequest);assert.deepEqual(calls.at(-1),['workbench:call','fish-qq',fishQqRequest]);
  const workspaceRequest={action:'state'};
  bridge.workspace(workspaceRequest);assert.deepEqual(calls.at(-1),['workbench:call','workspace',workspaceRequest]);
  const companionRequest={action:'state'};
  bridge.companion(companionRequest);assert.deepEqual(calls.at(-1),['workbench:call','companion',companionRequest]);
  const officeUpdates=[];const stopOffice=bridge.subscribeOffice(value=>officeUpdates.push(value));
  const officeState={active:true};emit('workbench:office-state',officeState);assert.deepEqual(officeUpdates,[officeState]);
  stopOffice();emit('workbench:office-state',{active:false});assert.equal(officeUpdates.length,1);
  for(const invalid of ['start','frame','settings','sources'])await assert.rejects(bridge.screenShare(invalid),/未知屏幕操作/);
  assert.equal('invoke' in bridge,false);assert.equal('openURL' in bridge,false);
  console.log('ok: avatar persistence and malformed-state recovery; frozen workbench/role bridge methods, exact IPC channels and payloads; isolated subscriptions cancel independently');
}finally{fs.rmSync(folder,{recursive:true,force:true});}
}
run().catch(error=>{console.error(error);process.exitCode=1;});
