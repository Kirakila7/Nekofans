import {createServer} from 'node:http';
import {randomBytes,timingSafeEqual} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import {createExecutorVerifier,createPrivateRuleRelay,createRelayProvider} from '../private-relay.mjs';
import {createSeatPairing} from '../private-seat-pairing.mjs';
import {gameAdapter} from '../private-game-registry.mjs';
import catalog from '../game-catalog.cjs';
import gameOrigin from '../private-game-origin.cjs';
import {MAX_STUDIO_BYTES} from '../studio-game.mjs';
import {createFriendInvites} from '../friend-invites.mjs';

const token=()=>randomBytes(18).toString('base64url');
const same=(a,b)=>typeof a==='string'&&typeof b==='string'&&Buffer.byteLength(a)===Buffer.byteLength(b)&&timingSafeEqual(Buffer.from(a),Buffer.from(b));
const page=readFileSync(new URL('./index.html',import.meta.url));
export function createPrivateTrial({publicOrigin,publicKey,now=Date.now,relay=createPrivateRuleRelay(),friendInvitePublicKey}={}){
 if(!gameOrigin.isPrivateGameOrigin(publicOrigin))throw Error('a trusted HTTPS game origin is required');
 const verifyRequest=createExecutorVerifier({publicKey,now}),rooms=new Map(),rates=new Map(),provider=createRelayProvider(relay);
 if(friendInvitePublicKey&&publicOrigin!==gameOrigin.GAME_ORIGIN)throw Error('friend invites require the fixed game origin');
 const invites=friendInvitePublicKey&&createFriendInvites({issuerKey:friendInvitePublicKey,rooms,now});
 const send=(res,code,value,headers={})=>{res.writeHead(code,{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff','referrer-policy':'no-referrer',...headers});res.end(JSON.stringify(value));};
 async function read(req, limit=4096){let size=0;const chunks=[];for await(const chunk of req){size+=chunk.length;if(size>limit)throw Error('too large');chunks.push(chunk);}return Buffer.concat(chunks).toString('utf8');}
 const server=createServer(async(req,res)=>{
  try{
   if(req.headers.host!==new URL(publicOrigin).host||req.headers.origin&&req.headers.origin!==publicOrigin)return send(res,403,{error:'invalid origin'});
   const current=now();for(const [id,room] of rooms)if(current-room.created>21600000)rooms.delete(id);
   const ip=req.headers['cf-connecting-ip']||req.socket.remoteAddress;if(typeof ip!=='string'||ip.length>80)return send(res,400,{error:'invalid client'});
   const rate=rates.get(ip);if(!rate||current-rate.start>=60000)rates.set(ip,{start:current,count:1});else if(++rate.count>240)return send(res,429,{error:'请求过多'});
   if(rates.size>2048){for(const [key,value] of rates)if(current-value.start>=60000)rates.delete(key);if(rates.size>2048)return send(res,503,{error:'服务繁忙'});}
   const pathname=new URL(req.url,'http://localhost').pathname;
   if(req.method==='GET'&&pathname==='/'){res.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff','referrer-policy':'no-referrer','content-security-policy':"default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; frame-src 'self'; base-uri 'none'; form-action 'none'"});return res.end(page);}
   if(req.method==='GET'&&pathname==='/games')return send(res,200,{games:catalog.listGames(),authoring:true});
   if(req.method==='GET'&&pathname==='/game')return send(res,200,{html:gameAdapter().html}); // legacy chess clients
   if(req.method==='GET'&&pathname==='/invitations/status')return send(res,200,{enabled:!!invites});
   const acceptInvite=/^\/invitations\/([A-Za-z0-9_-]{24})\/accept$/.exec(pathname);
   if(invites&&((req.method==='GET'&&pathname==='/invitations')||(req.method==='POST'&&acceptInvite))){
    const account=invites.principal(req.headers.authorization,'inbox');
    if(!account)return send(res,401,{status:'sign-in-required'});
    if(!acceptInvite)return send(res,200,{status:'ready',invitations:invites.list(account.sub)});
    const result=invites.accept(acceptInvite[1],account.sub);
    return send(res,result.status==='joined'?200:result.status==='room-full'?409:404,result);
   }
   if(req.method==='POST'&&['/executor/heartbeat','/executor/next','/executor/result','/publisher/rooms'].includes(pathname)){
    const body=await read(req,pathname==='/publisher/rooms'?MAX_STUDIO_BYTES+128:4096);
    if(!verifyRequest({method:req.method,path:pathname,body,timestamp:req.headers['x-neko-time'],nonce:req.headers['x-neko-nonce'],signature:req.headers['x-neko-signature']}))return send(res,401,{error:'unauthorized'});
    let data;try{data=JSON.parse(body||'{}');}catch{return send(res,400,{error:'invalid request'});}
    if(pathname==='/executor/heartbeat'){relay.heartbeat();return send(res,200,{ok:true});}
    if(pathname==='/executor/next')return send(res,200,{job:relay.next()});
    if(pathname==='/executor/result')return send(res,relay.settle(data)?200:409,{ok:true});
    const adapter=gameAdapter(data?.gameId,data?.definition);
    if(!adapter)return send(res,400,{error:'不支持的游戏'});
    if(rooms.size>=24)return send(res,503,{error:'试玩房间已满'});
    const id=token(),seatToken=token();
    rooms.set(id,{created:current,seats:[seatToken],actions:[],adapter,rules:adapter.createRules({provider}),pairing:createSeatPairing({now})});
    return send(res,201,{roomId:id,token:seatToken,gameId:adapter.info.id});
   }
   const match=/^\/rooms\/([A-Za-z0-9_-]{24})\/(join|state|rule|actions|pair|redeem|game|info|invite)$/.exec(pathname),room=match&&rooms.get(match[1]);
   if(!room)return send(res,404,{error:'房间不存在或已过期'});
   const [,roomId,operation]=match;
   const cookieName='neko-seat-'+roomId;
   const cookie=(req.headers.cookie||'').split(/;\s*/).find(v=>v.startsWith(cookieName+'='))?.slice(cookieName.length+1);
   const savedBrowserSeat=room.seats.findIndex(v=>same(v,cookie));
   if(req.method==='POST'&&operation==='invite'&&invites){
    const account=invites.principal(req.headers.authorization,'send');
    if(!account)return send(res,401,{status:'sign-in-required'});
    if(account.room!==roomId||!same(room.seats[0],req.headers['x-neko-room-seat']))return send(res,403,{status:'forbidden'});
    const result=invites.create(roomId,room,account);
    return send(res,result.status==='sent'?200:409,result);
   }
   if(req.method==='GET'&&operation==='info')return send(res,200,{game:room.adapter.info,...(room.adapter.definition?{definition:room.adapter.definition}:{})});
   if(req.method==='POST'&&operation==='join'){
    let data;try{data=JSON.parse(await read(req)||'{}');}catch{return send(res,400,{error:'无效入座请求'});}
    const browser=data?.browser===true;
    if(browser&&req.headers.origin!==publicOrigin)return send(res,403,{error:'invalid origin'});
    if(browser&&savedBrowserSeat>=0)return send(res,200,{seat:savedBrowserSeat});
    if(invites?.reserved(roomId))return send(res,409,{status:'invite-reserved'});
    if(room.seats.length!==1)return send(res,409,{error:'房间已满'});
    const seatToken=token();room.seats.push(seatToken);
    if(!browser)return send(res,201,{token:seatToken});
    const expires=Math.floor((room.created+21600000-current)/1000);
    return send(res,201,{seat:1},{'set-cookie':cookieName+'='+seatToken+'; Path=/rooms/'+roomId+'/; Max-Age='+expires+'; Secure; HttpOnly; SameSite=Strict'});
   }
   if(req.method==='POST'&&match[2]==='redeem'){
    let data;try{data=JSON.parse(await read(req));}catch{return send(res,400,{error:'配对信息无效'});}
    const match=room.pairing.redeem(data?.code);if(!match||!room.seats[match.seat])return send(res,400,{error:'配对码无效或已过期'});
    return send(res,200,{seat:match.seat,token:room.seats[match.seat]});
   }
   const auth=/^Bearer ([A-Za-z0-9_-]{24})$/.exec(req.headers.authorization||'');
   const seat=req.headers.authorization ? room.seats.findIndex(v=>same(v,auth?.[1])) : savedBrowserSeat;
   if(seat<0)return send(res,401,{error:'请重新加入房间'});
   if(!auth&&req.method==='POST'&&req.headers.origin!==publicOrigin)return send(res,403,{error:'invalid origin'});
   if(req.method==='GET'&&operation==='game')return send(res,200,{html:room.adapter.html});
   if(req.method==='POST'&&match[2]==='pair')return send(res,201,room.pairing.issue(seat));
   if(req.method==='GET'&&match[2]==='state'){
    let v=room.rules.view(seat);if(room.seats.length===2&&v.ownStatus==='ready'&&v.opponentReady)room.rules.start();v=room.rules.view(seat);
    const turnStatus=v.rulesActive?room.rules.turnStatus(room.actions):'normal';
    return send(res,200,{seat,gameId:room.adapter.info.id,players:room.seats.length,ready:v.rulesActive&&turnStatus==='normal',decisionRequired:turnStatus==='decision-required',...(turnStatus==='finished'?{finished:true}:{}),ownRuleStatus:v.ownStatus,opponentReady:v.opponentReady,executorOnline:relay.online(),actions:room.actions});
   }
   if(req.method==='POST'&&match[2]==='rule'){
    if(room.seats.length!==2)return send(res,409,{status:'waiting-for-player',error:'等待双方加入'});
    let data;try{data=JSON.parse(await read(req));}catch{return send(res,400,{error:'规则无效'});}
    const result=await room.rules.submit({seat,rule:data?.rule,preset:data?.preset});
    return send(res,result.status==='ready'?201:result.status==='unavailable'?503:['busy','already-submitted'].includes(result.status)?409:400,{status:result.status});
   }
   if(req.method==='POST'&&match[2]==='actions'){
    let data;try{data=JSON.parse(await read(req));}catch{return send(res,400,{error:'走子无效'});}
    if(!room.rules.view(seat).rulesActive)return send(res,409,{error:'等待双方规则准备好'});
    if(data?.expectedVersion!==room.actions.length)return send(res,409,{error:'棋局已更新'});
    const turnStatus=room.rules.turnStatus(room.actions);
    if(turnStatus==='finished')return send(res,409,{error:'对局已经结束'});
    if(turnStatus!=='normal')return send(res,409,{error:'对局暂时暂停，请双方商定如何继续'});
    if(room.actions.length>=room.adapter.maxActions||!catalog.acceptsAction(room.adapter.info.id,data.action)||!room.rules.permitsMove({actions:room.actions,seat,action:data.action}))return send(res,400,{error:'这一步暂时不可用'});
    const action={seat,action:data.action,version:room.actions.length+1};room.actions.push(action);return send(res,201,action);
   }
   return send(res,404,{error:'not found'});
  }catch{return send(res,500,{error:'请求未完成'});}
 });
 server.on('close',()=>relay.close());return server;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 const origin=process.env.TRIAL_PUBLIC_ORIGIN,keyPath=process.env.TRIAL_EXECUTOR_PUBLIC_KEY;
 if(!keyPath)throw Error('executor public key required');
 const inviteKeyPath=process.env.TRIAL_FRIEND_INVITE_PUBLIC_KEY;
 createPrivateTrial({publicOrigin:origin,publicKey:readFileSync(keyPath,'utf8'),
  ...(inviteKeyPath?{friendInvitePublicKey:readFileSync(inviteKeyPath,'utf8')}:{}),
 }).listen(Number(process.env.PORT||3114),'127.0.0.1',()=>console.log('private trial listening on loopback'));
}
