'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {trustedLocalCaller}=require('../../apps/neko-workbench/main-chat-runtime.cjs');
const {migrateChatRouting,actorBySession,bindNekoCharacter}=require('../../apps/neko-workbench/chat-routing.cjs');
const {NekoChat}=require('../../apps/neko-workbench/neko-chat.cjs');

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
});

test('switching backend during character fetch aborts the request and cannot start a late native socket',async()=>{
  let release;const delayed=new Promise(resolve=>release=resolve),calls=[],signals=[];let sockets=0;
  const chat=new NekoChat({fetchImpl:async(url,options)=>{calls.push(url);signals.push(options.signal);await delayed;return{ok:true,json:async()=>({'猫娘':{}})};},WebSocketImpl:class{constructor(){sockets++;}}});
  const pending=chat.connect({baseUrl:'http://127.0.0.1:48911',character:'大肥鱼'});chat.close();release();await pending;assert(signals[0].aborted);assert.equal(calls.length,1);assert.equal(sockets,0);assert.equal(chat.ping,undefined);
});

test('a missing bound Bigfish never creates a character or connects to the available alternative',async()=>{
  const calls=[];
  const chat=new NekoChat({
    fetchImpl:async(url,options)=>{
      calls.push([url,options.method||'GET']);
      return Response.json({'猫娘':{'另一只鱼':{}}});
    },
    WebSocketImpl:class{constructor(){assert.fail('No socket should open');}},
  });
  await assert.rejects(chat.connect({character:'大肥鱼'}),/没有找到已绑定/);
  assert.deepEqual(calls,[['http://127.0.0.1:48911/api/characters','GET']]);
});

test('binding survives a saved-state round trip and keeps history by server and character',()=>{
  const baseUrl='http://127.0.0.1:48911',otherUrl='http://127.0.0.1:48912';
  const original={baseUrl,character:'大肥鱼'},other={baseUrl:otherUrl,character:'大肥鱼'};
  const state={neko:{...original,enabled:true},actors:[{id:'main',chatBackend:'neko',messages:[{text:'她知道我喜欢橘子'}]}]};
  migrateChatRouting(state);
  bindNekoCharacter(state,other);
  assert.deepEqual(state.actors[0].messages,[]);
  state.actors[0].messages.push({text:'另一台服务上的会话'});
  const reopened=JSON.parse(JSON.stringify(state));
  migrateChatRouting(reopened);
  assert.equal(reopened.neko.baseUrl,otherUrl);
  assert.equal(reopened.neko.character,'大肥鱼');
  bindNekoCharacter(reopened,original);
  assert.deepEqual(reopened.actors[0].messages,[{text:'她知道我喜欢橘子'}]);
  bindNekoCharacter(reopened,other);
  assert.deepEqual(reopened.actors[0].messages,[{text:'另一台服务上的会话'}]);
});

test('selected N.E.K.O. role receives text after session startup and yields to its other window',async t=>{
  let socket;
  class TestSocket extends EventTarget{
    constructor(url){
      super();
      socket=this;
      this.url=url;
      this.sent=[];
      queueMicrotask(()=>{this.readyState=1;this.dispatchEvent(new Event('open'));});
    }
    send(data){this.sent.push(JSON.parse(data));}
    close(){this.readyState=3;this.dispatchEvent(new Event('close'));}
    receive(message){this.dispatchEvent(new MessageEvent('message',{data:JSON.stringify(message)}));}
  }
  const baseUrl='http://127.0.0.1:48911',character='旧角色';
  const chat=new NekoChat({fetchImpl:async()=>Response.json({'猫娘':{'大肥鱼':{},[character]:{}}}),WebSocketImpl:TestSocket});
  t.after(()=>chat.close());
  const phases=[];
  chat.on('connection',info=>phases.push(info.connection));
  await chat.connect({baseUrl,character});
  assert.equal(socket.url,'ws://127.0.0.1:48911/ws/'+encodeURIComponent(character));
  const {requestId}=chat.send('你还记得橘子吗？');
  assert.deepEqual(socket.sent.map(frame=>frame.action),['start_session']);
  assert.equal(socket.sent[0].new_session,false);
  socket.receive({type:'session_started',input_mode:'text'});
  assert.equal(socket.sent[1].request_id,requestId);
  assert.equal(socket.sent[1].data,'你还记得橘子吗？');
  let answer;
  chat.once('complete',result=>answer=result.text);
  socket.receive({type:'gemini_response',text:'记得。',request_id:requestId});
  socket.receive({type:'system',data:'turn end',request_id:requestId});
  assert.equal(answer,'记得。');
  socket.receive({type:'status',message:JSON.stringify({code:'CHARACTER_SWITCHING_TERMINAL'})});
  assert.equal(socket.readyState,3);
  assert.deepEqual(phases,['connecting','ready','reconnect-required']);
});
