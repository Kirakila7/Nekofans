'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {writeAtomicStateFileSync} = require('../../apps/neko-workbench/atomic-state-file.cjs');

function fixture({renameError,failures=0}={}) {
  const target=path.resolve('fixture/state.json'),files=new Map([[target,'previous state']]),descriptors=new Map();
  const calls={open:[],sync:[],close:[],rename:[],unlink:[],wait:[]};let sequence=0;
  const io={
    openSync(file,flag,mode){calls.open.push({file,flag,mode});if(files.has(file))throw Object.assign(Error('exists'),{code:'EEXIST'});files.set(file,'');const fd=++sequence;descriptors.set(fd,file);return fd;},
    writeFileSync(fd,text,encoding){assert.equal(encoding,'utf8');files.set(descriptors.get(fd),text);},
    fsyncSync(fd){assert(descriptors.has(fd));calls.sync.push(fd);},
    closeSync(fd){assert(descriptors.has(fd));descriptors.delete(fd);calls.close.push(fd);},
    renameSync(from,to){assert.equal(descriptors.size,0,'the temporary descriptor must close before replacement');calls.rename.push([from,to]);if(calls.rename.length<=failures)throw renameError;files.set(to,files.get(from));files.delete(from);},
    unlinkSync(file){assert.notEqual(file,target,'the existing state is never a cleanup target');calls.unlink.push(file);if(!files.delete(file))throw Object.assign(Error('missing'),{code:'ENOENT'});},
  };
  const pause=milliseconds=>{assert.equal(files.get(target),'previous state','the old target remains readable during retries');calls.wait.push(milliseconds);};
  return {target,files,descriptors,calls,io,write:(text='new state',options={})=>writeAtomicStateFileSync(target,text,{io,platform:'win32',pause,...options})};
}

for(const code of ['EPERM','EACCES','EBUSY'])test('Windows state replacement retries transient '+code+' without truncating the old state',()=>{
  const f=fixture({renameError:Object.assign(Error('synthetic contention'),{code}),failures:2});f.write();
  assert.equal(f.files.get(f.target),'new state');assert.equal(f.calls.rename.length,3);assert.deepEqual(f.calls.wait,[25,50]);assert.equal(f.calls.open.length,1);assert.equal(f.calls.open[0].flag,'wx');assert.equal(f.calls.open[0].mode,0o600);assert.equal(f.calls.sync.length,1);assert.equal(f.calls.close.length,1);assert.deepEqual([...f.files.keys()],[f.target]);
});

test('persistent contention stops after five attempts and preserves the old state and original error',()=>{
  const error=Object.assign(Error('synthetic held target'),{code:'EPERM'}),f=fixture({renameError:error,failures:Infinity});
  assert.throws(()=>f.write(),thrown=>thrown===error);assert.equal(f.calls.rename.length,5);assert.deepEqual(f.calls.wait,[25,50,100,200]);assert.equal(f.files.get(f.target),'previous state');assert.deepEqual([...f.files.keys()],[f.target]);assert.equal(f.descriptors.size,0);
});

for(const [platform,code] of [['win32','ENOSPC'],['darwin','EPERM']])test(platform+' '+code+' is not retried or hidden',()=>{
  const error=Object.assign(Error('synthetic permanent failure'),{code}),f=fixture({renameError:error,failures:Infinity});assert.throws(()=>f.write('new state',{platform}),thrown=>thrown===error);assert.equal(f.calls.rename.length,1);assert.deepEqual(f.calls.wait,[]);assert.equal(f.files.get(f.target),'previous state');assert.deepEqual([...f.files.keys()],[f.target]);
});

for(const operation of ['writeFileSync','fsyncSync','closeSync'])test(operation+' failure cleans only this temporary file and never publishes a partial state',()=>{
  const f=fixture(),error=Object.assign(Error('synthetic temporary-file failure'),{code:'EIO'}),original=f.io[operation];let failed=false;
  f.io[operation]=(...args)=>{if(!failed){failed=true;throw error;}return original(...args);};
  assert.throws(()=>f.write(),thrown=>thrown===error);assert.equal(f.files.get(f.target),'previous state');assert.deepEqual([...f.files.keys()],[f.target]);assert.equal(f.calls.rename.length,0);assert.equal(f.descriptors.size,0);assert.deepEqual(f.calls.wait,[]);
});

test('an exclusive-create collision never deletes a temporary file owned by another writer',()=>{
  const f=fixture();let collision;
  f.io.openSync=file=>{collision=file;f.files.set(file,'another writer');throw Object.assign(Error('collision'),{code:'EEXIST'});};
  assert.throws(()=>f.write(),{code:'EEXIST'});assert.equal(f.files.get(collision),'another writer');assert.equal(f.files.get(f.target),'previous state');assert.deepEqual(f.calls.unlink,[]);assert.deepEqual(f.calls.rename,[]);
});

test('separate saves use distinct owned temporaries and leave old fixed-name recovery files intact',()=>{
  const f=fixture(),legacy=f.target+'.tmp';f.files.set(legacy,'old recovery copy');f.write('first');f.write('second');assert.notEqual(f.calls.open[0].file,f.calls.open[1].file);assert(f.calls.open.every(row=>path.dirname(row.file)===path.dirname(f.target)));assert.equal(f.files.get(f.target),'second');assert.equal(f.files.get(legacy),'old recovery copy');assert(!f.calls.unlink.includes(legacy));
});

test('invalid state paths and non-text input fail before any filesystem operation',()=>{
  const f=fixture();assert.throws(()=>writeAtomicStateFileSync('relative.json','text',{io:f.io}),TypeError);assert.throws(()=>writeAtomicStateFileSync(f.target,Buffer.from('text'),{io:f.io}),TypeError);assert.deepEqual(f.calls.open,[]);
});
