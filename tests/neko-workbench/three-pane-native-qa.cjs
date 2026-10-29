'use strict';
// Opt-in Electron integration QA. Uses a temporary profile and synthetic HTTPS
// responses: this checks native view/layout plumbing, not Bilibili playback.
const fs=require('node:fs'),path=require('node:path');
if(!process.versions.electron || process.env.NEKO_THREE_PANE_QA_CHILD!=='1'){
 const {spawnSync}=require('node:child_process'),os=require('node:os'),exe=process.env.NEKO_UNIFIED_QA_ELECTRON;
 if(!exe||!path.isAbsolute(exe))throw Error('Set NEKO_UNIFIED_QA_ELECTRON to a raw Electron executable');
 const dir=fs.mkdtempSync(path.join(process.platform==='darwin'?'/private/tmp':os.tmpdir(),'neko-three-pane-qa-'));
 fs.writeFileSync(path.join(dir,'package.json'),JSON.stringify({name:'neko-three-pane-qa',version:'1.0.0',main:'bootstrap.cjs'}));
 fs.writeFileSync(path.join(dir,'bootstrap.cjs'),'require('+JSON.stringify(__filename)+');');
 const env={...process.env,NEKO_THREE_PANE_QA_CHILD:'1',NEKO_THREE_PANE_Q_DIR:dir};delete env.ELECTRON_RUN_AS_NODE;
 try{const result=spawnSync(exe,[dir],{env,cwd:dir,encoding:'utf8',timeout:60000});if(result.stdout)process.stdout.write(result.stdout);if(result.stderr)process.stderr.write(result.stderr);if(result.error)console.error(result.error);process.exitCode=result.status===0?0:1;}finally{fs.rmSync(dir,{recursive:true,force:true});}
}else{
 const {app,BrowserWindow,WebContentsView,session,ipcMain}=require('electron'),assert=require('node:assert/strict');
 const dir=process.env.NEKO_THREE_PANE_Q_DIR,src=path.join(__dirname,'../../apps/neko-workbench');
 app.setName('Neko Three Pane Isolation QA');app.setPath('home',dir);app.setPath('userData',path.join(dir,'profile'));app.setPath('sessionData',path.join(dir,'session'));app.commandLine.appendSwitch('host-resolver-rules','MAP * ~NOTFOUND');
 const {createSocialController,BILIBILI_PARTITION}=require(path.join(src,'community-config.cjs'));
 const {createNativeDividerController}=require(path.join(src,'native-divider-controller.cjs'));
 const {validate}=require(path.join(src,'pane-layout.cjs'));
 async function run(){
  const hits=[];session.fromPartition(BILIBILI_PARTITION).protocol.handle('https',request=>{hits.push(request.url);return new Response('<!doctype html><title>synthetic Bilibili fixture</title><p>LOCAL FIXTURE, NOT A LIVE VIDEO</p>',{headers:{'content-type':'text/html;charset=utf-8'}})});
  const preload=path.join(dir,'preload.cjs');fs.writeFileSync(preload,`const {contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('qa',{workspace:r=>ipcRenderer.invoke('qa:workspace',r),community:r=>ipcRenderer.invoke('qa:community',r),divider:r=>ipcRenderer.invoke('qa:divider',r),subscribeDivider:cb=>{const f=(_e,v)=>cb(v);ipcRenderer.on('workbench:divider-event',f);return()=>ipcRenderer.removeListener('workbench:divider-event',f)},subscribeCommunity:cb=>{const f=(_e,v)=>cb(v);ipcRenderer.on('qa:community-state',f);return()=>ipcRenderer.removeListener('qa:community-state',f)},companion:async()=>({}),getState:async()=>({workspaceRevision:0,companion:{ready:true,messages:[]}}),action:async()=>({})});`);
  const host=new BrowserWindow({width:1200,height:800,useContentSize:true,show:true,title:'Neko Three Pane Isolation QA',webPreferences:{preload,sandbox:true,contextIsolation:true,nodeIntegration:false}});
  let saved={enabled:false,side:'workspace',left:'coding',right:null,ratio:.5};const divider=createNativeDividerController({WebContentsView,ipcMain});divider.bind(host);divider.setEnabled(true);
  const social=createSocialController({WebContentsView,env:{},openExternal:async()=>{throw Error('blocked')},copyText:()=>{},onState:(_host,state)=>{if(!host.isDestroyed())host.webContents.send('qa:community-state',state)}});
  ipcMain.handle('qa:workspace',(event,r)=>{if(event.sender!==host.webContents)throw Error('bad sender');if(r.action==='pane-layout')return saved;if(r.action==='set-pane-layout')return saved=validate(r.layout);if(r.action==='state')return {officeMode:'dsh',seats:[]};if(r.action==='catalog')return {sessions:[{id:'qa',provider:'dsh',cwd:'/demo',title:'synthetic'}],providers:{dsh:'ready'}};if(r.action==='codex-state')return {items:[],approvals:[]};return {};});
  ipcMain.handle('qa:community',(event,r)=>{if(event.sender!==host.webContents)throw Error('bad sender');return social.action(host,r)});
  ipcMain.handle('qa:divider',(event,r)=>{if(event.sender!==host.webContents)throw Error('bad sender');return divider.place(host,r)});
  const html=`<!doctype html><html><head><style>html,body{height:100%;margin:0}.neko-side-rail{position:fixed;left:0;top:0;width:64px;height:100%;z-index:40}#frame{display:grid;grid-template-columns:220px minmax(0,1fr);margin-left:64px;width:calc(100% - 64px);height:100%}#side-track{position:relative;height:100%;width:220px;box-sizing:border-box}[data-slot=sidebar],[data-slot="sidebar.settings"]{display:contents}.settingsArea{position:absolute;bottom:0;height:124px;width:100%}.neko-companion-dock{position:absolute;bottom:0;height:120px;width:100%}.fixture_centerCol_hash42{display:flex;flex-direction:column;min-width:0;overflow:hidden}#draft{width:90%;height:90px}</style></head><body><aside class="neko-side-rail" data-neko-side-rail></aside><div id="frame"><div id="side-track"><aside data-slot="sidebar"><div>synthetic sidebar</div><div class="settingsArea"><div data-slot="sidebar.settings"><div class="neko-companion-dock">synthetic companion</div><div data-slot="settings.launcher"></div></div></div></aside></div><main class="fixture_centerCol_hash42"><textarea id="draft">synthetic coding draft</textarea></main></div></body></html>`;
  const read=x=>host.webContents.executeJavaScript(x,true);const wait=async(fn,label)=>{for(let i=0;i<150;i++){if(await fn())return;await new Promise(r=>setTimeout(r,40));}throw Error('Timed out: '+label)};
  const file=name=>fs.readFileSync(path.join(src,'embedded-dsh',name),'utf8');
  try{
   await host.loadURL('data:text/html;charset=utf-8,'+encodeURIComponent(html));
   await read(file('chatroom-preview-source.js')+'\n'+file('workspace-shell-source.js')+`\nwindow.disposeShell=installWorkspaceShell({window,document,bridge:window.qa,avatar:()=>'',locateSidebar:()=>({root:document.querySelector('#side-track')}),cssText:${JSON.stringify(file('workspace-shell-source.css'))}});true`);
   await read(file('unified-layout-source.js')+`\nwindow.disposeUnified=installUnifiedLayout({window,document,bridge:window.qa,cssText:${JSON.stringify(file('unified-layout-source.css'))}});true`);
   await wait(()=>read("!!document.querySelector('.neko-layout-entry')"),'layout entry');
   await read("document.querySelector('.neko-layout-entry').click();[...document.querySelectorAll('.neko-flex-config button')].find(x=>x.textContent.includes('左侧聊天室')).click();document.querySelector('.neko-unified-config .close').click()");
   await wait(()=>read("document.body.hasAttribute('data-neko-flex-mode') && !document.querySelector('.neko-chatroom-preview').hidden && !document.querySelector('.neko-flex-divider').hidden"),'three-pane render');
   await wait(()=>host.contentView.children.some(v=>v.webContents?.getURL().startsWith('https://m.bilibili.com/')),'mock video native view');
   await wait(()=>host.contentView.children.filter(v=>v.webContents?.getURL().includes('native-divider.html')).length===2,'two native divider views');
   const video=host.contentView.children.find(v=>v.webContents?.getURL().startsWith('https://m.bilibili.com/'));await wait(()=>video.webContents.getURL().startsWith('https://m.bilibili.com/'),'video ready');
   await video.webContents.executeJavaScript("document.body.dataset.qaMarker='preserved'",true);
   const geometry=()=>read(`(()=>{let r=x=>{let b=x.getBoundingClientRect();return {x:b.x,y:b.y,width:b.width,height:b.height}};return {social:r(document.querySelector('.neko-chatroom-preview')),coding:r(document.querySelector('[data-neko-flex-coding]')),video:r(document.querySelector('[data-neko-unified-slot=left]')),bars:[...document.querySelectorAll('.neko-unified-divider:not([hidden])')].map(x=>({orientation:x.dataset.orientation,rect:r(x)})),draft:document.querySelector('#draft').value}})()`);
   let before=await geometry();assert.equal(before.bars.length,2);assert.deepEqual(before.bars.map(x=>x.orientation).sort(),['horizontal','vertical']);assert(before.social.width>100&&before.coding.width>100&&before.video.width>100,'three areas visible');assert(before.video.y<before.coding.y,'video above coding');assert(before.social.x<before.video.x,'social left of video');assert.equal(before.draft,'synthetic coding draft');
   const vb0=video.getBounds();await read("document.querySelector('.neko-unified-divider:not(.neko-flex-divider)').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',shiftKey:true,bubbles:true}));document.querySelector('.neko-flex-divider').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',shiftKey:true,bubbles:true}))");
   await wait(()=>saved.flex?.rootRatio>.55&&saved.flex?.stackRatio>.5,'both separator keys save geometry in one tick');await wait(()=>video.getBounds().x>vb0.x && video.getBounds().height>vb0.height,'native video follows split resizing');
   const beforeSwap=video.getBounds();
   await read(`(()=>{const handles=[...document.querySelectorAll('.neko-flex-move')];const src=handles.find(n=>n.title.includes('B站视频'));const transfer=new DataTransfer();src.dispatchEvent(new DragEvent('dragstart',{bubbles:true,dataTransfer:transfer}));const zone=[...document.querySelectorAll('.neko-flex-drop')].find(n=>n.textContent.includes('工作区'));zone.dispatchEvent(new DragEvent('dragover',{bubbles:true,cancelable:true,dataTransfer:transfer}));zone.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:transfer}));src.dispatchEvent(new DragEvent('dragend',{bubbles:true,dataTransfer:transfer}));})()`);
   await wait(()=>saved.flex?.slots.join(',')==='social,coding,bilibili','drag swap persisted');
   await wait(()=>host.contentView.children.includes(video)&&video.getBounds().y>beforeSwap.y,'native video moves to lower slot');
   const after=await geometry();assert(after.video.y>after.coding.y,'video below coding after drag');assert.equal(await video.webContents.executeJavaScript('document.body.dataset.qaMarker',true),'preserved');assert.equal(after.draft,'synthetic coding draft');assert.equal(hits.length,1,'swap must not reload the native video');
   console.log(JSON.stringify({ok:true,electron:process.versions.electron,syntheticBilibili:true,realPlaybackTested:false,realNativeViews:true,threeAreas:true,barOrientations:before.bars.map(x=>x.orientation),nativeVideoBefore:vb0,nativeVideoAfterSwap:video.getBounds(),swapUsesSyntheticDragEvents:true,videoDocumentReused:true,draftPreserved:true}));
  }finally{divider.dispose();social.dispose();if(!host.isDestroyed())host.destroy();for(const x of ['qa:workspace','qa:community','qa:divider'])ipcMain.removeHandler(x);}
 }
 app.whenReady().then(run).then(()=>app.quit()).catch(e=>{console.error(e.stack||String(e));app.exit(1)});
}
