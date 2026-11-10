'use strict';
const path=require('node:path');
const {pathToFileURL}=require('node:url');
const {generateKeyPairSync,createPrivateKey,createPublicKey,createHash}=require('node:crypto');
const {WorkbenchSecretStore}=require('./main-chat-secret.cjs');
const {createCompanionAccountProvider}=require('./companion-account-provider.cjs');
const {createOwnRuleStore}=require('./private-own-rule-store.cjs');

function createPrivateGameRuntime({rpc,repositoryRoot,dataDir,safeStorage,fetchImpl=fetch,getOwnPersona=async()=>null,getSeatOwner=async()=>null}={}){
 if(typeof rpc!=='function'||typeof repositoryRoot!=='string'||typeof dataDir!=='string')throw TypeError('game runtime dependencies required');
 const store=new WorkbenchSecretStore(path.join(dataDir,'private-game','signing-key.encrypted'),safeStorage);
 const {GAME_ORIGIN,isPrivateGameOrigin:validOrigin}=require(path.join(repositoryRoot,'services/nekofans-game-hub/private-game-origin.cjs'));
 const catalog=require(path.join(repositoryRoot,'services/nekofans-game-hub/game-catalog.cjs'));
 let keyPromise,worker=null,controller=null,timer=null,heartbeatTimer=null,lastSuccess=0,connectionIssue=null,epoch=0,origin=null,seatSession=null;
 const localSeats=new Map();
 const gameBySeat=new WeakMap(),ownerBySeat=new WeakMap(),studioBySeat=new WeakMap();
 let connectingSeat=false,seatEpoch=0,manualMove=null;
 const loadSeatClient=()=>import(pathToFileURL(path.join(repositoryRoot,'services/nekofans-game-hub/private-seat-client.mjs')).href);
 const seatKey=session=>session.inviteUrl+':'+session.seat;
 const ownRule=createOwnRuleStore({getOwnSeatSession:()=>seatSession,timeoutMs:55000,submitRule:({session,rule,preset,signal})=>session.transport.submitOwnRule({rule,preset,signal})});
 const {createPrivateAgentSession}=require('./private-agent-session.cjs');
 const agent=createPrivateAgentSession({repositoryRoot,getOwnSeatSession:()=>seatSession,getOwnRule:ownRule.getOwnRule,getOwnPersona,provider:createCompanionAccountProvider(rpc,{namespace:'game-player'})});
 let agentStatus={status:'idle'},agentRun=null,agentStarting=false,agentEpoch=0;const uncertainGames=new Set();
 async function identity(){
  if(keyPromise)return keyPromise;
  keyPromise=(async()=>{let encoded=await store.get();if(!encoded){const pair=generateKeyPairSync('ed25519');encoded=pair.privateKey.export({format:'der',type:'pkcs8'}).toString('base64');await store.set(encoded);}
   const key=createPrivateKey({key:Buffer.from(encoded,'base64'),format:'der',type:'pkcs8'});if(key.asymmetricKeyType!=='ed25519')throw Error('游戏签名密钥无效');
   return {privateKey:key,publicKey:createPublicKey(key).export({format:'pem',type:'spki'}).toString()};})();
  try{return await keyPromise;}catch(error){keyPromise=null;throw error;}
 }
 function status(){return {running:!!worker,connected:!!worker&&Date.now()-lastSuccess<15000,origin};}
 async function publicKey(){return (await identity()).publicKey;}
 async function stop(){epoch++;controller?.abort();controller=null;clearTimeout(timer);clearInterval(heartbeatTimer);timer=null;heartbeatTimer=null;worker=null;origin=null;lastSuccess=0;connectionIssue=null;return status();}
 async function newWorker(url,provider){
  const id=await identity();
  const {createPrivateGameWorker}=await import(pathToFileURL(path.join(repositoryRoot,'services/nekofans-game-hub/private-game-worker.mjs')).href);
  return createPrivateGameWorker({origin:url,privateKey:id.privateKey,provider,fetchImpl});
 }
 async function start({url}={}){
  if(!validOrigin(url))throw Error('请输入有效的游戏服务器地址');
  await stop();const myEpoch=epoch,provider=createCompanionAccountProvider(rpc,{namespace:'game'});
  if((await provider.status()).status!=='signed-in')throw Object.assign(Error('请先登录 DeepSeek 工作台账号'),{code:'account-unavailable'});
  const current=await newWorker(url,provider);
  if(epoch!==myEpoch)throw Error('连接已取消');
  origin=url;controller=new AbortController();worker=current;
  const signal=controller.signal;
  let heartbeating=false;
  heartbeatTimer=setInterval(async()=>{
   if(signal.aborted||heartbeating)return;
   heartbeating=true;
   try{if(await current.heartbeat({signal})&&!signal.aborted){lastSuccess=Date.now();connectionIssue=null;}}
   finally{heartbeating=false;}
  },4000);
  heartbeatTimer.unref?.();
  const tick=async()=>{if(epoch!==myEpoch||signal.aborted)return;const result=await current.runOnce({signal});if(epoch!==myEpoch||signal.aborted)return;if(['idle','processed'].includes(result.status)){lastSuccess=Date.now();connectionIssue=null;}else connectionIssue=result.status;timer=setTimeout(tick,1500);timer.unref?.();};
  await tick();
  return status();
 }
 function activateSeat(next){
  if(seatSession!==next){agentEpoch++;agent.stop();seatSession=next;agentStatus={status:'idle'};}
  localSeats.set(next.inviteUrl,next);
  return {status:'paired',seat:next.seat,roomId:next.roomId};
 }
 function savedSeat(owner,inviteUrl){
  const id=createHash('sha256').update(JSON.stringify([owner,inviteUrl])).digest('hex');
  return new WorkbenchSecretStore(path.join(dataDir,'private-game','seats',id+'.encrypted'),safeStorage);
 }
 async function remember(owner,inviteUrl,{seat,token}){
  if(!owner)return;
  try{await savedSeat(owner,inviteUrl).set(JSON.stringify({seat,token,expires:Date.now()+21600000}));}catch{/* keep the current session usable */}
 }
 async function create({url,gameId=catalog.DEFAULT_GAME,definition}={}){
  if(!catalog.getGame(gameId))return {status:'invalid-game'};
  if(connectingSeat)return {status:'busy'};
  if(localSeats.size>=24)return {status:'seat-limit'};
  connectingSeat=true;const current=seatEpoch;
  try{
   url=url||origin||GAME_ORIGIN;
   const owner=await getSeatOwner();
   let publisher=worker&&origin===url?worker:await newWorker(url,createCompanionAccountProvider(rpc,{namespace:'game'}));
   const modern=await publisher.supportsGameCatalog(gameId);
   if(!modern){
    if(gameId===catalog.STUDIO_GAME)return {status:'authoring-unavailable'};
    if(gameId!==catalog.DEFAULT_GAME)return {status:'invalid-game'};
    if(!status().connected||url!==origin){
     try{await start({url});}catch(error){if(error.code==='account-unavailable')return {status:error.code};throw error;}
    }
    if(!status().connected)return {status:connectionIssue||'unavailable'};
    publisher=worker;
   }
   const result=await publisher.createRoom({signal:worker===publisher?controller.signal:undefined,gameId,definition,catalogVerified:modern});
   if(result.status!=='created')return result;
   const {createOwnSeatSession}=await loadSeatClient();
   if(seatEpoch!==current)return {status:'cancelled'};
   const token=new URLSearchParams(new URL(result.ownerUrl).hash.slice(1)).get('seat');
   const next=createOwnSeatSession({origin:new URL(result.inviteUrl).origin,roomId:result.roomId,seat:0,token,fetchImpl});
   await remember(owner,result.inviteUrl,{seat:0,token});
   if(seatEpoch!==current)return {status:'cancelled'};
   ownerBySeat.set(next,owner);gameBySeat.set(next,gameId);
   activateSeat(next);
   if(modern&&gameId===catalog.DEFAULT_GAME&&(!status().running||origin!==url))void start({url}).catch(()=>{});
   return result;
  }finally{connectingSeat=false;}
 }
 async function openOwnSeat({inviteUrl}={}){
  if(connectingSeat)return {status:'busy'};
  const {parsePrivateRoomInvite,joinOwnSeat,createOwnSeatSession}=await loadSeatClient();
  let invite;try{invite=parsePrivateRoomInvite(inviteUrl);}catch{return {status:'invalid-invite'};}
  if(connectingSeat)return {status:'busy'};
  connectingSeat=true;const current=seatEpoch;
  try{
   const owner=await getSeatOwner();
   const saved=localSeats.get(invite.inviteUrl);
   if(seatEpoch!==current)return {status:'cancelled'};
   if(saved){
    const knownOwner=ownerBySeat.get(saved);
    if(knownOwner&&knownOwner!==owner)return {status:'account-changed'};
    if(!knownOwner&&owner)ownerBySeat.set(saved,owner);
    return activateSeat(saved);
   }
   if(localSeats.size>=24)return {status:'seat-limit'};
   if(owner){
    let record;try{record=JSON.parse(await savedSeat(owner,invite.inviteUrl).get()||'null');}catch{}
    if(record?.expires>Date.now()){
     const recovered=createOwnSeatSession({...invite,seat:record.seat,token:record.token,fetchImpl});
     if(seatEpoch!==current)return {status:'cancelled'};
     ownerBySeat.set(recovered,owner);
     return activateSeat(recovered);
    }
   }
   const result=await joinOwnSeat({inviteUrl:invite.inviteUrl,fetchImpl,onJoined:details=>remember(owner,invite.inviteUrl,details)});
   if(seatEpoch!==current)return {status:'cancelled'};
   if(result.status!=='joined')return {status:result.status};
   ownerBySeat.set(result.session,owner);
   return activateSeat(result.session);
  }catch{return {status:'join-unknown'};}
  finally{connectingSeat=false;}
 }
 async function pairOwnSeat({url,roomId,code}={}){
  if(connectingSeat)return {status:'busy'};
  if(localSeats.size>=24)return {status:'seat-limit'};
  connectingSeat=true;const current=seatEpoch;
  try{
   const provider=createCompanionAccountProvider(rpc,{namespace:'game-player'});
   if((await provider.status()).status!=='signed-in')throw Error('请先登录自己的 DeepSeek 工作台账号');
   const {redeemOwnSeat}=await loadSeatClient();
   const owner=await getSeatOwner();
   let next;try{next=await redeemOwnSeat({origin:url,roomId,code,fetchImpl,onJoined:details=>remember(owner,url+'/?room='+roomId,details)});}catch{throw Error('配对码无效、已使用或已过期');}
   if(seatEpoch!==current)return {status:'cancelled'};
   // Re-pairing can represent a different authority. Clear the old local rule.
   if(seatSession?.inviteUrl===next.inviteUrl)ownRule.clear();
   ownerBySeat.set(next,owner);return activateSeat(next);
  }finally{connectingSeat=false;}
 }
 // Trusted main-process callers only; never expose this transport through IPC.
 function getOwnSeatSession(){return seatSession;}
 function forgetOwnSeat(){seatEpoch++;agentEpoch++;agent.stop();ownRule.clear();seatSession=null;localSeats.clear();uncertainGames.clear();}
 function seatOwnerChanged(owner){
  const previous=seatSession&&ownerBySeat.get(seatSession);
  if(!previous||previous===owner)return;
  seatEpoch++;agentEpoch++;agent.stop();ownRule.clear();seatSession=null;agentStatus={status:'idle'};
 }
 const matchesSeat=inviteUrl=>!!seatSession&&(inviteUrl===undefined||seatSession.inviteUrl===inviteUrl);
 function submitOwnRule({inviteUrl,text,preset}={}){
  if(!matchesSeat(inviteUrl))return {status:'not-paired'};
  const game=catalog.getGame(gameBySeat.get(seatSession)??catalog.DEFAULT_GAME);
  if(preset===undefined)return game?.customRules?ownRule.submit({text}):{status:'unsupported'};
  const choice=game?.preset.choices.find(([id])=>id===preset?.choice);
  if(!choice||!game.preset.turns.includes(preset.turns))return {status:'invalid'};
  const description=game.id===catalog.STUDIO_GAME?choice[1]:
    game.id==='chess'?'对手前'+preset.turns+'回合不能移动'+choice[1]:'对手首回合不能落在'+choice[1];
  return ownRule.submit({text:description,preset:{choice:choice[0],turns:preset.turns}});
 }
 async function readSeatView({inviteUrl}={}){
  if(typeof inviteUrl!=='string'||!matchesSeat(inviteUrl))return {status:'not-paired'};
  const session=seatSession;
  try{
   const view=await session.transport.readSeatView({seat:session.seat,signal:AbortSignal.timeout(8000)});
   if(view.gameId===catalog.STUDIO_GAME&&!studioBySeat.has(session)){
    const infoUrl=new URL('/rooms/'+session.roomId+'/info',session.inviteUrl).href;
    const result=await fetchImpl(infoUrl,{redirect:'error',signal:AbortSignal.timeout(8000)});
    if(!result.ok)return {status:'unavailable'};
    const body=await result.json();
    const {gameAdapter}=await import(pathToFileURL(path.join(repositoryRoot,'services/nekofans-game-hub/private-game-registry.mjs')).href);
    const adapter=gameAdapter(view.gameId,body.definition);
    if(!adapter)return {status:'unavailable'};
    studioBySeat.set(session,adapter);
   }
   if(session!==seatSession)return {status:'not-paired'};
   gameBySeat.set(session,view.gameId);
   return {status:'ready',seat:session.seat,...view,game:studioBySeat.get(session)?.info??catalog.gameInfo(view.gameId),agent:agentStatus};
  }catch{return {status:'unavailable'};}
 }
 async function boardHtml({inviteUrl}={}){
  if(typeof inviteUrl!=='string'||!matchesSeat(inviteUrl))return {status:'not-paired'};
  const session=seatSession;
  const current=await readSeatView({inviteUrl});
  if(current.status!=='ready'||session!==seatSession)return {status:'unavailable'};
  const {gameAdapter}=await import(pathToFileURL(path.join(repositoryRoot,'services/nekofans-game-hub/private-game-registry.mjs')).href);
  const adapter=studioBySeat.get(session)??gameAdapter(current.gameId);
  return session===seatSession?{status:'ready',html:adapter.html,game:current.game}:{status:'not-paired'};
 }
 async function playMove({inviteUrl,action,expectedVersion}={}){
  if(typeof inviteUrl!=='string'||!matchesSeat(inviteUrl))return {status:'not-paired'};
  if(!catalog.acceptsAction(gameBySeat.get(seatSession)??catalog.DEFAULT_GAME,action)||!Number.isSafeInteger(expectedVersion)||expectedVersion<0||expectedVersion>=300)return {status:'rejected'};
  if(agentRun||agentStarting||manualMove)return {status:'busy'};
  const session=seatSession;
  if(uncertainGames.has(seatKey(session)))return {status:'reconciliation-required'};
  manualMove=session;
  try{return await session.transport.submitMove({seat:session.seat,action,expectedVersion,signal:AbortSignal.timeout(8000)});}
  catch{if(localSeats.get(session.inviteUrl)===session)uncertainGames.add(seatKey(session));return {status:'submission-unknown'};}
  finally{manualMove=null;}
 }
 async function startAgent({inviteUrl}={}){
  if(agentRun||agentStarting||manualMove)return {status:'busy'};agentStarting=true;const thisEpoch=agentEpoch;try{const session=seatSession;if(!matchesSeat(inviteUrl))return {status:'not-paired'};
  if(!catalog.getGame(gameBySeat.get(session)??catalog.DEFAULT_GAME)?.teammate)return {status:'agent-game-unsupported'};
  if(uncertainGames.has(seatKey(session)))return {status:'reconciliation-required'};
  if(!(await ownRule.getOwnRule({roomId:session.roomId,seat:session.seat})))return {status:'own-rule-unavailable'};
  if((await createCompanionAccountProvider(rpc,{namespace:'game-player'}).status()).status!=='signed-in')return {status:'account-unavailable'};
  let persona;try{persona=await getOwnPersona({});}catch{}if(!persona?.id||!persona?.name||!persona?.prompt)return {status:'own-agent-unavailable'};
  if(seatSession!==session||agentEpoch!==thisEpoch)return {status:'cancelled'};
  agentStatus={status:'running'};agentRun=agent.run({maxMoves:100,maxDurationMs:3600000,maxWaitCycles:900}).then(result=>{if(result.status==='submission-unknown'&&localSeats.get(session.inviteUrl)===session)uncertainGames.add(seatKey(session));if(seatSession===session)agentStatus={status:result.status,moves:result.moves||0};}).catch(()=>{if(seatSession===session)agentStatus={status:'unavailable'};}).finally(()=>{agentRun=null;});
  return {status:'started'};}finally{agentStarting=false;}
 }
 function stopAgent({inviteUrl}={}){if(inviteUrl!==undefined&&!matchesSeat(inviteUrl))return {status:'not-paired'};agentEpoch++;agent.stop();return {status:agentRun||agentStarting?'stopping':'idle'};}
 return Object.freeze({status,publicKey,start,stop,create,pairOwnSeat,openOwnSeat,readSeatView,boardHtml,playMove,getOwnSeatSession,forgetOwnSeat,seatOwnerChanged,submitOwnRule,ownRuleStatus:ownRule.view,getOwnRule:ownRule.getOwnRule,startAgent,stopAgent,agentStatus:()=>agentStatus});
}
module.exports={createPrivateGameRuntime};
