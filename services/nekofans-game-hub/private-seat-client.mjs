import {createSeatRoomTransport} from './agent-match-room-transport.mjs';

import gameOrigin from './private-game-origin.cjs';

const {GAME_ORIGIN,isPrivateGameOrigin,parsePrivateRoomInvite}=gameOrigin;
const SEAT_ID=/^[A-Za-z0-9_-]{24}$/;
export {parsePrivateRoomInvite};

// This endpoint family is fixed to the game service. No credential is sent
// to an address taken from an invitation, a web page or a renderer.
export async function friendInviteRequest(path,{fetchImpl=fetch,method='GET',ticket,ownerToken}={}){
 if(!/^\/(?:invitations(?:\/status|\/[A-Za-z0-9_-]{24}\/accept)?|rooms\/[A-Za-z0-9_-]{24}\/invite)$/.test(path))throw TypeError('invalid invite endpoint');
 const headers={Accept:'application/json'};
 if(ticket)headers.authorization='Bearer '+ticket;
 if(ownerToken)headers['x-neko-room-seat']=ownerToken;
 const response=await fetchImpl(GAME_ORIGIN+path,{method,headers,redirect:'error',signal:AbortSignal.timeout(8000)});
 if(response.redirected)return {status:'unavailable'};
 let size=0;
 const chunks=[];
 for await(const chunk of response.body??[]){
  size+=chunk.byteLength;
  if(size>32768)return {status:'unavailable'};
  chunks.push(chunk);
 }
 const data=JSON.parse(Buffer.concat(chunks).toString('utf8'));
 if(path==='/invitations/status')return {enabled:response.ok&&data.enabled===true};
 return response.ok||[401,403,404,409].includes(response.status)?data:{status:'unavailable'};
}

// Only trusted callers may construct a session from an issued credential.
// The transport keeps the bearer in its closure.
export function createOwnSeatSession({origin,roomId,seat,token,fetchImpl=fetch}) {
 if(!isPrivateGameOrigin(origin)||!SEAT_ID.test(roomId)||![0,1].includes(seat)||typeof token!=='string'||!SEAT_ID.test(token))throw TypeError('invalid seat credential');
 const basic=createSeatRoomTransport({origin,roomId,seat,seatToken:token,fetchImpl});
 const transport=Object.freeze({...basic,
 async inviteFriend(ticket){
  if(seat!==0||origin!==GAME_ORIGIN)return {status:'forbidden'};
  return friendInviteRequest('/rooms/'+roomId+'/invite',{method:'POST',ticket,ownerToken:token,fetchImpl});
 },
 async submitOwnRule({rule,preset,signal}={}){
  if(preset===undefined&&(typeof rule!=='string'||!rule.trim()||[...rule.trim()].length>80||/[\u0000-\u001f\u007f]/.test(rule)))return {status:'invalid'};
  const response=await fetchImpl(`${origin}/rooms/${roomId}/rule`,{method:'POST',redirect:'error',signal,headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify(preset===undefined?{rule:rule.trim()}:{preset})});
  const body=await response.text();if(body.length>1024)throw Error('invalid rule response');
  const data=JSON.parse(body);if(response.status===201&&data?.status==='ready')return {status:'ready'};
  if([400,409,503].includes(response.status)&&['invalid','unsupported','busy','unavailable','already-submitted','waiting-for-player'].includes(data?.status))return {status:data.status};
  throw Error('rule submission outcome unknown');
 }});
 return Object.freeze({seat,roomId,origin,inviteUrl:origin+'/?room='+roomId,transport});
}

export async function joinOwnSeat({inviteUrl,fetchImpl=fetch,onJoined}={}) {
 const {origin,roomId}=parsePrivateRoomInvite(inviteUrl);
 const response=await fetchImpl(`${origin}/rooms/${roomId}/join`,{method:'POST',redirect:'error',signal:AbortSignal.timeout(10000)});
 if(response.status===404)return {status:'room-not-found'};
 if(response.status===409){
  const body=await response.text();
  return {status:body.length<=1024&&body.includes('"invite-reserved"')?'invite-reserved':'room-full'};
 }
 if(response.status!==201)throw Error('join outcome unknown');
 const raw=await response.text();if(raw.length>1024)throw Error('invalid join response');
 const value=JSON.parse(raw);
 if(!value||Object.keys(value).join(',')!=='token')throw Error('invalid join response');
 await onJoined?.({seat:1,token:value.token});
 return {status:'joined',session:createOwnSeatSession({origin,roomId,seat:1,token:value.token,fetchImpl})};
}

// Trusted workbench main-process only. A code is single use, short lived, and
// supplied as POST data, never as a URL. Only the local seat token is retained
// in the returned transport closure; it is not returned as data to a renderer.
export async function redeemOwnSeat({origin,roomId,code,fetchImpl=fetch,signal,onJoined}={}) {
 if(!isPrivateGameOrigin(origin))throw TypeError('invalid game origin');
 if(!/^[A-Za-z0-9_-]{24}$/.test(roomId||'')||!/^[A-Za-z0-9_-]{24}$/.test(code||'')||typeof fetchImpl!=='function')throw TypeError('invalid pairing data');
 const controller=new AbortController(),cancel=()=>controller.abort(),timer=setTimeout(cancel,10000);
 if(signal?.aborted)controller.abort();else signal?.addEventListener('abort',cancel,{once:true});
 try {
  const response=await fetchImpl(`${origin}/rooms/${roomId}/redeem`,{method:'POST',redirect:'error',signal:controller.signal,headers:{'content-type':'application/json'},body:JSON.stringify({code})});
  if(!response.ok)throw Error('pairing unavailable');
  const raw=await response.text();if(raw.length>1024)throw Error('invalid pairing response');
  const value=JSON.parse(raw);
  if(!value||![0,1].includes(value.seat)||!/^[A-Za-z0-9_-]{24}$/.test(value.token||'')||Object.keys(value).some(key=>!['seat','token'].includes(key)))throw Error('invalid pairing response');
  await onJoined?.({seat:value.seat,token:value.token});
  return createOwnSeatSession({origin,roomId,seat:value.seat,token:value.token,fetchImpl});
 }finally{clearTimeout(timer);signal?.removeEventListener('abort',cancel);}
}
