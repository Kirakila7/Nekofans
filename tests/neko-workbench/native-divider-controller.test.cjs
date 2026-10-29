'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{EventEmitter}=require('node:events');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
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
 input({type:'start',token:3});const pendingSite=new View();host.contentView.addChildView(pendingSite);c.raise(true);
 assert.equal(host.webContents.sent.at(-1)[1].type,'start','site ready must not cancel the active drag');
 assert.deepEqual(v.bounds,{x:0,y:0,width:1000,height:700});
 input({type:'move',x:700,token:3});assert.equal(host.webContents.sent.at(-1)[1].type,'move');
 input({type:'end',x:700,token:3});assert.equal(host.webContents.sent.at(-1)[1].type,'end');assert.equal(host.children.at(-1),v,'deferred raise runs after drag ends');host.contentView.removeChildView(pendingSite);
 input({type:'start',token:4});host.emit('hide');assert.equal(host.webContents.sent.at(-1)[1].type,'cancel');
 input({type:'start',token:5});host.emit('resize');assert.equal(host.webContents.sent.at(-1)[1].type,'cancel');
 host.contentView.removeChildView(site);
 c.setEnabled(false);assert.equal(host.children.length,0);c.setEnabled(true);assert.equal(host.children.length,1);c.place(host,{action:'remove',id:'chat'});assert.equal(host.children.length,0);c.dispose();assert.equal(ipc.listenerCount('neko-divider-input'),0);
});
test('horizontal divider uses screen Y, limits capture thickness and preserves interaction safety',async()=>{
 const ipc=new EventEmitter(),host=new Host(),c=createNativeDividerController({WebContentsView:View,ipcMain:ipc});
 let focused=0;host.isFocused=()=>true;host.webContents.focus=()=>{focused++;};c.bind(host);c.setEnabled(true);
 const rect={x:400,y:300,width:580,height:12};c.place(host,{action:'place',id:'stack',orientation:'horizontal',rect});await tick();
 const v=host.children[0],input=(m,frame=v.webContents.mainFrame,sender=v.webContents)=>ipc.emit('neko-divider-input',{sender,senderFrame:frame},m);
 assert.deepEqual(v.webContents.sent.at(-1),['neko-divider-orientation','horizontal']);assert.deepEqual(v.bounds,rect);
 assert.throws(()=>c.place(host,{action:'place',id:'stack',orientation:'diagonal',rect}));
 assert.throws(()=>c.place(host,{action:'place',id:'stack',orientation:'horizontal',rect:{...rect,height:49}}));
 assert.throws(()=>c.place(host,{action:'place',id:'stack',orientation:'horizontal',rect:{...rect,y:Infinity}}));
 input({type:'key',key:'ArrowUp',shift:true});assert.deepEqual(host.webContents.sent.at(-1)[1],{id:'stack',type:'key',key:'ArrowUp',shift:true});
 const count=host.webContents.sent.length;input({type:'key',key:'ArrowLeft'});assert.equal(host.webContents.sent.length,count);
 input({type:'start',token:4},{});assert.equal(host.webContents.sent.length,count);
 input({type:'start',token:4});assert.deepEqual(v.bounds,{x:0,y:0,width:1000,height:700});host.webContents.zoom=2;
 input({type:'move',x:400,token:4});assert.equal(host.webContents.sent.length,count+1,'missing Y cannot move the horizontal divider');
 input({type:'move',y:650,token:3});assert.equal(host.webContents.sent.length,count+1,'stale tokens cannot move the divider');
 input({type:'move',y:650,token:4});assert.deepEqual(host.webContents.sent.at(-1)[1],{id:'stack',type:'move',y:300});
 input({type:'end',y:650,token:4});assert.deepEqual(host.webContents.sent.at(-1)[1],{id:'stack',type:'end',y:300});assert.equal(focused,1);assert.deepEqual(v.bounds,{x:800,y:600,width:200,height:24});
 input({type:'start',token:5});host.emit('resize');assert.equal(host.webContents.sent.at(-1)[1].type,'cancel');assert.deepEqual(v.bounds,{x:800,y:600,width:200,height:24});
 input({type:'start',token:6});c.place(host,{action:'place',id:'stack',orientation:'vertical',rect:{x:400,y:20,width:12,height:300}});assert.equal(host.webContents.sent.at(-1)[1].type,'cancel');assert.deepEqual(v.webContents.sent.at(-1),['neko-divider-orientation','vertical']);
 const site=new View();host.contentView.addChildView(site);c.raise();assert.equal(host.children.at(-1),v,'capture surface stays above newly attached views');
 input({type:'key',key:'ArrowRight'});assert.equal(host.webContents.sent.at(-1)[1].key,'ArrowRight');
 c.dispose();
});
test('divider surface reports horizontal pointer coordinates and vertical keyboard input',()=>{
 const ipc=new EventEmitter(),sent=[];ipc.send=(...args)=>sent.push(args);const events={},target={addEventListener:(name,fn)=>{events[name]=fn;},setPointerCapture(){},releasePointerCapture(){}};
 let ready;const document={documentElement:{dataset:{}},getElementById:()=>target};const window={addEventListener:(name,fn)=>{if(name==='DOMContentLoaded')ready=fn;}};
 const source=fs.readFileSync(path.join(__dirname,'../../apps/neko-workbench/native-divider-preload.cjs'),'utf8');
 vm.runInNewContext(source,{require:name=>{assert.equal(name,'electron');return {ipcRenderer:ipc};},window,document,Date});ready();
 ipc.emit('neko-divider-orientation',{},'horizontal');assert.equal(document.documentElement.dataset.orientation,'horizontal');
 const event={button:0,pointerId:1,screenX:200,screenY:350,buttons:1,preventDefault(){}};
 events.pointerdown(event);events.pointermove({...event,screenX:250,screenY:480});
 assert.equal(sent.at(-1)[1].type,'move');assert.equal(sent.at(-1)[1].y,480);assert.equal(sent.at(-1)[1].x,undefined);
 events.pointerup({...event,type:'pointerup',screenY:480});assert.equal(sent.at(-1)[1].type,'end');assert.equal(sent.at(-1)[1].y,480);
 events.keydown({key:'ArrowDown',shiftKey:true,preventDefault(){}});assert.equal(sent.at(-1)[1].key,'ArrowDown');
 const before=sent.length;events.keydown({key:'ArrowLeft',preventDefault(){}});assert.equal(sent.length,before);
 ipc.emit('neko-divider-orientation',{},'vertical');events.keydown({key:'ArrowLeft',shiftKey:false,preventDefault(){}});assert.equal(sent.at(-1)[1].key,'ArrowLeft');
});
