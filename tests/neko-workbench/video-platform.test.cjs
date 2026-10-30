'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {createVideoPlatform}=require('../../apps/neko-workbench/video-platform.cjs');
test('video platform preference is validated and survives restart',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'neko-video-platform-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const file=path.join(dir,'platform.json'),store=createVideoPlatform(file);
 assert.deepEqual(store.get(),{platform:'bilibili'});assert.deepEqual(store.set('youtube'),{platform:'youtube'});assert.deepEqual(createVideoPlatform(file).get(),{platform:'youtube'});
 for(const bad of ['youtube.com','',null,{},'community'])assert.throws(()=>store.set(bad),/无效/);assert.deepEqual(store.get(),{platform:'youtube'});assert.deepEqual(createVideoPlatform(file).get(),{platform:'youtube'});
});
test('failed save preserves the prior selection and cleans temporary data',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'neko-video-platform-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const file=path.join(dir,'platform.json'),store=createVideoPlatform(file);store.set('youtube');const rename=fs.renameSync;
 try{fs.renameSync=()=>{const e=Error('no space');e.code='ENOSPC';throw e;};assert.throws(()=>store.set('bilibili'),{code:'ENOSPC'});}finally{fs.renameSync=rename;}
 assert.deepEqual(store.get(),{platform:'youtube'});assert.deepEqual(createVideoPlatform(file).get(),{platform:'youtube'});assert.deepEqual(fs.readdirSync(dir),['platform.json']);
});
