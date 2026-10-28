import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,renameSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {WorkbenchMemory} from '../../apps/neko-workbench/memory/controller.mjs';
import {EventStore,capabilities,selectValues} from '../../apps/neko-workbench/memory/event-store.mjs';
import {NekoMemoryAdapter} from '../../apps/neko-workbench/memory/neko-adapter.mjs';
const root=resolve(import.meta.dirname,'../..');
function event(id,parents=[],extra={}){return {eventId:id,itemId:'preference',personaId:'bigfish',origin:'diary',operation:'upsert',parents,occurredAt:'2026-10-28T00:00:00Z',value:{kind:'preference',text:'合成用户喜欢安静的晚上',visibility:'private',certainty:'user-confirmed',evidenceRefs:['synthetic-message']},...extra};}
function fixture(t){
  const dir=mkdtempSync(join(tmpdir(),'neko-native-memory-'));let online=true,recalls=0;
  const remote=new EventStore(join(dir,'remote.sqlite'));
  const worker={request:async(route,body)=>{if(!online)throw Error('fixture offline');if(route==='/health')return {ready:true,capabilities};if(route.startsWith('/pull')){const offset=Number(new URL('http://localhost'+route).searchParams.get('cursor'));const all=remote.events();return {events:all.slice(offset),nextCursor:String(all.length)};}if(route==='/push'){remote.append(body.events);return {ackedEventIds:body.events.map(e=>e.eventId)};}if(route==='/recall'){recalls++;return {values:selectValues(remote.records(),body.query,body.tokenBudget)};}throw Error('unexpected fixture route');},stop:async()=>{},close:async()=>{}};
  let legacy={items:[],summaries:[]};const instances=[];
  const create=()=>{const memory=new WorkbenchMemory({directory:join(dir,'memory'),dataDir:join(dir,'chat'),repositoryRoot:root,getModel:async()=>{},getPersona:async()=>{},getLegacy:async()=>legacy,worker});instances.push(memory);return memory;};
  t.after(async()=>{for(const m of instances)await m.close();remote.close();rmSync(dir,{recursive:true,force:true});});
  return {dir,remote,create,setOnline:value=>online=value,recalls:()=>recalls,setLegacy:value=>legacy=value};
}
test('native is the only provider by default; ten replays and restart preserve IDs',async t=>{
  const f=fixture(t);let memory=f.create();assert.equal(memory.status().mode,'neko');assert.deepEqual(Object.keys(memory.hub.adapters),['neko']);assert.equal(memory.diary,undefined);
  await memory.hub.add([event('original')]);for(let i=0;i<10;i++)await memory.sync();assert.equal(memory.hub.snapshot().events.length,1);assert.equal(f.remote.events().length,1);
  await memory.recall('bigfish','晚上',1000);assert.equal(f.recalls(),1);
  await memory.close();memory=f.create();assert.equal(memory.status().mode,'neko');await memory.sync();assert.equal(memory.status().pending,0);
});
test('offline native keeps pending writes and never falls back to local recall',async t=>{
  const f=fixture(t),memory=f.create();await memory.hub.add([event('offline')]);f.setOnline(false);
  await assert.rejects(memory.sync());await assert.rejects(memory.recall('bigfish','晚上',1000));assert.equal(memory.status().mode,'neko');assert.equal(memory.status().pending,1);
  f.setOnline(true);await memory.sync();assert.equal(memory.status().pending,0);assert.equal((await memory.recall('bigfish','晚上',1000)).length,1);
});
test('a durable native history larger than one transport batch reopens without losing pending events',async t=>{
  const f=fixture(t);let memory=f.create();
  const history=Array.from({length:10001},(_,i)=>event('history-'+i,[],{itemId:'history-item-'+i}));
  await memory.hub.add(history);await memory.close();memory=f.create();
  assert.equal(memory.hub.records().length,10001);assert.equal(memory.status().pending,10001);
});
test('upgrade preserves old hub and unsent diary events without touching the old database',async t=>{
  const f=fixture(t),old=new EventStore(join(f.dir,'memory/hub.sqlite')),diary=new EventStore(join(f.dir,'memory/diary.sqlite'));
  const snapshot={personaId:'bigfish',mode:'diary',events:[event('base')],cursors:{},acknowledgements:{}};
  old.set('hub',snapshot);old.set('settings',{autoSync:false,nekoEnabled:false});diary.append([event('base'),event('unsent',['base'])]);old.close();diary.close();
  const before=readFileSync(join(f.dir,'memory/diary.sqlite'));let memory=f.create();assert.equal(memory.status().mode,'neko');assert.equal(memory.hub.snapshot().events.length,2);assert.deepEqual(memory.store.get('preNativeOnlyHub'),snapshot);
  await memory.sync();assert.equal(f.remote.events().length,2);assert.deepEqual(readFileSync(join(f.dir,'memory/diary.sqlite')),before);
  await memory.close();memory=f.create();assert.equal(memory.hub.snapshot().events.length,2);assert.deepEqual(memory.store.get('preNativeOnlyHub'),snapshot);
});
test('native and user edits retain conflicts; stale updates fail; deleted records require explicit restore',async t=>{
  const f=fixture(t),memory=f.create();await memory.hub.add([event('base')]);await memory.sync();
  await memory.hub.add([event('left',['base'],{origin:'user',value:{...event('x').value,text:'用户修订'}})]);
  f.remote.append([event('right',['base'],{origin:'neko',value:{...event('x').value,text:'原生修订'}})]);await memory.sync();let row=memory.hub.records()[0];assert(row.conflict);
  await assert.rejects(memory.change({action:'event-resolve',id:row.itemId,text:'合并',revisionIds:['base']}));
  await memory.change({action:'event-resolve',id:row.itemId,text:'合并后的更正',revisionIds:row.heads.map(e=>e.eventId)});await memory.sync();row=memory.hub.records()[0];assert(!row.conflict);
  await memory.change({action:'event-delete',id:row.itemId,revisionIds:row.heads.map(e=>e.eventId)});await memory.sync();f.remote.append([event('base')]);await memory.sync();row=memory.hub.records()[0];assert(row.deleted);
  await memory.change({action:'event-restore',id:row.itemId,revisionIds:row.heads.map(e=>e.eventId)});await memory.sync();assert(!memory.hub.records()[0].deleted);
});
test('failed durable receipt retains retry; foreign events, collisions and corrupt personas fail closed',async t=>{
  const f=fixture(t),memory=f.create();await memory.hub.add([event('one')]);
  await assert.rejects(memory.hub.add([event('foreign',[],{personaId:'other'})]));await assert.rejects(memory.hub.add([event('one',[],{value:{...event('x').value,text:'篡改事件'}})]));
  const persist=memory.hub.persist;memory.hub.persist=async()=>{throw Error('fixture disk full');};await assert.rejects(memory.sync());assert.equal(memory.status().pending,1);memory.hub.persist=persist;await memory.sync();assert.equal(memory.status().pending,0);
  memory.store.set('hub',{personaId:'other',mode:'diary',events:[],cursors:{},acknowledgements:{}});await memory.close();assert.throws(()=>f.create(),/persona/);assert.doesNotThrow(()=>renameSync(join(f.dir,'memory/hub.sqlite'),join(f.dir,'memory/hub.closed.sqlite')));
});
test('partial native delivery retries after lost response without duplicating saved events',async t=>{
  const f=fixture(t),chain=Array.from({length:9},(_,i)=>event('batch-'+i,i?['batch-'+(i-1)]:[]));let calls=0;
  const adapter=new NekoMemoryAdapter({worker:{request:async(_route,body)=>{f.remote.append(body.events);if(++calls===2)throw Error('fixture response lost');return {ackedEventIds:body.events.map(e=>e.eventId)};}}});
  assert.equal((await adapter.push(chain)).ackedEventIds.length,4);await adapter.push(chain.slice(4));assert.equal(f.remote.events().length,9);
});
