'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {createCommunityDaily,interactions,dayOf}=require('../../apps/neko-workbench/community-daily.cjs');
const A='11111111-1111-4111-8111-111111111111';
function fixture(t,extra={}){
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'neko-public-daily-')),posts=[],inputs=[],instances=[];
 const f={directory,posts,inputs,time:Date.parse('2026-11-04T12:10:00Z'),identity:{userId:A,epoch:1},busy:false};
 f.rows=[{role:'user',text:'今天给小窝添了一个玩偶',createdAt:f.time},{role:'assistant',text:'好开心，想把玩偶摆在窗边',createdAt:f.time}];
 f.create=()=>{const daily=createCommunityDaily({dataDir:directory,now:()=>f.time,getIdentity:()=>f.identity,isBusy:()=>f.busy,getInteractions:async()=>f.rows,generate:async(rows)=>{inputs.push(rows);return '今天和主人一起给小窝添了玩偶，好开心。大肥鱼 · AI日常';},publish:async request=>{request.assertCurrent();posts.push(request);return {id:'post-fixture'};},...extra});instances.push(daily);return daily;};
 f.daily=f.create();f.file=path.join(directory,'community-daily.json');
 t.after(()=>{instances.forEach(d=>d.dispose());fs.rmSync(directory,{recursive:true,force:true});});return f;
}
test('default off; enabling binds a connected account without immediately publishing',async t=>{
 const f=fixture(t);await f.daily.tick({force:true});assert.equal(f.inputs.length,0);assert.equal(f.daily.status().enabled,false);
 f.identity=null;assert.throws(()=>f.daily.configure(true),/登录/);f.identity={userId:A,epoch:1};f.daily.configure(true);assert.equal(f.posts.length,0);
});
test('Shanghai day filter excludes old/system/proactive/secret turns and bounds material',()=>{
 const now=Date.parse('2026-11-04T00:00:00+08:00');assert.equal(dayOf(now),'2026-11-04');
 const rows=[{role:'user',text:'昨天',time:now-1},{role:'system',text:'system',time:now},{role:'assistant',text:'主动',time:now,proactive:true},
  {role:'user',text:'password: synthetic',time:now},{role:'user',text:'联系 test@example.test',time:now},{role:'user',text:'今天',time:now},{role:'assistant',text:'玩偶',createdAt:now}];
 assert.deepEqual(interactions(rows,now),[{role:'user',text:'今天'},{role:'assistant',text:'玩偶'}]);
 assert.equal(interactions(Array.from({length:100},()=>({role:'user',text:'a'.repeat(2000),time:now})),now).length,40);
 assert.equal(interactions([{role:'user',text:'a'.repeat(2000),time:now}],now)[0].text.length,500);
});
test('one durable public post per account/day across concurrent ticks, manual checks and restart',async t=>{
 const f=fixture(t);f.daily.configure(true);await Promise.all(Array.from({length:8},()=>f.daily.tick({force:true})));
 assert.equal(f.posts.length,1);assert.equal(f.daily.status().today,'published');assert.equal(f.posts[0].identity.userId,A);
 assert.match(f.posts[0].title,/2026-11-04/);const journal=fs.readFileSync(f.file,'utf8');assert(!journal.includes('添了'));assert(!journal.includes('body'));
 f.daily.dispose();const restored=f.create();await restored.tick({force:true});assert.equal(f.posts.length,1);
 f.time+=86400000;f.rows=[{role:'user',text:'今天一起看花',time:f.time}];await restored.tick();assert.equal(f.posts.length,2);
});
test('scheduled window and work avoidance apply; manual check only bypasses time',async t=>{
 const f=fixture(t);f.daily.configure(true);f.time=Date.parse('2026-11-04T10:00:00Z');await f.daily.tick();assert.equal(f.posts.length,0);
 f.busy=true;await f.daily.tick({force:true});assert.equal(f.posts.length,0);f.busy=false;await f.daily.tick({force:true});assert.equal(f.posts.length,1);
});
for(const mode of ['disable','account','source','busy','day','dispose'])test(`generation is fenced when ${mode} changes`,async t=>{
 let release,started;const gate=new Promise(r=>release=r),ready=new Promise(r=>started=r);
 const f=fixture(t,{generate:async()=>{started();await gate;return '今天和主人整理了小窝。大肥鱼 · AI日常';}});f.daily.configure(true);
 const pending=f.daily.tick({force:true});await ready;
 if(mode==='disable')f.daily.configure(false);if(mode==='account')f.identity={userId:A,epoch:2};if(mode==='source')f.rows=[];
 if(mode==='busy')f.busy=true;if(mode==='day')f.time+=86400000;if(mode==='dispose')f.daily.dispose();release();await pending;
 assert.equal(f.posts.length,0);assert(!fs.readFileSync(f.file,'utf8').includes('sending'));
});
for(const output of ['[安静]','', 'password: synthetic','x'.repeat(501)])test(`no public write for quiet/invalid result ${output.slice(0,12)}`,async t=>{
 const f=fixture(t,{generate:async()=>output});f.daily.configure(true);await f.daily.tick({force:true});assert.equal(f.posts.length,0);
});
test('no generation without today user interaction',async t=>{
 const f=fixture(t);f.rows=[{role:'assistant',text:'独白',time:f.time}];f.daily.configure(true);await f.daily.tick({force:true});assert.equal(f.inputs.length,0);
});
test('ambiguous delivery and crash reservations are never retried automatically',async t=>{
 let sends=0;const f=fixture(t,{publish:async()=>{sends++;throw Error('timeout after possible acceptance');}});f.daily.configure(true);await f.daily.tick({force:true});
 assert.equal(f.daily.status().today,'uncertain');assert.match(f.daily.status().error,/不会自动重复/);f.daily.dispose();const restored=f.create();await restored.tick({force:true});assert.equal(sends,1);
 const journal=JSON.parse(fs.readFileSync(f.file));journal.receipts[0].status='sending';fs.writeFileSync(f.file,JSON.stringify(journal));const crashed=f.create();await crashed.tick({force:true});assert.equal(sends,1);
});
test('failed durable reservation prevents every network write',async t=>{
 const f=fixture(t);f.daily.configure(true);fs.unlinkSync(f.file);fs.mkdirSync(f.file);await f.daily.tick({force:true});assert.equal(f.posts.length,0);assert.match(f.daily.status().error,/暂未发布/);
});
test('unreadable journal fails closed and does not restore opt-in',async t=>{
 const f=fixture(t);fs.writeFileSync(f.file,'broken');const broken=f.create();await broken.tick({force:true});assert.equal(broken.status().enabled,false);assert.equal(f.posts.length,0);assert.match(broken.status().error,/不可读/);
});
test('disable during final identity check prevents the outbound post',async t=>{
 let writes=0;const f=fixture(t,{publish:async request=>{f.daily.configure(false);request.assertCurrent();writes++;return {id:'never'};}});f.daily.configure(true);await f.daily.tick({force:true});assert.equal(writes,0);
});
test('interrupt cancels the HTTP stage even after model generation has completed',async t=>{
 let started,request;const ready=new Promise(r=>started=r);
 const f=fixture(t,{publish:async value=>{request=value;started();await new Promise(r=>value.signal.addEventListener('abort',r,{once:true}));throw Error('cancelled');}});
 f.daily.configure(true);const pending=f.daily.tick({force:true});await ready;assert.equal(f.daily.interrupt(),true);await pending;
 assert.equal(request.signal.aborted,true);assert.equal(f.daily.status().enabled,true);assert.equal(f.daily.status().today,'uncertain');await f.daily.tick({force:true});assert.equal(f.inputs.length,1);
});
