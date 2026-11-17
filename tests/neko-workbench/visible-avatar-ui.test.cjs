'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {patchVisibleAvatarUi}=require('../../apps/neko-workbench/embedded-dsh/visible-avatar-ui-patch.cjs');
const file=path.resolve(__dirname,'../../apps/neko-workbench/embedded-dsh/b0-skin/packages/dsh-client-ui-white-label/lib/client.js');

test('avatar presentation restores Claude only in office, keeps retired role entries hidden and preserves saved choices',()=>{
 const raw=fs.readFileSync(file,'utf8'),code=patchVisibleAvatarUi(raw+'\n// Native supplier model: claude-sonnet-fixture\n');
 assert.equal(patchVisibleAvatarUi(code),code);assert(code.includes('// Native supplier model: claude-sonnet-fixture'));
 let entry;vm.runInNewContext(code,{window:{__ModuleLoader__:{load:value=>entry=value}},console});
 const api=entry.factory(name=>name==='react'?{createElement(){}}:{createPortal(){}});
 assert.deepEqual(Array.from(api.AVATARS,a=>a.id),['yui','devcat','bigfish','gemini']);
 const legacy={avatar:{builtinId:'claude'}},before=JSON.stringify(legacy);
 assert.equal(api.sanitizeState(legacy).avatar.builtinId,'claude');assert.equal(JSON.stringify(legacy),before,'presentation never edits source data');
 const roles=api.sanitizeRoles({roles:[{id:'bigfish',name:'我的鱼',avatarId:'claude'}]});
 assert.equal(roles.roles.find(role=>role.id==='bigfish').avatarId,'claude','retained role editor data does not silently migrate');
 assert(roles.roles.some(role=>role.id==='claude'),'compatibility state retains the old role');
 assert.match(code,/snap\.state\.roles\.filter\(\(role\) => role\.id !== 'claude'\)\.map/);
 for(const name of ['builtinSrc','avatarName']){
  const body=code.slice(code.indexOf('function '+name+'(id)'),code.indexOf('\n    }',code.indexOf('function '+name+'(id)'))+6);
  let office=false;
  const fn=vm.runInNewContext('('+body+')',{AVATAR_ART:{bigfish:'fallback-fish',claude:'office-claude-art'},PLACEHOLDERS:{},DEFAULT_AVATAR:'yui',CUSTOM_NAME:'自定义',AVATARS:api.AVATARS,nekoOfficeEdition:()=>office,visibleAvatars:()=>office?[...api.AVATARS,{id:'claude',name:'Claude娘'}]:api.AVATARS});
  assert.equal(fn('claude'),name==='builtinSrc'?'fallback-fish':'大肥鱼');
  office=true;
  assert.equal(fn('claude'),name==='builtinSrc'?'office-claude-art':'Claude娘');
  office=false;
  assert.equal(fn('claude'),name==='builtinSrc'?'fallback-fish':'大肥鱼','returning to daily restores the daily presentation');
 }
});
