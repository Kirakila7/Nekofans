'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {pathToFileURL}=require('node:url');
const {taskRecord,screenRecord,createProjectTracker}=require('../../apps/neko-workbench/activity-memory.cjs');
const {ScreenObservation}=require('../../apps/neko-workbench/screen-observation-runtime.cjs');
const {ScreenVision}=require('../../apps/neko-workbench/screen-vision.cjs');
const {createCodexWorkspace}=require('../../apps/neko-workbench/codex-workspace.cjs');
const {spawn}=require('node:child_process');
const {WorkbenchMainChat}=require('../../apps/neko-workbench/main-chat-runtime.cjs');
const root=path.resolve(__dirname,'../..');
test('task summary and completed screen observation reach durable NEKO memory and survive restart',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'activity-memory-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const {WorkbenchMemory}=await import(pathToFileURL(path.join(root,'apps/neko-workbench/memory/controller.mjs')).href);
 const sent=[];const worker={request:async(route,body)=>{
   if(route==='/health')return {ready:true,capabilities:{protocol:1,pull:true,push:true,idempotency:true,tombstones:true,privateMemory:true}};
   if(route.startsWith('/pull'))return {events:[],nextCursor:'0',hasMore:false};
   if(route==='/push'){sent.push(...body.events);return {ackedEventIds:body.events.map(e=>e.eventId)};}
   if(route==='/recall')return {values:sent.map(e=>e.value)};throw Error(route);
 },close:async()=>{}};
 const open=()=>new WorkbenchMemory({directory:path.join(dir,'memory'),dataDir:dir,repositoryRoot:root,getLegacy:async()=>null,worker,autoSyncIntervalMs:60000});
 let memory=open();const task=taskRecord({provider:'DSH',session:'s1',turn:'t1',task:'建立应用',result:'已完成界面与测试。\n```\nDO_NOT_COPY\n```'});
 await Promise.all(Array.from({length:8},()=>memory.recordActivity(task)));await memory.sync();
 assert.equal(sent.filter(e=>e.value.text.includes('完成结果摘要')).length,1);
 assert.equal(sent.find(e=>e.value.text.includes('完成结果摘要')).value.kind,'fact');
 await assert.rejects(memory.recordActivity({...task,text:'不同内容'}),/标识冲突/);
 assert(!JSON.stringify(sent).includes('DO_NOT_COPY'));
 const original=sent.length;let record;
 const observation=new ScreenObservation({observe:async()=>({text:'屏幕显示构建成功'}),onRecord:r=>{record=r}});
 const image='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+X2Z8AAAAASUVORK5CYII=';
 observation.start({id:'window:1:0',name:'测试'},{});observation.frame({generation:observation.generation,seq:1,capturedAt:Date.now(),width:1,height:1,image});
 for(let i=0;i<30&&!record;i++)await new Promise(r=>setTimeout(r,10));
 assert(record);await memory.recordActivity(screenRecord(record));await memory.sync();assert(sent.length>original);assert(!JSON.stringify(sent).includes(image));
 const recalled=await memory.recall('bigfish','构建成功',300);assert(recalled.some(item=>item.text.includes('构建成功')));
 await memory.close();memory=open();const saved=await memory.view();assert(saved.records.some(x=>x.value?.text.includes('构建成功')));assert(saved.records.some(x=>x.value?.text.includes('已完成界面')));await memory.close();
});
test('official free model is selected only for the isolated deployment preset',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'free-memory-config-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const old=process.env.NEKO_WORKBENCH_MEMORY_OFFICIAL_FREE;process.env.NEKO_WORKBENCH_MEMORY_OFFICIAL_FREE='1';t.after(()=>{if(old===undefined)delete process.env.NEKO_WORKBENCH_MEMORY_OFFICIAL_FREE;else process.env.NEKO_WORKBENCH_MEMORY_OFFICIAL_FREE=old});
 const worker={request:async()=>{throw Error('offline')},stop:async()=>{},close:async()=>{}};
 const runtime=new WorkbenchMainChat({dataDir:dir,repositoryRoot:root,safeStorage:{isEncryptionAvailable:()=>false},memoryWorker:worker});
 await runtime.start();const config=await runtime.memoryModel();assert.equal(config.model,'free-model');assert.equal(config.baseUrl,'https://www.lanlan.tech/text/v1');assert.equal(runtime.readMemoryModel().officialFree,true);await runtime.close();
});
test('DSH completed turns from distinct projects record only final text, never tool output or failures',()=>{
 const entries=[],tracker=createProjectTracker(v=>entries.push(v));
 for(const session of ['project-a','project-b']){
   tracker.accept(session,{type:'turn/start',seq:42});
   tracker.accept(session,{type:'user/message',data:{source:{kind:'user'},content:[{type:'text',text:'完成项目'}]}});
   tracker.accept(session,{type:'tool/result',data:{content:'PRIVATE_TOOL_OUTPUT'}});
   tracker.accept(session,{type:'assistant/message',data:{message:{content:[{type:'text',text:'结果已完成'}]}}});
   tracker.accept(session,{type:'turn/end',data:{reason:{kind:session==='project-a'?'completed':'failed'}}});
 }
 assert.equal(entries.length,1);assert.match(entries[0].text,/结果已完成/);assert(!JSON.stringify(entries).includes('PRIVATE_TOOL_OUTPUT'));
});
test('only nonempty task outputs and text observations become events',()=>{
 assert.equal(taskRecord({provider:'DSH',session:'s',turn:'t',result:'```secret```'}),null);
 assert.equal(screenRecord({id:'1',text:''}),null);
 assert(!taskRecord({provider:'Codex',session:'s',turn:'t',result:'api_key=verysecretvalue'}).text.includes('verysecretvalue'));
});
test('screen context recalls NEKO memory only after destination consent',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'screen-neko-memory-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const personaDir=path.join(dir,'personas');fs.mkdirSync(personaDir);fs.copyFileSync(path.join(root,'config/personas/bigfish.json'),path.join(personaDir,'bigfish.json'));
 let recalls=0,request;
 const settings={protocol:'openai-compatible',baseUrl:'https://example.invalid/v1',model:'fixture',requestTimeoutMs:5000,maxOutputTokens:100};
 const chat={settings,personasDir:personaDir,opened:{},secretStore:{get:async()=> 'fixture',has:()=>true},history:async()=>[],memorySystem:{recall:async()=>{recalls++;return [{text:'项目测试已经完成'}]}}};
 const vision=new ScreenVision({dataDir:dir,repositoryRoot:root,getChat:()=>chat,fetch:async(_url,options)=>{request=JSON.parse(options.body);return new Response('data: {"choices":[{"delta":{"content":"看到了"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}})}});
 const input={frame:{image:'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+X2Z8AAAAASUVORK5CYII='},question:'项目进度',target:settings,signal:new AbortController().signal};
 await vision.observe(input);assert.equal(recalls,0);assert(!JSON.stringify(request).includes('项目测试已经完成'));
 await vision.observe({...input,contextConsent:settings});assert.equal(recalls,1);assert(JSON.stringify(request).includes('项目测试已经完成'));
});
test('completed Codex turns yield a result without command output',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'codex-activity-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const file=path.join(dir,'server.cjs');fs.writeFileSync(file,`const rl=require('node:readline').createInterface({input:process.stdin});const out=x=>process.stdout.write(JSON.stringify(x)+'\\n');rl.on('line',l=>{const m=JSON.parse(l);if(!m.id)return;let result={};if(m.method==='thread/list')result={data:[{id:'one',name:'项目',cwd:${JSON.stringify(dir)},status:{type:'idle'},updatedAt:1}],nextCursor:null};if(m.method==='thread/resume')result={thread:{id:'one',name:'项目',cwd:${JSON.stringify(dir)},status:{type:'idle'},updatedAt:1}};if(m.method==='turn/start'){const threadId=m.params.threadId;out({method:'turn/started',params:{threadId,turn:{id:'turn-1'}}});out({method:'item/completed',params:{threadId,turnId:'turn-1',item:{id:'tool',type:'commandExecution',aggregatedOutput:'PRIVATE_TOOL_OUTPUT'}}});out({method:'item/completed',params:{threadId,turnId:'turn-1',item:{id:'reply',type:'agentMessage',text:'项目结果已交付'}}});out({method:'turn/completed',params:{threadId,turn:{id:'turn-1',status:'completed',items:[]}}});result={turn:{id:'turn-1',status:'inProgress',items:[]}};}out({id:m.id,result});});`);
 const events=[],c=createCodexWorkspace({defaultCwd:dir,resolveExecutable:()=>'/fixture',spawnProcess:(_e,_a,options)=>spawn(process.execPath,[file],options),onCompleted:value=>events.push(value),timeoutMs:2000});t.after(()=>c.dispose());
 await c.list();await c.send({id:'one',cwd:dir,message:'完成项目'});assert.equal(events.length,1);assert.equal(events[0].result,'项目结果已交付');assert(!JSON.stringify(events).includes('PRIVATE_TOOL_OUTPUT'));
});
test('main companion chat sends completed conversation into same NEKO delivery ledger',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'chat-unified-memory-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const delivered=[];const worker={request:async(route,body)=>{if(route==='/health')return {ready:true,capabilities:{protocol:1,pull:true,push:true,idempotency:true,tombstones:true,privateMemory:true}};if(route.startsWith('/pull'))return {events:[],nextCursor:'0',hasMore:false};if(route==='/push'){delivered.push(...body.events);return {ackedEventIds:body.events.map(e=>e.eventId)};}if(route==='/recall')return {values:[]};throw Error(route)},stop:async()=>{},close:async()=>{}};
 const safeStorage={isEncryptionAvailable:()=>true,getSelectedStorageBackend:()=> 'keychain',encryptString:s=>Buffer.from(s),decryptString:b=>b.toString()};
 const runtime=new WorkbenchMainChat({dataDir:dir,repositoryRoot:root,safeStorage,memoryWorker:worker,fetch:async()=>new Response('data: {"choices":[{"delta":{"content":"收到"}}]}\n\ndata: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}})});
 await runtime.start();await runtime.saveApi({protocol:'openai-compatible',baseUrl:'https://example.invalid/v1',model:'fixture',requestTimeoutMs:5000,maxOutputTokens:100,key:{action:'replace',value:'fixture'}});
 const reply=await runtime.send('主角色测试问题');assert.equal(reply.status,'completed');await runtime.memorySystem.sync();
 assert(delivered.some(e=>e.value?.text?.includes('主角色测试问题')&&e.value.text.includes('收到')));await runtime.close();
});
