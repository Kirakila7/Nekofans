'use strict';
const path=require('node:path');
const {pathToFileURL}=require('node:url');
const {generateKeyPairSync,createPrivateKey,createPublicKey}=require('node:crypto');
const {WorkbenchSecretStore}=require('./main-chat-secret.cjs');
const {createCompanionAccountProvider}=require('./companion-account-provider.cjs');
const {createOwnRuleStore}=require('./private-own-rule-store.cjs');

function createPrivateGameRuntime({rpc,repositoryRoot,dataDir,safeStorage,fetchImpl=fetch,getOwnPersona=async()=>null}={}){
 if(typeof rpc!=='function'||typeof repositoryRoot!=='string'||typeof dataDir!=='string')throw TypeError('game runtime dependencies required');
 const store=new WorkbenchSecretStore(path.join(dataDir,'private-game','signing-key.encrypted'),safeStorage);
 let keyPromise,worker=null,controller=null,timer=null,lastSuccess=0,epoch=0,origin=null,seatSession=null;
 const localSeats=new Map();
 let connectingSeat=false,seatEpoch=0,manualMove=null;
 const loadSeatClient=()=>import(pathToFileURL(path.join(repositoryRoot,'services/nekofans-game-hub/private-seat-client.mjs')).href);
 const seatKey=session=>session.inviteUrl+':'+session.seat;
 const ownRule=createOwnRuleStore({getOwnSeatSession:()=>seatSession,submitRule:({session,rule,signal})=>session.transport.submitOwnRule({rule,signal})});
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
 async function stop(){epoch++;controller?.abort();controller=null;clearTimeout(timer);timer=null;worker=null;origin=null;lastSuccess=0;return status();}
 async function start({url}={}){
  if(typeof url!=='string'||!/^https:\/\/[a-z0-9-]+\.trycloudflare\.com$/.test(url)||new URL(url).origin!==url)throw Error('请输入有效的临时游戏服务器地址');
  await stop();const myEpoch=epoch,id=await identity(),provider=createCompanionAccountProvider(rpc,{namespace:'game'});
  if((await provider.status()).status!=='signed-in')throw Error('请先登录 DeepSeek 工作台账号');
  const {createPrivateGameWorker}=await import(pathToFileURL(path.join(repositoryRoot,'services/nekofans-game-hub/private-game-worker.mjs')).href);
  if(epoch!==myEpoch)throw Error('连接已取消');
  origin=url;controller=new AbortController();worker=createPrivateGameWorker({origin:url,privateKey:id.privateKey,provider,fetchImpl});
  const current=worker,signal=controller.signal;
  const tick=async()=>{if(epoch!==myEpoch||signal.aborted)return;const result=await current.runOnce({signal});if(epoch!==myEpoch||signal.aborted)return;if(['idle','processed'].includes(result.status))lastSuccess=Date.now();timer=setTimeout(tick,1500);timer.unref?.();};
  await tick();return status();
 }
 function activateSeat(next){
  if(seatSession!==next){agentEpoch++;agent.stop();seatSession=next;agentStatus={status:'idle'};}
  localSeats.set(next.inviteUrl,next);
  return {status:'paired',seat:next.seat,roomId:next.roomId};
 }
 async function create({url}={}){
  if(connectingSeat)return {status:'busy'};
  if(localSeats.size>=24)return {status:'seat-limit'};
  connectingSeat=true;const current=seatEpoch;
  try{
   if(url&&(!worker||url!==origin))await start({url});
   if(!status().connected)throw Error('游戏服务器或 DeepSeek 尚未连接');
   const result=await worker.createRoom({signal:controller.signal});
   if(result.status!=='created')throw Error('创建房间失败');
   const {createOwnSeatSession}=await loadSeatClient();
   if(seatEpoch!==current)return {status:'cancelled'};
   const token=new URLSearchParams(new URL(result.ownerUrl).hash.slice(1)).get('seat');
   activateSeat(createOwnSeatSession({origin:new URL(result.inviteUrl).origin,roomId:result.roomId,seat:0,token,fetchImpl}));
   return result;
  }finally{connectingSeat=false;}
 }
 async function openOwnSeat({inviteUrl}={}){
  if(connectingSeat)return {status:'busy'};
  const {parsePrivateRoomInvite,joinOwnSeat}=await loadSeatClient();
  let invite;try{invite=parsePrivateRoomInvite(inviteUrl);}catch{return {status:'invalid-invite'};}
  if(connectingSeat)return {status:'busy'};
  const saved=localSeats.get(invite.inviteUrl);
  if(saved)return activateSeat(saved);
  if(localSeats.size>=24)return {status:'seat-limit'};
  connectingSeat=true;const current=seatEpoch;
  try{
   const result=await joinOwnSeat({inviteUrl:invite.inviteUrl,fetchImpl});
   if(seatEpoch!==current)return {status:'cancelled'};
   return result.status==='joined'?activateSeat(result.session):{status:result.status};
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
   let next;try{next=await redeemOwnSeat({origin:url,roomId,code,fetchImpl});}catch{throw Error('配对码无效、已使用或已过期');}
   if(seatEpoch!==current)return {status:'cancelled'};
   // Re-pairing can represent a different authority. Clear the old local rule.
   if(seatSession?.inviteUrl===next.inviteUrl)ownRule.clear();
   return activateSeat(next);
  }finally{connectingSeat=false;}
 }
 // Trusted main-process callers only; never expose this transport through IPC.
 function getOwnSeatSession(){return seatSession;}
 function forgetOwnSeat(){seatEpoch++;agentEpoch++;agent.stop();ownRule.clear();seatSession=null;localSeats.clear();uncertainGames.clear();}
 const matchesSeat=inviteUrl=>!!seatSession&&(inviteUrl===undefined||seatSession.inviteUrl===inviteUrl);
 function submitOwnRule({inviteUrl,text}={}){return matchesSeat(inviteUrl)?ownRule.submit({text}):{status:'not-paired'};}
 async function readSeatView({inviteUrl}={}){
  if(typeof inviteUrl!=='string'||!matchesSeat(inviteUrl))return {status:'not-paired'};
  const session=seatSession;
  try{
   const view=await session.transport.readSeatView({seat:session.seat,signal:AbortSignal.timeout(8000)});
   if(session!==seatSession)return {status:'not-paired'};
   return {status:'ready',seat:session.seat,...view,agent:agentStatus};
  }catch{return {status:'unavailable'};}
 }
 async function boardHtml({inviteUrl}={}){
  if(typeof inviteUrl!=='string'||!matchesSeat(inviteUrl))return {status:'not-paired'};
  const {privateChessBoard}=await import(pathToFileURL(path.join(repositoryRoot,'services/nekofans-game-hub/private-chess-board.mjs')).href);
  return matchesSeat(inviteUrl)?{status:'ready',html:privateChessBoard}:{status:'not-paired'};
 }
 async function playMove({inviteUrl,action,expectedVersion}={}){
  if(typeof inviteUrl!=='string'||!matchesSeat(inviteUrl))return {status:'not-paired'};
  if(typeof action!=='string'||!/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(action)||!Number.isSafeInteger(expectedVersion)||expectedVersion<0||expectedVersion>=300)return {status:'rejected'};
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
  if(uncertainGames.has(seatKey(session)))return {status:'reconciliation-required'};
  if(!(await ownRule.getOwnRule({roomId:session.roomId,seat:session.seat})))return {status:'own-rule-unavailable'};
  if((await createCompanionAccountProvider(rpc,{namespace:'game-player'}).status()).status!=='signed-in')return {status:'account-unavailable'};
  let persona;try{persona=await getOwnPersona({});}catch{}if(!persona?.id||!persona?.name||!persona?.prompt)return {status:'own-agent-unavailable'};
  if(seatSession!==session||agentEpoch!==thisEpoch)return {status:'cancelled'};
  agentStatus={status:'running'};agentRun=agent.run({maxMoves:100,maxDurationMs:3600000,maxWaitCycles:900}).then(result=>{if(result.status==='submission-unknown'&&localSeats.get(session.inviteUrl)===session)uncertainGames.add(seatKey(session));if(seatSession===session)agentStatus={status:result.status,moves:result.moves||0};}).catch(()=>{if(seatSession===session)agentStatus={status:'unavailable'};}).finally(()=>{agentRun=null;});
  return {status:'started'};}finally{agentStarting=false;}
 }
 function stopAgent({inviteUrl}={}){if(inviteUrl!==undefined&&!matchesSeat(inviteUrl))return {status:'not-paired'};agentEpoch++;agent.stop();return {status:agentRun||agentStarting?'stopping':'idle'};}
 return Object.freeze({status,publicKey,start,stop,create,pairOwnSeat,openOwnSeat,readSeatView,boardHtml,playMove,getOwnSeatSession,forgetOwnSeat,submitOwnRule,ownRuleStatus:ownRule.view,getOwnRule:ownRule.getOwnRule,startAgent,stopAgent,agentStatus:()=>agentStatus});
}
module.exports={createPrivateGameRuntime};
