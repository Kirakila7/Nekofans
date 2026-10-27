'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {restoreDesktopActor,syncTaskRecord,acceptTaskRoster,promoteTaskRecord}=require('../../apps/neko-workbench/task-pets.cjs');
const {actorBySession}=require('../../apps/neko-workbench/chat-routing.cjs');
const state=()=>({actors:[{id:'main',chatBackend:'chat-api',sessionId:null}],positions:{},taskOrder:[],dshRoot:{id:'dsh-root',sessionId:'root'}});
const task=(sessionId,patch={})=>({source:'dsh-task-session',sessionId,running:true,backgroundJobs:0,title:'真实任务',task:'正在整理',...patch});

test('task restore preserves its tier, pin and saved position but requires native revalidation',()=>{
  const positions={old:{x:10,y:20}};
  const restored=restoreDesktopActor({id:'old',kind:'task',sessionId:'task-session',name:'自定义',pinned:true,active:true},positions);
  assert.equal(restored.id,'task-task-session');assert.equal(restored.kind,'task');assert.equal(restored.metadataReady,false);assert.equal(restored.active,false);assert.equal(restored.pinned,true);assert.deepEqual(positions[restored.id],{x:10,y:20});
  assert.equal(restoreDesktopActor({id:'old-child',sessionId:'child',name:'帮手'},{}).kind,'subagent');
});
test('only native task metadata creates a medium actor and source rosters withdraw stale identities',()=>{
  const s=state();assert.equal(syncTaskRecord(s,{...task('x'),source:'renderer'}),null);assert.equal(syncTaskRecord(s,task('bad id')),null);
  const change=syncTaskRecord(s,task('root'));assert(change.created);assert.equal(change.actor.kind,'task');assert.equal(actorBySession(s,'root'),change.actor);assert.notEqual(actorBySession(s,'root'),s.actors[0]);
  acceptTaskRoster(s,{source:'dsh-task-session',sessionIds:['root','root','invalid id']});assert.deepEqual(s.taskOrder,['root']);
  change.actor.pinned=true;acceptTaskRoster(s,{source:'dsh-task-session',sessionIds:[]});assert.equal(change.actor.metadataReady,false);assert.equal(change.actor.present,false);assert.equal(change.actor.pinned,true);
});
test('late native subagent identity promotes once, retaining user choices and never duplicates a medium pet',()=>{
  const s=state(),a=syncTaskRecord(s,task('child')).actor;
  a.nickname='小鲸鱼';a.pinned=true;s.positions[a.id]={x:1,y:2};s.taskOrder=['child'];
  const meta={source:'dsh-subagent-catalog',sessionId:'child',parentSessionId:'parent'};
  const result=promoteTaskRecord(s,meta);assert.equal(result.oldId,'task-child');assert.equal(a.kind,'subagent');assert.equal(a.id,'subagent-child');assert.equal(a.nickname,'小鲸鱼');assert.equal(a.pinned,true);assert.deepEqual(s.positions[a.id],{x:1,y:2});assert.deepEqual(s.taskOrder,[]);
  assert.equal(syncTaskRecord(s,task('child')),null);assert.equal(s.actors.length,2);assert.equal(promoteTaskRecord(s,meta),null);
});

test('verified task metadata repairs an ambiguous legacy helper identity without duplicating or losing user placement',()=>{
  const s=state();s.catalogOrder=['legacy'];s.actors.push({id:'subagent-legacy',kind:'subagent',sessionId:'legacy',nickname:'常用任务',pinned:true});s.positions['subagent-legacy']={x:12,y:34};
  const change=syncTaskRecord(s,task('legacy'));assert.equal(change.oldId,'subagent-legacy');assert.equal(change.actor.id,'task-legacy');assert.equal(change.actor.kind,'task');assert.equal(change.actor.name,'常用任务');assert.equal(change.actor.pinned,true);assert.deepEqual(s.positions['task-legacy'],{x:12,y:34});assert.deepEqual(s.catalogOrder,[]);assert.equal(s.actors.length,2);
});
