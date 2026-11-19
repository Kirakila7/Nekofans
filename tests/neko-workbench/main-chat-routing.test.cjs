'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {trustedLocalCaller}=require('../../apps/neko-workbench/main-chat-runtime.cjs');
const {migrateChatRouting,actorBySession}=require('../../apps/neko-workbench/chat-routing.cjs');
const {NekoChat}=require('../../tools/local-neko-chat/neko-chat.cjs');

test('chat-api routing survives repeated migration without moving its history to the DSH root',()=>{
  const state={rootId:'dsh-root',neko:{enabled:false},dshRoot:{sessionId:'dsh-root'},actors:[{id:'main',chatBackend:'chat-api',messages:[{role:'user',text:'自己的对话'}]}]};
  migrateChatRouting(state);migrateChatRouting(state);assert.equal(state.actors[0].chatBackend,'chat-api');assert.equal(state.actors[0].messages[0].text,'自己的对话');assert.equal(state.dshRoot.sessionId,'dsh-root');assert.equal(actorBySession(state,'dsh-root'),state.dshRoot);assert.notEqual(state.dshRoot,state.actors[0]);
});

test('account companion survives restart migration without replacing DSH root',()=>{
  const main={id:'main',chatBackend:'deepseek-account',messages:[{role:'user',text:'自己的对话'}]};
  const state={rootId:'dsh-root',neko:{enabled:false},dshRoot:{sessionId:'dsh-root'},actors:[main]};
  migrateChatRouting(state);migrateChatRouting(state);
  assert.equal(state.actors[0],main);assert.equal(main.chatBackend,'deepseek-account');
  assert.equal(main.messages[0].text,'自己的对话');assert.equal(state.dshRoot.sessionId,'dsh-root');
  assert.equal(actorBySession(state,'dsh-root'),state.dshRoot);
});

test('local IPC accepts only exact known main-frame file pages, and preload rejects unlisted methods',async()=>{
  const frame={url:'file:///fixture/index.html?view=chat-settings'},contents={mainFrame:frame,getURL:()=>frame.url},window={webContents:contents,isDestroyed:()=>false},event={sender:contents,senderFrame:frame};
  assert(trustedLocalCaller(event,window,frame.url));assert(!trustedLocalCaller({...event,senderFrame:{url:frame.url}},window,frame.url));assert(!trustedLocalCaller(event,window,'file:///fixture/index.html?view=memory'));assert(!trustedLocalCaller({...event,sender:{}},window,frame.url));
  let bridge;const calls=[];vm.runInNewContext(fs.readFileSync(path.resolve(__dirname,'../../apps/neko-workbench/preload.cjs'),'utf8'),{require:name=>{assert.equal(name,'electron');return{contextBridge:{exposeInMainWorld:(_name,value)=>bridge=value},ipcRenderer:{invoke:(...args)=>{calls.push(args);return Promise.resolve();},on(){},removeListener(){}}};}});
  await bridge.call('chat-settings-read');await bridge.call('chat-use-deepseek-account');await assert.rejects(bridge.call('read-file',{path:'private'}));assert.equal(calls.length,2);assert(Object.isFrozen(bridge));
  await assert.rejects(bridge.call('chat-open-neko-settings'),/未知桌宠操作/);
  await assert.rejects(bridge.call('neko-settings'),/未知桌宠操作/);
});

test('legacy local chat archives settings and history without selecting a paid route',()=>{
  const messages=[{role:'user',text:'旧的本地聊天'},{role:'user',text:'退出前发送的消息'}];
  const state={rootId:'dsh-root',actors:[{id:'main',chatBackend:'neko',messages}],
    neko:{enabled:true,baseUrl:'http://127.0.0.1:49120',character:'原角色',history:messages.slice(0,1)}};
  migrateChatRouting(state);
  migrateChatRouting(state);
  assert.equal(state.actors[0].chatBackend,null);
  assert.deepEqual(state.actors[0].messages,[]);
  assert.equal(state.neko.enabled,false);
  assert.equal(state.neko.chatMoved,true);
  assert.equal(state.neko.baseUrl,'http://127.0.0.1:49120');
  assert.equal(state.neko.character,'原角色');
  assert.deepEqual(state.neko.history,messages);
  assert.equal(state.dshRoot.sessionId,'dsh-root');
});

test('pre-routing profiles keep the DSH root separate from the retired local chat',()=>{
  const localHistory=[{role:'user',text:'本地聊天记录'}];
  const taskHistory=[{role:'user',text:'工作台任务记录'}];
  const state={rootId:'dsh-root',actors:[{id:'main',sessionId:'dsh-root',messages:taskHistory}],
    neko:{enabled:true,history:localHistory}};
  migrateChatRouting(state);
  assert.equal(state.actors[0].chatBackend,null);
  assert.deepEqual(state.dshRoot.messages,taskHistory);
  assert.deepEqual(state.neko.history,localHistory);
});

test('switching backend during character fetch aborts the request and cannot start a late native socket',async()=>{
  let release;const delayed=new Promise(resolve=>release=resolve),calls=[],signals=[];let sockets=0;
  const chat=new NekoChat({fetchImpl:async(url,options)=>{calls.push(url);signals.push(options.signal);await delayed;return{ok:true,json:async()=>({'猫娘':{}})};},WebSocketImpl:class{constructor(){sockets++;}}});
  const pending=chat.connect({baseUrl:'http://127.0.0.1:48911',character:'大肥鱼'});chat.close();release();await pending;assert(signals[0].aborted);assert.equal(calls.length,1);assert.equal(sockets,0);assert.equal(chat.ping,undefined);
});

test('a native role POST already sent before cancellation cannot emit a late profile/socket result',async()=>{
  let release,entered;const delayed=new Promise(resolve=>release=resolve),posting=new Promise(resolve=>entered=resolve);let profile=0,sockets=0;
  const chat=new NekoChat({fetchImpl:async(url)=>url.endsWith('/catgirl')?(entered(),await delayed,{ok:true,json:async()=>({success:true,character_name:'大肥鱼'})}):{ok:true,json:async()=>({'猫娘':{}})},WebSocketImpl:class{constructor(){sockets++;}}});
  chat.on('profile-created',()=>profile++);const pending=chat.connect({baseUrl:'http://127.0.0.1:48911',character:'大肥鱼'});await posting;chat.close();release();await pending;assert.equal(profile,0);assert.equal(sockets,0);assert.equal(chat.ping,undefined);
});
