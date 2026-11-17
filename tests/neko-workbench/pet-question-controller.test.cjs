'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),{EventEmitter}=require('node:events'),{pathToFileURL}=require('node:url'),path=require('node:path');
const {createPetQuestionController}=require('../../apps/neko-workbench/pet-question-controller.cjs');
function fixture(){
 const windows=[],handlers=new Map(),requests=[],parent=new EventEmitter();Object.assign(parent,{rect:{x:400,y:420,width:200,height:180},visible:true,isDestroyed:()=>false,getBounds(){return this.rect;},isVisible(){return this.visible;}});
 class Contents extends EventEmitter{constructor(){super();this.sent=[];this.mainFrame={url:pathToFileURL(path.resolve(__dirname,'../../apps/neko-workbench/pet-question.html')).href};}send(type,value){this.sent.push({type,value});}setWindowOpenHandler(fn){this.newWindow=fn;}}
 class Window extends EventEmitter{constructor(options){super();this.options=options;this.webContents=new Contents();this.visible=false;this.dead=false;windows.push(this);}setBounds(rect){this.rect=rect;}isDestroyed(){return this.dead;}showInactive(){this.visible=true;}hide(){this.visible=false;}isVisible(){return this.visible;}destroy(){this.dead=true;this.visible=false;this.emit('closed');}loadFile(file){this.file=file;}}
 const ipcMain={handle:(key,fn)=>handlers.set(key,fn),removeHandler:key=>handlers.delete(key)};
 const c=createPetQuestionController({BrowserWindow:Window,screen:{getDisplayMatching:()=>({workArea:{x:0,y:0,width:800,height:600}})},ipcMain,request:(id,value)=>{requests.push({id,value});return {ok:true};}});
 const q={sessionId:'s1',key:'question:s1:c',revision:1,kind:'question',canAnswer:true,questions:[{id:'q',question:'选择任务',options:[{label:'整理'}]}]};
 return {c,parent,q,windows,handlers,requests};
}
test('task options use their own small isolated window, follow the pet and preserve the parent bounds',async()=>{
 const f=fixture(),original={...f.parent.rect};f.c.sync('fish',f.parent,f.q);const w=f.windows[0];assert.equal(w.options.parent,f.parent);assert.equal(w.options.webPreferences.sandbox,true);assert.equal(w.options.webPreferences.nodeIntegration,false);assert.equal(w.visible,false);
 w.webContents.emit('did-finish-load');assert(w.visible);assert.equal(w.rect.width,300);assert.equal(w.rect.height,340);assert.deepEqual(f.parent.rect,original);assert(w.rect.x>=0&&w.rect.y>=0&&w.rect.x+300<=800&&w.rect.y+340<=600);
 const before=w.rect.x;f.parent.rect={...original,x:450};f.parent.emit('move');assert.notEqual(w.rect.x,before);
 w.emit('close',{preventDefault(){}});assert(!w.visible);assert.equal(f.requests.length,0,'closing the card does not answer or cancel its native request');f.parent.emit('move');assert(!w.visible);
 f.c.reveal('fish');assert(w.visible);assert.equal(w.webContents.sent.at(-1).value.reveal,true,'reopening restores the already mounted form');
 f.parent.visible=false;f.parent.emit('hide');assert(!w.visible);f.c.dispose();assert(w.dead);assert.equal(f.handlers.size,0);
});
test('only the exact question window main frame can answer for its bound pet',async()=>{
 const f=fixture();f.c.sync('fish',f.parent,f.q);const w=f.windows[0],handler=f.handlers.get('pet-question:action'),input={...f.q,type:'answer',answers:[{id:'q',selected:['整理']}]};
 assert.equal((await handler({sender:{},senderFrame:w.webContents.mainFrame},input)).ok,false);
 assert.equal((await handler({sender:w.webContents,senderFrame:{url:w.webContents.mainFrame.url}},input)).ok,false);
 assert.equal((await handler({sender:w.webContents,senderFrame:w.webContents.mainFrame},{...input,sessionId:'s2'})).ok,false);
 assert.equal((await handler({sender:w.webContents,senderFrame:w.webContents.mainFrame},input)).ok,true);assert.equal(f.requests[0].id,'fish');
 f.c.sync('fish',f.parent,null);assert(w.dead);assert.equal((await handler({sender:w.webContents,senderFrame:w.webContents.mainFrame},input)).ok,false);f.c.dispose();
});
