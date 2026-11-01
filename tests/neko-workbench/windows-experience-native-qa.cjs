'use strict';
// Synthetic work sessions and pages, using real Electron views and Windows hit tests.
const fs=require('node:fs'),path=require('node:path');
if(!process.versions.electron||process.env.NEKO_WIN_EXPERIENCE_CHILD!=='1'){
  const {spawnSync}=require('node:child_process'),os=require('node:os');
  const electron=process.env.NEKO_UNIFIED_QA_ELECTRON;
  if(!electron||!path.isAbsolute(electron))throw Error('Set NEKO_UNIFIED_QA_ELECTRON');
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'neko-win-experience-'));
  try{
    fs.writeFileSync(path.join(dir,'package.json'),JSON.stringify({name:'neko-win-experience-qa',version:'1.0.0',main:'bootstrap.cjs'}));
    fs.writeFileSync(path.join(dir,'bootstrap.cjs'),'require('+JSON.stringify(__filename)+');');
    const result=spawnSync(electron,[dir],{cwd:dir,env:{NEKO_WIN_EXPERIENCE_CHILD:'1',NEKO_WIN_EXPERIENCE_DIR:dir,NEKO_WIN_EXPERIENCE_SCREENSHOT:process.env.NEKO_WIN_EXPERIENCE_SCREENSHOT||''},encoding:'utf8',timeout:45000,windowsHide:true});
    if(result.stdout)process.stdout.write(result.stdout);if(result.stderr)process.stderr.write(result.stderr);if(result.error)throw result.error;process.exitCode=result.status===0?0:1;
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
}else{
  const {app,BrowserWindow,BaseWindow,WebContentsView,ipcMain,session}=require('electron'),assert=require('node:assert/strict'),{execFileSync}=require('node:child_process');
  const {createSocialController,BILIBILI_PARTITION}=require('../../apps/neko-workbench/community-config.cjs');
  const {createNativeComposerController}=require('../../apps/neko-workbench/native-composer-controller.cjs');
  const dir=process.env.NEKO_WIN_EXPERIENCE_DIR,sourceRoot=path.resolve(__dirname,'../../apps/neko-workbench/embedded-dsh');
  for(const name of ['profile','session'])fs.mkdirSync(path.join(dir,name));
  app.setPath('userData',path.join(dir,'profile'));app.setPath('sessionData',path.join(dir,'session'));
  app.commandLine.appendSwitch('host-resolver-rules','MAP * ~NOTFOUND');app.commandLine.appendSwitch('disable-background-networking');
  const read=name=>fs.readFileSync(path.join(sourceRoot,name),'utf8');
  app.whenReady().then(async()=>{
    session.fromPartition(BILIBILI_PARTITION).protocol.handle('https',()=>new Response('<!doctype html><title>Synthetic video</title><body style="margin:0;background:#78b9d4;height:100vh;font:24px system-ui">Synthetic Bilibili page</body>',{headers:{'content-type':'text/html'}}));
    const preload=path.join(dir,'host-preload.cjs');
    fs.writeFileSync(preload,"const {contextBridge,ipcRenderer}=require('electron');const subscribe=(name,fn)=>{const listener=(_,r)=>fn(r);ipcRenderer.on(name,listener);return()=>ipcRenderer.removeListener(name,listener)};contextBridge.exposeInMainWorld('qaNative',{community:r=>ipcRenderer.invoke('qa:community',r),composer:r=>ipcRenderer.invoke('qa:composer',r),subscribe:fn=>subscribe('workbench:native-composer-event',fn),subscribeCommunity:fn=>subscribe('qa:community-state',fn)});");
    const host=new BrowserWindow({x:40,y:40,width:1100,height:780,useContentSize:true,show:false,title:'Neko isolated Windows experience QA',webPreferences:{preload,sandbox:true,contextIsolation:true,nodeIntegration:false}});
    let social,composer;
    composer=createNativeComposerController({WebContentsView,ipcMain,getOverlayParent:()=>social.overlayWindow});
    social=createSocialController({WebContentsView,BaseWindow,env:{},onOverlayClosing:w=>composer.releaseParent(w),onState:(_host,value)=>{host.webContents.send('qa:community-state',value);composer.raise();}});
    const handle=(name,fn)=>ipcMain.handle(name,(event,r)=>{assert.equal(event.sender,host.webContents);assert.equal(event.senderFrame,host.webContents.mainFrame);return fn(r);});
    handle('qa:community',r=>social.action(host,r));
    handle('qa:composer',r=>{if(r.action==='update')return composer.update(r.state);const result=composer.place(host,r);composer.setEnabled(r.action==='place');return result;});
    const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms)),run=code=>host.webContents.executeJavaScript(code,true);
    const until=async check=>{for(let i=0;i<100;i++){if(await check())return;await wait(30);}throw Error('Native fixture condition timed out: '+check.toString().slice(0,180));};
    const html='<!doctype html><html><head><style>body{margin:0;background:#edf4fb;font:14px system-ui}#frame{display:grid;grid-template-columns:280px minmax(0,1fr) 0px;height:100vh;margin-left:64px}#track{position:relative;min-width:0}aside[data-slot=sidebar]{height:100%;display:flex;flex-direction:column}footer{margin-top:auto}main{min-width:0;overflow:hidden}[data-composer-seat]{padding:12px}textarea{max-width:100%}</style></head><body><div id="frame"><div id="track"><aside data-slot="sidebar"><div data-slot="sidebar.workspaces">Native project fixture</div><footer><div data-slot="settings.launcher"><button aria-haspopup="menu" data-collapsed data-signed-out>Account fixture</button></div></footer></aside></div><main class="x_centerCol_H"><div data-composer-seat><div data-composer-card><textarea>retained work draft</textarea></div></div></main><div></div></div></body></html>';
    try{
      await host.loadURL('data:text/html;charset=utf-8,'+encodeURIComponent(html));host.show();host.focus();
      await run('document.querySelector("#frame").style.gridTemplateColumns="280px minmax(0px, 1fr) 0px"');
      const setup=`
        window.qaSelected='one';window.qaSends=[];window.qaNativeCalls=[];window.qaSelectionListeners=new Set();
        const bindings=new Map(),shells=new Map();
        for(const id of ['one','two']){let draft={draft:'',draftRev:1,phase:'plain',attachmentIds:[],occurrences:[]};const listeners=new Set();bindings.set(id,{sessionId:id,session:{sessionId:id,getSnapshot:()=>({}),subscribe:()=>()=>{}}});shells.set(id,{state:{getSnapshot:()=>draft,subscribe:fn=>{listeners.add(fn);return()=>listeners.delete(fn)}},actions:{setDraft:v=>{draft={...draft,draft:v,draftRev:draft.draftRev+1};for(const fn of listeners)fn()},persistDraft(){},submit:()=>window.qaSends.push({id,text:draft.draft})}});}
        let layout={officeMode:'dsh',activeSeatId:null,seats:[{id:'seat-1',name:'DSH',provider:'dsh',projectRoot:''}],companionHistoryOpen:false};
        window.qaComposerCalls=[];
        window.nekoWorkbench={getState:async()=>({workspaceRoot:'/fixture',companion:{ready:true,messages:[]}}),action:async()=>({}),companion:async()=>({}),divider:async()=>({ok:true}),community:async r=>{window.qaNativeCalls.push(r);return window.qaNative.community(r)},nativeComposer:r=>{window.qaComposerCalls.push(r.action);return window.qaNative.composer(r)},subscribeNativeComposer:fn=>window.qaNative.subscribe(fn),subscribeCommunity:fn=>window.qaNative.subscribeCommunity(fn),lobby:async()=>({ok:true,state:{connection:'unconfigured',auth:{status:'signed-out'},messages:[],members:[]}}),workspace:async r=>r.action==='state'?layout:r.action==='update'?Object.assign(layout,r.patch):r.action==='pane-layout'?{enabled:false,side:'workspace',right:'coding',ratio:.5}:r.action==='video-platform'?{platform:'bilibili'}:r.action==='codex-state'?{items:[],approvals:[]}:r.action==='catalog'?{sessions:['one','two'].map(id=>({id,provider:'dsh',cwd:'/fixture/'+id,title:'Session '+id})),providers:{dsh:'ready'}}:null};
        ${read('side-rail-source.js')}
        ${read('chatroom-preview-source.js')}
        ${read('native-composer-source.js')}
        ${read('workspace-shell-source.js')}
        ${read('unified-layout-source.js')}
        window.qaStopRail=installWorkbenchSideRail({window,document,bridge:window.nekoWorkbench,openBilibiliHome:async()=>document.dispatchEvent(new CustomEvent('neko-video-open',{detail:{platform:'bilibili'}})),cssText:${JSON.stringify(read('side-rail-source.css'))}});
        window.qaStopShell=installWorkspaceShell({window,document,bridge:window.nekoWorkbench,cssText:${JSON.stringify(read('workspace-shell-source.css')+'\n'+read('chatroom-preview-source.css'))},avatar:()=>'',locateSidebar:()=>({root:document.querySelector('[data-slot="sidebar"]')}),getDshSelection:()=>({sessionId:window.qaSelected}),hasDshActiveSession:()=>true,openDshSession:async id=>{window.qaSelected=id;for(const fn of window.qaSelectionListeners)fn()},nativeComposerBindings:{getSelection:()=>({sessionId:window.qaSelected}),getMainSessionId:()=>window.qaSelected,getBinding:id=>bindings.get(id),getShell:(_,id)=>shells.get(id),subscribeSelection:fn=>{window.qaSelectionListeners.add(fn);return()=>window.qaSelectionListeners.delete(fn)}}});
        window.qaStopLayout=installUnifiedLayout({window,document,bridge:window.nekoWorkbench,cssText:${JSON.stringify(read('unified-layout-source.css'))}});
        window.qaOriginalChat=document.querySelector('.neko-companion-form textarea');window.qaOriginalChat.value='Retained private draft';
      `;
      await run(setup);
      host.showInactive();
      await wait(150);
      assert(host.isVisible(),'native fixture host is visible');
      await until(async()=>host.contentView.children.some(v=>v.webContents?.getURL().endsWith('native-composer.html')));
      let input=host.contentView.children.find(v=>v.webContents?.getURL().endsWith('native-composer.html'));
      await until(()=>input.webContents.executeJavaScript('document.querySelectorAll("#records-list button").length === 2'));
      await input.webContents.executeJavaScript('document.querySelectorAll("#records-list button")[1].click()');
      await until(()=>run('window.qaSelected === "two"'));
      assert.equal(await run('document.body.hasAttribute("data-neko-workspace-collapsed")'),true);
      await until(()=>input.webContents.executeJavaScript('document.querySelector("#session-label").textContent.includes("Session two")'));
      await run('document.querySelector("[data-neko-public-room]").click()');await wait(100);
      const lobby=await run('(()=>{const p=document.querySelector(".neko-lobby-panel"),r=p.getBoundingClientRect();return {open:!p.hidden,left:r.left,right:r.right,workInert:document.querySelector("main").hasAttribute("inert")}})()');
      assert(lobby.open);assert(lobby.left>=64);assert(lobby.right<1100);assert(!lobby.workInert);assert(host.contentView.children.includes(input));
      await run('document.querySelector(".neko-lobby-back").click();document.dispatchEvent(new CustomEvent("neko-video-open",{detail:{platform:"bilibili"}}))');
      await until(async()=>social.overlayWindow?.isVisible());
      const hitRoot=(x,y)=>{
        const code='using System;using System.Runtime.InteropServices;public class Hit{[StructLayout(LayoutKind.Sequential)]public struct P{public int X;public int Y;}[DllImport("user32.dll")]static extern IntPtr WindowFromPoint(P p);[DllImport("user32.dll")]static extern IntPtr GetAncestor(IntPtr h,uint f);public static long Root(int x,int y){return GetAncestor(WindowFromPoint(new P{X=x,Y=y}),2).ToInt64();}}';
        return execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',"Add-Type -TypeDefinition '"+code+"';[Hit]::Root("+Math.round(x)+','+Math.round(y)+')'],{encoding:'utf8',windowsHide:true}).trim();
      };
      for(const zoom of [1,1.25,1.5]){
        host.webContents.setZoomFactor(zoom);await wait(150);host.focus();
        await run('document.querySelector(".neko-rail-companion").click()');
        await until(()=>run('document.querySelector(".neko-companion-dock").hasAttribute("data-neko-companion-rail-chat")'));
        await wait(120);
        await run('document.querySelector(".neko-rail-companion").dispatchEvent(new KeyboardEvent("keydown",{key:"ArrowDown",bubbles:true,cancelable:true}))');await wait(80);
        assert.equal(await run('(()=>{const p=document.querySelector(".neko-rail-companion").getBoundingClientRect(),d=document.querySelector(".neko-companion-dock").getBoundingClientRect();return Math.abs(d.top-Math.max(16,Math.min(p.top,innerHeight-d.height-16)))<2})()'),true,'companion chat follows keyboard movement within the viewport');
        const popup=await run('(()=>{const d=document.querySelector(".neko-companion-dock"),i=d.querySelector("textarea"),r=i.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2,inside:r.width>0&&r.left>=64&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight,same:i===window.qaOriginalChat,draft:i.value,count:document.querySelectorAll(".neko-companion-character").length}})()');
        assert(popup.inside);assert(popup.same);assert.equal(popup.draft,'Retained private draft');assert.equal(popup.count,1);
        if(process.platform==='win32'){
          const origin=host.getContentBounds();
          assert.equal(hitRoot(origin.x+popup.x*zoom,origin.y+popup.y*zoom),host.getNativeWindowHandle().readBigUInt64LE().toString(),'native video shape passes companion input clicks through to the workbench');
          const video=social.overlayWindow.getContentBounds();
          assert.equal(hitRoot(video.x+20,video.y+20),social.overlayWindow.getNativeWindowHandle().readBigUInt64LE().toString(),'the opaque video remains in its native owner outside the cutout');
        }
        if(zoom===1&&process.env.NEKO_WIN_EXPERIENCE_SCREENSHOT)fs.writeFileSync(process.env.NEKO_WIN_EXPERIENCE_SCREENSHOT,(await host.webContents.capturePage()).toPNG());
        await run('document.querySelector(".neko-companion-rail-close").click()');await wait(80);
      }
      await run('document.querySelector(".neko-lobby-switch").click()');
      await until(async()=>!social.overlayWindow&&host.contentView.children.includes(input));
      assert.equal(await run('!document.querySelector(".neko-lobby-panel").hidden && document.body.hasAttribute("data-neko-workspace-collapsed")'),true,'returning from video opens the left lobby and retains the same working float');
      await run('document.querySelector(".neko-lobby-back").click();document.querySelector(".neko-room-entry").click()');await wait(100);
      assert.equal(await run('window.qaOriginalChat===document.querySelector(".neko-companion-form textarea") && window.qaOriginalChat.value==="Retained private draft" && !document.querySelector(".neko-companion-dock").hasAttribute("popover")'),true);
      console.log(JSON.stringify({ok:true,synthetic:true,sessionSelectionStaysFloating:true,leftLobbyKeepsWorkInput:true,companionDraftRetained:true,nativeMouseTargets:[1,1.25,1.5],popoverRestored:true}));
    }finally{
      try{await run('window.qaStopLayout?.();window.qaStopShell?.();window.qaStopRail?.()');}catch{}
      composer.dispose();social.dispose();host.destroy();ipcMain.removeHandler('qa:community');ipcMain.removeHandler('qa:composer');
    }
    app.quit();
  }).catch(error=>{console.error(error.stack||error);app.exit(1);});
}
