'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{EventEmitter}=require('node:events');
const {createNativeDividerController}=require('../../apps/neko-workbench/native-divider-controller.cjs');
class Contents extends EventEmitter{constructor(){super();this.mainFrame={};this.destroyed=false;this.zoom=1;this.sent=[];}getZoomFactor(){return this.zoom;}isDestroyed(){return this.destroyed;}send(...args){this.sent.push(args);}setWindowOpenHandler(){}loadFile(){return Promise.resolve();}close(){this.destroyed=true;}}
class View{constructor(options){this.options=options;this.webContents=new Contents();this.bounds=null;}setBackgroundColor(value){this.background=value;}setBounds(value){this.bounds=value;}}
class Host extends EventEmitter{constructor(){super();this.webContents=new Contents();this.children=[];this.contentView={addChildView:v=>{if(!this.children.includes(v))this.children.push(v);},removeChildView:v=>{this.children=this.children.filter(x=>x!==v);}};}isDestroyed(){return false;}getContentSize(){return [1000,700];}getContentBounds(){return {x:100,y:50,width:1000,height:700};}}
const tick=()=>new Promise(r=>setImmediate(r));
test('native divider validates sources, tracks zoom and restores bounds on end and cancellation',async()=>{
 const ipc=new EventEmitter(),host=new Host(),c=createNativeDividerController({WebContentsView:View,ipcMain:ipc});c.bind(host);c.setEnabled(true);c.place(host,{action:'place',id:'chat',rect:{x:400,y:20,width:12,height:600}});await tick();assert.equal(host.children.length,1);const v=host.children[0],input=(m,frame=v.webContents.mainFrame,sender=v.webContents)=>ipc.emit('neko-divider-input',{sender,senderFrame:frame},m);
 assert.deepEqual(v.bounds,{x:400,y:20,width:12,height:600});assert.throws(()=>c.place(host,{action:'place',id:'evil',rect:{x:0,y:0,width:12,height:600}}));assert.throws(()=>c.place(host,{action:'place',id:'chat',rect:{x:0,y:0,width:500,height:600}}));
 input({type:'start',token:1},{});assert.equal(host.webContents.sent.length,0,'reject untrusted frame');
 input({type:'start',token:1});assert.deepEqual(v.bounds,{x:0,y:0,width:1000,height:700});host.webContents.zoom=2;
 c.setEnabled(true);c.raise();assert.deepEqual(v.bounds,{x:0,y:0,width:1000,height:700},'layout updates must not shrink an active capture layer');
 input({type:'move',x:900,token:0});assert.equal(host.webContents.sent.length,1,'ignore stale drag');input({type:'move',x:900,token:1});assert.deepEqual(host.webContents.sent.at(-1)[1],{id:'chat',type:'move',x:400});
 input({type:'end',x:900,token:1});assert.deepEqual(v.bounds,{x:800,y:40,width:24,height:660});assert.equal(host.webContents.sent.at(-1)[1].type,'end');
 input({type:'start',token:2});host.emit('blur');assert.equal(host.webContents.sent.at(-1)[1].type,'cancel');assert.deepEqual(v.bounds,{x:800,y:40,width:24,height:660});input({type:'move',x:700,token:2});assert.equal(host.webContents.sent.at(-1)[1].type,'cancel');
 const site=new View();host.contentView.addChildView(site);c.raise();assert.equal(host.children.at(-1),v,'divider is above a newly attached site');
 input({type:'start',token:3});c.raise(true);assert.equal(host.webContents.sent.at(-1)[1].type,'cancel','a newly attached site cancels an active drag before raising');
 input({type:'start',token:4});host.emit('hide');assert.equal(host.webContents.sent.at(-1)[1].type,'cancel');
 input({type:'start',token:5});host.emit('resize');assert.equal(host.webContents.sent.at(-1)[1].type,'cancel');
 host.contentView.removeChildView(site);
 c.setEnabled(false);assert.equal(host.children.length,0);c.setEnabled(true);assert.equal(host.children.length,1);c.place(host,{action:'remove',id:'chat'});assert.equal(host.children.length,0);c.dispose();assert.equal(ipc.listenerCount('neko-divider-input'),0);
});
