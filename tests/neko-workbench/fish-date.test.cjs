'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {createCompanionMedia,splitMessage}=require('../../apps/neko-workbench/companion-media.cjs');
const base=path.resolve(__dirname,'../../apps/neko-workbench/embedded-dsh');
const png='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=';
function directory(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fish-date-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir;}
test('private media persists by content, rejects unsafe inputs and reconstructs an OpenAI image message',async t=>{
 const dir=directory(t),media=createCompanionMedia(dir),encoded=media.prepare('看看这张图',[{dataUrl:png,name:'test.png',kind:'sticker'}]);
 const parsed=splitMessage(encoded);assert.equal(parsed.text,'看看这张图');assert.equal(parsed.attachments[0].kind,'sticker');assert.equal(createCompanionMedia(dir).read(parsed.attachments[0].id).dataUrl,png);
 assert.throws(()=>media.prepare('bad',[{dataUrl:'data:image/svg+xml;base64,PHN2Zz4='}]),/图片格式/);assert.throws(()=>media.read('../secret'),/标识/);assert.throws(()=>media.prepare('',Array(5).fill({dataUrl:png})),/四张/);
 let body;await media.wrapFetch(async(_,init)=>{body=JSON.parse(init.body);return {};},'openai-compatible')('http://127.0.0.1/v1',{body:JSON.stringify({messages:[{role:'system',content:encoded},{role:'user',content:encoded}]})});
 assert.equal(body.messages[0].content,encoded,'private images are never expanded from system/memory text');assert.equal(body.messages[1].content[1].image_url.url,png);const account=media.accountMessages([{personaId:'bigfish',role:'user',text:encoded}])[0];assert.equal(account.text,'看看这张图');assert.equal(account.images[0].data,png.split(',')[1]);
});
test('Anthropic images use the image/source wire shape',async t=>{const media=createCompanionMedia(directory(t));const text=media.prepare('',[{dataUrl:png,name:'photo'}]);let body;await media.wrapFetch(async(_,init)=>{body=JSON.parse(init.body)},'anthropic')('http://127.0.0.1',{body:JSON.stringify({messages:[{role:'user',content:text}]})});assert.equal(body.messages[0].content[1].source.media_type,'image/png');});
test('ordinary text and invalid media markers remain intact; only the latest four images reach a model',async t=>{
 const media=createCompanionMedia(directory(t));
 for(const text of ['  原样保留  ','[[neko-media:broken]]','\n[[neko-media:W10]]'])assert.equal(splitMessage(text).text,text);
 const encoded=media.prepare('文字',[{dataUrl:png,name:'🐟'.repeat(50)}]);let body;
 await media.wrapFetch(async(_,init)=>{body=JSON.parse(init.body)},'openai-compatible')('http://127.0.0.1',{body:JSON.stringify({messages:Array.from({length:8},()=>({role:'user',content:encoded}))})});
 assert.equal(body.messages.flatMap(m=>m.content).filter(b=>b.type==='image_url').length,4);
 assert.equal(body.messages[0].content.some(b=>b.type==='image_url'),false);
 assert.equal(body.messages.at(-1).content.some(b=>b.type==='image_url'),true);
});
test('shared main-agent history keeps images across restart and pages through all messages without crossing conversations',async t=>{
 const {WorkbenchMainChat}=require('../../apps/neko-workbench/main-chat-runtime.cjs');
 const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'fish-date-runtime-')),inputs=[],runtimes=[];
 const create=()=>{const runtime=new WorkbenchMainChat({dataDir,repositoryRoot:path.resolve(__dirname,'../..'),initialBackend:'deepseek-account',safeStorage:{isEncryptionAvailable:()=>false},memoryWorker:{request:async()=>{throw Error('synthetic offline')},stop:async()=>{},close:async()=>{}},accountProvider:{async *stream(input){inputs.push(input);yield {type:'delta',text:'我在听呢'};yield {type:'complete',messageId:'synthetic-answer'};}}});runtimes.push(runtime);return runtime;};
 t.after(async()=>{for(const runtime of runtimes)await runtime.close();fs.rmSync(dataDir,{recursive:true,force:true})});
 let runtime=create();await runtime.start();const encoded=runtime.prepareMedia('今天想给你看看海',[{name:'海.png',dataUrl:png}]);
 const id=splitMessage(encoded).attachments[0].id;assert.throws(()=>runtime.readMedia(id),/会话/);
 assert.equal((await runtime.send(encoded)).status,'completed');let history=await runtime.history();
 assert.equal(history[0].text,'今天想给你看看海');assert.equal(runtime.readMedia(id).dataUrl,png);assert.equal(inputs[0].messages.at(-1).text,'今天想给你看看海');assert.equal(inputs[0].messages.at(-1).images[0].data,png.split(',')[1]);assert.doesNotMatch(JSON.stringify(inputs),/neko-media|base64/);
 const conversationId=runtime.opened.service.conversationId;await runtime.close();runtime=create();await runtime.start();assert.equal(runtime.opened.service.conversationId,conversationId);
 history=await runtime.history();assert.equal(history[0].attachments[0].id,id);assert.equal(runtime.readMedia(id).dataUrl,png);
 const store=new runtime.shared.SqliteConversationStore(path.join(runtime.dataDir,'conversations.sqlite'));
 try{for(let n=0;n<405;n++)await store.append({id:'archive-'+n,personaId:'bigfish',conversationId,role:'user',text:'历史 '+n,createdAt:Date.now()});await store.append({id:'elsewhere',personaId:'other',conversationId:'other-room',role:'user',text:'隔离会话',createdAt:Date.now()});}finally{store.close()}
 const latest=await runtime.history(),prior=await runtime.history({beforeId:latest[0].id}),first=await runtime.history({beforeId:prior[0].id});
 assert.equal(latest.length,200);assert.equal(prior.length,200);assert.equal(first.length,7);assert.equal(new Set([...first,...prior,...latest].map(m=>m.id)).size,407);
 await assert.rejects(runtime.history({beforeId:'elsewhere'}),/conversation/);
 await runtime.selectBackend('chat-api');assert.throws(()=>runtime.readMedia(id),/会话/);
});
test('room selector opens the private view, shares history, inserts emoji and preserves drafts on failure',async t=>{
 const {JSDOM}=require(path.join(process.env.NEKO_DOM_DEPS,'node_modules/jsdom'));const dom=new JSDOM('<body></body>',{runScripts:'outside-only',pretendToBeVisual:true});t.after(()=>dom.window.close());const w=dom.window,d=w.document;const calls=[];
 for(const file of ['fish-date-source.js','chatroom-preview-source.js'])w.eval(fs.readFileSync(path.join(base,file),'utf8'));
 let fail=false;const bridge={companion:async request=>{calls.push(request);if(request.action==='history')return [{id:'old',role:'user',text:'桌面上之前的聊天'}];if(request.action==='send'&&fail)throw Error('连接断开');return {};}};
 const view=w.createFishDateView({doc:d,bridge,avatar:()=>png});const panel=w.createChatroomPreview(d,()=>png,{mountHome:async()=>()=>{},createFishDate:()=>view.panel,onDateVisibility:open=>view.setOpen(open)});d.body.append(panel);panel.setSplit(true);
 const choices=[...d.querySelectorAll('.neko-chatroom-preview__room')];assert.match(choices[1].textContent,/我的小窝/);assert.match(choices[2].textContent,/肥鱼有约.*和她谈心/);
 choices[2].click();view.update({backend:'deepseek-account',ready:true,messages:[],working:false});await new Promise(r=>setTimeout(r,30));assert.equal(panel.dataset.roomView,'date');assert(!view.panel.hidden);assert.match(view.panel.textContent,/桌面上之前的聊天/);
 const input=d.querySelector('.neko-fish-date__form input');assert.equal(input.type,'text');d.querySelector('[aria-label="插入 😊"]').click();assert.equal(input.value,'😊');
 input.value='和她谈心';fail=true;d.querySelector('.neko-fish-date__form').dispatchEvent(new w.Event('submit',{cancelable:true}));await new Promise(r=>setTimeout(r,20));assert.equal(input.value,'和她谈心');assert.match(view.panel.textContent,/连接断开/);
 panel.showRooms();assert(view.panel.hidden);view.dispose();panel.disposeHome();
});
test('paste, stickers and IME use the shared send route and restore attachments after an asynchronous failure',async t=>{
 const {JSDOM}=require(path.join(process.env.NEKO_DOM_DEPS,'node_modules/jsdom'));
 const dom=new JSDOM('<body></body>',{runScripts:'outside-only',pretendToBeVisual:true});const w=dom.window,d=w.document,calls=[];
 t.after(()=>dom.window.close());w.eval(fs.readFileSync(path.join(base,'fish-date-source.js'),'utf8'));
 const bridge={companion:async r=>{calls.push(r);return r.action==='history'?[]:{accepted:true}}};
 const view=w.createFishDateView({doc:d,bridge,avatar:()=>png});t.after(()=>view.dispose());d.body.append(view.panel);view.update({backend:'deepseek-account',ready:true,messages:[]});view.setOpen(true);
 const input=d.querySelector('.neko-fish-date__form input'),form=d.querySelector('form');
 const paste=new w.Event('paste',{cancelable:true});Object.defineProperty(paste,'clipboardData',{value:{files:[new w.File([Buffer.from(png.split(',')[1],'base64')],'海.png',{type:'image/png'})]}});input.dispatchEvent(paste);await new Promise(r=>setTimeout(r,30));
 d.querySelector('[aria-label="贴贴"]').click();assert.equal(d.querySelectorAll('.neko-fish-date__preview').length,2);
 input.value='一起看看海';input.dispatchEvent(new w.CompositionEvent('compositionstart'));form.dispatchEvent(new w.Event('submit',{cancelable:true}));assert.equal(calls.filter(r=>r.action==='send').length,0);
 input.dispatchEvent(new w.CompositionEvent('compositionend'));form.dispatchEvent(new w.Event('submit',{cancelable:true}));await new Promise(r=>setTimeout(r,30));
 const sent=calls.find(r=>r.action==='send');assert.equal(sent.text,'一起看看海');assert.equal(sent.attachments[0].dataUrl,png);assert.equal(sent.attachments[1].kind,'sticker');assert.equal(input.value,'');
 view.update({backend:'deepseek-account',ready:true,messages:[],error:'回复失败',failedText:'一起看看海'});assert.equal(input.value,'一起看看海');assert.equal(d.querySelectorAll('.neko-fish-date__preview').length,2);
});
test('integrated room moves the existing pet, shifts the creation desk left and restores the original drafts',async t=>{
 const {JSDOM}=require(path.join(process.env.NEKO_DOM_DEPS,'node_modules/jsdom'));
 const {createWorkspaceLayout}=require('../../apps/neko-workbench/workspace-layout.cjs');
 const store=createWorkspaceLayout(path.join(directory(t),'layout.json'));
 const dom=new JSDOM('<body><aside data-neko-side-rail><div class="neko-side-rail__theme"></div></aside><aside data-slot="sidebar"><div data-neko-seat-mount></div><div data-slot="sidebar.workspaces"></div><footer><div data-slot="settings.launcher"></div></footer></aside><main><textarea>工作草稿</textarea></main></body>',{runScripts:'outside-only',pretendToBeVisual:true});
 const w=dom.window,d=w.document,sidebar=d.querySelector('[data-slot="sidebar"]'),calls=[];
 sidebar.getBoundingClientRect=()=>({left:64,right:364,top:0,bottom:800,width:300,height:800});d.querySelector('[data-neko-side-rail]').getBoundingClientRect=()=>({left:0,right:64,top:0,bottom:800,width:64,height:800});
 const bridge={action:async()=>({}),getState:async()=>({workspaceRoot:'/p',companion:{backend:'deepseek-account',ready:true,messages:[]}}),companion:async r=>r.action==='history'?[]:{},nativeComposer:async r=>{calls.push(r);return {ok:true}},subscribeNativeComposer:()=>()=>{},workspace:async r=>r.action==='state'?store.get():r.action==='update'?store.update(r.patch):r.action==='codex-state'?{items:[],approvals:[]}:r.action==='catalog'?{sessions:[],projects:[],providers:{dsh:'ready'}}:{}};
 for(const file of ['fish-date-source.js','chatroom-preview-source.js','workspace-shell-source.js'])w.eval(fs.readFileSync(path.join(base,file),'utf8'));
 const stop=w.installWorkspaceShell({window:w,document:d,bridge,avatar:()=>png,locateSidebar:()=>({root:sidebar,slot:sidebar})});
 t.after(()=>{stop();dom.window.close()});const tick=()=>new Promise(r=>setTimeout(r,60));await tick();
 const dock=d.querySelector('.neko-companion-dock'),pet=d.querySelector('.neko-companion-character'),oldInput=dock.querySelector('textarea');oldInput.value='原来的私聊草稿';
 d.querySelector('[aria-label="打开肥鱼有约，和她谈心"]').click();await tick();
 assert(dock.hidden);assert.equal(pet.parentElement,d.querySelector('.neko-fish-date__pet'));assert.equal(d.querySelectorAll('.neko-companion-character').length,1);
 const place=calls.filter(r=>r.action==='place').at(-1);assert(place,'creation desk placement sent');assert.equal(place.rect.x>=64&&place.rect.x<364,true,JSON.stringify(place));
 const input=d.querySelector('.neko-fish-date__form input');input.value='肥鱼有约草稿';
 d.querySelector('.neko-chatroom-preview').showRooms();await tick();
 assert(!dock.hidden);assert.equal(pet.parentElement,dock);assert.equal(oldInput.value,'原来的私聊草稿');assert.equal(d.querySelector('main textarea').value,'工作草稿');
 d.querySelector('[aria-label="打开肥鱼有约，和她谈心"]').click();await tick();assert.equal(input.value,'肥鱼有约草稿');
});
