'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { companionSnapshot } = require('../../apps/neko-workbench/workspace-controller.cjs');
let JSDOM;
try { ({ JSDOM } = require(path.join(process.env.NEKO_DOM_DEPS || '/private/tmp/neko-sidebar-dom-20261026', 'node_modules/jsdom'))); } catch {}
const source = fs.readFileSync(path.join(__dirname, '../../apps/neko-workbench/embedded-dsh/workspace-shell-source.js'), 'utf8');
const tick = () => new Promise(resolve => setTimeout(resolve, 20));

test('main companion snapshot projects bounded chat failures without exposing settings or other agents', () => {
  const state = { actors:[{id:'other',messages:[{role:'user',text:'other-private'}]},{id:'main',chatBackend:'chat-api',messages:[],chatReply:{id:'partial',text:'尚未完成'}}], mainChat:{ready:true,hasKey:true,settings:{baseUrl:'https://example.test',model:'m',key:'private-key'},chat:{phase:'error',lastUserMessage:'我的问题',errorMessage:'连接失败，请重试'}} };
  const failed = companionSnapshot(state);
  assert.equal(failed.error, '连接失败，请重试'); assert.equal(failed.failedText, '我的问题');
  assert.equal(failed.messages.at(-1).partial,true);
  assert(!JSON.stringify(failed).includes('private-key')); assert(!JSON.stringify(failed).includes('other-private'));
  state.mainChat.chat.phase='replying'; state.actors[1].active=true;
  const working=companionSnapshot(state); assert.equal(working.failedText,''); assert.equal(working.error,''); assert.equal(working.working,true);
});

test('companion feedback exposes setup, reply, failure and safe recovery without resending or overwriting a draft', { skip: !JSDOM }, async t => {
  const dom = new JSDOM('<body><aside data-neko-side-rail><div class="neko-side-rail__theme"></div></aside><aside data-slot="sidebar"><div data-neko-seat-mount></div><div data-slot="sidebar.workspaces"></div><div data-slot="settings.launcher"></div></aside><main></main></body>', { runScripts:'outside-only', pretendToBeVisual:true });
  t.after(() => dom.window.close());
  const w=dom.window, d=w.document, calls=[]; let subscriber, resolveSend;
  const layout={officeMode:'dsh',activeSeatId:null,seats:[],companionHistoryOpen:false};
  const state={workspaceRevision:0,companion:{ready:false,working:false,messages:[]}};
  const bridge={getState:async()=>state,subscribe:fn=>{subscriber=fn;return()=>{};},action:async a=>{calls.push({action:a});},companion:async request=>{calls.push(request);if(request.action==='send')return new Promise(resolve=>{resolveSend=resolve;});},workspace:async request=>{if(request.action==='state')return {...layout};if(request.action==='update')return Object.assign(layout,request.patch);if(request.action==='codex-state')return {items:[],approvals:[]};if(request.action==='catalog')return {sessions:[],providers:{}};return null;}};
  w.eval(source+'\nwindow.install=installWorkspaceShell');
  const cleanup=w.install({window:w,document:d,bridge}); t.after(cleanup); await tick();
  const input=d.querySelector('.neko-companion-form textarea'), status=d.querySelector('.neko-companion-status'), history=d.querySelector('.neko-companion-history');
  assert.match(status.textContent,/聊天尚未连接/); assert(!d.querySelector('.neko-companion-setup').hidden);
  input.value='保留的草稿'; input.dispatchEvent(new w.Event('input',{bubbles:true})); d.querySelector('.neko-companion-setup').click(); await tick();
  assert.equal(calls.at(-1).action,'chat-settings'); assert.equal(input.value,'保留的草稿');
  subscriber({...state,companion:{ready:true,working:false,messages:[]}}); await tick();
  d.querySelector('.neko-companion-form').requestSubmit(); await tick();
  assert.match(status.textContent,/正在发送/); assert.equal(calls.filter(x=>x.action==='send').length,1);
  input.value='新草稿'; input.dispatchEvent(new w.Event('input',{bubbles:true})); resolveSend({requestId:'one'}); await tick();
  assert.equal(input.value,'新草稿'); assert(!history.hidden,'accepted messages reveal their actual history');
  subscriber({...state,companion:{ready:true,working:true,messages:[{role:'assistant',text:'真实流式回复',streaming:true}]}}); await tick();
  assert.match(status.textContent,/正在回复/); assert.match(history.textContent,/回复中：真实流式回复/);
  subscriber({...state,companion:{ready:true,working:false,error:'连接失败，请重试',failedText:'保留的草稿',messages:[{role:'assistant',text:'未完成',partial:true}]}}); await tick();
  assert.match(history.textContent,/未完成回复：未完成/);
  const recover=d.querySelector('.neko-companion-recover'); assert.match(status.textContent,/连接失败/); assert(!recover.hidden); assert(recover.disabled);
  recover.click(); assert.equal(input.value,'新草稿'); assert.equal(calls.filter(x=>x.action==='send').length,1);
  input.value=''; input.dispatchEvent(new w.Event('input',{bubbles:true})); assert(!recover.disabled); recover.click();
  assert.equal(input.value,'保留的草稿'); assert.equal(calls.filter(x=>x.action==='send').length,1,'recover never sends automatically');
});

test('workbench account readiness follows the DSH connection without exposing credentials', () => {
  const state={connection:'starting',actors:[{id:'main',chatBackend:'deepseek-account',messages:[]}],mainChat:{ready:true,chat:{phase:'idle'}}};
  const starting=companionSnapshot(state); assert.equal(starting.ready,false); assert.equal(starting.workbenchStatus,'starting'); assert.match(starting.error,/正在连接/);
  state.connection='error'; const down=companionSnapshot(state); assert.equal(down.ready,false); assert.equal(down.workbenchStatus,'unavailable'); assert.match(down.error,/未连接/);
  state.connection='ready'; const restored=companionSnapshot(state); assert.equal(restored.ready,true); assert.equal(restored.workbenchStatus,'ready'); assert.equal(restored.error,'');
  state.mainChat.ready=false; assert.equal(companionSnapshot(state).ready,false,'the connection alone cannot make the chat provider ready');
});

test('account connection feedback preserves drafts and offers explicit reconnect without sending', {skip:!JSDOM}, async t=>{
  const dom=new JSDOM('<body><aside data-neko-side-rail><div class="neko-side-rail__theme"></div></aside><aside data-slot="sidebar"><div data-neko-seat-mount></div><div data-slot="sidebar.workspaces"></div><div data-slot="settings.launcher"></div></aside><main></main></body>',{runScripts:'outside-only',pretendToBeVisual:true});t.after(()=>dom.window.close());
  const w=dom.window,d=w.document,calls=[];let subscriber;const layout={officeMode:'dsh',activeSeatId:null,seats:[],companionHistoryOpen:false};
  const base={workspaceRevision:0,companion:{backend:'deepseek-account',workbenchStatus:'starting',ready:false,error:'工作台正在连接…',messages:[]}};
  const bridge={getState:async()=>base,subscribe:fn=>{subscriber=fn;return()=>{};},action:async a=>{calls.push(a)},companion:async r=>{calls.push(r.action)},workspace:async r=>r.action==='state'?layout:r.action==='codex-state'?{items:[],approvals:[]}:r.action==='catalog'?{sessions:[],providers:{}}:null};
  w.eval(source+'\nwindow.install=installWorkspaceShell');const cleanup=w.install({window:w,document:d,bridge});t.after(cleanup);await tick();
  const input=d.querySelector('.neko-companion-form textarea'),status=d.querySelector('.neko-companion-status'),setup=d.querySelector('.neko-companion-setup');input.value='仍未发送的草稿';
  assert.match(status.textContent,/正在连接/);assert(setup.hidden);d.querySelector('.neko-companion-form').requestSubmit();await tick();assert.deepEqual(calls,[]);assert.equal(input.value,'仍未发送的草稿');
  subscriber({...base,companion:{...base.companion,workbenchStatus:'unavailable',error:'工作台未连接，请重连后再聊天。'}});await tick();assert.match(status.textContent,/未连接/);assert.equal(setup.textContent,'重连工作台');assert(!setup.hidden);d.querySelector('.neko-companion-form').requestSubmit();await tick();assert.deepEqual(calls,[],'pressing send must not restart the workbench or submit a message');setup.click();await tick();assert.deepEqual(calls,['reconnect-workbench']);assert.equal(input.value,'仍未发送的草稿');
  subscriber({...base,companion:{...base.companion,workbenchStatus:'ready',ready:true,error:''}});await tick();assert(setup.hidden);assert.equal(input.value,'仍未发送的草稿');assert.deepEqual(calls,['reconnect-workbench']);
});
