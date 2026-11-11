'use strict';

// Coordinates real authentication owners. No cookie, OAuth code, grant or
// credential enters this module; public status alone never creates a login.
const TEXT=Object.freeze({idle:'登录 N.E.K.O. 账号后可连接社区和聊天室。',checking:'正在确认 N.E.K.O. 登录状态…',unavailable:'N.E.K.O. 登录状态暂不可读取，请刷新后重试。',community:'请完成 N.E.K.O. 官方登录，随后会继续聊天室授权。',chatroom:'正在连接聊天室，请完成官方授权确认。',done:'N.E.K.O. 社区和聊天室已连接同一账号。',connected:'社区和聊天室均已登录，可直接使用。',partial:'社区和聊天室的账号身份不同，请检查后重新连接。',failed:'聊天室授权未完成，请检查账号状态后重试。',changed:'N.E.K.O. 账号已变化，请重新连接聊天室。',canceled:'已取消本次连接，已有登录已保留。',timeout:'N.E.K.O. 登录等待已结束，请重试。'});
function createUnifiedNekoLogin({getCommunity,getLobby,requestCommunityLogin,cancelCommunityLogin=()=>{},signInLobby,reauthorizeLobby,verifyLobbyIdentity,cancelLobby,closeAuthorization=()=>{},onState=()=>{},timers=globalThis,timeoutMs=300000}={}){
 let current=null,disposed=false,serial=0,lastCommunityId=null,linkedCommunityId=null,canceling=Promise.resolve(),state={status:'idle',message:TEXT.idle,error:'',source:null,flowId:0,lobbyAvailable:false,identityStatus:'unverified'};
 const identity=value=>typeof value==='string'&&value.length>0&&value.length<=128?value:null;
 const community=()=>{try{return getCommunity()||{};}catch{return {};}};
 const lobby=()=>{try{return getLobby()||{};}catch{return {};}};
 const snapshot=()=>({...state});
 function publish(status,message,error='',operation=current){state={status,message,error,source:operation?.source??state.source,flowId:operation?.id??state.flowId,lobbyAvailable:lobby().auth?.status==='signed-in',identityStatus:operation?.identityStatus||'unverified'};try{onState(snapshot());}catch{}return snapshot();}
 function principal(value){const p=value?.identity;if(p?.verified!==true||!identity(p.subject)||typeof p.issuer!=='string')return null;try{const issuer=new URL(p.issuer);if(issuer.protocol!=='https:'||issuer.username||issuer.password||issuer.search||issuer.hash)return null;return {issuer:issuer.href,subject:p.subject};}catch{return null;}}
 function alive(operation){return !disposed&&current===operation&&operation.id===serial;}
 const close=()=>{try{Promise.resolve(closeAuthorization()).catch(()=>{});}catch{}};
 function finish(operation,status,message,error=''){if(!alive(operation))return;timers.clearTimeout(operation.timer);current=null;close();publish(status,message,error,operation);}
 function cancel(message=TEXT.canceled,status='canceled'){
  const operation=current;current=null;++serial;if(operation)timers.clearTimeout(operation.timer);
  // Cancellation does not sign either owner out or clear a retained grant.
  if(operation?.phase==='chatroom')canceling=canceling.then(()=>cancelLobby()).catch(()=>{});
  if(operation?.phase==='community')try{Promise.resolve(cancelCommunityLogin()).catch(()=>{});}catch{}
  close();return {ok:true,state:publish(status,message,'',operation)};
 }
 async function connectLobby(operation){
  if(!alive(operation)||operation.running)return;operation.running=true;operation.phase='chatroom';operation.communityId=identity(community().userId);
  publish('chatroom',TEXT.chatroom);
  try{
   // A retry must not join an old owner's still-settling canceled OAuth flow.
   await canceling;if(!alive(operation))return;
   const before=lobby(),already=before.auth?.status==='signed-in';
   let result={ok:true};
   if(!already)result=await signInLobby();
   else if(operation.reauthorize)result=await reauthorizeLobby();
   if(!alive(operation))return;
   const actual=community();if(actual.status!=='signed-in'||identity(actual.userId)!==operation.communityId){cancel(TEXT.changed,'partial');return;}
   if(result?.ok!==true||lobby().auth?.status!=='signed-in'){finish(operation,'partial',TEXT.failed,TEXT.failed);return;}
   const verified=await verifyLobbyIdentity();if(!alive(operation))return;
   const latest=community();if(latest.status!=='signed-in'||identity(latest.userId)!==operation.communityId){cancel(TEXT.changed,'partial');return;}
   const a=principal(community()),b=principal(verified),same=!!a&&!!b&&a.issuer===b.issuer&&a.subject===b.subject;
   operation.identityStatus=same?'verified':a&&b?'different':'unverified';
   linkedCommunityId=same?operation.communityId:null;
   finish(operation,same?'signed-in':a&&b?'partial':'connected',same?TEXT.done:a&&b?TEXT.partial:TEXT.connected);
  }catch{finish(operation,'partial',TEXT.failed,TEXT.failed);}
 }
 function begin(request={}){
  if(!request||typeof request!=='object'||Array.isArray(request)||Object.keys(request).some(key=>!['source','reauthorize'].includes(key))||request.source!==undefined&&!['lobby','account','friends'].includes(request.source)||request.reauthorize!==undefined&&typeof request.reauthorize!=='boolean')throw Error('N.E.K.O. 登录来源无效');
  if(disposed)return {ok:false,state:snapshot()};if(current)return {ok:true,state:snapshot()};
  const operation={id:++serial,source:request.source||'account',reauthorize:request.reauthorize===true,phase:'community',running:false,communityId:null,timer:null};current=operation;
  operation.timer=timers.setTimeout(()=>{if(alive(operation))cancel(TEXT.timeout,'error');},timeoutMs);operation.timer?.unref?.();
  const actual=community();
  if(actual.status==='signed-in'){lastCommunityId=identity(actual.userId);void connectLobby(operation);}
  else if(actual.status==='checking')publish('checking',TEXT.checking);
  else if(actual.status==='unavailable')finish(operation,'error',TEXT.unavailable,TEXT.unavailable);
  else requestCommunity(operation);
  return {ok:true,state:snapshot()};
 }
 function requestCommunity(operation){if(!alive(operation)||operation.communityRequested)return;operation.communityRequested=true;publish('community',TEXT.community);try{Promise.resolve(requestCommunityLogin()).catch(()=>finish(operation,'error',TEXT.failed,TEXT.failed));}catch{finish(operation,'error',TEXT.failed,TEXT.failed);}}
 function communityChanged(value=community()){
  if(disposed)return;
  if(value.status==='signed-in'){
   const id=identity(value.userId),changed=lastCommunityId&&id&&lastCommunityId!==id;lastCommunityId=id;
   if(changed||current?.communityId&&id!==current.communityId||linkedCommunityId&&id!==linkedCommunityId){linkedCommunityId=null;cancel(TEXT.changed,'partial');return;}
   if(current?.phase==='community')void connectLobby(current);
  }else if(value.status==='signed-out'){
   const hadIdentity=lastCommunityId||linkedCommunityId;lastCommunityId=null;linkedCommunityId=null;
   if(current?.phase==='community'){requestCommunity(current);return;}
   if(current?.phase==='chatroom'||hadIdentity&&!current)cancel(TEXT.changed,'partial');
  }else if(value.status==='unavailable'&&current?.phase==='community')finish(current,'error',TEXT.unavailable,TEXT.unavailable);
 }
 function lobbyChanged(){if(disposed||current)return;if(['signed-in','connected'].includes(state.status)&&lobby().auth?.status!=='signed-in'){linkedCommunityId=null;publish('partial',TEXT.changed);}}
 function dispose(){if(disposed)return;cancel();disposed=true;}
 return Object.freeze({begin,cancel,communityChanged,lobbyChanged,snapshot,dispose});
}
module.exports={createUnifiedNekoLogin,TEXT};
