'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {petLayout,packPetLayouts,petPlacement}=require('../../apps/neko-workbench/pet-layout.cjs');
const {actorKind,taskActorId,orderedTaskPets,orderedDesktopPets,selectDesktopPets,nextDesktopRefreshAt,
  orderedHelpers,selectHelpers,DESKTOP_ROTATION_MS}=require('../../apps/neko-workbench/pet-roster.cjs');

const mainWidth=stageWidth=>({stageWidth});
const task=(sessionId,extra={})=>({id:taskActorId(sessionId),kind:'task',sessionId,metadataReady:true,active:true,...extra});
const sub=(sessionId,parentSessionId,extra={})=>({id:'subagent-'+sessionId,sessionId,parentSessionId,metadataReady:true,active:true,...extra});
const ids=actors=>actors.map(actor=>actor.id);

test('main/task/subagent have three proportional stages while legacy booleans stay compatible',()=>{
  const original=mainWidth(462);
  assert.equal(petLayout('main',original).stageWidth,462);
  assert.equal(petLayout('task',original).stageWidth,323);
  assert.equal(petLayout('task',original).width,339,'middle windows need their actual width, not a 267px step');
  assert.equal(petLayout('subagent',original).stageWidth,239);
  const customized=mainWidth(320);
  assert.deepEqual(['main','task','subagent'].map(kind=>petLayout(kind,customized).stageWidth),[320,224,166]);
  assert.equal(petLayout(true,customized).stageWidth,320);
  assert.equal(petLayout(false,customized).stageWidth,239,'preserve the existing boolean helper API');
  assert.equal(petLayout('main').stageWidth,462);
  assert.throws(()=>petLayout('unknown',original),/kind/);
});

test('task identity is separate from main and legacy subagents and needs an actual session id',()=>{
  assert.equal(actorKind({id:'main',kind:'task'}),'main');
  assert.equal(actorKind(task('work')),'task');
  assert.equal(actorKind(sub('child','work')),'subagent');
  assert.equal(taskActorId('work'),'task-work');
  assert.equal(sub('child','work').id,'subagent-child');
  assert.throws(()=>taskActorId(''),/session id/);
  assert.throws(()=>taskActorId(null),/session id/);
});

test('compact appearance windows fit their native frame and name gutter at all three scales',()=>{
  const A=require('../../apps/neko-workbench/pet-appearance.js'),state={preferences:A.normalizePreferences({})};
  const actors=[{id:'main',appearanceId:A.CLAUDE,appearanceScale:.65},{id:'task-x',kind:'task',appearanceId:A.GEMINI,appearanceScale:.8},{id:'subagent-x',appearanceId:A.CAT}];
  const layouts=actors.map(actor=>{
    const kind=A.kind(actor),options=A.layoutOptions(state,actor),layout=petLayout(kind,mainWidth(462),options),legacy=petLayout(kind,mainWidth(462));
    const frameHeight=layout.stageWidth*9/16*options.scale,frameWidth=frameHeight*options.aspect;
    // Compact windows hug the native frame (IMPLEMENTATION_v0.18.md: "窗口按所选尺寸及画面
    // 比例收紧，并为三字标签保留侧边余量，底部仅留 6 像素"): the stage keeps its 16:9
    // height times the appearance scale, the frame stays centred with 8px side padding,
    // and the 3-char name tag is anchored at 50% + characterWidth*.32 with a 48px max
    // width (.pet-tier in style.css). A 16:9 frame is already wider than that anchor, so
    // the old uniform 60px gutter no longer describes the layout; square and 192:208
    // frames keep the wider side reservation. The invariant is frame + name tag inside.
    const nameTagHalfWidth=frameWidth*.32+48;
    assert(layout.width<legacy.width);assert(layout.height<legacy.height);
    assert(layout.width>=frameWidth+16,`${actor.id}: compact frame keeps 8px side padding`);
    assert(layout.width>=nameTagHalfWidth*2,`${actor.id}: upper-right 3-char name tag stays inside`);
    assert(layout.width>=(options.aspect===16/9?255:200),`${actor.id}: interactive minimum width`);
    assert(layout.height>=76+frameHeight+6,`${actor.id}: head slot + frame + 6px bottom`);
    return layout;
  });
  const bounds=packPetLayouts({area:{x:0,y:0,width:800,height:600},layouts});
  assertPacked({x:0,y:0,width:800,height:600},bounds);assert(bounds.every(item=>item.scale===1));
});

test('only real ordered task/catalog metadata becomes a desktop pet; task and nested children stay adjacent',()=>{
  const a=task('a'),b=task('b'),a1=sub('a1','a'),a2=sub('a2','a1'),b1=sub('b1','b');
  const actors=[{id:'main',metadataReady:true,pinned:true,active:true},b1,b,a2,task('stale'),a,task('loading',{metadataReady:false}),a1];
  const before=JSON.stringify(actors),orders={taskOrder:['a','b','loading'],catalogOrder:['b1','a1','a2']};
  assert.deepEqual(ids(orderedDesktopPets(actors,orders)),['task-a','subagent-a1','subagent-a2','task-b','subagent-b1']);
  assert.deepEqual(ids(orderedTaskPets(actors,orders.taskOrder,{catalogOrder:orders.catalogOrder})),['task-a','task-b']);
  assert.equal(JSON.stringify(actors),before,'ordering never changes actor identity or task state');
});

test('a catalogued subagent wins same-session dedup without combining its task identity',()=>{
  const taskAlias=task('same',{nickname:'middle alias'}),child=sub('same','parent',{nickname:'small actual'});
  const candidates=[taskAlias,task('real'),child,sub('same','parent'),task('real')];
  const orders={taskOrder:['same','real'],catalogOrder:['same']};
  const result=orderedDesktopPets(candidates,orders);
  assert.deepEqual(ids(result),['task-real','subagent-same']);
  assert.equal(result[1],child);
  assert.equal(result[1].nickname,'small actual');
  assert.equal(taskAlias.id,'task-same','the discarded alias is not rewritten into the subagent');
  assert.deepEqual(ids(orderedDesktopPets([taskAlias,child],{taskOrder:['same'],catalogOrder:[]})),['task-same'],'uncatalogued data cannot suppress a real task');
});

test('legacy helper signatures exclude task pets and preserve their old pinned/catalog selection order',()=>{
  const actors=[task('root'),sub('second','root'),sub('first','root',{pinned:true}),sub('loading','root',{metadataReady:false})];
  assert.deepEqual(ids(orderedHelpers(actors,['second','first','root','loading'])),['subagent-second','subagent-first']);
  assert.deepEqual(ids(selectHelpers(actors,['second','first','root'],1,0)),['subagent-first']);
  assert.deepEqual(ids(orderedHelpers(actors,['second','first'],{taskOrder:['root']})),['task-root','subagent-second','subagent-first']);
  assert.deepEqual(ids(selectHelpers(actors,['second','first'],2,0,{taskOrder:['root']})),['task-root','subagent-first']);
});

test('one shared non-main limit preserves pin priority, activity, and spare-slot completion feedback',()=>{
  const actors=[{id:'main',active:true,pinned:true,metadataReady:true},task('a',{pinned:true,active:false}),sub('a1','a'),task('b'),sub('done','b',{active:false,displayUntil:100})];
  const orders={taskOrder:['a','b'],catalogOrder:['a1','done']};
  const small=selectDesktopPets(actors,orders,2,0);
  assert.equal(small.length,2);
  assert(small.some(actor=>actor.id==='task-a'),'a pinned task still reserves one slot');
  assert(!small.some(actor=>actor.id==='main'||actor.id==='subagent-done'));
  assert.deepEqual(ids(selectDesktopPets(actors,orders,4,0)),['task-a','subagent-a1','task-b','subagent-done']);
  assert.deepEqual(ids(selectDesktopPets(actors,orders,4,101)),['task-a','subagent-a1','task-b']);
  assert.equal(selectDesktopPets(actors,orders,1,0)[0].id,'task-a');
});

test('small limits rotate across task families and their children without permanent same-modulo starvation',()=>{
  const actors=[task('a'),task('b'),sub('a1','a'),sub('b1','b')];
  const orders={taskOrder:['a','b'],catalogOrder:['a1','b1']};
  const seen=new Set();
  for(let tick=0;tick<8;tick++){
    const selected=selectDesktopPets(actors,orders,1,tick*DESKTOP_ROTATION_MS);
    assert.equal(selected.length,1);
    seen.add(selected[0].id);
  }
  assert.deepEqual([...seen].sort(),['subagent-a1','subagent-b1','task-a','task-b']);
  assert.equal(nextDesktopRefreshAt(actors,orders,1,1),DESKTOP_ROTATION_MS);
  assert.equal(nextDesktopRefreshAt(actors,orders,4,1),null);
  const feedback=[task('a',{active:false,displayUntil:500})];
  assert.equal(nextDesktopRefreshAt(feedback,{taskOrder:['a'],catalogOrder:[]},5,1),500);
  assert.equal(nextDesktopRefreshAt(feedback,{taskOrder:['a'],catalogOrder:[]},5,501),null);
});

test('cyclic/orphaned parent metadata stays bounded and does not invent a parent task',()=>{
  const actors=[sub('x','y'),sub('y','x'),sub('unknown','missing')];
  const orders={taskOrder:['missing'],catalogOrder:['x','y','unknown']};
  assert.deepEqual(ids(orderedDesktopPets(actors,orders)),['subagent-x','subagent-y','subagent-unknown']);
  assert.equal(selectDesktopPets(actors,orders,5,0).length,3);
});

function overlap(a,b){return a.x<b.x+b.width&&a.x+a.width>b.x&&a.y<b.y+b.height&&a.y+a.height>b.y;}
function assertPacked(area,bounds){
  for(const item of bounds){
    assert(item.x>=area.x&&item.y>=area.y);
    assert(item.x+item.width<=area.x+area.width);
    assert(item.y+item.height<=area.y+area.height);
    assert(item.scale>0&&item.scale<=1);
    assert.equal(item.overflow,false);
  }
  for(let i=0;i<bounds.length;i++)for(let j=i+1;j<bounds.length;j++)assert.equal(overlap(bounds[i],bounds[j]),false,`windows ${i} and ${j} overlap`);
}

test('default packing uses actual middle/small widths and variable row heights',()=>{
  const original=mainWidth(462),layouts=['main','task','subagent','task','subagent','subagent'].map(kind=>petLayout(kind,original));
  const area={x:0,y:0,width:1920,height:1080};
  const bounds=packPetLayouts({area,layouts});
  assertPacked(area,bounds);
  assert.equal(bounds[0].scale,1);
  assert.equal(bounds[1].width,339);
  assert(bounds[1].x+bounds[1].width<bounds[0].x,'middle pet has its full width plus spacing');
});

test('narrow and negative-origin work areas fit all visible pets with a common scale',()=>{
  const layouts=['main','task','subagent','task','subagent','subagent'].map(kind=>petLayout(kind,mainWidth(462)));
  for(const area of [{x:-1366,y:-100,width:1366,height:768},{x:40,y:30,width:320,height:220}]){
    const bounds=packPetLayouts({area,layouts});
    assertPacked(area,bounds);
    assert(bounds.every(item=>item.scale===bounds[0].scale));
    if(area.width===320)assert(bounds[0].scale<1);
  }
});

test('saved positions are clamped to the current screen while valid saved placement is retained',()=>{
  const area={x:-1000,y:40,width:1000,height:800},layouts=['main','task','subagent'].map(kind=>petLayout(kind,mainWidth(462)));
  const normal=petPlacement({area,layout:layouts[1],index:1,layouts});
  const clamped=petPlacement({area,layout:layouts[1],index:1,layouts,saved:{x:9999,y:-9999}});
  assert.equal(clamped.width,339);
  assert.equal(clamped.x,area.x+area.width-clamped.width);
  assert.equal(clamped.y,area.y);
  const retained=petPlacement({area,layout:layouts[1],index:1,layouts,saved:{x:-600,y:200}});
  assert.equal(retained.x,-600);assert.equal(retained.y,200);
  assert.deepEqual(petPlacement({area,layout:layouts[1],index:1,layouts,saved:{x:NaN,y:0}}),normal);
});

test('an impossible one-pixel screen reports overflow instead of a zero scale or invalid bounds',()=>{
  const bounds=packPetLayouts({area:{x:0,y:0,width:1,height:1},layouts:[petLayout('main'),petLayout('task')],edge:0});
  assert(bounds.every(item=>item.scale>0&&item.width===1&&item.height===1&&item.x===0&&item.y===0&&item.overflow));
  assert.deepEqual(packPetLayouts({area:{x:0,y:0,width:1,height:1},layouts:[]}),[]);
});
