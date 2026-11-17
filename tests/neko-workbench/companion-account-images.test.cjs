'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {createRequire}=require('node:module');
const {createCompanionMedia,splitMessage}=require('../../apps/neko-workbench/companion-media.cjs');
const {createCompanionAccountProvider}=require('../../apps/neko-workbench/companion-account-provider.cjs');
const {createCompanionAccountBridge}=require('../../apps/neko-workbench/companion-account-bridge.cjs');
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=','base64');
const image={mime:'image/png',data:png.toString('base64'),name:'合成图.png'};
const route={provider:'deepseek-account',model:'deepseek-flash',reasoningEffort:'high'};
function directory(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'companion-images-'));t.after(()=>{assert.equal(path.dirname(path.resolve(dir)),path.resolve(os.tmpdir()));assert(path.basename(dir).startsWith('companion-images-'));const writable=p=>{for(const item of fs.readdirSync(p,{withFileTypes:true})){const file=path.join(p,item.name);if(item.isDirectory()&&!item.isSymbolicLink())writable(file);else if(item.isFile())fs.chmodSync(file,0o600);}};writable(dir);fs.rmSync(dir,{recursive:true,force:true,maxRetries:5,retryDelay:50});});return dir;}
function fixture({namespace='companion',modalities=['text','image'],store}={}){
 const calls=[];const attachments=store||{saveImages:async inputs=>{calls.push({saved:inputs});return inputs.map((input,i)=>({attachmentId:'synthetic-'+i,mediaType:input.mediaType}));}};
 const ctx={get:key=>key==='attachments'?attachments:{getState:async()=>({status:'credential-stored'})},llm:{prepareCall:async config=>{calls.push({config});return {config,inputModalities:modalities,stream:async function*(options){calls.push({options});yield {type:'text-delta',index:0,text:'合成响应'};yield {type:'finish',reason:{kind:'stop'}};}};}}};
 const bridge=createCompanionAccountBridge({ctx,route,namespace,createUserMessage:m=>({...m,role:'user'}),createAssistantMessage:m=>({...m,role:'assistant'})});
 return {calls,bridge,send:input=>bridge.send({requestId:namespace+'-test',text:'看看这张图',maxTokens:100,...input})};
}
test('private account bridge sends actual images on the original account route, without a project session or tools',async()=>{
 const f=fixture();await f.send({images:[image]});const call=f.calls.find(c=>c.options).options;
 assert.deepEqual(f.calls[0].config,{...route,maxTokens:100});assert.equal(call.messages[0].content[1].type,'image');assert.deepEqual(f.calls.find(c=>c.saved).saved[0].data,png);
 assert.equal(call.tools,undefined);assert.equal(call.sessionId,undefined);assert.equal(call.messages[0].source.kind,'user');
});
test('model capability failure does not silently replace the image with a text marker or change the billing route',async()=>{
 const f=fixture({modalities:['text']});await assert.rejects(f.send({images:[image]}),/未开放图片能力/);assert.equal(f.calls.length,1);assert.equal(f.calls[0].config.provider,'deepseek-account');
});
test('images stay out of public, proactive, memory and assistant contexts; malformed batches make no model calls',async()=>{
 for(const namespace of ['lobby','proactive','memory']){const f=fixture({namespace});await assert.rejects(f.send({images:[image]}),/图片用途/);assert.equal(f.calls.length,0);}
 for(const input of [{images:Array(5).fill(image)},{images:[{...image,data:'not base64'}]},{images:[{...image,mime:'image/gif'}]},{history:[{role:'user',text:'之前'},{role:'assistant',text:'回答',images:[image]}]}]){const f=fixture();await assert.rejects(f.send(input),/图片/);assert.equal(f.calls.length,0);}
});
test('same-role user history keeps its original image order and no image bytes enter system context',async()=>{
 const f=fixture();await f.send({context:'人物与记忆',history:[{role:'user',text:'旧照片',images:[image]}],images:[{...image,name:'第二张.png'}]});
 const call=f.calls.find(c=>c.options).options;assert.equal(call.system,'人物与记忆');assert.equal(call.messages.length,1);assert.deepEqual(call.messages[0].content.map(b=>b.type),['text','image','image']);assert.equal(call.messages[0].content[0].text,'旧照片\n\n看看这张图');
});
test('media account projection uses only the latest four private user images and verifies stored bytes',t=>{
 const dir=directory(t),media=createCompanionMedia(dir),encoded=media.prepare('照片',[{dataUrl:'data:image/png;base64,'+image.data,name:'photo'}]);
 const rows=media.accountMessages(Array.from({length:6},(_,i)=>({personaId:'bigfish',role:'user',text:encoded,id:i})));
 assert.equal(rows.flatMap(m=>m.images||[]).length,4);assert(!rows[0].images);assert(rows.at(-1).images);assert.doesNotMatch(JSON.stringify(rows),/neko-media/);
 assert.equal(media.accountMessages([{personaId:'other',role:'user',text:encoded}])[0].text,encoded);
 const id=splitMessage(encoded).attachments[0].id;fs.writeFileSync(path.join(dir,'media',id+'.bin'),Buffer.from('tampered'));assert.throws(()=>media.accountMessages([{personaId:'bigfish',role:'user',text:encoded}]),/校验失败/);
});
test('account provider preserves image attachments through its private RPC and history normalization',async()=>{
 const calls=[],provider=createCompanionAccountProvider(async(method,value)=>{calls.push({method,value});return {text:'合成回复'};});
 for await(const _ of provider.stream({persona:{id:'bigfish'},signal:new AbortController().signal,maxOutputTokens:100,messages:[{personaId:'bigfish',role:'user',text:'旧图',images:[image]},{personaId:'bigfish',role:'assistant',text:'已收到'},{personaId:'bigfish',role:'user',text:'新图',images:[image]}]})){}
 assert.equal(calls[0].method,'companion-account-chat');assert.deepEqual(calls[0].value.images,[image]);assert.deepEqual(calls[0].value.history[0].images,[image]);assert(!calls[0].value.history[1].images);
});
test('browser accepts an image with an empty MIME type and detects GIF bytes automatically',async t=>{
 const {JSDOM}=require(path.join(process.env.NEKO_DOM_DEPS,'node_modules/jsdom'));const dom=new JSDOM('<body/>',{runScripts:'outside-only',pretendToBeVisual:true});t.after(()=>dom.window.close());const w=dom.window,d=w.document;
 w.eval(fs.readFileSync(path.resolve(__dirname,'../../apps/neko-workbench/embedded-dsh/fish-date-source.js'),'utf8'));
 const view=w.createFishDateView({doc:d,avatar:()=>'',bridge:{companion:async r=>r.action==='history'?[]:{}}});t.after(()=>view.dispose());d.body.append(view.panel);view.update({backend:'deepseek-account',ready:true,messages:[]});view.setOpen(true);
 const gif=Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7','base64');const paste=new w.Event('paste',{cancelable:true});Object.defineProperty(paste,'clipboardData',{value:{files:[new w.File([gif],'wrong.jpg',{type:''})]}});d.querySelector('.neko-fish-date__form input').dispatchEvent(paste);await new Promise(r=>setTimeout(r,30));
 assert.match(d.querySelector('.neko-fish-date__preview img').src,/^data:image\/gif;base64,/);
 const media=createCompanionMedia(directory(t)),encoded=media.prepare('',[{name:'wrong.jpg',dataUrl:'data:image/png;base64,'+gif.toString('base64')}]);assert.equal(splitMessage(encoded).attachments[0].mime,'image/gif');
});
test('real bundled DSH image store and GIF decoder retain temporal frames through the private account stream',{skip:!process.env.NEKO_NATIVE_DSH_ASAR},async t=>{
 const native=createRequire(path.join(process.env.NEKO_NATIVE_DSH_ASAR,'dsh/node_modules/@deepseek-ai/dsh-attachment-local/package.json'));
 const sharp=native('sharp'),{Context}=native('@deepseek-ai/cordis'),{LocalAttachmentStore}=native('@deepseek-ai/dsh-attachment-local'),llm=native('@deepseek-ai/dsh-llm');
 const context=new Context();t.after(()=>context.scope?.dispose?.());const dir=directory(t),store=new LocalAttachmentStore(context,{dshHome:dir});
 const raw=Buffer.concat([Buffer.from(Array(9).fill([255,0,0]).flat()),Buffer.from(Array(9).fill([0,255,0]).flat()),Buffer.from(Array(9).fill([0,0,255]).flat())]);
 const gif=await sharp(raw,{raw:{width:3,height:9,channels:3,pageHeight:3}}).gif({delay:[100,100,100],loop:0}).toBuffer();assert.equal((await sharp(gif).metadata()).pages,3);
 const media=createCompanionMedia(path.join(dir,'private-media')),encoded=media.prepare('这是什么变化？',[{name:'实际动图.jpg',dataUrl:'data:image/png;base64,'+gif.toString('base64')}]);
 const requests=[];const ctx={get:key=>key==='attachments'?store:{getState:async()=>({status:'credential-stored'})},llm:{prepareCall:async config=>({config,inputModalities:['text','image'],stream:async function*(options){requests.push({config,options});yield {type:'text-delta',index:0,text:'fixture-only-response'};yield {type:'finish',reason:{kind:'stop'}};}})}};
 const bridge=createCompanionAccountBridge({ctx,route,createUserMessage:llm.createUserMessage,createAssistantMessage:llm.createAssistantMessage,loadImageDecoder:()=>sharp});
 const provider=createCompanionAccountProvider(async(method,input)=>{assert.equal(method,'companion-account-chat');return bridge.send(input);});
 for await(const _ of provider.stream({persona:{id:'bigfish'},signal:new AbortController().signal,maxOutputTokens:100,messages:media.accountMessages([{personaId:'bigfish',role:'user',text:encoded}])})){}
 const request=requests[0];assert.equal(request.config.provider,'deepseek-account');assert.equal(request.config.model,'deepseek-flash');const content=request.options.messages[0].content;assert.match(content.find(b=>b.text?.includes('GIF')).text,/共 3 帧/);
 const refs=content.filter(b=>b.type==='image');assert.equal(refs.length,3);const colors=[];for(const ref of refs){const saved=await store.readImage(ref.attachment);const bytes=saved.data||saved;const pixels=await sharp(bytes).removeAlpha().raw().toBuffer();colors.push([...pixels.subarray(0,3)]);}assert.deepEqual(colors,[[255,0,0],[0,255,0],[0,0,255]]);
});
