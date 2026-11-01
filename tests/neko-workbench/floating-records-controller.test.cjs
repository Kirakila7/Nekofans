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
  const children=[]; window.contentView={ addChildView(v) { children.push(v); }, removeChildView(v) { const i=children.indexOf(v); if(i>=0) children.splice(i,1); } };
  const controller=createNativeComposerController({WebContentsView:View,ipcMain}); return {controller,ipcMain,window,children};
}
async function init(ctx) {ctx.controller.place(ctx.window,{action:'place',rect:{x:500,y:700,width:400,height:60}});ctx.controller.setEnabled(true);await Promise.resolve();}
test('records navigation is bound to the verified child, catalog and unchanged draft revision',async()=>{
 const t=setup();await init(t);const v=FakeView.latest,ev={sender:v.webContents,senderFrame:v.webContents.mainFrame};
 t.controller.update({value:'',enabled:true,busy:false,sessionToken:'s',revision:4,records:[{id:'dsh:a',project:'demo',title:'A',enabled:true}]});
 const open={type:'record-open',id:'dsh:a',sessionToken:'s',revision:4,openId:1};
 t.ipcMain.emit('neko-composer-input',{sender:new FakeContents(),senderFrame:{}},open);t.ipcMain.emit('neko-composer-input',ev,{...open,id:'dsh:other'});t.ipcMain.emit('neko-composer-input',ev,{...open,revision:3});assert.equal(t.window.webContents.sent.length,0);
 t.ipcMain.emit('neko-composer-input',ev,open);assert.equal(t.window.webContents.sent.length,1);
 t.ipcMain.emit('neko-composer-input',ev,{type:'edit',value:'draft',sessionToken:'s',revision:4,editId:5});t.ipcMain.emit('neko-composer-input',ev,open);assert.equal(t.window.webContents.sent.length,2);
 t.ipcMain.emit('neko-composer-input',ev,{type:'records-resize',delta:4001});assert.equal(t.window.webContents.sent.length,2);t.controller.dispose();
});
test('a bounded later catalog window preserves record 250 and accepts its selection',async()=>{
 const t=setup();await init(t);const v=FakeView.latest,ev={sender:v.webContents,senderFrame:v.webContents.mainFrame};const records=Array.from({length:60},(_,i)=>({id:'dsh:s'+(200+i),project:'fish',title:'task',enabled:true}));
 t.controller.update({value:'',enabled:true,sessionToken:'s0',revision:1,records,recordsHasMore:false});const state=v.webContents.sent.at(-1)[1];assert(state.records.some(r=>r.id==='dsh:s250'));
 t.ipcMain.emit('neko-composer-input',ev,{type:'record-open',id:'dsh:s250',sessionToken:'s0',revision:1,openId:7});assert.equal(t.window.webContents.sent.at(-1)[1].id,'dsh:s250');t.controller.dispose();
});
test('resizing an attached native view does not detach it',async()=>{
 const t=setup();await init(t);const v=FakeView.latest;let removals=0;const remove=t.window.contentView.removeChildView;t.window.contentView.removeChildView=x=>{removals++;remove(x)};
 t.controller.place(t.window,{action:'place',rect:{x:400,y:400,width:500,height:360}});assert.deepEqual(t.children,[v]);assert.equal(removals,0);assert.deepEqual(v.bounds,{x:400,y:400,width:500,height:360});t.controller.dispose();
});

test('native task state is bounded and task toggles require the trusted attached frame',async()=>{
 const t=setup();await init(t);const v=FakeView.latest,ev={sender:v.webContents,senderFrame:v.webContents.mainFrame};
 t.controller.update({value:'',sessionToken:'s',revision:1,taskOpen:true,taskMessages:[{id:'a',role:'system',text:'hidden'},{id:'b',role:'assistant',text:'x'.repeat(7000),secret:'not forwarded'}],taskStatus:'running'});
 const state=v.webContents.sent.at(-1)[1];assert.equal(state.taskMessages.length,1);assert.equal(state.taskMessages[0].text.length,6000);assert.equal(state.taskMessages[0].secret,undefined);
 t.ipcMain.emit('neko-composer-input',{...ev,senderFrame:{}},{type:'task-toggle',open:true});assert.equal(t.window.webContents.sent.length,0);
 t.ipcMain.emit('neko-composer-input',ev,{type:'task-toggle',open:true});assert.deepEqual(t.window.webContents.sent.at(-1)[1],{type:'task-toggle',open:true});t.controller.dispose();
});
