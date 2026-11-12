'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createCompanionAccountProvider}=require('../../apps/neko-workbench/companion-account-provider.cjs');
const {createCompanionAccountBridge}=require('../../apps/neko-workbench/companion-account-bridge.cjs');

const signal=()=>new AbortController().signal;
function input(id,conversationId,extra={}){
 return {persona:{id,name:id,prompt:id},messages:[{personaId:id,conversationId,role:'user',text:'synthetic context'}],memories:[],maxOutputTokens:256,signal:signal(),...extra};
}
async function consume(provider,value){const events=[];for await(const event of provider.stream(value))events.push(event);return events;}

test('role and purpose bindings reject crossed teammate/goddess contexts before RPC',async()=>{
 const calls=[];const rpc=async(method,args)=>{calls.push({method,args});return {text:'ok'}};
 const teammate=createCompanionAccountProvider(rpc,{namespace:'game-player'});
 const goddess=createCompanionAccountProvider(rpc,{namespace:'game'});
 const studio=createCompanionAccountProvider(rpc,{namespace:'game-studio'});
 for(const [provider,value] of [
  [goddess,input('bigfish','private-game-turn')],
  [teammate,input('private-game-rule-compiler','private-game-turn')],
  [teammate,input('game-studio','private-game-turn')],
  [teammate,input('bigfish','private-game-rules')],
  [goddess,input('game-studio','private-game-rules')],
  [goddess,input('private-game-rule-compiler','private-game-draft')],
  [goddess,input('game-studio','private-game-draft')],
  [studio,input('private-game-rule-compiler','private-game-rules')],
  [teammate,input('bigfish','private-game-turn',{memories:[{text:'creator secret'}]})],
  [teammate,input('bigfish','private-game-turn',{memoryContext:{text:'creator secret'}})],
  [teammate,input('bigfish','private-game-turn',{messages:[{personaId:'another',conversationId:'private-game-turn',role:'user',text:'wrong owner'}]})],
 ])await assert.rejects(consume(provider,value),/Private game context/);
 assert.equal(calls.length,0);
 await consume(teammate,input('bigfish','private-game-turn'));
 await consume(studio,input('game-studio','private-game-draft'));
 await consume(goddess,input('private-game-rule-compiler','private-game-rules'));
 assert.deepEqual(calls.map(c=>c.method),['game-player-account-chat','game-studio-account-chat','game-account-chat']);
 assert(calls.every(c=>c.args.history.length===0));
});

test('a pending teammate move cannot block or cancel goddess rule compilation',async t=>{
 const {createStreamingMoveAgent}=await import('../../services/nekofans-game-hub/agent-match.mjs');
 const {compilePrivateRule}=await import('../../services/nekofans-game-hub/private-chess-compiler.mjs');
 const observed={},releases={},started={};
 const ready={player:new Promise(resolve=>{started.player=resolve}),goddess:new Promise(resolve=>{started.goddess=resolve})};
 const ctx={get:()=>({getState:async()=>({status:'credential-stored'})}),llm:{prepareCall:async config=>({config,stream:async function*(request){
  const role=request.system.includes('玩家伙伴大肥鱼')?'player':'goddess';observed[role]=request;started[role]();
  await new Promise((resolve,reject)=>{releases[role]=resolve;const stop=()=>reject(Error('cancelled'));if(request.signal.aborted)return stop();request.signal.addEventListener('abort',stop,{once:true});});
  yield {type:'text-delta',index:0,text:role==='player'?'{"action":"e2e4"}':'{"kind":"opponent-piece-ban","piece":"n","turns":1}'};
  yield {type:'finish',reason:{kind:'stop'}};
 }})}};
 const deps={ctx,route:{provider:'deepseek-account',model:'deepseek-flash'},createUserMessage:x=>x,createAssistantMessage:x=>x};
 const bridges={game:createCompanionAccountBridge({...deps,namespace:'game'}),'game-player':createCompanionAccountBridge({...deps,namespace:'game-player'})};
 t.after(()=>Object.values(bridges).forEach(b=>b.dispose()));
 const calls=[];const rpc=(method,args)=>{calls.push({method,args});const namespace=method.startsWith('game-player-')?'game-player':'game';const bridge=bridges[namespace];if(method.endsWith('-chat'))return bridge.send(args);if(method.endsWith('-cancel'))return bridge.cancel(args);return bridge.status()};
 const player=createCompanionAccountProvider(rpc,{namespace:'game-player'}),goddess=createCompanionAccountProvider(rpc,{namespace:'game'});
 const controller=new AbortController();
 const agent=createStreamingMoveAgent({provider:player,persona:{id:'bigfish',name:'大肥鱼',prompt:'玩家伙伴大肥鱼'}});
 const move=agent.choose({seat:0,view:{version:0,publicState:{},legalActions:['e2e4'],ownPrivateContext:{rule:'own-rule-only'}},signal:controller.signal});
 move.catch(()=>{});await ready.player;
 const compilation=compilePrivateRule({provider:goddess,rule:'opponent-rule-for-goddess-only'});await ready.goddess;
 const requestId=calls.find(c=>c.method==='game-player-account-chat').args.requestId;
 assert.deepEqual(bridges.game.cancel({requestId}),{accepted:false});
 assert(!observed.player.signal.aborted);controller.abort();
 await assert.rejects(move,/Cancelled|cancelled/);
 assert(!observed.goddess.signal.aborted);
 releases.goddess();assert.equal((await compilation).status,'compiled');
 assert(!JSON.stringify(observed.player.messages).includes('opponent-rule-for-goddess-only'));
 assert(!JSON.stringify(observed.goddess.messages).includes('own-rule-only'));
 assert(observed.player.system.includes('玩家伙伴大肥鱼'));
 assert(!observed.goddess.system.includes('玩家伙伴大肥鱼'));
 assert(!observed.player.tools&&!observed.goddess.tools);
 assert(calls.some(c=>c.method==='game-player-account-cancel'));
});

test('both isolated bridges reject old chat and accept only their own request prefix',async()=>{
 const deps={ctx:{},route:{provider:'deepseek-account',model:'deepseek-flash'},createUserMessage:x=>x,createAssistantMessage:x=>x};
 for(const namespace of ['game','game-player']){
  const bridge=createCompanionAccountBridge({...deps,namespace});
  try{
   await assert.rejects(bridge.send({requestId:namespace+'-history',text:'test',history:[{role:'user',text:'old secret'}],maxTokens:20}),/不能附带历史/);
   await assert.rejects(bridge.send({requestId:(namespace==='game'?'game-player':'game')+'-forged',text:'test',maxTokens:20}),/聊天内容无效/);
  }finally{bridge.dispose();}
 }
});
