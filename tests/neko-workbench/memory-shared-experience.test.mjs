import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {WorkbenchMemory} from '../../apps/neko-workbench/memory/controller.mjs';
import {EventStore,capabilities,selectValues} from '../../apps/neko-workbench/memory/event-store.mjs';
const root=resolve(import.meta.dirname,'../..');
const SUMMARY='10月29日晚上，我和主人在大厅里聊了合成的乌龙茶话题，阿布说他也喜欢。';
function fixture(t){
  const dir=mkdtempSync(join(tmpdir(),'neko-shared-experience-'));const remote=new EventStore(join(dir,'remote.sqlite'));const instances=[];
  const worker={request:async(route,body)=>{if(route==='/health')return {ready:true,capabilities};
    if(route.startsWith('/pull')){const offset=Number(new URL('http://localhost'+route).searchParams.get('cursor'));const all=remote.events();return {events:all.slice(offset),nextCursor:String(all.length)};}
    if(route==='/push'){remote.append(body.events);return {ackedEventIds:body.events.map(e=>e.eventId)};}
    if(route==='/recall')return {values:selectValues(remote.records(),body.query,body.tokenBudget)};throw Error('unexpected fixture route');},stop:async()=>{},close:async()=>{}};
  const create=()=>{const memory=new WorkbenchMemory({directory:join(dir,'memory'),dataDir:join(dir,'chat'),repositoryRoot:root,getModel:async()=>{},getPersona:async()=>{},getLegacy:async()=>({items:[],summaries:[]}),worker});instances.push(memory);return memory;};
  t.after(async()=>{for(const m of instances)await m.close();remote.close();rmSync(dir,{recursive:true,force:true});});
  return {dir,remote,create};
}
const input=(extra={})=>({id:'seg-synthetic-1',text:SUMMARY,occurredAt:Date.parse('2026-10-29T12:00:00Z'),evidenceRefs:['lobby-msg:m1','lobby-msg:m2','lobby-msg:m1'],...extra});

test('recordSharedExperience writes one private inferred fact with lobby source markers',async t=>{
  const f=fixture(t),memory=f.create();const result=await memory.recordSharedExperience(input());
  assert.equal(result.itemId,'lobby:seg-synthetic-1');assert.equal(result.created,true);assert.match(result.eventId,/^lobby:[0-9a-f]{64}$/);
  const event=memory.hub.snapshot().events.find(e=>e.itemId===result.itemId);
  assert.equal(event.origin,'user');assert.equal(event.eventId,result.eventId);assert.equal(event.occurredAt,'2026-10-29T12:00:00.000Z');
  assert.deepEqual(event.value,{kind:'fact',text:SUMMARY,visibility:'private',certainty:'inferred',evidenceRefs:['lobby-msg:m1','lobby-msg:m2']});
  const view=await memory.view();assert(view.records.some(r=>r.itemId==='lobby:seg-synthetic-1'&&!r.deleted&&!r.conflict));
  await memory.sync();assert(f.remote.events().some(e=>e.eventId===result.eventId));
});

test('repeated submission of one segment keeps one record and the same event id; deletion is not revived',async t=>{
  const f=fixture(t),memory=f.create();const first=await memory.recordSharedExperience(input());const again=await memory.recordSharedExperience(input());
  assert.equal(again.eventId,first.eventId);assert.equal(again.created,false);
  const other=await memory.recordSharedExperience(input({text:'另一种说法的合成摘要。'}));assert.equal(other.created,false);
  assert.equal(memory.hub.snapshot().events.filter(e=>e.itemId===first.itemId).length,1);
  const record=(await memory.view()).records.find(r=>r.itemId===first.itemId);
  await memory.change({action:'event-delete',id:first.itemId,revisionIds:record.heads.map(e=>e.eventId)});
  await memory.recordSharedExperience(input());const after=(await memory.view()).records.find(r=>r.itemId===first.itemId);assert.equal(after.deleted,true);
});

test('concurrent retries of one segment persist a single record without conflict',async t=>{
  const f=fixture(t),memory=f.create();const values=await Promise.all(Array.from({length:8},(_,i)=>memory.recordSharedExperience(input({text:'合成并发摘要 '+i}))));
  assert.equal(values.filter(v=>v.created).length,1);assert.equal(new Set(values.map(v=>v.eventId)).size,1);
  const rows=(await memory.view()).records.filter(r=>r.itemId==='lobby:seg-synthetic-1');assert.equal(rows.length,1);assert.equal(rows[0].conflict,false);
});

test('lobby experience is editable through existing actions and survives a controller rebuild',async t=>{
  const f=fixture(t);let memory=f.create();const {itemId}=await memory.recordSharedExperience(input());await memory.sync();
  let record=(await memory.view()).records.find(r=>r.itemId===itemId);
  await memory.change({action:'event-update',id:itemId,text:'我和主人在大厅里聊了合成的茶。',revisionIds:record.heads.map(e=>e.eventId)});
  record=(await memory.view()).records.find(r=>r.itemId===itemId);assert.equal(record.value.text,'我和主人在大厅里聊了合成的茶。');assert.equal(record.value.visibility,'private');
  assert.deepEqual(record.value.evidenceRefs,['lobby-msg:m1','lobby-msg:m2']);await memory.sync();
  await memory.close();memory=f.create();
  const values=await memory.recall('bigfish','大厅 茶',1200);assert(values.some(v=>v.text==='我和主人在大厅里聊了合成的茶。'));
  assert((await memory.view()).records.some(r=>r.itemId===itemId&&!r.deleted));
});

test('invalid shared experiences are rejected without writing anything',async t=>{
  const f=fixture(t),memory=f.create();
  for(const bad of [input({id:'../x'}),input({text:'  '}),input({text:'长'.repeat(2001)}),input({occurredAt:'never'}),input({evidenceRefs:[]}),input({evidenceRefs:['m1']}),input({evidenceRefs:['lobby-msg:bad id']})])
    await assert.rejects(memory.recordSharedExperience(bad));
  assert.equal(memory.hub.snapshot().events.length,0);
});

test('hub and worker origin validation are unchanged',()=>{
  const hub=readFileSync(join(root,'apps/neko-workbench/framework/reference/memory-hub.mjs'),'utf8');
  assert.match(hub,/\['diary', 'neko', 'user'\]\.includes\(event\.origin\)/);
});
