'use strict';
// Run with Electron and NEKO_BUBBLE_NATIVE_QA=1; uses only synthetic state.
if(process.env.NEKO_BUBBLE_NATIVE_QA!=='1')throw Error('Set NEKO_BUBBLE_NATIVE_QA=1 for isolated native QA');
const {app,BrowserWindow,ipcMain}=require('electron');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const output=process.env.NEKO_BUBBLE_QA_DIR;if(!output||!path.isAbsolute(output))throw Error('Set an absolute NEKO_BUBBLE_QA_DIR');
fs.mkdirSync(output,{recursive:true});app.setPath('userData',path.join(output,'profile'));
app.on('window-all-closed',()=>{});
const base=path.resolve(__dirname,'../../apps/neko-workbench');
let state,opened=0;const fullText='长回复滚动验收：这一行内容应完整保留，不被窗口裁切。\n'.repeat(90)+'最后一行：全文已到末尾。';
ipcMain.handle('pet:call',(_event,method)=>{if(method==='state')return state;if(method==='open-workbench')opened++;return true;});
const pause=ms=>new Promise(r=>setTimeout(r,ms));
app.whenReady().then(async()=>{
  const results=[];
  for(const backend of ['deepseek-account','chat-api','neko'])for(const zoom of [1,1.25,1.5]){
    state={actors:[{id:'main',name:'大肥鱼',present:true,chatBackend:backend,status:'idle',messages:[],work:{tick:0,state:null},chatReply:{id:'synthetic-long',text:fullText,streaming:false}}],preferences:{},neko:{character:'大肥鱼',connection:'ready'},mainChat:{hasKey:false}};
    const w=new BrowserWindow({show:false,width:Math.ceil(478*zoom),height:Math.ceil(342*zoom),transparent:true,frame:false,webPreferences:{preload:path.join(base,'preload.cjs'),sandbox:true,contextIsolation:true,nodeIntegration:false}});
    const errors=[];w.webContents.on('console-message',(_event,...args)=>{if(args[0]>=3)errors.push(args[1]);});
    await w.loadFile(path.join(base,'index.html'),{query:{view:'pet',actor:'main',stageWidth:'462'}});w.webContents.setZoomFactor(zoom);w.showInactive();
    await w.webContents.executeJavaScript('document.fonts.ready');await pause(120);
    const before=await w.webContents.executeJavaScript(`(()=>{const b=document.querySelector('.pet-bubble'),c=b.querySelector('.pet-bubble-content'),r=b.getBoundingClientRect();return {text:c.textContent,top:r.top,bottom:r.bottom,viewport:innerHeight,scrollHeight:c.scrollHeight,height:c.clientHeight,up:b.querySelector('[aria-label="向上滚动回复"]').disabled,down:b.querySelector('[aria-label="向下滚动回复"]').disabled};})()`);
    assert.equal(before.text,fullText);assert(before.top>=0&&before.bottom<=before.viewport);assert(before.scrollHeight>before.height);assert.equal(before.up,true);assert.equal(before.down,false);assert.deepEqual(errors,[]);
    const down=await w.webContents.executeJavaScript(`(()=>{const b=document.querySelector('[aria-label="向下滚动回复"]'),r=b.getBoundingClientRect();return {x:(r.x+r.width/2)*${zoom},y:(r.y+r.height/2)*${zoom}};})()`);
    w.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,x:Math.round(down.x),y:Math.round(down.y)});w.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,x:Math.round(down.x),y:Math.round(down.y)});await pause(60);
    const clickState=await w.webContents.executeJavaScript(`(()=>{const c=document.querySelector('.pet-bubble-content'),b=document.querySelector('[aria-label="向下滚动回复"]');return {top:c.scrollTop,rect:b.getBoundingClientRect().toJSON(),pointer:getComputedStyle(b).pointerEvents,zoom:devicePixelRatio};})()`);
    assert(clickState.top>0,'native down-button click scrolls '+JSON.stringify({backend,zoom,down,clickState}));
    await w.webContents.executeJavaScript(`(()=>{const c=document.querySelector('.pet-bubble-content');c.scrollTop=c.scrollHeight;c.dispatchEvent(new Event('scroll'));})()`);
    assert(await w.webContents.executeJavaScript("document.querySelector('[aria-label=\"向下滚动回复\"]').disabled"));
    // Appended streaming text must preserve where the user was reading.
    await w.webContents.executeJavaScript("document.querySelector('.pet-bubble-content').scrollTop=20");state.actors[0].chatReply.text=fullText+'流式追加';w.webContents.send('pet:state',state);await pause(50);
    assert.equal(await w.webContents.executeJavaScript("document.querySelector('.pet-bubble-content').scrollTop"),20);
    if(backend==='deepseek-account'&&zoom===1){
      fs.writeFileSync(path.join(output,'bubble-scroll.png'),(await w.webContents.capturePage()).toPNG());
      const point=await w.webContents.executeJavaScript("(()=>{const r=document.querySelector('.character').getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()");
      for(const clickCount of [1,2]){w.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount,...point});w.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount,...point});}await pause(80);assert.equal(opened,1,'double click opens the workbench once');
    }
    state.actors[0].chatReply.text='短回复';w.webContents.send('pet:state',state);await pause(80);
    assert(await w.webContents.executeJavaScript("document.querySelector('.pet-bubble-scroll-controls').hidden"));
    results.push({backend,zoom,fullTextPreserved:true,nativeButtonScrolled:true,insideWindow:true,streamPositionPreserved:true});w.destroy();
  }
  fs.writeFileSync(path.join(output,'results.json'),JSON.stringify({passed:results.length,opened,results},null,2));app.exit(0);
}).catch(error=>{fs.writeFileSync(path.join(output,'error.txt'),error.stack);app.exit(1);});
