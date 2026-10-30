'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
let JSDOM; try { ({ JSDOM } = require(path.join(process.env.NEKO_DOM_DEPS || '', 'node_modules/jsdom'))); } catch {}
const tick = () => new Promise(resolve => setTimeout(resolve, 20));

test('public room opens the existing lobby; social surfaces move the same companion to the rail and keep its draft', {skip: !JSDOM}, async t => {
  const dom = new JSDOM('<body><aside data-neko-side-rail><div class="neko-side-rail__space"></div><div class="neko-side-rail__theme"></div></aside><aside data-slot="sidebar"><div data-neko-seat-mount></div><div data-slot="sidebar.workspaces"></div><footer><div data-slot="settings.launcher"></div></footer></aside><main><textarea aria-label="工作草稿">工作内容</textarea></main></body>', {runScripts:'outside-only'});
  t.after(() => dom.window.close());
  const w=dom.window, d=w.document, root=d.querySelector('[data-slot="sidebar"]'), actions=[], calls=[];
  root.getBoundingClientRect=()=>({left:64,right:300,top:0,bottom:700,width:236,height:700});
  const snapshot={connection:'online',auth:{status:'signed-in'},me:{user_id:'user1'},channel:{id:'test'},messages:[],members:[],participation:{mode:'off',available:false}};
  const bridge={getState:async()=>({companion:{ready:true,messages:[]}}),subscribe:()=>()=>{},companion:async()=>({}),
    action:async action=>actions.push(action),lobby:async req=>{calls.push(req.action);return {ok:true,state:snapshot};},subscribeLobby:()=>()=>{},
    workspace:async r=>r.action==='state'?{officeMode:'dsh',seats:[]}:r.action==='codex-state'?{items:[],approvals:[]}:r.action==='catalog'?{sessions:[],projects:[],providers:{dsh:'ready'}}:{}};
  const base=path.resolve(__dirname,'../../apps/neko-workbench/embedded-dsh');
  w.eval(fs.readFileSync(path.join(base,'chatroom-preview-source.js'),'utf8')+'\n'+fs.readFileSync(path.join(base,'workspace-shell-source.js'),'utf8')+'\nwindow.install=installWorkspaceShell');
  const cleanup=w.install({window:w,document:d,bridge,createChatroomPreview:w.createChatroomPreview,locateSidebar:()=>({root}),avatar:()=>''}); t.after(cleanup); await tick();
  const dock=d.querySelector('.neko-companion-dock'), character=d.querySelector('.neko-companion-character'), input=d.querySelector('.neko-companion-form textarea');
  dock.getBoundingClientRect=()=>({left:64,right:300,top:500,bottom:620,width:236,height:120});
  w.dispatchEvent(new w.Event('resize')); await tick();
  const rooms=d.querySelectorAll('.neko-chatroom-preview__room');
  assert.equal(rooms[0].textContent.includes('公共聊天室'),true);assert.equal(rooms[1].textContent.includes('我的小窝'),true);
  assert.equal(d.querySelector('.neko-workspace-rail-controls .neko-lobby-switch'),null);
  const coding=d.querySelector('main textarea'), main=d.querySelector('main'), startup=d.querySelector('.neko-workspace-startup');
  const startupHidden=startup?.hidden;
  input.value='保留的草稿'; rooms[0].click(); await tick();
  const lobby=d.querySelector('.neko-lobby-panel');
  assert.equal(lobby.hidden,false);assert(calls.includes('open'));
  assert.equal(lobby.style.left,'64px');assert.equal(lobby.style.width,'236px');assert.equal(d.querySelector('.neko-chatroom-preview').hidden,true);
  assert.equal(main.hasAttribute('inert'),false);assert.equal(coding.value,'工作内容');assert.equal(startup?.hidden,startupHidden);
  coding.value+='，继续编辑';
  d.querySelector('.neko-lobby-members-toggle').click();assert.equal(d.querySelector('.neko-lobby-members-toggle').getAttribute('aria-expanded'),'true');
  d.querySelector('.neko-lobby-back').click();await tick();
  assert.equal(lobby.hidden,true);assert.equal(d.querySelector('.neko-chatroom-preview').hidden,false);assert.equal(coding.value,'工作内容，继续编辑');
  assert.equal(d.activeElement,rooms[0]);
  rooms[0].click();await tick();assert.equal(lobby.hidden,false);
  d.querySelector('.neko-room-workspace').click(); await tick(); assert.equal(d.querySelector('.neko-lobby-panel').hidden,true);
  for (const surface of ['community','bilibili']) {
    d.dispatchEvent(new w.CustomEvent('neko-side-surface-change',{detail:{surface}})); await tick();
    const pet=d.querySelector('.neko-rail-companion');assert.equal(dock.hidden,true);assert.equal(pet.hidden,false);assert.equal(character.parentElement,pet);
    pet.click(); await tick();assert.equal(actions.at(-1),'open-companion-chat');assert.equal(input.value,'保留的草稿');
    d.dispatchEvent(new w.CustomEvent('neko-side-surface-change',{detail:{surface:'hidden'}})); await tick();
    assert.equal(dock.hidden,false);assert.equal(character.parentElement,dock);assert.equal(input.value,'保留的草稿');
  }
});
