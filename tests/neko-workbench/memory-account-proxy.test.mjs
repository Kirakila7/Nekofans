import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync,rmSync,readdirSync,readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join,resolve } from 'node:path';
import { NekoMemoryWorker,NekoMemoryAdapter } from '../../apps/neko-workbench/memory/neko-adapter.mjs';
const require=createRequire(import.meta.url),{createMemoryAccountProxy}=require('../../apps/neko-workbench/memory-account-proxy.cjs');
const root=resolve(import.meta.dirname,'../..');
test('loopback adapter requires its token, rejects cross-origin and unsupported features',async t=>{
 let calls=0;const proxy=createMemoryAccountProxy({invoke:async()=>{calls++;return 'synthetic response';}}),model=await proxy.start();t.after(()=>proxy.close());
 const url=model.baseUrl+'/chat/completions',body=JSON.stringify({model:model.model,messages:[{role:'user',content:'synthetic'}],stream:false});
 const request=(auth,extra={})=>fetch(url,{method:'POST',headers:{'content-type':'application/json',...(auth?{authorization:'Bearer '+auth}:{}),...extra},body});
 assert.equal((await request('wrong')).status,403);assert.equal((await request(model.apiKey,{origin:'https://example.test'})).status,403);assert.equal(calls,0);
 const ok=await request(model.apiKey);assert.equal(ok.status,200);const completed=await ok.json();assert.equal(completed.choices[0].message.content,'synthetic response');assert.equal(Object.hasOwn(completed,'usage'),false);assert.equal(calls,1);
 const bad=await fetch(url,{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+model.apiKey},body:JSON.stringify({model:model.model,messages:[{role:'user',content:'synthetic'}],tools:[{}]})});assert.equal(bad.status,400);assert.equal(calls,1);
});
test('closing adapter aborts an in-flight memory call',async()=>{
 let sawAbort=false;const proxy=createMemoryAccountProxy({invoke:({signal})=>new Promise((_,reject)=>signal.addEventListener('abort',()=>{sawAbort=true;reject(Error('aborted'));},{once:true}))});const model=await proxy.start();
 const request=fetch(model.baseUrl+'/chat/completions',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+model.apiKey},body:JSON.stringify({model:model.model,messages:[{role:'user',content:'synthetic'}]})}).catch(()=>null);
 await new Promise(r=>setTimeout(r,30));await proxy.close();await request;assert.equal(sawAbort,true);
});
test('native worker uses account adapter for synthetic episode and recovers across restart', {skip:process.env.NEKO_MEMORY_COMPONENT_TEST!=='1',timeout:180000},async t=>{
 const directory=mkdtempSync(join(tmpdir(),'neko-memory-account-'));let calls=0;
 const proxy=createMemoryAccountProxy({invoke:async ({messages})=>{assert(messages.some(m=>m.role==='user'));calls++;return JSON.stringify([{text:'合成用户喜欢茉莉花茶',importance:6,entity:'master'}]);}});
 const opts={repositoryRoot:root,dataRoot:directory,getModel:()=>proxy.start(),getPersona:async()=>({prompt:'合成角色'})};
 let worker=new NekoMemoryWorker(opts),adapter=new NekoMemoryAdapter({worker});t.after(async()=>{await worker.close();await proxy.close();rmSync(directory,{recursive:true,force:true});});
 const event={eventId:'synthetic-1',itemId:'synthetic-preference',personaId:'bigfish',origin:'user',operation:'upsert',parents:[],occurredAt:'2026-10-28T00:00:00Z',value:{kind:'preference',text:'合成用户喜欢茉莉花茶',visibility:'private',certainty:'user-confirmed',evidenceRefs:['synthetic-1']}};
 await worker.ensure();const episode={...event,eventId:'synthetic-episode',itemId:'synthetic-episode',value:{...event.value,kind:'episode',certainty:'inferred',text:'用户原话：我喜欢茉莉花茶。\n角色回复：记住啦。'}};await adapter.push([episode]);assert((await adapter.pull()).events.some(x=>x.value?.text==='合成用户喜欢茉莉花茶'));await adapter.push([event]);assert((await adapter.recall('茉莉花茶',512)).some(x=>x.text===event.value.text));
 await worker.close();worker=new NekoMemoryWorker(opts);adapter=new NekoMemoryAdapter({worker});await worker.ensure();assert((await adapter.recall('茉莉花茶',512)).some(x=>x.text===event.value.text));
 assert(calls>0,'native memory never used synthetic account proxy');
 const modelToken=(await proxy.start()).apiKey;function logs(dir){for(const entry of readdirSync(dir,{withFileTypes:true})){const file=join(dir,entry.name);if(entry.isDirectory())logs(file);else {const bytes=readFileSync(file);assert(!bytes.includes(Buffer.from(modelToken)));if(/\.(?:log|jsonl|ndjson)$/.test(entry.name))assert(!bytes.includes(Buffer.from('用户原话：我喜欢茉莉花茶')));}}}logs(directory);
});
test('concurrent memory requests fail fast; restarted proxy rejects old token',async()=>{
 let started;const firstStarted=new Promise(r=>started=r);const proxy=createMemoryAccountProxy({invoke:({signal})=>new Promise((_,reject)=>{started();signal.addEventListener('abort',()=>reject(Error('cancelled')),{once:true});})});const model=await proxy.start();
 const body=JSON.stringify({model:model.model,messages:[{role:'user',content:'synthetic'}]});const headers={'content-type':'application/json',authorization:'Bearer '+model.apiKey};
 const first=fetch(model.baseUrl+'/chat/completions',{method:'POST',headers,body}).catch(()=>null);await firstStarted;
 assert.equal((await fetch(model.baseUrl+'/chat/completions',{method:'POST',headers,body})).status,503);
 await proxy.close();await first;const next=createMemoryAccountProxy({invoke:async()=> 'synthetic'});const replacement=await next.start();
 try{assert.equal((await fetch(replacement.baseUrl+'/chat/completions',{method:'POST',headers,body})).status,403);assert.notEqual(model.apiKey,replacement.apiKey);}finally{await next.close();}
});
test('simultaneous start and close cannot leave listener usable',async()=>{
 const proxy=createMemoryAccountProxy({invoke:async()=> 'synthetic'});const a=proxy.start(),b=proxy.start();const closing=proxy.close();await Promise.allSettled([a,b,closing]);await assert.rejects(proxy.start(),/已关闭/);
});
test('preempted memory remains durable and replays after fake account reconnect', {skip:process.env.NEKO_MEMORY_COMPONENT_TEST!=='1',timeout:180000},async t=>{
 const {createCompanionAccountBridge}=require('../../apps/neko-workbench/companion-account-bridge.cjs');
 const {createCompanionAccountProvider}=require('../../apps/neko-workbench/companion-account-provider.cjs');
 let first=true,offline=false,start;const started=new Promise(r=>start=r);
 const ctx={get:()=>({getState:async()=>({status:'credential-stored'})}),llm:{prepareCall:async config=>({config,stream:async function*(options){
   const text=options.messages.at(-1).content[0].text;
   if(text==='foreground synthetic'){yield {type:'text-delta',index:0,text:'done'};yield {type:'finish',reason:{kind:'stop'}};return;}
   if(first){first=false;start();await new Promise(r=>options.signal.addEventListener('abort',()=>{offline=true;r();},{once:true}));return;}
   if(offline)throw Error('synthetic offline');
   yield {type:'text-delta',index:0,text:JSON.stringify([{text:'合成用户喜欢茉莉花茶',entity:'master',importance:6}])};yield {type:'finish',reason:{kind:'stop'}};
 }})}};
 const bridge=createCompanionAccountBridge({ctx,route:{provider:'deepseek-account',model:'deepseek-flash'},createUserMessage:x=>x,createAssistantMessage:x=>x,timeoutMs:10000});
 const provider=createCompanionAccountProvider((method,args)=>method==='memory-account-model'?bridge.send({...args,purpose:'memory'}):method==='companion-account-cancel'?bridge.cancel(args):Promise.reject(Error('unexpected')));
 const proxy=createMemoryAccountProxy({invoke:args=>provider.memory(args)}),directory=mkdtempSync(join(tmpdir(),'neko-memory-preempt-'));
 const worker=new NekoMemoryWorker({repositoryRoot:root,dataRoot:directory,getModel:()=>proxy.start(),getPersona:async()=>({prompt:'合成角色'})}),adapter=new NekoMemoryAdapter({worker});
 t.after(async()=>{bridge.dispose();await worker.close();await proxy.close();rmSync(directory,{recursive:true,force:true});});
 const event={eventId:'preempt-event',itemId:'preempt-episode',personaId:'bigfish',origin:'user',operation:'upsert',parents:[],occurredAt:'2026-10-28T00:00:00Z',value:{kind:'episode',text:'用户原话：我喜欢茉莉花茶。',visibility:'private',certainty:'inferred',evidenceRefs:['test-message']}};
 await worker.ensure();const push=adapter.push([event]);push.catch(()=>{});await started;
 assert.deepEqual(await bridge.send({requestId:'companion-synthetic',text:'foreground synthetic',maxTokens:1000}),{text:'done'});
 await assert.rejects(push);offline=false;assert.deepEqual((await adapter.push([event])).ackedEventIds,['preempt-event']);const pulled=await adapter.pull();
 assert.equal(pulled.events.filter(x=>x.eventId==='preempt-event').length,1);assert(pulled.events.some(x=>x.value?.text==='合成用户喜欢茉莉花茶'));
});
test('fragmented UTF-8 input reaches fake model intact',async t=>{
 const {request}=await import('node:http');let received;const proxy=createMemoryAccountProxy({invoke:async ({messages})=>{received=messages[0].content;return 'ok';}}),model=await proxy.start();t.after(()=>proxy.close());
 const body=Buffer.from(JSON.stringify({model:model.model,messages:[{role:'user',content:'合成测试'}]})),marker=body.indexOf(Buffer.from('合'))+1;
 await new Promise((resolve,reject)=>{const req=request(model.baseUrl+'/chat/completions',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+model.apiKey}},res=>{res.resume();res.on('end',resolve);});req.on('error',reject);req.write(body.subarray(0,marker));setImmediate(()=>req.end(body.subarray(marker)));});assert.equal(received,'合成测试');
});
