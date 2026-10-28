// Pet controls and the official Web UI share one DSH runtime.
// Every helper identity comes from the DSH parent-owned subagent catalog.
const path=require('node:path');
const {randomUUID}=require('node:crypto');
const readline=require('node:readline');
const {currentTaskFromTodo}=require('./original/work-status.cjs');
const {catalogOrder,mergeCatalogOrder}=require('./pet-roster.cjs');
const {cleanPrompt,historyContext}=require('./pet-context.js');
const {resolveRuntimePaths}=require('./runtime-config.cjs');
const {createTaskSessionTracker}=require('./task-session-tracker.cjs');
const runtimePaths=resolveRuntimePaths();
const runtime=runtimePaths.modulesDir;
let createUserMessage,carrierKeyOf;
exports.name='pet-lab-bridge';
exports.inject=['agents','subagents','sessionQuery','sessionController','agentPresets','webApp','connection','llm','workingDirectory'];
exports.apply=function(ctx){
  let root,closing=false;
  const catalog=new Map();
  const initialPrompts=new Map();
  const children=new Map();
  const syncingParents=new Map();let lastRoster='';
  const options={provider:'deepseek-account',model:'deepseek-flash',reasoningEffort:'high'};
  const emit=(method,params)=>process.stdout.write(JSON.stringify({method,params})+'\n');
  const taskSessions=createTaskSessionTracker({emit,getAgent:id=>ctx.agents.get(id),observeSession:id=>ctx.sessionQuery.observeSession(id),
    getLiveJobs:id=>ctx.get('jobs')?.list(id)});
  const signal=()=>new AbortController().signal;
  const publishRoster=()=>{const sessionIds=catalogOrder(root?.agent.id,children),key=JSON.stringify(sessionIds);if(key!==lastRoster){lastRoster=key;emit('agent-roster',{source:'dsh-subagent-catalog',sessionIds});}};
  const text=blocks=>(blocks||[]).filter(b=>b.type==='text').map(b=>b.text||'').join('\n');
  const summary=value=>{
    const valueText=cleanPrompt(value);
    return Array.from(valueText.trim()).slice(0,240).join('');
  };
  function publish(record,createdNow=false){
    emit('agent-meta',{sessionId:record.sessionId,parentSessionId:record.parentSessionId,name:record.label??record.sessionId,label:record.label,title:record.title||'',task:record.currentTask||record.promptTask||record.title||'',mode:record.mode,createdAt:record.createdAt,running:ctx.agents.get(record.sessionId)?.status==='running'||record.externalRunning===true,createdNow,source:'dsh-subagent-catalog'});
  }
  function register(parentSessionId,row,createdNow=false){
    const id=String(row.id??row.childId??'');if(!id||!parentSessionId)return;
    taskSessions.exclude(id);
    const previous=catalog.get(id)||{sessionId:id,title:'',promptTask:'',currentTask:null};
    const record={...previous,parentSessionId:String(parentSessionId),label:typeof row.label==='string'?row.label:previous.label,mode:row.mode||previous.mode||'unknown',createdAt:row.createdAt??row.childCreatedAt??previous.createdAt};
    catalog.set(id,record);
    const siblings=children.get(record.parentSessionId)||[];
    if(!siblings.includes(id)){children.set(record.parentSessionId,[...siblings,id]);publishRoster();}
    publish(record,createdNow);return record;
  }
  async function hydrate(record){
    if(record.mode==='external')return;
    let observation;
    try{
      observation=await ctx.sessionQuery.observeSession(record.sessionId);
      record.title=String(observation.projections?.values.title||record.title||'');
      for(let i=observation.events.length-1;i>=observation.inheritedEventCount;i--){
        const event=observation.events[i];
        if(event.type==='user/message'&&['user','agent-message'].includes(event.data?.source?.kind)){record.promptTask=summary(text(event.data.content));break;}
      }
      const todo=observation.events.findLast(e=>e.type==='todo/write');
      if(todo)record.currentTask=currentTaskFromTodo(todo);
      if(record.parentSessionId)publish(record);
      const context=historyContext(observation,!!record.parentSessionId);
      if(context.delegatedPromptSeq!==null)initialPrompts.set(record.sessionId,context.delegatedPromptSeq);
      emit('session-context',{sessionId:record.sessionId,title:record.title,...context});
    }catch(error){emit('catalog-diagnostic',{sessionId:record.sessionId,message:String(error?.message||error)});}
    finally{observation?.[Symbol.dispose]?.();}
  }
  async function syncParent(parentId,visited=new Set()){
    parentId=String(parentId);if(visited.has(parentId))return;visited.add(parentId);
    if(syncingParents.has(parentId))return syncingParents.get(parentId);
    const task=(async()=>{
      let rows;
      try{rows=await ctx.subagents.listChildren(parentId,signal());}
      catch(error){emit('catalog-diagnostic',{parentSessionId:parentId,message:String(error?.message||error)});return;}
      children.set(parentId,mergeCatalogOrder(rows.map(row=>String(row.id??row.childId)),children.get(parentId)||[]));publishRoster();
      for(const row of rows){const record=register(parentId,row);await hydrate(record);if(row.mode!=='external')await syncParent(record.sessionId,visited);}
    })();
    syncingParents.set(parentId,task);
    try{await task;}finally{syncingParents.delete(parentId);}
  }
  ctx.on('session/event',(session,event)=>{
    const id=String(session.id);
    taskSessions.onEvent(session,event);
    if(event.type==='subagent/catalog'){
      const record=register(id,event.data,true);if(record)hydrate(record);
    }
    const record=catalog.get(id);
    if(record){
      if(event.type==='session/title'){record.title=String(event.data.title||'');publish(record);}
      if(event.type==='user/message'&&['user','agent-message'].includes(event.data?.source?.kind)){record.promptTask=summary(text(event.data.content));record.currentTask=null;publish(record);}
      if(event.type==='todo/write'){record.currentTask=currentTaskFromTodo(event);publish(record);}
    }
    let delegatedPrompt=false;
    if((record||taskSessions.isSubagent(id))&&event.type==='user/message'&&event.data?.source?.kind==='user'){
      if(!initialPrompts.has(id))initialPrompts.set(id,event.seq);
      delegatedPrompt=initialPrompts.get(id)===event.seq;
    }
    emit('event',{sessionId:id,event,delegatedPrompt});
  });
  ctx.on('agent/status',({agent,status})=>{
    const id=String(agent.id),record=catalog.get(id);
    taskSessions.onStatus(agent,status);
    if(record)publish(record);
    else if(agent.session.header.parentSession)syncParent(agent.session.header.parentSession);
    emit('status',{sessionId:id,status});
  });
  ctx.on('agent/error',({agent,error})=>emit('failure',{sessionId:String(agent.id),message:String(error?.message||error)}));
  ctx.on('subagent/start',function(info){
    const record=catalog.get(String(info.id));
    if(record){if(!info.local)record.externalRunning=true;publish(record);}
    else {const parent=carrierKeyOf?.(this);if(parent?.id)syncParent(parent.id);}
    emit('subagent-activity',{sessionId:String(info.id),phase:'start',local:info.local});
  });
  ctx.on('subagent/end',info=>{
    const record=catalog.get(String(info.id));if(record){record.externalRunning=false;publish(record);}
    emit('subagent-activity',{sessionId:String(info.id),phase:'end',local:info.local,stopReason:info.stopReason});
  });
  function stopTrackedTask(sessionId){
    const failure=()=>new Error('未能完整停止工作台任务，请在工作台检查后重试。');
    try{
      const registry=ctx.get('jobs');
      if(!registry||typeof registry.list!=='function')throw failure();
      const rows=registry.list(sessionId);
      if(!Array.isArray(rows))throw failure();
      // Native list(owner) also includes unowned public jobs. They and other
      // sessions are never cancellation targets, even if a registry returns them.
      const owned=rows.filter(job=>job?.owner===sessionId&&['running','stopping'].includes(job.status));
      if(owned.some(job=>typeof job.id!=='string'||!job.id)||owned.length&&typeof registry.kill!=='function')throw failure();
      const agent=ctx.agents.get(sessionId);
      if(agent&&typeof agent.cancel!=='function')throw failure();
      if(!agent&&!owned.length)return {accepted:false};
      agent?.cancel({kind:'user'});
      for(const jobId of new Set(owned.map(job=>job.id))){
        const result=registry.kill(jobId,sessionId,'workbench task stop');
        if(!['requested','already-finished'].includes(result))throw failure();
      }
      // Accepted means native cancellation was requested, not settled. Keep
      // task metadata unchanged until actual job/settled and agent/status.
      return {accepted:true};
    }catch{throw failure();}
  }
  const send=content=>createUserMessage({content:[{type:'text',text:content}],source:{kind:'user'}});
  async function dispatch(method,p){
    if(method==='init'){
      await ctx.get('loader')?.await();
      ({createUserMessage}=await import(require('node:url').pathToFileURL(runtime+'/dsh-llm/lib/index.js').href));
      ({carrierKeyOf}=await import(require('node:url').pathToFileURL(runtime+'/dsh-scope/lib/index.js').href));
      const sessionId=p.rootId||randomUUID();
      const setup=async agentCtx=>{await ctx.agentPresets.mount(agentCtx,'standard');};
      root=p.resume?await ctx.agents.resume({resumeSessionId:sessionId,agentOptions:options,setup}):await ctx.agents.create({sessionId,meta:{cwd:runtimePaths.workspaceDir,agentPreset:'standard'},agentOptions:options,setup});
      await hydrate({sessionId:root.agent.id,title:''});
      const parents=new Set([sessionId,...(p.parentIds||[])]),visited=new Set();
      for(const parentId of parents)await syncParent(parentId,visited);
      for(const taskId of new Set([root.agent.id,...(Array.isArray(p.taskIds)?p.taskIds.filter(id=>typeof id==='string'):[])]))await taskSessions.restore(taskId);
      return {sessionId:root.agent.id,provider:options.provider,model:options.model,uiUrl:ctx.connection.authenticatedUrl(ctx.webApp.getAdvertisedUrl())};
    }
    if(!root)throw new Error('DSH 尚未就绪');
    if(method==='fish-care'){
      if(!['status','start','pause'].includes(p.action))throw new Error('未知养鱼操作');
      const fish=await import(require('node:url').pathToFileURL(require('node:path').join(__dirname,'vendor/dsh-bili-whale/lib/index.js')).href);
      return fish.workbenchAction(p.action);
    }
    if(method==='qqbot-care'){
      if(!['status','start','pause'].includes(p.action))throw new Error('未知 QQ 机器人操作');
      const qqbot=await import(require('node:url').pathToFileURL(require('node:path').join(__dirname,'vendor/dsh-qqbot-workbench/index.cjs')).href);
      return qqbot.qqbotAction(p.action);
    }
    if(method==='prompt'){
      if(p.sessionId===root.agent.id){root.agent.followup(send(p.text));return {sessionId:root.agent.id};}
      const record=catalog.get(String(p.sessionId));
      if(!record)throw new Error('没有找到这个 DSH 子代理。');
      if(record.mode!=='continuable')throw new Error('这个 DSH 子任务是只读记录，请在内置 DSH 查看。');
      if(!ctx.agents.get(record.parentSessionId)){
        const found=await ctx.sessionController.resolveAgent(record.parentSessionId);
        if(found.error)throw found.error;
      }
      await ctx.subagents.prompt({parentSessionId:record.parentSessionId,childSessionId:record.sessionId,mode:'continuable',delivery:'queue',requestId:randomUUID(),content:[{type:'text',text:p.text}]},signal());
      return {sessionId:record.sessionId,parentSessionId:record.parentSessionId};
    }
    if(method==='stop'){
      if(taskSessions.has(String(p.sessionId)))return stopTrackedTask(String(p.sessionId));
      if(p.sessionId===root.agent.id)root.agent.cancel({kind:'user'});
      else {const record=catalog.get(String(p.sessionId));if(!record)throw new Error('没有找到这个 DSH 子代理。');ctx.subagents.interrupt(record.sessionId,{kind:'user',parentSessionId:record.parentSessionId});}
      return {accepted:true};
    }
    if(method==='sync'){
      const parents=new Set([root.agent.id,...[...catalog.values()].map(r=>r.parentSessionId)]);
      for(const parentId of parents)await syncParent(parentId);
      taskSessions.refresh();
      return {count:catalog.size};
    }
    if(method==='ping')return {ok:true};
    throw new Error('未知操作');
  }
  const lines=readline.createInterface({input:process.stdin});
  lines.on('line',async line=>{let request;try{request=JSON.parse(line);const result=await dispatch(request.method,request.params||{});process.stdout.write(JSON.stringify({id:request.id,result})+'\n');}catch(error){process.stdout.write(JSON.stringify({id:request?.id,error:String(error?.message||error)})+'\n');}});
  lines.on('close',()=>{if(closing)return;closing=true;Promise.resolve().then(()=>typeof ctx.root?.dispose==='function'?ctx.root.dispose():ctx.dispose?.()).finally(()=>process.exit(0));});
  ctx.on('dispose',()=>{closing=true;taskSessions.dispose();lines.close();});
  emit('ready',{version:2});
};
