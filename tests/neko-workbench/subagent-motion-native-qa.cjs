'use strict';
// Opt-in: run with Electron. Production main/preload/renderer and native windows;
// External DSH uses a protocol fixture; keychain availability fails closed. No model calls.
const {app,BrowserWindow,screen,Menu}=require('electron');
app.disableHardwareAcceleration();
// Motion QA neither reads a user keychain nor requires credentials.
require('../../apps/neko-workbench/main-chat-secret.cjs').WorkbenchSecretStore.prototype.available=()=>false;
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
const Module=require('node:module'),{EventEmitter}=require('node:events'),{PassThrough}=require('node:stream');
const root=path.resolve(__dirname,'../..'),qa=fs.mkdtempSync(path.join(os.tmpdir(),'neko-swarm-native-'));
const evidence=process.env.NEKO_MOTION_EVIDENCE||fs.mkdtempSync(path.join(os.tmpdir(),'neko-swarm-evidence-'));fs.mkdirSync(evidence,{recursive:true});
app.once('quit',()=>fs.rmSync(qa,{recursive:true,force:true}));
const data=path.join(qa,'data'),modules=path.join(qa,'modules'),cli=path.join(qa,'dsh');fs.mkdirSync(data);
fs.writeFileSync(cli,'native QA protocol fixture');
for(const name of ['dsh-llm','dsh-scope']){fs.mkdirSync(path.join(modules,name,'lib'),{recursive:true});fs.writeFileSync(path.join(modules,name,'lib/index.js'),'');}
Object.assign(process.env,{NEKO_WORKBENCH_DATA_DIR:data,NEKO_WORKBENCH_WORKSPACE:path.join(qa,'work'),NEKO_WORKBENCH_ELECTRON_USER_DATA:path.join(qa,'electron'),
  NEKO_WORKBENCH_DSH_CLI:cli,NEKO_WORKBENCH_DSH_MODULES:modules,PET_OPEN_WORKBENCH:'0',PET_WORKBENCH_ONLY:'0'});
const identities=[['whale','dsh-original'],['claude','claude-pixel'],['gemini','gemini-pixel'],['cat','neko-cat'],['classic','claude-girl']];
fs.writeFileSync(path.join(data,'state.json'),JSON.stringify({preferences:{helpersVisible:true,helperLimit:8,subagentExploration:false},
  actors:[{id:'main',name:'喷泉QA·主肥鱼',chatBackend:'chat-api',present:true,messages:[]},...identities.map(([id,appearanceId])=>({id:'subagent-'+id,sessionId:id,name:'喷泉QA·'+id,appearanceId,pinned:id==='cat',messages:[]}))]}));
const report={mode:'production native windows + DSH protocol fixture; keychain unavailable; no provider requests',phases:{},positions:{},foregroundCalls:0,assertions:[]};
let child,motion,menu,reduced=false;
const originalLoad=Module._load,realChild=require('node:child_process'),realMotion=require('../../apps/neko-workbench/subagent-motion.cjs');
const emit=(method,params)=>child.stdout.write(JSON.stringify({method,params})+'\n');
function fakeSpawn(){
  child=new EventEmitter();Object.assign(child,{pid:2147483647,killed:false,stdout:new PassThrough(),stderr:new PassThrough(),
    kill(){child.killed=true;child.emit('close',0);}});
  child.stdin=new EventEmitter();
  child.stdin.write=function(line){const request=JSON.parse(line);setImmediate(()=>child.stdout.write(JSON.stringify({id:request.id,
    result:request.method==='init'?{sessionId:'qa-root',uiUrl:'http://127.0.0.1:1/'}:{accepted:true}})+'\n'));};
  child.stdin.end=()=>child.emit('close',0);
  setImmediate(()=>emit('ready',{}));return child;
}
Module._load=function(name,parent,...rest){
  if(name==='node:child_process')return {...realChild,spawn:(command,...args)=>command===cli?fakeSpawn():realChild.spawn(command,...args)};
  if(name==='./subagent-motion.cjs')return {createSubagentMotion:options=>motion=realMotion.createSubagentMotion({...options,
    getCursor:()=>null,reducedMotion:()=>reduced,onPose(id,value){options.onPose(id,value);if(value){report.phases[id]||=[];if(!report.phases[id].includes(value.phase))report.phases[id].push(value.phase);}}})};
  return originalLoad.call(this,name,parent,...rest);
};
const originalAbove=BrowserWindow.prototype.moveAbove;
BrowserWindow.prototype.moveAbove=function(...args){const value=originalAbove.apply(this,args);report.foregroundCalls++;return value;};
Menu.prototype.popup=function(){menu=this;};
process.on('uncaughtException',error=>{console.error('Native QA uncaught:',error.stack);app.exit(1);});
console.log('Native QA: load production main');
require(path.join(root,'apps/neko-workbench/main.cjs'));
console.log('Native QA: production main loaded');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function wait(check,ms=6000){const until=Date.now()+ms;while(Date.now()<until){if(await check())return;await sleep(40);}throw Error('Native QA condition timed out');}
const pets=()=>BrowserWindow.getAllWindows().filter(w=>w.webContents.getURL().includes('view=pet'));
const actorId=w=>new URL(w.webContents.getURL()).searchParams.get('actor');
const call=(w,method,value={})=>w.webContents.executeJavaScript(`window.pet.call(${JSON.stringify(method)},${JSON.stringify(value)})`);
const visual=w=>w.webContents.executeJavaScript('(()=>{const c=document.querySelector(".character"),r=c.getBoundingClientRect();return {phase:document.querySelector(".pet").dataset.agentMotion,centreOffset:r.x+r.width/2-innerWidth/2,height:r.height,transform:getComputedStyle(c).transform};})()');
app.whenReady().then(async()=>{
  try{
    console.log('Native QA: Electron ready');
    await wait(()=>child&&pets().some(w=>actorId(w)==='main'),15000);
    const main=pets().find(w=>actorId(w)==='main');await wait(()=>!main.webContents.isLoading());
    const area=screen.getPrimaryDisplay().workArea;
    main.setPosition(Math.round(area.x+area.width*.52),Math.round(area.y+area.height*.54));
    emit('agent-roster',{source:'dsh-subagent-catalog',sessionIds:identities.map(x=>x[0])});
    for(const [id] of identities)emit('agent-meta',{source:'dsh-subagent-catalog',sessionId:id,parentSessionId:'qa-root',name:'喷泉QA·'+id,mode:'continuable',running:true});
    emit('task-meta',{source:'dsh-task-session',sessionId:'medium-task',running:true,backgroundJobs:1,title:'喷泉QA·中号任务'});
    emit('task-roster',{source:'dsh-task-session',sessionIds:['medium-task']});
    await wait(()=>pets().length===7&&motion.snapshot().length===6);
    const track=setInterval(()=>{for(const w of pets()){const id=actorId(w);if(id==='main')continue;report.positions[id]||=[];report.positions[id].push({...w.getBounds(),at:Date.now()});}},40);
    try{
      await wait(()=>Object.values(report.phases).some(p=>p.includes('spawning')));
      await sleep(430);
      report.birthVisuals=[];
      for(const w of pets())if(actorId(w)!=='main'&&!w.webContents.isLoading()){
        const frame=await visual(w);assert(Math.abs(frame.centreOffset)<Math.max(12,frame.height*.06),'birth keeps the character centred');
        report.birthVisuals.push({id:actorId(w),...frame});
        fs.writeFileSync(path.join(evidence,actorId(w)+'-birth.png'),(await w.webContents.capturePage()).toPNG());
      }
      await wait(()=>motion.snapshot().every(r=>!r.spawning&&r.phase==='clustered'),8000);
      report.assertions.push('all six task/subagent windows launch and settle');
    }finally{clearInterval(track);}
    assert(report.foregroundCalls>0);report.assertions.push('native foreground ordering called');
    for(const [id,points] of Object.entries(report.positions)){
      assert(points.some(p=>p.x!==points[0].x||p.y!==points[0].y),id+' moved');
      for(const p of points){const a=screen.getDisplayMatching(p).workArea;assert(p.x>=a.x&&p.y>=a.y&&p.x+p.width<=a.x+a.width&&p.y+p.height<=a.y+a.height);}
    }
    const count=Object.values(report.phases).filter(p=>p.includes('spawning')).length;assert.equal(count,6);
    await call(main,'menu');const settings=menu.items.find(i=>i.label==='设置').submenu;
    for(const label of ['任务与子代理喷泉出场','DBSCAN 邻近聚类与避让'])assert(settings.items.some(i=>i.label===label&&i.checked));
    const original=pets().find(w=>actorId(w)==='subagent-whale');
    await call(original,'motion-input',{active:true});const before=original.getBounds();await sleep(180);assert.deepEqual(original.getBounds(),before);
    await call(original,'move',{dx:-130,dy:-90});await call(original,'move-end');await call(original,'motion-input',{active:false});
    const dragged=original.getBounds();await sleep(450);assert.deepEqual(original.getBounds(),dragged);report.assertions.push('input and drag pause native motion');
    await sleep(3200);await wait(()=>motion.snapshot().find(r=>r.id==='subagent-whale')?.phase==='clustered');
    report.settled=[];
    for(const w of pets()){
      const id=actorId(w);const file=id+'-settled.png';fs.writeFileSync(path.join(evidence,file),(await w.webContents.capturePage()).toPNG());
      report.settled.push({id,bounds:w.getBounds(),file,dom:await w.webContents.executeJavaScript('({phase:document.querySelector(".pet").dataset.agentMotion,appearance:document.querySelector(".pet").dataset.appearance,opacity:getComputedStyle(document.querySelector(".character")).opacity})')});
    }
    for(const [id] of identities)emit('subagent-activity',{sessionId:id,local:false,phase:'end',stopReason:'completed'});
    emit('task-meta',{source:'dsh-task-session',sessionId:'medium-task',running:false,backgroundJobs:0,outcome:'completed',title:'喷泉QA·中号任务'});
    await wait(async()=>{const s=await call(main,'state');return s.actors.filter(a=>a.id!=='main').every(a=>!a.returningHome);},8000);
    const state=await call(main,'state'),pinned=state.actors.find(a=>a.sessionId==='cat');assert(pinned.present&&!pinned.active);
    assert(state.actors.filter(a=>a.id!=='main'&&a.sessionId!=='cat').every(a=>!a.present));report.assertions.push('completion gathers before hiding; pinned cat remains');
    const cat=pets().find(w=>actorId(w)==='subagent-cat');assert.equal(await cat.webContents.executeJavaScript('document.querySelector(".pet-cat-motion").dataset.home'),'false');
    reduced=true;emit('agent-roster',{source:'dsh-subagent-catalog',sessionIds:[...identities.map(x=>x[0]),'reduced']});
    emit('agent-meta',{source:'dsh-subagent-catalog',sessionId:'reduced',parentSessionId:'qa-root',name:'喷泉QA·减少动态',mode:'continuable',running:true});
    await wait(()=>motion.snapshot().some(r=>r.id==='subagent-reduced'));assert(!report.phases['subagent-reduced']?.includes('spawning'));
    let still;await wait(()=>{still=pets().find(w=>actorId(w)==='subagent-reduced');return still&&!still.webContents.isLoading()&&still.isVisible();});
    still.webContents.debugger.attach('1.3');
    try{
      await still.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
      const frame=await visual(still);assert(Math.abs(frame.centreOffset)<1,'reduced-motion CSS preserves centring');report.reducedVisual=frame;
    }finally{still.webContents.debugger.detach();}
    report.assertions.push('reduced-motion path does not launch; reduced-motion CSS stays centred');
    report.status='passed';
  }catch(error){report.status='failed';report.error=error.message;report.bootWindows=BrowserWindow.getAllWindows().map(w=>({title:w.getTitle(),url:w.webContents.getURL(),loading:w.webContents.isLoading()}));report.childStarted=!!child;report.motion=motion?.snapshot();console.error(error.stack);}
  finally{
    fs.writeFileSync(path.join(evidence,'native-motion-qa.json'),JSON.stringify(report,null,2));
    console.log(JSON.stringify({status:report.status,error:report.error,evidence,assertions:report.assertions}));
    Module._load=originalLoad;BrowserWindow.prototype.moveAbove=originalAbove;
    setTimeout(()=>app.exit(report.status==='passed'?0:1),200);
    app.quit();
  }
});
setTimeout(()=>app.exit(2),45000).unref();
