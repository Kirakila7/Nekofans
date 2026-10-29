'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const A=require('../../apps/neko-workbench/pet-appearance.js');
const {syncTaskRecord,promoteTaskRecord,restoreDesktopActor}=require('../../apps/neko-workbench/task-pets.cjs');

test('all three role appearance defaults remain independent and actor choices survive native revalidation',()=>{
 const state={preferences:A.normalizePreferences({helperLimit:5,taskAppearance:'https://untrusted.invalid/cat.gif'}),actors:[],positions:{},taskOrder:[]};
 assert.equal(state.preferences.taskAppearance,A.ORIGINAL);assert.equal(state.preferences.helperLimit,5);
 assert.equal(A.setDefault(state,'task',A.CAT),true);assert.equal(A.setDefault(state,'main',A.CLAUDE),true);assert.equal(A.setDefault(state,'subagent','../secret'),false);
 const task=syncTaskRecord(state,{source:'dsh-task-session',sessionId:'real-task',running:true}).actor;
 assert.equal(A.selected(state,task),A.CAT);assert.equal(A.selected(state,{id:'main',appearanceId:A.CAT}),A.CAT);assert.equal(A.selected(state,{id:'subagent-child',kind:'subagent'}),A.ORIGINAL);
 A.setActor(task,A.ORIGINAL);assert.equal(A.selected(state,task),A.ORIGINAL);assert.equal(A.setActor(task,'data:image/svg+xml,evil'),false);
 syncTaskRecord(state,{source:'dsh-task-session',sessionId:'real-task',running:false});assert.equal(task.appearanceId,A.ORIGINAL);
 promoteTaskRecord(state,{source:'dsh-subagent-catalog',sessionId:'real-task',parentSessionId:'parent'});assert.equal(task.appearanceId,A.ORIGINAL);
 A.setActor(task,A.CAT);const restored=restoreDesktopActor(JSON.parse(JSON.stringify(task)),{});assert.equal(A.selected(state,restored),A.CAT);assert.equal(restored.metadataReady,false);
 A.setActor(restored,null);assert.equal(A.selected(state,restored),A.ORIGINAL);A.setDefault(state,'subagent',A.CAT);assert.equal(A.selected(state,restored),A.CAT);
 assert.equal(A.setActor({id:'main'},A.CAT),true);assert.equal(A.selected(state,{id:'main'}),A.CLAUDE);
});

class Element {
 constructor(){this.dataset={};this.children=[];this.attrs=new Map();this.classList={remove(){}};this.srcWrites=0;}
 appendChild(child){this.children.push(child);}setAttribute(key,value){this.attrs.set(key,value);}removeAttribute(key){this.attrs.delete(key);if(key==='src')this._src='';}remove(){this.removed=true;}
 set src(value){this._src=value;this.srcWrites++;}get src(){return this._src;}
}
function fixture(reduced=false){
 const character=new Element(),videos=[new Element(),new Element()],listeners=new Set(),calls=[],insets=[];
 for(const video of videos){video.pause=()=>video.paused=true;video.load=()=>video.loaded=true;}
 const media={matches:reduced,addEventListener(_name,callback){listeners.add(callback);},removeEventListener(_name,callback){listeners.delete(callback);}};
 const original=function(name,once){calls.push([name,once]);this.pending={gen:++this.gen};};
 const feedback={gen:8,pending:{gen:8},switchTo:original,dragState:{active:false},resumeWorkStatusAnim(){this.switchTo('restore-working',false);return true;},playIdle(){this.switchTo('idle',true);}};
 const presenter=A.install({character,videos,feedback,document:{createElement:()=>new Element()},matchMedia:()=>media,onHeadInset:value=>insets.push(value)});
 return {character,videos,feedback,presenter,media,listeners,calls,insets,original,motion:character.children[0],image:character.children[0].children[0]};
}
test('native kitten switches live without stale video playback, keeps work state, stops patrol for drag and restores original media',()=>{
 const f=fixture(),actor={id:'task-real',kind:'task',active:true,status:'working',work:{state:'thinking'}},state={preferences:{taskAppearance:A.CAT}};
 f.presenter.render(state,actor);assert.equal(f.motion.hidden,false);assert.equal(f.image.src,A.assets.idle);assert.equal(f.motion.dataset.phase,'idle');assert(f.videos.every(v=>v.hidden&&v.paused&&v.loaded));
 const oldVideoReady=()=>{if(f.feedback.pending&&f.feedback.pending.gen!==8)return;assert.fail('old video must remain cancelled');};oldVideoReady();
 const writes=f.image.srcWrites;f.presenter.render(state,actor);f.feedback.switchTo('thinking',false);assert.equal(f.image.srcWrites,writes);assert.deepEqual(f.calls,[]);
 f.feedback.dragState.active=true;f.feedback.switchTo('drag',true);assert.equal(f.image.src,A.assets.drag);assert.equal(f.motion.dataset.phase,'drag');
 f.feedback.dragState.active=false;actor.active=false;actor.status='success';actor.work.state='success';f.presenter.render(state,actor);assert.equal(f.image.src,A.assets.success);
 state.preferences.taskAppearance=A.ORIGINAL;f.presenter.render(state,actor);assert.equal(f.motion.hidden,true);assert(f.videos.every(v=>!v.hidden));assert.deepEqual(f.calls,[['restore-working',false]]);
 f.presenter.dispose();assert.equal(f.feedback.switchTo,f.original);assert.equal(f.motion.removed,true);assert.equal(f.listeners.size,0);
});
test('reduced motion and failed native media use a local still without error loops or resetting every state broadcast',()=>{
 const f=fixture(true),actor={id:'subagent-real',kind:'subagent',appearanceId:A.CAT,active:true};
 f.presenter.render({},actor);assert.equal(f.image.src,A.assets.still);assert.equal(f.motion.dataset.reduced,'true');
 f.media.matches=false;for(const listener of f.listeners)listener();assert.equal(f.image.src,A.assets.running);
 f.image.onerror();assert.equal(f.image.src,A.assets.still);const count=f.image.srcWrites;f.image.onerror();f.presenter.render({},actor);assert.equal(f.image.srcWrites,count);
 f.presenter.dispose();for(const listener of f.listeners)listener();assert.equal(f.image.src,'');
});

test('desktop cat direction and return animation follow motion without rewriting task success',()=>{
 const f=fixture(),actor={id:'subagent-real',kind:'subagent',appearanceId:A.CAT,active:false,status:'success',work:{state:'success'}};
 f.presenter.render({},actor);f.presenter.setMotion({phase:'returning',moving:true,direction:1});
 assert.equal(f.image.src,A.assets.running);assert.equal(f.motion.dataset.desktop,'true');assert.equal(f.motion.dataset.direction,'right');assert.equal(actor.work.state,'success');
 f.presenter.setMotion({phase:'gathered',moving:false,direction:-1});assert.equal(f.image.src,A.assets.success);
 f.presenter.setMotion(null);assert.equal(f.motion.dataset.desktop,'false');f.presenter.dispose();
});
test('bundled native cat assets retain their pinned bytes, transparency-capable formats and original license',()=>{
 const root=path.resolve(__dirname,'../../apps/neko-workbench/assets/neko-cat'),source=JSON.parse(fs.readFileSync(path.join(root,'SOURCE.json'),'utf8'));
 assert.equal(source.source,'Project-N-E-K-O/N.E.K.O');
 for(const entry of source.files){const bytes=fs.readFileSync(path.join(root,entry.file));assert.equal(bytes.subarray(0,6).toString(),'GIF89a');assert.equal(bytes.readUInt16LE(6),512);assert.equal(bytes.readUInt16LE(8),512);assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'),entry.sha256);assert.equal(crypto.createHash('sha1').update(Buffer.from('blob '+bytes.length+'\0')).update(bytes).digest('hex'),entry.gitBlob);}
 assert.match(fs.readFileSync(path.join(root,source.sourceLicense),'utf8'),/Apache License/);
 assert.equal(fs.readFileSync(path.join(root,'still.png')).subarray(1,4).toString(),'PNG');
});


test('Claude and Gemini poses follow real states independently from model identity; compact sizes can be customized',()=>{
 const state={preferences:A.normalizePreferences({})};
 for(const id of [A.CLAUDE,A.GEMINI]){
  const actor={id:'main',appearanceId:id,chatBackend:'chat-api',sessionId:null,status:'idle',work:{state:null}};
  assert.match(A.sourceFor(id,actor),id===A.CLAUDE?/review.webp$/:/idle.webp$/);actor.active=true;actor.work.state='thinking';assert.match(A.sourceFor(id,actor),/review.webp$/);
  actor.work.state='working';assert.match(A.sourceFor(id,actor),/running.webp$/);actor.active=false;actor.work.state='error';assert.match(A.sourceFor(id,actor),id===A.CLAUDE?/waiting.webp$/:/failed.webp$/);
  actor.work.state='success';assert.match(A.sourceFor(id,actor),id===A.CLAUDE?/waving.webp$/:/jumping.webp$/);
  assert.match(A.sourceFor(id,actor,{dragging:true}),/waving.webp$/);assert.match(A.sourceFor(id,actor,{reduced:true}),/still.png$/);assert.equal(actor.chatBackend,'chat-api');assert.equal(actor.sessionId,null);
 }
 const cat={id:'subagent-x',appearanceId:A.CAT};assert.equal(A.scaleFor(state,cat),.65);assert.equal(A.setScale(cat,.4),true);assert.equal(A.scaleFor(state,cat),.4);assert.equal(A.setScale(cat,Infinity),false);assert.equal(A.setScale(cat,2),false);A.setScale(cat,null);assert.equal(A.scaleFor(state,cat),.65);
});
test('custom imports stay local and survive role restoration with a first-frame reduced-motion fallback',()=>{
 const root=path.resolve(__dirname,'../../apps/neko-workbench/assets/neko-cat'),png=fs.readFileSync(path.join(root,'still.png')),gif=fs.readFileSync(path.join(root,'cat-idle-cat4-3.gif'));
 const value={name:'my cat',animated:true,frameCount:29,dataUrl:'data:image/gif;base64,'+gif.toString('base64'),stillDataUrl:'data:image/png;base64,'+png.toString('base64')},actor={id:'main',chatBackend:'chat-api'};
 assert.equal(A.setCustom(actor,value),true);assert.equal(A.selected({},actor),A.CUSTOM);assert.equal(A.sourceFor(A.CUSTOM,actor),value.dataUrl);assert.equal(A.sourceFor(A.CUSTOM,actor,{reduced:true}),value.stillDataUrl);assert.equal(A.sourceFor(A.CUSTOM,actor,{failed:true}),value.stillDataUrl);
 for(const dataUrl of ['https://example.invalid/private.png','data:image/svg+xml;base64,PHN2Zz4=','data:image/png;base64,ZXZpbA==','data:image/png;base64,'+'A'.repeat(A.MAX_CUSTOM_BYTES*2)])assert.equal(A.validCustom({dataUrl}),false);
 assert.equal(A.setDefault({preferences:{}},'task',A.CUSTOM),false);assert.equal(actor.chatBackend,'chat-api');
 const f=fixture();f.presenter.render({},actor);assert.equal(f.image.src,value.dataUrl);f.media.matches=true;for(const listener of f.listeners)listener();assert.equal(f.image.src,value.stillDataUrl);f.presenter.dispose();
});
test('all bundled Claude and Gemini states are genuine multi-frame WebP with pinned hashes and source license',()=>{
 const root=path.resolve(__dirname,'../../apps/neko-workbench/assets/ai-girls'),source=JSON.parse(fs.readFileSync(path.join(root,'SOURCE.json'),'utf8'));
 assert.equal(source.license,'CC BY-NC 4.0');
 const {animationFrames}=require('../../apps/neko-workbench/pet-appearance-import.cjs');
 for(const entry of source.files){const bytes=fs.readFileSync(path.join(root,entry.file));assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'),entry.sha256);if(entry.file.endsWith('.webp')){assert(entry.frames>1);assert(entry.uniqueFrames>1);assert.equal(animationFrames(bytes,'image/webp'),entry.frames);assert.equal(bytes.subarray(0,4).toString(),'RIFF');assert.equal(bytes.subarray(8,12).toString(),'WEBP');}}
 for(const id of [A.CLAUDE,A.GEMINI])for(const work of ['thinking','working','success','error',null]){const file=A.sourceFor(id,{active:work==='working',work:{state:work}});assert(fs.existsSync(path.resolve(__dirname,'../../apps/neko-workbench',file)));}
});

test('pixel alternatives render on all three roles, follow real work states and keep existing character choices',()=>{
 for(const tier of ['main','task','subagent'])for(const id of [A.CLAUDE_PIXEL,A.GEMINI_PIXEL]){
  const state={preferences:A.normalizePreferences({})},actor={id:tier==='main'?'main':tier+'-real',kind:tier==='task'?'task':'subagent',sessionId:tier==='main'?null:'real-session',parentSessionId:tier==='subagent'?'real-parent':null,chatBackend:tier==='main'?'chat-api':'dsh',status:'idle',work:{state:null}},identity=JSON.stringify([actor.id,actor.sessionId,actor.parentSessionId,actor.chatBackend]);
  assert(A.setDefault(state,tier,id));assert.equal(A.selected(state,actor),id);assert.equal(A.frameAspect(state,actor),A.pixelFrames[id].width/A.pixelFrames[id].height);
  const f=fixture();f.presenter.render(state,actor);assert.match(f.image.src,/pixel-ai-girls\/(claude|gemini)\/idle.webp$/);
  actor.active=true;actor.status='working';
  for(const [work,clip]of [['thinking','think'],['working','type'],['result','check'],['waiting','read'],['success','success'],['error','failed']]){actor.work.state=work;f.presenter.render(state,actor);assert(f.image.src.endsWith('/'+clip+'.webp'));assert.equal(A.headInset(state,actor),(A.pixelFrames[id].tops[clip]-A.pixelFrames[id].y)/A.pixelFrames[id].height);}
  f.feedback.dragState.active=true;f.feedback.switchTo('drag',true);assert(f.image.src.endsWith('/walk-left.webp'));assert.equal(f.insets.at(-1),A.headInset(state,actor,{dragging:true}));
  const writes=f.image.srcWrites;f.presenter.render(state,actor);assert.equal(f.image.srcWrites,writes,'a state broadcast must not restart the same animation');
  f.media.matches=true;for(const listener of f.listeners)listener();assert(f.image.src.endsWith('/still.png'));assert.equal(f.insets.at(-1),A.headInset(state,actor,{reduced:true}));f.media.matches=false;for(const listener of f.listeners)listener();f.image.onerror();assert(f.image.src.endsWith('/still.png'));assert.equal(f.insets.at(-1),A.headInset(state,actor,{failed:true}));
  const saved=JSON.parse(JSON.stringify(actor));if(tier!=='main')Object.assign(saved,restoreDesktopActor(saved,{}));assert.equal(A.selected(JSON.parse(JSON.stringify(state)),saved),id);
  assert(A.setActor(actor,A.GEMINI));f.presenter.render(state,actor);assert.match(f.image.src,/assets\/ai-girls\/gemini\//);assert.equal(JSON.stringify([actor.id,actor.sessionId,actor.parentSessionId,actor.chatBackend]),identity);
  f.presenter.dispose();
 }
});

test('pixel animation files retain source attribution, eight distinct source frames and exact looping timings',()=>{
 const root=path.resolve(__dirname,'../../apps/neko-workbench/assets/pixel-ai-girls'),source=JSON.parse(fs.readFileSync(path.join(root,'SOURCE.json'),'utf8'));
 assert.equal(source.repository,'https://github.com/Hjh-12138/DSH-Pixel-Toons');assert.equal(source.commit,'973c6bdbeffd272e2bc35f7065ba2f7d42fbe7e8');
 assert.match(fs.readFileSync(path.join(root,source.licenseFile),'utf8'),/MIT License/);assert.match(fs.readFileSync(path.join(root,source.noticeFile),'utf8'),/Unofficial fan/);
 assert.deepEqual(source.displayViewports.claude,A.pixelFrames[A.CLAUDE_PIXEL]);assert.deepEqual(source.displayViewports.gemini,A.pixelFrames[A.GEMINI_PIXEL]);
 const {animationFrames}=require('../../apps/neko-workbench/pet-appearance-import.cjs'),animations=source.files.filter(entry=>entry.file.endsWith('.webp'));assert.equal(animations.length,18);
 for(const entry of source.files){
  const bytes=fs.readFileSync(path.join(root,entry.file));assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'),entry.sha256);
  if(!entry.file.endsWith('.webp'))continue;
  assert.equal(animationFrames(bytes,'image/webp'),8);assert.equal(entry.frames,8);assert.equal(entry.uniqueFrames,8);assert.equal(new Set(entry.sourceFrames).size,8);assert.deepEqual(entry.size,[256,256]);
  let duration=0,loop=null;for(let pos=12;pos+8<=bytes.length;){const name=bytes.subarray(pos,pos+4).toString(),size=bytes.readUInt32LE(pos+4);if(name==='ANIM')loop=bytes.readUInt16LE(pos+12);if(name==='ANMF'){const ms=bytes.readUIntLE(pos+20,3);assert.equal(ms,125);duration+=ms;}pos+=8+size+size%2;}
  assert.equal(loop,0);assert.equal(duration,1000);
 }
 for(const id of [A.CLAUDE_PIXEL,A.GEMINI_PIXEL])for(const work of ['thinking','working','result','waiting','success','error',null])assert(fs.existsSync(path.resolve(__dirname,'../../apps/neko-workbench',A.sourceFor(id,{active:work==='working',work:{state:work}}))));
});
