'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(path.resolve(__dirname,'../../apps/neko-workbench/renderer.js'),'utf8');
function clock(){let time=0,id=0;const timers=new Map();return {now:()=>time,schedule:(fn,delay)=>{timers.set(++id,{fn,at:time+delay});return id;},cancel:id=>timers.delete(id),advance(ms){time+=ms;for(const [id,t]of [...timers])if(t.at<=time){timers.delete(id);t.fn();}}};}
function lifetime(){const context={};vm.runInNewContext(source.slice(source.indexOf('function installSpeechLifetime('),source.indexOf('// Settings submits')),context);return context.installSpeechLifetime;}
function fixture(){const c=clock(),bubble={hidden:true,classList:{remove(){}}},actor={chatReply:{id:'one',text:'hello',streaming:false}};let duration=60000;
 const feedback={showLocal(text){this.localText=text;bubble.hidden=!text;},renderBubble(){bubble.hidden=!this.localText;}};
 const policy=lifetime()({feedback,bubble,getActor:()=>actor,getDuration:()=>duration,...c});return {c,bubble,actor,feedback,policy,duration:v=>duration=v};}
test('completed speech expires after one minute and broadcasts cannot resurrect it',()=>{const f=fixture();f.feedback.showLocal('hello');f.c.advance(59000);assert(!f.bubble.hidden);f.feedback.renderBubble();f.c.advance(1000);assert(f.bubble.hidden);f.feedback.renderBubble();assert(f.bubble.hidden);f.feedback.showLocal('hello');assert(f.bubble.hidden);});
test('streaming has no expiry until completed; identical next message has a fresh deadline',()=>{const f=fixture();f.actor.chatReply.streaming=true;f.feedback.showLocal('hello');f.c.advance(120000);assert(!f.bubble.hidden);f.actor.chatReply.streaming=false;f.feedback.showLocal('hello');f.c.advance(59000);assert(!f.bubble.hidden);f.c.advance(1000);assert(f.bubble.hidden);f.actor.chatReply.id='two';f.feedback.showLocal('hello');assert(!f.bubble.hidden);});
test('duration changes apply from completion and persistent setting remains available',()=>{const f=fixture();f.feedback.showLocal('hello');f.c.advance(10000);f.duration(5000);f.policy.refresh();assert(f.bubble.hidden);f.actor.chatReply.id='two';f.duration(0);f.feedback.showLocal('hello');f.c.advance(3600001);assert(!f.bubble.hidden);f.policy.dispose();});
test('a late historical streaming snapshot cannot restore expired speech',()=>{const f=fixture();f.feedback.showLocal('hello');f.c.advance(60000);f.actor.chatReply.streaming=true;f.feedback.showLocal('hello');assert(f.bubble.hidden);});
let JSDOM;try{({JSDOM}=require(path.join(process.env.NEKO_DOM_DEPS||path.resolve(__dirname,'../../../.nekofans-build/test-dom'),'node_modules/jsdom')));}catch{}
function renderer(t){const dom=new JSDOM('<div id="app"></div>',{url:'file:///workbench/index.html?view=pet&actor=main',runScripts:'outside-only'}),w=dom.window,calls=[];t.after(()=>dom.window.close());let update;
 w.eval(fs.readFileSync(path.resolve(__dirname,'../../apps/neko-workbench/pet-chat-presentation.js'),'utf8'));
 w.DshPetFeedback=class{constructor(_a,_v,b){this.bubble=b;this.dragState={active:false};this.animations={drag:[]};}showLocal(text){this.localText=text;this.renderBubble();}renderBubble(){this.bubble.textContent=this.localText||'';this.bubble.hidden=!this.localText;}onWorkTick(){}playIdle(){}resumeWorkStatusAnim(){return false;}};
 w.PetContext={preview:()=>({})};w.PetShared={HIT_BOX:{x0:160,y0:90,x1:480,y1:270}};
 w.PetAppearance={ORIGINAL:'original',selected:()=> 'original',scaleFor:()=>1,frameAspect:()=>16/9,install:()=>({isCat:()=>false,isMedia:()=>false,render(){},dispose(){}})};
 const state={actors:[{id:'main',name:'大肥鱼',status:'idle',chatBackend:'chat-api',chatReply:{id:'test',text:'hello'},messages:[]}],preferences:{},neko:{}};
 w.pet={onState:fn=>update=fn,onInput(){},call:async(method,payload)=>{calls.push([method,payload]);return method==='state'?state:true;}};w.eval(source);
 return {w,calls,state,update};}
test('single click opens a blank white speech composer, submit works and double click opens workbench',{skip:!JSDOM},async t=>{
 const f=renderer(t);await new Promise(r=>setImmediate(r));const d=f.w.document,character=d.querySelector('.character'),form=d.querySelector('.chat');
 assert(form.hidden);assert(form.classList.contains('speech-composer'));assert(d.querySelector('.pet-tier').hidden);assert(d.querySelector('.pet-logo').hidden);
 character.dispatchEvent(new f.w.MouseEvent('click',{detail:0,bubbles:true}));assert(!form.hidden);assert.equal(form.querySelector('input').value,'');f.update(f.state);assert.equal(character.getAttribute('aria-expanded'),'true');
 form.querySelector('input').value='一起布置小窝';form.dispatchEvent(new f.w.Event('submit',{cancelable:true}));await new Promise(r=>setImmediate(r));assert(f.calls.some(([m,p])=>m==='prompt'&&p.text==='一起布置小窝'));assert(form.hidden);
 character.dispatchEvent(new f.w.MouseEvent('dblclick',{button:0,bubbles:true}));assert(f.calls.some(([m])=>m==='open-workbench'));
});
test('main pet transparent stage passes clicks through, body and editor remain interactive',{skip:!JSDOM},async t=>{
 const f=renderer(t);await new Promise(r=>setImmediate(r));const d=f.w.document,character=d.querySelector('.character');
 character.getBoundingClientRect=()=>({left:0,top:100,right:640,bottom:460,width:640,height:360});d.querySelector('.pet-bubble').hidden=true;
 f.w.dispatchEvent(new f.w.MouseEvent('mousemove',{clientX:10,clientY:110}));assert.equal(f.calls.at(-1)[1].ignore,true);
 f.w.dispatchEvent(new f.w.MouseEvent('mousemove',{clientX:320,clientY:280}));assert.equal(f.calls.at(-1)[1].ignore,false);
 character.dispatchEvent(new f.w.MouseEvent('click',{detail:0,bubbles:true}));d.querySelector('.chat').getBoundingClientRect=()=>({left:10,right:300,top:10,bottom:90});
 f.w.dispatchEvent(new f.w.MouseEvent('mousemove',{clientX:20,clientY:20}));assert.equal(f.calls.filter(([m])=>m==='pass-through').at(-1)[1].ignore,false);
});
test('decoded video alpha determines the model hit, including transparent pixels within the body rectangle',{skip:!JSDOM},async t=>{
 const f=renderer(t);await new Promise(r=>setImmediate(r));const d=f.w.document,character=d.querySelector('.character'),video=d.querySelector('video');
 const rect={left:0,top:100,right:640,bottom:460,width:640,height:360};character.getBoundingClientRect=video.getBoundingClientRect=()=>rect;video.classList.add('is-front');Object.defineProperties(video,{videoWidth:{value:640},videoHeight:{value:360}});
 let alpha=0;f.w.HTMLCanvasElement.prototype.getContext=()=>({clearRect(){},drawImage(){},getImageData:()=>({data:[0,0,0,alpha]})});d.querySelector('.pet-bubble').hidden=true;
 f.w.dispatchEvent(new f.w.MouseEvent('mousemove',{clientX:320,clientY:280}));assert.equal(f.calls.filter(([m])=>m==='pass-through').at(-1)[1].ignore,true);
 alpha=255;f.w.dispatchEvent(new f.w.MouseEvent('mousemove',{clientX:320,clientY:280}));assert.equal(f.calls.filter(([m])=>m==='pass-through').at(-1)[1].ignore,false);
 alpha=0;await new Promise(r=>setTimeout(r,220));assert.equal(f.calls.filter(([m])=>m==='pass-through').at(-1)[1].ignore,true,'stationary pointer is resampled as the video changes');
});
