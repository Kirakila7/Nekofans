'use strict';
const forms=require('./compact-questions.js');

// Only the authenticated workbench publishes carriers. Pet windows can act
// solely on their own host-resolved session; the workbench rechecks the live
// carrier before using the official answer channel.
function createAgentQuestionRelay({getHost,getSessionId,onChange=()=>{},timeoutMs=10000}){
  let owner=null,rows=new Map(),sequence=0;const pending=new Map();
  const same=(a,b)=>a&&b&&a.sessionId===b.sessionId&&a.key===b.key&&a.revision===b.revision;
  function finish(id,result){const job=pending.get(id);if(!job)return;pending.delete(id);clearTimeout(job.timer);job.resolve(result);}
  function clear(){owner=null;rows.clear();for(const id of [...pending.keys()])finish(id,{ok:false,code:'closed'});onChange();}
  function accept(sender,message){
    const host=getHost();if(!host||host.isDestroyed?.()||sender!==host.webContents)return {ok:false};
    if(message?.action==='result'){
      if(owner!==sender||!Number.isSafeInteger(message.requestId))return {ok:false};
      finish(message.requestId,{ok:message.ok===true,...(message.ok===true?{}:{code:'unconfirmed'})});return {ok:true};
    }
    if(message?.action!=='publish'||!Array.isArray(message.items)||message.items.length>100)return {ok:false};
    if(owner&&owner!==sender)clear();owner=sender;const next=new Map();let size=0;
    for(const value of message.items){const q=forms.normalize(value);if(!q)continue;size+=JSON.stringify(q).length;if(size>1024*1024)break;next.set(q.sessionId,q);}
    rows=next;for(const [id,job] of pending)if(!same(rows.get(job.question.sessionId),job.question))finish(id,{ok:false,code:'stale'});
    onChange();return {ok:true};
  }
  function forActor(id){const session=getSessionId(id);return typeof session==='string'?rows.get(session)||null:null;}
  function request(actorId,input){
    const question=forActor(actorId),host=getHost();
    if(!host||host.isDestroyed?.()||owner!==host.webContents||!same(question,input)||!['answer','focus','blur','engage','open'].includes(input?.type))return Promise.resolve({ok:false,code:'stale'});
    const answers=input.type==='answer'?forms.answersFor(question,input.answers):undefined;
    if(input.type==='answer'&&(!question.canAnswer||question.submitting||question.submitted||!answers||[...pending.values()].some(job=>job.answer&&same(job.question,question))))return Promise.resolve({ok:false,code:'unavailable'});
    return new Promise(resolve=>{
      const requestId=++sequence,timer=setTimeout(()=>finish(requestId,{ok:false,code:'unconfirmed'}),timeoutMs);
      pending.set(requestId,{resolve,timer,question,answer:input.type==='answer'});
      try{owner.send('workbench:question-event',{requestId,type:input.type,sessionId:question.sessionId,key:question.key,revision:question.revision,...(answers?{answers}:{})});}catch{finish(requestId,{ok:false,code:'closed'});}
    });
  }
  return {accept,forActor,request,clear,dispose:clear};
}
module.exports={createAgentQuestionRelay};
