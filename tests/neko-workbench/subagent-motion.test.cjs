'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { createSubagentMotion, motionOptions, homeTarget, exploreTarget, HOME_REST_MS } = require('../../apps/neko-workbench/subagent-motion.cjs');
const area = { x: 0, y: 24, width: 1440, height: 850 };
class Window {
  constructor(x=300,y=300) { this.bounds={x,y,width:200,height:169};this.visible=true;this.focused=false;this.moves=[]; }
  getBounds(){return {...this.bounds};} isDestroyed(){return !!this.destroyed;} isVisible(){return this.visible;} isFocused(){return this.focused;}
  setPosition(x,y,animate){this.moves.push({x,y,animate});Object.assign(this.bounds,{x,y});}
}
function fixture(){
  let time=0,home={x:800,y:500,width:400,height:330},cursor=null,reduced=false,paused=false,scheduled=0,cleared=0;
  const poses=[],returned=[],w=new Window();
  const motion=createSubagentMotion({now:()=>time,random:()=>.25,getHome:()=>home,getArea:()=>area,getCursor:()=>cursor,reducedMotion:()=>reduced,isPaused:()=>paused,
    onPose:(id,value)=>poses.push({id,value}),onReturned:id=>returned.push(id),schedule:()=>{scheduled++;return 1;},unschedule:()=>{cleared++;}});
  const entry={id:'subagent-real',window:w,active:true,returning:false};
  return {motion,w,entry,poses,returned,sync:()=>motion.sync([entry]),step(ms=40){time+=ms;motion.tick();},setHome:v=>home=v,setCursor:v=>cursor=v,setReduced:v=>reduced=v,setPaused:v=>paused=v,
    get scheduled(){return scheduled;},get cleared(){return cleared;},get home(){return home;}};
}
function assertInside(bounds){assert(bounds.x>=area.x&&bounds.y>=area.y);assert(bounds.x+bounds.width<=area.x+area.width);assert(bounds.y+bounds.height<=area.y+area.height);}

test('exploration moves actual native windows smoothly, pauses between trips and keeps task events independent',()=>{
  const f=fixture();f.sync();const initial=f.w.getBounds();f.step();
  assert.notDeepEqual(f.w.getBounds(),initial);assert(Math.hypot(f.w.bounds.x-initial.x,f.w.bounds.y-initial.y)<=5);
  assert.equal(f.entry.active,true);assert.equal(f.scheduled,1);
  for(let i=0;i<600;i++){f.step();assertInside(f.w.bounds);}
  assert(f.poses.some(p=>p.value?.moving));assert(f.poses.some(p=>p.value?.phase==='exploring'&&!p.value.moving));
  f.motion.dispose();assert.equal(f.cleared,1);assert.equal(f.poses.at(-1).value,null);
});

test('return follows the current main character, gathers briefly and completes only after arrival',()=>{
  const f=fixture();f.sync();for(let i=0;i<20;i++)f.step();
  f.entry.active=false;f.entry.returning=true;f.sync();for(let i=0;i<15;i++)f.step();
  assert.equal(f.returned.length,0);f.setHome({x:100,y:300,width:400,height:330});
  for(let i=0;i<150;i++)f.step();
  assert.deepEqual(f.returned,['subagent-real']);
  const target=homeTarget(f.home,f.w.bounds,area);assert.equal(f.w.bounds.x,target.x);assert.equal(f.w.bounds.y,target.y);
  assert(f.poses.some(p=>p.value?.phase==='gathered'&&!p.value.moving));
  for(let i=0;i<50;i++)f.step();assert.equal(f.returned.length,1,'one completion callback per return');
});

test('pointer hover, focus, open input and drag pause both exploration and return without premature disappearance',()=>{
  const f=fixture();f.sync();
  for(const reason of ['hover','focus','input']){
    const before=f.w.getBounds();
    if(reason==='hover')f.setCursor({x:before.x+10,y:before.y+10});
    if(reason==='focus')f.w.focused=true;
    if(reason==='input')f.setPaused(true);
    for(let i=0;i<80;i++)f.step();assert.deepEqual(f.w.getBounds(),before);
    f.setCursor(null);f.w.focused=false;f.setPaused(false);
  }
  f.w.setPosition(700,200);f.motion.resumeFromDrag(f.entry.id);const placed=f.w.getBounds();
  for(let i=0;i<50;i++)f.step();assert.deepEqual(f.w.getBounds(),placed,'manual placement gets a brief pause');
  f.entry.active=false;f.entry.returning=true;f.sync();f.setPaused(true);
  for(let i=0;i<1000;i++)f.step();assert.equal(f.returned.length,0);
  f.setPaused(false);for(let i=0;i<200;i++)f.step();assert.equal(f.returned.length,1);
});

test('new work cancels a pending return, hidden/removed actors stop moving and stale completion cannot hide them',()=>{
  const f=fixture();f.sync();f.entry.active=false;f.entry.returning=true;f.sync();f.step();
  f.entry.active=true;f.entry.returning=false;f.sync();for(let i=0;i<300;i++)f.step();assert.equal(f.returned.length,0);
  f.w.visible=false;const at=f.w.getBounds();for(let i=0;i<30;i++)f.step();assert.deepEqual(f.w.getBounds(),at);
  f.motion.sync([]);f.w.visible=true;for(let i=0;i<30;i++)f.step();assert.deepEqual(f.w.getBounds(),at);assert.equal(f.cleared,1);
});

test('reduced motion suppresses exploration and uses a still, immediate home placement before retreat',()=>{
  const f=fixture();f.setReduced(true);f.sync();const at=f.w.getBounds();for(let i=0;i<20;i++)f.step();assert.deepEqual(f.w.getBounds(),at);
  f.entry.active=false;f.entry.returning=true;f.sync();f.step();assert.equal(f.poses.at(-1).value.phase,'gathered');assert.equal(f.returned.length,0);
  for(let i=0;i<Math.ceil(HOME_REST_MS/40)+1;i++)f.step();assert.equal(f.returned.length,1);
});

test('reconciliation preserves exploration positions, layout sizes and negative-origin display bounds',()=>{
  const f=fixture();f.sync();for(let i=0;i<20;i++)f.step();const at=f.w.getBounds();
  const kept=f.motion.keepPosition(f.entry.id,{x:1000,y:600,width:180,height:155},area);
  assert.equal(kept.x,at.x);assert.equal(kept.y,at.y);assert.equal(kept.width,180);
  f.motion.replay(f.entry.id);assert(f.poses.at(-1).value.phase==='exploring');
  const display={x:-1440,y:-100,width:1440,height:900};
  for(let index=0;index<8;index++){
    const target=homeTarget({x:-400,y:100,width:400,height:300},{width:200,height:169},display,index);
    assert(target.x>=display.x&&target.y>=display.y);assert(target.x+200<=0&&target.y+169<=800);
    const explore=exploreTarget({width:200,height:169},display,()=>index/8);
    assert(explore.x>=display.x&&explore.y>=display.y);assert(explore.x+200<=0&&explore.y+169<=800);
  }
});

test('one helper finishing its fade does not change the remaining helpers gathering slots',()=>{
  const f=fixture(),second=new Window(0,30);
  const firstHome=homeTarget(f.home,f.w.bounds,area,0);f.w.setPosition(firstHome.x,firstHome.y);
  f.entry.active=false;f.entry.returning=true;
  f.motion.sync([f.entry,{id:'second',window:second,active:false,returning:true}]);
  for(let i=0;i<200;i++)f.step();
  const secondHome=homeTarget(f.home,second.bounds,area,1);
  assert.equal(second.bounds.x,secondHome.x);assert.equal(second.bounds.y,secondHome.y);
  assert.deepEqual(f.returned,['subagent-real','second']);
});

test('subsections land once and keep their workplace while tiny subagents gather and follow the main pet',()=>{
  const f=fixture(),task=f.entry,helperWindow=new Window(200,300);
  Object.assign(task,motionOptions({id:'task',kind:'task'},{},true));
  assert.deepEqual({fountain:task.fountain,cluster:task.cluster,explore:task.explore},{fountain:true,cluster:false,explore:false});
  const helper={id:'helper',window:helperWindow,active:true,...motionOptions({id:'helper',kind:'subagent'})};
  const sync=()=>f.motion.sync([task,helper]);sync();
  assert(f.motion.snapshot().every(r=>r.spawning));
  for(let i=0;i<180;i++)f.step();
  const landed=task.window.getBounds();
  assert.equal(f.motion.snapshot().find(r=>r.id===task.id).phase,'resting');
  assert.equal(f.motion.snapshot().find(r=>r.id===task.id).target,undefined,'task is excluded from cluster layout');
  const helperBefore=helperWindow.getBounds();
  f.setHome({x:100,y:300,width:400,height:330});sync();
  for(let i=0;i<220;i++)f.step();
  assert.deepEqual(task.window.getBounds(),landed,'landed subsection stays in place to work');
  assert.notDeepEqual(helperWindow.getBounds(),helperBefore,'tiny subagent follows the colony');
  assert.equal(f.motion.snapshot().find(r=>r.id==='helper').phase,'clustered');
});
