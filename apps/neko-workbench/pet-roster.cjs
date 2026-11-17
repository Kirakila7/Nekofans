// DSH renders each catalog in its stored order and expands children inline.
const DEFAULT_LIMIT=5;
const DESKTOP_ROTATION_MS=15000;
// A return animation must not keep a hidden or overflowed helper alive forever.
const RETURN_HOME_TIMEOUT_MS=60000;
function beginReturnHome(actor,now=Date.now()){
  actor.returningHome=true;actor.displayUntil=now+RETURN_HOME_TIMEOUT_MS;
}
function expireReturnHomes(actors,now=Date.now()){
  for(const actor of actors){
    if(!actor.returningHome)continue;
    if(actor.active){actor.returningHome=false;continue;}
    if(!Number.isFinite(actor.displayUntil)||actor.displayUntil<=now){actor.returningHome=false;actor.displayUntil=0;}
  }
}
function normalizeLimit(value){return Number.isInteger(Number(value))&&Number(value)>=1&&Number(value)<=32?Number(value):DEFAULT_LIMIT;}
// A snapshot requested before an append can arrive after its live catalog event.
function mergeCatalogOrder(snapshot,known){return [...new Set([...snapshot,...known])];}
function catalogOrder(rootId,children){
  const seen=new Set(),ordered=[];
  function visit(parent){for(const id of children.get(parent)||[]){if(seen.has(id))continue;seen.add(id);ordered.push(id);visit(id);}}
  if(rootId)visit(rootId);
  for(const parent of children.keys())if(!seen.has(parent))visit(parent);
  return ordered;
}
function actorKind(actor){return actor?.id==='main'?'main':actor?.kind==='task'?'task':'subagent';}
function desktopHomeId(actor,actors){
  const bySession=new Map(actors.filter(a=>a.sessionId).map(a=>[a.sessionId,a]));
  const visited=new Set([actor?.sessionId]);let parent=actor?.parentSessionId;
  while(parent&&!visited.has(parent)){
    visited.add(parent);const owner=bySession.get(parent);if(!owner)break;
    if(owner.kind==='task'&&owner.present)return owner.id;
    parent=owner.parentSessionId;
  }
  return 'main';
}
function taskActorId(sessionId){if(typeof sessionId!=='string'||!sessionId.trim()||/[\x00-\x1f]/.test(sessionId))throw new TypeError('A task needs a real session id');return 'task-'+sessionId;}
function rankOf(order){return new Map([...new Set(Array.isArray(order)?order:[])].map((id,index)=>[id,index]));}
function eligible(actors,kind,rank){
  const seen=new Set();
  return actors.filter(actor=>{
    if(actorKind(actor)!==kind||!actor.metadataReady||typeof actor.sessionId!=='string'||!rank.has(actor.sessionId)||seen.has(actor.sessionId))return false;
    seen.add(actor.sessionId);return true;
  }).sort((a,b)=>rank.get(a.sessionId)-rank.get(b.sessionId));
}
function desktopRoster(actors,{taskOrder=[],catalogOrder=[]}={}){
  const subs=eligible(actors,'subagent',rankOf(catalogOrder));
  const subBySession=new Map(subs.map(actor=>[actor.sessionId,actor]));
  // A session which is a genuine subagent cannot simultaneously be a task pet.
  const tasks=eligible(actors,'task',rankOf(taskOrder)).filter(actor=>!subBySession.has(actor.sessionId));
  const taskBySession=new Map(tasks.map(actor=>[actor.sessionId,actor]));
  const groups=new Map(tasks.map(task=>[task.sessionId,[]])),orphans=[],families=new Map();
  for(const task of tasks)families.set(task,task.sessionId);
  for(const sub of subs){
    let parent=sub.parentSessionId,task=null;
    const visited=new Set([sub.sessionId]);
    while(typeof parent==='string'&&!visited.has(parent)){
      if(taskBySession.has(parent)){task=taskBySession.get(parent);break;}
      visited.add(parent);parent=subBySession.get(parent)?.parentSessionId;
    }
    if(task){groups.get(task.sessionId).push(sub);families.set(sub,task.sessionId);}
    else{orphans.push(sub);families.set(sub,sub.parentSessionId||sub.sessionId);}
  }
  const ordered=tasks.flatMap(task=>[task,...groups.get(task.sessionId)]).concat(orphans);
  return {tasks,subs,ordered,families};
}
function orderedTaskPets(actors,taskOrder,{catalogOrder=[]}={}){return desktopRoster(actors,{taskOrder,catalogOrder}).tasks;}
function orderedDesktopPets(actors,orders={}){return desktopRoster(actors,orders).ordered;}
function rotate(values,offset){if(!values.length)return [];const start=offset%values.length;return values.slice(start).concat(values.slice(0,start));}
function fairTake(candidates,families,count,tick){
  if(candidates.length<=count)return candidates;
  const buckets=new Map();
  for(const actor of candidates){const key=families.get(actor);if(!buckets.has(key))buckets.set(key,[]);buckets.get(key).push(actor);}
  const values=[...buckets.values()];
  // Advance a family's member only after a full family cycle. Rotating both
  // by the same modulo would permanently hide A's child/B's parent at limit 1.
  const groups=rotate(values,tick).map(group=>rotate(group,Math.floor(tick/values.length)));
  const chosen=[];
  for(let round=0;chosen.length<count;round++){
    let added=false;
    for(const group of groups){if(group[round]){chosen.push(group[round]);added=true;if(chosen.length===count)break;}}
    if(!added)break;
  }
  return chosen;
}
function selectDesktopPets(actors,orders,limit,now=Date.now()){
  const {ordered,families}=desktopRoster(actors,orders),capacity=normalizeLimit(limit),tick=Math.floor(now/DESKTOP_ROTATION_MS);
  const pinned=ordered.filter(actor=>actor.pinned).slice(0,capacity);
  const active=ordered.filter(actor=>!actor.pinned&&actor.active);
  const selected=[...pinned,...fairTake(active,families,capacity-pinned.length,tick)];
  const feedback=ordered.filter(actor=>!actor.pinned&&!actor.active&&(actor.returningHome||actor.displayUntil>now));
  selected.push(...fairTake(feedback,families,capacity-selected.length,tick));
  const chosen=new Set(selected);
  // Selection priority controls membership; visible order still keeps a task
  // and its actual descendants adjacent instead of pretending they are one pet.
  return ordered.filter(actor=>chosen.has(actor));
}
function nextDesktopRefreshAt(actors,orders,limit,now=Date.now()){
  const ordered=orderedDesktopPets(actors,orders),capacity=normalizeLimit(limit);
  const pinned=Math.min(capacity,ordered.filter(actor=>actor.pinned).length),free=capacity-pinned;
  const active=ordered.filter(actor=>!actor.pinned&&actor.active).length;
  const feedback=ordered.filter(actor=>!actor.pinned&&!actor.active&&(actor.returningHome||actor.displayUntil>now));
  const candidates=feedback.filter(actor=>actor.displayUntil>now).map(actor=>actor.displayUntil);
  const feedbackSlots=Math.max(0,free-active);
  if(free>0&&(active>free||(feedbackSlots>0&&feedback.length>feedbackSlots)))candidates.push((Math.floor(now/DESKTOP_ROTATION_MS)+1)*DESKTOP_ROTATION_MS);
  return candidates.length?Math.min(...candidates):null;
}
function orderedHelpers(actors,order,options){
  if(options&&Object.hasOwn(options,'taskOrder'))return orderedDesktopPets(actors,{...options,catalogOrder:order});
  const rank=new Map(order.map((id,i)=>[id,i]));
  return actors.filter(a=>actorKind(a)==='subagent'&&a.metadataReady&&rank.has(a.sessionId)).sort((a,b)=>rank.get(a.sessionId)-rank.get(b.sessionId));
}
function selectHelpers(actors,order,limit,now=Date.now(),options){
  if(options&&Object.hasOwn(options,'taskOrder'))return selectDesktopPets(actors,{...options,catalogOrder:order},limit,now);
  const all=orderedHelpers(actors,order),pinned=all.filter(a=>a.pinned),active=all.filter(a=>a.active&&!a.pinned);
  // Completed feedback uses spare slots; it never blocks a running DSH task.
  return [...pinned,...active,...all.filter(a=>!a.pinned&&!a.active&&a.displayUntil>now)].slice(0,normalizeLimit(limit));
}
function displayName(actor){return actor.nickname||actor.dshName||actor.label||actor.sessionId;}
function nickname(value){const name=String(value??'').trim();if(Array.from(name).length>24||/[\r\n\x00-\x1f]/.test(name))throw new Error('名字请使用 24 字以内的单行文字。');return name;}
module.exports={DEFAULT_LIMIT,DESKTOP_ROTATION_MS,RETURN_HOME_TIMEOUT_MS,beginReturnHome,expireReturnHomes,normalizeLimit,mergeCatalogOrder,catalogOrder,
  actorKind,desktopHomeId,taskActorId,orderedTaskPets,orderedDesktopPets,selectDesktopPets,nextDesktopRefreshAt,
  orderedHelpers,selectHelpers,displayName,nickname};
