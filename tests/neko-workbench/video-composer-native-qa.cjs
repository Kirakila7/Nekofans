'use strict';
// Isolated native video/composer integration. All site content is synthesized.
const fs=require('node:fs'),path=require('node:path');
if(!process.versions.electron||process.env.NEKO_VIDEO_COMPOSER_QA_CHILD!=='1'){
  const os=require('node:os'),{spawnSync}=require('node:child_process');
  const electron=process.env.NEKO_UNIFIED_QA_ELECTRON;if(!electron||!path.isAbsolute(electron))throw Error('Set NEKO_UNIFIED_QA_ELECTRON');
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'neko-video-composer-qa-'));
  try{
    fs.writeFileSync(path.join(dir,'package.json'),JSON.stringify({name:'neko-video-composer-qa',version:'1.0.0',main:'bootstrap.cjs'}));
    fs.writeFileSync(path.join(dir,'bootstrap.cjs'),'require('+JSON.stringify(__filename)+');');
    const hold=Math.min(60000,Math.max(0,Number(process.env.NEKO_VIDEO_QA_HOLD_MS)||0));
    const r=spawnSync(electron,[dir],{cwd:dir,env:{NEKO_VIDEO_COMPOSER_QA_CHILD:'1',NEKO_VIDEO_COMPOSER_QA_DIR:dir,NEKO_VIDEO_QA_HOLD_MS:String(hold)},encoding:'utf8',timeout:hold+30000,windowsHide:true});
    if(r.stdout)process.stdout.write(r.stdout);if(r.stderr)process.stderr.write(r.stderr);if(r.error)throw r.error;process.exitCode=r.status===0?0:1;
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
}else{
  const {app,BrowserWindow,BaseWindow,WebContentsView,ipcMain,session}=require('electron'),assert=require('node:assert/strict');
  const {createSocialController,BILIBILI_PARTITION}=require('../../apps/neko-workbench/community-config.cjs');
  const {createNativeComposerController}=require('../../apps/neko-workbench/native-composer-controller.cjs');
  const dir=process.env.NEKO_VIDEO_COMPOSER_QA_DIR;
  for(const name of ['profile','session'])fs.mkdirSync(path.join(dir,name));
  app.setPath('userData',path.join(dir,'profile'));app.setPath('sessionData',path.join(dir,'session'));
  app.commandLine.appendSwitch('host-resolver-rules','MAP * ~NOTFOUND');app.commandLine.appendSwitch('disable-background-networking');
  app.whenReady().then(async()=>{
    app.setAccessibilitySupportEnabled(true);
    const options=[],windows=[],wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
    function CheckedWindow(value){options.push(value);const w=new BaseWindow({...value,title:'Neko Video Layer QA'});windows.push(w);return w;}
    session.fromPartition(BILIBILI_PARTITION).protocol.handle('https',()=>new Response('<!doctype html><title>Local video fixture</title><body style="margin:0;background:#74bada;height:100vh">Local video fixture</body>',{headers:{'content-type':'text/html'}}));
    const preload=path.join(dir,'host-preload.cjs');
    fs.writeFileSync(preload,"const {contextBridge,ipcRenderer}=require('electron');const events=[];ipcRenderer.on('workbench:native-composer-event',(_,v)=>events.push(v));contextBridge.exposeInMainWorld('qaEvents',{read:()=>events});");
    const host=new BrowserWindow({width:1100,height:780,useContentSize:true,show:false,title:'Neko Video Host QA',webPreferences:{preload,sandbox:true,contextIsolation:true,nodeIntegration:false}});
    await host.loadURL('data:text/html,<title>Neko Video Host QA</title><body style="background:%23f7fbff">Local workbench</body>');host.showInactive();
    let social;
    const composer=createNativeComposerController({WebContentsView,ipcMain,getOverlayParent:()=>social.overlayWindow});
    social=createSocialController({WebContentsView,BaseWindow:CheckedWindow,env:{},openExternal:async()=>{throw Error('External navigation prohibited');},onOverlayClosing:w=>composer.releaseParent(w)});
    let input=null;
    try{
      for(const zoom of [1,1.25,1.5]){
        host.webContents.setZoomFactor(zoom);
        const width=1100/zoom,height=780/zoom;
        const bounds={x:64,y:56,width:width-64,height:height-56};
        const divider={x:width-8,y:56,width:8,height:height-56};
        await social.action(host,{action:'open',site:'bilibili',slot:'side',bounds,holes:[divider]});
        const owner=social.overlayWindow,root=host.getContentBounds(),area=owner.getContentBounds(),video=social.view;
        assert.equal(area.x,root.x+Math.round(64*zoom));assert.equal(area.y,root.y+Math.round(56*zoom));
        assert.equal(area.x+area.width,root.x+1100);assert.equal(area.y+area.height,root.y+780,'video edge matches workbench content at each zoom');
        assert.equal(options.at(-1).thickFrame,false);assert.equal(options.at(-1).roundedCorners,false);
        const rect={x:width-416,y:height-92,width:400,height:76};
        composer.place(host,{action:'place',rect});composer.update({value:'retained synthetic draft',enabled:true,busy:false,sessionToken:'fixture-session',revision:1});composer.setEnabled(true);
        for(let i=0;i<100&&!owner.contentView.children.some(v=>v!==video&&v.webContents?.getURL().endsWith('native-composer.html'));i++)await wait(20);
        const current=owner.contentView.children.find(v=>v!==video);
        assert(current,'trusted input attaches to video window');if(input)assert.equal(current,input,'moving between native owners retains the input web contents');input=current;
        assert.equal(owner.contentView.children.at(-1),input,'input is above opaque video');
        const r=input.getBounds();assert.equal(area.x+r.x,root.x+Math.round(rect.x*zoom));assert.equal(area.y+r.y,root.y+Math.round(rect.y*zoom));
        assert.equal(await input.webContents.executeJavaScript('document.querySelector("textarea").value'),'retained synthetic draft');
        if(zoom===1&&Number(process.env.NEKO_VIDEO_QA_HOLD_MS))await wait(Number(process.env.NEKO_VIDEO_QA_HOLD_MS));
        // Input uses the real isolated preload and IPC; no backend task runs.
        await input.webContents.executeJavaScript("document.querySelector('#expand').click()");await wait(30);
        assert((await host.webContents.executeJavaScript('qaEvents.read()')).some(e=>e.type==='expand'));
        await social.action(host,{action:'layout',slot:'side',bounds,holes:[]});composer.raise();
        assert(owner.isDestroyed());assert(host.contentView.children.includes(input),'before closing video window the original input is released and restored');
        assert.equal(await input.webContents.executeJavaScript('document.querySelector("textarea").value'),'retained synthetic draft');
      }
      console.log(JSON.stringify({ok:true,zooms:[1,1.25,1.5],videoEdgesAligned:true,inputAboveVideo:true,nativeExpandIPC:true,inputAndDraftRetained:true,frameRemoved:true}));
    }finally{composer.dispose();social.dispose();host.destroy();}
    app.quit();
  }).catch(error=>{console.error(error.stack||error);app.exit(1);});
}
