// Optional, explicitly started single-seat loop. No credentials are held here.
// A host may choose to call match.step() manually instead.
export function createSeatAgentRunner({match,intervalMs=1000,maxMoves=40,maxWaitCycles=180,maxDurationMs=600000,maxTransientRetries=3,wait}={}) {
  if(!match||typeof match.step!=='function') throw TypeError('seat match required');
  if(!Number.isSafeInteger(intervalMs)||intervalMs<50||intervalMs>30000||!Number.isSafeInteger(maxMoves)||maxMoves<1||maxMoves>300||!Number.isSafeInteger(maxWaitCycles)||maxWaitCycles<1||maxWaitCycles>3600||!Number.isSafeInteger(maxDurationMs)||maxDurationMs<100||maxDurationMs>3600000||!Number.isSafeInteger(maxTransientRetries)||maxTransientRetries<0||maxTransientRetries>5|| (wait!==undefined && typeof wait!=='function'))throw TypeError('invalid run limits');
  let controller=null;
  const sleep=wait||((ms,signal)=>new Promise((resolve,reject)=>{
    if(signal.aborted)return reject(Error('cancelled'));
    const onAbort=()=>{clearTimeout(timer);reject(Error('cancelled'))};
    const timer=setTimeout(()=>{signal.removeEventListener('abort',onAbort);resolve()},ms);
    signal.addEventListener('abort',onAbort,{once:true});
  }));
  async function run({signal,onEvent}={}) {
    if(controller)return {status:'busy'};
    if(signal?.aborted)return {status:'cancelled',moves:0};
    if(onEvent!==undefined && typeof onEvent!=='function')throw TypeError('invalid event handler');
    const runController=new AbortController();controller=runController;
    const cancel=()=>runController.abort();signal?.addEventListener('abort',cancel,{once:true});
    const deadline=setTimeout(cancel,maxDurationMs);let moves=0,waits=0,failures=0;
    try {
      while(!runController.signal.aborted){
        // createSeatAgentMatch handles the in-flight provider and submit timeout.
        // The host must reconcile submission-unknown before starting any new run.
        const result=await match.step({signal:runController.signal});
        if(!result||typeof result.status!=='string')return {status:'unavailable',moves};
        // Deliberately never send raw models, rule text or arbitrary errors to UI.
        // UI listeners cannot mask an uncertain submission or change whether
        // a server-side action happened. Delivery failures are non-authoritative.
        if(onEvent)try{onEvent({status:result.status,...(result.status==='applied'?{seat:result.seat,version:result.version,action:result.action}:{})})}catch{}
        if(['room-unavailable','room-timeout','model-unavailable','model-timeout'].includes(result.status)){
          // Only retry before a move is submitted. Never retry ambiguous writes.
          if(++failures>maxTransientRetries)return {status:result.status,moves};
          await sleep(Math.min(30000,intervalMs*2**failures),runController.signal);
          continue;
        }
        failures=0;
        if(result.status==='applied'){
          moves++;waits=0;if(moves>=maxMoves)return {status:'move-limit',moves};
        } else if(!['waiting','not-your-turn'].includes(result.status)) {
          return {status:result.status,moves};
        } else if(++waits>=maxWaitCycles) return {status:'wait-limit',moves};
        await sleep(intervalMs,runController.signal);
      }
      return {status:'cancelled',moves};
    } catch { return {status:runController.signal.aborted?'cancelled':'unavailable',moves}; }
    finally {clearTimeout(deadline);signal?.removeEventListener('abort',cancel);controller=null;}
  }
  return Object.freeze({run,stop(){if(controller)controller.abort()}});
}
