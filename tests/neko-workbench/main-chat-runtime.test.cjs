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
function fixture(t){const directory=fs.mkdtempSync(path.join(os.tmpdir(),'neko-main-chat-'));const safeStorage=vault();const options={dataDir:directory,repositoryRoot:root,safeStorage};const runtimes=[];
  t.after(async()=>{for(const runtime of runtimes)await runtime.close();fs.rmSync(directory,{recursive:true,force:true});});
  const create=()=>{const runtime=new WorkbenchMainChat(options);runtimes.push(runtime);return runtime;};return {directory,options,safeStorage,create};}
function sse(res,text='你好'){res.writeHead(200,{'content-type':'text/event-stream'});res.write(`data: ${JSON.stringify({choices:[{delta:{content:text.slice(0,1)}}]})}\n\n`);res.end(`data: ${JSON.stringify({choices:[{delta:{content:text.slice(1)}}]})}\n\ndata: [DONE]\n\n`);}
async function upstream(t){const requests=[];let handler=(_req,res)=>sse(res);const server=createServer((req,res)=>{let text='';req.on('data',chunk=>text+=chunk);req.on('end',()=>{const record={url:req.url,headers:req.headers,body:JSON.parse(text)};requests.push(record);handler(record,res);});});
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);}));
  return {requests,baseUrl:`http://127.0.0.1:${server.address().port}/v1`,setHandler:fn=>{handler=fn;}};}
const config=(baseUrl,extra={})=>({protocol:'openai-compatible',baseUrl,model:'fixture-model',requestTimeoutMs:5000,maxOutputTokens:256,key:{action:'replace',value:'fixture-secret-only'},...extra});

test('new workbench uses independent unconfigured chat, encrypted key projection and existing shared service',async t=>{
  const f=fixture(t),runtime=f.create();await runtime.start();const snapshot=runtime.read();assert.equal(snapshot.backend,'chat-api');assert.equal(snapshot.ready,true);assert.equal(snapshot.hasKey,false);assert.equal(snapshot.voiceStatus,'未接入');
  assert.equal(snapshot.settings.personaId,'bigfish');assert(fs.existsSync(path.join(runtime.personasDir,'bigfish.json')));assert(!JSON.stringify(snapshot).includes('fixture-secret'));
  assert.equal((await runtime.send('你好')).status,'error');assert.equal(runtime.read().chat.phase,'error');
  const history=await runtime.history();assert.equal(history.length,1);assert.equal(history[0].role,'user');assert.equal(history[0].personaId,'bigfish');
});

test('actual loopback API streams; confirmed memory, edits, deletion, source summaries and restart use the same stores',async t=>{
  const f=fixture(t),api=await upstream(t);let runtime=f.create();await runtime.start();await runtime.saveApi({...config(api.baseUrl),personaId:'forged',apiKey:'must-not-persist'});
  const projections=[];runtime.subscribe(state=>projections.push(state));const result=await runtime.send('我喜欢乌龙茶');assert.equal(result.status,'completed');assert.equal(result.text,'你好');
  assert(projections.some(p=>p.chat.phase==='connecting'));assert(projections.some(p=>p.chat.phase==='replying'&&p.chat.reply==='你'));
  assert.equal(api.requests[0].url,'/v1/chat/completions');assert.equal(api.requests[0].headers.authorization,'Bearer fixture-secret-only');
  const storedConfig=fs.readFileSync(runtime.configFile,'utf8');assert(!storedConfig.includes('fixture-secret'));assert(!storedConfig.includes('must-not-persist'));assert.equal(JSON.parse(storedConfig).mainChat.personaId,'bigfish');
  const cipher=fs.readFileSync(runtime.secretStore.file);assert(!cipher.includes(Buffer.from('fixture-secret-only')));
  let memory=await runtime.memories();const proposal=memory.items.find(item=>item.text.includes('乌龙茶'));assert(proposal);assert.equal(proposal.confirmation,'pending');
  await runtime.send('我喝什么茶');assert(!api.requests.at(-1).body.messages[0].content.includes('乌龙茶'));
  await runtime.memoryAction({action:'confirm',id:proposal.id});await runtime.memoryAction({action:'update',id:proposal.id,text:'用户喜欢茉莉花茶'});
  await runtime.send('我的茶偏好是什么');assert(api.requests.at(-1).body.messages[0].content.includes('用户喜欢茉莉花茶'));
  await assert.rejects(runtime.memoryAction({action:'remove',id:proposal.id,personaId:'other'}));
  for(let n=0;n<10;n++)await runtime.send('继续聊天 '+n);
  memory=await runtime.memories();assert(memory.summaries.length>0);const summary=memory.summaries[0];const sources=await runtime.memoryAction({action:'sources',id:summary.id});assert(sources.length>0);assert(sources.every(row=>row.personaId==='bigfish'));
  const id=runtime.opened.service.conversationId,priorHistory=await runtime.history();await runtime.close();runtime=f.create();await runtime.start();assert.equal(runtime.opened.service.conversationId,id);assert.equal((await runtime.history()).length,priorHistory.length);
  memory=await runtime.memories();assert.equal(memory.items.find(item=>item.id===proposal.id).text,'用户喜欢茉莉花茶');
  await runtime.memoryAction({action:'remove',id:proposal.id});await runtime.memoryAction({action:'remove-summary',id:summary.id});assert(!(await runtime.memories()).items.some(item=>item.id===proposal.id));assert(!(await runtime.memories()).summaries.some(item=>item.id===summary.id));
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

test('safeStorage refuses unavailable/basic_text backends and can repair/rollback unreadable ciphertext',async t=>{
  const f=fixture(t),file=path.join(f.directory,'cipher'),safe=f.safeStorage,store=new WorkbenchSecretStore(file,safe);
  safe.getSelectedStorageBackend=()=> 'basic_text';assert.equal(store.available(),false);await assert.rejects(store.set('fixture-private'));assert(!fs.existsSync(file));
  safe.getSelectedStorageBackend=()=> 'keychain';await store.set('fixture-private');const old=fs.readFileSync(file),rollback=await store.prepareRollback();await store.set('second-fixture');await rollback();assert.deepEqual(fs.readFileSync(file),old);assert.equal(await store.get(),'fixture-private');
  fs.writeFileSync(file,'broken-ciphertext');const repair=new WorkbenchSecretStore(file,safe);await assert.rejects(repair.get());await repair.set('repaired');assert.equal(await repair.get(),'repaired');await repair.clear();assert.equal(repair.has(),false);
  safe.isEncryptionAvailable=()=>false;assert.equal(repair.available(),false);await assert.rejects(repair.set('not-saved'));assert(!fs.existsSync(file));
});
