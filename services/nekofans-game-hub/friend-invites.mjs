import {createPrivateKey, createPublicKey, randomBytes, sign, verify} from 'node:crypto';
import gameOrigin from './private-game-origin.cjs';

const ISSUER = 'https://community.project-neko.cn';
const {GAME_ORIGIN} = gameOrigin;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ID = /^[A-Za-z0-9_-]{24}$/;
const SEGMENT = /^[A-Za-z0-9_-]+$/;
const LIFETIME = 15 * 60 * 1000;
const newId = () => randomBytes(18).toString('base64url');
const matches = (pattern, value) => typeof value === 'string' && pattern.test(value);
const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');

// Mount on the N.E.K.O. community origin with its existing auth middleware
// and relationship store. The game server only needs the matching public key.
export function createFriendInviteIssuer({issuerKey, authenticate, mayInvite, now = Date.now}){
 const key = issuerKey?.type === 'private' ? issuerKey : createPrivateKey(issuerKey);
 if(key.asymmetricKeyType !== 'ed25519')throw TypeError('invalid game invitation signing key');
 const head = encode({alg:'EdDSA',typ:'neko-game-invite+jwt'});
 return async function issue({authorization,body}){
  const {op,target,room} = body??{};
  if(op!=='inbox'&&op!=='send')return {status:'invalid'};
  const account=await authenticate(authorization);
  if(!matches(UUID,account?.id))return {status:'sign-in-required'};
  if(op==='send'){
   if(!matches(UUID,target)||target===account.id||!matches(ID,room))return {status:'invalid'};
   if(!await mayInvite(account.id,target))return {status:'forbidden'};
  }
  const iat=Math.floor(now()/1000);
  const claims={iss:ISSUER,aud:GAME_ORIGIN,sub:account.id,op,iat,exp:iat+45};
  if(op==='send')Object.assign(claims,{target,room,name:typeof account.name==='string'?account.name.slice(0,80):''});
  const message=head+'.'+encode(claims);
  const ticket=message+'.'+sign(null,Buffer.from(message),key).toString('base64url');
  return {status:'ready',ticket,userId:account.id};
 };
}

// The issuer maps its authenticated session to a community UUID. A send ticket
// also attests to a current, unblocked mutual friendship with the exact target.
// The inbox never receives the issuer's community OAuth access or refresh token.
export function createFriendInvites({issuerKey, rooms, now = Date.now}){
 const key = issuerKey?.type === 'public' ? issuerKey : createPublicKey(issuerKey);
 if(key.asymmetricKeyType !== 'ed25519')throw TypeError('invalid game invitation issuer key');
 const byRoom = new Map(), byId = new Map();
 function prune(){
  const current = now();
  for(const [roomId, invite] of byRoom){
   if(!rooms.has(roomId) || (!invite.accepted && invite.expires <= current)){
    byRoom.delete(roomId);byId.delete(invite.id);
   }
  }
 }
 function principal(header, op){
  if(typeof header !== 'string' || header.length > 2048 || !header.startsWith('Bearer '))return null;
  const parts = header.slice(7).split('.');
  if(parts.length !== 3 || !parts.every(p=>SEGMENT.test(p)) || parts[2].length !== 86)return null;
  try{
   const [encodedHeader, payload, signature] = parts;
   const head = JSON.parse(Buffer.from(encodedHeader,'base64url'));
   if(head?.alg !== 'EdDSA' || head.typ !== 'neko-game-invite+jwt')return null;
   if(!verify(null,Buffer.from(encodedHeader+'.'+payload),key,Buffer.from(signature,'base64url')))return null;
   const claims = JSON.parse(Buffer.from(payload,'base64url'));
   const time = Math.floor(now()/1000);
   if(claims?.iss !== ISSUER || claims.aud !== GAME_ORIGIN || claims.op !== op ||
      !matches(UUID,claims.sub) || !Number.isSafeInteger(claims.iat) || !Number.isSafeInteger(claims.exp) ||
      claims.iat > time+5 || claims.exp <= time || claims.exp <= claims.iat || claims.exp-claims.iat > 60)return null;
   if(op === 'send' && (!matches(UUID,claims.target) || claims.target === claims.sub || !matches(ID,claims.room)))return null;
   return claims;
  }catch{return null;}
 }
 function list(owner){
  prune();
  return [...byId.values()].filter(i=>i.target===owner).sort((a,b)=>b.created-a.created)
   .map(({id,roomId,sender,created,accepted})=>({id,sender,created,accepted,title:rooms.get(roomId).adapter.info.title}));
 }
 function create(roomId, room, sender){
  prune();
  if(room.seats.length !== 1)return {status:'room-full'};
  const previous = byRoom.get(roomId);
  if(previous?.senderId === sender.sub && previous.target === sender.target)return {status:'sent'};
  if(previous)byId.delete(previous.id);
  const created = now();
  const invite = {id:newId(), roomId, senderId:sender.sub, target:sender.target, created, expires:created+LIFETIME,
   sender:typeof sender.name === 'string' ? sender.name.trim().slice(0,80) || 'N.E.K.O. 好友' : 'N.E.K.O. 好友', accepted:false};
  byRoom.set(roomId,invite);byId.set(invite.id,invite);
  return {status:'sent'};
 }
 function accept(id, owner){
  prune();
  const invite = byId.get(id);
  if(!invite || invite.target !== owner)return {status:'not-found'};
  const room = rooms.get(invite.roomId);
  if(!invite.accepted){
   if(room.seats.length !== 1)return {status:'room-full'};
   room.seats.push(newId());invite.accepted = true;
  }
  return {status:'joined',roomId:invite.roomId,seat:1,token:room.seats[1]};
 }
 function reserved(roomId){
  prune();
  const invite = byRoom.get(roomId);
  return !!invite && !invite.accepted;
 }
 return Object.freeze({principal,list,create,accept,reserved});
}
