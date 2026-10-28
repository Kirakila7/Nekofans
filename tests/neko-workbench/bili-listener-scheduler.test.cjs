'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {pathToFileURL}=require('node:url');

test('DM, comments and live deliveries install and retain the read-only guard through their own turn',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'bili-listener-qa-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const home=path.join(root,'home'),data=path.join(root,'data'),tools=path.join(root,'tools');
  fs.mkdirSync(path.join(home,'.bili-ai'),{recursive:true});fs.mkdirSync(data,{recursive:true});fs.mkdirSync(path.join(tools,'commands'),{recursive:true});
  fs.writeFileSync(path.join(home,'.bili-ai','credentials.json'),JSON.stringify({sessdata:'fixture',bili_jct:'fixture',buvid3:'fixture'}));
  fs.writeFileSync(path.join(data,'whale-listen.json'),JSON.stringify({lastSeen:Math.floor(Date.now()/1000)-60}));
  const config=path.join(data,'bili-whale.config.json');
  fs.writeFileSync(config,JSON.stringify({workbench:{allowExternalWrites:false},owner:{mid:'1'},listen:{dm:true,comment:true,allDay:true,scope:'reply',live:true,liveRoom:'1'}}));
  const bili=path.join(tools,'bili.mjs');
  fs.writeFileSync(bili,"if(process.argv.includes('--ack'))console.log('ack');else console.log(JSON.stringify({hit:true,receipt:'fixture',name:'owner',mid:'1',text:'hello'}));");
  fs.writeFileSync(path.join(tools,'commands','danmaku-await.mjs'),"console.log('AWAIT_HIT fixture');");
  const keys=['BILI_WHALE_HOME','BILI_WHALE_CONFIG','BILI_WHALE_DSH_HOME','DSH_NODE','BILI_TRAFFIC_TEST'];
  const before=Object.fromEntries(keys.map(k=>[k,process.env[k]]));
  Object.assign(process.env,{BILI_WHALE_HOME:home,BILI_WHALE_CONFIG:config,BILI_WHALE_DSH_HOME:data,DSH_NODE:process.execPath,BILI_TRAFFIC_TEST:'1'});
  t.after(()=>{for(const k of keys){if(before[k]===undefined)delete process.env[k];else process.env[k]=before[k]}});
  const priorFetch=globalThis.fetch;
  globalThis.fetch=async()=>({text:async()=>JSON.stringify({code:0,data:{items:[{id:'1',reply_time:Math.floor(Date.now()/1000),user:{nickname:'fixture',mid:'1'},item:{business_id:1,subject_id:'1',root_id:'1',source_id:'1'}}]}})});
  t.after(()=>{globalThis.fetch=priorFetch});
  const {startScheduler}=await import(pathToFileURL(path.resolve(__dirname,'../../apps/neko-workbench/vendor/dsh-bili-whale/lib/scheduler.js')));
  let guard,active,turn=0,disposed=0;const events=new Map(),delivered=[];
  const agent={ctx:{inject(_names,install){
    const value={dispose:async()=>{guard=null;disposed++}};const fiber=Promise.resolve(value);fiber.state=2;fiber.dispose=value.dispose;
    install({tools:{guard(fn){guard=fn}}});return fiber;
  }},cancel(){}};
  const ctx={get(name){if(name==='agents')return {get:()=>agent}},on(name,fn){events.set(name,fn);return()=>events.delete(name)},sessionController:{
    async resolveAgent(){return {agent}},async selectModel(){},async prompt(request){
      assert.equal(typeof guard,'function');
      const id=++turn;active=id;
      const emit=events.get('session/event');
      emit({header:{id:'fixture-session'}},{type:'turn/start',data:{turn:id}});
      emit({header:{id:'fixture-session'}},{type:'user/message',data:{turn:id,source:{rpcId:request.requestId}}});
      delivered.push({request,guard});
    }
  }};
  const scheduler=startScheduler(ctx,{dshHome:data,cwd:root,biliMjs:bili,sessionId:'fixture-session',route:{provider:'fixture',model:'fixture'}});
  t.after(()=>scheduler.stop());
  const check=async(kind,expected)=>{
    const entry=delivered.at(-1);assert.ok(entry.request.requestId.startsWith(expected));
    assert.match(entry.guard({name:'bash',arguments:{command:'node bili.mjs --go'}}),/只读/);
    assert.doesNotMatch(entry.request.content[0].text,/node bili\.mjs [^\n]*--go/);
    // An older turn ending must not release the current guard.
    const emit=events.get('session/event');emit({header:{id:'fixture-session'}},{type:'turn/end',data:{turn:active-1}});
    assert.equal(typeof guard,'function',`${kind} guard was released by another turn`);
    emit({header:{id:'fixture-session'}},{type:'turn/end',data:{turn:active}});
    await new Promise(resolve=>setImmediate(resolve));assert.equal(guard,null);
  };
  await scheduler.dmTick();assert.equal(delivered.length,1);await check('dm','bili-whale-dm-');
  await scheduler.listenTick();assert.equal(delivered.length,2);await check('comment','bili-whale-listen-');
  await scheduler.liveTick();
  for(let i=0;i<100&&delivered.length<3;i++)await new Promise(resolve=>setTimeout(resolve,20));
  assert.equal(delivered.length,3);await check('live','bili-whale-live-');
  assert.equal(disposed,3);
});
