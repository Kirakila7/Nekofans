'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {patchVisibleAvatarUi}=require('../../apps/neko-workbench/embedded-dsh/visible-avatar-ui-patch.cjs');
const file=path.resolve(__dirname,'../../apps/neko-workbench/embedded-dsh/b0-skin/packages/dsh-client-ui-white-label/lib/client.js');

test('avatar presentation shows all five portraits and preserves saved choices',()=>{
 const raw=fs.readFileSync(file,'utf8'),code=patchVisibleAvatarUi(raw+'\n// Native supplier model: claude-sonnet-fixture\n');
 assert.equal(patchVisibleAvatarUi(code),code);assert(code.includes('// Native supplier model: claude-sonnet-fixture'));
 let entry;vm.runInNewContext(code,{window:{__ModuleLoader__:{load:value=>entry=value}},console});
 const api=entry.factory(name=>name==='react'?{createElement(){}}:{createPortal(){}});
 assert.deepEqual(Array.from(api.AVATARS,a=>a.id),['yui','devcat','bigfish','claude','gemini']);
 const legacy={avatar:{builtinId:'claude'}},before=JSON.stringify(legacy);
 assert.equal(api.sanitizeState(legacy).avatar.builtinId,'claude');assert.equal(JSON.stringify(legacy),before,'presentation never edits source data');
 const roles=api.sanitizeRoles({roles:[{id:'bigfish',name:'我的鱼',avatarId:'claude'}]});
 assert.equal(roles.roles.find(role=>role.id==='bigfish').avatarId,'claude','retained role editor data does not silently migrate');
 assert(roles.roles.some(role=>role.id==='claude'),'compatibility state retains the old role');
 assert.match(code,/snap\.state\.roles\.map/);
 assert.match(code,/function visibleAvatars\(\) \{ return AVATARS \}/);
 for(const name of ['builtinSrc','avatarName']){
  const start=code.indexOf('function '+name+'(');
  assert(start>=0,'avatar presentation function is present');
  const body=code.slice(start,code.indexOf('\n    }',start)+6);
  const fn=vm.runInNewContext('('+body+')',{AVATAR_ART:{claude:'claude-art'},PLACEHOLDERS:{},DEFAULT_AVATAR:'yui',CUSTOM_NAME:'自定义',AVATARS:api.AVATARS,visibleAvatars:()=>api.AVATARS});
  assert.equal(fn('claude'),name==='builtinSrc'?'claude-art':'Claude娘');
 }
});
