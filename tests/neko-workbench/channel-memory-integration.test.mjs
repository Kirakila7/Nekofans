import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {EventStore,capabilities,selectValues} from '../../apps/neko-workbench/memory/event-store.mjs';
import {WorkbenchMainChat} from '../../apps/neko-workbench/main-chat-runtime.cjs';
import {createChannelLife} from '../../apps/neko-workbench/channel-life.cjs';
import {createCommunityDaily} from '../../apps/neko-workbench/community-daily.cjs';
import {qqExperience,biliExperience} from '../../apps/neko-workbench/channel-experiences.cjs';
function fixture(t){
  const directory=mkdtempSync(join(tmpdir(),'neko-channel-e2e-')),remote=new EventStore(join(directory,'remote.sqlite')),requests=[];
  const worker={request:async(route,body)=>{if(route==='/health')return {ready:true,capabilities};if(route.startsWith('/pull')){const offset=Number(new URL('http://local'+route).searchParams.get('cursor'));const rows=remote.events();return {events:rows.slice(offset),nextCursor:String(rows.length)};}if(route==='/push'){remote.append(body.events);return {ackedEventIds:body.events.map(e=>e.eventId)};}if(route==='/recall')return {values:selectValues(remote.records(),body.query,body.tokenBudget)};throw Error('unexpected route');},close:async()=>{},stop:async()=>{}};
  const provider={async *stream(input){requests.push(input);yield {type:'delta',text:'刚才的渠道经历让我想到茶香，你想聊聊吗？'};}};
  const runtimes=[],create=()=>{const runtime=new WorkbenchMainChat({dataDir:directory,repositoryRoot:resolve(import.meta.dirname,'../..'),initialBackend:'deepseek-account',accountProvider:provider,memoryWorker:worker,safeStorage:{isEncryptionAvailable:()=>true,encryptString:v=>Buffer.from(v),decryptString:v=>v.toString()}});runtimes.push(runtime);return runtime;};const runtime=create();
  const lives=[];t.after(async()=>{lives.forEach(c=>c.dispose());for(const r of runtimes)await r.close();remote.close();rmSync(directory,{recursive:true,force:true});});return {directory,remote,runtime,requests,lives,create};
}

test('community daily uses actual today conversation and main provider without private memory or forged history',async t=>{
 const f=fixture(t);await f.runtime.start();
 await f.runtime.memorySystem.recordChannelExperience(qqExperience({messageId:'private-qq',scope:'c2c',text:'合成的私人消息不要公开'},Date.now()));
 await f.runtime.send('今天给小窝添了一个玩偶');const before=await f.runtime.history(),posts=[];
 const daily=createCommunityDaily({dataDir:f.directory,getIdentity:()=>({userId:'fixture-owner',epoch:1}),getInteractions:()=>f.runtime.history(),generate:(rows,s)=>f.runtime.generateCommunityDaily(rows,s),publish:async p=>{p.assertCurrent();posts.push(p);return {id:'synthetic-post'};}});f.lives.push(daily);
 daily.configure(true);await daily.tick({force:true});assert.equal(posts.length,1);assert.equal(f.requests.length,2);
 const generated=f.requests[1];assert.equal(generated.persona.name,'大肥鱼');assert.match(generated.persona.prompt,/公开社区/);assert.match(generated.messages[0].text,/添了一个玩偶/);
 assert(!generated.messages[0].text.includes('私人消息'));assert.deepEqual(generated.memoryContext,[]);assert.deepEqual(generated.memories,[]);assert.deepEqual(generated.summaries,[]);
 assert.deepEqual(await f.runtime.history(),before,'public generation does not enter private user history');await daily.tick({force:true});assert.equal(posts.length,1);
});

test('community summary generation aborts when a new private message arrives',async t=>{
 const f=fixture(t);await f.runtime.start();let started;const ready=new Promise(r=>started=r);
 f.runtime.proactiveAccountProvider={async *stream(input){started();await new Promise(r=>input.signal.addEventListener('abort',r,{once:true}));yield {type:'delta',text:'must not publish'};}};
 const pending=f.runtime.generateCommunityDaily([{role:'user',text:'今天整理玩偶'}],new AbortController().signal);await ready;
 const check=assert.rejects(pending,/Cancelled/);await f.runtime.send('继续和我聊天');await check;assert.equal((await f.runtime.history()).filter(m=>m.role==='user').length,1);
});
test('B站 and QQ observations reach real main memory, recall and an opt-in desktop comment without a forged user history',async t=>{
  const f=fixture(t);let life;f.runtime.environmentContext=()=>life?.context()||'';await f.runtime.start();let time=Date.parse('2026-11-03T02:00:00Z');const replies=[];
  life=createChannelLife({dataDir:f.directory,getMemory:()=>f.runtime.memorySystem,generate:(e,s)=>f.runtime.generateProactive(e,s),present:r=>replies.push(r),now:()=>time});f.lives.push(life);
  life.accept(biliExperience({at:new Date(time).toISOString(),kind:'watch',target:'BV-fixture',note:'看到了关于乌龙茶的介绍'}));life.accept(qqExperience({messageId:'synthetic',scope:'group',text:'群友说他喜欢乌龙茶'},time));await life.tick();await f.runtime.memorySystem.sync();
  const records=(await f.runtime.memorySystem.view()).records.filter(r=>r.itemId.startsWith('channel:'));assert.equal(records.length,2);assert(records.every(r=>r.value.visibility==='private'&&r.value.certainty==='inferred'));
  assert((await f.runtime.memorySystem.recall('bigfish','乌龙茶',2000)).some(v=>v.text.includes('乌龙茶')));assert.equal(f.requests.length,0);
  life.configure({proactiveEnabled:true});time+=61000;await life.tick();assert.equal(replies.length,1);assert.equal(f.requests.length,1);assert(f.requests[0].memoryContext.length>0);assert.match(f.requests[0].persona.prompt,/不透露对方身份/);assert.equal((await f.runtime.history()).length,0,'the internal generation instruction is not stored as user speech');
  assert.equal((await f.runtime.memorySystem.view()).records.filter(r=>r.itemId.startsWith('channel:')).length,2);
  await f.runtime.send('这听起来不错');assert.equal(f.requests.length,2);assert.match(f.requests[1].persona.prompt,/角色自己的发言/);assert.match(f.requests[1].persona.prompt,/你想聊聊吗/);assert.equal((await f.runtime.history()).filter(m=>m.role==='user').length,1);
});
test('channel records respect concurrent deduplication, deletion, restart, and public-lobby memory isolation',async t=>{
  const f=fixture(t);await f.runtime.start();const memory=f.runtime.memorySystem,entry=qqExperience({messageId:'once',scope:'c2c',text:'私聊合成样例'},Date.parse('2026-11-03T02:00:00Z'));
  const results=await Promise.all(Array.from({length:6},()=>memory.recordChannelExperience(entry)));assert.equal(results.filter(r=>r.created).length,1);const id=results[0].itemId;await memory.sync();
  const record=(await memory.view()).records.find(r=>r.itemId===id);await memory.change({action:'event-delete',id,revisionIds:record.heads.map(e=>e.eventId)});assert.equal((await memory.recordChannelExperience(entry)).available,false);assert.equal(memory.channelExperience(id),null);
  await assert.rejects(memory.recordChannelExperience({...entry,evidenceRefs:['lobby-msg:forged']}));
  await memory.recordChannelExperience(qqExperience({messageId:'live-private',scope:'c2c',text:'仍存在的私聊合成样例'},Date.parse('2026-11-03T02:00:00Z')));await memory.sync();assert((await memory.recall('bigfish','私聊',2000)).length>0);
  // Public lobby retrieval must keep refusing channel provenance.
  f.runtime.lobbyAccountProvider={status:async()=>({status:'signed-in'}),async *stream(){}};f.runtime.lobbyAccountStatus='signed-in';f.runtime.lobbyAccountCheckedAt=Date.now();
  const publicMemory=f.runtime.lobbyMemory();assert(publicMemory);assert.equal((await publicMemory.recall('私聊',2000)).length,0);
  await f.runtime.close();const reopened=f.create();await reopened.start();assert.equal(reopened.memorySystem.channelExperience(id),null);assert.equal((await reopened.memorySystem.recordChannelExperience(entry)).available,false);
});
