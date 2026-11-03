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
  getZoomFactor() { return 1; }
}
class FakeView { constructor(opts) { this.webContents=new FakeContents(); this.opts=opts; FakeView.latest=this; } setBackgroundColor(x) { this.background=x; } setBounds(r) { this.bounds=r; } }
function setup(View = FakeView) {
  const ipcMain=new EventEmitter(), window=new EventEmitter();
  window.webContents=new FakeContents(); window.isDestroyed=()=>false; window.isVisible=()=>true; window.isMinimized=()=>false; window.getContentSize=()=>[1000,800];
  const children=[]; window.contentView={ addChildView(v) { const i=children.indexOf(v); if(i>=0)children.splice(i,1); children.push(v); }, removeChildView(v) { const i=children.indexOf(v); if(i>=0) children.splice(i,1); } };
  const controller=createNativeComposerController({WebContentsView:View,ipcMain}); return {controller,ipcMain,window,children};
}
async function init(ctx) {ctx.controller.place(ctx.window,{action:'place',rect:{x:500,y:700,width:400,height:60}});ctx.controller.setEnabled(true);await Promise.resolve();}
test('trusted floating drag events are bounded and do not depend on an active work session',async()=>{
 const t=setup();await init(t);const v=FakeView.latest,event={sender:v.webContents,senderFrame:v.webContents.mainFrame};t.ipcMain.emit('neko-composer-input',event,{type:'move',dx:-120,dy:80});assert.deepEqual(t.window.webContents.sent.at(-1)[1],{type:'move',dx:-120,dy:80});const count=t.window.webContents.sent.length;t.ipcMain.emit('neko-composer-input',event,{type:'move',dx:Infinity,dy:0});assert.equal(t.window.webContents.sent.length,count);t.ipcMain.emit('neko-composer-input',{sender:{},senderFrame:{}},{type:'move',reset:true});assert.equal(t.window.webContents.sent.length,count);t.controller.dispose();
});
test('chat-only composer refuses stale full-workspace actions while retaining record selection',async()=>{
 const t=setup();await init(t);const v=FakeView.latest;t.controller.update({value:'draft',sessionToken:'s1',revision:1,enabled:true,chatOnly:true});
 const sender={sender:v.webContents,senderFrame:v.webContents.mainFrame};t.ipcMain.emit('neko-composer-input',sender,{type:'expand'});t.ipcMain.emit('neko-composer-input',sender,{type:'files',sessionToken:'s1',revision:1});assert.equal(t.window.webContents.sent.length,0);
 assert.equal(v.webContents.sent.at(-1)[1].chatOnly,true);t.ipcMain.emit('neko-composer-input',sender,{type:'records-toggle',open:true});assert.equal(t.window.webContents.sent.at(-1)[1].type,'records-toggle');t.controller.dispose();
});
test('native composer overlays video, clips bounds, detaches, and disposes',async()=>{
  const t=setup();await init(t);const v=FakeView.latest;
  assert.equal(t.children.length,1);assert.deepEqual(v.bounds,{x:500,y:700,width:400,height:60});assert.equal(v.background,'#00000000');assert.equal(v.opts.webPreferences.nodeIntegration,false);assert.equal(v.opts.webPreferences.contextIsolation,true);assert.equal(v.webContents.windowHandler().action,'deny');
  t.controller.raise();assert.deepEqual(t.children,[v]);t.controller.place(t.window,{action:'remove'});assert.equal(t.children.length,0);
  assert.throws(()=>t.controller.place(t.window,{action:'place',rect:{x:1,y:1,width:2,height:3}}));t.controller.dispose();assert.equal(v.webContents.closed,true);assert.equal(t.ipcMain.listenerCount('neko-composer-input'),0);
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

test('model selection is catalog-bound and acknowledged by id before submission or record navigation can resume',async()=>{
 const t=setup();await init(t);const v=FakeView.latest,event={sender:v.webContents,senderFrame:v.webContents.mainFrame};
 const id=JSON.stringify(['deepseek-account','deepseek-flash']),state={value:'保留草稿',enabled:true,busy:false,sessionToken:'s1',revision:2,modelId:id,reasoningId:'low',modelOptions:[{id,label:'Flash',reasoningOptions:[{id:'low',label:'Low'},{id:'high',label:'High'}]}],records:[{id:'dsh:another',title:'Another',project:'P',enabled:true}]};
 t.controller.update(state);const select={type:'model-select',modelId:id,reasoningId:'high',sessionToken:'s1',revision:2,selectionId:7};
 t.ipcMain.emit('neko-composer-input',event,{...select,revision:1});assert.equal(t.window.webContents.sent.length,0);assert.equal(v.webContents.sent.at(-1)[1].settledModelSelectionId,7);assert.equal(v.webContents.sent.at(-1)[1].value,'保留草稿');
 t.ipcMain.emit('neko-composer-input',event,{...select,reasoningId:'invented'});assert.equal(t.window.webContents.sent.length,0);
 t.ipcMain.emit('neko-composer-input',event,select);assert.deepEqual(t.window.webContents.sent.at(-1)[1],select);
 const count=t.window.webContents.sent.length,submit={type:'submit',value:'保留草稿',sessionToken:'s1',revision:2,submissionId:9};
 t.ipcMain.emit('neko-composer-input',event,submit);t.ipcMain.emit('neko-composer-input',event,{type:'record-open',id:'dsh:another',openId:4,sessionToken:'s1',revision:2});assert.equal(t.window.webContents.sent.length,count);
 t.controller.update({...state,settledModelSelectionId:6});t.ipcMain.emit('neko-composer-input',event,submit);assert.equal(t.window.webContents.sent.length,count,'an unrelated acknowledgment cannot clear the pending choice');
 t.ipcMain.emit('neko-composer-input',event,{type:'model-refresh'});assert.deepEqual(t.window.webContents.sent.at(-1)[1],{type:'model-refresh',selectionId:7});
 t.controller.update({...state,reasoningId:'high',settledModelSelectionId:7});t.ipcMain.emit('neko-composer-input',event,submit);assert.equal(t.window.webContents.sent.at(-1)[1].type,'submit');t.controller.dispose();
});
