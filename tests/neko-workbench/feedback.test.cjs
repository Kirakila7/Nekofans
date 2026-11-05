'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {contacts,createFeedback}=require('../../apps/neko-workbench/feedback.cjs');

test('public feedback destinations are fixed and renderer URLs or copy payloads cannot reach the host',async()=>{
  const opened=[],copied=[],feedback=createFeedback({openExternal:async value=>opened.push(value),copyText:value=>copied.push(value)});
  for(const target of ['email','bilibili','github','issues'])assert.equal((await feedback({action:'open',target})).ok,true);
  for(const target of ['qqGroup','email'])await feedback({action:'copy',target});
  assert.deepEqual(copied,['1130382639','acekira3@gmail.com']);
  assert.deepEqual(opened.slice(1),['https://space.bilibili.com/142818715','https://github.com/Kirakila7/Nekofans','https://github.com/Kirakila7/Nekofans/issues/new']);
  assert.equal(new URL(opened[0]).protocol,'mailto:');assert.equal(decodeURIComponent(new URL(opened[0]).searchParams.get('subject')),'Nekofans 使用反馈');
  const before=opened.length+copied.length;
  for(const input of [null,[],{}, {action:'open',target:'qqGroup'},{action:'open',target:'https://example.invalid'},{action:'open',target:'github',url:'file:///private'}, {action:'copy',target:'email',text:'private text'}])await assert.rejects(feedback(input),/未知/);
  assert.equal(opened.length+copied.length,before);assert(Object.isFrozen(contacts));
});

test('account help panel exposes contacts, requires explicit clicks and reports copy/open failures',async t=>{
  const {JSDOM}=require(path.join(process.env.NEKO_DOM_DEPS,'node_modules/jsdom'));
  const dom=new JSDOM('<div data-slot="settings.launcher"><button aria-haspopup="menu" aria-expanded="true" data-collapsed="true" data-signed-out="true">账号</button></div><div data-menu-material="" role="menu"><div role="presentation"><button role="menuitem">设置</button><button role="menuitem">意见反馈</button><button role="menuitem">登录</button></div></div>',{runScripts:'outside-only',pretendToBeVisual:true});
  const w=dom.window,d=w.document,calls=[];let fail=false;
  w.eval(fs.readFileSync(path.resolve(__dirname,'../../apps/neko-workbench/embedded-dsh/account-habitat-source.js'),'utf8'));
  const bridge={getAccounts:async()=>({neko:{community:{status:'signed-out'},lobby:{status:'signed-out'}}}),feedback:async request=>{calls.push({...request});if(fail)throw Error('private diagnostic');return {ok:true};}};
  const stop=w.installNekoAccountHabitat({locale:{getSnapshot:()=>({active:'zh-CN'})}},{document:d,window:w,accountsBridge:bridge});
  t.after(()=>{stop();w.close();});const tick=()=>new Promise(r=>w.setTimeout(r,25));await tick();await tick();
  const panel=d.querySelector('[data-neko-feedback]');assert(panel);assert.equal(panel.open,false);assert.equal(calls.length,0);
  for(const value of ['1130382639','acekira3@gmail.com','142818715','Acekira','Nekofans'])assert(panel.textContent.includes(value));
  assert.equal(d.querySelectorAll('[role=menuitem]').length,3,'native account controls retained');
  for(const [action,target] of [['copy','qqGroup'],['copy','email'],['open','email'],['open','bilibili'],['open','github'],['open','issues']]){
    const button=panel.querySelector(`[data-feedback-target="${target}"][data-feedback-action="${action}"]`);button.click();await tick();assert.equal(button.disabled,false);assert.deepEqual(calls.at(-1),{action,target});
  }
  fail=true;panel.querySelector('[data-feedback-target="github"]').click();await tick();assert.equal(panel.querySelector('[role=status]').textContent,'操作未完成，请重试。');assert(!panel.textContent.includes('private diagnostic'));
  stop();assert.equal(d.querySelector('[data-neko-feedback]'),null);
});
