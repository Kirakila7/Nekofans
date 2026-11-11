import {createHash,randomBytes,sign,verify} from 'node:crypto';
import {parseRuleProposal} from './private-chess-compiler.mjs';

const token=()=>randomBytes(18).toString('base64url');
const canonical=({method,path,body,timestamp,nonce})=>['nekofans-private-relay-v1',method,path,String(timestamp),nonce,createHash('sha256').update(body).digest('hex')].join('\n');
export function signExecutorRequest({privateKey,method,path,body='',timestamp=Date.now(),nonce=token()}) {
  const data={method,path,body,timestamp,nonce};
  return {timestamp:String(timestamp),nonce,signature:sign(null,Buffer.from(canonical(data)),privateKey).toString('base64url')};
}
export function createExecutorVerifier({publicKey,now=Date.now}={}) {
  if(!publicKey)throw new TypeError('public key required');
  const seen=new Map();
  return ({method,path,body='',timestamp,nonce,signature})=>{
    const t=Number(timestamp),at=now();
    for(const [n,expires] of seen)if(expires<at)seen.delete(n);
    if(!Number.isSafeInteger(t)||Math.abs(at-t)>30000||!/^[A-Za-z0-9_-]{24}$/.test(nonce||'')||!/^[A-Za-z0-9_-]{86}$/.test(signature||'')||seen.has(nonce)||seen.size>=4096)return false;
    try {if(!verify(null,Buffer.from(canonical({method,path,body,timestamp:t,nonce})),publicKey,Buffer.from(signature,'base64url')))return false;}catch{return false;}
    seen.set(nonce,at+60001);return true;
  };
}

// A single private job goes only to the authenticated executor. Both raw rule
// and validated effect stay out of all player-visible views and server logs.
export function createPrivateRuleRelay({timeoutMs=24000,maxJobs=12}={}) {
  const jobs=new Map();let executorAt=0,closed=false;
  function heartbeat(){executorAt=Date.now();}
  function online(){return !closed&&executorAt>0&&Date.now()-executorAt<15000;}
  function submit(rule,{signal}={}) {
    if(!online()||jobs.size>=maxJobs||typeof rule!=='string'||!rule.trim()||[...rule].length>80)return Promise.resolve({status:'unavailable'});
    const id=token();
    return new Promise(resolve=>{
      let finished=false;
      const done=result=>{if(finished)return;finished=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);jobs.delete(id);resolve(result);};
      const abort=()=>done({status:'unavailable'});const timer=setTimeout(abort,timeoutMs);
      if(signal?.aborted)return done({status:'unavailable'});
      signal?.addEventListener('abort',abort,{once:true});jobs.set(id,{id,rule:rule.trim(),claimed:false,done});
    });
  }
  function next(){heartbeat();for(const job of jobs.values())if(!job.claimed){job.claimed=true;return {id:job.id,rule:job.rule};}return null;}
  function settle({id,status,effect}={}) {
    const job=jobs.get(id);if(!job||!job.claimed)return false;
    let result={status:'unavailable'};
    if(status==='unsupported')result={status:'unsupported'};
    if(status==='compiled') {const parsed=parseRuleProposal(JSON.stringify(effect));if(parsed&&parsed.kind!=='unsupported')result={status:'compiled',effect:parsed};}
    job.done(result);return true;
  }
  function close(){closed=true;for(const job of jobs.values())job.done({status:'unavailable'});}
  return Object.freeze({submit,next,settle,online,close});
}

// Adapter into the existing strictly validated private compiler. The AI worker
// receives just the submitting side's rule, independently for each request.
export function createRelayProvider(relay){
  return {async *stream(input){
    let value;try{value=JSON.parse(input.messages?.[0]?.text||'');}catch{return;}
    const result=await relay.submit(value.rule,{signal:input.signal});
    if(result.status==='compiled')yield {type:'delta',text:JSON.stringify(result.effect)};
    else if(result.status==='unsupported')yield {type:'delta',text:'{"kind":"unsupported"}'};
    else return;
    yield {type:'complete'};
  }};
}
