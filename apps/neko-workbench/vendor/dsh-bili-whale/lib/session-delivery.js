import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

// One queue owns session selection and persona acknowledgement for all channels.
export function createSessionDelivery({controller,dshHome,cwd,sessionId,config,persona,route,isBusy=()=>false,now=Date.now,log=()=>{},onSession=()=>{}}) {
  if(!route?.provider||!route?.model)throw Error('养鱼会话缺少工作台账号模型路线')
  const file=path.join(dshHome,'whale-session.json')
  let state={id:sessionId,startedAt:now()},ready=false,tail=Promise.resolve(),lastDelivered=0
  // 2026-10-24：进程启动后有没有投递过 —— 用来做「重启后首次必注入人设」
  //   因为 DSH 的 create() 返回 { sessionId, agentPreset? }，分不出"新建"还是"复用" ✗
  let booted=false
  try {
    const saved=JSON.parse(fs.readFileSync(file,'utf8'))
    if(typeof saved.id!=='string'||!saved.id||!Number.isFinite(saved.startedAt)||saved.startedAt<0)throw Error('invalid state')
    state=saved
  } catch(e) { if(e.code!=='ENOENT')throw Error('会话状态损坏，请检查 whale-session.json，避免误建会话') }
  onSession(state.id)
  lastDelivered=Number.isFinite(state.deliveredAt)?state.deliveredAt:0
  function save(next) {
    fs.mkdirSync(dshHome,{recursive:true})
    const tmp=file+'.'+crypto.randomUUID()+'.tmp'
    try {fs.writeFileSync(tmp,JSON.stringify(next));fs.renameSync(tmp,file)} finally {fs.rmSync(tmp,{force:true})}
  }
  return {
    send(request,signal,{retainUntilAck=false,beforePrompt,requireExisting=false}={}) {
      const job=tail.then(async()=>{
        signal?.throwIfAborted()
        const cfg=config(),days=Number(cfg.sessionRotateDays??0),once=cfg.personaOncePerSession===true
        let persist=retainUntilAck||!!state.pendingRequest||once||(Number.isFinite(days)&&days>0)
        const rotating=!state.pendingRequest&&Number.isFinite(days)&&days>0&&now()-state.startedAt>=days*86400000&&now()-lastDelivered>=8*60000&&!isBusy()
        let next=rotating?{id:crypto.randomUUID(),startedAt:now(),rotatedFrom:state.id}:state
        if(retainUntilAck){
          if(!request.requestId)throw Error('可靠交付需要 requestId')
          next={...next,pendingRequest:request.requestId}
        }
        if(!ready||rotating) {
          try {
            // create() only reuses blank sessions. Resume an existing session
            // first so a restart cannot mint an unrelated empty conversation.
            const found=rotating&&!requireExisting?null:await controller.resolveAgent(rotating?state.id:next.id)
            if(found?.error&&found.error.code!=='session/not-found')throw Error('session unavailable')
            if(!rotating&&!found?.agent&&found?.error?.code!=='session/not-found')throw Error('invalid session result')
            if(requireExisting&&!found?.agent)throw Error('original session is unavailable')
            if(rotating||found?.error?.code==='session/not-found'){
              const created=await controller.create({sessionId:next.id,cwd})
              if(typeof created?.sessionId!=='string'||!created.sessionId)throw Error('invalid session identity')
              if(created.sessionId!==next.id){next={...next,id:created.sessionId};persist=true}
              // Retain ownership even if model selection fails or pause
              // arrives before the first prompt is accepted.
              save(next);state=next;onSession(next.id)
            }
          }catch {const error=Error('养鱼会话未能创建或恢复，请检查工作台会话状态。');error.code='SESSION_UNAVAILABLE';throw error}
        }
        // 2026-10-24 修第二版（审查报告第 3 条 + 复审）：
        //   上一版想靠 create() 的返回字段判断"是不是新建会话" ✗
        //   但 DSH 的 sessionController.create 返回的是 { sessionId, agentPreset? }
        //   —— 根本没有 created / fresh 这种布尔 ✗ 那段判断永远为假 ✗
        //   （而且注释写着"拿不到信号就往多注入那边靠"，代码却继续跳过 ✗ 自相矛盾）
        //
        // 现在的做法：接口分不出来就不分 ✗
        //   每次【进程启动后的第一次投递】都重新注入完整人设 + 日记恢复指引 ✓
        //   之后同一会话内按 personaIHash 去重 ✓
        //   代价：每次重启多重注入一次人设（~1000 字）✓ 换来"她不会重启后失忆"✓
        //   只开 personaIze 开关时才这样；关着的时候每条都注入，和以前一样 ✓
        // Pin the workbench account route on every new, resumed or rotated
        // session before delivery. A recorded per-session model (an older
        // selection or another key) must never decide what this prompt bills.
        signal?.throwIfAborted()
        // Reassert immediately before every prompt: the user can change a
        // live session's model between deliveries without recreating it.
        try {await controller.selectModel({sessionId:next.id,provider:route.provider,model:route.model,...(route.reasoningEffort?{reasoningEffort:route.reasoningEffort}:{})})}
        catch {const error=Error('工作台账号模型不可用，养鱼未投递；请检查账号登录和模型状态。');error.code='MODEL_ROUTE_UNAVAILABLE';throw error}
        signal?.throwIfAborted()
        const bootFirst = !booted
        if(persist)save(next)
        if(rotating)log(`会话轮换：${next.rotatedFrom} → ${next.id}；旧会话保留`)
        state=next;ready=true;onSession(state.id)
        signal?.throwIfAborted()
        const block=persona(),fingerprint=crypto.createHash('sha256').update(block).digest('hex')
        const include=!once||bootFirst||state.personaHash!==fingerprint
        const reminder=`人设依据：${path.join(process.env.BILI_WHALE_HOME || process.env.USERPROFILE || process.env.HOME||'.','.bili-ai/persona.md')}；上下文缺失时重读。`
        const diary=`先读本地日记恢复记忆：${path.join(dshHome,'whale-diary.md')} 和 ${path.join(dshHome,'whale-diary-private.md')}；不要将旧会话未确认事项当成已完成。`
        const prefix=[include?block:reminder,...((!state.deliveredAt||bootFirst)?[diary]:[])].filter(Boolean).join('\n')
        const content=[...(request.content??[])]
        if(content[0]?.type==='text')content[0]={...content[0],text:prefix+'\n'+content[0].text}
        else content.unshift({type:'text',text:prefix})
        if(beforePrompt)await beforePrompt(state.id)
        signal?.throwIfAborted()
        try {await controller.prompt({...request,sessionId:state.id,content},signal)}
        catch {ready=false;const error=Error('工作台账号未能接收养鱼任务，请检查登录、余额与连接状态。');error.code='MODEL_DELIVERY_FAILED';throw error}
        booted=true   // 投递成功了才算
        lastDelivered=now()
        state={...state,personaHash:fingerprint,deliveredAt:lastDelivered}
        // Delivery succeeded: persistence failure must not make callers retry it.
        if(persist)try {save(state)} catch(e){log('会话已投递，但保存人设标记失败：'+e.message)}
      })
      tail=job.catch(()=>{})
      return job
    },
    confirm(requestId) {
      const job=tail.then(()=>{
        if(state.pendingRequest!==requestId)return
        const next={...state};delete next.pendingRequest
        save(next);state=next
      })
      tail=job.catch(()=>{});return job
    },
  }
}
