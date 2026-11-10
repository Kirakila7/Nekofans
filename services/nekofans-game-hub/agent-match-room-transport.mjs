import catalog from './game-catalog.cjs';

// A private, trusted-host transport for the existing seat-authenticated room
// API. Caller acquires/retains its seat tokens and decides which server to use;
// this module neither creates rooms nor discovers credentials. Never expose
// this closure to the renderer or the model.
function createTransport({ origin, roomId, credentials, fetchImpl = fetch } = {}) {
  let base;
  try { base = new URL(origin); } catch { throw TypeError('invalid origin'); }
  if (base.origin !== origin || base.username || base.password || base.search || base.hash ||
      !(base.protocol === 'https:' || (base.protocol === 'http:' && ['localhost','127.0.0.1','[::1]'].includes(base.hostname)))) throw TypeError('invalid origin');
  if (!/^[A-Za-z0-9_-]{24}$/.test(roomId || '')) throw TypeError('invalid room id');
  if (typeof fetchImpl !== 'function') throw TypeError('fetch required');
  async function request({ seat, action, expectedVersion, signal, includeRoomStatus=false }) {
    if (seat !== 0 && seat !== 1) throw TypeError('invalid seat');
    if (typeof credentials[seat] !== 'string') throw TypeError('seat is not authorized');
    const submitting = action !== undefined;
    if (submitting && (typeof action !== 'string' || !action || action.length > 1024 || !Number.isSafeInteger(expectedVersion) || expectedVersion < 0)) throw TypeError('invalid action');
    const response = await fetchImpl(`${origin}/rooms/${roomId}/${submitting ? 'actions' : 'state'}`, {
      method: submitting ? 'POST' : 'GET', redirect: 'error', signal,
      headers: { authorization: `Bearer ${credentials[seat]}`, ...(submitting ? {'content-type':'application/json'} : {}) },
      ...(submitting ? {body: JSON.stringify({action, expectedVersion})} : {}),
    });
    if (submitting && response.status === 409) return { status:'conflict' };
    if (submitting && response.status === 400) return { status:'rejected' };
    if (!response.ok) throw Error('room unavailable');
    let text;
    if (response.body && typeof response.body.getReader === 'function') {
      const reader = response.body.getReader(), chunks = []; let bytes = 0;
      try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          bytes += chunk.value.byteLength;
          if (bytes > 100000) { await reader.cancel().catch(() => {}); throw Error('room response too large'); }
          chunks.push(Buffer.from(chunk.value));
        }
      } finally { reader.releaseLock(); }
      text = Buffer.concat(chunks).toString('utf8');
    } else {
      // In-memory test doubles may expose only text(); native fetch streams.
      text = await response.text();
      if (Buffer.byteLength(text) > 100000) throw Error('room response too large');
    }
    const value = JSON.parse(text);
    if (submitting) {
      if (response.status !== 201 || value?.seat !== seat || value?.action !== action || value?.version !== expectedVersion + 1) throw Error('unexpected submission response');
      return { status:'applied', version:value.version };
    }
    if (value?.seat !== seat || typeof value?.ready !== 'boolean' || !Array.isArray(value?.actions) || (value.decisionRequired !== undefined && typeof value.decisionRequired !== 'boolean')) throw Error('invalid seat state');
    // Only the canonical public action fields cross into the game adapter.
    const actions=value.actions.map(({seat:player,action:move,version})=>({seat:player,action:move,version}));
    const view={ready:value.ready,decisionRequired:value.decisionRequired===true,actions};
    if(!includeRoomStatus)return view;
    const gameId=value.gameId ?? catalog.DEFAULT_GAME;
    if(!catalog.getGame(gameId)||actions.some(({seat:player,action:move,version},index)=>![0,1].includes(player)||!catalog.acceptsAction(gameId,move)||version!==index+1))throw Error('invalid public game action');
    return {...view,gameId,...(value.finished===true?{finished:true}:{}),players:value.players===2?2:1,executorOnline:value.executorOnline===true,
      ownRuleStatus:['empty','processing','ready'].includes(value.ownRuleStatus)?value.ownRuleStatus:'empty',
      opponentReady:value.opponentReady===true};
  }
  return Object.freeze({
    readState: ({seat,signal}) => request({seat,signal}),
    readSeatView: ({seat,signal}) => request({seat,signal,includeRoomStatus:true}),
    submitMove: ({seat,expectedVersion,action,signal}) => request({seat,expectedVersion,action,signal}),
  });
}

// Each player's workbench holds only its own capability. Calls for the other
// seat fail before any network request and no second token is needed.
export function createSeatRoomTransport({origin,roomId,seat,seatToken,fetchImpl=fetch}={}) {
  if (![0,1].includes(seat) || typeof seatToken !== 'string' || !/^[A-Za-z0-9_-]{24}$/.test(seatToken)) throw TypeError('seat credential required');
  const credentials = Object.freeze({[seat]:seatToken});
  return createTransport({origin,roomId,credentials,fetchImpl});
}

// Trusted two-seat harness for isolated tests or a trusted service. Do not
// use it to transfer one participant's credential to another participant.
export function createRoomTransport({origin,roomId,seatTokens,fetchImpl=fetch}={}) {
  if (!Array.isArray(seatTokens) || seatTokens.length !== 2 || seatTokens.some(token => typeof token !== 'string' || !/^[A-Za-z0-9_-]{24}$/.test(token)) || seatTokens[0] === seatTokens[1]) throw TypeError('two distinct seat credentials required');
  return createTransport({origin,roomId,credentials:Object.freeze({0:seatTokens[0],1:seatTokens[1]}),fetchImpl});
}

