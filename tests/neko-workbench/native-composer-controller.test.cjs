'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createNativeComposerController } = require('../../apps/neko-workbench/native-composer-controller.cjs');
class FakeContents extends EventEmitter {
  constructor() { super(); this.sent=[]; this.mainFrame={}; this.closed=false; }
  isDestroyed() { return this.closed; }
  setWindowOpenHandler(fn) { this.windowHandler=fn; }
  loadFile(p) { this.loaded=p; return Promise.resolve(); }
  close() { this.closed=true; }
  send(...args) { this.sent.push(args); }
  getZoomFactor() { return this.zoom || 1; }
  setZoomFactor(value) { this.zoom=value; }
}
class FakeView { constructor(opts) { this.webContents=new FakeContents(); this.opts=opts; FakeView.latest=this; } setBackgroundColor(x) { this.background=x; } setBounds(r) { this.bounds=r; } }
function setup(View = FakeView) {
  const ipcMain=new EventEmitter(), window=new EventEmitter();
  window.webContents=new FakeContents(); window.isDestroyed=()=>false; window.isVisible=()=>true; window.isMinimized=()=>false; window.getContentSize=()=>[1000,800];
  const children=[]; window.contentView={ addChildView(v) { const i=children.indexOf(v); if(i>=0)children.splice(i,1); children.push(v); }, removeChildView(v) { const i=children.indexOf(v); if(i>=0) children.splice(i,1); } };
  const controller=createNativeComposerController({WebContentsView:View,ipcMain}); return {controller,ipcMain,window,children};
}
async function init(ctx) {ctx.controller.place(ctx.window,{action:'place',rect:{x:500,y:700,width:400,height:60}});ctx.controller.setEnabled(true);await Promise.resolve();}
test('native composer overlays video, clips bounds, detaches, and disposes',async()=>{
  const t=setup();await init(t);const v=FakeView.latest;
  assert.equal(t.children.length,1);assert.deepEqual(v.bounds,{x:500,y:700,width:400,height:60});assert.equal(v.background,'#00000000');assert.equal(v.opts.webPreferences.nodeIntegration,false);assert.equal(v.opts.webPreferences.contextIsolation,true);assert.equal(v.webContents.windowHandler().action,'deny');
  t.controller.raise();assert.deepEqual(t.children,[v]);t.controller.place(t.window,{action:'remove'});assert.equal(t.children.length,0);
  assert.throws(()=>t.controller.place(t.window,{action:'place',rect:{x:1,y:1,width:2,height:3}}));t.controller.dispose();assert.equal(v.webContents.closed,true);assert.equal(t.ipcMain.listenerCount('neko-composer-input'),0);
});

test('resize reattaches a clipped composer and page zoom scales its content once', async()=>{
  const t=setup();await init(t);const v=FakeView.latest;
  t.controller.update({value:'保留草稿',enabled:true,sessionToken:'s',revision:1});
  let size=[400,300];t.window.getContentSize=()=>size;
  t.window.emit('resize');assert.equal(t.children.length,0);
  size=[1600,1200];t.window.emit('resize');assert.deepEqual(t.children,[v]);
  t.window.webContents.setZoomFactor(1.5);t.window.webContents.emit('zoom-changed');
  assert.deepEqual(v.bounds,{x:750,y:1050,width:600,height:90});assert.equal(v.webContents.getZoomFactor(),1.5);
  assert.equal(v.webContents.sent.at(-1)[1].value,'保留草稿');
  let detachCount=0;const remove=t.window.contentView.removeChildView;
  t.window.contentView.removeChildView=view=>{detachCount++;remove(view);};
  t.children.push({site:true});t.controller.raise();assert.equal(t.children.at(-1),v);assert.equal(detachCount,0,'raising must not interrupt the focused input/IME');
  t.controller.dispose();
});
test('only attached, top-frame trusted view may send bounded events for current session',async()=>{
  const t=setup();await init(t);const v=FakeView.latest;
  const current={value:'草稿',enabled:true,busy:false,sessionToken:'session-a',revision:3};t.controller.update(current);
  const event={sender:v.webContents,senderFrame:v.webContents.mainFrame};
  const submit={type:'submit',value:'继续任务',sessionToken:'session-a',revision:3,submissionId:1};
  t.ipcMain.emit('neko-composer-input',{sender:new FakeContents(),senderFrame:{}},submit);
  t.ipcMain.emit('neko-composer-input',{sender:v.webContents,senderFrame:{}},submit);
  t.ipcMain.emit('neko-composer-input',event,{...submit,sessionToken:'stale'});
  t.ipcMain.emit('neko-composer-input',event,{...submit,revision:2});
  t.ipcMain.emit('neko-composer-input',event,{...submit,value:'x'.repeat(30001)});
  assert.equal(t.window.webContents.sent.length,0);
  t.ipcMain.emit('neko-composer-input',event,submit);assert.deepEqual(t.window.webContents.sent[0],['workbench:native-composer-event',submit]);
  t.ipcMain.emit('neko-composer-input',event,submit);assert.equal(t.window.webContents.sent.length,1);
  t.controller.update({...current,settledSubmitId:1,busy:true});t.ipcMain.emit('neko-composer-input',event,submit);assert.equal(t.window.webContents.sent.length,1);
  t.controller.setEnabled(false);t.ipcMain.emit('neko-composer-input',event,{type:'expand'});assert.equal(t.window.webContents.sent.length,1);
  t.controller.dispose();
});
test('window hide and reopen retain isolated state; old session or revision rejection never submits',async()=>{
  const t=setup();await init(t);const v=FakeView.latest;
  t.controller.update({value:'保留',enabled:true,busy:false,sessionToken:'a',revision:8});
  t.window.emit('hide');assert.equal(t.children.length,0);t.window.emit('show');assert.equal(t.children.length,1);
  const event={sender:v.webContents,senderFrame:v.webContents.mainFrame};
  t.ipcMain.emit('neko-composer-input',event,{type:'submit',value:'保留',sessionToken:'a',revision:7,submissionId:3});
  assert.equal(t.window.webContents.sent.length,0);const last=v.webContents.sent.at(-1);assert.equal(last[0],'neko-composer-state');assert.equal(last[1].settledSubmitId,3);assert.equal(last[1].value,'保留');
  t.controller.place(t.window,{action:'remove'});t.ipcMain.emit('neko-composer-input',event,{type:'expand'});assert.equal(t.window.webContents.sent.length,0);
  t.window.emit('closed');assert.equal(v.webContents.closed,true);t.controller.dispose();
});
test('edit acknowledgement serializes versioned writes and rejects stale writes without losing the draft',async()=>{
 const t=setup();await init(t);const v=FakeView.latest, event={sender:v.webContents,senderFrame:v.webContents.mainFrame};
 const current={value:'原始',enabled:true,busy:false,sessionToken:'s',revision:1};t.controller.update(current);
 const first={type:'edit',value:'初稿',sessionToken:'s',revision:1,editId:1};t.ipcMain.emit('neko-composer-input',event,first);t.ipcMain.emit('neko-composer-input',event,{...first,editId:2});assert.equal(t.window.webContents.sent.length,1);
 t.controller.update({...current,value:'初稿',revision:2,settledEditId:1});t.ipcMain.emit('neko-composer-input',event,{...first,editId:3});assert.equal(t.window.webContents.sent.length,1);assert.equal(v.webContents.sent.at(-1)[1].editConflict,true);
 t.ipcMain.emit('neko-composer-input',event,{...first,revision:2,editId:4});assert.equal(t.window.webContents.sent.length,2);t.controller.dispose();
});
test('composer load failure notifies the host to recover the workspace', async()=>{
 class FailLoad extends FakeView { constructor(options) { super(options); this.webContents.loadFile=()=>Promise.reject(Error('synthetic failure')); } }
 const t=setup(FailLoad);await init(t);await new Promise(resolve=>setImmediate(resolve));const v=FakeView.latest;
 assert.deepEqual(t.window.webContents.sent,[['workbench:native-composer-event',{type:'unavailable'}]]);
 assert.equal(t.children.length,0);assert(v.webContents.closed);t.controller.dispose();
});
test('renderer crash sends one recovery notification and normal removal does not',async()=>{
 const t=setup();await init(t);const v=FakeView.latest;v.webContents.emit('render-process-gone');
 assert.deepEqual(t.window.webContents.sent,[['workbench:native-composer-event',{type:'unavailable'}]]);
 assert.equal(t.children.length,0);assert(v.webContents.closed);v.webContents.emit('render-process-gone');assert.equal(t.window.webContents.sent.length,1);
 t.controller.dispose();
 const removed=setup();await init(removed);const removedView=FakeView.latest;removed.controller.place(removed.window,{action:'remove'});removedView.webContents.emit('render-process-gone');
 assert.deepEqual(removed.window.webContents.sent,[]);removed.controller.dispose();
});
test('late load failure after removal or disposal does not report a visible composer failure',async()=>{
 let rejectLoad;class DeferredView extends FakeView { constructor(options) { super(options);this.webContents.loadFile=()=>new Promise((_,reject)=>{rejectLoad=reject;}); } }
 const removed=setup(DeferredView);removed.controller.place(removed.window,{action:'place',rect:{x:500,y:700,width:400,height:60}});removed.controller.place(removed.window,{action:'remove'});
 rejectLoad(Error('synthetic late failure'));await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(removed.window.webContents.sent,[]);removed.controller.dispose();
 const disposed=setup(DeferredView);disposed.controller.place(disposed.window,{action:'place',rect:{x:500,y:700,width:400,height:60}});disposed.controller.dispose();
 rejectLoad(Error('synthetic late failure'));await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(disposed.window.webContents.sent,[]);
});

test('files event is authorized only for the current clean session and trusted view',async()=>{
 const t=setup();await init(t);const v=FakeView.latest,event={sender:v.webContents,senderFrame:v.webContents.mainFrame},current={value:'draft',enabled:true,busy:false,sessionToken:'s1',revision:3};t.controller.update(current);
 for(const m of [{type:'files',sessionToken:'s2',revision:3},{type:'files',sessionToken:'s1',revision:2}])t.ipcMain.emit('neko-composer-input',event,m);
 assert.match(v.webContents.sent.at(-1)[1].status,/会话或草稿已变化/,'a stale directory action provides visible feedback');
 t.ipcMain.emit('neko-composer-input',{sender:v.webContents,senderFrame:{}},{type:'files',sessionToken:'s1',revision:3});assert.equal(t.window.webContents.sent.length,0);
 t.ipcMain.emit('neko-composer-input',event,{type:'files',sessionToken:'s1',revision:3});assert.deepEqual(t.window.webContents.sent[0],['workbench:native-composer-event',{type:'files',sessionToken:'s1',revision:3}]);
 t.ipcMain.emit('neko-composer-input',event,{type:'edit',value:'new',sessionToken:'s1',revision:3,editId:1});t.ipcMain.emit('neko-composer-input',event,{type:'files',sessionToken:'s1',revision:3});assert.equal(t.window.webContents.sent.length,2);t.controller.dispose();
});
test('lobby submit requires a verified target and preserves uncertain result to child',async()=>{
 const t=setup();await init(t);const v=FakeView.latest,event={sender:v.webContents,senderFrame:v.webContents.mainFrame};
 const state={value:'草稿',enabled:true,busy:false,sessionToken:'s',revision:1,targetRequired:true,targetLabel:''};
 t.controller.update(state);const request={type:'submit',value:'草稿',sessionToken:'s',revision:1,submissionId:11};
 t.ipcMain.emit('neko-composer-input',event,request);assert.equal(t.window.webContents.sent.length,0);
 t.controller.update({...state,targetLabel:'项目 · 会话'});t.ipcMain.emit('neko-composer-input',event,request);assert.equal(t.window.webContents.sent.length,1);
 t.controller.update({...state,targetLabel:'项目 · 会话',settledSubmitId:11,submitUnknown:true});assert.equal(v.webContents.sent.at(-1)[1].submitUnknown,true);assert.equal(v.webContents.sent.at(-1)[1].targetLabel,'项目 · 会话');t.controller.dispose();
});
