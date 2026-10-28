'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {dbscan,bodyBounds,clusterLayout,fountainOrigin,fountainFrame,separation}=require('../../apps/neko-workbench/pet-swarm.cjs');
const {createSubagentMotion,HOME_REST_MS}=require('../../apps/neko-workbench/subagent-motion.cjs');
const area={x:0,y:24,width:1440,height:900};
class Window {
  constructor(x=150,y=550){this.bounds={x,y,width:255,height:217};this.visible=true;this.moves=[];}
  getBounds(){return {...this.bounds};}isVisible(){return this.visible;}isDestroyed(){return !!this.destroyed;}isFocused(){return !!this.focused;}
  setPosition(x,y){this.moves.push([x,y]);Object.assign(this.bounds,{x,y});}
}
function fixture(count=1){
  let time=0,reduced=false,cursor=null,paused=false,scheduled=0,cleared=0;
  let home={x:700,y:540,width:478,height:342,body:{width:176,height:201,bottomInset:18}};
  const entries=Array.from({length:count},(_,i)=>({id:'agent-'+i,sessionId:'native-'+i,window:new Window(50+i*36,500),active:true,returning:false,
    fountain:true,cluster:true,explore:false,body:{width:91,height:105,bottomInset:15}}));
  const poses=[],returned=[],layers=[];
  const motion=createSubagentMotion({now:()=>time,getHome:()=>home,getArea:()=>area,getCursor:()=>cursor,reducedMotion:()=>reduced,isPaused:()=>paused,
    onPose:(id,value)=>poses.push({id,value}),onReturned:id=>returned.push(id),onForeground:id=>layers.push(id),
    schedule:()=>{scheduled++;return 1;},unschedule:()=>{cleared++;}});
  return {entries,motion,poses,returned,layers,sync:()=>motion.sync(entries),step(n=1){for(let i=0;i<n;i++){time+=40;motion.tick();}},
    setReduced:v=>reduced=v,setCursor:v=>cursor=v,setPaused:v=>paused=v,setHome:v=>home=v,get home(){return home;},get scheduled(){return scheduled;},get cleared(){return cleared;}};
}
function inside(b,a=area){assert(b.x>=a.x&&b.y>=a.y);assert(b.x+b.width<=a.x+a.width);assert(b.y+b.height<=a.y+a.height);}

test('DBSCAN expands density-connected neighbours, promotes border points, distinguishes noise and validates parameters',()=>{
  const points=[{x:0,y:0},{x:5,y:0},{x:10,y:0},{x:100,y:100},{x:105,y:100},{x:300,y:-20}];
  assert.deepEqual(dbscan(points,6,2),[0,0,0,1,1,-1]);
  assert.deepEqual(dbscan([{x:0,y:0},{x:1,y:0},{x:2,y:0}],1.1,3),[0,0,0]);
  assert.deepEqual(dbscan([],10),[]);assert.deepEqual(dbscan([{x:0,y:0},{x:0,y:0}],1,2),[0,0]);
  assert.throws(()=>dbscan(points,0),TypeError);assert.throws(()=>dbscan([{x:NaN,y:0}],1),TypeError);
});

test('mixed-size colonies have finite distinct placements inside negative-origin displays and avoid the main visible body',()=>{
  const a={x:-1440,y:-300,width:1440,height:900},home={x:-520,y:150,width:478,height:342,body:{width:176,height:201,bottomInset:18}};
  const records=Array.from({length:32},(_,i)=>({id:'pet-'+i,homeSlot:i,point:{x:-1400+i*20,y:200,width:160,height:140},body:{width:i%3?50:66,height:i%3?58:74,bottomInset:6}}));
  const layout=clusterLayout(records,home,a),positions=new Set();
  for(const r of records){const target=layout.targets.get(r.id);inside(target,a);positions.add(target.x+','+target.y);assert(Number.isFinite(target.x+target.y));
    const b=bodyBounds(target,r.body),m=bodyBounds(home);
    assert(b.x+b.width<=m.x||b.x>=m.x+m.width||b.y+b.height<=m.y||b.y>=m.y+m.height);
  }
  assert.equal(positions.size,32);assert.deepEqual([...clusterLayout(records,home,a).targets],[...layout.targets]);
});

test('fountain starts behind the main body, rises, lands precisely and stays on the selected display',()=>{
  const f=fixture(),e=f.entries[0],origin=fountainOrigin(e.window.bounds,e.body,f.home,area);
  const main=bodyBounds(f.home),b=bodyBounds(origin,e.body);assert(Math.abs(b.x+b.width/2-main.x-main.width/2)<1);
  const target={...e.window.bounds,x:500,y:500};
  const first=fountainFrame({origin,target,area,elapsed:0,lift:150});assert.deepEqual(first.point,origin);
  const peak=fountainFrame({origin,target,area,elapsed:450,lift:150});assert(peak.point.y<origin.y&&peak.point.y<target.y);
  const last=fountainFrame({origin,target,area,elapsed:900,lift:150});assert(last.done);assert.deepEqual(last.point,target);
  for(let t=0;t<=1300;t+=20)inside(fountainFrame({origin,target,area,elapsed:t,slot:7,lift:800}).point);
});

test('eight native identities fountain once, settle as a colony and use one shared timer without altering tasks',()=>{
  const f=fixture(8);f.sync();assert.equal(f.scheduled,1);assert.equal(f.motion.snapshot().filter(x=>x.spawning).length,8);
  f.step(1);f.step(8);assert(f.poses.some(x=>x.value?.phase==='spawning'&&x.value.progress>0));
  for(let i=0;i<100;i++){f.step();for(const e of f.entries)inside(e.window.bounds);}
  assert(f.motion.snapshot().every(x=>!x.spawning&&x.phase==='clustered'));
  assert(f.entries.every(e=>e.active===true&&e.sessionId.startsWith('native-')));
  const starts=f.poses.filter(x=>x.value?.phase==='spawning'&&x.value.progress===0).length;
  for(let i=0;i<20;i++){f.sync();f.step();}assert.equal(f.scheduled,1);
  assert.equal(f.poses.filter(x=>x.value?.phase==='spawning'&&x.value.progress===0).length,starts);
  f.motion.dispose();assert.equal(f.cleared,1);assert.deepEqual(f.motion.snapshot(),[]);
});

test('birth time starts on first visible frame; promotion, window replacement and preference changes do not replay it',()=>{
  const f=fixture(),e=f.entries[0];e.window.visible=false;f.sync();f.step(80);assert(f.motion.snapshot()[0].spawning);
  e.window.visible=true;f.step();assert.equal(f.poses.at(-1).value.progress,0);f.step(40);assert(!f.motion.snapshot()[0].spawning);
  e.id='subagent-promoted';e.window=new Window();f.sync();assert(!f.motion.snapshot()[0].spawning);
  e.fountain=false;f.sync();e.fountain=true;f.sync();assert(!f.motion.snapshot()[0].spawning);
  f.motion.sync([]);f.sync();assert(!f.motion.snapshot()[0].spawning);f.motion.dispose();
});

test('cursor over main does not cancel hidden birth; input, focus and dragging cancel flight safely',()=>{
  const f=fixture(),e=f.entries[0],b=bodyBounds(f.home);f.setCursor({x:b.x+b.width/2,y:b.y+b.height/2});f.sync();f.step(5);
  assert(f.motion.snapshot()[0].spawning);f.setCursor(null);f.setPaused(true);const at=e.window.getBounds();f.step();
  assert(!f.motion.snapshot()[0].spawning);assert.deepEqual(e.window.getBounds(),at);f.setPaused(false);
  e.window.setPosition(200,200);f.motion.resumeFromDrag(e.id);const placed=e.window.getBounds();f.step(70);assert.deepEqual(e.window.getBounds(),placed);
  f.step(60);assert.notDeepEqual(e.window.getBounds(),placed);f.motion.dispose();
});

test('reduced motion disables births and cancels an in-flight birth immediately; hidden and destroyed windows stay safe',()=>{
  const f=fixture();f.setReduced(true);f.sync();assert(!f.motion.snapshot()[0].spawning);const at=f.entries[0].window.getBounds();f.step(20);assert.deepEqual(f.entries[0].window.getBounds(),at);f.motion.dispose();
  const g=fixture();g.sync();g.step(5);g.setReduced(true);g.step();assert(!g.motion.snapshot()[0].spawning);
  g.entries[0].window.visible=false;const hidden=g.entries[0].window.getBounds();g.step(10);assert.deepEqual(g.entries[0].window.getBounds(),hidden);
  g.entries[0].window.destroyed=true;g.step();assert.deepEqual(g.motion.snapshot(),[]);assert.equal(g.cleared,1);
});

test('all appearances gather on completion; pinned roles never request a fade and new work cancels pending removal',()=>{
  const f=fixture(3);f.sync();f.step(80);const e=f.entries[0];e.active=false;e.returning=true;e.retire=false;f.sync();f.step(80);
  assert(f.returned.includes(e.id));assert(f.poses.some(x=>x.id===e.id&&x.value?.phase==='gathered'&&x.value.retire===false));
  assert.equal(HOME_REST_MS,1300);const second=f.entries[1];second.active=false;second.returning=true;f.sync();f.step(5);
  second.active=true;second.returning=false;f.sync();f.step(70);assert(!f.returned.includes(second.id));f.motion.dispose();
});

test('separation steers overlapping visible neighbours apart with a bounded force',()=>{
  const f=fixture(2),records=f.entries.map((e,i)=>({...e,homeSlot:i,point:e.window.getBounds()}));
  records[1].point={...records[0].point};const force=separation(records[0],records);assert(force.x<0);assert(Math.hypot(force.x,force.y)<=130.001);
  records[1].point.x+=500;assert.deepEqual(separation(records[0],records),{x:0,y:0});
});

test('retiring a neighbour preserves survivor slots and pinned completion keeps its native position across reconciliation',()=>{
  const f=fixture(3);f.sync();f.step(80);
  const previous=f.motion.snapshot(),pinned=f.entries[0];pinned.active=false;pinned.returning=true;pinned.retire=false;
  f.sync();f.step(60);const at=pinned.window.getBounds();f.sync();f.step(2);assert.deepEqual(pinned.window.getBounds(),at);
  const survivor=previous.find(r=>r.id===f.entries[2].id).target;
  f.entries.splice(1,1);f.sync();f.step(2);
  assert.deepEqual(f.motion.snapshot().find(r=>r.id===f.entries[1].id).target,survivor);
  f.motion.dispose();
});
