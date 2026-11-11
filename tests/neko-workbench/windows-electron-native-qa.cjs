'use strict';
// Opt-in real Electron check. Uses synthetic sessions/sites, an isolated profile,
// no listening ports, no provider calls, and exits after verification.
const fs=require('node:fs'),path=require('node:path');
if(!process.versions.electron||process.env.NEKO_WINDOWS_QA_CHILD!=='1'){
  const {spawnSync}=require('node:child_process'),os=require('node:os');
  const runtime=process.env.NEKO_UNIFIED_QA_ELECTRON;
  if(!runtime||!path.isAbsolute(runtime))throw Error('Set NEKO_UNIFIED_QA_ELECTRON to an Electron executable');
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'neko-windows-electron-'));
  try{
    fs.writeFileSync(path.join(dir,'package.json'),JSON.stringify({name:'neko-windows-electron-qa',version:'1.0.0',main:'bootstrap.cjs'}));
    fs.writeFileSync(path.join(dir,'bootstrap.cjs'),'require('+JSON.stringify(__filename)+');');
    const env={...process.env,NEKO_WINDOWS_QA_CHILD:'1',NEKO_WINDOWS_QA_DIR:dir};delete env.ELECTRON_RUN_AS_NODE;
    const result=spawnSync(runtime,[dir],{cwd:dir,env,encoding:'utf8',timeout:45000,windowsHide:true});
    if(result.stdout)process.stdout.write(result.stdout);if(result.stderr)process.stderr.write(result.stderr);
    if(result.error)throw result.error;process.exitCode=result.status===0?0:1;
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
}else{
  const {app,BrowserWindow,WebContentsView,ipcMain,session}=require('electron'),assert=require('node:assert/strict');
  const {createSocialController,BILIBILI_PARTITION}=require('../../apps/neko-workbench/community-config.cjs');
  const {createNativeComposerController}=require('../../apps/neko-workbench/native-composer-controller.cjs');
  const {workbenchWindowOptions,updateWorkbenchWindowTheme}=require('../../apps/neko-workbench/workbench-window.cjs');
  const dir=process.env.NEKO_WINDOWS_QA_DIR,src=path.resolve(__dirname,'../../apps/neko-workbench'),read=name=>fs.readFileSync(path.join(src,'embedded-dsh',name),'utf8');
  app.setPath('userData',path.join(dir,'profile'));app.setPath('sessionData',path.join(dir,'session'));
  for(const flag of ['disable-background-networking','disable-component-update','disable-sync','no-first-run'])app.commandLine.appendSwitch(flag);
  app.commandLine.appendSwitch('host-resolver-rules','MAP * ~NOTFOUND');
  const timer=setTimeout(()=>app.exit(1),35000);
  app.whenReady().then(async()=>{
    const synthetic="<!doctype html><meta charset=\"utf-8\"><style>*{box-sizing:border-box}body{margin:0;background:#fff;color:#28364d;font:13px/1.6 \"Segoe UI\",\"Microsoft YaHei UI\",sans-serif}header{display:flex;align-items:center;justify-content:space-between;padding:18px 24px;border-bottom:1px solid #edf1f6}header strong{font-size:14px}header small{color:#8b97a9;font-size:10px}main{padding:24px}.player{position:relative;display:grid;place-items:center;aspect-ratio:16/9;overflow:hidden;background:radial-gradient(ellipse at 82% 15%,#5367a5aa,transparent 54%),radial-gradient(ellipse at 5% 100%,#527c9d88,transparent 55%),#202d48;border-radius:16px;color:#fff}.player:before,.player:after{content:\"\";position:absolute;width:75%;height:80%;border:1px solid #ffffff0d;border-radius:50%;transform:rotate(-25deg)}.player:after{width:110%;height:125%}.play{position:relative;display:grid;place-items:center;width:56px;height:56px;border:1px solid #ffffff55;border-radius:50%;background:#ffffff10}.play svg{width:22px;fill:#fff;margin-left:4px}h1{font-size:16px;font-weight:600;margin:20px 0 5px}p{margin:0;color:#8b97a9;font-size:11px}.cards{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:22px}.cards div{padding:14px 16px;border:1px solid #e8edf5;border-radius:12px;background:#f9fbfe}.cards strong{font-size:12px;font-weight:600}.cards small{display:block;margin-top:4px;color:#95a0b1;font-size:10px}</style><header><strong>视频预览</strong><small>本地合成页面</small></header><main><div class=\"player\"><span class=\"play\"><svg viewBox=\"0 0 24 24\"><path d=\"m7 4 14 8-14 8Z\"/></svg></span></div><h1>一起看看，发现新的灵感</h1><p>本地合成内容，仅用于界面检查</p><div class=\"cards\"><div><strong>舒适的内容空间</strong><small>查看页面与窗口比例</small></div><div><strong>随时继续工作</strong><small>检查输入区与内容的留白</small></div></div></main>";
    await session.fromPartition(BILIBILI_PARTITION).protocol.handle('https',()=>new Response(synthetic,{headers:{'content-type':'text/html'}}));
    const preload=path.join(dir,'preload.cjs');
    fs.writeFileSync(preload,"const {contextBridge,ipcRenderer}=require('electron');const sub=(name,fn)=>{const h=(_,v)=>fn(v);ipcRenderer.on(name,h);return()=>ipcRenderer.removeListener(name,h)};contextBridge.exposeInMainWorld('qa',{theme:dark=>ipcRenderer.invoke('qa:theme',dark),community:r=>ipcRenderer.invoke('qa:community',r),composer:r=>ipcRenderer.invoke('qa:composer',r),subscribe:fn=>sub('workbench:native-composer-event',fn),subscribeCommunity:fn=>sub('qa:community-state',fn)});");
    const host=new BrowserWindow({...workbenchWindowOptions(process.platform,{x:40,y:40,width:1180,height:800}),useContentSize:true,show:false,title:'NEKOfuns · Windows 隔离验收',autoHideMenuBar:true,webPreferences:{preload,sandbox:true,contextIsolation:true,nodeIntegration:false}});
    ipcMain.handle('qa:theme',(event,dark)=>{assert.equal(event.sender,host.webContents);updateWorkbenchWindowTheme(host,dark);return true;});
    const composer=createNativeComposerController({WebContentsView,ipcMain});
    const social=createSocialController({WebContentsView,env:{},onState:(_host,value)=>{if(!host.isDestroyed()){host.webContents.send('qa:community-state',value);composer.raise();}}});
    ipcMain.handle('qa:community',(event,r)=>{assert.equal(event.sender,host.webContents);return social.action(host,r);});
    ipcMain.handle('qa:composer',(event,r)=>{assert.equal(event.sender,host.webContents);if(r.action==='update')return composer.update(r.state);const result=composer.place(host,r);composer.setEnabled(r.action==='place');return result;});
    const run=code=>host.webContents.executeJavaScript(code,true),wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
    const until=async(check,label)=>{for(let i=0;i<100;i++){if(await check())return;await wait(35);}throw Error('Timed out: '+label);};
    const output=process.env.NEKO_WINDOWS_QA_OUTPUT;if(output)fs.mkdirSync(output,{recursive:true});
    const capture=path.join(dir,'capture-window.ps1');
    if(output&&process.platform==='win32')fs.writeFileSync(capture,`param([long]$WindowHandle,[string]$OutputPath)
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @'
using System;using System.Runtime.InteropServices;public class Capture { [StructLayout(LayoutKind.Sequential)] public struct R{public int L,T,Right,B;} [DllImport("user32.dll")]public static extern bool GetWindowRect(IntPtr h,out R r); [DllImport("user32.dll")]public static extern bool PrintWindow(IntPtr h,IntPtr dc,uint flags); }
'@
$r=New-Object Capture+R
[Capture]::GetWindowRect([IntPtr]$WindowHandle,[ref]$r)|Out-Null
$bitmap=New-Object Drawing.Bitmap(($r.Right-$r.L),($r.B-$r.T))
$graphics=[Drawing.Graphics]::FromImage($bitmap)
$dc=$graphics.GetHdc()
try{if(-not [Capture]::PrintWindow([IntPtr]$WindowHandle,$dc,2)){throw 'Window capture failed'}}finally{$graphics.ReleaseHdc($dc);$graphics.Dispose()}
try{$bitmap.Save($OutputPath,[Drawing.Imaging.ImageFormat]::Png)}finally{$bitmap.Dispose()}
`);
    const avatar='data:image/webp;base64,'+fs.readFileSync(path.join(src,'embedded-dsh/assets/avatars/bigfish.webp')).toString('base64');
    const companionPoster='data:image/webp;base64,'+fs.readFileSync(path.join(src,'embedded-dsh/assets/account/bigfish-idle.webp')).toString('base64');
    try{
      const html='<!doctype html><meta charset="utf-8"><style>html,body{margin:0;height:100%;background:#edf2fc;font:14px system-ui}#frame{display:grid;grid-template-columns:280px minmax(0,1fr) 0px;height:100vh}#track{min-width:0}aside[data-slot=sidebar]{height:100%;display:flex;flex-direction:column;background:var(--dsw-specific-sidebar-fill,#f4f7fc)}footer{margin-top:auto}main{min-width:0;overflow:hidden}[data-composer-seat]{padding:12px}textarea{max-width:100%}</style><div id="frame"><div id="track"><aside data-slot="sidebar"><div data-slot="sidebar.workspaces">本地测试项目</div><footer><div data-slot="settings.launcher"><button aria-haspopup="menu" data-collapsed data-signed-out>测试账号</button></div></footer></aside></div><main class="qa_centerCol_H"><div data-composer-seat><div data-composer-card><textarea>保留的工作草稿</textarea></div></div></main><div></div></div>';
      await host.loadURL('data:text/html;charset=utf-8,'+encodeURIComponent(html));host.showInactive();
      await run(`
        window.qaDraft={draft:'保留的工作草稿',draftRev:1,phase:'plain',attachmentIds:[],occurrences:[]};window.qaListeners=new Set();window.qaSent=[];
        const binding={sessionId:'test-session',session:{sessionId:'test-session',getSnapshot:()=>({}),subscribe:()=>()=>{}}};
        const inputShell={state:{getSnapshot:()=>window.qaDraft,subscribe:fn=>{window.qaListeners.add(fn);return()=>window.qaListeners.delete(fn)}},actions:{setDraft:value=>{window.qaDraft={...window.qaDraft,draft:value,draftRev:window.qaDraft.draftRev+1};for(const fn of window.qaListeners)fn()},persistDraft(){},submit:()=>window.qaSent.push(window.qaDraft.draft)}};
        const layout={officeMode:'dsh',activeSeatId:null,seats:[{id:'seat-1',name:'DSH',avatarId:'bigfish',provider:'dsh',projectRoot:null}]};
        window.nekoWorkbench={platform:'win32',windowTheme:dark=>window.qa.theme(dark),getState:async()=>({workspaceRoot:'/synthetic',companion:{ready:true,messages:[]}}),action:async()=>({}),companion:async()=>({}),divider:async()=>({ok:true}),community:r=>window.qa.community(r),nativeComposer:r=>window.qa.composer(r),subscribeNativeComposer:fn=>window.qa.subscribe(fn),subscribeCommunity:fn=>window.qa.subscribeCommunity(fn),lobby:async()=>({ok:true,state:{connection:'unconfigured',auth:{status:'signed-out'},messages:[],members:[]}}),workspace:async r=>r.action==='state'?layout:r.action==='update'?Object.assign(layout,r.patch):r.action==='pane-layout'?{enabled:false,side:'workspace',right:'coding',ratio:.5}:r.action==='video-platform'?{platform:'bilibili'}:r.action==='codex-state'?{items:[],approvals:[]}:r.action==='catalog'?{sessions:[{id:'test-session',provider:'dsh',cwd:'/synthetic',title:'本地验收会话'}],providers:{dsh:'ready'}}:null};
        ${read('side-rail-source.js')}
        ${read('chatroom-preview-source.js')}
        ${read('native-composer-source.js')}
        ${read('workspace-shell-source.js')}
        ${read('unified-layout-source.js')}
        window.stopRail=installWorkbenchSideRail({window,document,bridge:window.nekoWorkbench,openBilibiliHome:async()=>{},fishAvatar:${JSON.stringify(avatar)},accountAvatar:${JSON.stringify(avatar)},cssText:${JSON.stringify(read('side-rail-source.css'))}});
        window.stopShell=installWorkspaceShell({window,document,bridge:window.nekoWorkbench,avatar:()=>${JSON.stringify(avatar)},companionPosterSrc:${JSON.stringify(companionPoster)},locateSidebar:()=>({root:document.querySelector('[data-slot="sidebar"]')}),getDshSelection:()=>({sessionId:'test-session'}),hasDshActiveSession:()=>true,nativeComposerBindings:{getSelection:()=>({sessionId:'test-session'}),getMainSessionId:()=>'test-session',getBinding:()=>binding,getShell:()=>inputShell},cssText:${JSON.stringify(read('workspace-shell-source.css')+'\n'+read('chatroom-preview-source.css'))}});
        window.stopLayout=installUnifiedLayout({window,document,bridge:window.nekoWorkbench,cssText:${JSON.stringify(read('unified-layout-source.css'))}});
        true;
      `);
      const findInput=()=>host.contentView.children.find(v=>v.webContents?.getURL().endsWith('native-composer.html'));
      await run('document.querySelector(".neko-fixed-scene-entry").click()');
      await until(()=>!!findInput(),'floating input');
      await until(()=>host.contentView.children.some(v=>v.webContents?.getURL().startsWith('https://www.bilibili.com')),'synthetic video');
      let video=host.contentView.children.find(v=>v.webContents?.getURL().startsWith('https://www.bilibili.com'));
      await video.webContents.executeJavaScript('window.preservedMarker="same-page"');
      const measures=[];
      for(const [width,height,zoom] of [[1180,800,1],[1100,680,1.25],[1000,640,1.5]]){
        host.webContents.setZoomFactor(zoom);host.setContentSize(width,height);await wait(300);
        // A small window presents the existing tabs instead of a crushed split.
        const tabbed=await run('!document.querySelector(".neko-flex-tabs").hidden');
        if(tabbed)await run('[...document.querySelectorAll(".neko-flex-tabs button")].find(b=>/B站/.test(b.textContent)).click()');
        await until(()=>host.contentView.children.includes(video)&&!!findInput(),'native children after resizing');
        const input=findInput();await until(()=>input.webContents.getZoomFactor()===zoom,'input zoom');
        const vb=video.getBounds(),ib=input.getBounds();
        const chrome=await run('(()=>{const h=document.querySelector("[data-neko-window-titlebar]"),r=h.getBoundingClientRect(),rail=document.querySelector(".neko-side-rail").getBoundingClientRect(),p=document.querySelector("[data-neko-unified-slot=left] header"),b=p.querySelector("button").getBoundingClientRect(),brand=h.firstElementChild.getBoundingClientRect(),safe=navigator.windowControlsOverlay?.getTitlebarAreaRect();return {top:r.top,bottom:r.bottom,railTop:rail.top,titleFont:getComputedStyle(p.querySelector("strong")).fontSize,buttonHeight:b.height,brandRight:brand.right,safeRight:safe?.right,viewportWidth:innerWidth,clientWidth:document.documentElement.clientWidth}})()');
        assert.equal(chrome.top,0);assert(chrome.bottom>0&&chrome.railTop>=chrome.bottom-1,'rail clears native titlebar');
        assert.equal(chrome.titleFont,'14px');assert(chrome.buttonHeight>=32,'toolbar buttons retain usable targets');
        assert.equal(chrome.viewportWidth,chrome.clientWidth,'titlebar must not create an outer page scrollbar');
        if(Number.isFinite(chrome.safeRight))assert(chrome.brandRight<=chrome.safeRight+1,'brand clears native caption controls');
        assert(vb.width/zoom>=600||tabbed,'video is usable or tabbed');
        assert(vb.y+vb.height<=ib.y-7*zoom,'video controls remain above work input');
        assert(ib.x>=0&&ib.y>=0&&ib.x+ib.width<=width&&ib.y+ib.height<=height);
        assert.equal(await video.webContents.executeJavaScript('window.preservedMarker'),'same-page');
        const ui=await input.webContents.executeJavaScript('(()=>{const ids=["target","composer","status"],rects=ids.map(id=>{const r=document.getElementById(id).getBoundingClientRect();return {id,top:r.top,bottom:r.bottom}});return {value:document.getElementById("message").value,rects,height:innerHeight,copy:document.getElementById("copy").title}})()');
        assert.equal(ui.value,'保留的工作草稿');assert.match(ui.copy,/Ctrl\+C/);
        assert.equal(await input.webContents.executeJavaScript('getComputedStyle(document.getElementById("copy")).display'),'none','recovery-only controls stay hidden');
        assert(ui.rects.filter(r=>r.bottom>r.top).every(r=>r.top>=0&&r.bottom<=ui.height+1),'input labels fit');
        // Reordering an already attached view must keep the focused input.
        host.focus();input.webContents.focus();await wait(60);composer.raise();assert(input.webContents.isFocused());
        measures.push({width,height,zoom,tabbed,video:vb,input:ib,chrome});
        if(output){
          const file=path.join(output,'windows-'+width+'-'+zoom+'.png');
          if(process.platform==='win32')await new Promise((resolve,reject)=>require('node:child_process').execFile('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',capture,'-WindowHandle',host.getNativeWindowHandle().readBigUInt64LE().toString(),'-OutputPath',file],{windowsHide:true,timeout:10000},error=>error?reject(error):resolve()));
          else fs.writeFileSync(file,(await host.webContents.capturePage()).toPNG());
        }
      }
      host.maximize();await until(()=>host.isMaximized(),'native maximize');await wait(150);
      host.unmaximize();await until(()=>!host.isMaximized()&&!!findInput(),'native unmaximize');await wait(150);
      host.minimize();await until(()=>!host.contentView.children.includes(video),'minimized video detached');assert(video.webContents.isAudioMuted());
      host.restore();await until(()=>host.contentView.children.includes(video)&&!!findInput(),'restore children');assert.equal(await video.webContents.executeJavaScript('window.preservedMarker'),'same-page');assert(!video.webContents.isAudioMuted());
      assert.equal(await run('window.qaSent.length'),0,'verification sends no task');
      if(output)fs.writeFileSync(path.join(output,'measurements.json'),JSON.stringify(measures,null,2));
      console.log(JSON.stringify({ok:true,synthetic:true,electron:process.versions.electron,measurements:measures,restoredWithoutReload:true,focusedInputRetained:true}));
    }finally{
      try{await run('window.stopLayout?.();window.stopShell?.();window.stopRail?.()');}catch{}
      composer.dispose();social.dispose();host.destroy();ipcMain.removeHandler('qa:community');ipcMain.removeHandler('qa:composer');ipcMain.removeHandler('qa:theme');clearTimeout(timer);app.quit();
    }
  }).catch(error=>{console.error(error.stack);clearTimeout(timer);app.exit(1);});
}
