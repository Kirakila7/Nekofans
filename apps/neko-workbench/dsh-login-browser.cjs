'use strict';

function officialDshAuthorizeUrl(value){
 if(typeof value!=='string'||value.length>16384)return null;
 try{const url=new URL(value);return url.protocol==='https:'&&url.hostname==='platform.deepseek.com'&&!url.port&&!url.username&&!url.password&&!url.hash&&url.pathname==='/dsh/authorize'?url.href:null;}catch{return null;}
}

// Authorization state and PKCE stay with DSH. This host only supplies the
// official desktop browser-opening step and never persists the projected URL.
function createDshLoginBrowser({openExternal,onError=()=>{}}){
 const seen=new Set();let disposed=false;
 function accept(value){
  if(disposed||!value||value.phase!=='waiting-browser'||typeof value.id!=='string'||!value.id||value.id.length>160)return false;
  const url=officialDshAuthorizeUrl(value.authorizeUrl);if(!url||seen.has(value.id))return false;
  seen.add(value.id);if(seen.size>128)seen.delete(seen.values().next().value);
  Promise.resolve().then(()=>{if(!disposed)return openExternal(url);}).catch(()=>{try{onError('未能自动打开浏览器，请使用登录窗口中的复制链接。');}catch{}});
  return true;
 }
 return Object.freeze({accept,dispose(){disposed=true;seen.clear();}});
}

module.exports={officialDshAuthorizeUrl,createDshLoginBrowser};
