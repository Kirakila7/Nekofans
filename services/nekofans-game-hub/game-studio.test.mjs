import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createGameStudio} from './game-studio.mjs';
import {createRequire} from 'node:module';
const {createCompanionAccountProvider}=createRequire(import.meta.url)('../../apps/neko-workbench/companion-account-provider.cjs');
const {createCompanionAccountBridge}=createRequire(import.meta.url)('../../apps/neko-workbench/companion-account-bridge.cjs');
import {compilePrivateRule} from './private-chess-compiler.mjs';

test('DeepSeek authoring route creates and revises immutable, unpublished drafts',async()=>{
 const requests=[];
 const game=title=>({title,description:'轮流过桥',nodes:[
  {text:'先行方选路',seat:0,choices:[{label:'走桥',next:1}]},
  {text:'后行方选路线',seat:1,choices:[{label:'跟上',next:2}]},
  {text:'双方都到达',winner:'draw'},
 ]});
 const provider=createCompanionAccountProvider(async(method,input)=>{
  requests.push({method,input});
  return {text:JSON.stringify(game(requests.length===1?'月球旧桥':'月球蓝桥'))};
 },{namespace:'game-studio'});
 const studio=createGameStudio({provider});
 const first=await studio.propose({prompt:'做一个双人月球过桥游戏'});
 assert.equal(first.status,'draft');assert.equal(first.preview.title,'月球旧桥');assert(!('game' in first));
 const second=await studio.propose({prompt:'改成蓝色',revisionId:first.revisionId});
 assert.equal(second.status,'draft');assert.notEqual(second.digest,first.digest);
 const copy=studio.inspect(first.revisionId);copy.game.nodes[0].choices[0].next=2;
 assert.equal(studio.inspect(first.revisionId).game.nodes[0].choices[0].next,1);
 assert.equal(studio.inspect(second.revisionId).game.title,'月球蓝桥');
 assert.equal(studio.inspect(second.revisionId).parent,first.revisionId);
 assert.equal(requests[0].method,'game-studio-account-chat');assert.deepEqual(requests[0].input.history,[]);
 assert.equal(JSON.parse(requests[1].input.text).previousDraft.title,'月球旧桥');
 assert.deepEqual(await studio.propose({prompt:'修改',revisionId:'missing'}),{status:'not-found'});
});

test('dedicated game account bridge receives no other seat, conversation history or tools',async()=>{
 let seen;
 const ctx={get:()=>({getState:async()=>({status:'credential-stored'})}),llm:{prepareCall:async(config)=>({config,stream:async function*(input){seen=input;yield {type:'text-delta',index:0,text:'{"kind":"opponent-piece-ban","piece":"n","turns":1}'};yield {type:'finish',reason:{kind:'stop'}};}})}};
 const bridge=createCompanionAccountBridge({ctx,route:{provider:'deepseek-account',model:'deepseek-flash'},namespace:'game',createUserMessage:x=>x,createAssistantMessage:x=>x});
 const provider=createCompanionAccountProvider((method,args)=>method==='game-account-chat'?bridge.send(args):bridge.cancel(args),{namespace:'game'});
 try {const result=await compilePrivateRule({provider,rule:'只属于甲方的规则'});assert.equal(result.status,'compiled');assert.equal(seen.messages.length,1);assert(!seen.tools);assert(!JSON.stringify(seen).includes('乙方的规则'));assert.match(JSON.stringify(seen.messages),/只属于甲方的规则/);
 await assert.rejects(bridge.send({requestId:'game-invalid',text:'test',history:[{role:'user',text:'old secret'}],maxTokens:20}),/不能附带历史/);
 } finally {bridge.dispose();}
});

test('invalid model responses and unsolicited chat histories are rejected',async()=>{
 const provider=createCompanionAccountProvider(async()=>({text:'not html'}),{namespace:'game-studio'});
 assert.deepEqual(await createGameStudio({provider}).propose({prompt:'做游戏'}),{status:'invalid-proposal'});
 const ac=new AbortController();
 await assert.rejects(async()=>{for await(const e of provider.stream({persona:{id:'x'},signal:ac.signal,messages:[{role:'user',text:'one',conversationId:'private-game-rules'},{role:'user',text:'two',conversationId:'private-game-rules'}]}))void e;},/Private game context/);
});
