'use strict';
// Read-only adapter for the official community web session. Tokens stay in
// this origin's isolated renderer; IPC contains only a verified public status.
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
