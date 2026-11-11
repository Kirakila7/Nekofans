import { compilePrivateRule, parseRuleProposal, permitsPrivateMove, inspectPrivateTurn } from './private-chess-compiler.mjs';

// Construct only inside the trusted authoritative game process. Player
// endpoints must authenticate seats before calling this object. Its closures
// intentionally expose no model output, rule text or compiled effect.
export function createPrivateChessRoom({ provider } = {}) {
  const entries = [{status:'empty', effect:null}, {status:'empty', effect:null}];
  let locked = false;
  const view = seat => {
    if (![0,1].includes(seat)) throw new TypeError('invalid seat');
    return { ownStatus:entries[seat].status, opponentReady:entries[1-seat].status === 'ready', rulesActive:locked };
  };
  async function submit({ seat, rule, preset, signal } = {}) {
    if (![0,1].includes(seat)) return {status:'invalid'};
    if (locked || entries[seat].status === 'ready') return {status:'already-submitted'};
    if (entries[seat].status === 'processing') return {status:'busy'};
    if (preset !== undefined) {
      if (rule !== undefined || !preset || Object.keys(preset).sort().join(',') !== 'choice,turns') return {status:'invalid'};
      const effect = parseRuleProposal(JSON.stringify({kind:'opponent-piece-ban',piece:preset.choice,turns:preset.turns}));
      if (!effect) return {status:'invalid'};
      entries[seat] = {status:'ready',effect};
      return {status:'ready'};
    }
    entries[seat].status='processing';
    const result=await compilePrivateRule({provider,rule,signal,timeoutMs:50000});
    if (result.status === 'compiled') {entries[seat]={status:'ready',effect:result.effect}; return {status:'ready'};}
    entries[seat]={status:'empty',effect:null};
    return {status:result.status};
  }
  function start() {
    if (locked) return {status:'already-started'};
    if (!entries.every(e=>e.status==='ready')) return {status:'not-ready'};
    locked=true;return {status:'active'};
  }
  function permitsMove({actions,seat,action}) {
    return locked && permitsPrivateMove({actions,seat,action,effects:entries.map(e=>e.effect)});
  }
  function turnStatus(actions) {return locked?inspectPrivateTurn({actions,effects:entries.map(e=>e.effect)}):'unavailable';}
  return Object.freeze({view,submit,start,permitsMove,turnStatus});
}
