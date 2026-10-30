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
  const account=fs.readFileSync(path.join(root,'account-habitat-source.js'),'utf8'),accountCss=fs.readFileSync(path.join(root,'account-habitat-source.css'),'utf8');
  const fixture=`<!doctype html><html><head><style>
   html,body{margin:0;width:100%;height:100%}#app{height:100%}#frame{height:100%;display:grid;grid-template-columns:280px minmax(0px, 1fr) 0px}
   [data-slot=sidebar]{display:contents}.sidebar-root{height:100%;min-width:0;display:flex;flex-direction:column}.sidebar-content{flex:1;min-height:0}.footer{flex:none}
   .native_centerCol_hash{min-width:0;display:flex;flex-direction:column;padding:12px;box-sizing:border-box;overflow:hidden;transform:translateZ(0)}.composer{min-width:0;width:100%;display:flex;flex-wrap:wrap;gap:4px;box-sizing:border-box}.composer textarea{width:100%;min-width:0;box-sizing:border-box}.composer button{flex:1 1 88px;min-width:0}
   ${sideCss}\n${shellCss}\n${roomCss}
   </style></head><body><div id="app"><div id="frame" style="grid-template-columns:280px minmax(0px, 1fr) 0px"><div class="sidebar-track"><aside data-slot="sidebar"><div class="sidebar-root"><div class="sidebar-content"><button id="native-new-qa" class="kB3qhq_newSession" aria-label="新建会话"><svg><path id="native-new-icon-qa"></path></svg></button><div data-neko-seat-mount></div><div data-slot="sidebar.workspaces"></div></div><div class="footer"><div data-slot="settings.launcher"></div></div></div></aside></div><main class="native_centerCol_hash"><div class="composer" data-composer-seat><textarea data-composer-input>local coding draft</textarea><button>模型</button><button>发送</button></div></main></div></div></body></html>`;
  app.whenReady().then(async()=>{
    const win=new BrowserWindow({width:1200,height:800,useContentSize:true,show:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});
    try {
      await win.loadURL('data:text/html;charset=utf-8,'+encodeURIComponent(fixture));
      const read=expression=>win.webContents.executeJavaScript(expression,true);
      await read(`${side}\n${room}\n${shell}\n${account}\n`+`window.__actions=[];window.__bridge={action:async v=>window.__actions.push(v),getAccounts:async()=>({codex:{status:'signed-out',quota:{status:'idle',buckets:[]}}}),lobby:async()=>({ok:true,state:{connection:'unconfigured',messages:[],members:[],participation:{mode:'off',available:false}}}),getState:async()=>({companion:{ready:true,messages:[]}}),companion:async()=>{},workspace:async r=>r.action==='state'?{officeMode:'dsh',seats:[]}:r.action==='codex-state'?{items:[],approvals:[]}:r.action==='catalog'?{sessions:[{id:'demo',provider:'dsh',cwd:'/demo/工作台项目',title:'界面工作会话'}],providers:{dsh:'ready'}}:{},subscribeCommunity:()=>()=>{}};`+
      `document.querySelector('[data-slot="settings.launcher"]').innerHTML='<button class="_5Qcc8a_trigger" aria-haspopup="menu" aria-expanded="false" data-collapsed="false" data-signed-out="true" aria-label="账号菜单"><span class="_5Qcc8a_label">更多</span></button>';window.__accountClicks=0;const accountButton=document.querySelector('._5Qcc8a_trigger');accountButton.addEventListener('click',()=>{window.__accountClicks++;accountButton.setAttribute('aria-expanded','true');const menu=document.createElement('div');menu.setAttribute('data-menu-material','translucent');menu.setAttribute('role','menu');const viewport=document.createElement('div');viewport.setAttribute('role','presentation');for(const label of ['设置','意见反馈','登录']){const item=document.createElement('button');item.setAttribute('role','menuitem');const text=document.createElement('span');text.className='_itemLabel_4ub78_190';text.textContent=label;item.appendChild(text);viewport.appendChild(item)}menu.appendChild(viewport);document.body.appendChild(menu)});`+
      `window.__stopHabitat=installNekoAccountHabitat({remote:{account:{getState:async()=>({ok:true,value:{status:'signed-out'}})}},locale:{getSnapshot:()=>({active:'zh-CN'})}},{window,document,accountsBridge:window.__bridge,cssText:${JSON.stringify(accountCss)}});`+
      `window.__bridge.lobby=async()=>({ok:true,state:{connection:'online',me:{user_id:'qa'},channel:{name:'公共大厅'},messages:[],members:[],participation:{mode:'off',available:false}}});window.__stopRail=installWorkbenchSideRail({window,document,bridge:window.__bridge,openBilibiliHome:async()=>{}});`+
      `document.querySelector('#native-new-qa').addEventListener('click',()=>window.__nativeClicks=(window.__nativeClicks||0)+1);window.__stopShell=installWorkspaceShell({window,document,bridge:window.__bridge,createChatroomPreview,locateSidebar:()=>({root:document.querySelector('.sidebar-root')}),hasDshActiveSession:()=>true,avatar:()=>''}); true;`);
      const wait=async fn=>{for(let i=0;i<100;i++){if(await read(fn))return;await new Promise(r=>setTimeout(r,25));}throw Error('Timed out: '+fn);};
      await wait("!!document.querySelector('.neko-chat-sidebar-divider:not([hidden])') && !!document.querySelector('.neko-chatroom-preview:not([hidden])')");
      await wait("!document.querySelector('.neko-side-rail__account').disabled");
      await read("document.querySelector('.neko-side-rail__account').click(); true;");
      await wait("!!document.querySelector('.neh-menu-card .neh-provider-card')");
      assert.equal(await read("window.__accountClicks"),1);
      assert.equal(await read("document.querySelector('.neh-menu-card').textContent.includes('Codex')"),true);
      const beforeLobby=await read("(()=>{const r=document.querySelector('main').getBoundingClientRect();return {left:r.left,width:r.width,hidden:document.querySelector('.neko-startup').hidden}})()");
      await read("document.querySelector('button.neko-chatroom-preview__room').click(); true;");
      await wait("!document.querySelector('.neko-lobby-panel').hidden");
      assert.equal(await read("document.querySelector('.neko-workspace-rail-controls .neko-lobby-switch')===null"),true);
      const lobbyBounds=await read("(()=>{const r=e=>e.getBoundingClientRect().toJSON();return {lobby:r(document.querySelector('.neko-lobby-panel')),side:r(document.querySelector('.sidebar-root')),code:r(document.querySelector('main')),inert:document.querySelector('main').hasAttribute('inert'),draft:document.querySelector('.composer textarea').value,hidden:document.querySelector('.neko-startup').hidden}})()");
      assert(Math.abs(lobbyBounds.lobby.left-lobbyBounds.side.left)<2);assert(lobbyBounds.lobby.right<=lobbyBounds.code.left+2);
      assert.equal(lobbyBounds.code.left,beforeLobby.left);assert.equal(lobbyBounds.code.width,beforeLobby.width);assert.equal(lobbyBounds.hidden,beforeLobby.hidden);assert.equal(lobbyBounds.inert,false);assert.equal(lobbyBounds.draft,'local coding draft');
      const narrowLobby=await read("(()=>{const p=document.querySelector('.neko-lobby-panel');p.style.width='236px';const b=p.querySelector('.neko-lobby-members-toggle');b.click();const r=p.getBoundingClientRect(),m=p.querySelector('.neko-lobby-members').getBoundingClientRect(),t=b.getBoundingClientRect();return {display:getComputedStyle(b).display,expanded:b.getAttribute('aria-expanded'),membersWidth:m.width,inside:t.right<=r.right+1 && m.right<=r.right+1,overflow:p.scrollWidth>p.clientWidth+1}})()");
      assert.notEqual(narrowLobby.display,'none');assert.equal(narrowLobby.expanded,'true');assert(narrowLobby.membersWidth>0);assert(narrowLobby.inside);assert.equal(narrowLobby.overflow,false);
      await read("document.querySelector('.neko-chat-sidebar-divider').dispatchEvent(new KeyboardEvent('keydown',{key:'End',bubbles:true})); true;");
      await wait("document.body.hasAttribute('data-neko-workspace-collapsed') && !!document.querySelector('[data-neko-collapsed-composer]')");
      const floating=await read("(()=>{const t=document.querySelector('.composer textarea'),r=t.getBoundingClientRect(),x=Math.round(r.left+r.width/2),y=Math.round(r.top+r.height/2);return {x,y,hit:document.elementFromPoint(x,y)===t,disabled:t.disabled}})()");
      assert(floating.hit,'collapsed editor must receive pointer hit testing');assert.equal(floating.disabled,false);
      win.webContents.sendInputEvent({type:'mouseDown',x:floating.x,y:floating.y,button:'left',clickCount:1});win.webContents.sendInputEvent({type:'mouseUp',x:floating.x,y:floating.y,button:'left',clickCount:1});
      await wait("document.activeElement===document.querySelector('.composer textarea')");
      win.webContents.sendInputEvent({type:'char',keyCode:'X'});
      await wait("document.querySelector('.composer textarea').value.includes('X')");
      await read("document.querySelector('.composer textarea').value='local coding draft'; document.querySelector('[data-neko-workspace-expand-control]').click(); true;");
      await wait("!document.body.hasAttribute('data-neko-workspace-collapsed')");
      await read("document.querySelector('.neko-lobby-back').click(); true;");
      await wait("!document.querySelector('.neko-chatroom-preview').hidden");
      assert.equal(await read("document.querySelector('.composer textarea').value"),'local coding draft');
      await read("document.querySelector('.neko-room-entry').click(); document.querySelector('.neko-companion-form textarea').value='unsent'; document.dispatchEvent(new CustomEvent('neko-side-surface-change',{detail:{surface:'community'}})); true;");
      await wait("document.querySelector('.neko-companion-dock').hidden && !document.querySelector('.neko-rail-companion').hidden");
      const railSize=await read("(()=>{const r=document.querySelector('.neko-rail-companion').getBoundingClientRect();return {width:r.width,height:r.height}})()");
      assert(railSize.width>=54 && railSize.height>=68,'rail companion is enlarged');
      await read("document.querySelector('.neko-rail-companion').click(); document.dispatchEvent(new CustomEvent('neko-side-surface-change',{detail:{surface:'hidden'}})); true;");
      await wait("!document.querySelector('.neko-companion-dock').hidden");
      assert.equal(await read("window.__actions.includes('open-companion-chat')"),true);
      assert.equal(await read("document.querySelector('.neko-companion-form textarea').value"),'unsent');
      const snapshot=()=>read(`(()=>{const $=s=>document.querySelector(s),r=e=>{const x=e.getBoundingClientRect();return {x:x.x,y:x.y,right:x.right,width:x.width,height:x.height}};return {frame:r($('#frame')),side:r($('.sidebar-root')),code:r($('main')),input:r($('.composer textarea')),preview:r($('.neko-chatroom-preview')),startup:r($('.neko-startup')),dock:r($('.neko-companion-dock')),divider:r($('.neko-chat-sidebar-divider')),draft:$('.composer textarea').value,scroll:$('main').scrollWidth,client:$('main').clientWidth};})()`);
      let first=await snapshot(); assert(Math.abs(first.side.width/first.frame.width-.75)<.01); assert(Math.abs(first.preview.width-first.side.width)<2); assert(Math.abs(first.startup.x-first.side.right)<2);assert(first.input.right<=first.code.right+1);assert(first.scroll<=first.client+1);
      await wait("!!document.querySelector('.neko-startup__project-header strong')");
      await read("document.querySelector('.neko-startup__continue').click(); document.querySelector('#native-new-icon-qa').dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true})); true;");
      await wait("!document.querySelector('.neko-startup').hidden");
      assert.equal(await read("window.__nativeClicks || 0"),0,'actual Chromium capture prevents the DSH button handler');
      assert.equal(await read("document.querySelector('.composer textarea').value"),'local coding draft');
      const chooser=await read(`(()=>{const p=document.querySelector('.neko-startup'),r=e=>{let x=e.getBoundingClientRect();return {left:x.left,right:x.right,top:x.top,bottom:x.bottom,width:x.width,height:x.height}};const rows=[];for(const w of [250,284,320,400,600]){p.style.width=w+'px';const h=document.querySelector('.neko-startup__header h1'),n=document.querySelector('.neko-startup__project-header strong'),project=document.querySelector('.neko-startup__project'),newButton=document.querySelector('.neko-startup__project-new');rows.push({width:w,p:r(p),h:r(h),n:r(n),project:r(project),newButton:r(newButton),scroll:p.scrollWidth,client:p.clientWidth});}return rows;})()`);
      for(const row of chooser){assert(row.scroll<=row.client+1,'chooser must not overflow at '+row.width);assert(row.n.width>=45,'project name must remain visible at '+row.width);assert(row.h.right<=row.p.right+1,'header must fit at '+row.width);assert(row.newButton.right<=row.project.right+1,'new session button must fit at '+row.width);}
      await read("window.dispatchEvent(new Event('resize'))");
      await read(`(()=>{const h=document.querySelector('.neko-chat-sidebar-divider');const x=h.getBoundingClientRect().x+6;h.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,button:0,pointerId:7,clientX:x}));h.dispatchEvent(new PointerEvent('pointermove',{bubbles:true,pointerId:7,clientX:264}));h.dispatchEvent(new PointerEvent('pointerup',{bubbles:true,pointerId:7,clientX:264}));})()`);
      await wait("document.querySelector('.neko-chat-sidebar-divider').getAttribute('aria-valuenow')==='18'");
      let moved=await snapshot();assert(moved.code.width>first.code.width+400);assert(Math.abs(moved.preview.width-moved.side.width)<2);assert(Math.abs(moved.startup.x-moved.side.right)<2);assert(moved.input.right<=moved.code.right+1);assert(moved.scroll<=moved.client+1);assert.equal(moved.draft,'local coding draft');assert(moved.dock.right<=moved.side.right+1);
      win.setSize(800,650);await wait("document.querySelector('#frame').getBoundingClientRect().width<800");let narrow=await snapshot();assert(narrow.input.right<=narrow.code.right+1);assert(narrow.scroll<=narrow.client+1);assert(narrow.dock.right<=narrow.side.right+1);
      console.log(JSON.stringify({ok:true,electron:process.versions.electron,isolatedProfile:true,defaultChatFraction:Math.round(first.side.width/first.frame.width*100),initialCodingWidth:first.code.width,afterDragCodingWidth:moved.code.width,previewFollowsTrack:true,startupFollowsTrack:true,draftPreserved:true,narrowLayoutChecked:true,chooserWidths:chooser.map(row=>row.width)}));
    } catch(error) { console.error(error.stack||error); try { console.error(await win.webContents.executeJavaScript(`JSON.stringify({body:document.body.outerHTML.slice(0,1800),divider:document.querySelector('.neko-chat-sidebar-divider')?.outerHTML,room:document.querySelector('.neko-chatroom-preview')?.outerHTML.slice(0,300),frame:document.querySelector('#frame')?.getBoundingClientRect().toJSON()})`)); } catch {} win.destroy(); app.exit(1); return; }
    finally { if(!win.isDestroyed())win.destroy(); }
    app.quit();
  }).catch(error=>{console.error(error.stack||error);process.exitCode=1;app.quit();});
}
