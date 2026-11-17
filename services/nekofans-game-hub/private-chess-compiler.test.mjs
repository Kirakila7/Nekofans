import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compilePrivateRule, parseRuleProposal, permitsPrivateMove, classifyPrivatePosition } from './private-chess-compiler.mjs';
import { createPrivateChessRoom } from './private-chess-room.mjs';
import { createRequire } from 'node:module';
const chess=createRequire(import.meta.url)('./standard-trial/chess-core.cjs');

test('the private model call is stateless and its response is reduced to bounded data', async () => {
  let input;
  const provider = { async *stream(value) { input=value; yield {type:'delta', text:'{"kind":"opponent-piece-ban","piece":"n","turns":1}'}; yield {type:'complete'}; } };
  const result=await compilePrivateRule({provider,rule:'对手第一回合不能动马'});
  assert.deepEqual(result,{status:'compiled',effect:{kind:'opponent-piece-ban',piece:'n',turns:1}});
  assert.equal(input.messages.length,1); assert.equal(input.messages[0].conversationId,'private-game-rules'); assert.deepEqual(input.memories,[]);
  assert.equal(parseRuleProposal('{"kind":"opponent-piece-ban","piece":"n","turns":1,"note":"secret"}'),null);
  assert.equal(parseRuleProposal('{"kind":"opponent-piece-ban","piece":"k","turns":3}'),null);
  assert.equal(parseRuleProposal('{"kind":"opponent-piece-ban","piece":"n","turns":4}'),null);
  assert.deepEqual(await compilePrivateRule({provider:{async *stream(){yield {type:'delta',text:'私密内容'};yield {type:'complete'};}},rule:'测试'}),{status:'unavailable'});
});

test('room views and responses never disclose either rule or compiled effects', async () => {
  let calls=0;
  const provider={async *stream(){calls++;yield {type:'delta',text:'{"kind":"opponent-piece-ban","piece":"n","turns":1}'};yield {type:'complete'};}};
  const room=createPrivateChessRoom({provider});
  assert.deepEqual(room.start(),{status:'not-ready'});
  assert.deepEqual(await room.submit({seat:0,rule:'白方的秘密'}),{status:'ready'});
  assert.deepEqual(await room.submit({seat:0,rule:'再次提交'}),{status:'already-submitted'});
  assert.deepEqual(room.view(1),{ownStatus:'empty',opponentReady:true,rulesActive:false});
  assert.deepEqual(await room.submit({seat:1,rule:'黑方的秘密'}),{status:'ready'});
  assert.deepEqual(room.start(),{status:'active'});assert.equal(calls,2);
  assert.equal(room.permitsMove({actions:[],seat:0,action:'g1f3'}),false);
  assert.equal(room.permitsMove({actions:[],seat:0,action:'e2e4'}),true);
  assert(!JSON.stringify(room.view(0)).includes('秘密'));assert(!JSON.stringify(room.view(1)).includes('piece'));
});

test('a secret restriction is applied by the server only to the opponent and expires', () => {
  const effects=[{kind:'opponent-piece-ban',piece:'n',turns:1},null];
  const white=[{seat:0,action:'e2e4'}];
  assert.equal(permitsPrivateMove({actions:white,seat:1,action:'g8f6',effects}),false);
  assert.equal(permitsPrivateMove({actions:white,seat:1,action:'e7e5',effects}),true);
  const later=[...white,{seat:1,action:'e7e5'},{seat:0,action:'g1f3'}];
  assert.equal(permitsPrivateMove({actions:later,seat:1,action:'g8f6',effects}),true);
  assert.equal(permitsPrivateMove({actions:[],seat:1,action:'g8f6',effects}),false);
});

test('if a restriction would forbid every legal move, pause without disclosing or overriding it',()=>{
  const state=chess.parseFen('8/8/8/8/8/2k5/7r/KR5r w - - 0 1');
  const legal=chess.legalMoves(state);assert(legal.length>0);assert(legal.every(move=>state.board[move.from].toLowerCase()==='r'));
  const effect={kind:'opponent-piece-ban',piece:'r',turns:2};
  assert.equal(classifyPrivatePosition({state,turnsPlayed:0,effect}),'decision-required');
  assert.equal(classifyPrivatePosition({state,turnsPlayed:2,effect}),'normal');
  assert.equal(classifyPrivatePosition({state,turnsPlayed:0,effect:{kind:'bad'}}),'unavailable');
});

test('unsupported, aborted and invalid requests do not pretend a rule was activated',async()=>{
  const provider={async *stream(){yield {type:'delta',text:'{"kind":"unsupported"}'};yield {type:'complete'};}};
  assert.deepEqual(await compilePrivateRule({provider,rule:'我的皇后能飞'}),{status:'unsupported'});
  assert.deepEqual(await compilePrivateRule({provider,rule:' '}),{status:'invalid'});
  const controller=new AbortController();controller.abort();
  assert.deepEqual(await compilePrivateRule({provider,rule:'测试',signal:controller.signal}),{status:'unavailable'});
});
