'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const base=path.resolve(__dirname,'../../apps/neko-workbench'),motion=fs.readFileSync(path.join(base,'embedded-dsh/home-pet-motion-source.js'),'utf8');
const {createYuiHomeSession}=require('../../apps/neko-workbench/yui-home-session.cjs');
function helpers(){const context={};vm.createContext(context);vm.runInContext(motion,context);return context;}
test('idle room randomly walks and pauses for direct interaction, first person, hidden state and disposal',async()=>{
 const h=helpers(),world=createYuiHomeSession();world.command({action:'return-home'});let time=0,busy=false;const moved=[],activities=[];
 const p=h.createHomePetMotion({getState:world.state,move:async cmd=>{moved.push(cmd);world.command(cmd);},onActivity:a=>activities.push(a),random:()=>.3,now:()=>time,blocked:()=>busy});
 time=4000;await p.tick();assert.equal(moved.length,1);assert(activities.includes('move'));assert(world.state().avatar.position.z<2.5);
 p.pause();time+=5000;await p.tick();assert.equal(moved.length,1);time+=20000;busy=true;await p.tick();assert.equal(moved.length,1);busy=false;
 world.command({action:'perspective',mode:'agent'});time+=30000;await p.tick();assert.equal(moved.length,1);world.command({action:'perspective',mode:'orbit'});
 p.setEnabled(false);time+=30000;await p.tick();assert.equal(moved.length,1);p.setEnabled(true);time+=2000;await p.tick();assert.equal(moved.length,2);p.dispose();time+=30000;await p.tick();assert.equal(moved.length,2);
});
test('stationary idle can trigger a material action, and movement never crosses furniture or the floor edge',async()=>{
 const h=helpers(),world=createYuiHomeSession();world.command({action:'return-home'});let time=5000;const actions=[];
 const p=h.createHomePetMotion({getState:world.state,move:()=>{throw Error('must stay still');},onActivity:a=>actions.push(a),random:()=>.6,now:()=>time});time+=4000;await p.tick();assert.deepEqual(actions,['action']);
 const items=[{kind:'wall',x:0,z:0,y:0,width:5,depth:.1,rotation:45}];assert.equal(h.homePetPathClear(items,{x:-2,z:-2},{x:2,z:2}),false);assert.equal(h.homePetClear([],4.2,0),false);assert.equal(h.homePetPathClear([{kind:'rug',x:0,z:0,y:0,width:5,depth:5,rotation:0}],{x:-1,z:0},{x:1,z:0}),true);
});
test('dropped position is saved, bounded and cannot overlap rotated furniture',()=>{
 const world=createYuiHomeSession();world.command({action:'furnish',items:[{id:'desk',kind:'desk',x:0,z:0,rotation:45}]});
 assert.throws(()=>world.command({action:'avatar_place',x:0,z:0}),/家具/);assert.throws(()=>world.command({action:'avatar_place',x:4.2,z:0}),/地板/);
 world.command({action:'avatar_place',x:2,z:2});assert.deepEqual(world.state().avatar.position,{x:2,y:0,z:2});assert(world.state().avatar.atHome);
});
test('only existing original material names can load; paths and missing actions fail closed',async()=>{
 const {createHomePetAssets}=require('../../apps/neko-workbench/home-pet-assets.cjs'),assets=createHomePetAssets(),manifest=await assets.manifest();
 assert(manifest.clicks.length>0);assert(manifest.moves.length>0);assert(manifest.actions.includes('超大伸懒腰'));
 const clip=await assets.load(manifest.clicks[0]);assert(clip.src.startsWith('data:video/webm;base64,'));await assert.rejects(assets.load('../idle'));await assert.rejects(assets.load('https://example.test/video'));await assert.rejects(assets.load('not-a-clip'));
});
const {JSDOM}=require(path.join(process.env.NEKO_DOM_DEPS,'node_modules/jsdom'));
test('room model click plays original reaction, drag saves placement and teardown stops video',async t=>{
 const dom=new JSDOM('<div id="stage"></div>',{runScripts:'outside-only',pretendToBeVisual:true});const w=dom.window;t.after(()=>w.close());
 const draws=[],plays=[],calls=[];w.Image=class{constructor(){this.complete=true;this.naturalWidth=640;}};
 w.HTMLMediaElement.prototype.play=function(){plays.push(this.src);return Promise.resolve();};w.HTMLMediaElement.prototype.pause=function(){plays.push('paused');};
 w.HTMLCanvasElement.prototype.getContext=()=>({setTransform(){},clearRect(){},beginPath(){},moveTo(){},lineTo(){},closePath(){},fill(){},stroke(){},arc(){},drawImage:(...a)=>draws.push(a)});
 w.HTMLElement.prototype.getBoundingClientRect=()=>({left:0,top:0,width:800,height:560});w.eval(motion);w.eval(fs.readFileSync(path.join(base,'embedded-dsh/our-home-ui-source.js'),'utf8'));
 const world=createYuiHomeSession();world.command({action:'return-home'});
 const bridge={subscribeHome:world.subscribe,home:async r=>{calls.push(r);if(r.action==='pet-animations')return {ok:true,animations:{idle:['idle'],drag:['drag'],clicks:['click'],moves:['walk'],actions:['stretch']}};if(r.action==='pet-animation')return {ok:true,animation:{src:'data:video/webm;base64,'+r.name}};return world.command(r);}};
 const release=await w.mountOurHome(w.document.querySelector('#stage'),{bridge,window:w});await new Promise(r=>setImmediate(r));const canvas=w.document.querySelector('canvas');
 function point(){const d=draws.at(-1);return {clientX:d[1]+d[3]/2,clientY:d[2]+d[4]/2};}
 function pointer(type,p){const e=new w.MouseEvent(type,{button:0,bubbles:true,...p});Object.defineProperty(e,'pointerId',{value:1});canvas.dispatchEvent(e);}
 let p=point();pointer('pointerdown',p);pointer('pointerup',p);await new Promise(r=>setImmediate(r));assert(calls.some(r=>r.action==='pet-animation'&&r.name==='click'));
 p=point();pointer('pointerdown',p);pointer('pointermove',{clientX:p.clientX+30,clientY:p.clientY+10});pointer('pointerup',p);await new Promise(r=>setImmediate(r));assert(calls.some(r=>r.action==='avatar_place'));assert(calls.some(r=>r.action==='pet-animation'&&r.name==='drag'));
 Object.defineProperty(w.document,'hidden',{configurable:true,value:true});w.document.dispatchEvent(new w.Event('visibilitychange'));assert(plays.includes('paused'),'hidden room pauses the material decoder');
 release();assert(plays.includes('paused'));assert.equal(w.document.querySelector('.neko-our-home'),null);
});
