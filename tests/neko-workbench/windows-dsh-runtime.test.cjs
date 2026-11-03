'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),path=require('node:path');
const {resolveWindowsDsh}=require('../../apps/neko-workbench/windows-dsh-runtime.cjs');
const options={resourcesPath:path.resolve('fixture/resources'),homeDir:path.resolve('fixture/home'),programFiles:path.resolve('fixture/programs')};
test('complete embedded DSH is preferred without probing a separate installation',()=>{
  const bundled=path.join(options.resourcesPath,'dsh'),calls=[];
  const result=resolveWindowsDsh({...options,bundledOnly:true,exists:file=>{calls.push(file);assert(file.startsWith(bundled+path.sep));return true;}});
  assert.deepEqual(result,{resources:bundled,bundled:true});assert.equal(calls.length,3);
});
test('bundled-only builds reject an incomplete payload without using installed DSH',()=>{
  const bundled=path.join(options.resourcesPath,'dsh');
  const result=resolveWindowsDsh({...options,bundledOnly:true,exists:file=>{assert(file.startsWith(bundled+path.sep));return !file.endsWith(path.join('runtime','primary-runtime'));}});
  assert.equal(result,null);
});
test('legacy non-bundled builds retain explicit external installation selection',()=>{
  const install=path.resolve('fixture/explicit'),resources=path.join(install,'resources');
  assert.deepEqual(resolveWindowsDsh({...options,explicitInstall:install,exists:file=>file===path.join(resources,'app.asar')}),{resources,bundled:false});
});
