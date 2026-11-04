'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {createServer}=require('node:http');
const {WorkbenchMainChat}=require('../../apps/neko-workbench/main-chat-runtime.cjs');
const {WorkbenchSecretStore}=require('../../apps/neko-workbench/main-chat-secret.cjs');
const root=path.resolve(__dirname,'../..');
function vault(){return {isEncryptionAvailable:()=>true,getSelectedStorageBackend:()=> 'keychain',
  encryptString:value=>Buffer.from('fixture-cipher:'+Buffer.from(value).toString('base64')),
  decryptString:bytes=>{const raw=bytes.toString();if(!raw.startsWith('fixture-cipher:'))throw Error('bad fixture');return Buffer.from(raw.slice(15),'base64').toString();}};}
function fixture(t){const directory=fs.mkdtempSync(path.join(os.tmpdir(),'neko-main-chat-'));const safeStorage=vault();const options={dataDir:directory,repositoryRoot:root,safeStorage,memoryWorker:{request:async()=>{throw Error('fixture native offline');},stop:async()=>{},close:async()=>{}}};const runtimes=[];
  t.after(async()=>{for(const runtime of runtimes)await runtime.close();fs.rmSync(directory,{recursive:true,force:true});});
  const create=(extra={})=>{const runtime=new WorkbenchMainChat({...options,...extra});runtimes.push(runtime);return runtime;};return {directory,options,safeStorage,create};}
function sse(res,text='你好'){res.writeHead(200,{'content-type':'text/event-stream'});res.write(`data: ${JSON.stringify({choices:[{delta:{content:text.slice(0,1)}}]})}\n\n`);res.end(`data: ${JSON.stringify({choices:[{delta:{content:text.slice(1)}}]})}\n\ndata: [DONE]\n\n`);}
async function upstream(t){const requests=[];let handler=(_req,res)=>sse(res);const server=createServer((req,res)=>{let text='';req.on('data',chunk=>text+=chunk);req.on('end',()=>{const record={url:req.url,headers:req.headers,body:JSON.parse(text)};requests.push(record);handler(record,res);});});
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);}));
  return {requests,baseUrl:`http://127.0.0.1:${server.address().port}/v1`,setHandler:fn=>{handler=fn;}};}
const config=(baseUrl,extra={})=>({protocol:'openai-compatible',baseUrl,model:'fixture-model',requestTimeoutMs:5000,maxOutputTokens:256,key:{action:'replace',value:'fixture-secret-only'},...extra});
test('live home context refreshes per chat turn and never changes the persona file or raw conversation history',async t=>{
 const f=fixture(t),inputs=[];let context='家里只有地板';const provider={async *stream(input){inputs.push(input);yield {type:'delta',text:'一起布置吧'};yield {type:'complete',messageId:'home-fixture'};}};
 const runtime=f.create({initialBackend:'deepseek-account',accountProvider:provider,environmentContext:()=>context});await runtime.start();const personaBefore=fs.readFileSync(path.join(runtime.personasDir,'bigfish.json'),'utf8');await runtime.send('我们家现在有什么？');assert(inputs[0].persona.prompt.includes('家里只有地板'));context='家里新增了一张蓝色沙发';await runtime.send('喜欢刚添的东西吗？');assert(inputs[1].persona.prompt.includes('蓝色沙发'));assert(!inputs[0].persona.prompt.includes('蓝色沙发'));assert.deepEqual((await runtime.history()).filter(x=>x.role==='user').map(x=>x.text),['我们家现在有什么？','喜欢刚添的东西吗？']);assert.equal(fs.readFileSync(path.join(runtime.personasDir,'bigfish.json'),'utf8'),personaBefore);
});

test('new workbench uses independent unconfigured chat, encrypted key projection and existing shared service',async t=>{
  const f=fixture(t),runtime=f.create();await runtime.start();const snapshot=runtime.read();assert.equal(snapshot.backend,'chat-api');assert.equal(snapshot.ready,true);assert.equal(snapshot.hasKey,false);assert.equal(snapshot.voiceStatus,'未接入');
  assert.equal(snapshot.settings.personaId,'bigfish');assert(fs.existsSync(path.join(runtime.personasDir,'bigfish.json')));assert(!JSON.stringify(snapshot).includes('fixture-secret'));
  assert.equal((await runtime.send('你好')).status,'error');assert.equal(runtime.read().chat.phase,'error');
  const history=await runtime.history();assert.equal(history.length,1);assert.equal(history[0].role,'user');assert.equal(history[0].personaId,'bigfish');
});

test('memory IPC accepts bounded priority/pin edits without confirming a candidate',async t=>{
  const f=fixture(t),runtime=f.create();await runtime.start();
  const value={kind:'fact',text:'合成测试记忆',visibility:'private',certainty:'candidate',evidenceRefs:['synthetic']};
  await runtime.memorySystem.hub.add([{eventId:'ipc-priority-base',itemId:'ipc-priority-item',personaId:'bigfish',origin:'user',operation:'upsert',parents:[],occurredAt:'2026-10-28T00:00:00Z',value}]);
  const input={action:'event-priority',id:'ipc-priority-item',revisionIds:['ipc-priority-base'],priority:90,pinned:true};
  const result=await runtime.memoryAction(input);assert.equal(result.ok,true);
  const row=result.replication.records.find(r=>r.itemId===input.id);assert.equal(row.value.priority,90);assert.equal(row.value.pinned,true);assert.equal(row.value.certainty,'candidate');
  assert.equal((await runtime.memoryAction({...input,priority:200,revisionIds:row.heads.map(e=>e.eventId)})).ok,false);
  assert.equal((await runtime.memoryAction({...input,priority:2})).ok,false);
});

test('starting DSH with unconfigured companion chat never queries the keychain; settings checks remain fail-closed',async t=>{
  const f=fixture(t);let checks=0;f.safeStorage.isEncryptionAvailable=()=>{checks++;throw Error('locked keychain fixture');};
  const runtime=f.create();await runtime.start();runtime.read();assert.equal(checks,0);assert.equal(runtime.read().secureStorageAvailable,null);
  assert.equal(runtime.read({checkSecureStorage:true}).secureStorageAvailable,false);assert.equal(checks,1);
  await assert.rejects(runtime.saveApi(config('https://example.invalid/v1')),/保存失败/);assert.equal(runtime.secretStore.has(),false);
});

test('loopback chat uses only native memory, preserves raw history, and does not generate local proposals or summaries',async t=>{
  const f=fixture(t),api=await upstream(t);let runtime=f.create();await runtime.start();await runtime.saveApi({...config(api.baseUrl),personaId:'forged',apiKey:'must-not-persist'});
  const projections=[];runtime.subscribe(state=>projections.push(state));const result=await runtime.send('我喜欢乌龙茶');assert.equal(result.status,'completed');assert.equal(result.text,'你好');
  assert(projections.some(p=>p.chat.phase==='connecting'));assert(projections.some(p=>p.chat.phase==='replying'&&p.chat.reply==='你'));
  assert.equal(api.requests[0].url,'/v1/chat/completions');assert.equal(api.requests[0].headers.authorization,'Bearer fixture-secret-only');
  const storedConfig=fs.readFileSync(runtime.configFile,'utf8');assert(!storedConfig.includes('fixture-secret'));assert(!storedConfig.includes('must-not-persist'));assert.equal(JSON.parse(storedConfig).mainChat.personaId,'bigfish');
  assert(!fs.readFileSync(runtime.secretStore.file).includes(Buffer.from('fixture-secret-only')));
  for(let n=0;n<11;n++)await runtime.send('继续聊天 '+n);
  let memory=await runtime.memories();assert.equal(memory.items.length,0);assert.equal(memory.summaries.length,0);assert.equal(memory.replication.mode,'neko');assert.equal(memory.replication.records.filter(r=>r.value?.kind==='episode').length,12);
  await assert.rejects(runtime.memoryAction({action:'set-mode',mode:'diary'}));await assert.rejects(runtime.memoryAction({action:'auto-sync',enabled:false}));
  const id=runtime.opened.service.conversationId,priorHistory=await runtime.history();await runtime.close();runtime=f.create();await runtime.start();assert.equal(runtime.opened.service.conversationId,id);assert.equal((await runtime.history()).length,priorHistory.length);
  memory=await runtime.memories();assert.equal(memory.replication.records.length,12);assert.equal(memory.replication.mode,'neko');
});

test('cancel discards partial assistant storage, API failure is fixed text, and the next request recovers',async t=>{
  const f=fixture(t),api=await upstream(t),runtime=f.create();await runtime.start();await runtime.saveApi(config(api.baseUrl));
  let started;const firstChunk=new Promise(resolve=>started=resolve);api.setHandler((_req,res)=>{res.writeHead(200,{'content-type':'text/event-stream'});res.write(`data: ${JSON.stringify({choices:[{delta:{content:'未完成的回复'}}]})}\n\n`);started();});
  const pending=runtime.send('请慢慢回复');await firstChunk;assert.equal(runtime.cancel(),true);assert.equal((await pending).status,'cancelled');assert.equal((await runtime.history()).filter(item=>item.role==='assistant').length,0);
  api.setHandler((_req,res)=>{res.writeHead(500,{'content-type':'application/json'});res.end(JSON.stringify({error:'private-upstream-fixture-secret'}));});
  assert.equal((await runtime.send('模拟错误')).status,'error');assert(!JSON.stringify(runtime.read()).includes('private-upstream'));
  api.setHandler((_req,res)=>sse(res,'恢复了'));assert.equal((await runtime.send('再试一次')).text,'恢复了');
});

test('Anthropic setting selects the existing provider and uses its own message protocol',async t=>{
  const f=fixture(t),api=await upstream(t),runtime=f.create();await runtime.start();api.setHandler((_req,res)=>{res.writeHead(200,{'content-type':'text/event-stream'});res.end('event: content_block_delta\ndata: '+JSON.stringify({type:'content_block_delta',delta:{type:'text_delta',text:'原生协议'}})+'\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n');});
  await runtime.saveApi(config(api.baseUrl,{protocol:'anthropic'}));assert.equal((await runtime.send('你好')).text,'原生协议');assert.equal(api.requests[0].url,'/v1/messages');assert.equal(api.requests[0].headers['x-api-key'],'fixture-secret-only');
});

test('backend selection commits before changing memory and a failed encrypted save preserves previous config/key',async t=>{
  const f=fixture(t),runtime=f.create();await runtime.start();await runtime.saveApi(config('https://example.invalid/v1'));
  await runtime.selectBackend('neko');assert.equal(runtime.read().backend,'neko');await assert.rejects(runtime.send('不能双发'),/启用聊天/);await assert.rejects(runtime.memories());
  const previous=fs.readFileSync(runtime.configFile);f.safeStorage.encryptString=()=>{throw Error('private key detail');};await assert.rejects(runtime.saveApi(config('https://other.invalid/v1')),/保存失败/);assert.equal(runtime.backend,'neko');assert.deepEqual(fs.readFileSync(runtime.configFile),previous);assert.equal(await runtime.secretStore.get(),'fixture-secret-only');
  fs.renameSync(runtime.configFile,runtime.configFile+'.saved');fs.mkdirSync(runtime.configFile);let cancellations=0;const cancel=runtime.opened.service.cancel.bind(runtime.opened.service);runtime.opened.service.cancel=()=>{cancellations++;return cancel();};
  await assert.rejects(runtime.selectBackend('chat-api'));assert.equal(runtime.backend,'neko');assert.equal(cancellations,0,'failed selection does not cancel the current backend');
});

test('account provider shares companion history and native memory wiring while keeping API credentials separate',async t=>{
  const f=fixture(t),api=await upstream(t),inputs=[];
  const provider={async *stream(input){inputs.push(input);yield {type:'delta',text:'账号回复'};yield {type:'complete',messageId:'account-answer'};}};
  const runtime=f.create({accountProvider:provider});
  await runtime.start();await runtime.saveApi(config(api.baseUrl));
  assert.equal((await runtime.send('第一条')).status,'completed');
  const originalConversation=runtime.opened.service.conversationId;
  await runtime.selectBackend('deepseek-account');assert.equal(runtime.read().backend,'deepseek-account');
  assert.equal(runtime.opened.service.conversationId,originalConversation);
  assert.equal((await runtime.send('第二条')).text,'账号回复');
  assert.equal(inputs.length,1);assert.equal(inputs[0].persona.id,'bigfish');
  assert.deepEqual(inputs[0].messages.map(m=>m.text),['第一条','你好','第二条']);
  assert.equal((await runtime.memories()).replication.mode,'neko');
  assert.equal(await runtime.secretStore.get(),'fixture-secret-only');
  await runtime.selectBackend('chat-api');assert.equal((await runtime.send('第三条')).status,'completed');
  assert.equal(api.requests.length,2);assert.equal(runtime.opened.service.conversationId,originalConversation);
});

test('account backend without a provider fails closed without saving or sending a turn',async t=>{
  const f=fixture(t),runtime=f.create();await runtime.start();
  await assert.rejects(runtime.selectBackend('deepseek-account'),/尚未接入/);
  assert.equal(runtime.read().backend,'chat-api');
  fs.writeFileSync(runtime.configFile,JSON.stringify({backend:'deepseek-account',mainChat:runtime.settings}));
  await runtime.close();const restored=f.create();await restored.start();
  assert.equal(restored.read().backend,'deepseek-account');assert.equal(restored.read().ready,false);
  await assert.rejects(restored.send('不应保存'),/尚未接入/);assert.deepEqual(await restored.history(),[]);
});

test('safeStorage refuses unavailable/basic_text backends and can repair/rollback unreadable ciphertext',async t=>{
  const f=fixture(t),file=path.join(f.directory,'cipher'),safe=f.safeStorage,store=new WorkbenchSecretStore(file,safe);
  safe.getSelectedStorageBackend=()=> 'basic_text';assert.equal(store.available(),false);await assert.rejects(store.set('fixture-private'));assert(!fs.existsSync(file));
  safe.getSelectedStorageBackend=()=> 'keychain';await store.set('fixture-private');const old=fs.readFileSync(file),rollback=await store.prepareRollback();await store.set('second-fixture');await rollback();assert.deepEqual(fs.readFileSync(file),old);assert.equal(await store.get(),'fixture-private');
  fs.writeFileSync(file,'broken-ciphertext');const repair=new WorkbenchSecretStore(file,safe);await assert.rejects(repair.get());await repair.set('repaired');assert.equal(await repair.get(),'repaired');await repair.clear();assert.equal(repair.has(),false);
  safe.isEncryptionAvailable=()=>false;assert.equal(repair.available(),false);await assert.rejects(repair.set('not-saved'));assert(!fs.existsSync(file));
});
