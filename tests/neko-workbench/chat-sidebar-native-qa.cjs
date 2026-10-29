'use strict';
// Opt-in isolated Chromium geometry check. No real accounts or external pages.
// NEKO_UNIFIED_QA_ELECTRON=/absolute/path/to/Electron node tests/neko-workbench/chat-sidebar-native-qa.cjs
const fs = require('node:fs'), path = require('node:path');
if (!process.versions.electron || process.env.NEKO_CHAT_NATIVE_QA_CHILD !== '1') {
  const { spawnSync } = require('node:child_process');
  const os = require('node:os'); const runtime = process.env.NEKO_UNIFIED_QA_ELECTRON;
  if (!runtime || !path.isAbsolute(runtime)) { console.error('Set NEKO_UNIFIED_QA_ELECTRON to a raw Electron executable'); process.exitCode=1; }
  else {
    const base = process.platform === 'darwin' && fs.existsSync('/private/tmp') ? '/private/tmp' : os.tmpdir();
    const dir = fs.mkdtempSync(path.join(base,'neko-chat-native-qa-'));
    try {
      fs.writeFileSync(path.join(dir,'package.json'),JSON.stringify({name:'neko-chat-isolated-qa',version:'1.0.0',main:'bootstrap.cjs',private:true}));
      fs.writeFileSync(path.join(dir,'bootstrap.cjs'),'require('+JSON.stringify(__filename)+');\n');
      const result=spawnSync(runtime,[dir],{cwd:dir,env:{NEKO_CHAT_NATIVE_QA_CHILD:'1',NEKO_CHAT_NATIVE_QA_DIR:dir},encoding:'utf8',timeout:45000});
      if(result.stdout)process.stdout.write(result.stdout);if(result.stderr)process.stderr.write(result.stderr);
      if(result.error)console.error(result.error.message);process.exitCode=result.status===0?0:1;
    } finally { fs.rmSync(dir,{recursive:true,force:true}); }
  }
} else {
  const { app, BrowserWindow } = require('electron'), assert=require('node:assert/strict');
  const dir=process.env.NEKO_CHAT_NATIVE_QA_DIR;
  if(!dir||!path.isAbsolute(dir))throw Error('Missing isolated QA directory');
  fs.mkdirSync(path.join(dir,'profile'),{recursive:true});fs.mkdirSync(path.join(dir,'session'),{recursive:true});
  app.setName('Neko Chat Layout QA');app.setPath('home',dir);app.setPath('userData',path.join(dir,'profile'));app.setPath('sessionData',path.join(dir,'session'));
  app.commandLine.appendSwitch('host-resolver-rules','MAP * ~NOTFOUND');app.commandLine.appendSwitch('disable-background-networking');
  const root=path.join(__dirname,'../../apps/neko-workbench/embedded-dsh');
  const side=fs.readFileSync(path.join(root,'side-rail-source.js'),'utf8'),sideCss=fs.readFileSync(path.join(root,'side-rail-source.css'),'utf8');
  const shell=fs.readFileSync(path.join(root,'workspace-shell-source.js'),'utf8'),shellCss=fs.readFileSync(path.join(root,'workspace-shell-source.css'),'utf8');
  const room=fs.readFileSync(path.join(root,'chatroom-preview-source.js'),'utf8'),roomCss=fs.readFileSync(path.join(root,'chatroom-preview-source.css'),'utf8');
  const fixture=`<!doctype html><html><head><style>
   html,body{margin:0;width:100%;height:100%}#app{height:100%}#frame{height:100%;display:grid;grid-template-columns:280px minmax(0px, 1fr) 0px}
   [data-slot=sidebar]{display:contents}.sidebar-root{height:100%;min-width:0;display:flex;flex-direction:column}.sidebar-content{flex:1;min-height:0}.footer{flex:none}
   .native_centerCol_hash{min-width:0;display:flex;flex-direction:column;padding:12px;box-sizing:border-box}.composer{min-width:0;width:100%;display:flex;flex-wrap:wrap;gap:4px;box-sizing:border-box}.composer textarea{width:100%;min-width:0;box-sizing:border-box}.composer button{flex:1 1 88px;min-width:0}
   ${sideCss}\n${shellCss}\n${roomCss}
   </style></head><body><div id="app"><div id="frame" style="grid-template-columns:280px minmax(0px, 1fr) 0px"><div class="sidebar-track"><aside data-slot="sidebar"><div class="sidebar-root"><div class="sidebar-content"><div data-neko-seat-mount></div><div data-slot="sidebar.workspaces"></div></div><div class="footer"><div data-slot="settings.launcher"></div></div></div></aside></div><main class="native_centerCol_hash"><div class="composer"><textarea>local coding draft</textarea><button>模型</button><button>发送</button></div></main></div></div></body></html>`;
  app.whenReady().then(async()=>{
    const win=new BrowserWindow({width:1200,height:800,useContentSize:true,show:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});
    try {
      await win.loadURL('data:text/html;charset=utf-8,'+encodeURIComponent(fixture));
      const read=expression=>win.webContents.executeJavaScript(expression,true);
      await read(`${side}\n${room}\n${shell}\n`+`window.__bridge={action:async()=>{},getState:async()=>({companion:{ready:true,messages:[]}}),companion:async()=>{},workspace:async r=>r.action==='state'?{officeMode:'dsh',seats:[]}:r.action==='codex-state'?{items:[],approvals:[]}:r.action==='catalog'?{sessions:[],providers:{dsh:'ready'}}:{},subscribeCommunity:()=>()=>{}};`+
      `window.__stopRail=installWorkbenchSideRail({window,document,bridge:window.__bridge,openBilibiliHome:async()=>{}});`+
      `window.__stopShell=installWorkspaceShell({window,document,bridge:window.__bridge,createChatroomPreview,locateSidebar:()=>({root:document.querySelector('.sidebar-root')}),avatar:()=>''}); true;`);
      const wait=async fn=>{for(let i=0;i<100;i++){if(await read(fn))return;await new Promise(r=>setTimeout(r,25));}throw Error('Timed out: '+fn);};
      await wait("!!document.querySelector('.neko-chat-sidebar-divider:not([hidden])') && !!document.querySelector('.neko-chatroom-preview:not([hidden])')");
      const snapshot=()=>read(`(()=>{const $=s=>document.querySelector(s),r=e=>{const x=e.getBoundingClientRect();return {x:x.x,y:x.y,right:x.right,width:x.width,height:x.height}};return {frame:r($('#frame')),side:r($('.sidebar-root')),code:r($('main')),input:r($('.composer textarea')),preview:r($('.neko-chatroom-preview')),startup:r($('.neko-startup')),dock:r($('.neko-companion-dock')),divider:r($('.neko-chat-sidebar-divider')),draft:$('.composer textarea').value,scroll:$('main').scrollWidth,client:$('main').clientWidth};})()`);
      let first=await snapshot(); assert(Math.abs(first.side.width/first.frame.width-.75)<.01); assert(Math.abs(first.preview.width-first.side.width)<2); assert(Math.abs(first.startup.x-first.side.right)<2);assert(first.input.right<=first.code.right+1);assert(first.scroll<=first.client+1);
      await read(`(()=>{const h=document.querySelector('.neko-chat-sidebar-divider');const x=h.getBoundingClientRect().x+6;h.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,button:0,pointerId:7,clientX:x}));h.dispatchEvent(new PointerEvent('pointermove',{bubbles:true,pointerId:7,clientX:264}));h.dispatchEvent(new PointerEvent('pointerup',{bubbles:true,pointerId:7,clientX:264}));})()`);
      await wait("document.querySelector('.neko-chat-sidebar-divider').getAttribute('aria-valuenow')==='18'");
      let moved=await snapshot();assert(moved.code.width>first.code.width+400);assert(Math.abs(moved.preview.width-moved.side.width)<2);assert(Math.abs(moved.startup.x-moved.side.right)<2);assert(moved.input.right<=moved.code.right+1);assert(moved.scroll<=moved.client+1);assert.equal(moved.draft,'local coding draft');assert(moved.dock.right<=moved.side.right+1);
      win.setSize(800,650);await wait("document.querySelector('#frame').getBoundingClientRect().width<800");let narrow=await snapshot();assert(narrow.input.right<=narrow.code.right+1);assert(narrow.scroll<=narrow.client+1);assert(narrow.dock.right<=narrow.side.right+1);
      console.log(JSON.stringify({ok:true,electron:process.versions.electron,isolatedProfile:true,defaultChatFraction:Math.round(first.side.width/first.frame.width*100),initialCodingWidth:first.code.width,afterDragCodingWidth:moved.code.width,previewFollowsTrack:true,startupFollowsTrack:true,draftPreserved:true,narrowLayoutChecked:true}));
    } catch(error) { console.error(error.stack||error); try { console.error(await win.webContents.executeJavaScript(`JSON.stringify({body:document.body.outerHTML.slice(0,1800),divider:document.querySelector('.neko-chat-sidebar-divider')?.outerHTML,room:document.querySelector('.neko-chatroom-preview')?.outerHTML.slice(0,300),frame:document.querySelector('#frame')?.getBoundingClientRect().toJSON()})`)); } catch {} win.destroy(); app.exit(1); return; }
    finally { if(!win.isDestroyed())win.destroy(); }
    app.quit();
  }).catch(error=>{console.error(error.stack||error);process.exitCode=1;app.quit();});
}
