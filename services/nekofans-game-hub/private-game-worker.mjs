import gameOrigin from './private-game-origin.cjs';
import {signExecutorRequest} from './private-relay.mjs';
import {compilePrivateRule} from './private-chess-compiler.mjs';

// Runs in the publisher's trusted workbench main process. No rule text,
// signing key or model response is sent to any renderer or chat history.
export function createPrivateGameWorker({origin,privateKey,provider,fetchImpl=fetch}={}) {
  if(!gameOrigin.isPrivateGameOrigin(origin))throw TypeError('invalid game origin');
  if(!privateKey||!provider||typeof provider.stream!=='function'||typeof fetchImpl!=='function')throw TypeError('worker dependencies required');
  let active=false;
  async function request(path,method,body='',signal){
    const signed=signExecutorRequest({privateKey,method,path,body});
    const controller=new AbortController(),cancel=()=>controller.abort(),timer=setTimeout(cancel,10000);
    if(signal?.aborted)controller.abort();else signal?.addEventListener('abort',cancel,{once:true});
    try {const response=await fetchImpl(origin+path,{method,redirect:'error',signal:controller.signal,headers:{'x-neko-time':signed.timestamp,'x-neko-nonce':signed.nonce,'x-neko-signature':signed.signature,...(body?{'content-type':'application/json'}:{})},...(body?{body}:{})});
      if(!response.ok)throw Error('relay unavailable');
      const text=await response.text();if(text.length>2048)throw Error('invalid relay response');return JSON.parse(text);
    } finally {clearTimeout(timer);signal?.removeEventListener('abort',cancel);}
  }
  async function runOnce({signal}={}){
    if(active)return {status:'busy'};
    if(signal?.aborted)return {status:'unavailable'};
    active=true;
    try {
      const payload=await request('/executor/next','POST','{}',signal),job=payload?.job;
      if(job===null)return {status:'idle'};
      if(!job||!/^[A-Za-z0-9_-]{24}$/.test(job.id||'')||typeof job.rule!=='string'||[...job.rule].length>80)return {status:'unavailable'};
      const result=await compilePrivateRule({provider,rule:job.rule,signal});
      const body=JSON.stringify({id:job.id,status:result.status,...(result.status==='compiled'?{effect:result.effect}:{})});
      await request('/executor/result','POST',body,signal);
      return {status:'processed'};
    }catch{return {status:'unavailable'};}finally{active=false;}
  }
  async function createRoom({signal}={}){
    try {const value=await request('/publisher/rooms','POST','{}',signal);
      if(!/^[A-Za-z0-9_-]{24}$/.test(value.roomId||'')||!/^[A-Za-z0-9_-]{24}$/.test(value.token||''))return {status:'unavailable'};
      return {status:'created',roomId:value.roomId,ownerUrl:origin+'/?room='+value.roomId+'#seat='+value.token,inviteUrl:origin+'/?room='+value.roomId};
    } catch{return {status:'unavailable'};}
  }
  return Object.freeze({runOnce,createRoom});
}
