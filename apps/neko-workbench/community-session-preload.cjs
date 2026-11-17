'use strict';
// Read-only adapter for the official community web session. Tokens stay in
// this origin's isolated renderer; IPC contains only account status and contact summaries.
// Contract: official /assets/index-CJ8rQcvj.js (2026-11-02),
// neko-auth-changed + GET /api/users/me, authenticated by the site's OAuth store.
const {ipcRenderer}=require('electron');
if(process.isMainFrame&&location.origin==='https://community.project-neko.cn'){
 let generation=0,timer=null,verified=null,loginAttempt=null;
 // The current official Fa/kC contract only admits OAuth. Legacy credentials
 // and uncommitted OAuth continuation keys are deliberately never consulted.
 const current=()=>({token:localStorage.getItem('neko_oauth_access_token')||'',
  source:localStorage.getItem('neko_auth_source')||'',generation:localStorage.getItem('neko_auth_generation')||'',
  logout:localStorage.getItem('neko_auth_logout_generation')||''});
 const same=(a,b)=>!!a&&!!b&&a.token===b.token&&a.source===b.source&&a.generation===b.generation&&a.logout===b.logout;
 const publish=value=>{ipcRenderer.send('workbench:community-web-account',value);return value;};
 function cancelLogin(){const attempt=loginAttempt;loginAttempt=null;if(!attempt)return;attempt.observer?.disconnect();clearTimeout(attempt.timer);}
 async function read(){
  const ticket=++generation;let session;
  try{session=current();}catch{verified=null;return publish({status:'unavailable'});}
  if(!session.token){verified=null;return publish({status:'signed-out'});}
  // Rechecking an unchanged, verified session must not flap the account UI or
  // send an already signed-in user through the community login screen again.
  if(!same(verified,session)){verified=null;publish({status:'checking'});}
  try{
   const response=await fetch('/api/users/me',{headers:{Accept:'application/json',Authorization:'Bearer '+session.token},redirect:'error',cache:'no-store',signal:AbortSignal.timeout(8000)});
   if(ticket!==generation||!same(current(),session))return;
   if(response.status===401){verified=null;return publish({status:'signed-out'});}
   if(!response.ok)throw Error('unavailable');
   const text=await response.text();if(text.length>65536)throw Error('invalid');const value=JSON.parse(text);
   if(ticket!==generation||!same(current(),session))return;
   const user=value?.user;
   if(!user||typeof user.id!=='string'||!user.id||user.id.length>128)throw Error('invalid');
   verified=session;
   cancelLogin();
   return publish({status:'signed-in',userId:user.id,name:typeof user.display_name==='string'?user.display_name.slice(0,80):typeof user.username==='string'?user.username.slice(0,80):''});
  }catch{if(ticket===generation){verified=null;return publish({status:'unavailable'});}}
 }
 function schedule(){clearTimeout(timer);timer=setTimeout(()=>void read(),100);}
 window.addEventListener('neko-auth-changed',schedule);window.addEventListener('storage',schedule);window.addEventListener('focus',schedule);
 ipcRenderer.on('workbench:community-web-state',schedule);
 ipcRenderer.on('workbench:community-web-friends',async(_event,id)=>{
  if(!Number.isSafeInteger(id)||id<1||location.origin!=='https://community.project-neko.cn')return;
  const answer=value=>ipcRenderer.send('workbench:community-web-friends-result',{id,...value});
  let session;
  try{session=current();}catch{return answer({status:'unavailable'});}
  if(!session.token)return answer({status:'sign-in-required'});
  const signal=AbortSignal.timeout(12000);
  const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  async function json(path){
   const response=await fetch(path,{headers:{Accept:'application/json',Authorization:'Bearer '+session.token},redirect:'error',cache:'no-store',signal});
   if(!response.ok)throw Object.assign(Error('community response'),{status:response.status});
   const reader=response.body.getReader();
   const decoder=new TextDecoder();
   let text='',size=0;
   try{
    for(;;){
     const part=await reader.read();
     if(part.done)break;
     size+=part.value.byteLength;
     if(size>512000){await reader.cancel();throw Error('response too large');}
     text+=decoder.decode(part.value,{stream:true});
    }
   }finally{reader.releaseLock();}
   return JSON.parse(text+decoder.decode());
  }
  try{
   const {user}=await json('/api/users/me');
   if(typeof user?.id!=='string'||!uuid.test(user.id))throw Error('invalid identity');
   const friends=new Map();
   let offset=0;
   for(let page=0;page<100;page++){
    if(!same(current(),session))return answer({status:'account-changed'});
    const result=await json('/api/users/'+user.id+'/following?limit=100&offset='+offset);
    if(!Array.isArray(result?.items)||result.items.length>100||!Number.isSafeInteger(result.total)||result.total<0)throw Error('invalid friends response');
    for(const friend of result.items){
     if(friend?.is_mutual!==true||typeof friend.id!=='string'||!uuid.test(friend.id)||friend.id===user.id||friend.blocked_by_viewer||friend.blocks_viewer)continue;
     const name=[friend.display_name,friend.username].find(value=>typeof value==='string'&&value.trim())||'好友';
     const avatar=[friend.avatar_url,friend.avatarUrl,friend.avatar?.url].find(value=>
      typeof value==='string'&&value.length<=1024&&!/[?#]/.test(value)&&/^(?:https:\/\/|\/(?![\\/])|hue:\d{1,3}$)/i.test(value));
     friends.set(friend.id,{id:friend.id,displayName:name.trim().slice(0,100),online:friend.online===true,...(avatar?{avatar}:{})});
    }
    offset+=result.items.length;
    if(offset>=result.total){
     if(!same(current(),session))return answer({status:'account-changed'});
     return answer({status:'ready',userId:user.id,friends:[...friends.values()]});
    }
    if(!result.items.length)break;
   }
   return answer({status:'unavailable'});
  }catch(error){
   return answer({status:error.status===401?'sign-in-required':error.status===403?'permission-denied':'unavailable'});
  }
 });
 ipcRenderer.on('workbench:community-game-ticket',async(_event,id,input)=>{
  if(!Number.isSafeInteger(id)||id<1||location.origin!=='https://community.project-neko.cn')return;
  const reply=value=>ipcRenderer.send('workbench:community-game-ticket-result',{id,...value});
  const op=input?.op;
  if(op!=='inbox'&&op!=='send')return reply({status:'unavailable'});
  if(op==='send'&&(!/^[a-f0-9-]{36}$/.test(input.target||'')||!/^[A-Za-z0-9_-]{24}$/.test(input.room||'')))return reply({status:'unavailable'});
  try{
   const session=current();
   if(!session.token)return reply({status:'sign-in-required'});
   if(!same(verified,session)){
    const identity=await read();
    if(!same(session,current()))return reply({status:'account-changed'});
    if(identity?.status!=='signed-in')return reply({status:identity?.status==='signed-out'?'sign-in-required':'unavailable'});
   }
   const response=await fetch('/api/game-invites/ticket',{
    method:'POST',redirect:'error',cache:'no-store',signal:AbortSignal.timeout(8000),
    headers:{Accept:'application/json','Content-Type':'application/json',Authorization:'Bearer '+session.token},
    body:JSON.stringify(op==='send'?{op,target:input.target,room:input.room}:{op}),
   });
   if(!same(session,current()))return reply({status:'account-changed'});
   if(response.status===401)return reply({status:'sign-in-required'});
   if(response.status===403)return reply({status:'forbidden'});
   if(!response.ok)return reply({status:'unavailable'});
   const reader=response.body.getReader();
   const decoder=new TextDecoder();
   let body='',length=0;
   try{
    for(;;){
     const {done,value}=await reader.read();
     if(done)break;
     length+=value.byteLength;
     if(length>4096){await reader.cancel();return reply({status:'unavailable'});}
     body+=decoder.decode(value,{stream:true});
    }
   }finally{reader.releaseLock();}
   if(!same(session,current()))return reply({status:'account-changed'});
   const {ticket,userId}=JSON.parse(body+decoder.decode());
   if(typeof ticket!=='string'||ticket.length>2040||!/^[-\w]+\.[-\w]+\.[-\w]+$/.test(ticket)||
      typeof userId!=='string'||!/^[a-f0-9-]{36}$/.test(userId))return reply({status:'unavailable'});
   return reply({status:'ready',ticket,userId});
  }catch{return reply({status:'unavailable'});}
 });
 ipcRenderer.on('workbench:community-web-login-cancel',cancelLogin);
 ipcRenderer.on('workbench:community-web-login',async()=>{
  // Let the official page own its authorization UI and token refresh flow.
  cancelLogin();const attempt={observer:null,timer:null,checks:0,checking:false};loginAttempt=attempt;
  const active=()=>loginAttempt===attempt;
  const result=await read();if(!active()||result?.status==='signed-in')return;
  const welcomeOpen=()=>document.getElementById('community-manifesto-title')?.getClientRects().length>0;
  const open=()=>{if(!active()||attempt.checking||welcomeOpen())return;const target=[...document.querySelectorAll('button,a,[role="button"]')].find(n=>/登录\s*[/／]\s*注册/.test(n.getAttribute('aria-label')||n.textContent)&&n.getClientRects().length);if(!target)return;
   attempt.checking=true;void read().then(value=>{if(!active()||value?.status==='signed-in')return;if(!value)return;cancelLogin();if(target.isConnected&&target.getClientRects().length)target.click();}).finally(()=>{attempt.checking=false;});};
  attempt.observer=new MutationObserver(open);attempt.observer.observe(document,{childList:true,subtree:true});open();
  const retry=()=>{if(!active())return;if(!welcomeOpen()&&++attempt.checks>=30){cancelLogin();publish({status:'unavailable'});return;}open();if(active())attempt.timer=setTimeout(retry,1000);};attempt.timer=setTimeout(retry,1000);
 });
 window.addEventListener('DOMContentLoaded',schedule);if(document.readyState!=='loading')schedule();setInterval(()=>void read(),30000);
}
