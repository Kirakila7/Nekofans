'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {WorkbenchMainChat}=require('../../apps/neko-workbench/main-chat-runtime.cjs');
const {ScreenVision,parseSettings,imageParts,visionTarget}=require('../../apps/neko-workbench/screen-vision.cjs');
const {ScreenObservation}=require('../../apps/neko-workbench/screen-observation-runtime.cjs');
const root=path.resolve(__dirname,'../..');
const jpeg='data:image/jpeg;base64,'+Buffer.from([255,216,...Array(30).fill(7)]).toString('base64');
const observe=(v,args)=>v.observe({target:visionTarget(v.effective().config),...args});
async function fixture(t){
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'neko-vision-'));const requests=[];
 const safeStorage={isEncryptionAvailable:()=>true,getSelectedStorageBackend:()=> 'keychain',encryptString:s=>Buffer.from('cipher-'+s),decryptString:b=>b.toString().slice(7)};
 const fakeFetch=async(url,options)=>{const body=JSON.parse(options.body),pathname=new URL(url).pathname;requests.push({body,url:pathname,headers:options.headers});
  if(body.model==='reject-image')return new Response('private-token-secret-body',{status:400});
  if(body.model==='truncated')return new Response('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n');
  if(pathname.endsWith('/messages'))return new Response('event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"text":"看到了"}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n');
  return new Response('data: {"choices":[{"delta":{"content":"看"}}]}\n\ndata: {"choices":[{"delta":{"content":"到了"},"finish_reason":"stop"}],"usage":{"prompt_tokens":12,"completion_tokens":3}}\n\ndata: [DONE]\n\n');
 };
 // Vision consent tests exercise the legacy memory.list boundary directly;
 // prevent the independent native memory worker and its background sync from
 // racing the per-test read gates or starting a real local service.
 const memoryWorker={request:async()=>{throw Error('fixture memory worker offline');},stop:async()=>{},close:async()=>{}};
 const chat=new WorkbenchMainChat({dataDir:directory,repositoryRoot:root,safeStorage,memoryWorker});await chat.start();
 clearInterval(chat.memorySystem.timer);
 const baseUrl='https://vision.example.test/v1';
 await chat.saveApi({protocol:'openai-compatible',baseUrl,model:'fixture-vision',requestTimeoutMs:2000,maxOutputTokens:256,key:{action:'replace',value:'fixture-private'}});
 const vision=new ScreenVision({dataDir:directory,repositoryRoot:root,safeStorage,getChat:()=>chat,fetch:fakeFetch});
 t.after(async()=>{await chat.close();fs.rmSync(directory,{recursive:true,force:true});});
 return {vision,chat,requests,baseUrl,directory};
}
test('default image request does not read or send private memory, chat or prior observations',async t=>{
 const {vision:v,chat,requests}=await fixture(t);const texts=[];
 let memoryReads=0,chatReads=0;chat.opened.memory.list=async()=>{memoryReads++;return [{text:'PRIVATE_MEMORY',confirmation:'confirmed'}]};chat.history=async()=>{chatReads++;return [{role:'user',text:'PRIVATE_CHAT'}]};
 const result=await observe(v,{frame:{image:jpeg},question:'画面是什么？',history:[{text:'PRIVATE_OLD_OBSERVATION'}],signal:new AbortController().signal,onText:text=>texts.push(text)});
 assert.equal(result.text,'看到了');assert.deepEqual(texts,['看','看到了']);assert.deepEqual(result.usage,{inputTokens:12,outputTokens:3});
 assert.equal(requests[0].body.messages.at(-1).content[1].image_url.url,jpeg);assert.equal(memoryReads,0);assert.equal(chatReads,0);assert(!JSON.stringify(requests[0].body).includes('PRIVATE_'));
 assert.equal(requests[0].headers.authorization,'Bearer fixture-private');assert(!JSON.stringify(v.read()).includes('fixture-private'));
});
test('explicit consent is bound to exact API address and model, and changed destination fails closed',async t=>{
 const {vision:v,chat,requests,baseUrl}=await fixture(t);chat.opened.memory.list=async()=>[{personaId:'bigfish',text:'PRIVATE_MEMORY',confirmation:'confirmed'}];chat.history=async()=>[{role:'user',text:'PRIVATE_CHAT'}];
 const contextConsent={protocol:'openai-compatible',baseUrl:new URL(baseUrl).href.replace(/\/+$/, ''),model:'fixture-vision'};
 await observe(v,{frame:{image:jpeg},question:'what',contextConsent,signal:new AbortController().signal});const body=JSON.stringify(requests[0].body);assert(body.includes('PRIVATE_MEMORY'));assert(body.includes('PRIVATE_CHAT'));
 await v.save({mode:'custom',protocol:'openai-compatible',baseUrl,model:'other-model',key:{action:'replace',value:'separate-private'}});
 await assert.rejects(observe(v,{frame:{image:jpeg},contextConsent,signal:new AbortController().signal}),/重新确认/);assert.equal(requests.length,1);
});
test('custom Anthropic vision settings encrypt a separate key',async t=>{
 const {vision:v,baseUrl,requests}=await fixture(t);await v.save({mode:'custom',protocol:'anthropic',baseUrl,model:'fixture-anthropic',key:{action:'replace',value:'separate-private'}});
 const result=await observe(v,{frame:{image:jpeg},question:'what',signal:new AbortController().signal});assert.equal(result.text,'看到了');
 assert.equal(requests[0].url,'/v1/messages');assert.equal(requests[0].headers['x-api-key'],'separate-private');assert.equal(requests[0].body.messages[0].content[0].type,'image');assert(!fs.readFileSync(v.file,'utf8').includes('private'));
});
test('image incompatibility and incomplete streams report bounded errors without leaking upstream data',async t=>{
 const {vision:v,baseUrl}=await fixture(t);
 for(const model of ['reject-image','truncated']){
  await v.save({mode:'custom',protocol:'openai-compatible',baseUrl,model,key:{action:'replace',value:'fixture-private'}});
  await assert.rejects(observe(v,{frame:{image:jpeg},signal:new AbortController().signal}),e=>e.code==='api'&&!e.message.includes('private'));
 }
});
test('a cancelled request never fetches, and secrets are absent from settings projection',async t=>{
 const {vision:v,requests}=await fixture(t);const controller=new AbortController();controller.abort();await assert.rejects(observe(v,{frame:{image:jpeg},signal:controller.signal}),/停止/);assert.equal(requests.length,0);
});
test('only bounded image data and safe configured destinations are accepted',()=>{
 for(const url of ['http://example.com/v1','https://user:secret@example.com/v1','https://example.com/v1?key=secret','file:///tmp/x'])assert.throws(()=>parseSettings({mode:'custom',protocol:'openai-compatible',baseUrl:url,model:'x'}));
 assert.throws(()=>imageParts('https://example.com/a.jpg'));assert.throws(()=>imageParts('data:image/jpeg;base64,AAAA'));assert.equal(imageParts(jpeg).mime,'image/jpeg');
});
test('changed protocol, full address or model fails closed without context sharing in both connection modes',async t=>{
 const {vision:v,chat,requests,baseUrl}=await fixture(t);
 for(const mode of ['chat','custom']) {
  if(mode==='custom') await v.save({mode:'custom',protocol:'openai-compatible',baseUrl,model:'fixture-vision',key:{action:'replace',value:'key'}});
  const original={...(mode==='chat'?chat.settings:v.settings)},target=visionTarget(original);
  for(const change of [{protocol:'anthropic'},{baseUrl:'https://vision.example.test/other'},{model:'other-model'}]) {
   if(mode==='chat') chat.settings={...original,...change}; else v.settings={...original,...change};
   await assert.rejects(v.observe({frame:{image:jpeg},target,signal:new AbortController().signal}),/重新确认/);
   assert.equal(requests.length,0);
  }
  if(mode==='chat') chat.settings=original; else v.settings=original;
 }
});
test('target change while awaiting a key or private history stops before fetch',async t=>{
 for(const waitOn of ['key','history']) {
  const {vision:v,chat,requests}=await fixture(t),target=visionTarget(chat.settings);
  let release,entered;const waiting=new Promise(resolve=>entered=resolve);
  if(waitOn==='key')chat.secretStore.get=()=>{entered();return new Promise(resolve=>release=()=>resolve('fixture-private'));};
  else chat.history=()=>{entered();return new Promise(resolve=>release=()=>resolve([]));};
  const pending=v.observe({frame:{image:jpeg},target,contextConsent:waitOn==='history'?target:null,signal:new AbortController().signal});
  await waiting;chat.settings={...chat.settings,baseUrl:'https://changed.example.test/v1'};release();
  await assert.rejects(pending,/重新确认/);assert.equal(requests.length,0);
 }
});
test('cancelling during key, memory or history access stops before the next private read and before fetch',async t=>{
 for(const waitOn of ['key','memory','history']) {
  const {vision:v,chat,requests}=await fixture(t),target=visionTarget(chat.settings),controller=new AbortController();
  const reads=[];let release,entered;const waiting=new Promise(resolve=>entered=resolve);
  const gate=(name,result)=>{reads.push(name);if(name!==waitOn)return Promise.resolve(result);entered();return new Promise(resolve=>release=()=>resolve(result));};
  chat.secretStore.get=()=>gate('key','fixture-private');
  chat.opened.memory.list=()=>gate('memory',[]);
  chat.history=()=>gate('history',[]);
  const pending=v.observe({frame:{image:jpeg},target,contextConsent:target,signal:controller.signal});
  await waiting;controller.abort();release();
  await assert.rejects(pending,error=>error.code==='cancelled');
  const expected={key:['key'],memory:['key','memory'],history:['key','memory','history']};
  assert.deepEqual(reads,expected[waitOn]);assert.equal(requests.length,0);
 }
});
test('a changed provider pauses a running observation before the next frame is sent',async t=>{
 const {vision:v,chat,requests}=await fixture(t),target=visionTarget(chat.settings);
 const runtime=new ScreenObservation({observe:args=>v.observe(args)});t.after(()=>runtime.stop());
 runtime.start({id:'window:1:0',name:'test'},target);chat.settings={...chat.settings,model:'other-model'};
 runtime.frame({generation:runtime.generation,seq:1,capturedAt:Date.now(),width:10,height:10,image:jpeg});
 for(let i=0;i<10&&runtime.phase==='sharing';i++)await new Promise(resolve=>setImmediate(resolve));
 assert.equal(runtime.phase,'paused');assert.match(runtime.error,/重新确认/);assert.equal(requests.length,0);
});
