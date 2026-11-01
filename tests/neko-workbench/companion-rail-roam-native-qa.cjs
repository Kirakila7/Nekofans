'use strict';
// Opt-in isolated Chromium geometry/input check; it never opens a user profile.
// NEKO_RAIL_QA_ELECTRON=/absolute/path/to/Electron node tests/neko-workbench/companion-rail-roam-native-qa.cjs
const fs = require('node:fs'), path = require('node:path');
if (!process.versions.electron || process.env.NEKO_RAIL_QA_CHILD !== '1') {
  const { spawnSync } = require('node:child_process');
  const os = require('node:os');
  const electron = process.env.NEKO_RAIL_QA_ELECTRON;
  if (!electron || !path.isAbsolute(electron)) { console.error('Set NEKO_RAIL_QA_ELECTRON to an absolute Electron executable'); process.exitCode = 1; }
  else {
    const dir = fs.mkdtempSync(path.join(process.platform === 'darwin' && fs.existsSync('/private/tmp') ? '/private/tmp' : os.tmpdir(), 'neko-rail-native-qa-'));
    try {
      fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({name:'neko-rail-native-qa',version:'1.0.0',main:'bootstrap.cjs',private:true}));
      fs.writeFileSync(path.join(dir, 'bootstrap.cjs'), 'require(' + JSON.stringify(__filename) + ');\n');
      const r = spawnSync(electron, [dir], {cwd:dir, env:{NEKO_RAIL_QA_CHILD:'1',NEKO_RAIL_QA_DIR:dir}, encoding:'utf8', timeout:30000});
      if (r.stdout) process.stdout.write(r.stdout); if (r.stderr) process.stderr.write(r.stderr); if (r.error) console.error(r.error.message);
      process.exitCode = r.status === 0 ? 0 : 1;
    } finally { fs.rmSync(dir,{recursive:true,force:true}); }
  }
} else {
  const {app,BrowserWindow} = require('electron'), assert = require('node:assert/strict');
  const dir=process.env.NEKO_RAIL_QA_DIR;
  fs.mkdirSync(path.join(dir,'profile'),{recursive:true}); fs.mkdirSync(path.join(dir,'session'),{recursive:true});
  app.setName('Neko isolated rail QA'); app.setPath('home',dir); app.setPath('userData',path.join(dir,'profile')); app.setPath('sessionData',path.join(dir,'session'));
  app.commandLine.appendSwitch('host-resolver-rules','MAP * ~NOTFOUND'); app.commandLine.appendSwitch('disable-background-networking');
  app.whenReady().then(async () => {
    const win = new BrowserWindow({width:960,height:700,show:false,webPreferences:{backgroundThrottling:false,contextIsolation:false,sandbox:false}});
    try {
      const railCss=fs.readFileSync(path.join(__dirname,'../../apps/neko-workbench/embedded-dsh/side-rail-source.css'),'utf8');
      const shellCss=fs.readFileSync(path.join(__dirname,'../../apps/neko-workbench/embedded-dsh/workspace-shell-source.css'),'utf8');
      const shell=fs.readFileSync(path.join(__dirname,'../../apps/neko-workbench/embedded-dsh/workspace-shell-source.js'),'utf8');
      const html='<!doctype html><html><head><style>'+railCss+'\n#frame {position:fixed;left:64px;width:260px;height:100%;} #frame[data-sidebar-collapsed="true"] [data-slot="sidebar"] {display:none}</style></head><body data-neko-side-rail-layout><aside class="neko-side-rail" data-neko-side-rail><div class="neko-side-rail__theme"></div><div class="neko-side-rail__space" aria-hidden="true"></div><nav class="neko-side-rail__bottom"><button class="neko-side-rail__button neko-side-rail__expand">展开</button><button class="neko-side-rail__button">视频</button><button class="neko-side-rail__button">账号</button></nav></aside><div id="frame" data-sidebar-collapsed="false"><aside data-slot="sidebar"><div data-neko-seat-mount></div><div data-slot="sidebar.workspaces"></div><div data-slot="settings.launcher"></div></aside></div></body></html>';
      await win.loadURL('data:text/html;charset=utf-8,'+encodeURIComponent(html));
      const setup=`Object.defineProperty(document,'visibilityState',{configurable:true,get:()=> 'visible'}); Math.random=()=>.8; window.qaActions=[];
        window.nekoWorkbench={getState:async()=>({workspaceRoot:'/fixture',workspaceRevision:0,companion:{ready:true,messages:[]}}),companion:async()=>({}),action:async name=>window.qaActions.push(name),workspace:async r=>r.action==='state'?{officeMode:'dsh',activeSeatId:null,seats:[],companionHistoryOpen:false}:r.action==='codex-state'?{items:[],approvals:[]}:r.action==='catalog'?{sessions:[],projects:[],providers:{dsh:'ready'}}:{}};
        ${shell}\nwindow.qaCleanup=installWorkspaceShell({window,document,bridge:window.nekoWorkbench,cssText:${JSON.stringify(shellCss)},avatar:()=>'',locateSidebar:()=>({root:document.querySelector('[data-slot="sidebar"]')})});
        document.querySelector('#frame').setAttribute('data-sidebar-collapsed','true');`;
      await win.webContents.executeJavaScript(setup,true);
      const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms)); await wait(250);
      const read=()=>win.webContents.executeJavaScript(`(()=>{const p=document.querySelector('.neko-rail-companion'),s=document.querySelector('.neko-side-rail__space'),b=document.querySelector('.neko-side-rail__bottom'); const rect=n=>{const r=n.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,bottom:r.bottom}};return {pet:rect(p),space:rect(s),bottom:rect(b),hidden:p.hidden,menu:document.querySelector('.neko-companion-menu').hidden,aria:s.getAttribute('aria-hidden')};})()`,true);
      const first=await read(); assert.equal(first.hidden,false); assert.equal(first.aria,'false'); assert(first.pet.y>=first.space.y && first.pet.bottom<=first.space.bottom && first.pet.bottom<=first.bottom.y);
      await wait(2800); const moved=await read(); assert(moved.pet.y>first.pet.y+1,'autonomous position changes in real Chromium');
      const x=Math.round(moved.pet.x+moved.pet.width/2), y=Math.round(moved.pet.y+moved.pet.height/2), target=Math.round(first.space.bottom-30);
      win.webContents.sendInputEvent({type:'mouseDown',x,y,button:'left',clickCount:1});
      win.webContents.sendInputEvent({type:'mouseMove',x,y:target,button:'left'});
      win.webContents.sendInputEvent({type:'mouseUp',x,y:target,button:'left',clickCount:1});
      await wait(150); const dragged=await read(); assert(dragged.pet.y>moved.pet.y+10,'drag changes position'); assert(dragged.pet.bottom<=dragged.space.bottom+.5); assert.equal(dragged.menu,true,'drag does not open menu');
      const px=Math.round(dragged.pet.x+dragged.pet.width/2), py=Math.round(dragged.pet.y+dragged.pet.height/2);
      win.webContents.sendInputEvent({type:'mouseDown',x:px,y:py,button:'left',clickCount:1}); win.webContents.sendInputEvent({type:'mouseUp',x:px,y:py,button:'left',clickCount:1});
      await wait(100); assert.equal((await read()).menu,false,'click opens menu');
      await win.webContents.executeJavaScript("document.querySelector('.neko-side-rail__space').remove()",true); await wait(150);
      const fallback=await win.webContents.executeJavaScript(`(()=>{const p=document.querySelector('.neko-rail-companion'),t=document.querySelector('.neko-side-rail__theme');return {position:getComputedStyle(p).position,petBottom:p.getBoundingClientRect().bottom,themeTop:t.getBoundingClientRect().top};})()`,true);
      assert(['static','relative'].includes(fallback.position),'missing blank space uses normal rail flow');
      assert(fallback.petBottom<=fallback.themeTop+.5,'missing blank space does not cover the top control');
      await win.webContents.executeJavaScript(`document.querySelector('#frame').setAttribute('data-sidebar-collapsed','false'); document.querySelector('.neko-companion-form textarea').value='unsent social fixture';`,true);
      await wait(100);
      for (const surface of ['community','bilibili']) {
        await win.webContents.executeJavaScript(`document.dispatchEvent(new CustomEvent('neko-side-surface-change',{detail:{surface:${JSON.stringify(surface)}}}));`,true);
        await wait(100);
        const social=await win.webContents.executeJavaScript(`(()=>{const d=document.querySelector('.neko-companion-dock'),p=document.querySelector('.neko-rail-companion'),c=document.querySelector('.neko-companion-character'),r=p.getBoundingClientRect();return{dockDisplay:getComputedStyle(d).display,rail:p.hidden,parent:c.parentElement===p,count:document.querySelectorAll('.neko-companion-character').length,x:r.x,width:r.width,height:r.height,actions:window.qaActions.length};})()`,true);
        assert.equal(social.dockDisplay,'none',surface+' has no bottom-left chat'); assert.equal(social.rail,false); assert(social.parent); assert.equal(social.count,1);
        assert(social.x>=0&&social.x+social.width<=64,'fish stays inside the rail'); assert(social.width>=54&&social.height>=68,'larger rail fish');
        await win.webContents.executeJavaScript("document.querySelector('.neko-rail-companion').click()",true);await wait(100);
        assert.equal(await win.webContents.executeJavaScript("document.querySelector('.neko-companion-dock').hasAttribute('data-neko-companion-rail-chat') && document.querySelector('.neko-companion-form textarea').value === 'unsent social fixture'",true),true);
        assert.equal(await win.webContents.executeJavaScript('window.qaActions.length',true),social.actions,'chat stays inside the workbench');
        await win.webContents.executeJavaScript("document.querySelector('.neko-companion-rail-close').click()",true);await wait(100);
      }
      await win.webContents.executeJavaScript(`document.dispatchEvent(new CustomEvent('neko-side-surface-change',{detail:{surface:'hidden'}}));`,true); await wait(100);
      const restored=await win.webContents.executeJavaScript(`(()=>{const d=document.querySelector('.neko-companion-dock');return{display:getComputedStyle(d).display,parent:document.querySelector('.neko-companion-character').parentElement===d,draft:document.querySelector('.neko-companion-form textarea').value};})()`,true);
      assert.notEqual(restored.display,'none'); assert(restored.parent); assert.equal(restored.draft,'unsent social fixture');
      console.log(JSON.stringify({ok:true,electron:process.versions.electron,autoWalk:true,drag:true,dragKeepsMenuClosed:true,clickOpensMenu:true,confinedToBlankRail:true,missingSpaceAvoidsOverlap:true,socialDockHidden:true,socialClickChats:true,socialDraftRestored:true}));
    } finally { win.destroy(); }
    app.quit();
  }).catch(e=>{console.error(e.stack||String(e));app.exit(1);});
}
