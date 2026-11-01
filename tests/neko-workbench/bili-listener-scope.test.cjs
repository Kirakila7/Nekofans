'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const {pathToFileURL}=require('node:url');

test('listener guard blocks shell and other files until writes are explicitly enabled, including revocation mid-turn',async t=>{
  const {createListeningScope}=await import(pathToFileURL(path.resolve(__dirname,'../../apps/neko-workbench/vendor/dsh-bili-whale/lib/read-scope.js')));
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fish-listener-scope-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const diary=path.join(dir,'diary.md'), outside=path.join(dir,'outside.txt');
  fs.writeFileSync(diary,'diary');
  let current=false,guard,disposed=false;
  const agent={ctx:{inject(names,install){
    assert.deepEqual(names,['tools']);
    const readyScope={state:2,dispose:async()=>{disposed=true}};
    const fiber=Promise.resolve(readyScope);fiber.state=2;fiber.dispose=readyScope.dispose;
    install({tools:{guard(fn){guard=fn}}});return fiber;
  }}};
  const scope=await createListeningScope(agent,{cwd:dir,files:[diary],isWriteAllowed:()=>current});
  assert.match(guard({name:'bash',arguments:{command:'env -u BILI_WHALE_CONFIG node bili.mjs comment --go'}}),/只读/);
  assert.match(guard({name:'write',arguments:{file_path:outside,content:'no'}}),/不允许/);
  assert.equal(guard({name:'read',arguments:{file_path:diary}}),undefined);
  assert.equal(guard({name:'write',arguments:{file_path:diary}}),undefined);
  current=true;
  assert.equal(guard({name:'bash',arguments:{command:'allowed after explicit opt-in'}}),undefined);
  current=false;
  assert.match(guard({name:'bash',arguments:{command:'blocked after revocation'}}),/只读/);
  current=undefined;
  assert.match(guard({name:'bash',arguments:{}}),/只读/);
  current='true';
  assert.match(guard({name:'bash',arguments:{}}),/只读/);
  fs.unlinkSync(diary);
  // A directory junction exercises link rejection without Windows symlink privileges.
  if(process.platform==='win32'){fs.mkdirSync(outside);fs.symlinkSync(outside,diary,'junction');}
  else fs.symlinkSync(outside,diary);
  assert.match(guard({name:'write',arguments:{file_path:diary}}),/链接/);
  await scope.dispose();assert.equal(disposed,true);
});

test('listener guard fails closed when tool protection cannot be installed',async()=>{
  const {createListeningScope}=await import(pathToFileURL(path.resolve(__dirname,'../../apps/neko-workbench/vendor/dsh-bili-whale/lib/read-scope.js')));
  await assert.rejects(createListeningScope(null,{cwd:'/tmp',files:[],isWriteAllowed:()=>false}),/隔离不可用/);
  const agent={ctx:{inject(_names,install){const fiber=Promise.resolve();fiber.state=2;fiber.dispose=async()=>{};install({tools:{}});return fiber}}};
  await assert.rejects(createListeningScope(agent,{cwd:'/tmp',files:[],isWriteAllowed:()=>false}),/隔离不可用/);
});
