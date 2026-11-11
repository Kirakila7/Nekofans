import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createGameStudio} from './game-studio.mjs';
import {createRequire} from 'node:module';
const {createCompanionAccountProvider}=createRequire(import.meta.url)('../../apps/neko-workbench/companion-account-provider.cjs');
const {createCompanionAccountBridge}=createRequire(import.meta.url)('../../apps/neko-workbench/companion-account-bridge.cjs');
import {compilePrivateRule} from './private-chess-compiler.mjs';

test('DeepSeek authoring route creates and revises immutable, unpublished drafts',async()=>{
 const requests=[];
 const provider=createCompanionAccountProvider(async(method,input)=>{requests.push({method,input});return {text:requests.length===1?'<!doctype html><html>first</html>':'<!doctype html><html>second</html>'};},{namespace:'game'});
 const studio=createGameStudio({provider});
 const first=await studio.propose({prompt:'制作双人国际象棋'});
 assert.equal(first.status,'draft');assert.equal(first.requiresIsolation,true);assert(!('html' in first));
 const second=await studio.propose({prompt:'改成蓝色',revisionId:first.revisionId});
 assert.equal(second.status,'draft');assert.notEqual(second.digest,first.digest);
 assert.match(studio.inspect(first.revisionId).html,/first/);assert.match(studio.inspect(second.revisionId).html,/second/);
 assert.equal(studio.inspect(second.revisionId).parent,first.revisionId);
 assert.equal(requests[0].method,'game-account-chat');assert.deepEqual(requests[0].input.history,[]);
 assert.match(requests[1].input.text,/first/);assert(!JSON.stringify(requests).includes('other-player-secret'));
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
 const provider=createCompanionAccountProvider(async()=>({text:'not html'}),{namespace:'game'});
 assert.deepEqual(await createGameStudio({provider}).propose({prompt:'做游戏'}),{status:'invalid-proposal'});
 const ac=new AbortController();
 await assert.rejects(async()=>{for await(const e of provider.stream({persona:{id:'x'},signal:ac.signal,messages:[{role:'user',text:'one',conversationId:'private-game-rules'},{role:'user',text:'two',conversationId:'private-game-rules'}]}))void e;},/Private game context/);
});
