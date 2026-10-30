'use strict';
// Uses the host's authenticated LLM service directly. No DSH agent, tool,
// session, project directory, or generic session-event log is created.
function createCompanionAccountBridge({ctx, route, createUserMessage, createAssistantMessage, timeoutMs=75000, cleanupTimeoutMs=5000}) {
  if (route?.provider!=='deepseek-account' || route?.model!=='deepseek-flash' || typeof createUserMessage!=='function' || typeof createAssistantMessage!=='function') throw Error('陪伴聊天账号路线无效。');
  let active=null, disposed=false, cleanupFailed=false, pendingCleanup=0;
  const seen=new Set();
  const cleanupError=()=>Error('陪伴聊天请求清理未确认，请重启工作台后检查。');
  async function status() {
    let timer;
    try {
      const account=ctx.get?.('deepseekAccount');
      if(typeof account?.getState!=='function')return {status:'unavailable'};
      const state=await Promise.race([account.getState(),new Promise(resolve=>{timer=setTimeout(()=>resolve(null),5000);})]);
      if(state?.status==='credential-stored')return {status:'signed-in'};
      if(['credential-missing','signed-out'].includes(state?.status))return {status:'signed-out'};
      return {status:'unavailable'};
    } catch {return {status:'unavailable'};} finally {clearTimeout(timer);}
  }
  function cancel({requestId}={}) {
    if(!active||active.requestId!==requestId)return {accepted:false};
    active.cancelled=true;active.abort.abort();active.reject(Error('陪伴聊天已取消。'));return {accepted:true};
  }
  async function send({requestId,text,context='',history=[],maxTokens}={}) {
    if(cleanupFailed||pendingCleanup)throw cleanupError();
    if(disposed||active)throw Error('陪伴聊天暂不可用，请稍后重试。');
    if(typeof requestId!=='string'||!/^companion-[a-zA-Z0-9_-]{1,100}$/.test(requestId)||typeof text!=='string'||!text.trim()||text.length>32000||typeof context!=='string'||context.length>64000||!Number.isSafeInteger(maxTokens)||maxTokens<1||maxTokens>32000)throw Error('聊天内容无效。');
    if(!Array.isArray(history)||history.length>50||history.some(x=>!x||!['user','assistant'].includes(x.role)||typeof x.text!=='string'||x.text.length>32000)||history.reduce((sum,x)=>sum+x.text.length,0)>64000)throw Error('聊天历史无效。');
    if(seen.has(requestId))throw Error('聊天请求已使用，请重试。');seen.add(requestId);
    let reject;const interrupted=new Promise((_,r)=>{reject=r;});interrupted.catch(()=>{});
    const state=active={requestId,abort:new AbortController(),reject,cancelled:false};
    let timer, iterator, pending, ended=false;
    const wait=async value=>{pending=Promise.resolve(value);try{return await Promise.race([pending,interrupted]);}finally{if(!state.abort.signal.aborted)pending=null;}};
    try {
      timer=setTimeout(()=>{state.cancelled=true;state.abort.abort();reject(Error('陪伴聊天超时，请重试。'));},timeoutMs);
      const account=await wait(status());
      if(account.status!=='signed-in')throw Error(account.status==='signed-out'?'请先登录 DeepSeek 工作台账号。':'无法确认 DeepSeek 工作台账号状态。');
      if(typeof ctx.llm?.prepareCall!=='function')throw Error('陪伴聊天模型服务不可用。');
      const call=await wait(ctx.llm.prepareCall({...route,maxTokens},state.abort.signal));
      if(!call||typeof call.stream!=='function'||!call.config||typeof call.config!=='object')throw Error('陪伴聊天模型服务不可用。');
      const normalized=[];
      for(const m of [...history,{role:'user',text}]){
        const trimmed=m.text.trim();if(!trimmed||(!normalized.length&&m.role!=='user'))continue;
        const last=normalized.at(-1);if(last?.role===m.role)last.text+='\n\n'+trimmed;else normalized.push({role:m.role,text:trimmed});
      }
      const messages=normalized.map(m=>m.role==='user'
        ? createUserMessage({content:[{type:'text',text:m.text}],source:{kind:'user'}})
        : createAssistantMessage({content:[{type:'text',text:m.text}],source:{provider:'workbench-history',model:'persisted'}}));
      const stream=call.stream({...call.config,messages,system:context,signal:state.abort.signal});
      if(!stream||typeof stream[Symbol.asyncIterator]!=='function')throw Error('陪伴聊天回复格式异常。');
      iterator=stream[Symbol.asyncIterator]();let finish;const blocks=new Map();
      const textBlock=index=>{if(!Number.isSafeInteger(index)||index<0||index>1024)throw Error('陪伴聊天回复格式异常。');if(!blocks.has(index))blocks.set(index,'');return blocks.get(index);};
      for(;;){
        const next=await wait(iterator.next());
        if(next.done){ended=true;break;}
        const chunk=next.value;
        if(!chunk||typeof chunk.type!=='string')throw Error('陪伴聊天回复格式异常。');
        if(chunk.type==='usage')continue;
        if(finish)throw Error('陪伴聊天回复格式异常。');
        if(chunk.type==='text-delta'){
          if(typeof chunk.text!=='string')throw Error('陪伴聊天回复格式异常。');
          const previous=textBlock(chunk.index), updated=previous+chunk.text;
          if(updated.length>64000)throw Error('陪伴聊天回复格式异常。');blocks.set(chunk.index,updated);
        } else if(chunk.type==='finish') finish=chunk.reason?.kind;
        else if(chunk.type==='block-start'){
          if(!['text','reasoning'].includes(chunk.blockType))throw Error('陪伴聊天回复格式异常。');
          if(chunk.blockType==='text')textBlock(chunk.index);
        } else if(chunk.type==='block-end'){
          if(!['text','reasoning'].includes(chunk.block?.type))throw Error('陪伴聊天回复格式异常。');
          if(chunk.block?.type==='text'){
            textBlock(chunk.index);if(typeof chunk.block.text!=='string'||chunk.block.text.length>64000)throw Error('陪伴聊天回复格式异常。');blocks.set(chunk.index,chunk.block.text);
          }
        } else if(!['start','reasoning-delta'].includes(chunk.type))throw Error('陪伴聊天回复格式异常。');
      }
      const result=[...blocks.values()].join('');
      if(result.length>64000)throw Error('陪伴聊天回复格式异常。');
      if(finish!=='stop'||!result.trim())throw Error('陪伴聊天未能完成，请检查账号或重试。');
      return {text:result};
    } catch(error) {
      if(state.cancelled)throw Error(error?.message==='陪伴聊天超时，请重试。'?error.message:'陪伴聊天已取消。');
      if(/^(陪伴聊天|请先登录 DeepSeek 工作台账号|无法确认 DeepSeek 工作台账号)/.test(error?.message||''))throw error;
      throw Error('陪伴聊天暂不可用，请检查工作台账号和连接。');
    } finally {
      clearTimeout(timer);state.abort.abort();
      if(!ended&&(iterator||pending)){
        pendingCleanup++;let cleanupTimer;
        try {
          const waits=[];
          if(pending)waits.push(Promise.resolve(pending).then(()=>true,()=>true));
          if(iterator && typeof iterator.return!=='function')waits.push(Promise.resolve(false));
          if(typeof iterator?.return==='function')waits.push(Promise.resolve().then(()=>iterator.return()).then(()=>true,()=>false));
          const ok=await Promise.race([Promise.all(waits).then(values=>values.every(Boolean)),new Promise(resolve=>{cleanupTimer=setTimeout(()=>resolve(false),cleanupTimeoutMs);})]);
          if(!ok)cleanupFailed=true;
        } finally {clearTimeout(cleanupTimer);pendingCleanup--;}
      }
      if(active===state)active=null;
      if(cleanupFailed||pendingCleanup)throw cleanupError();
    }
  }
  function dispose(){disposed=true;if(active)cancel({requestId:active.requestId});}
  return {status,send,cancel,dispose};
}
module.exports={createCompanionAccountBridge};
