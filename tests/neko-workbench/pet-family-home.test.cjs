'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {desktopHomeId}=require('../../apps/neko-workbench/pet-roster.cjs');
const {createSubagentMotion}=require('../../apps/neko-workbench/subagent-motion.cjs');
const {normalizePreferences}=require('../../apps/neko-workbench/pet-appearance.js');
test('helpers gather by default while an explicit roaming preference survives normalization',()=>{assert.equal(normalizePreferences().subagentExploration,false);assert.equal(normalizePreferences({subagentExploration:true}).subagentExploration,true);});
test('nested helpers choose their visible owning task, with bounded main fallback',()=>{
  const task={id:'task-one',kind:'task',sessionId:'one',present:true},helper={id:'helper',sessionId:'two',parentSessionId:'one'},child={id:'child',sessionId:'three',parentSessionId:'two'};
  const actors=[task,helper,child];assert.equal(desktopHomeId(helper,actors),'task-one');assert.equal(desktopHomeId(child,actors),'task-one');
  task.present=false;assert.equal(desktopHomeId(child,actors),'main');task.present=true;
  helper.parentSessionId='three';assert.equal(desktopHomeId(child,actors),'main');assert.equal(desktopHomeId({parentSessionId:'missing'},actors),'main');
});
class Window{constructor(x){this.bounds={x,y:400,width:120,height:120};}getBounds(){return {...this.bounds};}isDestroyed(){return false;}isVisible(){return true;}setPosition(x,y){Object.assign(this.bounds,{x,y});}}
test('two work-session families gather separately and track only their own moving task',()=>{
  let time=0;const area={x:0,y:0,width:2000,height:1000};
  const homes={a:{anchorId:'task-a',x:150,y:300,width:300,height:300},b:{anchorId:'task-b',x:1350,y:300,width:300,height:300}};
  const motion=createSubagentMotion({now:()=>time,getHome:id=>homes[id],getArea:()=>area,schedule:()=>1,unschedule(){}});
  const a=new Window(200),b=new Window(1400);motion.sync([{id:'a',window:a,active:true,cluster:true,explore:false,fountain:false},{id:'b',window:b,active:true,cluster:true,explore:false,fountain:false}]);
  for(let n=0;n<200;n++){time+=40;motion.tick();}
  let snapshots=motion.snapshot(),targetA=snapshots.find(x=>x.id==='a').target,targetB=snapshots.find(x=>x.id==='b').target;
  assert(targetA.x<800);assert(targetB.x>1000);assert.equal(a.bounds.x,Math.round(targetA.x));assert.equal(b.bounds.x,Math.round(targetB.x));
  const oldA={...targetA};homes.b.x-=200;time+=40;motion.tick();snapshots=motion.snapshot();assert.deepEqual(snapshots.find(x=>x.id==='a').target,oldA);assert(snapshots.find(x=>x.id==='b').target.x<targetB.x);motion.dispose();
});
