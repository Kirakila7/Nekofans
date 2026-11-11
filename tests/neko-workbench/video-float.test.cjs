'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),{EventEmitter}=require('node:events');
const {createVideoFloatController,COMPACT}=require('../../apps/neko-workbench/video-float-controller.cjs');
class Contents extends EventEmitter{constructor(){super();this.sent=[];this.mainFrame={};}send(...args){this.sent.push(args);}isDestroyed(){return false;}setWindowOpenHandler(fn){this.open=fn;}getZoomFactor(){return 1;}loadFile(file){this.file=file;this.loads=(this.loads||0)+1;return Window.defer?new Promise(resolve=>{(Window.releases||=[]).push(resolve);Window.release=()=>{for(const done of Window.releases.splice(0))done();};}):Promise.resolve();}close(){this.closed=true;}}
class Window extends EventEmitter{constructor(options={}){super();this.options=options;this.webContents=new Contents();this.rect={x:options.x||100,y:options.y||100,width:options.width||1200,height:options.height||800};this.contentView={children:[],addChildView(view){this.children=this.children.filter(x=>x!==view);this.children.push(view);}};this.visible=false;this.destroyed=false;this.loads=0;this.boundsHistory=[];Window.latest=this;}getBounds(){return {...this.rect};}getContentBounds(){return this.contentRect?{...this.contentRect}:this.getBounds();}getContentSize(){return [this.rect.width,this.rect.height];}setBounds(bounds){if(this.emitNativeEventsOnSetBounds)this.emit('will-move',{},bounds);this.rect={...bounds};this.boundsHistory.push({...bounds});this.emit('resize');this.emit('moved');}setResizable(value){this.resizable=value;}setMinimumSize(...size){this.minimum=size;}setMenu(){}setTitle(title){this.title=title;}loadFile(file){this.loaded=file;this.loads++;return Window.defer?new Promise(resolve=>{Window.release=resolve;}):Promise.resolve();}show(){this.visible=true;this.emit('show');}showInactive(){this.show();}focus(){}hide(){this.visible=false;this.emit('hide');}isVisible(){return this.visible;}destroy(){this.destroyed=true;}isDestroyed(){return this.destroyed;}}
class View{constructor(){this.webContents=new Contents();View.latest=this;}setBackgroundColor(value){this.background=value;}setBounds(rect){this.rect=rect;}}
function fixture(t,{display,platform='win32'}={}){const owner=new Window();owner.visible=true;const handlers=new Map(),calls=[],views=[],siteContents=new Contents();const ipcMain=Object.assign(new EventEmitter(),{handle:(name,fn)=>handlers.set(name,fn),removeHandler:name=>handlers.delete(name)});const screen={getDisplayMatching:bounds=>({workArea:display?.(bounds)||{x:0,y:0,width:1920,height:1080}}),getPrimaryDisplay:()=>({workArea:{x:0,y:0,width:1920,height:1080}})};let disposed=false;const controller=createVideoFloatController({BrowserWindow:Window,WebContentsView:class extends View{constructor(...args){super(...args);views.push(this);}},ipcMain,screen,shell:{openExternal(){}},clipboard:{writeText(){}},platform,createSocial:options=>({view:{webContents:siteContents},bindHost(){},action:async(_win,request)=>{calls.push(request);return {ok:true};},dispose(){disposed=true;}})});t.after(()=>{controller.dispose();Window.defer=false;});return {owner,controller,calls,handlers,views,siteContents,ipcMain,isDisposed:()=>disposed,input:(request,index=1)=>handlers.get('neko-video-float')({sender:views[index].webContents,senderFrame:views[index].webContents.mainFrame},request),siteDrag:(delta,event={sender:siteContents,senderFrame:siteContents.mainFrame})=>ipcMain.emit('neko-video-site-drag',event,delta)};}
test('compact glass window is fixed size; expansion and resize reuse the same web document',async t=>{
 const f=fixture(t);await f.controller.action(f.owner,{action:'open',site:'bilibili'});const win=Window.latest;assert.equal(win.options.width,COMPACT.width);assert.equal(win.options.height,COMPACT.height);assert.equal(win.options.resizable,false);assert.equal(win.options.frame,false);assert.equal(win.options.hasShadow,false);assert.deepEqual(f.calls.at(-1).bounds,{x:0,y:0,width:480,height:336});assert(win.contentView.children.some(v=>v.rect.x===440&&v.rect.y===296));assert.deepEqual(View.latest.rect,{x:0,y:0,width:40,height:40});assert.equal(win.options.webPreferences.nodeIntegration,false);assert.equal(win.options.webPreferences.sandbox,true);
 assert.equal(f.calls.filter(r=>r.action==='open').length,1);await f.input({action:'resize',dx:100,dy:100});assert.equal(win.rect.width,480);
 await f.input({action:'toggle-expanded'});assert(win.resizable);assert.equal(win.rect.width,960);assert.equal(win.rect.height,640);assert.equal(View.latest.webContents.loads,1);assert.equal(f.calls.filter(r=>r.action==='open').length,1);
 await f.input({action:'resize',dx:100,dy:60});assert.equal(win.rect.width,1060);assert.equal(f.calls.at(-1).bounds.width,1060);await f.input({action:'toggle-expanded'});assert(!win.resizable);assert.equal(win.rect.width,480);assert.equal(win.rect.height,336);await f.input({action:'toggle-expanded'});assert.equal(win.rect.width,1060);assert.equal(win.rect.height,700);
});
test('office suspend, parent hide and explicit close preserve the window and resume selected site',async t=>{
 const f=fixture(t);await f.controller.action(f.owner,{action:'open',site:'youtube'});const win=Window.latest;await f.controller.action(f.owner,{action:'suspend'});assert(!win.visible);assert.equal(f.controller.snapshot().open,false);await f.controller.action(f.owner,{action:'resume'});assert(win.visible);assert.equal(f.controller.snapshot().site,'youtube');f.owner.emit('hide');assert(!win.visible);f.owner.emit('show');assert(win.visible);await f.input({action:'close'});assert(!win.visible);await f.controller.action(f.owner,{action:'resume'});assert(!win.visible);await f.controller.action(f.owner,{action:'open',site:'youtube'});assert.equal(Window.latest,win);assert.equal(View.latest.webContents.loads,1);
});
test('only trusted floating chrome can resize or operate the shared site controller',async t=>{
 const f=fixture(t);await assert.rejects(f.controller.action(f.owner,{action:'open',site:'other'}));await f.controller.action(f.owner,{action:'open',site:'youtube'});await assert.rejects(f.handlers.get('neko-video-float')({sender:{},senderFrame:{}},{action:'close'}));await f.input({action:'open-youtube-video',videoUrl:'https://www.youtube.com/watch?v=M7lc1UVf-VE'});assert.equal(f.calls.at(-1).action,'open-youtube-video');assert.equal(f.calls.at(-1).slot,'left');await f.input({action:'toggle-expanded'});await f.input({action:'resize',dx:Infinity,dy:5});assert.equal(Window.latest.rect.width,960);f.controller.dispose();assert(f.isDisposed());assert(!f.handlers.has('neko-video-float'));
});
test('closing or switching while chrome loads cannot reopen a stale video window',async t=>{
 const f=fixture(t);Window.defer=true;const opening=f.controller.action(f.owner,{action:'open',site:'bilibili'});await f.controller.action(f.owner,{action:'hide'});Window.release();await opening;assert(!Window.latest.visible);assert.equal(f.calls.filter(r=>r.action==='open').length,0);
});

test('trusted chrome only snaps once dragging finishes, preserves size and does not reload video content',async t=>{
 const f=fixture(t);await f.controller.action(f.owner,{action:'open',site:'bilibili'});const win=Window.latest;
 win.setBounds({...win.getBounds(),x:40,y:400});const beforeOpen=f.calls.filter(x=>x.action==='open').length;
 await f.input({action:'move',dx:-15,dy:0},0);assert.equal(win.rect.x,25,'intermediate motion does not stick to the nearby screen edge');
 await f.input({action:'move',dx:0,dy:0,finished:true},0);assert.equal(win.rect.x,8);assert.equal(win.rect.y,400);
 assert.deepEqual([win.rect.width,win.rect.height],[480,336]);assert.equal(f.calls.filter(x=>x.action==='open').length,beforeOpen);
 assert(f.views.every(view=>view.webContents.loads===1),'both trusted control documents are retained');
 win.setBounds({...win.getBounds(),x:40,y:400});await f.input({action:'move',dx:-15,dy:0,finished:true},1);
 assert.equal(win.rect.x,8,'a final delta is applied before the end-of-drag snap');
 win.setBounds({...win.getBounds(),x:420,y:360});const far=win.getBounds();await f.input({action:'move',dx:0,dy:0,finished:true});assert.deepEqual(win.getBounds(),far,'far-away windows remain where the user left them');
});

test('owner snapping uses the workbench content edges and keeps the expanded dimensions and web document',async t=>{
 const f=fixture(t);f.owner.contentRect={x:150,y:140,width:1100,height:720};await f.controller.action(f.owner,{action:'open',site:'bilibili'});const win=Window.latest;
 win.setBounds({...win.getBounds(),x:185,y:300});await f.input({action:'move',dx:-10,dy:0,finished:false});assert.equal(win.rect.x,175);
 await f.input({action:'move',dx:0,dy:0,finished:true});assert.equal(win.rect.x,158,'content inner edge is used instead of the outer window edge');
 await f.input({action:'toggle-expanded'});win.setBounds({...win.getBounds(),x:173,y:200});const size=[win.rect.width,win.rect.height];
 await f.input({action:'move',dx:0,dy:0,finished:true});assert.equal(win.rect.x,158);assert.deepEqual([win.rect.width,win.rect.height],size);
 assert.equal(f.calls.filter(x=>x.action==='open').length,1);assert(f.views.every(view=>view.webContents.loads===1));
});

test('account menu clips only the overlapping video area and restores the original window without navigation',async t=>{
 const f=fixture(t);await f.controller.action(f.owner,{action:'open',site:'bilibili'});const win=Window.latest,before=win.getBounds(),shapes=[];win.setShape=regions=>shapes.push(regions);
 const parent=f.owner.getContentBounds();f.controller.setAccountMenuRect({x:before.x-parent.x+100,y:before.y-parent.y+80,width:200,height:100});
 assert(win.visible);assert(shapes.at(-1).length>0);assert.deepEqual(win.getBounds(),before);assert.equal(f.calls.filter(call=>call.action==='open').length,1);
 for(const region of shapes.at(-1))assert(region.x+region.width<=94||region.x>=306||region.y+region.height<=74||region.y>=186,'the menu intersection receives no video pixels or clicks');
 f.controller.setAccountMenuRect(null);assert.deepEqual(shapes.at(-1),[]);assert(win.visible);assert.deepEqual(win.getBounds(),before);
});

test('fully covered and initially deferred video restores on menu close but never revives a closed or suspended video',async t=>{
 const f=fixture(t);f.controller.setAccountMenuRect({x:0,y:0,width:1300,height:900});await f.controller.action(f.owner,{action:'open',site:'bilibili'});const win=Window.latest;
 assert(!win.visible);assert(f.controller.snapshot().open,'occlusion does not change the open intent');f.controller.setAccountMenuRect(null);assert(win.visible,'first show deferred by a menu is restored');
 f.controller.setAccountMenuRect({x:0,y:0,width:1300,height:900});assert(!win.visible);
 await f.controller.action(f.owner,{action:'suspend'});f.controller.setAccountMenuRect(null);assert(!win.visible);await f.controller.action(f.owner,{action:'resume'});assert(win.visible);
 f.controller.setAccountMenuRect({x:0,y:0,width:1300,height:900});assert(!win.visible);await f.input({action:'close'});f.controller.setAccountMenuRect(null);assert(!win.visible);assert(!f.controller.snapshot().open);
});

test('website drag completion uses the same snapping and rejects foreign senders, subframes and malformed finished flags',async t=>{
 const f=fixture(t);await f.controller.action(f.owner,{action:'open',site:'bilibili'});const win=Window.latest;
 win.setBounds({...win.getBounds(),x:40,y:400});f.siteDrag({dx:-15,dy:0});assert.equal(win.rect.x,25);
 f.siteDrag({dx:0,dy:0,finished:'true'});assert.equal(win.rect.x,25);
 f.siteDrag({dx:0,dy:0,finished:true},{sender:{},senderFrame:f.siteContents.mainFrame});assert.equal(win.rect.x,25);
 f.siteDrag({dx:0,dy:0,finished:true},{sender:f.siteContents,senderFrame:{}});assert.equal(win.rect.x,25);
 f.siteDrag({dx:0,dy:0,finished:true});assert.equal(win.rect.x,8);
 win.setBounds({...win.getBounds(),x:40,y:400});f.siteDrag({dx:-15,dy:0,finished:true});assert.equal(win.rect.x,8);
 for(const finished of ['true',1,null,undefined])await assert.rejects(f.input({action:'move',dx:0,dy:0,finished}),/移动参数/);
 await assert.rejects(f.handlers.get('neko-video-float')({sender:f.views[0].webContents,senderFrame:{}},{action:'move',dx:1,dy:1,finished:true}),/请从视频浮窗/);
 assert.equal(f.calls.filter(x=>x.action==='open').length,1);
});

test('native user movement snaps at its moved boundary while programmatic movement never starts a native drag',async t=>{
 const f=fixture(t);await f.controller.action(f.owner,{action:'open',site:'bilibili'});const win=Window.latest;
 win.setBounds({...win.getBounds(),x:25,y:400});assert.equal(win.rect.x,25,'a programmatic moved event is not a completed user drag');
 win.emit('will-move',{},win.getBounds());win.emit('move');assert.equal(win.rect.x,25);win.emit('moved');assert.equal(win.rect.x,8);
 win.setBounds({...win.getBounds(),x:40,y:400});win.emitNativeEventsOnSetBounds=true;
 await f.input({action:'move',dx:-15,dy:0});assert.equal(win.rect.x,25,'programmatic will-move/moved events are ignored during an IPC delta');
 await f.input({action:'move',dx:0,dy:0,finished:true});assert.equal(win.rect.x,8);
 await f.input({action:'toggle-expanded'});assert.equal(win.rect.width,960);assert.equal(f.calls.filter(x=>x.action==='open').length,1);
});

test('macOS native moved aliases never snap before a real hold-drag completion',async t=>{
 const f=fixture(t,{platform:'darwin'});await f.controller.action(f.owner,{action:'open',site:'bilibili'});const win=Window.latest;
 win.setBounds({...win.getBounds(),x:25,y:400});win.emit('will-move',{},win.getBounds());win.emit('moved');assert.equal(win.rect.x,25);
 await f.input({action:'move',dx:0,dy:0,finished:true});assert.equal(win.rect.x,8,'actual pointerup completion remains available on macOS');
 assert.equal(f.calls.filter(x=>x.action==='open').length,1);
});

test('hidden, suspended, parent-hidden and not-yet-loaded windows ignore late drag deltas and completions',async t=>{
 const f=fixture(t);await f.controller.action(f.owner,{action:'open',site:'bilibili'});const win=Window.latest;
 for(const hide of [()=>f.input({action:'close'}),()=>f.controller.action(f.owner,{action:'suspend'}),()=>f.owner.emit('hide')]){
  await f.controller.action(f.owner,{action:'open',site:'bilibili'});win.setBounds({...win.getBounds(),x:25,y:400});win.emit('will-move',{},win.getBounds());await hide();
  const before=win.getBounds();await f.input({action:'move',dx:100,dy:100,finished:true});f.siteDrag({dx:100,dy:100,finished:true});win.emit('moved');assert.deepEqual(win.getBounds(),before);
 }
 const g=fixture(t);Window.defer=true;const opening=g.controller.action(g.owner,{action:'open',site:'bilibili'});const loading=Window.latest,before=loading.getBounds();
 await g.input({action:'move',dx:100,dy:100,finished:true});g.siteDrag({dx:100,dy:100,finished:true});loading.emit('will-move',{},before);loading.emit('moved');assert.deepEqual(loading.getBounds(),before);
 Window.release();await opening;
});

test('moving onto another display and snapping never implicitly shrinks the expanded video',async t=>{
 const f=fixture(t,{display:bounds=>bounds.x>=1900?{x:1920,y:0,width:900,height:700}:{x:0,y:0,width:1920,height:1080}});
 await f.controller.action(f.owner,{action:'open',site:'bilibili'});await f.input({action:'toggle-expanded'});const win=Window.latest,size=[win.rect.width,win.rect.height];
 await f.input({action:'move',dx:1920,dy:0});assert.deepEqual([win.rect.width,win.rect.height],size);
 await f.input({action:'move',dx:0,dy:0,finished:true});assert.deepEqual([win.rect.width,win.rect.height],size);
 assert.equal(f.calls.filter(x=>x.action==='open').length,1);assert(f.views.every(view=>view.webContents.loads===1));
});
