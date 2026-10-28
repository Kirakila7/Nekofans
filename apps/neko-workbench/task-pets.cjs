'use strict';
const TASK_SOURCE='dsh-task-session',SUBAGENT_SOURCE='dsh-subagent-catalog';
function validSession(value){return typeof value==='string'&&value.length>0&&value.length<=512&&!/[\x00-\x20\x7f]/.test(value);}
function restoreDesktopActor(actor,positions){
  if(actor.id==='main')return actor;
  const kind=actor.kind==='task'||actor.id.startsWith('task-')?'task':'subagent';
  const id=`${kind}-${actor.sessionId}`;
  if(positions[actor.id]&&!positions[id])positions[id]=positions[actor.id];
  return {...actor,id,kind,dshName:actor.dshName||actor.name||actor.sessionId,pinned:actor.pinned===true,
    present:false,metadataReady:false,active:false,backgroundJobs:0,taskOutcome:null,displayUntil:0,returningHome:false};
}
function syncTaskRecord(state,meta){
  if(meta?.source!==TASK_SOURCE||!validSession(meta.sessionId)||typeof meta.running!=='boolean')return null;
  let actor=state.actors.find(a=>a.id!=='main'&&a.sessionId===meta.sessionId);
  if(actor&&actor.metadataSource===SUBAGENT_SOURCE&&actor.kind!=='task')return null;
  const created=!actor;
  if(!actor){actor={id:`task-${meta.sessionId}`,kind:'task',sessionId:meta.sessionId,status:'idle',present:false,messages:[],notice:null,work:{state:null,task:null,tick:0},workFlags:{goalRound:false,closing:null}};state.actors.push(actor);}
  const wasActive=actor.active===true,oldId=actor.kind!=='task'?actor.id:null;
  if(oldId){actor.id=`task-${meta.sessionId}`;if(state.positions?.[oldId]&&!state.positions[actor.id])state.positions[actor.id]=state.positions[oldId];state.catalogOrder=(state.catalogOrder||[]).filter(id=>id!==meta.sessionId);}
  const safeText=value=>typeof value==='string'?value.replace(/[\x00-\x1f\x7f]/g,' ').trim().slice(0,240):'';
  const title=safeText(meta.title),task=safeText(meta.task),name=safeText(meta.name)||title||task||'工作台任务';
  Object.assign(actor,{kind:'task',mode:'task',dshName:name,title,task,metadataReady:true,metadataSource:TASK_SOURCE,
    backgroundJobs:Number.isInteger(meta.backgroundJobs)&&meta.backgroundJobs>0?Math.min(10000,meta.backgroundJobs):0,
    taskOutcome:['completed','killed','failed','unknown'].includes(meta.outcome)?meta.outcome:null,
    active:meta.running,createdAt:meta.createdAt??actor.createdAt});
  actor.name=actor.nickname||name;
  return {actor,wasActive,created,oldId};
}
function acceptTaskRoster(state,meta){
  if(meta?.source!==TASK_SOURCE||!Array.isArray(meta.sessionIds))return false;
  state.taskOrder=[...new Set(meta.sessionIds.filter(validSession))];
  const live=new Set(state.taskOrder);
  for(const actor of state.actors)if(actor.kind==='task'&&!live.has(actor.sessionId)){
    actor.metadataReady=false;actor.active=false;actor.displayUntil=0;actor.present=false;
  }
  return true;
}
function promoteTaskRecord(state,meta){
  if(meta?.source!==SUBAGENT_SOURCE||!validSession(meta.sessionId)||!validSession(meta.parentSessionId))return null;
  const actor=state.actors.find(a=>a.kind==='task'&&a.sessionId===meta.sessionId);
  if(!actor)return null;
  const oldId=actor.id;
  actor.id=`subagent-${meta.sessionId}`;actor.kind='subagent';actor.backgroundJobs=0;
  actor.metadataSource=SUBAGENT_SOURCE;actor.parentSessionId=meta.parentSessionId;
  if(state.positions?.[oldId]&&!state.positions[actor.id])state.positions[actor.id]=state.positions[oldId];
  state.taskOrder=(state.taskOrder||[]).filter(id=>id!==meta.sessionId);
  delete actor.lastTaskStopReason;
  return {actor,oldId};
}
module.exports={TASK_SOURCE,SUBAGENT_SOURCE,validSession,restoreDesktopActor,syncTaskRecord,acceptTaskRoster,promoteTaskRecord};
