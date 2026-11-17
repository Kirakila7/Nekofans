'use strict';
const path = require('node:path');
const {pathToFileURL} = require('node:url');

function abortable(operation, signal) {
  return new Promise((resolve,reject)=>{
    const abort=()=>reject(Error('cancelled'));
    if(signal.aborted)return abort();
    signal.addEventListener('abort',abort,{once:true});
    Promise.resolve().then(operation).then(resolve,reject).finally(()=>signal.removeEventListener('abort',abort));
  });
}

// Trusted main process only. A host must bind getOwnRule to the player's
// confirmed room/seat and keep it separate from renderers, histories and logs.
// This module does not submit or verify rules and does not start on its own.
function createPrivateAgentSession({repositoryRoot, getOwnSeatSession, getOwnRule, getOwnPersona, provider}={}) {
  if(typeof repositoryRoot!=='string'||typeof getOwnSeatSession!=='function'||typeof getOwnRule!=='function'||typeof getOwnPersona!=='function'||!provider||typeof provider.stream!=='function')throw TypeError('private agent dependencies required');
  let current=null, epoch=0;
  async function run({signal,onEvent,maxMoves=20,maxDurationMs=600000,intervalMs=1000,maxWaitCycles=180,wait}={}) {
    if(current)return {status:'busy'};
    if(!Number.isSafeInteger(maxDurationMs)||maxDurationMs<100||maxDurationMs>3600000)return {status:'invalid-limits'};
    const paired=getOwnSeatSession();
    if(!paired||![0,1].includes(paired.seat)||typeof paired.roomId!=='string'||!paired.transport)return {status:'not-paired'};
    const thisEpoch=++epoch;
    const state={runner:null,abort:new AbortController()}; current=state;
    const cancel=()=>state.abort.abort();
    const deadline=setTimeout(cancel,maxDurationMs);
    if(signal?.aborted)cancel();else signal?.addEventListener('abort',cancel,{once:true});
    const active=()=>!state.abort.signal.aborted&&epoch===thisEpoch&&getOwnSeatSession()===paired;
    try {
      // The trusted callback may return only the rule confirmed for this seat
      // and this room; the session never fetches or receives the opponent rule.
      const rule=await abortable(()=>getOwnRule({roomId:paired.roomId,seat:paired.seat,signal:state.abort.signal}),state.abort.signal);
      if(!active())return {status:'cancelled'};
      if(!rule||rule.roomId!==paired.roomId||rule.seat!==paired.seat||typeof rule.text!=='string'||!rule.text.trim()||[...rule.text].length>256||rule.confirmed!==true)return {status:'own-rule-unavailable'};
      const persona=await abortable(()=>getOwnPersona({signal:state.abort.signal}),state.abort.signal);
      if(!active())return {status:'cancelled'};
      if(!persona||typeof persona.id!=='string'||!persona.id.trim()||typeof persona.name!=='string'||!persona.name.trim()||typeof persona.prompt!=='string'||!persona.prompt.trim())return {status:'own-agent-unavailable'};
      const base=path.join(repositoryRoot,'services','nekofans-game-hub');
      const [{createChessMatchAdapter},{createSeatAgentMatch,createStreamingMoveAgent},{createSeatAgentRunner}]=await abortable(()=>Promise.all([
        import(pathToFileURL(path.join(base,'agent-match-chess.mjs')).href),
        import(pathToFileURL(path.join(base,'agent-match.mjs')).href),
        import(pathToFileURL(path.join(base,'agent-match-runner.mjs')).href),
      ]),state.abort.signal);
      if(!active())return {status:'cancelled'};
      // Refuse old paired sessions after logout, forget or re-pair; this check
      // occurs both before reading and immediately before a possible submission.
      const transport={
        readState(input){if(!active()||input.seat!==paired.seat)throw Error('session expired');return paired.transport.readState(input)},
        submitMove(input){if(!active()||input.seat!==paired.seat)throw Error('session expired');return paired.transport.submitMove(input)},
      };
      const ownRule=rule.text.trim();
      const game=createChessMatchAdapter({transport,getOwnPrivateContext:async({seat})=>{if(!active()||seat!==paired.seat)throw Error('session expired');return {rule:ownRule}}});
      const agent=createStreamingMoveAgent({provider,persona});
      const match=createSeatAgentMatch({game,seat:paired.seat,agent});
      state.runner=createSeatAgentRunner({match,maxMoves,maxDurationMs,intervalMs,maxWaitCycles,...(wait?{wait}:{})});
      const event=typeof onEvent==='function'?value=>{if(active())onEvent(value)}:undefined;
      return await state.runner.run({signal:state.abort.signal,...(event?{onEvent:event}:{})});
    } catch {return {status:active()?'unavailable':'cancelled'};}
    finally {clearTimeout(deadline);signal?.removeEventListener('abort',cancel);if(current===state)current=null;}
  }
  function stop(){epoch++;current?.abort.abort();current?.runner?.stop();}
  return Object.freeze({run,stop});
}
module.exports={createPrivateAgentSession};
