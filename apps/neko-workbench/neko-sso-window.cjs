'use strict';
const {OFFICIAL_AUTH_ORIGIN,communityWindowOptions,installCommunityNavigation}=require('./community-config.cjs');
// Keep this small official-navigation contract independent of optional lobby
// modules. A missing lobby implementation must never block private chat boot.
const DEFAULT_CHAT_CLIENT_ID='neko-chat-desktop-prod';
const DEFAULT_CHAT_OAUTH_PORTS=Object.freeze([48921,48922,48923]);
const KEYS=new Set(['client_id','redirect_uri','state','code_challenge','code_challenge_method','response_type','scope']);
function officialChatAuthorization(value){
 let url,callback;try{url=new URL(value);callback=new URL(url.searchParams.get('redirect_uri'));}catch{return null;}
 const q=url.searchParams;
 if(url.origin!==OFFICIAL_AUTH_ORIGIN||url.pathname!=='/oauth2/auth'||url.username||url.password||url.hash||[...q.keys()].some(k=>!KEYS.has(k)||q.getAll(k).length!==1)
  ||q.get('client_id')!==DEFAULT_CHAT_CLIENT_ID||q.get('response_type')!=='code'||q.get('code_challenge_method')!=='S256'
  ||!/^[A-Za-z0-9_-]{43}$/.test(q.get('state')||'')||!/^[A-Za-z0-9_-]{43}$/.test(q.get('code_challenge')||'')
  ||(q.get('scope')||'').split(' ').filter(Boolean).sort().join(' ')!=='offline openid profile'
  ||callback.protocol!=='http:'||callback.hostname!=='127.0.0.1'||!DEFAULT_CHAT_OAUTH_PORTS.includes(Number(callback.port))||callback.pathname!=='/oauth/callback'||callback.search||callback.hash||callback.username||callback.password)return null;
 return {url:url.href,callback:callback.href};
}
function createNekoSsoWindow({BrowserWindow,getParent,openExternal,onCancel=()=>{}}={}){
 let window=null,release=null,intentional=false,disposed=false;
 function close(){intentional=true;release?.();release=null;if(window&&!window.isDestroyed())window.close();window=null;}
 async function open(value){
  if(disposed)throw Error('N.E.K.O. 授权窗口已关闭');
  let initial;try{initial=new URL(value);}catch{throw Error('N.E.K.O. 授权地址无效');}
  if(!['https:','http:'].includes(initial.protocol)||initial.username||initial.password)throw Error('N.E.K.O. 授权地址无效');
  const accepted=officialChatAuthorization(initial.href);if(!accepted)return openExternal(initial.href);
  close();intentional=false;
  const current=new BrowserWindow({...communityWindowOptions({show:true,parent:getParent?.()}),title:'N.E.K.O. 账号 · 聊天室授权'});window=current;
  // No preload/native API is installed. Auth owns login/consent and the
  // callback is still validated by lobby-auth's independent PKCE receiver.
  release=installCommunityNavigation(current,{openExternal,allowAuthPopup:false,onInternalPopup:url=>current.loadURL(url),classify:target=>{
   let url;try{url=new URL(target);}catch{return {kind:'blocked'};}
   if(!['https:','http:'].includes(url.protocol)||url.username||url.password)return {kind:'blocked'};
   if(url.origin===OFFICIAL_AUTH_ORIGIN&&!url.username&&!url.password)return {kind:'internal',url:url.href};
   const callback=new URL(accepted.callback);
   if(url.origin===callback.origin&&url.pathname===callback.pathname&&!url.username&&!url.password&&!url.hash)return {kind:'internal',url:url.href};
   return {kind:'external',url:url.href};
  }});
  current.on('closed',()=>{if(window===current){release?.();release=null;window=null;if(!intentional&&!disposed)onCancel();}});
  try{await current.loadURL(accepted.url);}catch{if(window===current)close();throw Error('N.E.K.O. 官方授权页面未能打开');}
 }
 return Object.freeze({open,close,dispose(){disposed=true;close();}});
}
module.exports={createNekoSsoWindow,officialChatAuthorization};
