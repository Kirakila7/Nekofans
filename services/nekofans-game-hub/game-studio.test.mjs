import {test} from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {createGameStudio} from './game-studio.mjs';
import {studioWorkshopHtml} from './studio-game.mjs';
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

test('a validated AI draft becomes a workshop game with the same choices and outcome', async () => {
 const game = {title:'双人灯塔',description:'协作探索小岛',nodes:[
   {text:'你发现了 <em>一盏灯</em>',seat:0,choices:[{label:'点灯',next:1}]},
   {text:'灯照亮了另一块礁石',seat:1,choices:[{label:'前往礁石',next:2}]},
   {text:'人们回到了家',winner:1},
 ]};
 const provider=createCompanionAccountProvider(async()=>({text:JSON.stringify(game)}),{namespace:'game-studio'});
 const studio=createGameStudio({provider});
 const draft=await studio.propose({prompt:'设计双人灯塔游戏'});
 assert.equal(studio.workshopProject('missing'),null);
 const project=studio.workshopProject(draft.revisionId);
 assert.equal(project.title,game.title);
 assert.deepEqual(studio.playtest('missing',[]),{status:'not-found'});
 assert.deepEqual(studio.playtest(draft.revisionId,[1]),{status:'invalid'});
 assert.deepEqual(studio.playtest(draft.revisionId,[0,0,0]),{status:'invalid'});
 const source=studioWorkshopHtml(project).match(/<script>([\s\S]*)<\/script>/)[1];
 assert(!source.includes('<em>'));
 const elements=new Map(), makeElement=()=>({children:[],replaceChildren(...children){this.children=children;},addEventListener(){}});
 const document={getElementById(id){if (!elements.has(id))elements.set(id,makeElement());return elements.get(id);},createElement:makeElement};
 let config;
 vm.runInNewContext(source,{document,NekofansGame:{connect(value){config=value;return {submit(){}};}}});
 let state=config.initialState;
 config.onChange(state,{player:0,isMyTurn:true,ready:true});
 assert.equal(elements.get('scene').textContent,game.nodes[0].text);
 assert.deepEqual(studio.playtest(draft.revisionId,[]),{status:'turn',text:elements.get('scene').textContent,seat:0,choices:['点灯']});
 assert.equal(config.agent.legalActions(state,{player:1}).length,0);
 const action=config.agent.legalActions(state,{player:0})[0].action;
 const ignored=config.reducer(state,action,{player:1});
 assert.equal(ignored.node,0);
 state=config.reducer(state,action,{player:0});
 assert.equal(state.node,1);
 config.onChange(state,{player:1,isMyTurn:true,ready:true});
 assert.deepEqual(studio.playtest(draft.revisionId,[0]),{status:'turn',text:elements.get('scene').textContent,seat:1,choices:['前往礁石']});
 state=config.reducer(state,{type:'choose',option:0},{player:1});
 assert.equal(state.node,2);
 config.onChange(state,{player:1,ready:true});
 assert.equal(elements.get('status').textContent,'你赢了');
 assert.deepEqual(studio.playtest(draft.revisionId,[0,0]),{status:'finished',text:elements.get('scene').textContent,winner:1});
 assert.deepEqual(studio.workshopProject(draft.revisionId),project);
});

test('local drafts reopen after restart, keeping private revisions and publisher input intact',async t=>{
 const directory=mkdtempSync(join(tmpdir(),'nekofans-studio-'));
 t.after(()=>rmSync(directory,{recursive:true,force:true}));
 const draftFile=join(directory,'drafts.json'),calls=[];
 const original={title:'渡轮',description:'两人轮流引导渡轮',nodes:[
   {text:'灯塔还没亮',seat:0,choices:[{label:'点灯',next:1}]},
   {text:'船长看到了灯',seat:1,choices:[{label:'靠岸',next:2}]},
   {text:'回到港口',winner:1},
 ]};
 const provider={async *stream({messages}){calls.push(JSON.parse(messages[0].text));
   yield {type:'delta',text:JSON.stringify({...original,title:calls.length===1?'渡轮':'新版渡轮'})};yield {type:'complete'};}};
 const initial=createGameStudio({provider,draftFile});
 const first=await initial.propose({prompt:'做一局轮渡'});
 const resumed=createGameStudio({provider,draftFile});
 assert.deepEqual(resumed.openDraft(first.revisionId),first);
 assert.deepEqual(resumed.workshopProject(first.revisionId),original);
 assert.equal(resumed.playtest(first.revisionId,[0,0]).winner,1);
 assert.equal(calls.length,1,'reopening and playing make no model requests');
 const amended=await resumed.propose({prompt:'改一下标题',revisionId:first.revisionId});
 assert.deepEqual(calls[1].previousDraft,original);
 const next=createGameStudio({provider,draftFile});
 assert.deepEqual(next.listDrafts().revisions.map(({revisionId,title})=>({revisionId,title})),[{revisionId:amended.revisionId,title:'新版渡轮'}]);
 assert.equal(next.inspect(first.revisionId).game.title,'渡轮');
 assert.equal(next.inspect(amended.revisionId).parent,first.revisionId);

 const saved=readFileSync(draftFile);
 writeFileSync(draftFile,'{"version":1,"revisions":[{"id":"broken"}]}');
 const invalid=createGameStudio({provider,draftFile});
 assert.equal(invalid.listDrafts().status,'draft-storage-unavailable');
 assert.deepEqual(await invalid.propose({prompt:'做一个新游戏'}),{status:'draft-storage-unavailable'});
 assert.equal(calls.length,2);
 assert.equal(readFileSync(draftFile,'utf8'),'{"version":1,"revisions":[{"id":"broken"}]}');
 writeFileSync(draftFile,saved);
 assert.deepEqual(createGameStudio({provider,draftFile}).openDraft(amended.revisionId),amended);

 const blockedFile=join(directory,'blocked.json'),volatile=createGameStudio({provider,draftFile:blockedFile});
 mkdirSync(blockedFile);
 const unsaved=await volatile.propose({prompt:'制作另一份草稿'});
 assert.equal(unsaved.saved,false);
 assert.deepEqual(volatile.openDraft(unsaved.revisionId),unsaved);
});
