import {createSeatRoomTransport} from './agent-match-room-transport.mjs';

const SEAT_ID=/^[A-Za-z0-9_-]{24}$/;
const TRIAL_ORIGIN=/^https:\/\/[a-z0-9-]+\.trycloudflare\.com$/;

export function parsePrivateRoomInvite(value) {
 let url;
 if(typeof value!=='string'||value.length>300||value.includes('#'))throw TypeError('invalid room invitation');
 try{url=new URL(value);}catch{throw TypeError('invalid room invitation');}
 const entries=[...url.searchParams];
 if(!TRIAL_ORIGIN.test(url.origin)||url.username||url.password||url.pathname!=='/'||
    entries.length!==1||entries[0][0]!=='room'||!SEAT_ID.test(entries[0][1]))throw TypeError('invalid room invitation');
 return {origin:url.origin,roomId:entries[0][1],inviteUrl:url.origin+'/?room='+entries[0][1]};
}

// Only trusted callers may construct a session from an issued credential.
// The transport keeps the bearer in its closure.
export function createOwnSeatSession({origin,roomId,seat,token,fetchImpl=fetch}) {
 if(!TRIAL_ORIGIN.test(origin)||!SEAT_ID.test(roomId)||![0,1].includes(seat)||typeof token!=='string'||!SEAT_ID.test(token))throw TypeError('invalid seat credential');
 const basic=createSeatRoomTransport({origin,roomId,seat,seatToken:token,fetchImpl});
 const transport=Object.freeze({...basic,async submitOwnRule({rule,signal}={}){
  if(typeof rule!=='string'||!rule.trim()||[...rule.trim()].length>80||/[\u0000-\u001f\u007f]/.test(rule))return {status:'invalid'};
  const response=await fetchImpl(`${origin}/rooms/${roomId}/rule`,{method:'POST',redirect:'error',signal,headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify({rule:rule.trim()})});
  const body=await response.text();if(body.length>1024)throw Error('invalid rule response');
  const data=JSON.parse(body);if(response.status===201&&data?.status==='ready')return {status:'ready'};
  if([400,409,503].includes(response.status)&&['invalid','unsupported','busy','unavailable','already-submitted','waiting-for-player'].includes(data?.status))return {status:data.status};
  throw Error('rule submission outcome unknown');
 }});
 return Object.freeze({seat,roomId,origin,inviteUrl:origin+'/?room='+roomId,transport});
}

export async function joinOwnSeat({inviteUrl,fetchImpl=fetch}={}) {
 const {origin,roomId}=parsePrivateRoomInvite(inviteUrl);
 const response=await fetchImpl(`${origin}/rooms/${roomId}/join`,{method:'POST',redirect:'error',signal:AbortSignal.timeout(10000)});
 if(response.status===404)return {status:'room-not-found'};
 if(response.status===409)return {status:'room-full'};
 if(response.status!==201)throw Error('join outcome unknown');
 const raw=await response.text();if(raw.length>1024)throw Error('invalid join response');
 const value=JSON.parse(raw);
 if(!value||Object.keys(value).join(',')!=='token')throw Error('invalid join response');
 return {status:'joined',session:createOwnSeatSession({origin,roomId,seat:1,token:value.token,fetchImpl})};
}

// Trusted workbench main-process only. A code is single use, short lived, and
// supplied as POST data, never as a URL. Only the local seat token is retained
// in the returned transport closure; it is not returned as data to a renderer.
export async function redeemOwnSeat({origin,roomId,code,fetchImpl=fetch,signal}={}) {
 if(typeof origin!=='string'||!/^https:\/\/[a-z0-9-]+\.trycloudflare\.com$/.test(origin)||new URL(origin).origin!==origin)throw TypeError('invalid temporary origin');
 if(!/^[A-Za-z0-9_-]{24}$/.test(roomId||'')||!/^[A-Za-z0-9_-]{24}$/.test(code||'')||typeof fetchImpl!=='function')throw TypeError('invalid pairing data');
 const controller=new AbortController(),cancel=()=>controller.abort(),timer=setTimeout(cancel,10000);
 if(signal?.aborted)controller.abort();else signal?.addEventListener('abort',cancel,{once:true});
 try {
  const response=await fetchImpl(`${origin}/rooms/${roomId}/redeem`,{method:'POST',redirect:'error',signal:controller.signal,headers:{'content-type':'application/json'},body:JSON.stringify({code})});
  if(!response.ok)throw Error('pairing unavailable');
  const raw=await response.text();if(raw.length>1024)throw Error('invalid pairing response');
  const value=JSON.parse(raw);
  if(!value||![0,1].includes(value.seat)||!/^[A-Za-z0-9_-]{24}$/.test(value.token||'')||Object.keys(value).some(key=>!['seat','token'].includes(key)))throw Error('invalid pairing response');
  return createOwnSeatSession({origin,roomId,seat:value.seat,token:value.token,fetchImpl});
 }finally{clearTimeout(timer);signal?.removeEventListener('abort',cancel);}
}
