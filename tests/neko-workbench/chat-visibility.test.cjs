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
