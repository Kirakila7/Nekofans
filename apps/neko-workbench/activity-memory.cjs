'use strict';
const { createHash, randomUUID } = require('node:crypto');

// Only human-readable task outcomes and screen observations enter memory.
// Tool arguments, transcripts, screenshots and code blocks are not persisted.
function excerpt(value, limit = 700) {
  if (typeof value !== 'string') return '';
  return value.replace(/```[\s\S]*?```/g, ' ')
    .replace(/\b(?:sk|pk)-[A-Za-z0-9_-]{12,}\b/g, '[已隐藏密钥]')
    .replace(/\b(?:api[_-]?key|access[_-]?token|password|secret)\s*[:=]\s*\S+/gi, '[已隐藏凭据]')
    .replace(/\s+/g, ' ').trim().slice(0, limit);
}
function taskRecord({provider, session, turn, task, result}) {
  const output=excerpt(result); if(!output || !session || !turn || !['DSH','Codex'].includes(provider))return null;
  const title=excerpt(task,200), id=createHash('sha256').update(JSON.stringify([provider,session,turn])).digest('hex');
  return {source:'project',id,text:`工作台项目任务（${provider}）${title?'：'+title:''}。完成结果摘要：${output}`};
}
function screenRecord({id,question,text}) {
  const result=excerpt(text); if(!id||!result)return null;
  const prompt=excerpt(question,200);
  return {source:'screen',id:String(id),text:`用户主动分享的屏幕观察${prompt?'，问题：'+prompt:''}。主角色观察摘要：${result}`};
}
function content(value) {
  if(typeof value==='string')return value;
  if(Array.isArray(value))return value.map(content).join('');
  if(!value||typeof value!=='object')return '';
  return value.type==='text' ? String(value.text||'') : content(value.content||value.message?.content||value.blocks);
}
function isRootWorkSession(state, session) {
  if (!session || !state) return false;
  if (state.dshRoot?.sessionId === session) return true;
  const actor = state.actors?.find(a => a.sessionId === session && a.id !== 'main');
  return actor?.kind === 'task' && actor.metadataReady === true && actor.metadataSource === 'dsh-task-session' && !actor.parentSessionId;
}
function createProjectTracker(onCompleted, allowed = () => false) {
  const turns=new Map(), pending=new Map();
  function accept(session,event) {
    if(!session||!event||typeof event.type!=='string')return;
    if(!allowed(session)){
      turns.delete(session);
      if(event.type==='turn/start'){
        if(pending.size>=500)pending.delete(pending.keys().next().value);
        pending.set(session,{type:'turn/start',id:event.id,seq:event.seq});
      } else if(event.type==='turn/end') pending.delete(session);
      return;
    }
    const start=pending.get(session);
    if(start){pending.delete(session);accept(session,start);}
    if(event.type==='turn/start'){
      if(turns.size>=500)turns.delete(turns.keys().next().value);
      turns.set(session,{turn:String(event.id||event.seq||randomUUID()),task:'',result:''});return;
    }
    const turn=turns.get(session);if(!turn)return;
    if(event.type==='user/message'&&event.data?.source?.kind==='user')turn.task=content(event.data.content).slice(0,1000);
    if(event.type==='assistant/message')turn.result=content(event.data?.message||event).slice(0,12000);
    if(event.type==='turn/end'){
      turns.delete(session);
      if((event.data?.reason?.kind||event.stopReason)==='completed'){
        const value=taskRecord({provider:'DSH',session,turn:turn.turn,task:turn.task,result:turn.result});
        if(value)onCompleted(value);
      }
    }
  }
  return {accept};
}
module.exports={excerpt,taskRecord,screenRecord,createProjectTracker,isRootWorkSession};
