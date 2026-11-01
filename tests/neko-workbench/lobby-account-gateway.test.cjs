'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createLobbyAccountGateway}=require('../../apps/neko-workbench/lobby-account-gateway.cjs');
const {providerGetter,independentReply}=require('../../apps/neko-workbench/lobby-cat.cjs');
const F=require('./lobby-fixtures.cjs');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {createCompanionAccountBridge}=require('../../apps/neko-workbench/companion-account-bridge.cjs');

test('the actual bridge routes public and private calls to independent turns and cancel scopes',{timeout:3000},async()=>{
  const source=fs.readFileSync(path.resolve(__dirname,'../../apps/neko-workbench/bridge.cjs'),'utf8');
  const constructors=source.split('\n').filter(line=>/^  const (companionAccount|lobbyAccount)=/.test(line)).join('\n');
  const routes=source.slice(source.indexOf("    if(method==='companion-account-status')"),source.indexOf("    if(method==='workspace-catalog')"));
  const gates=new Map();
  const ctx={get:()=>({getState:async()=>({status:'credential-stored'})}),llm:{prepareCall:async config=>({config,stream:async function*(input){
    const text=input.messages.at(-1).content[0].text;await new Promise(resolve=>{gates.set(text,resolve);input.signal.addEventListener('abort',resolve,{once:true});});
    yield {type:'text-delta',index:0,text:'合成回复'};yield {type:'finish',reason:{kind:'stop'}};
  }})}};
  const request=vm.runInNewContext(`(()=>{${constructors};return async(method,p)=>{${routes}};})()`,{ctx,options:{provider:'deepseek-account',model:'deepseek-flash'},createCompanionAccountBridge,createUserMessage:x=>({...x,role:'user'}),createAssistantMessage:x=>({...x,role:'assistant'})});
  const privateTurn=request('companion-account-chat',{requestId:'companion-private-1',text:'私聊合成问题',context:'合成人设',maxTokens:200});
  const publicTurn=request('lobby-account-chat',{requestId:'companion-public-1',text:'大厅合成问题',context:'合成人设',maxTokens:200});
  const publicRejected=assert.rejects(publicTurn,/取消/);
  const deadline=Date.now()+1500;while(gates.size<2&&Date.now()<deadline)await new Promise(resolve=>setImmediate(resolve));assert.equal(gates.size,2);
  assert.equal((await request('lobby-account-cancel',{requestId:'companion-private-1'})).accepted,false);
  assert.equal((await request('lobby-account-cancel',{requestId:'companion-public-1'})).accepted,true);await publicRejected;
  gates.get('私聊合成问题')();assert.equal((await privateTurn).text,'合成回复');
});

test('selected backend resolves the isolated account provider without falling back to private chat or API keys',()=>{
  const publicProvider={stream(){}},privateProvider={stream(){throw Error('private chat must not be used');}};
  let runtime={backend:'deepseek-account',accountProvider:privateProvider},available=true,apiCalls=0;
  const get=providerGetter({runtime:()=>runtime,getAccountProvider:()=>available?publicProvider:null,createChatApiProvider:()=>{apiCalls++;return {};}});
  assert.equal(get(),publicProvider);available=false;assert.equal(get(),null);assert.equal(apiCalls,0);
  runtime={backend:'neko'};available=true;assert.equal(get(),null);
  runtime={backend:'deepseek-account',closed:true};assert.equal(get(),null);
  runtime={backend:'chat-api',secretStore:{has:()=>true,available:()=>true,get:()=> 'synthetic'},settings:{baseUrl:'https://example.invalid',model:'synthetic'}};
  assert(get());assert.equal(apiCalls,1);runtime.secretStore.available=()=>false;assert.equal(get(),null);
});

test('a stale status response cannot restore availability after engine invalidation or disposal',async()=>{
  let release,ready=true,changes=0;
  const g=createLobbyAccountGateway({rpc:()=>new Promise(resolve=>{release=resolve;}),isReady:()=>ready,onChange:()=>changes++});
  const first=g.refresh();await Promise.resolve();assert.equal(g.refresh(),first);g.invalidate();release({status:'signed-in'});await first;assert.equal(g.provider(),null);assert.equal(changes,0);
  const next=g.refresh();await Promise.resolve();release({status:'signed-in'});await next;assert(g.provider());assert.equal(changes,1);
  ready=false;await g.refresh();assert.equal(g.provider(),null);assert.equal(changes,2);
  ready=true;const last=g.refresh();await Promise.resolve();g.dispose();release({status:'signed-in'});await last;assert.equal(g.provider(),null);
});

test('signed-out and failed account checks remain unavailable',async()=>{
  for(const result of [{status:'signed-out'},null,Error('synthetic failure')]){
    const g=createLobbyAccountGateway({rpc:async()=>{if(result instanceof Error)throw result;return result;},isReady:()=>true});
    await g.refresh();assert.equal(g.provider(),null);g.dispose();
  }
});

test('a full independent turn uses lobby account RPC and sends only public context, without private history or memory',async()=>{
  const calls=[];
  const g=createLobbyAccountGateway({isReady:()=>true,rpc:async(method,input)=>{calls.push({method,input});return method==='lobby-account-status'?{status:'signed-in'}:{text:'合成公开回复'};}});
  await g.refresh();
  assert.deepEqual(Object.keys(g.provider()), ['stream'], 'public transport does not expose private memory extraction');
  const target=F.message({text:'合成公开问题',created_at:Date.now()});
  const reply=await independentReply({target,recentLobby:[target],context:{ownerId:F.OWNER,catId:F.CAT,ownerName:'合成主人',catName:'合成猫'}},{provider:g.provider(),getPersona:F.persona});
  assert.equal(reply,'合成公开回复');assert.deepEqual(calls.map(c=>c.method),['lobby-account-status','lobby-account-chat']);
  const input=calls[1].input;assert.deepEqual(input.history,[]);assert(input.text.includes('合成公开问题'));assert(input.context.includes('没有任何工具'));assert.equal(input.maxTokens,200);g.dispose();
});

test('cancellation is confined to the matching lobby request and cannot target private chat',async()=>{
  const calls=[];let release;
  const g=createLobbyAccountGateway({isReady:()=>true,rpc:async(method,input)=>{calls.push({method,input});if(method==='lobby-account-status')return {status:'signed-in'};if(method==='lobby-account-chat')return new Promise(resolve=>{release=resolve;});return {accepted:true};}});
  await g.refresh();const abort=new AbortController();
  const run=(async()=>{for await(const event of g.provider().stream({persona:{id:'lobby-cat',prompt:'合成人设'},messages:[{role:'user',text:'公开问题'}],signal:abort.signal,maxOutputTokens:200}))void event;})();
  while(!release)await new Promise(resolve=>setImmediate(resolve));abort.abort();release({text:'迟到的合成回复'});await assert.rejects(run,/Cancelled/);
  assert.equal(calls.at(-1).method,'lobby-account-cancel');assert.equal(calls.at(-1).input.requestId,calls[1].input.requestId);g.dispose();
});
