import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRoomTransport,createSeatRoomTransport} from './agent-match-room-transport.mjs';
import {createAgentMatch,createSeatAgentMatch} from './agent-match.mjs';
import {createChessMatchAdapter} from './agent-match-chess.mjs';
const seatTokens=['a'.repeat(24),'b'.repeat(24)],roomId='r'.repeat(24),origin='https://room.example';
const reply=(status,value)=>({status,ok:status>=200&&status<300,text:async()=>JSON.stringify(value)});
function fixture(){const actions=[],seen=[];return {actions,seen,async fetch(url,options){seen.push({url,options});const seat=seatTokens.indexOf(options.headers.authorization.slice(7));if(seat<0)return reply(401,{});if(url.endsWith('/state'))return reply(200,{seat,ready:true,actions,privateOpponentRule:'do not expose'});const body=JSON.parse(options.body);if(body.expectedVersion!==actions.length)return reply(409,{});const item={seat,action:body.action,version:actions.length+1};actions.push(item);return reply(201,item);}};}
test('two distinct authorized seats play through the room transport without token or opponent-rule exposure',async()=>{
 const f=fixture(),transport=createRoomTransport({origin,roomId,seatTokens,fetchImpl:f.fetch});const inputs=[];
 const game=createChessMatchAdapter({transport,getOwnPrivateContext:async({seat})=>seat?'my black secret':'my white secret'});
 const agents=['e2e4','e7e5'].map(action=>({async choose(x){inputs.push(x.view);return {action}}}));
 const match=createAgentMatch({game,agents});assert.equal((await match.step({seat:0})).status,'applied');assert.equal((await match.step({seat:1})).status,'applied');
 assert.deepEqual(f.actions.map(x=>x.action),['e2e4','e7e5']);assert(!JSON.stringify(inputs).includes(seatTokens[0]));assert(!JSON.stringify(inputs).includes(seatTokens[1]));assert(!JSON.stringify(inputs).includes('do not expose'));assert(!JSON.stringify(inputs[0]).includes('my black secret'));assert(!JSON.stringify(inputs[1]).includes('my white secret'));
 assert(f.seen.every(x=>!x.url.includes(seatTokens[0])&&!x.url.includes(seatTokens[1])));assert(f.seen.every(x=>x.options.redirect==='error'));
});
test('bad seat, misbound response, conflicts and lost response fail safely',async()=>{
 const mismatch=createRoomTransport({origin,roomId,seatTokens,fetchImpl:async()=>reply(200,{seat:1,ready:true,actions:[]})});await assert.rejects(mismatch.readState({seat:0}));
 const conflict=createRoomTransport({origin,roomId,seatTokens,fetchImpl:async()=>reply(409,{})});assert.equal((await conflict.submitMove({seat:0,expectedVersion:0,action:'e2e4'})).status,'conflict');
 let count=0;const lost=createRoomTransport({origin,roomId,seatTokens,fetchImpl:async()=>{count++;throw Error('lost');}});await assert.rejects(lost.submitMove({seat:0,expectedVersion:0,action:'e2e4'}));assert.equal(count,1);
 assert.throws(()=>createRoomTransport({origin:'http://public.example',roomId,seatTokens}));assert.throws(()=>createRoomTransport({origin,roomId,seatTokens:[seatTokens[0],seatTokens[0]]}));
});
test('invalid success responses, server failure and oversized streams fail without repeating submission',async()=>{
 for (const [status,payload] of [[201,{seat:1,action:'e2e4',version:1}],[201,{seat:0,action:'e2e4',version:3}],[201,{seat:0,action:'d2d4',version:1}],[503,{}]]) {
  let calls=0;const t=createRoomTransport({origin,roomId,seatTokens,fetchImpl:async()=>{calls++;return reply(status,payload)}});
  await assert.rejects(t.submitMove({seat:0,expectedVersion:0,action:'e2e4'}));assert.equal(calls,1);
 }
 let cancelled=false;const big={status:200,ok:true,body:{getReader(){return {async read(){return {done:false,value:new Uint8Array(100001)}},async cancel(){cancelled=true},releaseLock(){}}}}};
 const t=createRoomTransport({origin,roomId,seatTokens,fetchImpl:async()=>big});await assert.rejects(t.readState({seat:0}),/large/);assert.equal(cancelled,true);
});
test('decision-required room pauses both agents without requesting a move or submitting',async()=>{
 let submits=0,choices=0;
 const transport=createRoomTransport({origin,roomId,seatTokens,fetchImpl:async(url,options)=>{
  if(url.endsWith('/actions')){submits++;return reply(500,{})}
  return reply(200,{seat:seatTokens.indexOf(options.headers.authorization.slice(7)),ready:false,decisionRequired:true,actions:[]});
 }});
 const match=createAgentMatch({game:createChessMatchAdapter({transport}),agents:[0,1].map(()=>({async choose(){choices++;return {action:'e2e4'}}}))});
 assert.deepEqual(await match.step({seat:0}),{status:'decision-required'});
 assert.deepEqual(await match.step({seat:1}),{status:'decision-required'});
 assert.equal(choices,0);assert.equal(submits,0);
});
test('malformed decisionRequired does not silently become a waiting or playable state',async()=>{
 const transport=createRoomTransport({origin,roomId,seatTokens,fetchImpl:async()=>reply(200,{seat:0,ready:true,decisionRequired:'true',actions:[]})});
 await assert.rejects(transport.readState({seat:0}),/invalid seat state/);
});
test('two separate hosts each need only their own seat token and agent',async()=>{
 const f=fixture(), contexts=[];
 const hosts=seatTokens.map((seatToken,seat)=>{
  const transport=createSeatRoomTransport({origin,roomId,seat,seatToken,fetchImpl:f.fetch});
  const game=createChessMatchAdapter({transport,getOwnPrivateContext:async({seat:which})=>{
   assert.equal(which,seat);return `private-${seat}`;
  }});
  const agent={async choose({view}){contexts.push({seat,view});return {action:seat?'e7e5':'e2e4'}}};
  return {transport, match:createSeatAgentMatch({game,seat,agent})};
 });
 await assert.rejects(hosts[0].transport.readState({seat:1}),/not authorized/);
 await assert.rejects(hosts[1].transport.submitMove({seat:0,expectedVersion:0,action:'e2e4'}),/not authorized/);
 assert.equal(f.seen.length,0);
 assert.equal((await hosts[0].match.step()).status,'applied');
 assert.equal((await hosts[0].match.step()).status,'not-your-turn');
 assert.equal((await hosts[1].match.step()).status,'applied');
 assert.deepEqual(f.actions.map(a=>a.action),['e2e4','e7e5']);
 assert.equal(contexts[0].view.ownPrivateContext,'private-0');assert.equal(contexts[1].view.ownPrivateContext,'private-1');
 assert(!JSON.stringify(contexts).includes(seatTokens[0]));assert(!JSON.stringify(contexts).includes(seatTokens[1]));
 assert(!JSON.stringify(contexts[0]).includes('private-1'));assert(!JSON.stringify(contexts[1]).includes('private-0'));
});
