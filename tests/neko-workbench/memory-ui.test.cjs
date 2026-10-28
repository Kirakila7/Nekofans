const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawn}=require('node:child_process'),{pathToFileURL}=require('node:url');
const root=path.resolve(__dirname,'../..'),electron=process.env.NEKO_WORKBENCH_ELECTRON;
test('actual Chromium memory panel: native-only controls, source safety, drafts, confirmations and encrypted-key projection',{skip:!electron,timeout:30000},async()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'neko-memory-ui-'));
  fs.writeFileSync(path.join(directory,'index.html'),'<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="'+pathToFileURL(path.join(root,'apps/neko-workbench/style.css')).href+'"><div id="root" style="height:100vh"></div><script src="'+pathToFileURL(path.join(root,'apps/neko-workbench/main-chat-ui.js')).href+'"></script>');
  const renderer=async function(){
    const delay=()=>new Promise(r=>setTimeout(r,50)),calls=[];let listener;
    const event={eventId:'first',itemId:'synthetic-item',personaId:'bigfish',origin:'neko',operation:'upsert',parents:[],occurredAt:'2026-10-28T00:00:00Z',value:{kind:'fact',text:'<img src=x onerror="window.bad=true">合成记忆',visibility:'private',certainty:'candidate',evidenceRefs:['synthetic-source']}};
    const state={items:[],summaries:[],memoryModel:{useChatApi:true,hasKey:false},replication:{mode:'neko',autoSync:true,configured:true,pending:0,conflicts:0,providerStates:{diary:'已连接',neko:'已连接'},error:'',restorePoints:[],records:[{itemId:event.itemId,heads:[event],value:event.value,deleted:false,conflict:false}]}};
    const pet={onState(fn){listener=fn;return()=>{listener=null;};},async call(method,input){
      if(method==='chat-history')return [];
      if(method==='chat-memory-read')return structuredClone(state);
      if(method==='chat-memory-action'){calls.push(structuredClone(input));if(input.action==='sync')return {ok:false,message:'合成离线：记录已保留'};
        if(input.action==='event-confirm'){state.replication.records[0].value.certainty='user-confirmed';state.replication.records[0].heads=[{...event,eventId:'confirmed'}];}
        if(input.action==='configure-neko')state.memoryModel={useChatApi:input.useChatApi,hasKey:true};return {ok:true};}
      throw Error('unexpected fixture IPC');}};
    const dispose=window.WorkbenchChatUI.mountMemory(document.getElementById('root'),pet);await delay();
    const check=(ok,message)=>{if(!ok)throw Error(message);};
    check(!document.querySelector('img')&&!window.bad,'source content executed');
    check(!document.querySelector('.memory-mode,.switch-memory,.auto-memory-sync,.disable-neko-memory'),'dual provider controls remain');document.querySelector('.sync-memory').click();await delay();
    check(!document.body.textContent.includes('日记模式'),'diary fallback remains');check(document.querySelector('[role=status]').textContent.includes('记录已保留'),'failure hidden');
    const edit=document.querySelector('.memory-items textarea');edit.value='保留的编辑草稿';edit.dispatchEvent(new Event('input',{bubbles:true}));
    listener({mainChat:{backend:'chat-api',chat:{phase:'idle'},memorySystem:{revision:2,pending:1}}});await delay();check(document.querySelector('.memory-items textarea').value==='保留的编辑草稿','background refresh lost draft');
    [...document.querySelectorAll('button')].find(b=>b.textContent==='确认').click();await delay();check(calls.some(c=>c.action==='event-confirm'&&c.revisionIds.join()==='first'),'revision binding missing');
    const reuse=document.querySelector('.memory-reuse-chat');reuse.checked=false;reuse.dispatchEvent(new Event('change'));
    const form=document.querySelector('.memory-model-form');for(const [name,value] of Object.entries({baseUrl:'https://example.invalid/v1',model:'synthetic-model',apiKey:'synthetic-ui-secret'}))form.elements.namedItem(name).value=value;
    form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));await delay();check(form.elements.namedItem('apiKey').value==='','key remains in form');check(!document.body.textContent.includes('synthetic-ui-secret'),'key echoed');
    check(calls.some(c=>c.action==='configure-neko'&&c.useChatApi===false&&c.key.action==='replace'),'independent model configuration missing');dispose();
    return {checks:8,actions:calls.map(c=>c.action)};
  };
  const script=`const {app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(path.join(directory,'profile'))});app.commandLine.appendSwitch('disable-gpu');app.whenReady().then(async()=>{let window;try{window=new BrowserWindow({show:false,width:620,height:680,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});await window.loadFile(${JSON.stringify(path.join(directory,'index.html'))});const result=await window.webContents.executeJavaScript('('+${JSON.stringify(renderer.toString())}+')()');if(process.env.NEKO_MEMORY_UI_SCREENSHOT){await window.webContents.executeJavaScript("document.querySelector('.memory-model-settings').open=true");require('node:fs').writeFileSync(process.env.NEKO_MEMORY_UI_SCREENSHOT,(await window.webContents.capturePage()).toPNG());}console.log('MEMORY_UI_RESULT '+JSON.stringify(result));app.exit(0);}catch(error){console.log('MEMORY_UI_FAILED '+error.message);app.exit(1);}});`;
  fs.writeFileSync(path.join(directory,'main.cjs'),script);
  const environment={...process.env};delete environment.ELECTRON_RUN_AS_NODE;
  const child=spawn(electron,[path.join(directory,'main.cjs')],{windowsHide:true,stdio:['ignore','pipe','pipe'],env:environment});let output='';child.stdout.on('data',c=>output+=c);child.stderr.on('data',c=>output=(output+c.toString()).slice(-4000));
  const timer=setTimeout(()=>child.kill(),20000);
  try{const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);});assert.equal(code,0,output.slice(-1000));assert(output.includes('"checks":8'));}
  finally{clearTimeout(timer);fs.rmSync(directory,{recursive:true,force:true});}
});
