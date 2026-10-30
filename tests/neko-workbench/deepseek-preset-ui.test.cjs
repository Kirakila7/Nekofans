'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path');
const {createRequire}=require('node:module');
const deps=process.env.NEKO_DOM_DEPS;
const ui=require('../../apps/neko-workbench/main-chat-ui.js');
const settle=()=>new Promise(resolve=>setImmediate(resolve));
function settings(baseUrl,hasKey){return {backend:'chat-api',hasKey,secureStorageAvailable:true,settings:{protocol:'anthropic',baseUrl,model:'existing-model',requestTimeoutMs:60000,maxOutputTokens:1024}};}

test('DeepSeek preset is explicit, preserves config until save, and requires a new key across providers',{skip:!deps},async()=>{
  const {JSDOM}=createRequire(path.join(deps,'package.json'))('jsdom');
  const dom=new JSDOM('<!doctype html><div id="root"></div>',{url:'https://workbench.invalid/'});const host=dom.window.document.getElementById('root');
  const calls=[];let snapshot=settings('https://other-provider.invalid/v1',true);
  const pet={onState:()=>()=>{},call:async(method,payload)=>{calls.push({method,payload});if(method==='chat-settings-read')return snapshot;if(method==='chat-settings-save'){snapshot={...snapshot,settings:{...snapshot.settings,...payload}};return snapshot;}return true;}};
  try{
    const dispose=ui.mountSettings(host,pet);await settle();
    const form=host.querySelector('form'),field=name=>form.elements.namedItem(name),preset=host.querySelector('.deepseek-preset');
    assert.equal(field('baseUrl').value,'https://other-provider.invalid/v1');assert.equal(field('model').value,'existing-model');assert.equal(calls.filter(x=>x.method==='chat-settings-save').length,0);
    preset.click();assert.equal(field('protocol').value,'openai-compatible');assert.equal(field('baseUrl').value,'https://api.deepseek.com');assert.equal(field('model').value,'deepseek-flash');assert.equal(calls.filter(x=>x.method==='chat-settings-save').length,0);
    form.dispatchEvent(new dom.window.Event('submit',{bubbles:true,cancelable:true}));await settle();assert.equal(calls.filter(x=>x.method==='chat-settings-save').length,0);assert.match(host.querySelector('[role=status]').textContent,/其他服务商的密钥/);
    field('apiKey').value='fixture-deepseek-key';form.dispatchEvent(new dom.window.Event('submit',{bubbles:true,cancelable:true}));await settle();const save=calls.find(x=>x.method==='chat-settings-save');assert.equal(save.payload.baseUrl,'https://api.deepseek.com');assert.equal(save.payload.model,'deepseek-flash');assert.deepEqual(save.payload.key,{action:'replace',value:'fixture-deepseek-key'});assert.equal(field('apiKey').value,'');
    assert.match(host.textContent,/与工作台登录的 DSH 账号及余额分开/);dispose();
  }finally{dom.window.close();}
});

test('existing DeepSeek key remains usable when preset selected for the same origin',{skip:!deps},async()=>{
  const {JSDOM}=createRequire(path.join(deps,'package.json'))('jsdom');const dom=new JSDOM('<!doctype html><div id="root"></div>',{url:'https://workbench.invalid/'});const host=dom.window.document.getElementById('root');const calls=[];
  const pet={onState:()=>()=>{},call:async(method,payload)=>{calls.push({method,payload});return method==='chat-settings-read'?settings('https://api.deepseek.com/v1',true):settings('https://api.deepseek.com',true);}};
  try{const dispose=ui.mountSettings(host,pet);await settle();host.querySelector('.deepseek-preset').click();host.querySelector('form').dispatchEvent(new dom.window.Event('submit',{bubbles:true,cancelable:true}));await settle();assert.deepEqual(calls.find(x=>x.method==='chat-settings-save').payload.key,{action:'keep'});dispose();}finally{dom.window.close();}
});

test('account switch uses a dedicated command and does not send or clear API credentials',{skip:!deps},async()=>{
  const {JSDOM}=createRequire(path.join(deps,'package.json'))('jsdom');const dom=new JSDOM('<div id="root"></div>',{url:'https://workbench.invalid/'});const host=dom.window.document.getElementById('root');const calls=[];let succeed=false;
  const pet={onState:()=>()=>{},call:async(method,payload)=>{calls.push({method,payload});if(method==='chat-settings-read')return settings('https://other.invalid/v1',true);if(method==='chat-use-deepseek-account'){if(!succeed)throw Error('private');return {...settings('https://other.invalid/v1',true),backend:'deepseek-account'};}throw Error('unexpected');}};
  try{const dispose=ui.mountSettings(host,pet);await settle();assert.match(host.textContent,/社区大厅中的妈妈自动回复、手动生成回复及共同经历记忆暂不支持此模式/);const input=host.querySelector('[name=apiKey]');input.value='unsaved-key';const button=host.querySelector('.use-deepseek-account');button.click();await settle();assert.match(host.querySelector('[role=status]').textContent,/未能切换/);assert.equal(input.value,'unsaved-key');assert(!JSON.stringify(calls).includes('unsaved-key'));succeed=true;button.click();await settle();assert.match(host.querySelector('[role=status]').textContent,/请确保工作台已登录/);assert(!calls.some(x=>x.method==='chat-settings-save'));dispose();}finally{dom.window.close();}
});
