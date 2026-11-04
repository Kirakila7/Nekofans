'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {createNativeComposerAdapter}=require('../../apps/neko-workbench/embedded-dsh/native-composer-source.js');
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=','base64');
const tick=()=>new Promise(r=>setTimeout(r,30));
function fixture(t){
 const {JSDOM}=require(path.join(process.env.NEKO_DOM_DEPS,'node_modules/jsdom'));
 const dom=new JSDOM('<body><textarea id="work-input"></textarea></body>',{runScripts:'outside-only',pretendToBeVisual:true});const w=dom.window,d=w.document;
 t.after(()=>dom.window.close());w.eval(fs.readFileSync(path.resolve(__dirname,'../../apps/neko-workbench/embedded-dsh/fish-date-source.js'),'utf8'));
 const state={draft:'已有的工作草稿',draftRev:1,phase:'plain',attachmentIds:[],occurrences:[]},nativeEvents=[],calls=[];
 const shell={state:{getSnapshot:()=>structuredClone(state),subscribe:()=>()=>{}},actions:{setDraft(text){state.draft=text;state.draftRev++;},persistDraft(){},submit(){nativeEvents.push('native-send');}}},binding={sessionId:'work',session:{sessionId:'work'}};
 const adapter=createNativeComposerAdapter({getSelection:()=>({sessionId:'work'}),getMainSessionId:()=> 'work',getBinding:()=>binding,getShell:()=>shell});t.after(()=>adapter.dispose());
 // DSH's retained input installs document-level file-drop handlers without
 // consulting defaultPrevented. Keep that behavior to catch double intake.
 for(const type of ['dragenter','dragover','dragleave','drop','paste','change'])d.addEventListener(type,event=>{
  nativeEvents.push(type);if((type==='drop'&&event.dataTransfer?.files?.length)||(type==='paste'&&event.clipboardData?.files?.length)||(type==='change'&&event.target.type==='file')){state.attachmentIds.push('native-file');state.draftRev++;}
 });
 const view=w.createFishDateView({doc:d,avatar:()=>'',bridge:{companion:async request=>{calls.push(request);return request.action==='history'?[]:{accepted:true};}}});t.after(()=>view.dispose());d.body.append(view.panel);view.update({backend:'deepseek-account',ready:true,messages:[]});view.setOpen(true);
 const image=()=>new w.File([png],'私聊图片.png',{type:'image/png'});
 function event(type,property,value){const e=new w.Event(type,{bubbles:true,cancelable:true});Object.defineProperty(e,property,{value});return e;}
 return {w,d,view,state,adapter,nativeEvents,calls,image,event,input:d.querySelector('.neko-fish-date__form input')};
}
test('pasted private images never reach the retained workspace while the private send retains the bytes',async t=>{
 const f=fixture(t),event=f.event('paste','clipboardData',{files:[f.image()]});f.input.value='私聊草稿';f.input.dispatchEvent(event);await tick();
 assert(event.defaultPrevented);assert.equal(f.d.querySelectorAll('.neko-fish-date__preview').length,1);assert.deepEqual(f.nativeEvents,[]);assert.equal(f.adapter.snapshot().available,true);assert.equal(f.state.draft,'已有的工作草稿');assert.deepEqual(f.state.attachmentIds,[]);
 f.d.querySelector('.neko-fish-date__form').dispatchEvent(new f.w.Event('submit',{bubbles:true,cancelable:true}));await tick();const sent=f.calls.find(r=>r.action==='send');assert.equal(sent.text,'私聊草稿');assert.equal(sent.attachments[0].dataUrl,'data:image/png;base64,'+png.toString('base64'));assert.equal(f.state.draft,'已有的工作草稿');
});
test('private file drag/drop does not activate or populate native document attachment handlers',async t=>{
 const f=fixture(t),transfer={types:['Files'],files:[f.image()]};
 for(const type of ['dragenter','dragover','dragleave','dragenter','drop']){const event=f.event(type,'dataTransfer',transfer);f.view.panel.dispatchEvent(event);assert(event.defaultPrevented);}
 await tick();assert.equal(f.d.querySelectorAll('.neko-fish-date__preview').length,1);assert.deepEqual(f.nativeEvents,[]);assert.equal(f.adapter.snapshot().available,true);assert.deepEqual(f.state.attachmentIds,[]);
});
test('native workspace still receives its own files and correctly preserves the rich-draft warning',t=>{
 const f=fixture(t),event=f.event('drop','dataTransfer',{types:['Files'],files:[f.image()]});f.d.querySelector('#work-input').dispatchEvent(event);
 assert.deepEqual(f.nativeEvents,['drop']);assert.deepEqual(f.state.attachmentIds,['native-file']);assert.equal(f.adapter.snapshot().available,false);assert.match(f.adapter.snapshot().reason,/当前草稿包含引用、附件或指令/);assert.equal(f.d.querySelectorAll('.neko-fish-date__preview').length,0);
});
test('private intake preserves an existing real work attachment and does not hide its warning',async t=>{
 const f=fixture(t);f.state.attachmentIds.push('existing-work-image');const before=f.adapter.snapshot();assert.equal(before.available,false);
 f.input.dispatchEvent(f.event('paste','clipboardData',{files:[f.image()]}));await tick();assert.equal(f.d.querySelectorAll('.neko-fish-date__preview').length,1);assert.deepEqual(f.nativeEvents,[]);assert.deepEqual(f.state.attachmentIds,['existing-work-image']);assert.equal(f.adapter.snapshot().reason,before.reason);assert.equal(f.state.draft,'已有的工作草稿');
});
test('private text paste keeps its browser default; file picker changes and rejected private drops remain private',async t=>{
 const f=fixture(t),plain=f.event('paste','clipboardData',{files:[],getData:()=> '私聊文字'});f.input.dispatchEvent(plain);assert.equal(plain.defaultPrevented,false);assert.deepEqual(f.nativeEvents,[]);
 const picker=f.d.querySelector('input[type=file]');Object.defineProperty(picker,'files',{value:[f.image()]});picker.dispatchEvent(new f.w.Event('change',{bubbles:true}));await tick();assert.equal(f.d.querySelectorAll('.neko-fish-date__preview').length,1);assert.deepEqual(f.nativeEvents,[]);
 const bad=f.event('drop','dataTransfer',{types:['Files'],files:[new f.w.File(['not an image'],'private.pdf',{type:'application/pdf'})]});f.view.panel.dispatchEvent(bad);await tick();assert.match(f.d.querySelector('.neko-fish-date__notice').textContent,/仅支持/);assert.deepEqual(f.nativeEvents,[]);assert.equal(f.adapter.snapshot().available,true);
});
