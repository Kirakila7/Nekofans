'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {createYuiHomeStorage}=require('../../apps/neko-workbench/yui-home-storage.cjs');
const {createYuiHomeSession}=require('../../apps/neko-workbench/yui-home-session.cjs');
let JSDOM;try{({JSDOM}=require(path.join(process.env.NEKO_DOM_DEPS||'/private/tmp/neko-sidebar-dom-20261026','node_modules/jsdom')));}catch{}
const src=fs.readFileSync(path.resolve(__dirname,'../../apps/neko-workbench/embedded-dsh/yui-home-ui-source.js'),'utf8');
const textures=fs.readFileSync(path.resolve(__dirname,'../../apps/neko-workbench/embedded-dsh/yui-home-textures-source.js'),'utf8');
const tick=()=>new Promise(r=>setTimeout(r,5));
function canvasContext(calls=[]){return {setTransform(){},clearRect(){},beginPath(){},moveTo(){},lineTo(){},closePath(){},fill(){},stroke(){},save(){},restore(){},transform(...args){calls.push(['transform',...args]);},drawImage(...args){calls.push(['image',...args]);}};}
async function mount(t, backend, options={}){
 const dom=new JSDOM('<div id="stage"></div>',{runScripts:'outside-only',pretendToBeVisual:true});t.after(()=>dom.window.close());const w=dom.window;
 if(options.Image)w.Image=options.Image;
 w.HTMLCanvasElement.prototype.getContext=()=>canvasContext(options.calls);w.HTMLElement.prototype.getBoundingClientRect=()=>({left:0,top:0,width:400,height:300,right:400,bottom:300});
 w.eval(textures+'\n'+src+'\nwindow.mountHome=mountYuiHome');let count=0;const bridge={home:request=>['textures','textures-retry'].includes(request.action) && options.getTextures ? options.getTextures(request.action) : backend.command(request),subscribeHome:fn=>{count++;const un=backend.subscribe(fn);return ()=>{count--;un();};}};
 const stage=w.document.querySelector('#stage'),release=await w.mountHome(stage,{window:w,bridge,avatar:()=>'/avatar.png'});return {w,stage,release,count:()=>count};
}
test('local home places, removes and reloads blocks while reporting save status',{skip:!JSDOM},async t=>{
 const initial=createYuiHomeSession().state();let saved=JSON.stringify({version:1,blocks:[],camera:initial.camera,perspective:initial.perspective,avatar:initial.avatar});const store={load:async()=>saved,save:async text=>{saved=text;}};const backend=await createYuiHomeStorage({store});const f=await mount(t,backend);const canvas=f.stage.querySelector('canvas'),select=f.stage.querySelector('select'),status=f.stage.querySelector('[role=status]');
 assert.match(status.textContent,/已保存到工作台本地/);assert.equal(f.stage.querySelector('.neko-home__avatar'),null);select.value='cherry_planks';canvas.dispatchEvent(new f.w.KeyboardEvent('keydown',{key:'Enter',bubbles:true}));await tick();assert.equal(backend.state().blocks[0].material,'cherry_planks');
 // Click the visible top face and add a second block to the same column.
 canvas.dispatchEvent(new f.w.MouseEvent('click',{bubbles:true,clientX:200,clientY:133}));await tick();assert.deepEqual(backend.state().blocks.map(b=>[b.x,b.y,b.z]),[[0,0,0],[0,1,0]]);assert.equal(JSON.parse(saved).blocks.length,2);
 f.release();assert.equal(f.count(),0);const restored=await createYuiHomeStorage({store});const f2=await mount(t,restored);assert.deepEqual(restored.state().blocks.map(b=>b.y),[0,1]);f2.stage.querySelector('canvas').dispatchEvent(new f2.w.KeyboardEvent('keydown',{key:'Delete',bubbles:true}));await tick();assert.deepEqual(restored.state().blocks.map(b=>b.y),[0]);assert.deepEqual(JSON.parse(saved).blocks.map(b=>b.y),[0]);f2.release();
});
test('corrupt store cannot be edited and displays its persistence error',{skip:!JSDOM},async t=>{
 let writes=0;const backend=await createYuiHomeStorage({store:{load:async()=>'{broken',save:async()=>{writes++;}}});const f=await mount(t,backend);assert.match(f.stage.querySelector('[role=status]').textContent,/读取失败/);assert(f.stage.querySelector('select').disabled);assert(f.stage.querySelector('.neko-home__retry-save').hidden);f.stage.querySelector('canvas').dispatchEvent(new f.w.KeyboardEvent('keydown',{key:'Enter',bubbles:true}));await tick();assert.equal(writes,0);f.release();
});
test('retrying failed initial save does not alter house and prevents duplicate requests',{skip:!JSDOM},async t=>{
 let calls=0,finish;const backend=await createYuiHomeStorage({store:{load:async()=>null,save:async()=>{calls++;if(calls===1)throw Error('disk');await new Promise(resolve=>{finish=resolve;});}}});const before=JSON.stringify(backend.state().blocks);const f=await mount(t,backend),retry=f.stage.querySelector('.neko-home__retry-save');
 assert(!retry.hidden);assert.equal(retry.textContent,'重试保存');retry.click();await tick();assert.equal(calls,2);assert(retry.disabled);assert.equal(retry.textContent,'正在保存…');retry.click();assert.equal(calls,2);finish();await tick();assert(retry.hidden);assert.match(f.stage.querySelector('[role=status]').textContent,/已保存到工作台本地/);assert.equal(JSON.stringify(backend.state().blocks),before);f.release();
});
test('save failures report unsaved state and cleanup subscriptions',{skip:!JSDOM},async t=>{
 const backend=await createYuiHomeStorage({store:{load:async()=>null,save:async()=>{throw Error('disk');}}});const f=await mount(t,backend);f.stage.querySelector('canvas').dispatchEvent(new f.w.KeyboardEvent('keydown',{key:'Enter',bubbles:true}));await tick();assert.match(f.stage.querySelector('[role=status]').textContent,/尚未保存/);f.release();assert.equal(f.count(),0);assert(!f.stage.querySelector('.neko-home'));
});
test('local texture faces decode once per distinct PNG and render without changing saved blocks',{skip:!JSDOM},async t=>{
 let decodes=0,writes=0;const calls=[],url='data:image/png;base64,AAAA';
 class ImageFixture {constructor(){decodes++;this.naturalWidth=16;this.naturalHeight=16;}set src(value){this.value=value;queueMicrotask(()=>this.onload());}}
 const backend=await createYuiHomeStorage({store:{load:async()=>null,save:async()=>{writes++;}}});const before=JSON.stringify(backend.state().blocks),initialWrites=writes;
 const f=await mount(t,backend,{Image:ImageFixture,calls,getTextures:async()=>({status:'partial',source:'minecraft-local',materials:{oak_planks:{top:url,side:url},glass:{top:url,side:url}}})});await tick();
 assert.match(f.stage.querySelector('.neko-home__texture-status').textContent,/本机 Minecraft 材质（与原家园尚未比对）/);
 assert.match(f.stage.querySelector('.neko-home__texture-status').textContent,/部分方块使用基础材质/);
 assert.equal(decodes,1);assert(calls.some(row=>row[0]==='image'));assert(calls.some(row=>row[0]==='transform'));
 assert.equal(writes,initialWrites);assert.equal(JSON.stringify(backend.state().blocks),before);f.release();
});
test('missing or failed local texture access leaves home usable and reports basic materials',{skip:!JSDOM},async t=>{
 const backend=await createYuiHomeStorage({store:{load:async()=>null,save:async()=>{}}});
 const f=await mount(t,backend,{getTextures:async()=>{throw Error('not installed');}});await tick();
 assert.match(f.stage.querySelector('.neko-home__texture-status').textContent,/本机材质暂不可用/);
 const count=backend.state().blocks.length;f.stage.querySelector('canvas').dispatchEvent(new f.w.KeyboardEvent('keydown',{key:'Enter',bubbles:true}));await tick();assert.equal(backend.state().blocks.length,count+1);f.release();
});
test('valid original Yui source is distinguished from the local Minecraft pack',{skip:!JSDOM},async t=>{
 const url='data:image/png;base64,AAAA';class ImageFixture {constructor(){this.naturalWidth=16;this.naturalHeight=16;}set src(value){queueMicrotask(()=>this.onload());}}
 const backend=await createYuiHomeStorage({store:{load:async()=>null,save:async()=>{}}});
 const f=await mount(t,backend,{Image:ImageFixture,getTextures:async()=>({status:'partial',source:'yui-original',materials:{oak_planks:{top:url,side:url}}})});await tick();
 assert.match(f.stage.querySelector('.neko-home__texture-status').textContent,/原 Yui 家园材质/);f.release();
});
test('retry textures reloads original material without blocking editing or duplicate requests',{skip:!JSDOM},async t=>{
 const url='data:image/png;base64,AAAA';class ImageFixture {constructor(){this.naturalWidth=16;this.naturalHeight=16;}set src(value){queueMicrotask(()=>this.onload?.());}}
 const backend=await createYuiHomeStorage({store:{load:async()=>null,save:async()=>{}}});let resolveRetry,retries=0;
 const f=await mount(t,backend,{Image:ImageFixture,getTextures:action=>action==='textures'?Promise.resolve({status:'partial',source:'minecraft-local',materials:{oak_planks:{top:url,side:url}}}):(retries++,new Promise(resolve=>{resolveRetry=resolve;}))});await tick();
 const button=f.stage.querySelector('.neko-home__retry-textures');assert(!button.hidden);button.click();button.click();await tick();assert.equal(retries,1);assert(button.disabled);assert.match(f.stage.querySelector('.neko-home__texture-status').textContent,/正在重新检测/);
 const before=backend.state().blocks.length;f.stage.querySelector('canvas').dispatchEvent(new f.w.KeyboardEvent('keydown',{key:'Enter',bubbles:true}));await tick();assert.equal(backend.state().blocks.length,before+1);
 const materials=Object.fromEntries(backend.state().materials.map(key=>[key,{top:url,side:url}]));resolveRetry({status:'available',source:'yui-original',materials});await tick();assert(button.hidden);assert.match(f.stage.querySelector('.neko-home__texture-status').textContent,/原 Yui 家园材质/);f.release();
});
test('failed retry preserves existing materials and lets the user try again',{skip:!JSDOM},async t=>{
 const url='data:image/png;base64,AAAA';class ImageFixture {constructor(){this.naturalWidth=16;this.naturalHeight=16;}set src(value){queueMicrotask(()=>this.onload?.());}}
 const backend=await createYuiHomeStorage({store:{load:async()=>null,save:async()=>{}}});
 const f=await mount(t,backend,{Image:ImageFixture,getTextures:async action=>{if(action==='textures-retry')throw Error('offline');return {status:'partial',source:'minecraft-local',materials:{oak_planks:{top:url,side:url}}};}});await tick();const button=f.stage.querySelector('.neko-home__retry-textures');button.click();await tick();assert(!button.hidden);assert(!button.disabled);assert.match(f.stage.querySelector('.neko-home__texture-status').textContent,/检测失败 · 保留当前材质/);f.release();
});
test('PNG faces map to the three isometric planes and an animated strip uses the first frame',{skip:!JSDOM},t=>{
 const dom=new JSDOM('',{runScripts:'outside-only'});t.after(()=>dom.window.close());const w=dom.window;w.eval(textures+'\nwindow.drawBlock=drawYuiHomeBlock');
 const calls=[],ctx=canvasContext(calls),image={naturalWidth:16,naturalHeight:32};
 w.drawBlock(ctx,[[0,0],[20,10],[0,20],[-20,10]],[[0,18],[20,28],[0,38],[-20,28]],'oak_planks',{top:image,side:image});
 assert.equal(calls.filter(row=>row[0]==='image').length,3);assert.deepEqual(calls.filter(row=>row[0]==='transform').at(-1),['transform',1.25,.625,-1.25,.625,0,0]);
 assert.deepEqual(calls.filter(row=>row[0]==='image').at(-1).slice(2),[0,0,16,16,0,0,16,16]);
});
test('camera rotation and zoom preserve the world and rotated surface clicks place in the same column',{skip:!JSDOM},async t=>{
 const init=createYuiHomeSession().state(),doc=JSON.stringify({version:1,blocks:[],camera:init.camera,perspective:init.perspective,avatar:init.avatar});let saved=doc;
 const backend=await createYuiHomeStorage({store:{load:async()=>saved,save:async v=>{saved=v}}});const f=await mount(t,backend),canvas=f.stage.querySelector('canvas');
 const btn=label=>f.stage.querySelector(`[aria-label="${label}"]`);
 assert.equal(f.stage.querySelector('.neko-home__view-value').textContent,'100%');
 canvas.dispatchEvent(new f.w.KeyboardEvent('keydown',{key:'Enter',bubbles:true}));await tick();
 for(let i=1;i<=16;i++){btn('向右旋转视角').click();const a=i*Math.PI/8,span=Math.abs(Math.cos(a))+Math.abs(Math.sin(a)),n=backend.state().blocks.length;const unit=Math.min(400*.91/(9*span),300*.88/(9*span*.27+n*.82));const y=150-(n*.82*unit)/2;canvas.dispatchEvent(new f.w.MouseEvent('click',{bubbles:true,clientX:200,clientY:y}));await tick();assert.equal(backend.state().blocks.length,i+1);assert(backend.state().blocks.every(b=>b.x===0&&b.z===0));}
 const count=backend.state().blocks.length;
 function pointer(type,x,y){const e=new f.w.MouseEvent(type,{bubbles:true,clientX:x,clientY:y,button:0});Object.defineProperty(e,'pointerId',{value:1});canvas.dispatchEvent(e);}
 pointer('pointerdown',120,120);pointer('pointermove',170,120);pointer('pointerup',170,120);canvas.dispatchEvent(new f.w.MouseEvent('click',{bubbles:true,clientX:170,clientY:120}));await tick();assert.equal(backend.state().blocks.length,count,'drag must not place a block');
 btn('放大视角').click();assert.equal(f.stage.querySelector('.neko-home__view-value').textContent,'120%');btn('重置正面视角').click();assert.equal(f.stage.querySelector('.neko-home__view-value').textContent,'100%');
 const browserZoom=new f.w.WheelEvent('wheel',{deltaY:-10,ctrlKey:true,cancelable:true,bubbles:true});canvas.dispatchEvent(browserZoom);assert.equal(browserZoom.defaultPrevented,false);assert.equal(backend.state().blocks.length,count);f.release();
});
