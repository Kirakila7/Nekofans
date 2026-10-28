'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {createReplyPresenter}=require('../../apps/neko-workbench/pet-chat-presentation.js');

test('latest API reply remains persistent while streaming, after completion and during unrelated state updates',()=>{
  const calls=[],presenter=createReplyPresenter({showLocal:(text,options)=>calls.push({text,options})});
  const actor={chatReply:{id:'turn',text:'hello',streaming:true},notice:null};
  presenter.render(actor);assert.deepEqual(calls.at(-1),{text:'hello',options:{persistent:true}});
  actor.chatReply={...actor.chatReply,text:'hello world',streaming:false};presenter.render(actor);
  assert.deepEqual(calls.at(-1),{text:'hello world',options:{persistent:true}});
  const count=calls.length;presenter.render(actor);assert.equal(calls.length,count);
  actor.chatReply={id:'next',text:'',streaming:true};presenter.render(actor);
  assert.deepEqual(calls.at(-1),{text:'',options:{persistent:false}},'a new turn clears the previous reply');
});

test('errors are not erased by empty or historical replies and reset restores replies on backend return',()=>{
  const calls=[],presenter=createReplyPresenter({showLocal:(text,options)=>calls.push({text,options})});
  const actor={chatReply:{id:'failed',text:'',streaming:false},notice:{id:'error',text:'API request failed'}};
  presenter.render(actor);assert.equal(calls.at(-1).text,'API request failed');
  assert.equal(calls.at(-1).options.persistent,true,'API errors stay available until the next action');
  actor.chatReply={id:'old',text:'old successful reply',streaming:false};presenter.render(actor);
  assert.equal(calls.length,1,'history refresh cannot overwrite an error');
  actor.notice=null;presenter.render(actor);assert.equal(calls.at(-1).options.persistent,true);
  presenter.reset();presenter.render(actor);assert.equal(calls.length,4);
});

test('leaving API mode clears its persistent reply once without wiping later N.E.K.O. feedback',()=>{
  const calls=[],feedback={showLocal:text=>calls.push(text)},presenter=createReplyPresenter(feedback);
  presenter.render({chatReply:{id:'api',text:'API reply'},notice:null});
  assert.equal(presenter.reset(),true);assert.equal(calls.at(-1),'');
  feedback.showLocal('N.E.K.O. reply');
  assert.equal(presenter.reset(),false);assert.equal(calls.at(-1),'N.E.K.O. reply');
});

test('actual feedback adapter expires transient notices but never times out a persistent reply',()=>{
  const timers=new Map();let id=0;
  const context={window:{PetShared:{},DshPetWorkConfig:{}},setTimeout:fn=>{timers.set(++id,fn);return id;},clearTimeout:key=>timers.delete(key)};
  vm.runInNewContext(fs.readFileSync(path.resolve(__dirname,'../../apps/neko-workbench/original/feedback.js'),'utf8'),context);
  const feedback=Object.create(context.window.DshPetFeedback.prototype);feedback.renderBubble=()=>{};
  feedback.showLocal('temporary notice');assert.equal(timers.size,1);
  for(const fn of [...timers.values()])fn();assert.equal(feedback.localText,null);
  feedback.showLocal('last reply',{persistent:true});assert.equal(timers.size,0);assert.equal(feedback.localText,'last reply');
  feedback.showLocal('');assert.equal(feedback.localText,'');assert.equal(timers.size,0);
});

test('screen feedback streams through main pet presenter and pause restores ordinary chat',()=>{
  const calls=[],presenter=createReplyPresenter({showLocal:text=>calls.push(text)}),actor={chatReply:{id:'chat',text:'普通聊天',streaming:false}};
  presenter.render(actor);actor.screenReply={id:'screen',text:'画面反馈',streaming:true};presenter.render(actor);assert.equal(calls.at(-1),'画面反馈');
  actor.screenReply={...actor.screenReply,text:'画面反馈完成',streaming:false};presenter.render(actor);assert.equal(calls.at(-1),'画面反馈完成');
  actor.screenReply=null;presenter.render(actor);assert.equal(calls.at(-1),'普通聊天');
});

test('only tiny subagents run continuously; a subsection runs in the air and returns to real work on landing',()=>{
  const C=require('../../apps/neko-workbench/pet-chat-presentation.js'),A=require('../../apps/neko-workbench/pet-appearance.js');
  const a={id:'helper-native',kind:'subagent',sessionId:'native',active:false,status:'error',work:{state:'error',tick:4}};const before=JSON.stringify(a),visual=C.animationActor(a);
  assert.equal(JSON.stringify(a),before);assert.equal(visual.status,'error');assert.equal(visual.presentationRunning,true);
  assert.equal(A.sourceFor(A.CAT,visual,{desktopMotion:{phase:'resting',moving:false}}),A.assets.running);
  assert.match(A.sourceFor(A.CLAUDE,visual),/running\.webp$/);assert.match(A.sourceFor(A.GEMINI_PIXEL,visual),/walk-left\.webp$/);
  const task={...a,id:'task-native',kind:'task',active:true,status:'working',work:{state:'thinking',tick:4}};
  assert.equal(C.animationActor(task),task);assert.equal(C.animationActor(task,{phase:'spawning'}).presentationRunning,true);
  const landed=C.animationActor(task,{phase:'resting'});assert.equal(landed,task);
  assert.match(A.sourceFor(A.GEMINI_PIXEL,landed),/think\.webp$/);assert.match(A.sourceFor(A.CLAUDE,landed),/review\.webp$/);
  assert.equal(A.sourceFor(A.CAT,landed,{desktopMotion:{phase:'resting',moving:false}}),A.assets.idle);
  assert.equal(C.animationActor({id:'main'}).presentationRunning,undefined);
});
let JSDOM;try{({JSDOM}=require(path.join(process.env.NEKO_DOM_DEPS||'/private/tmp/neko-sidebar-dom-20261026','node_modules/jsdom')));}catch{}
function petFixture(t,actor){
  const dom=new JSDOM('<div id="app"></div>',{url:'file:///workbench/index.html?view=pet&actor='+actor.id,runScripts:'outside-only'});t.after(()=>dom.window.close());const w=dom.window,calls=[],ticks=[],switches=[],visuals=[];let onState,onInput,onMotion;
  w.eval(fs.readFileSync(path.resolve(__dirname,'../../apps/neko-workbench/pet-chat-presentation.js'),'utf8'));
  w.DshPetFeedback=class{constructor(_id,_videos,bubble){this.bubble=bubble;this.anim='idle';this.dragState={active:false};this.animations={drag:['drag']};this.prevWorkTick=0;}showLocal(text){this.bubble.textContent=text;this.bubble.hidden=!text;}onWorkTick(work,tick){if(!tick||tick===this.prevWorkTick)return;this.prevWorkTick=tick;this.workState=work.state;ticks.push(work);this.switchTo('work:'+work.state,false);}switchTo(name,once){this.anim=name;switches.push([name,once]);}resumeWorkStatusAnim(){if(!this.workState)return false;this.switchTo('work:'+this.workState,false);return true;}playIdle(){this.anim='idle';}playOnce(name){this.anim=name;}};
  w.PetContext={preview:()=>({task:'real task',work:'actual work status',lastUser:'real message'})};w.PetShared={HIT_BOX:{x0:0,y0:0,x1:640,y1:360},pick:pool=>pool[0]};
  w.PetAppearance={ORIGINAL:'dsh-original',selected:()=> 'dsh-original',scaleFor:()=>1,frameAspect:()=>16/9,install:()=>({isCat:()=>false,isMedia:()=>false,setMotion(){},dispose(){},render(_s,a){visuals.push(a);}})};
  const state={actors:[actor],preferences:{subagentFountain:false,subagentClustering:false,subagentExploration:false},neko:{connection:'disabled'}};
  w.pet={onState:fn=>{onState=fn;return ()=>{};},onInput:fn=>{onInput=fn;return ()=>{};},onMotion:fn=>{onMotion=fn;return ()=>{};},call:async(method,p)=>{calls.push([method,p]);return method==='state'?state:true;}};
  w.eval(fs.readFileSync(path.resolve(__dirname,'../../apps/neko-workbench/renderer.js'),'utf8'));
  return {w,calls,ticks,switches,visuals,state,update:next=>onState(next),motion:value=>onMotion(value),open:()=>onInput(),click:()=>w.document.querySelector('.character').dispatchEvent(new w.MouseEvent('click',{bubbles:true,detail:0}))};
}
test('actual subsection renderer starts folded, opens real messages on click, and follows work after fountain landing',{skip:!JSDOM},async t=>{
  const a={id:'task-real',kind:'task',name:'Task',status:'working',work:{state:'thinking',tick:1},messages:[{role:'assistant',text:'真实会话回复'}]};const f=petFixture(t,a);await new Promise(r=>setTimeout(r,0));const d=f.w.document;
  assert(d.querySelector('.chat').hidden);assert(d.querySelector('.pet-bubble').hidden);assert.equal(f.ticks.length,1);assert.deepEqual(f.switches,[['work:thinking',false]]);
  f.motion({phase:'spawning',moving:true});assert.equal(f.switches.at(-1)[0],'子代理-持续奔跑');assert.equal(f.visuals.at(-1).presentationRunning,true);
  f.motion({phase:'resting',moving:false});assert.equal(f.switches.at(-1)[0],'work:thinking','landing restores work without a new state tick');assert.equal(f.visuals.at(-1).presentationRunning,undefined);
  f.click();assert(d.querySelector('.pet').classList.contains('task-chat-open'));assert.equal(d.querySelector('.pet-bubble').textContent,'真实会话回复');assert(!d.querySelector('.pet-bubble').hidden);assert(d.querySelector('.chat').hidden);
  f.update({...f.state,actors:[{...a,status:'success',work:{state:'success',tick:2}}]});assert.equal(f.switches.at(-1)[0],'work:success');assert.equal(f.visuals.at(-1).presentationRunning,undefined);assert(d.querySelector('.task-inspector').hidden);
  f.click();assert(d.querySelector('.pet-bubble').hidden);assert(!f.calls.some(([m])=>m==='open-task'||m==='prompt'));
});
test('actual tiny subagent renderer removes chat and stays running throughout clustering and task changes',{skip:!JSDOM},async t=>{
  const f=petFixture(t,{id:'native-helper',kind:'subagent',name:'Helper',mode:'continuable',status:'working',work:{state:'working',tick:2},chatReply:{text:'helper result'},messages:[]});await new Promise(r=>setTimeout(r,0));const d=f.w.document;
  assert.equal(d.querySelector('.chat'),null);assert(d.querySelector('.pet-bubble').hidden);f.open();f.click();assert.equal(d.querySelector('.chat'),null);assert(!d.querySelector('.pet').classList.contains('chat-open'));assert.equal(f.ticks.length,0);assert(!f.calls.some(([m])=>m==='prompt'));
  f.motion({phase:'clustered',moving:false});f.update({...f.state,actors:[{...f.state.actors[0],active:false,status:'success',work:{state:'success',tick:3}}]});
  assert.equal(f.switches.at(-1)[0],'子代理-持续奔跑');assert.equal(f.visuals.at(-1).presentationRunning,true);assert.equal(f.ticks.length,0);
});
test('main pet still opens its existing chat input and presents its API reply',{skip:!JSDOM},async t=>{
  const f=petFixture(t,{id:'main',name:'Main',chatBackend:'chat-api',status:'idle',work:{state:null,tick:0},chatReply:{id:'real',text:'main reply'},messages:[]});await new Promise(r=>setTimeout(r,0));f.open();const d=f.w.document;assert(!d.querySelector('.chat').hidden);assert.equal(d.querySelector('.pet-bubble').textContent,'main reply');assert.equal(f.visuals.at(-1).presentationRunning,undefined);
});
