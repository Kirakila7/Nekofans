'use strict';
// Opt-in Electron integration QA. Uses a temporary profile and synthetic HTTPS
// responses: this checks native view/layout plumbing, not Bilibili playback.
const fs=require('node:fs'),path=require('node:path');
if(!process.versions.electron || process.env.NEKO_THREE_PANE_QA_CHILD!=='1'){
 const {spawnSync}=require('node:child_process'),os=require('node:os'),exe=process.env.NEKO_UNIFIED_QA_ELECTRON;
 if(!exe||!path.isAbsolute(exe))throw Error('Set NEKO_UNIFIED_QA_ELECTRON to a raw Electron executable');
 const dir=fs.mkdtempSync(path.join(process.platform==='darwin'?'/private/tmp':os.tmpdir(),'neko-three-pane-collapse-qa-'));
 fs.writeFileSync(path.join(dir,'package.json'),JSON.stringify({name:'neko-three-pane-collapse-qa',version:'1.0.0',main:'bootstrap.cjs'}));
 fs.writeFileSync(path.join(dir,'bootstrap.cjs'),'require('+JSON.stringify(__filename)+');');
 const env={...process.env,NEKO_THREE_PANE_QA_CHILD:'1',NEKO_THREE_PANE_Q_DIR:dir};delete env.ELECTRON_RUN_AS_NODE;
 try{const result=spawnSync(exe,[dir],{env,cwd:dir,encoding:'utf8',timeout:60000});if(result.stdout)process.stdout.write(result.stdout);if(result.stderr)process.stderr.write(result.stderr);if(result.error)console.error(result.error);process.exitCode=result.status===0?0:1;}finally{fs.rmSync(dir,{recursive:true,force:true});}
}else{
 const {app,BrowserWindow,WebContentsView,session,ipcMain}=require('electron'),assert=require('node:assert/strict');
 const dir=process.env.NEKO_THREE_PANE_Q_DIR,src=path.join(__dirname,'../../apps/neko-workbench');
 app.setName('Neko Three Pane Collapse Isolation QA');app.setPath('home',dir);app.setPath('userData',path.join(dir,'profile'));app.setPath('sessionData',path.join(dir,'session'));app.commandLine.appendSwitch('host-resolver-rules','MAP * ~NOTFOUND');
 const {createSocialController,BILIBILI_PARTITION,YOUTUBE_PARTITION}=require(path.join(src,'community-config.cjs'));
 const youtube=process.env.NEKO_QA_VIDEO_SITE==='youtube', videoUrl=youtube?'https://www.youtube.com/embed/':'https://www.bilibili.com/';
 const {createNativeDividerController}=require(path.join(src,'native-divider-controller.cjs'));
 const {createNativeComposerController}=require(path.join(src,'native-composer-controller.cjs'));
 const {validate}=require(path.join(src,'pane-layout.cjs'));
 async function run(){
  const hits=[];session.fromPartition(youtube?YOUTUBE_PARTITION:BILIBILI_PARTITION).protocol.handle('https',request=>{hits.push(request.url);return new Response('<!doctype html><title>synthetic Bilibili fixture</title><p>LOCAL FIXTURE, NOT A LIVE VIDEO</p>',{headers:{'content-type':'text/html;charset=utf-8'}})});
  const preload=path.join(dir,'preload.cjs');fs.writeFileSync(preload,`const {contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('qa',{workspace:r=>ipcRenderer.invoke('qa:workspace',r),community:r=>ipcRenderer.invoke('qa:community',r),nativeComposer:r=>ipcRenderer.invoke('qa:composer',r),subscribeNativeComposer:cb=>{const f=(_e,v)=>cb(v);ipcRenderer.on('workbench:native-composer-event',f);return()=>ipcRenderer.removeListener('workbench:native-composer-event',f)},divider:r=>ipcRenderer.invoke('qa:divider',r),subscribeDivider:cb=>{const f=(_e,v)=>cb(v);ipcRenderer.on('workbench:divider-event',f);return()=>ipcRenderer.removeListener('workbench:divider-event',f)},subscribeCommunity:cb=>{const f=(_e,v)=>cb(v);ipcRenderer.on('qa:community-state',f);return()=>ipcRenderer.removeListener('qa:community-state',f)},companion:async()=>({}),getState:async()=>({workspaceRevision:0,companion:{ready:true,messages:[]}}),action:async()=>({})});`);
  const host=new BrowserWindow({width:1200,height:800,useContentSize:true,show:true,title:'Neko Three Pane Collapse Isolation QA',webPreferences:{preload,sandbox:true,contextIsolation:true,nodeIntegration:false}});
  let saved={enabled:false,side:'workspace',left:'coding',right:null,ratio:.5};const divider=createNativeDividerController({WebContentsView,ipcMain});divider.bind(host);divider.setEnabled(true);const composer=createNativeComposerController({WebContentsView,ipcMain});composer.bind(host);
  const social=createSocialController({WebContentsView,env:{},openExternal:async()=>{throw Error('blocked')},copyText:()=>{},onState:(_host,state)=>{if(!host.isDestroyed()){host.webContents.send('qa:community-state',state);composer.setEnabled(social.hasVisibleView);composer.raise();}}});
  ipcMain.handle('qa:workspace',(event,r)=>{if(event.sender!==host.webContents)throw Error('bad sender');if(r.action==='pane-layout')return saved;if(r.action==='set-pane-layout')return saved=validate(r.layout);if(r.action==='state')return {officeMode:'dsh',seats:[]};if(r.action==='catalog')return {sessions:[{id:'qa',provider:'dsh',cwd:'/demo',title:'synthetic'}],providers:{dsh:'ready'}};if(r.action==='codex-state')return {items:[],approvals:[]};return {};});
  ipcMain.handle('qa:community',async(event,r)=>{if(event.sender!==host.webContents)throw Error('bad sender');try{return await social.action(host,r)}finally{composer.setEnabled(social.hasVisibleView);composer.raise();}});
  ipcMain.handle('qa:composer',async(event,r)=>{if(event.sender!==host.webContents)throw Error('bad sender');if(r.action==='update'){if(r.state?.settledEditId)await new Promise(resolve=>setTimeout(resolve,300));return composer.update(r.state);} const result=composer.place(host,r);composer.setEnabled(social.hasVisibleView);composer.raise();return result;});
  ipcMain.handle('qa:divider',(event,r)=>{if(event.sender!==host.webContents)throw Error('bad sender');return divider.place(host,r)});
  const html=`<!doctype html><html><head><style>html,body{height:100%;margin:0}.neko-side-rail{position:fixed;left:0;top:0;width:64px;height:100%;z-index:40}#frame{display:grid;grid-template-columns:220px minmax(0,1fr);margin-left:64px;width:calc(100% - 64px);height:100%}#side-track{position:relative;height:100%;width:220px;box-sizing:border-box}[data-slot=sidebar],[data-slot="sidebar.settings"]{display:contents}.settingsArea{position:absolute;bottom:0;height:124px;width:100%}.neko-companion-dock{position:absolute;bottom:0;height:120px;width:100%}.fixture_centerCol_hash42{display:flex;flex-direction:column;min-width:0;overflow:hidden}#draft{width:90%;height:32px;box-sizing:border-box}</style></head><body><aside class="neko-side-rail" data-neko-side-rail></aside><div id="frame"><div id="side-track"><aside data-slot="sidebar"><div>synthetic sidebar</div><div class="settingsArea"><div data-slot="sidebar.settings"><div class="neko-companion-dock">synthetic companion</div><div data-slot="settings.launcher"></div></div></div></aside></div><main class="fixture_centerCol_hash42" data-neko-chat-center><div data-composer-seat><div class="fixture_composerStack"><div><div data-composer-card><div data-input-scroll><textarea id="draft" data-composer-input>synthetic coding draft</textarea></div><div class="fixture_row"><button id="send">发送</button></div></div></div></div></div></main></div></body></html>`;
  const read=x=>host.webContents.executeJavaScript(x,true);const wait=async(fn,label)=>{for(let i=0;i<150;i++){if(await fn())return;await new Promise(r=>setTimeout(r,40));}throw Error('Timed out: '+label)};
  const file=name=>fs.readFileSync(path.join(src,'embedded-dsh',name),'utf8');
  try{
   await host.loadURL('data:text/html;charset=utf-8,'+encodeURIComponent(html));
   await read(file('chatroom-preview-source.js')+'\n'+file('native-composer-source.js')+'\n'+file('workspace-shell-source.js')+`\nwindow.qaAvailable=true;window.qaSelectionListeners=[];window.qaShellListeners=[];window.qaState={draft:'synthetic coding draft',draftRev:1,phase:'plain',occurrences:[],attachmentIds:[]};window.qaBinding={sessionId:'qa',session:{sessionId:'qa'}};window.qaShell={state:{getSnapshot:()=>window.qaState,subscribe:cb=>{window.qaShellListeners.push(cb);return()=>{};}},actions:{setDraft:text=>{window.qaState={...window.qaState,draft:text,draftRev:window.qaState.draftRev+1};document.querySelector('#draft').value=text;window.qaShellListeners.forEach(cb=>cb());},persistDraft:()=>{},submit:()=>{window.qaSubmitted=(window.qaSubmitted||0)+1}}};window.qaSetAvailable=value=>{window.qaAvailable=value;window.qaSelectionListeners.forEach(cb=>cb())};window.disposeShell=installWorkspaceShell({window,document,bridge:window.qa,avatar:()=>'',mountHome:stage=>{stage.innerHTML='<p id=qa-home>synthetic local home</p>';return ()=>stage.replaceChildren()},locateSidebar:()=>({root:document.querySelector('#side-track')}),nativeComposerBindings:{getSelection:()=>window.qaAvailable?{sessionId:'qa'}:null,getMainSessionId:()=>window.qaAvailable?'qa':null,getBinding:id=>id==='qa'?window.qaBinding:null,getShell:()=>window.qaShell,subscribeSelection:cb=>{window.qaSelectionListeners.push(cb);return()=>{}}},cssText:${JSON.stringify(file('workspace-shell-source.css'))}});true`);
   await read(file('unified-layout-source.js')+`\nwindow.disposeUnified=installUnifiedLayout({window,document,bridge:window.qa,cssText:${JSON.stringify(file('unified-layout-source.css'))}});true`);
   await wait(()=>read("!!document.querySelector('.neko-layout-entry')"),'layout entry');
   await read("document.querySelector('.neko-layout-entry').click();[...document.querySelectorAll('.neko-flex-config button')].find(x=>x.textContent.includes('左侧聊天室')).click();document.querySelector('.neko-unified-config .close').click()");
   await wait(()=>read("document.body.hasAttribute('data-neko-flex-mode') && !document.querySelector('.neko-chatroom-preview').hidden && !document.querySelector('.neko-flex-divider').hidden"),'three-pane render');
   await read("document.querySelector('button[aria-label*=\"我的小窝\"]').click();true");
   await wait(()=>read("!!document.querySelector('#qa-home')"),'synthetic local home');
   if (youtube) await read("document.dispatchEvent(new CustomEvent('neko-video-open',{detail:{platform:'youtube'}}));true");
   assert(await read("!!document.querySelector('#qa-home') && !document.querySelector('[data-neko-chatroom-preview]').hidden"),'the local home stays mounted while the video pane changes');
   await wait(()=>host.contentView.children.some(v=>v.webContents?.getURL().startsWith(videoUrl)),'mock video native view');
   await wait(()=>host.contentView.children.filter(v=>v.webContents?.getURL().includes('native-divider.html')).length===2,'two native divider views');
   const video=host.contentView.children.find(v=>v.webContents?.getURL().startsWith(videoUrl));await wait(()=>video.webContents.getURL().startsWith(videoUrl),'video ready');
   if (!youtube) assert(!/Mobile|Electron/i.test(video.webContents.getUserAgent()),'desktop homepage must use a sanitized desktop user agent');
   await video.webContents.executeJavaScript("document.body.dataset.qaMarker='preserved'",true);
   const geometry=()=>read(`(()=>{let r=x=>{let b=x.getBoundingClientRect();return {x:b.x,y:b.y,width:b.width,height:b.height}};return {social:r(document.querySelector('.neko-chatroom-preview')),coding:r(document.querySelector('[data-neko-flex-coding]')),video:r(document.querySelector('[data-neko-unified-slot=left]')),bars:[...document.querySelectorAll('.neko-unified-divider:not([hidden])')].map(x=>({orientation:x.dataset.orientation,rect:r(x)})),draft:document.querySelector('#draft').value}})()`);
   let before=await geometry();assert.equal(before.bars.length,2);assert.deepEqual(before.bars.map(x=>x.orientation).sort(),['horizontal','vertical']);assert(before.social.width>100&&before.coding.width>100&&before.video.width>100,'three areas visible');assert(before.video.y<before.coding.y,'video above coding');assert(before.social.x<before.video.x,'social left of video');assert.equal(before.draft,'synthetic coding draft');
   const vb0=video.getBounds();await read("document.querySelector('.neko-unified-divider:not(.neko-flex-divider)').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',shiftKey:true,bubbles:true}));document.querySelector('.neko-flex-divider').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',shiftKey:true,bubbles:true}))");
   await wait(()=>saved.flex?.rootRatio>.55&&saved.flex?.stackRatio>.5,'both separator keys save geometry in one tick');await wait(()=>video.getBounds().x>vb0.x && video.getBounds().height>vb0.height,'native video follows split resizing');
   // Keep a single real Bilibili WebContentsView across both orientations.
   // The page is a synthetic HTTPS fixture; no real account or video is used.
   await read("window.qaDraftNode=document.querySelector('#draft'); window.qaComposerNode=document.querySelector('[data-composer-seat]'); true");
   const readUIAfterRestore=()=>read("({draft:document.querySelector('#draft').value,same:window.qaDraftNode===document.querySelector('#draft')})");
   const findComposer=()=>host.contentView.children.find(v=>v.webContents?.getURL().endsWith('native-composer.html'));
   async function checkCollapsed(axis, useMouse=false){
     const beforeRatio=saved.flex.stackRatio,previousVideo=video.getBounds();
     if(useMouse){
       // This is a synthetic DOM pointer sequence; native child view ordering,
       // geometry and focus are verified separately in Electron below.
       await read(`(()=>{const h=document.querySelector('.neko-flex-divider'),a=h.getBoundingClientRect(),c=document.querySelector('[data-neko-flex-coding]').getBoundingClientRect(),x=a.x+a.width/2,y=a.y+a.height/2;h.setPointerCapture=()=>{};for(const [type,cx,cy] of [['pointerdown',x,y],['pointermove',${axis==='horizontal'?'c.right-2':'x'},${axis==='vertical'?'c.bottom-2':'y'}],['pointerup',${axis==='horizontal'?'c.right-2':'x'},${axis==='vertical'?'c.bottom-2':'y'}]])h.dispatchEvent(new PointerEvent(type,{bubbles:true,button:0,pointerId:7,clientX:cx,clientY:cy}));})()`);
     } else await read("document.querySelector('.neko-flex-divider').dispatchEvent(new KeyboardEvent('keydown',{key:'End',bubbles:true}));true");
     await wait(()=>read("document.body.hasAttribute('data-neko-flex-workspace-collapsed')"),axis+' compact workspace');
     await wait(()=>!!findComposer(),axis+' native composer child');
     const native=findComposer();
     await wait(async()=>{let b=video.getBounds(),input=await native.webContents.executeJavaScript("({disabled:document.querySelector('#message').disabled,value:document.querySelector('#message').value})");return !input.disabled&&input.value==='synthetic coding draft'&&(axis==='vertical'?b.height>previousVideo.height+60:b.width>previousVideo.width+60)},axis+' full native view and bound composer');
     const b=video.getBounds(), c=native.getBounds(), children=host.contentView.children;
     assert(children.indexOf(native)>children.indexOf(video),'floating native composer must be above B站 child view');
     assert(c.x>=b.x&&c.y>=b.y&&c.x+c.width<=b.x+b.width&&c.y+c.height<=b.y+b.height+2,'native composer is actually over the video area');
     assert(c.width>=100&&c.height>=32,'floating composer has usable bounds');
     native.webContents.focus(); native.webContents.sendInputEvent({type:'mouseDown',x:100,y:35,button:'left',clickCount:1}); native.webContents.sendInputEvent({type:'mouseUp',x:100,y:35,button:'left',clickCount:1});
     await wait(()=>native.webContents.executeJavaScript("document.activeElement===document.querySelector('#message')"),axis+' floating input focus');
     assert.equal(await video.webContents.executeJavaScript('document.body.dataset.qaMarker',true),'preserved');assert.equal(hits.length,1,'collapse must not reload B站');
     await native.webContents.executeJavaScript("document.querySelector('#expand').click();true");
     await wait(()=>read("!document.body.hasAttribute('data-neko-flex-workspace-collapsed')"),axis+' restore');
     await wait(()=>!host.contentView.children.includes(native),axis+' floating view removed');
     await wait(()=>{const b=video.getBounds();return axis==='vertical'?b.height<=previousVideo.height+3:b.width<=previousVideo.width+3},axis+' video returns to prior split');
     const restored=await readUIAfterRestore();assert.equal(restored.draft,'synthetic coding draft');assert(restored.same);assert(Math.abs(saved.flex.stackRatio-beforeRatio)<.011,'restore keeps the pre-collapse ratio');
     assert.equal(await video.webContents.executeJavaScript('document.body.dataset.qaMarker',true),'preserved');assert.equal(hits.length,1,'restore must not reload B站');
     return {axis,method:useMouse?'synthetic-pointer':'keyboard',composerBounds:c,videoBounds:b,composerAboveVideo:true,focused:true,draftRetained:true};
   }
   const vertical=await checkCollapsed('vertical',true);
   await checkCollapsed('vertical');
   // Change only axis while retaining the same three views and user draft.
   await read("document.querySelector('.neko-layout-entry').click();[...document.querySelectorAll('.neko-flex-config button')].find(x=>x.textContent==='左右排列').click();document.querySelector('.neko-unified-config .close').click();true");
   await wait(()=>saved.flex?.stackAxis==='x'&&saved.flex?.slots.join(',')==='social,bilibili,coding','horizontal arrangement');
   await wait(()=>video.getBounds().width<vertical.videoBounds.width-60,'video shrinks to horizontal split before collapse');
   const horizontal=await checkCollapsed('horizontal',true);
   await checkCollapsed('horizontal');
   // Edit then immediately expand under slow edit acknowledgements. The native
   // input must keep its final text and the overlay must not vanish too early.
   await read("document.querySelector('.neko-flex-divider').dispatchEvent(new KeyboardEvent('keydown',{key:'End',bubbles:true}));true");
   await wait(()=>!!findComposer(),'editable composer');const edited=findComposer();
   await wait(()=>edited.webContents.executeJavaScript("!document.querySelector('#message').disabled"),'editable input ready');
   await edited.webContents.executeJavaScript("(()=>{const m=document.querySelector('#message');m.value='synthetic changed draft';m.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('#expand').click()})()");
   assert(await read("document.body.hasAttribute('data-neko-flex-workspace-collapsed')"),'overlay stays open until draft acknowledgement');
   await wait(()=>read("!document.body.hasAttribute('data-neko-flex-workspace-collapsed')"),'expand after delayed draft acknowledgement');
   assert.equal(await read("document.querySelector('#draft').value"),'synthetic changed draft');
   // No available work session: floating input must be disabled, recoverable,
   // and must not destroy the native draft retained by the workspace.
   await read("window.qaSetAvailable(false);true");
   await read("document.querySelector('.neko-flex-divider').dispatchEvent(new KeyboardEvent('keydown',{key:'End',bubbles:true}));true");
   await wait(()=>!!findComposer(),'unavailable composer');
   const unavailable=findComposer();await wait(()=>unavailable.webContents.executeJavaScript("document.querySelector('#message').disabled"),'unavailable input disabled');
   assert.equal(await read("document.querySelector('#draft').value"),'synthetic changed draft');
   await unavailable.webContents.executeJavaScript("document.querySelector('#expand').click();true");await wait(()=>read("!document.body.hasAttribute('data-neko-flex-workspace-collapsed')"),'unavailable restore');
   assert.equal(await read("document.querySelector('#draft').value"),'synthetic changed draft');
   console.log(JSON.stringify({ok:true,electron:process.versions.electron,isolatedProfile:true,syntheticVideo:youtube?'youtube':'bilibili',realPlaybackTested:false,realNativeViews:true,vertical,horizontal,videoDocumentReused:true,unavailableSessionDisabledAndRecoverable:true,delayedEditBeforeExpand:true,localHomeRetained:true}));
  }finally{composer.dispose();divider.dispose();social.dispose();if(!host.isDestroyed())host.destroy();for(const x of ['qa:workspace','qa:community','qa:divider','qa:composer'])ipcMain.removeHandler(x);}
 }
 app.whenReady().then(run).then(()=>app.quit()).catch(e=>{console.error(e.stack||String(e));app.exit(1)});
}
