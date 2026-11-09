'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {createStoryPrototypeLauncher}=require('../../apps/neko-workbench/story-prototype-launcher.cjs');

test('starts only the designated local project, keeps bridge token out of result, and stops it',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'neko-story-test-'));
  fs.writeFileSync(path.join(root,'server.js'),"if(!process.env.NEKO_AI_BRIDGE_TOKEN)process.exit(1); console.log('127.0.0.1:8787（仅本机'); setInterval(()=>{},1000); process.on('SIGTERM',()=>process.exit(0));");
  const token='a'.repeat(64);let stops=0;
  const relay={stop:async()=>{stops++;},start:async()=>({status:'started',token,baseUrl:'http://127.0.0.1:1234/v1',model:'fixture',label:'fixture'})};
  const launcher=createStoryPrototypeLauncher({projectDir:root,executable:process.execPath,relay});
  t.after(async()=>{await launcher.stop();fs.rmSync(root,{recursive:true,force:true});});
  const result=await launcher.start();
  assert.deepEqual(result,{status:'started',origin:'http://127.0.0.1:8787'});
  assert(!JSON.stringify(result).includes(token));
  assert.equal((await launcher.start()).status,'running');
  await launcher.stop();assert(stops>=2);
});

test('the one-click path creates and binds one local story room, then reopens it',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'neko-story-open-'));
  fs.writeFileSync(path.join(root,'server.js'),"console.log('127.0.0.1:8787（仅本机'); setInterval(()=>{},1000);");
  const origin='http://127.0.0.1:8787',roomId='r-0123abcd',url=origin+'/room/'+roomId+'?token=white-fixture';
  let bound=null,creates=0;const opened=[];
  const relay={
    stop:async()=>{bound=null;},
    start:async()=>({status:'started',token:'bridge-fixture',baseUrl:origin,model:'fixture',label:'fixture'}),
    status:()=>({status:'running',bound:!!bound,roomId:bound}),
    bind:async({roomId:id,prototypeOrigin})=>{assert.equal(prototypeOrigin,origin);bound=id;return {status:'bound'};},
  };
  const launcher=createStoryPrototypeLauncher({projectDir:root,executable:process.execPath,relay,fetchImpl:async(path,options)=>{
    creates++;assert.equal(path,origin+'/api/rooms');assert.equal(options.redirect,'error');
    assert.equal(JSON.parse(options.body).scenario,'story-v1');
    return Response.json({ok:true,roomId,links:{white:url,black:'black-fixture',goddess:'goddess-fixture'}});
  }});
  t.after(async()=>{await launcher.stop();fs.rmSync(root,{recursive:true,force:true});});
  const open=async link=>{assert.equal(bound,roomId);opened.push(link);};
  for(let n=0;n<2;n++)assert.deepEqual(await launcher.openRoom(open),{status:'opened',roomId});
  assert.equal(creates,1);assert.deepEqual(opened,[url,url]);
});

test('unconfigured or relative project directories never start the relay', async () => {
  const relay = {
    status: () => ({status:'idle'}),
    start: () => assert.fail('the relay must not start'),
    stop: () => assert.fail('the relay must not be touched'),
  };
  for (const projectDir of [undefined, '.']) {
    const launcher = createStoryPrototypeLauncher({projectDir, executable:process.execPath, relay});
    assert.deepEqual(await launcher.start(), {status:'missing-project'});
    assert.deepEqual(await launcher.openRoom(() => assert.fail('the browser must not open')), {status:'missing-project'});
  }
});
