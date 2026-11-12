import gameOrigin from './private-game-origin.cjs';
import catalog from './game-catalog.cjs';
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
      if(!response.ok)throw Object.assign(Error('relay unavailable'),{statusCode:response.status});
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
    }catch(error){return {status:error.statusCode===401?'publisher-not-paired':'unavailable'};}finally{active=false;}
  }
  async function heartbeat({signal}={}) {
    try {await request('/executor/heartbeat','POST','{}',signal);return true;}
    catch{return false;}
  }
  async function supportsGameCatalog(gameId, {signal}={}) {
    try {
      const listing = await fetchImpl(origin+'/games',{redirect:'error',signal:signal || AbortSignal.timeout(5000)});
      if (!listing.ok) return false;
      const capabilities = await listing.json();
      return gameId === catalog.STUDIO_GAME ? capabilities.authoring === true :
        capabilities.games?.some(game => game.id === gameId) === true;
    } catch {return false;}
  }
  async function createRoom({signal,gameId=catalog.DEFAULT_GAME,definition,catalogVerified=false}={}){
    if(!catalog.getGame(gameId))return {status:'invalid-game'};
    try {
      if (gameId !== catalog.DEFAULT_GAME && !catalogVerified && !await supportsGameCatalog(gameId,{signal}))return {status:'invalid-game'};
      const value=await request('/publisher/rooms','POST',JSON.stringify({gameId,...(definition?{definition}:{})}),signal);
      if(!/^[A-Za-z0-9_-]{24}$/.test(value.roomId||'')||!/^[A-Za-z0-9_-]{24}$/.test(value.token||''))return {status:'creation-unknown'};
      if((value.gameId ?? catalog.DEFAULT_GAME)!==gameId)return {status:'creation-unknown'};
      return {status:'created',roomId:value.roomId,ownerUrl:origin+'/?room='+value.roomId+'#seat='+value.token,inviteUrl:origin+'/?room='+value.roomId};
    } catch(error){return {status:error.statusCode===401?'publisher-not-paired':error.statusCode?'unavailable':'creation-unknown'};}
  }
  return Object.freeze({runOnce,createRoom,heartbeat,supportsGameCatalog});
}
