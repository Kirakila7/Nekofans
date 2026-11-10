'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {installApplication,assertAppsStopped}=require('../../scripts/install-neko-daily.cjs');

function fixture(t){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'neko-install-rename-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const source=path.join(root,'incoming','Nekofans.app'),target=path.join(root,'Applications','Nekofans.app'),legacy=path.join(root,'Applications','N.E.K.O.工作台试用.app');
  function app(dir,value='old',id='cn.neko.workbench.trial'){fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,'payload'),value);fs.writeFileSync(path.join(dir,'id'),id);}
  function identify(dir,id){if(fs.readFileSync(path.join(dir,'id'),'utf8')!==id)throw Error('identity mismatch');}
  app(source,'new');
  const options={source,target,legacy,expectedId:'cn.neko.workbench.trial',verify:()=>{},checkStopped:()=>{},identify,makeId:()=>'test-id'};
  return {root,source,target,legacy,app,options,read:dir=>fs.readFileSync(path.join(dir,'payload'),'utf8')};
}
test('renaming old daily app keeps an exact recoverable backup and user data',t=>{
  const f=fixture(t);f.app(f.legacy);const data=path.join(f.root,'user-data');fs.writeFileSync(data,'existing session');
  const result=installApplication(f.options);
  assert.equal(f.read(f.target),'new');assert.equal(f.read(result.backup),'old');assert.equal(fs.existsSync(f.legacy),false);assert.equal(fs.readFileSync(data,'utf8'),'existing session');
});
test('both names existing is refused before either application changes',t=>{
  const f=fixture(t);f.app(f.legacy);f.app(f.target,'other');
  assert.throws(()=>installApplication(f.options),/同时存在/);assert.equal(f.read(f.legacy),'old');assert.equal(f.read(f.target),'other');
});
test('invalid candidate signature and mismatched existing bundle preserve the old application',t=>{
  const f=fixture(t);f.app(f.legacy);
  assert.throws(()=>installApplication({...f.options,verify:()=>{throw Error('signature invalid');}}),/signature invalid/);
  assert.equal(f.read(f.legacy),'old');assert.equal(fs.existsSync(f.target),false);
  fs.writeFileSync(path.join(f.legacy,'id'),'unrelated');assert.throws(()=>installApplication(f.options),/identity mismatch/);assert.equal(f.read(f.legacy),'old');
});
test('a post-install preparation failure restores the old application',t=>{
  const f=fixture(t);f.app(f.legacy);
  assert.throws(()=>installApplication({...f.options,afterCommit:()=>{throw Error('prepare failed');}}),/prepare failed/);
  assert.equal(f.read(f.legacy),'old');assert.equal(fs.existsSync(f.target),false);
});
test('a failed promotion restores the old application',t=>{
  const f=fixture(t);f.app(f.legacy);const rename=fs.renameSync;
  try{
    fs.renameSync=(from,to)=>{if(from===f.target+'.installing-test-id')throw Error('promotion failed');return rename(from,to);};
    assert.throws(()=>installApplication(f.options),/promotion failed/);
  }finally{fs.renameSync=rename;}
  assert.equal(f.read(f.legacy),'old');assert.equal(fs.existsSync(f.target),false);
});
test('application appearing during verification is not overwritten',t=>{
  const f=fixture(t);f.app(f.legacy);
  assert.throws(()=>installApplication({...f.options,verify:()=>f.app(f.target,'arrived')}),/状态发生变化/);
  assert.equal(f.read(f.legacy),'old');assert.equal(f.read(f.target),'arrived');
});
test('process check refuses either old or new app including helper processes',()=>{
  const paths=['/home/Applications/Nekofans.app','/home/Applications/N.E.K.O.工作台试用.app'];
  for(const app of paths)assert.throws(()=>assertAppsStopped(paths,()=>({status:0,stdout:app+'/Contents/MacOS/Electron --some-flag\n'})),/退出/);
  assert.doesNotThrow(()=>assertAppsStopped(paths,()=>({status:0,stdout:'/another/app/Contents/MacOS/Electron\n'})));
  assert.throws(()=>assertAppsStopped(paths,()=>({status:1,stdout:''})),/无法检查/);
});
