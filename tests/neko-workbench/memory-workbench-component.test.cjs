const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),net=require('node:net');
const {createServer}=require('node:http');
const {WorkbenchMainChat}=require('../../apps/neko-workbench/main-chat-runtime.cjs');
const root=path.resolve(__dirname,'../..');
const vault={isEncryptionAvailable:()=>true,getSelectedStorageBackend:()=> 'keychain',encryptString:value=>Buffer.from('fixture:'+Buffer.from(value).toString('base64')),decryptString:bytes=>Buffer.from(bytes.toString().slice(8),'base64').toString()};
test('workbench sends once, extracts through native memory, confirms, recalls, corrects, deletes and restarts',{skip:process.env.NEKO_MEMORY_COMPONENT_TEST!=='1',timeout:180000},async t=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'neko-workbench-memory-')),requests=[];let extractions=0;
  const api=createServer((req,res)=>{let raw='';req.on('data',c=>raw+=c);req.on('end',()=>{const body=JSON.parse(raw);requests.push(body);
    if(body.stream){res.writeHead(200,{'content-type':'text/event-stream'});return res.end('data: '+JSON.stringify({choices:[{delta:{content:'合成聊天回复'}}]})+'\n\ndata: [DONE]\n\n');}
    extractions++;res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({id:'fixture',choices:[{index:0,finish_reason:'stop',message:{role:'assistant',content:JSON.stringify([{text:'合成用户最喜欢普洱茶',importance:6,entity:'master'}])}}],usage:{prompt_tokens:1,completion_tokens:1}}));
  });});await new Promise(r=>api.listen(0,'127.0.0.1',r));
  let runtime=new WorkbenchMainChat({dataDir:directory,repositoryRoot:root,safeStorage:vault});
  t.after(async()=>{await runtime.close();await new Promise(r=>{api.closeAllConnections();api.close(r);});fs.rmSync(directory,{recursive:true,force:true});});
  await runtime.start();assert.equal(runtime.read().memorySystem.mode,'neko');
  await runtime.saveApi({protocol:'openai-compatible',baseUrl:`http://127.0.0.1:${api.address().port}/v1`,model:'fixture-memory-chat',requestTimeoutMs:5000,maxOutputTokens:100,key:{action:'replace',value:'synthetic-model-key'}});
  assert.equal((await runtime.send('我喜欢普洱茶')).status,'completed');assert.equal(requests.filter(r=>r.stream).length,1);assert.equal((await runtime.history()).length,2);
  let result=await runtime.memoryAction({action:'sync'});assert.equal(result.ok,true);
  result=await runtime.memoryAction({action:'sync'});assert.equal(result.ok,true);assert(extractions>0);
  let view=await runtime.memories(),candidate=view.replication.records.find(r=>r.value?.nativeRef?.provider==='neko'&&r.value.text==='合成用户最喜欢普洱茶');assert(candidate);assert.equal(candidate.value.certainty,'candidate');
  result=await runtime.memoryAction({action:'event-confirm',id:candidate.itemId,revisionIds:candidate.heads.map(e=>e.eventId)});assert.equal(result.ok,true);
  await runtime.memoryAction({action:'sync'});assert.equal(runtime.memorySystem.status().mode,'neko');
  await runtime.send('我的普洱茶偏好是什么');let system=requests.filter(r=>r.stream).at(-1).messages[0].content;assert(system.includes('合成用户最喜欢普洱茶'));assert(system.includes('user-confirmed'));
  candidate=(await runtime.memories()).replication.records.find(r=>r.itemId===candidate.itemId);
  await runtime.memoryAction({action:'event-update',id:candidate.itemId,text:'合成用户改为喜欢红茶',revisionIds:candidate.heads.map(e=>e.eventId)});await runtime.memoryAction({action:'sync'});
  await runtime.send('红茶和普洱茶偏好');system=requests.filter(r=>r.stream).at(-1).messages[0].content;assert(system.includes('合成用户改为喜欢红茶'));assert(!system.includes('合成用户最喜欢普洱茶'));
  candidate=(await runtime.memories()).replication.records.find(r=>r.itemId===candidate.itemId);await runtime.memoryAction({action:'event-delete',id:candidate.itemId,revisionIds:candidate.heads.map(e=>e.eventId)});await runtime.memoryAction({action:'sync'});
  await runtime.send('红茶偏好');system=requests.filter(r=>r.stream).at(-1).messages[0].content;assert(!system.includes('合成用户改为喜欢红茶'));
  const history=(await runtime.history()).length,port=Number(new URL(runtime.memorySystem.worker.url).port);await runtime.close();
  await new Promise((resolve,reject)=>{const server=net.createServer();server.once('error',reject);server.listen(port,'127.0.0.1',()=>server.close(resolve));});
  runtime=new WorkbenchMainChat({dataDir:directory,repositoryRoot:root,safeStorage:vault});await runtime.start();assert.equal(runtime.memorySystem.status().mode,'neko');assert.equal((await runtime.history()).length,history);assert((await runtime.memories()).replication.records.find(r=>r.itemId===candidate.itemId).deleted);
});
test('independent Anthropic memory model keeps its key and protocol separate from OpenAI chat',{skip:process.env.NEKO_MEMORY_COMPONENT_TEST!=='1',timeout:90000},async t=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'neko-memory-anthropic-')),calls=[];
  const api=createServer((req,res)=>{let raw='';req.on('data',c=>raw+=c);req.on('end',()=>{const body=JSON.parse(raw);calls.push({url:req.url,headers:req.headers,body});
    if(body.stream){res.writeHead(200,{'content-type':'text/event-stream'});return res.end('data: '+JSON.stringify({choices:[{delta:{content:'合成回复'}}]})+'\n\ndata: [DONE]\n\n');}
    res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({id:'fixture-anthropic',type:'message',role:'assistant',model:'fixture-claude',content:[{type:'text',text:JSON.stringify([{text:'独立记忆模型提取的合成事实',importance:6,entity:'master'}])}],stop_reason:'end_turn',usage:{input_tokens:1,output_tokens:1}}));
  });});await new Promise(r=>api.listen(0,'127.0.0.1',r));
  const runtime=new WorkbenchMainChat({dataDir:directory,repositoryRoot:root,safeStorage:vault});t.after(async()=>{await runtime.close();await new Promise(r=>{api.closeAllConnections();api.close(r);});fs.rmSync(directory,{recursive:true,force:true});});
  await runtime.start();const baseUrl=`http://127.0.0.1:${api.address().port}/v1`;
  await runtime.saveApi({protocol:'openai-compatible',baseUrl,model:'fixture-openai',requestTimeoutMs:5000,maxOutputTokens:100,key:{action:'replace',value:'synthetic-chat-key'}});
  const configured=await runtime.memoryAction({action:'configure-neko',enabled:true,useChatApi:false,protocol:'anthropic',baseUrl,model:'fixture-claude',requestTimeoutMs:5000,key:{action:'replace',value:'synthetic-memory-only-key'}});assert.equal(configured.ok,true);await runtime.send('合成测试经历');
  assert.equal((await runtime.memoryAction({action:'sync'})).ok,true);
  const chat=calls.find(c=>c.body.stream),memory=calls.find(c=>!c.body.stream);assert.equal(chat.headers.authorization,'Bearer synthetic-chat-key');assert.equal(memory.url,'/v1/messages');assert.equal(memory.headers['x-api-key'],'synthetic-memory-only-key');
  assert((await runtime.memories()).replication.records.some(r=>r.value?.nativeRef&&r.value.text==='独立记忆模型提取的合成事实'));
  assert(!fs.readFileSync(runtime.memoryConfigFile,'utf8').includes('synthetic-memory-only-key'));assert(!fs.readFileSync(runtime.memorySecretStore.file).includes(Buffer.from('synthetic-memory-only-key')));
});
