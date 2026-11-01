'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
let JSDOM;
try { ({ JSDOM } = require(path.join(process.env.NEKO_DOM_DEPS || '/private/tmp/neko-sidebar-dom-20261026', 'node_modules/jsdom'))); } catch {}

async function waitFor(check, label) {
  const end = Date.now() + 3000;
  while (!check()) {
    if (Date.now() >= end) assert.fail('Timed out waiting for ' + label);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

test('fullscreen channel keeps the same companion and unsent draft through chat toggle and layout changes', {skip: !JSDOM}, async t => {
  const dom = new JSDOM('<body><aside data-neko-side-rail><div class="neko-side-rail__space"></div><div class="neko-side-rail__theme"></div></aside><aside data-slot="sidebar"><div data-neko-seat-mount></div><div data-slot="sidebar.workspaces"></div><footer><div data-slot="settings.launcher"></div></footer></aside><main data-neko-chat-center><div data-composer-seat><textarea aria-label="工作草稿">工作内容</textarea></div></main></body>', {runScripts:'outside-only', pretendToBeVisual:true});
  let cleanup;
  t.after(() => { cleanup?.(); dom.window.close(); });
  const w = dom.window, d = w.document, root = d.querySelector('[data-slot="sidebar"]');
  root.getBoundingClientRect = () => ({left:64,right:1064,top:0,bottom:700,width:1000,height:700});
  d.querySelector('[data-neko-chat-center]').getBoundingClientRect = () => ({left:1064,right:1064,top:0,bottom:700,width:0,height:700});
  const snapshot = {connection:'online',auth:{status:'signed-in'},me:{user_id:'fixture'},channel:{id:'test'},messages:[],members:[],participation:{mode:'off',available:false}};
  const calls = [];
  const oldReply = {id:'old',role:'assistant',text:'旧回复'};
  let companionSubscriber;
  const bridge = {
    getState:async()=>({companion:{ready:true,messages:[oldReply]}}), subscribe:fn=>{companionSubscriber=fn; return ()=>{};}, companion:async()=>({}), action:async()=>{},
    lobby:async request=>{calls.push(request.action); return {ok:true,state:snapshot};}, subscribeLobby:()=>()=>{},
    nativeComposer:async()=>({ok:true}), subscribeNativeComposer:()=>()=>{},
    workspace:async request=>request.action==='state'?{officeMode:'dsh',seats:[]}:request.action==='codex-state'?{items:[],approvals:[]}:request.action==='catalog'?{sessions:[],projects:[],providers:{dsh:'ready'}}:{}
  };
  const base = path.resolve(__dirname, '../../apps/neko-workbench/embedded-dsh');
  w.eval(fs.readFileSync(path.join(base,'chatroom-preview-source.js'),'utf8')+'\n'+fs.readFileSync(path.join(base,'workspace-shell-source.js'),'utf8')+'\nwindow.install=installWorkspaceShell');
  cleanup = w.install({window:w,document:d,bridge,createChatroomPreview:w.createChatroomPreview,locateSidebar:()=>({root}),avatar:()=>'',cssText:fs.readFileSync(path.join(base,'workspace-shell-source.css'),'utf8')});
  await waitFor(()=>d.querySelector('.neko-chatroom-preview__room') && d.querySelector('.neko-companion-form textarea'),'room and companion');
  const dock = d.querySelector('.neko-companion-dock');
  const character = d.querySelector('.neko-companion-character');
  const input = dock.querySelector('.neko-companion-form textarea');
  const coding = d.querySelector('main textarea');
  await waitFor(()=>dock.querySelector('.neko-companion-history')?.textContent.includes('旧回复'),'initial companion state');
  dock.getBoundingClientRect = () => ({left:64,right:1064,top:500,bottom:620,width:1000,height:120});
  w.dispatchEvent(new w.Event('resize'));
  input.value = '还没有发送的主 agent 草稿';

  d.body.setAttribute('data-neko-workspace-collapsed','');
  await new Promise(resolve=>setTimeout(resolve,20));
  assert.equal(dock.hasAttribute('data-neko-companion-lobby'),false,'room list alone is not the channel');
  d.querySelector('.neko-chatroom-preview__room').click();
  await waitFor(()=>calls.includes('open') && dock.hasAttribute('data-neko-companion-lobby'),'fullscreen lobby companion');
  assert.equal(dock.querySelector('.neko-companion-character'),character,'reuse the original character');
  assert.equal(dock.querySelector('.neko-companion-form textarea'),input,'reuse the original input');
  const reply = dock.querySelector('.neko-companion-reply');
  assert(reply, 'the main companion has a reply bubble');
  assert.equal(reply.getAttribute('aria-live'),'polite');
  assert.equal(reply.hidden,true,'old history must not appear as a new reply on entry');
  const newReply = {id:'new-1',role:'assistant',text:'<b>新回复</b> & 原样文字'};
  companionSubscriber({companion:{ready:true,messages:[oldReply,newReply]}});
  await waitFor(()=>!reply.hidden && reply.textContent.includes(newReply.text),'new assistant reply appears');
  assert(reply.textContent.includes(newReply.text),'reply text is displayed verbatim');
  assert.equal(reply.querySelector('b'),null,'reply text never becomes HTML');
  let replyMutations=0;
  const replyObserver=new w.MutationObserver(records=>{replyMutations+=records.length;});
  replyObserver.observe(reply,{childList:true,characterData:true,subtree:true});
  companionSubscriber({companion:{ready:true,messages:[oldReply,newReply]}});
  await new Promise(resolve=>setTimeout(resolve,20));
  replyObserver.disconnect();
  assert.equal(replyMutations,0,'duplicate snapshots must not redraw or retrigger the same reply');
  const sameTextNewMessage = {...newReply,id:'new-2'};
  replyObserver.observe(reply,{childList:true,characterData:true,subtree:true});
  companionSubscriber({companion:{ready:true,messages:[oldReply,newReply,sameTextNewMessage]}});
  await new Promise(resolve=>setTimeout(resolve,20));
  replyObserver.disconnect();
  assert(replyMutations>0,'a different message with identical text is still a new reply');
  assert.equal(dock.hasAttribute('data-neko-companion-chat-open'),false,'companion chat is initially folded');
  const panel = dock.querySelector('.neko-companion-chat-panel');
  assert(panel?.contains(input), 'the original input is in the collapsible chat panel');
  assert.equal(panel.hidden,true,'the chat panel is hidden when folded');
  assert.equal(character.getAttribute('aria-expanded'),'false');
  character.click();
  await waitFor(()=>dock.hasAttribute('data-neko-companion-chat-open'),'companion chat opens');
  assert.equal(character.getAttribute('aria-expanded'),'true');
  assert.equal(panel.hidden,false,'clicking the character reveals the actual chat panel');
  assert.equal(input.value,'还没有发送的主 agent 草稿');
  assert.equal(coding.value,'工作内容');
  input.value += '，继续编辑';
  character.click();
  await waitFor(()=>!dock.hasAttribute('data-neko-companion-chat-open'),'companion chat closes');
  assert.equal(character.getAttribute('aria-expanded'),'false');
  assert.equal(panel.hidden,true,'clicking the character again hides the chat panel');
  assert.equal(input.value,'还没有发送的主 agent 草稿，继续编辑');
  character.dispatchEvent(new w.KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));
  await waitFor(()=>dock.hasAttribute('data-neko-companion-chat-open'),'keyboard opens companion chat');
  assert.equal(input.value,'还没有发送的主 agent 草稿，继续编辑');
  character.dispatchEvent(new w.KeyboardEvent('keydown',{key:' ',bubbles:true,cancelable:true}));
  assert.equal(panel.hidden,true,'space closes the chat');
  const pointer=(type,x,y)=>{const e=new w.MouseEvent(type,{bubbles:true,cancelable:true,button:0,clientX:x,clientY:y}); Object.defineProperty(e,'pointerId',{value:1}); character.dispatchEvent(e);};
  pointer('pointerdown',300,500); pointer('pointermove',360,500); pointer('pointerup',360,500);
  character.click();
  assert.equal(panel.hidden,true,'the click following a drag must not open the chat');
  character.click();
  assert.equal(panel.hidden,false,'the next ordinary click opens the chat');
  assert.equal(input.value,'还没有发送的主 agent 草稿，继续编辑');

  d.body.removeAttribute('data-neko-workspace-collapsed');
  await waitFor(()=>!dock.hasAttribute('data-neko-companion-lobby'),'restored workspace layout');
  assert.equal(reply.hidden,true,'the reply bubble is hidden after leaving fullscreen channel');
  assert.equal(panel.hidden,false,'the ordinary chat panel is restored outside fullscreen lobby');
  assert.equal(dock.querySelector('.neko-companion-form textarea'),input);
  assert.equal(input.value,'还没有发送的主 agent 草稿，继续编辑');
  assert.equal(coding.value,'工作内容');

  // The fixed video scene uses an explicit social pane rectangle instead of
  // the native sidebar's (potentially narrow) bounds. It should reuse the
  // same floating companion, without halving the already half-width channel.
  d.body.setAttribute('data-neko-fixed-scene','');
  d.body.setAttribute('data-neko-flex-mode','');
  d.body.setAttribute('data-neko-flex-workspace-collapsed','');
  d.body.style.setProperty('--neko-flex-compact-width','440px');
  d.body.style.setProperty('--neko-flex-compact-right','16px');
  d.body.style.setProperty('--neko-flex-compact-bottom','16px');
  const socialRect={x:64,y:0,width:480,height:700};
  d.dispatchEvent(new w.CustomEvent('neko-flex-social-geometry',{detail:socialRect}));
  await waitFor(()=>dock.hasAttribute('data-neko-companion-lobby'),'fixed scene channel companion');
  assert.equal(d.querySelector('.neko-lobby-panel').hasAttribute('data-neko-lobby-full'),false,'left channel keeps the full social pane width');
  d.body.setAttribute('data-neko-workspace-collapsed','');
  await new Promise(resolve=>setTimeout(resolve,20));
  assert.equal(d.querySelector('.neko-lobby-panel').hasAttribute('data-neko-lobby-full'),false,'a transient ordinary-collapse flag must not halve the scene channel again');
  d.body.removeAttribute('data-neko-workspace-collapsed');
  assert.equal(parseFloat(d.body.style.getPropertyValue('--neko-companion-left')),socialRect.x,'companion uses the social pane left edge');
  assert(parseFloat(d.body.style.getPropertyValue('--neko-companion-width'))<=socialRect.width,'companion remains inside the social pane');
  assert.equal(panel.hidden,true,'fixed scene starts with the companion chat folded');
  assert.equal(dock.querySelector('.neko-companion-character'),character,'scene uses the same live character');
  character.click();
  assert.equal(panel.hidden,false,'clicking the scene character opens the chat');
  assert.equal(input.value,'还没有发送的主 agent 草稿，继续编辑','chat draft survives entering scene');
  assert.equal(coding.value,'工作内容','work draft is unaffected');
  const sceneReply={id:'scene-1',role:'assistant',text:'固定场景的真实回复'};
  companionSubscriber({companion:{ready:true,messages:[oldReply,newReply,sameTextNewMessage,sceneReply]}});
  await waitFor(()=>!reply.hidden && reply.textContent.includes(sceneReply.text),'fixed scene companion reply');
  character.click();
  assert.equal(panel.hidden,true,'clicking the scene character closes the chat');
  assert.equal(input.value,'还没有发送的主 agent 草稿，继续编辑');
  d.body.removeAttribute('data-neko-fixed-scene');
  d.body.removeAttribute('data-neko-flex-mode');
  d.body.removeAttribute('data-neko-flex-workspace-collapsed');
  d.dispatchEvent(new w.CustomEvent('neko-flex-social-geometry',{detail:null}));
  await waitFor(()=>!dock.hasAttribute('data-neko-companion-lobby'),'fixed scene exits');
  assert.equal(panel.hidden,false,'the ordinary chat panel returns after leaving the scene');
  assert.equal(reply.hidden,true,'the scene reply bubble is not left over other screens');
  assert.equal(input.value,'还没有发送的主 agent 草稿，继续编辑');
  assert.equal(coding.value,'工作内容');

  d.querySelector('.neko-room-workspace').click();
  await waitFor(()=>d.querySelector('.neko-lobby-panel').hidden,'work mode');
  assert.equal(dock.hasAttribute('data-neko-companion-lobby'),false);
  assert.equal(dock.querySelector('.neko-companion-character'),character);
  assert.equal(input.value,'还没有发送的主 agent 草稿，继续编辑');
});
