import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createAgentMatch, createStreamingMoveAgent } from './agent-match.mjs';
import { createChessMatchAdapter } from './agent-match-chess.mjs';
const chess = createRequire(import.meta.url)('./standard-trial/chess-core.cjs');

function chessTransport() {
  const actions = [];
  return {
    async readState() { return { ready: true, actions: structuredClone(actions), secret: 'never pass this field' }; },
    async submitMove({ seat, expectedVersion, action }) {
      if (expectedVersion !== actions.length) return { status: 'conflict' };
      const next = { seat, action, version: actions.length + 1 };
      const replay = chess.replayActions([...actions, next]);
      if (replay.rejected.length) return { status: 'rejected' };
      actions.push(next); return { status: 'applied', version: actions.length };
    },
    actions,
  };
}

test('two fixture agents alternate standard chess through the generic runner without receiving the other private context', async () => {
  const transport = chessTransport(), calls = [];
  const game = createChessMatchAdapter({ transport, getOwnPrivateContext: async ({ seat }) => seat ? 'side-b-secret' : 'side-a-secret' });
  const agents = ['e2e4', 'e7e5'].map((move, seat) => ({ async choose(input) {
    calls.push(structuredClone({ seat, view: input.view })); return { action: move };
  }}));
  const match = createAgentMatch({ game, agents });
  assert.equal((await match.step({ seat: 0 })).status, 'applied');
  assert.equal((await match.step({ seat: 0 })).status, 'not-your-turn');
  assert.equal((await match.step({ seat: 1 })).status, 'applied');
  assert.deepEqual(transport.actions.map(x => x.action), ['e2e4', 'e7e5']);
  assert.equal(calls.length, 2);
  assert(JSON.stringify(calls[0]).includes('side-a-secret'));
  assert(!JSON.stringify(calls[0]).includes('side-b-secret'));
  assert(JSON.stringify(calls[1]).includes('side-b-secret'));
  assert(!JSON.stringify(calls[1]).includes('side-a-secret'));
  assert(!JSON.stringify(calls).includes('never pass this field'));
});

test('the same runner supports a non-chess game without leaking extra snapshot fields', async () => {
  let current = 0, received;
  const game = { async readView() { return { game:'tokens', version:current, status:'active', turn:0, publicState:{tokens:3}, legalActions:['take'], ownPrivateContext:'my own', otherSecret:'private!' }; },
    async submit({action,expectedVersion}) { assert.equal(action,'take'); assert.equal(expectedVersion,current++); return {status:'applied',version:current}; } };
  const match = createAgentMatch({game, agents:[{async choose(x){received=x; return {action:'take'};}},{async choose(){throw Error('wrong seat');}}]});
  assert.equal((await match.step({seat:0})).status,'applied');
  assert(!JSON.stringify(received.view).includes('private!'));
});

test('invalid model responses and actions never reach the game adapter', async () => {
  let submissions = 0;
  const game = {async readView(){return {game:'test',version:0,status:'active',turn:0,publicState:{},legalActions:['yes']};},async submit(){submissions++;}};
  for (const result of [null, {action:'no'}, {action:'yes',reason:'secret'}, {action:''}]) {
    const match=createAgentMatch({game,agents:[{async choose(){return result;}},{async choose(){}}]});
    assert.equal((await match.step({seat:0})).status,'invalid-action');
  }
  assert.equal(submissions,0);
});

test('busy, cancellation, stale version and uncertain submission are distinct and never automatically retried', async () => {
  let finish;
  const blocked = new Promise(resolve=>{finish=resolve;});
  const game={async readView(){return {version:0,status:'active',turn:0,publicState:{},legalActions:['go']};},async submit(){return {status:'conflict'};}};
  const agents=[{async choose(){await blocked;return {action:'go'};}},{async choose(){}}];
  const match=createAgentMatch({game,agents,timeoutMs:1000});
  const first=match.step({seat:0});
  assert.equal((await match.step({seat:0})).status,'busy'); finish();
  assert.equal((await first).status,'conflict');
  let count=0;
  const uncertain=createAgentMatch({game:{...game,async submit(){count++;throw Error('network lost');}},agents:[{async choose(){return {action:'go'};}},agents[1]]});
  assert.equal((await uncertain.step({seat:0})).status,'submission-unknown'); assert.equal(count,1);
  const controller=new AbortController();controller.abort();
  assert.equal((await uncertain.step({seat:0,signal:controller.signal})).status,'cancelled');
});

test('a timed-out model cannot submit a delayed answer', async () => {
  let resolveLate, submissions=0;
  const reply = new Promise(resolve=>{resolveLate=resolve;});
  const game={async readView(){return {version:0,status:'active',turn:0,publicState:{},legalActions:['go']};},
    async submit(){submissions++;return {status:'applied',version:1};}};
  const match=createAgentMatch({game,agents:[{async choose(){return reply;}},{async choose(){}}],timeoutMs:10});
  assert.equal((await match.step({seat:0})).status,'model-timeout');
  resolveLate({action:'go'});await new Promise(resolve=>setImmediate(resolve));
  assert.equal(submissions,0);
});

test('room and model failures are classified without returning sensitive exception text', async () => {
  const agent={async choose(){throw Error('private model rule and credential');}};
  const view={game:'test',version:0,status:'active',turn:0,publicState:{},legalActions:['go']};
  const readError=createAgentMatch({game:{async readView(){throw Error('private room token')},async submit(){}},agents:[agent,agent]});
  assert.deepEqual(await readError.step({seat:0}),{status:'room-unavailable'});
  const modelError=createAgentMatch({game:{async readView(){return view},async submit(){}},agents:[agent,agent]});
  assert.deepEqual(await modelError.step({seat:0}),{status:'model-unavailable'});
});

test('streaming agent supplies only its own view and requires complete structured output', async () => {
  let request;
  const provider={async *stream(input){request=input;yield {type:'delta',text:'{"action":"e2e4"}'};yield {type:'complete'};}};
  const agent=createStreamingMoveAgent({provider});
  const result=await agent.choose({seat:0,view:{version:0,ownPrivateContext:'own',publicState:{}},signal:new AbortController().signal});
  assert.deepEqual(result,{action:'e2e4'});assert.equal(request.messages.length,1);
  assert.deepEqual(request.memories,[]);assert(!('tools' in request));
  const malformed=createStreamingMoveAgent({provider:{async *stream(){yield {type:'delta',text:'e2e4'};yield {type:'complete'};}}});
  assert.equal(await malformed.choose({seat:0,view:{version:0},signal:new AbortController().signal}),null);
});

test('two separately injected streaming fixtures take legal chess turns without shared private input', async () => {
  const transport = chessTransport(), seen = [];
  const providers = ['e2e4', 'e7e5'].map((action, seat) => ({async *stream(input) {
    seen[seat] = JSON.parse(input.messages[0].text);
    yield {type:'delta',text:JSON.stringify({action})}; yield {type:'complete'};
  }}));
  const game = createChessMatchAdapter({transport,getOwnPrivateContext:async({seat})=>seat?'black-rule':'white-rule'});
  const match = createAgentMatch({game,agents:providers.map(provider=>createStreamingMoveAgent({provider}))});
  assert.equal((await match.step({seat:0})).status,'applied');
  assert.equal((await match.step({seat:1})).status,'applied');
  assert.equal(seen[0].view.ownPrivateContext,'white-rule');
  assert.equal(seen[1].view.ownPrivateContext,'black-rule');
  assert(!JSON.stringify(seen[0]).includes('black-rule'));
  assert(!JSON.stringify(seen[1]).includes('white-rule'));
  assert.deepEqual(transport.actions.map(x=>x.action),['e2e4','e7e5']);
});

test('a complete chess game reaches checkmate and neither agent plays afterwards', async () => {
  const transport=chessTransport();
  const actions=[['e2e4','d1h5','f1c4','h5f7'],['e7e5','b8c6','g8f6']];
  let calls=0;
  const agents=actions.map(moves=>({async choose(){calls++;return {action:moves.shift()}}}));
  const game=createChessMatchAdapter({transport});
  const match=createAgentMatch({game,agents});
  for(const seat of [0,1,0,1,0,1,0]) assert.equal((await match.step({seat})).status,'applied');
  assert.equal((await match.step({seat:1})).status,'finished');
  assert.equal((await match.step({seat:0})).status,'finished');
  assert.equal(calls,7);
});
