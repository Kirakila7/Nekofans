// Shared by the renderer and DSH bridge; previews never require a model call.
(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.PetContext=api;})(globalThis,function(){
  function cleanPrompt(value){
    let text=String(value||'').split('\n\n[桌宠本地上下文]')[0].trim();
    if(text.startsWith('你是「大肥鱼工作小队」')){const parts=text.split(/\n用户(?:消息|任务)：\s*\n/);if(parts.length>1)text=parts.at(-1).trim();}
    return text;
  }
  const oneLine=value=>String(value||'').replace(/\s+/gu,' ').trim();
  function humanMessage(event){
    if(event?.type!=='user/message'||event.data?.source?.kind!=='user')return null;
    const text=cleanPrompt((event.data.content||[]).filter(b=>b.type==='text').map(b=>b.text||'').join('\n'));
    return text?{text,time:Number(event.time)||0}:null;
  }
  function activity(event){
    if(event?.type!=='tool/call')return '';
    let args=event.data?.arguments;try{if(typeof args==='string')args=JSON.parse(args);}catch{args=null;}
    const description=oneLine(args?.description);if(description)return description;
    const labels={bash:'执行命令',exec_command:'执行命令',read:'读取文件',read_file:'读取文件',write:'写入文件',write_file:'写入文件',edit:'修改文件',apply_patch:'修改文件',web_search:'搜索资料',subagent:'处理子任务',subagent_fork:'创建子任务'};
    return labels[event.data?.name]||'';
  }
  function acceptHuman(actor,message){
    if(!message)return;
    if(!actor.lastUserMessage||message.time>=actor.lastUserMessage.time)actor.lastUserMessage=message;
  }
  function historyContext(observation,isChild){
    const events=observation.events.slice(observation.inheritedEventCount||0);
    // DSH stores a delegated child's initial instruction as source:user too.
    // It is the parent's assignment, not a chat message sent by the human.
    const initial=isChild?events.find(e=>humanMessage(e)):null;
    const last=events.findLast(e=>e!==initial&&humanMessage(e));
    const start=events.findLastIndex(e=>e.type==='turn/start');
    const action=events.slice(Math.max(0,start)).findLast(e=>activity(e));
    return {lastUserMessage:last?humanMessage(last):null,currentActivity:action?activity(action):'',delegatedPromptTime:initial?.time??null,delegatedPromptSeq:initial?.seq??null};
  }
  function preview(actor){
    const last=actor.lastUserMessage?.text||actor.messages?.findLast(m=>m.role==='user')?.text||'';
    if(['neko','chat-api','deepseek-account'].includes(actor.chatBackend))return {task:actor.chatBackend==='deepseek-account'?'DeepSeek 账号聊天 · 大肥鱼':actor.chatBackend==='chat-api'?'独立聊天 · 大肥鱼':'N.E.K.O. · '+(actor.nekoCharacter||'等待连接'),work:actor.active?'正在聊天':actor.status==='error'?'聊天遇到问题':'陪你聊天',lastUser:oneLine(last)||'还没有给她发过消息'};
    const title=/^你是(?:「大肥鱼工作小队」| DSH 子代理)/u.test(actor.title||'')?'':actor.title;
    const task=oneLine(actor.dshName||title||actor.task||cleanPrompt(last))||'等待任务';
    const active=actor.active||['working','stopping'].includes(actor.status);
    const phases={thinking:'思考中',working:'进行中',result:'整理结果',waiting:'等待确认'};
    let work;
    {
      const phase=active?(actor.status==='stopping'?'正在停止':phases[actor.work?.state]||'进行中'):({success:'已完成',error:'出错了',stopped:'已停止'}[actor.status]||'等待任务');
      const detail=oneLine(actor.work?.task||actor.currentActivity||actor.task||cleanPrompt(last));
      work=phase+(detail?' · '+detail:'');
    }
    return {task,work:oneLine(work),lastUser:oneLine(cleanPrompt(last))||'还没有给她发过消息'};
  }
  return {cleanPrompt,oneLine,humanMessage,activity,acceptHuman,historyContext,preview};
});
