'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),{EventEmitter}=require('node:events');
const {createNativeComposerController}=require('../../apps/neko-workbench/native-composer-controller.cjs');
class Contents extends EventEmitter{constructor(){super();this.mainFrame={};this.sent=[];}isDestroyed(){return false;}getZoomFactor(){return 1.25;}setWindowOpenHandler(){}loadFile(){return Promise.resolve();}send(...args){this.sent.push(args);}}
class Desktop extends EventEmitter{constructor(options){super();this.options=options;this.webContents=new Contents();this.rect={x:0,y:0,width:480,height:120};this.visible=false;this.shapes=[];this.shows=0;this.raises=0;Desktop.latest=this;}isDestroyed(){return !!this.destroyed;}destroy(){this.destroyed=true;}isVisible(){return this.visible;}hide(){this.visible=false;}showInactive(){this.visible=true;this.shows++;}moveTop(){this.raises++;}setShape(regions){this.shape=regions.map(r=>({...r}));this.shapes.push(this.shape);}setMenu(){}getBounds(){return {...this.rect};}setBounds(rect){this.rect={...rect};this.emit('move');}}
test('desktop work float moves beyond host, survives resize/mode hide with draft and validates sender',async()=>{
 const ipc=new EventEmitter(),host=new EventEmitter();host.webContents=new Contents();host.isDestroyed=()=>false;host.isVisible=()=>true;host.isMinimized=()=>false;host.getContentSize=()=>[1000,800];host.getContentBounds=()=>({x:100,y:100,width:1000,height:800});
 const c=createNativeComposerController({BrowserWindow:Desktop,ipcMain:ipc,screen:{getDisplayMatching:()=>({workArea:{x:0,y:0,width:2560,height:1440}})}});
 const place=()=>c.place(host,{action:'place',rect:{x:500,y:600,width:400,height:120}});place();c.setEnabled(true);await Promise.resolve();const w=Desktop.latest,event={sender:w.webContents,senderFrame:w.webContents.mainFrame};assert.equal(w.options.parent,host);assert.deepEqual(w.rect,{x:725,y:850,width:500,height:150});assert(w.visible);
 c.update({value:'未发送草稿',sessionToken:'s',revision:3,enabled:true,chatOnly:true});ipc.emit('neko-composer-input',event,{type:'move',dx:700,dy:-200});assert(w.rect.x>1100);const moved={...w.rect};place();host.emit('resize');assert.deepEqual(w.rect,moved);
 c.place(host,{action:'remove'});assert(!w.visible);place();assert(w.visible);assert.equal(Desktop.latest,w);assert.equal(w.webContents.sent.at(-1)[1].value,'未发送草稿');assert.equal(w.webContents.sent.at(-1)[1].desktop,true);
 ipc.emit('neko-composer-input',{sender:{},senderFrame:{}},{type:'move',dx:100,dy:0});assert.deepEqual(w.rect,moved);ipc.emit('neko-composer-input',event,{type:'submit',value:'x',sessionToken:'stale',revision:3,submissionId:1});assert.equal(host.webContents.sent.length,0);
 host.emit('minimize');assert(!w.visible);host.emit('restore');assert(w.visible);c.dispose();assert(w.destroyed);
});

async function movingFixture(t,{zoom=1.25,workArea={x:0,y:0,width:2560,height:1440},displayMatching,WindowType=Desktop,platform='win32',menuBeforeLoad}={}){
 const ipc=new EventEmitter(),host=new EventEmitter(),origin={x:100,y:100},hostVisibility={visible:true,minimized:false};let factor=zoom;
 host.webContents=new Contents();host.webContents.getZoomFactor=()=>factor;host.isDestroyed=()=>false;host.isVisible=()=>hostVisibility.visible;host.isMinimized=()=>hostVisibility.minimized;host.getContentSize=()=>[1000,800];host.getContentBounds=()=>({...origin,width:1000,height:800});
 const controller=createNativeComposerController({BrowserWindow:WindowType,ipcMain:ipc,screen:{getDisplayMatching:displayMatching||(()=>({workArea}))},platform});
 const normal={x:500,y:600,width:400,height:120},place=(rect=normal,extra={})=>controller.place(host,{action:'place',rect,...extra});place();if(menuBeforeLoad!==undefined)controller.setAccountMenuRect(menuBeforeLoad);controller.setEnabled(true);await Promise.resolve();
 const child=Desktop.latest,sender={sender:child.webContents,senderFrame:child.webContents.mainFrame};t.after(()=>controller.dispose());
 const input=(message,event=sender)=>ipc.emit('neko-composer-input',event,message);
 return {ipc,host,origin,hostVisibility,controller,child,place,normal,sender,input,drag:(dx,dy,extra={})=>input({type:'move',dx,dy,...extra}),finish:(dx=0,dy=0)=>input({type:'move',dx,dy,finished:true}),move:(dx,dy)=>{origin.x+=dx;origin.y+=dy;host.emit('move');},setZoom:value=>{factor=value;host.webContents.emit('zoom-changed');}};
}
test('creation float follows the owner vector after a free drag without multiplying DIP motion by zoom',async t=>{
 const f=await movingFixture(t);assert.equal(f.child.options.title,'创造台');const initial={...f.child.rect};f.move(120,-75);assert.deepEqual(f.child.rect,{...initial,x:initial.x+120,y:initial.y-75});
 f.drag(200,-80);const dragged={...f.child.rect};f.move(40,60);assert.deepEqual(f.child.rect,{...dragged,x:dragged.x+40,y:dragged.y+60});const final={...f.child.rect};
 for(const event of ['move','resize','show','restore'])f.host.emit(event);assert.deepEqual(f.child.rect,final,'duplicate native notifications never accumulate displacement');assert.equal(f.host.webContents.sent.length,0,'owner moves are not echoed into frontend move events');
 f.setZoom(1.5);assert.equal(f.child.rect.x,final.x);assert.equal(f.child.rect.y,final.y);assert.equal(f.child.rect.width,600);assert.equal(f.child.rect.height,180);f.move(50,-30);assert.equal(f.child.rect.x,final.x+50);assert.equal(f.child.rect.y,final.y-30);
});
test('a child that already followed natively is reconciled once regardless of notification order',async t=>{
 const f=await movingFixture(t);f.drag(160,-100);const before={...f.child.rect};f.origin.x+=100;f.origin.y+=50;
 // Native owned windows can move before their owner's notification arrives.
 f.child.setBounds({...before,x:before.x+100,y:before.y+50});f.host.emit('move');assert.deepEqual(f.child.rect,{...before,x:before.x+100,y:before.y+50});
 const once={...f.child.rect};f.move(35,-20);f.child.emit('move');f.host.emit('move');assert.deepEqual(f.child.rect,{...once,x:once.x+35,y:once.y-20});
});
test('lobby placement has a separate free offset and restoring the ordinary mode retains its prior position',async t=>{
 const f=await movingFixture(t);f.drag(210,-180);const normal={...f.child.rect},lobby={x:12,y:650,width:196,height:120};
 f.place(lobby,{positionKey:'lobby',resetPosition:true});assert.equal(f.child.rect.width,245,'196 CSS pixels remain allowed for the narrow selector');assert.equal(f.child.rect.x,115);assert.equal(f.child.rect.y,913);f.drag(50,-60);const movedLobby={...f.child.rect};f.move(40,20);
 f.place(f.normal,{positionKey:'default'});assert.deepEqual(f.child.rect,{...normal,x:normal.x+40,y:normal.y+20});
 f.place(lobby,{positionKey:'lobby'});assert.deepEqual(f.child.rect,{...movedLobby,x:movedLobby.x+40,y:movedLobby.y+20});
 f.place(lobby,{positionKey:'lobby',resetPosition:true});assert.equal(f.child.rect.x,155);assert.equal(f.child.rect.y,933);f.place(f.normal,{positionKey:'default'});assert.equal(f.child.rect.x,normal.x+40);
 assert.throws(()=>f.place(f.normal,{positionKey:'unbounded-new-key'}));assert.throws(()=>f.place(f.normal,{resetPosition:'yes'}));
});
test('screen edges clamp safely without losing the intended owner-relative placement',async t=>{
 const f=await movingFixture(t);f.drag(100,-200);const free={...f.child.rect};f.move(2000,0);assert.equal(f.child.rect.x,2560-free.width);assert(f.child.rect.y>=0);f.move(-2000,0);assert.deepEqual(f.child.rect,free,'returning from the screen edge restores the free offset');
});

test('drag completion applies its last delta then snaps screen edges once and preserves owner vector following',async t=>{
 const f=await movingFixture(t);const size={width:f.child.rect.width,height:f.child.rect.height};
 f.drag(-700,-830);assert.deepEqual(f.child.rect,{x:25,y:20,...size},'near-edge movement stays continuous before release');
 f.finish(-8,-5);assert.deepEqual(f.child.rect,{x:8,y:8,...size},'release includes the final delta and snaps within 20 native DIPs');
 f.move(5,7);const followed={x:13,y:15,...size};assert.deepEqual(f.child.rect,followed);
 for(const event of ['resize','show','restore'])f.host.emit(event);assert.deepEqual(f.child.rect,followed,'owner events do not re-snap the float back to the screen edge');
 f.setZoom(1.5);assert.equal(f.child.rect.x,13);assert.equal(f.child.rect.y,15);assert.equal(f.child.rect.width,600);assert.equal(f.child.rect.height,180);
 assert.equal(f.host.webContents.sent.length,0,'desktop snapping never feeds a second move back into the renderer');
});

test('completion snaps to owner inner edges but leaves a distant drop untouched',async t=>{
 const f=await movingFixture(t);f.drag(117-f.child.rect.x,750-f.child.rect.y);assert.equal(f.child.rect.x,117);assert.equal(f.child.rect.y,750);
 f.finish();assert.deepEqual(f.child.rect,{x:108,y:742,width:500,height:150});
 f.drag(400-f.child.rect.x,400-f.child.rect.y);const far={...f.child.rect};f.finish();assert.deepEqual(f.child.rect,far);
});

test('snapped default and lobby positions remain independent across mode changes and owner moves',async t=>{
 const f=await movingFixture(t),lobby={x:12,y:650,width:196,height:120};
 f.drag(17-f.child.rect.x,15-f.child.rect.y);f.finish();const normal={...f.child.rect};assert.equal(normal.x,8);assert.equal(normal.y,8);
 f.place(lobby,{positionKey:'lobby',resetPosition:true});f.drag(117-f.child.rect.x,750-f.child.rect.y);f.finish();const compact={...f.child.rect};assert.deepEqual(compact,{x:108,y:742,width:245,height:150});
 f.place(f.normal,{positionKey:'default'});assert.deepEqual(f.child.rect,normal);f.move(40,20);assert.deepEqual(f.child.rect,{...normal,x:48,y:28});
 f.place(lobby,{positionKey:'lobby'});assert.deepEqual(f.child.rect,{...compact,x:148,y:762});
 f.place(f.normal,{positionKey:'default'});assert.deepEqual(f.child.rect,{...normal,x:48,y:28});
});

test('drag completion uses the float display work area on a negative-coordinate screen at non-unit zoom',async t=>{
 const calls=[],left={x:-1920,y:-200,width:1920,height:1080},right={x:0,y:0,width:2560,height:1440};
 const f=await movingFixture(t,{displayMatching:b=>{calls.push({...b});return {workArea:b.x<0?left:right};}});
 f.drag(-1905-f.child.rect.x,-185-f.child.rect.y);assert.deepEqual(f.child.rect,{x:-1905,y:-185,width:500,height:150});f.finish();
 assert.deepEqual(calls.at(-1),{x:-1905,y:-185,width:500,height:150});assert.deepEqual(f.child.rect,{x:-1912,y:-192,width:500,height:150});
 f.move(12,9);assert.deepEqual(f.child.rect,{x:-1900,y:-183,width:500,height:150});
});

test('finished movement validates boolean, final deltas, sender frame and attachment before moving or snapping',async t=>{
 const f=await movingFixture(t);f.drag(17-f.child.rect.x,15-f.child.rect.y);const before={...f.child.rect};
 for(const finished of [undefined,null,0,1,'true',{},[]]){f.input({type:'move',dx:3,dy:4,finished});assert.deepEqual(f.child.rect,before);}
 for(const final of [{dx:Infinity,dy:0},{dx:4001,dy:0},{dx:0},{dy:0}]){f.input({type:'move',finished:true,...final});assert.deepEqual(f.child.rect,before);}
 f.input({type:'move',dx:0,dy:0,finished:true},{sender:{},senderFrame:{}});f.input({type:'move',dx:0,dy:0,finished:true},{sender:f.child.webContents,senderFrame:{}});assert.deepEqual(f.child.rect,before);
 f.controller.place(f.host,{action:'remove'});f.finish();assert.deepEqual(f.child.rect,before);f.place();f.controller.setEnabled(false);f.finish();assert.deepEqual(f.child.rect,before);f.controller.setEnabled(true);
 f.drag(1,1,{finished:false});assert.deepEqual(f.child.rect,{...before,x:18,y:16});f.finish();assert.deepEqual(f.child.rect,{...before,x:8,y:8});
});

test('native movement only snaps after user will-move and moved, never from programmatic macOS aliases',async t=>{
 class AliasDesktop extends Desktop{setBounds(rect){super.setBounds(rect);this.emit('moved');}}
 const f=await movingFixture(t,{WindowType:AliasDesktop});f.place({x:12,y:12,width:400,height:120});assert.deepEqual(f.child.rect,{x:115,y:115,width:500,height:150},'programmatic near-edge placement must not snap');
 f.move(5,5);assert.equal(f.child.rect.x,120);assert.equal(f.child.rect.y,120);f.setZoom(1.5);assert.deepEqual(f.child.rect,{x:123,y:123,width:600,height:180});
 f.child.emit('will-move');f.child.rect={...f.child.rect,x:120,y:120};f.child.emit('move');assert.equal(f.child.rect.x,120,'native move notifications alone are not drag completion');
 f.child.emit('moved');assert.deepEqual(f.child.rect,{x:113,y:113,width:600,height:180});
 f.child.emit('will-move');f.controller.setEnabled(false);f.child.rect={...f.child.rect,x:120,y:120};f.child.emit('moved');assert.equal(f.child.rect.x,120,'hiding cancels a pending native completion');
});

test('macOS native move aliases never imply release while actual hold-drag completion still snaps',async t=>{
 const f=await movingFixture(t,{platform:'darwin'});f.place({x:12,y:12,width:400,height:120});
 for(const coordinate of [117,118]){f.child.emit('will-move');f.child.rect={...f.child.rect,x:coordinate,y:coordinate};f.child.emit('move');f.child.emit('moved');assert.equal(f.child.rect.x,coordinate);assert.equal(f.child.rect.y,coordinate);}
 f.move(5,5);assert.equal(f.child.rect.x,123);assert.equal(f.child.rect.y,123);f.finish();assert.deepEqual(f.child.rect,{x:113,y:113,width:500,height:150});
});

const partialMenu={x:500,y:600,width:80,height:80},coveringMenu={x:450,y:550,width:500,height:300};
const covers=(regions,x,y)=>regions.some(r=>x>=r.x&&x<r.x+r.width&&y>=r.y&&y<r.y+r.height);

test('account menu cuts only overlapping desktop pixels and leaves the same draft and remaining controls visible',async t=>{
 const f=await movingFixture(t),before={...f.child.rect},shows=f.child.shows;
 f.controller.update({value:'独立未发送草稿',sessionToken:'menu-session',revision:4,enabled:true});f.controller.setAccountMenuRect(partialMenu);
 assert(f.child.visible);assert.deepEqual(f.child.rect,before);assert.deepEqual(f.child.shape,[{x:0,y:106,width:500,height:44},{x:106,y:0,width:394,height:106}]);
 assert(!covers(f.child.shape,50,50));assert(covers(f.child.shape,300,50));assert(covers(f.child.shape,50,130));
 f.controller.setAccountMenuRect(null);assert.deepEqual(f.child.shape,[]);assert(f.child.visible);assert.equal(f.child.shows,shows,'partial clipping never hides or refocuses the whole composer');
 assert.equal(f.child.webContents.sent.at(-1)[1].value,'独立未发送草稿');assert.equal(f.child.webContents.sent.at(-1)[1].sessionToken,'menu-session');
});

test('a fully occluded composer keeps its session binding and resumes without changing position or draft',async t=>{
 const f=await movingFixture(t),before={...f.child.rect},shows=f.child.shows;
 f.controller.update({value:'保留输入',sessionToken:'s',revision:3,enabled:true});f.controller.setAccountMenuRect(coveringMenu);assert(!f.child.visible);
 f.controller.raise();assert.equal(f.child.raises,0);f.drag(20,20,{finished:true});assert.deepEqual(f.child.rect,before,'blocked queued movement cannot shift the hidden float');
 f.input({type:'edit',value:'同步保留输入',sessionToken:'s',revision:3,editId:1});assert.equal(f.host.webContents.sent.at(-1)[1].type,'edit','menu occlusion does not detach the active session');
 f.controller.update({value:'同步保留输入',sessionToken:'s',revision:4,enabled:true,settledEditId:1});f.controller.setAccountMenuRect(null);
 assert(f.child.visible);assert.equal(f.child.shows,shows+1);assert.deepEqual(f.child.rect,before);assert.equal(f.child.webContents.sent.at(-1)[1].value,'同步保留输入');
 f.move(40,-20);assert.deepEqual(f.child.rect,{...before,x:before.x+40,y:before.y-20});
});

test('a menu open before first display defers showing without losing the eventual initial reveal',async t=>{
 const f=await movingFixture(t,{menuBeforeLoad:coveringMenu});assert(!f.child.visible);assert.equal(f.child.shows,0);
 f.controller.setAccountMenuRect(null);assert(f.child.visible);assert.equal(f.child.shows,1);
});

test('a native completion arriving after menu occlusion cannot snap the hidden composer',async t=>{
 const f=await movingFixture(t);f.drag(17-f.child.rect.x,15-f.child.rect.y);const before={...f.child.rect};f.child.emit('will-move');
 f.controller.setAccountMenuRect({x:-100,y:-100,width:1000,height:1000});assert(!f.child.visible);f.child.emit('moved');assert.deepEqual(f.child.rect,before);
 f.controller.setAccountMenuRect(null);assert(f.child.visible);assert.deepEqual(f.child.rect,before);
});

test('closing a menu never revives an explicitly disabled, removed, dismissed or owner-hidden composer',async t=>{
 for(const action of ['disable','remove','dismiss','owner-hide']){
  const f=await movingFixture(t);f.controller.setAccountMenuRect(coveringMenu);const shows=f.child.shows;
  if(action==='disable')f.controller.setEnabled(false);
  else if(action==='remove')f.controller.place(f.host,{action:'remove'});
  else if(action==='dismiss')f.child.emit('close',{preventDefault(){}});
  else{f.hostVisibility.visible=false;f.host.emit('hide');}
  f.controller.setAccountMenuRect(null);assert(!f.child.visible,action);assert.equal(f.child.shows,shows,action);
  if(action==='disable')f.controller.setEnabled(true);else if(action==='owner-hide'){f.hostVisibility.visible=true;f.host.emit('show');}else f.place();
  assert(f.child.visible,action+' resumes only after its corresponding display intent is restored');
 }
});

test('menu clipping follows drag, owner displacement, zoom and child dimensions without modifying owner-relative offsets',async t=>{
 const f=await movingFixture(t);f.controller.setAccountMenuRect(partialMenu);f.drag(40,0);assert(!covers(f.child.shape,40,50));assert(covers(f.child.shape,80,50));
 const calls=f.child.shapes.length;f.move(200,100);assert.equal(f.child.shapes.length,calls,'a shared owner vector leaves the local cutout unchanged');
 f.setZoom(1.5);assert.equal(f.child.rect.width,600);assert.equal(f.child.rect.height,180);assert(!covers(f.child.shape,100,160));assert(covers(f.child.shape,20,20));assert(covers(f.child.shape,500,160));
 f.child.rect={...f.child.rect,width:700,height:220};f.child.emit('resize');assert(covers(f.child.shape,600,210),'native child size changes refresh the permitted region');
 f.controller.setAccountMenuRect(null);const position={x:f.child.rect.x,y:f.child.rect.y};f.move(30,-15);assert.equal(f.child.rect.x,position.x+30);assert.equal(f.child.rect.y,position.y-15);
});

test('unsupported shape fallback restores only layer-hidden visibility and disposal/rebind clear menu state',async t=>{
 const f=await movingFixture(t,{platform:'darwin'});f.controller.setAccountMenuRect(partialMenu);assert(!f.child.visible);f.controller.setAccountMenuRect(null);assert(f.child.visible);
 f.controller.setAccountMenuRect(partialMenu);const old=f.child,shows=old.shows;f.controller.dispose();assert(old.destroyed);assert.equal(old.shows,shows,'dispose must not reveal an occluded float');
 const g=await movingFixture(t);g.controller.setAccountMenuRect(partialMenu);const first=g.child,secondHost=new EventEmitter();secondHost.webContents=new Contents();secondHost.isDestroyed=()=>false;secondHost.isVisible=()=>true;secondHost.isMinimized=()=>false;secondHost.getContentSize=()=>[1000,800];secondHost.getContentBounds=()=>({x:200,y:200,width:1000,height:800});
 g.controller.place(secondHost,{action:'place',rect:g.normal});g.controller.setEnabled(true);await Promise.resolve();const second=Desktop.latest;
 assert(first.destroyed);assert.deepEqual(first.shape,[]);assert(second.visible);assert.deepEqual(second.shape,[],'a rebound owner starts without the prior account menu');
});
