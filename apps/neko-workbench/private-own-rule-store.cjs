'use strict';
// Trusted host, memory only. submitRule must use the paired local seat and send
// the same text to the authoritative service. Only an explicit ready response
// creates a local rule; an uncertain outcome requires external reconciliation.
function createOwnRuleStore({getOwnSeatSession,submitRule,timeoutMs=30000}={}) {
 if(typeof getOwnSeatSession!=='function'||typeof submitRule!=='function')throw TypeError('trusted rule dependencies required');
 if(!Number.isSafeInteger(timeoutMs)||timeoutMs<100||timeoutMs>120000)throw TypeError('invalid timeout');
 let pending=false;const records=new WeakMap(),uncertainSeats=new Set();
 function current(){const s=getOwnSeatSession();return s&&[0,1].includes(s.seat)&&typeof s.roomId==='string'?s:null}
 const key=s=>(s.origin||'')+':'+s.roomId+':'+s.seat;
 function view(){const s=current();return {status:!s?'not-paired':records.has(s)?'ready':uncertainSeats.has(key(s))?'reconciliation-required':pending?'processing':'empty'};}
 async function submit({text,signal}={}){
  const session=current();
  if(!session)return {status:'not-paired'};
  if(records.has(session))return {status:'already-submitted'};
  if(uncertainSeats.has(key(session)))return {status:'reconciliation-required'};
  if(pending)return {status:'busy'};
  if(typeof text!=='string'||!text.trim()||[...text.trim()].length>80||/[\u0000-\u001f\u007f]/.test(text))return {status:'invalid'};
  if(signal?.aborted)return {status:'cancelled'};
  pending=true;const rule=text.trim(),controller=new AbortController();
  const cancel=()=>controller.abort();signal?.addEventListener('abort',cancel,{once:true});const timer=setTimeout(cancel,timeoutMs);
  try{
    let result;
    try{result=await new Promise((resolve,reject)=>{
      const abort=()=>reject(Error('cancelled'));if(controller.signal.aborted)return abort();
      controller.signal.addEventListener('abort',abort,{once:true});
      Promise.resolve().then(()=>submitRule({session,rule,signal:controller.signal})).then(resolve,reject).finally(()=>controller.signal.removeEventListener('abort',abort));
    });}catch{uncertainSeats.add(key(session));return {status:'submission-unknown'};}
    if(current()!==session||controller.signal.aborted){uncertainSeats.add(key(session));return {status:'submission-unknown'};}
    if(result?.status==='ready'){records.set(session,rule);return {status:'ready'};}
    if(['invalid','unsupported','busy','unavailable','waiting-for-player'].includes(result?.status))return {status:result.status};
    // Already submitted or malformed responses may refer to a different text.
    uncertainSeats.add(key(session));return {status:'reconciliation-required'};
  }finally{clearTimeout(timer);signal?.removeEventListener('abort',cancel);controller.abort();pending=false;}
 }
 async function getOwnRule({roomId,seat,signal}={}){
  const session=current();
  if(signal?.aborted||!session||session.roomId!==roomId||session.seat!==seat||!records.has(session))return null;
  return {roomId,seat,text:records.get(session),confirmed:true};
 }
 function clear(){const session=current();if(session)records.delete(session); /* An ambiguous submission cannot be cleared by UI to force a retry. */}
 return Object.freeze({submit,view,getOwnRule,clear});
}
module.exports={createOwnRuleStore};
