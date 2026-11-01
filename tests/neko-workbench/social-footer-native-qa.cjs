'use strict';
// Isolated Windows window-shape check; every remote page is a local fixture.
const fs=require('node:fs'),path=require('node:path');
if (!process.versions.electron || process.env.NEKO_SOCIAL_FOOTER_QA_CHILD!=='1') {
  const os=require('node:os'),{spawnSync}=require('node:child_process');
  const electron=process.env.NEKO_UNIFIED_QA_ELECTRON;
  if(!electron||!path.isAbsolute(electron))throw Error('Set NEKO_UNIFIED_QA_ELECTRON');
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'neko-social-footer-qa-'));
  try {
    fs.writeFileSync(path.join(dir,'package.json'),JSON.stringify({name:'neko-social-footer-qa',version:'1.0.0',main:'bootstrap.cjs'}));
    fs.writeFileSync(path.join(dir,'bootstrap.cjs'),'require('+JSON.stringify(__filename)+');');
    const result=spawnSync(electron,[dir],{cwd:dir,env:{NEKO_SOCIAL_FOOTER_QA_CHILD:'1',NEKO_SOCIAL_FOOTER_QA_DIR:dir},encoding:'utf8',timeout:30000,windowsHide:true});
    if(result.stdout)process.stdout.write(result.stdout);if(result.stderr)process.stderr.write(result.stderr);
    if(result.error)throw result.error;process.exitCode=result.status===0?0:1;
  } finally { fs.rmSync(dir,{recursive:true,force:true}); }
} else {
  const {app,BrowserWindow,BaseWindow,WebContentsView,session}=require('electron'),assert=require('node:assert/strict');
  const {createSocialController,COMMUNITY_PARTITION,BILIBILI_PARTITION}=require('../../apps/neko-workbench/community-config.cjs');
  const dir=process.env.NEKO_SOCIAL_FOOTER_QA_DIR;
  for(const name of ['profile','session'])fs.mkdirSync(path.join(dir,name));
  app.setPath('userData',path.join(dir,'profile'));app.setPath('sessionData',path.join(dir,'session'));
  app.commandLine.appendSwitch('host-resolver-rules','MAP * ~NOTFOUND');app.commandLine.appendSwitch('disable-background-networking');
  app.whenReady().then(async()=>{
    const windows=[],shapes=[],hits=[];
    class CheckedWindow extends BaseWindow {
      constructor(options){super(options);windows.push(this);}
      setShape(regions){shapes.push(regions);return super.setShape(regions);}
    }
    for(const partition of [COMMUNITY_PARTITION,BILIBILI_PARTITION])session.fromPartition(partition).protocol.handle('https',request=>{
      hits.push(request.url);return new Response('<!doctype html><title>Local fixture</title><body style="margin:0;background:#7bbddd;height:100vh">Local social page</body>',{headers:{'content-type':'text/html'}});
    });
    const host=new BrowserWindow({width:1000,height:760,useContentSize:true,show:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});
    await host.loadURL('data:text/html,'+encodeURIComponent('<title>Local host</title><aside data-neko-side-rail></aside><aside data-slot="sidebar"><div data-slot="settings.launcher"></div></aside><main data-neko-chat-center style="position:relative;contain:layout paint;overflow:hidden;width:0;height:700px"><div data-composer-seat><textarea>original draft</textarea></div></main>'));
    const shell=fs.readFileSync(path.join(__dirname,'../../apps/neko-workbench/embedded-dsh/workspace-shell-source.js'),'utf8');
    const css=fs.readFileSync(path.join(__dirname,'../../apps/neko-workbench/embedded-dsh/workspace-shell-source.css'),'utf8');
    await host.webContents.executeJavaScript(shell+`\nwindow.qaStop=installWorkspaceShell({window,document,cssText:${JSON.stringify(css)},avatar:()=>'',bridge:{action:async()=>({}),getState:async()=>({workspaceRoot:'/fixture',companion:{ready:true,messages:[]}}),companion:async()=>({}),workspace:async r=>r.action==='state'?{officeMode:'dsh',seats:[]}:r.action==='catalog'?{sessions:[],projects:[],providers:{dsh:'ready'}}:{items:[],approvals:[]}},locateSidebar:()=>({root:document.querySelector('[data-slot="sidebar"]')})});document.body.setAttribute('data-neko-workspace-collapsed','');`);
    await new Promise(resolve=>setTimeout(resolve,200));
    const compact=await host.webContents.executeJavaScript(`(()=>{const seat=document.querySelector('[data-composer-seat]'),input=seat.querySelector('textarea'),r=input.getBoundingClientRect(),s=seat.getBoundingClientRect();return{open:seat.matches(':popover-open'),hit:document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)===input,parent:seat.parentElement.matches('[data-neko-chat-center]'),hole:{x:s.x,y:s.y,width:s.width,height:s.height}};})()`);
    assert(compact.open&&compact.hit&&compact.parent,'original input escapes clipped zero-width column without being remounted');
    const controller=createSocialController({WebContentsView,BaseWindow:CheckedWindow,env:{},openExternal:async()=>{throw Error('No external navigation');}});
    const bounds={x:64,y:50,width:900,height:700},hole=compact.hole;
    try {
      for(const site of ['community','bilibili']) {
        await controller.action(host,{action:'open',site,slot:'side',bounds,holes:[hole]});
        const view=controller.view,owner=windows.at(-1),regions=shapes.at(-1),loads=hits.length;
        assert.equal(view.getBounds().height,700,'native page retains full height');
        assert(regions.some(r=>r.y+r.height===700&&r.x<100),'page reaches bottom outside composer');
        const inside=(x,y)=>regions.some(r=>x>=r.x&&x<r.x+r.width&&y>=r.y&&y<r.y+r.height);
        assert(!inside(hole.x+hole.width/2-bounds.x,hole.y+hole.height/2-bounds.y),'shape exposes original composer');
        assert(inside(100-bounds.x,740-bounds.y),'bottom-left page remains rendered');
        assert.equal(owner.getParentWindow(),host);assert(!owner.isVisible(),'hidden host keeps owned window hidden');
        await controller.action(host,{action:'layout',slot:'side',bounds,holes:[]});
        assert(owner.isDestroyed());assert(host.contentView.children.includes(view));assert.equal(hits.length,loads,'restoring parent does not reload page');
        assert.equal(view.getBounds().y+view.getBounds().height,750);
      }
      assert.equal(await host.webContents.executeJavaScript('document.querySelector("[data-composer-seat] textarea").value'),'original draft');
      await host.webContents.executeJavaScript("document.body.removeAttribute('data-neko-workspace-collapsed')");await new Promise(resolve=>setTimeout(resolve,100));
      assert.equal(await host.webContents.executeJavaScript("document.querySelector('[data-composer-seat]').hasAttribute('popover')"),false);
      console.log(JSON.stringify({ok:true,fullHeight:true,composerCutout:true,bottomCornerRendered:true,ownedWindowLifecycle:true,noReload:true,draftPreserved:true,originalInputHitTest:true,popoverRestored:true}));
    } finally {controller.dispose();host.destroy();}
    app.quit();
  }).catch(error=>{console.error(error.stack||error);app.exit(1);});
}
