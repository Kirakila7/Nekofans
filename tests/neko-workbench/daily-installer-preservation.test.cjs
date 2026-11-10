'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {ensureMemoryEnvironment,ensureProjectLink}=require('../../scripts/install-neko-daily.cjs');
test('installer leaves an existing project binding untouched',t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'neko-install-binding-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const file=path.join(dir,'workbench-project.json'),original='{"root":"/my/real/project","custom":true}\n';fs.writeFileSync(file,original);
  let queried=false;const result=ensureProjectLink({data:dir,projectRoot:'/unrelated',repository:'owner/repo',query(){queried=true;throw Error('must not run');}});
  assert.equal(result,false);assert.equal(queried,false);assert.equal(fs.readFileSync(file,'utf8'),original);
});
test('installer creates only a missing binding to an explicitly verified repository',t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'neko-install-link-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const project=path.join(dir,'project'),data=path.join(dir,'data');fs.mkdirSync(project);fs.mkdirSync(path.join(project,'.git'));fs.mkdirSync(data);
  const result=ensureProjectLink({data,projectRoot:project,repository:'owner/repo',query:()=>({status:0,stdout:'https://github.com/owner/repo.git\n'})});
  assert.equal(result,true);assert.equal(JSON.parse(fs.readFileSync(path.join(data,'workbench-project.json'),'utf8')).root,project);
});
test('existing functional memory runtime is not modified or reinstalled',t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'neko-install-runtime-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  fs.mkdirSync(path.join(dir,'bin'));fs.writeFileSync(path.join(dir,'bin/python'),'existing runtime');
  const calls=[];ensureMemoryEnvironment({environment:dir,project:'/fixture',env:{},probe:()=>({status:0}),execute:(...args)=>calls.push(args)});
  assert.deepEqual(calls,[]);assert.equal(fs.readFileSync(path.join(dir,'bin/python'),'utf8'),'existing runtime');
});
test('missing memory runtime is prepared and checked',()=>{
  const calls=[];ensureMemoryEnvironment({environment:'/fixture/not-present',project:'/fixture/project',env:{},execute:(...args)=>calls.push(args)});
  assert.equal(calls.length,2);assert.equal(calls[0][0],'uv');assert.equal(calls[1][0],'/fixture/not-present/bin/python');
});
