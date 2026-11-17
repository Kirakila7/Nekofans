'use strict';

// Project existing official PendingQuestion carriers. The native question
// plugin continues to own its waterfall, countdown, continuation and inbox.
function createWorkbenchQuestionController(options={}) {
  const forms=options.forms||(typeof WORKBENCH_QUESTION_FORMS==='object'?WORKBENCH_QUESTION_FORMS:require('../compact-questions.js'));
  const entries=new Map();let source=null,stopSource=null,sequence=0,disposed=false,last='',refreshing=false;
  const snapshot=()=>[...entries.values()].map(row=>row.dto).filter(Boolean);
  function emit(){const rows=snapshot(),key=JSON.stringify(rows);if(key===last)return;last=key;try{options.onChange?.(rows);}catch{}}
  function detach(row){try{row.carrier.releaseFocus?.();}catch{}try{row.stop?.();}catch{}row.dto=null;}
  function read(row){
    let state;try{state=row.carrier.getSnapshot();}catch{return null;}
    if(state?.closed||row.carrier.review!==undefined)return null;
    const raw={sessionId:row.id,key:row.carrier.key,revision:row.revision,kind:row.carrier.kind,questions:row.carrier.questions?.map(q=>({...q,options:Array.isArray(q.options)?q.options:[]})),canAnswer:state?.channel==='waterfall'||state?.channel==='rpc',state:state?.state,error:row.error||'',remainingMs:state?.countdown?.remainingMs,submitting:row.inFlight,submitted:row.sent};
    // Plan review retains its native full-plan approval/cancel semantics.
    // A compact title must not replace the document the user approves.
    let dto=row.carrier.kind==='plan-review'?forms.normalize({...raw,kind:'unsupported',questions:[],canAnswer:false}):forms.normalize(raw);
    if(!dto)dto=forms.normalize({...raw,kind:'unsupported',questions:[],canAnswer:false});
    if(!dto)return null;
    const signature=forms.fingerprint(dto);
    if(row.signature!==undefined&&signature!==row.signature){row.revision=++sequence;row.sent=false;row.error='问题已更新，请重新确认';}
    row.signature=signature;dto.revision=row.revision;
    if(row.sent&&row.sentVia==='waterfall'&&state?.channel==='rpc'&&state?.state==='continued'){row.sent=false;row.error='已继续工作，请重新确认回答';dto.submitted=false;dto.error=row.error;}
    return dto;
  }
  function refresh(){
    if(disposed||refreshing)return;refreshing=true;
    try{
      const next=options.getSource?.();
      if(next!==source){try{stopSource?.();}catch{}source=next;stopSource=source?.subscribe?.(refresh);}
      const statuses=source?.getSnapshot?.(),present=new Set();
      if(statuses&&typeof statuses[Symbol.iterator]==='function')for(const [id,status] of statuses){
        if(present.size>=100)break;
        const carrier=status?.pendingInteraction;
        if(typeof id!=='string'||id.length>512||!carrier||carrier.sessionId!==id||!['question','plan-review'].includes(carrier.kind)||typeof carrier.key!=='string'||typeof carrier.getSnapshot!=='function'||typeof carrier.answer!=='function')continue;
        present.add(id);let row=entries.get(id);
        if(!row||row.carrier!==carrier){if(row)detach(row);row={id,carrier,revision:++sequence,signature:undefined,stop:null,sent:false,inFlight:false,error:''};entries.set(id,row);row.stop=carrier.subscribe?.(refresh);}
        row.dto=read(row);
      }
      for(const [id,row] of entries)if(!present.has(id)){detach(row);entries.delete(id);}
    }catch{for(const row of entries.values())detach(row);entries.clear();}finally{refreshing=false;}
    emit();
  }
  async function perform(message){
    refresh();const row=entries.get(message?.sessionId),dto=row?.dto;
    if(disposed||!row||!dto||message.key!==dto.key||message.revision!==dto.revision)return {ok:false,code:'stale'};
    if(message.type==='open'){if(typeof options.openSession!=='function')return {ok:false,code:'unavailable'};try{await options.openSession(row.id);return {ok:true};}catch{row.error='未能打开工作区，请稍后重试';row.dto=read(row);emit();return {ok:false,code:'unavailable'};}}
    const method={focus:'holdFocus',blur:'releaseFocus',engage:'engage'}[message.type];
    if(method){try{row.carrier[method]?.();refresh();return {ok:true};}catch{return {ok:false,code:'unavailable'};}}
    if(message.type!=='answer'||!dto.canAnswer||row.inFlight||row.sent)return {ok:false,code:'unavailable'};
    const answers=forms.answersFor(dto,message.answers);if(!answers)return {ok:false,code:'invalid'};
    row.inFlight=true;row.error='';row.sentVia=row.carrier.getSnapshot()?.channel;row.dto=read(row);emit();
    try{
      await row.carrier.answer({answers});
      if(entries.get(row.id)===row){row.sent=true;row.inFlight=false;row.dto=read(row);emit();}
      return {ok:true};
    }catch{
      if(entries.get(row.id)===row){row.inFlight=false;row.error='回答未确认，请核对后重试';row.dto=read(row);emit();}
      return {ok:false,code:'unconfirmed'};
    }
  }
  return {refresh,snapshot,current:id=>entries.get(id)?.dto||null,perform,dispose(){disposed=true;try{stopSource?.();}catch{}for(const row of entries.values())detach(row);entries.clear();source=null;}};
}
if(typeof window==='undefined'&&typeof module==='object'&&module.exports)module.exports={createWorkbenchQuestionController};
