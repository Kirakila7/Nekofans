'use strict';
// Explicit, opt-in native integration check. No real accounts, external
// pages or user profiles are touched. Unlike *.test.cjs this launches Electron.
// Usage: NEKO_UNIFIED_QA_ELECTRON=/absolute/path/to/Electron node tests/neko-workbench/unified-native-views-qa.cjs
const fs = require('node:fs');
const path = require('node:path');

if (!process.versions.electron || process.env.NEKO_UNIFIED_NATIVE_QA_CHILD !== '1') {
  const { spawnSync } = require('node:child_process');
  const os = require('node:os');
  const runtime = process.env.NEKO_UNIFIED_QA_ELECTRON;
  if (!runtime || !path.isAbsolute(runtime)) {
    console.error('Set NEKO_UNIFIED_QA_ELECTRON to an absolute Electron executable path.');
    process.exitCode = 1;
  } else {
    const base = process.platform === 'darwin' && fs.existsSync('/private/tmp') ? '/private/tmp' : os.tmpdir();
    const dir = fs.mkdtempSync(path.join(base, 'neko-unified-native-qa-'));
    try {
      fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name:'neko-isolated-native-qa', version:'1.0.0', main:'bootstrap.cjs', private:true }));
      // This bootstrap references the checked-out test, not any installed app.
      fs.writeFileSync(path.join(dir, 'bootstrap.cjs'), 'require(' + JSON.stringify(__filename) + ');\n');
      const env = { NEKO_UNIFIED_NATIVE_QA_CHILD:'1', NEKO_UNIFIED_NATIVE_QA_DIR:dir };
      const result = spawnSync(runtime, [dir], { cwd:dir, env, encoding:'utf8', timeout:45000, windowsHide:true });
      if (result.stdout) process.stdout.write(result.stdout);
      if (result.stderr) process.stderr.write(result.stderr);
      if (result.error) console.error('Electron QA failed:', result.error.message);
      process.exitCode = result.status === 0 ? 0 : 1;
    } finally { fs.rmSync(dir, { recursive:true, force:true }); }
  }
} else {
  const { app, BrowserWindow, WebContentsView, session, ipcMain } = require('electron');
  const assert = require('node:assert/strict');
  const dir = process.env.NEKO_UNIFIED_NATIVE_QA_DIR;
  if (!dir || !path.isAbsolute(dir)) throw Error('Missing isolated test directory');
  fs.mkdirSync(path.join(dir, 'profile'), { recursive:true });
  fs.mkdirSync(path.join(dir, 'session'), { recursive:true });
  app.setName('Neko Isolated WebContentsView QA');
  app.setPath('home', dir);
  app.setPath('userData', path.join(dir, 'profile'));
  app.setPath('sessionData', path.join(dir, 'session'));
  assert.equal(app.getPath('home'), dir);
  assert.equal(app.getPath('userData'), path.join(dir, 'profile'));
  assert.equal(app.getPath('sessionData'), path.join(dir, 'session'));
  for (const flag of ['disable-background-networking', 'disable-component-update', 'disable-sync', 'no-first-run', 'disable-default-apps']) app.commandLine.appendSwitch(flag);
  app.commandLine.appendSwitch('host-resolver-rules', 'MAP * ~NOTFOUND');
  const { createSocialController, COMMUNITY_PARTITION, BILIBILI_PARTITION } = require('../../apps/neko-workbench/community-config.cjs');
  const { validate: validateLayout } = require('../../apps/neko-workbench/pane-layout.cjs');
  const hits = [];
  async function verifyRealLayout() {
    const preload = path.join(dir, 'layout-fixture-preload.cjs');
    fs.writeFileSync(preload, [
      "const {contextBridge,ipcRenderer}=require('electron');",
      "contextBridge.exposeInMainWorld('nekoWorkbench',{",
      "workspace:r=>ipcRenderer.invoke('qa:workspace',r),community:r=>ipcRenderer.invoke('qa:community',r),",
      "subscribeCommunity:cb=>{const handler=(_e,state)=>cb(state);ipcRenderer.on('qa:community-state',handler);return()=>ipcRenderer.removeListener('qa:community-state',handler)}",
      "});",
    ].join('\n'));
    const fixture = `<!doctype html><html><head><style>
      html,body{height:100%;margin:0}.neko-side-rail{position:fixed;left:0;top:0;width:64px;height:100%;z-index:40}
      #frame{display:grid;grid-template-columns:220px minmax(0,1fr);margin-left:64px;width:calc(100% - 64px);height:100%}
      #side-track{position:relative;height:100%;width:220px;box-sizing:border-box}
      [data-slot=sidebar],[data-slot="sidebar.settings"]{display:contents}
      .settingsArea{position:absolute;bottom:0;height:124px;width:100%}
      .neko-companion-dock{position:absolute;bottom:0;height:120px;width:100%}
      .fixture_centerCol_hash42{display:flex;flex-direction:column;min-width:0;overflow:hidden}
      #draft{width:90%;height:90px}.neko-unified-panel{font-family:system-ui}
      </style></head><body><aside class="neko-side-rail" data-neko-side-rail><div class="neko-workspace-rail-controls"></div></aside>
      <div id="frame"><div id="side-track"><aside data-slot="sidebar"><div>原有工作区</div><div class="settingsArea"><div data-slot="sidebar.settings"><div class="neko-companion-dock">原有角色与账号区</div><div data-slot="settings.launcher"></div></div></div></aside></div>
      <main class="fixture_centerCol_hash42"><textarea id="draft">local coding draft</textarea></main></div></body></html>`;
    const host = new BrowserWindow({ width:1200, height:800, useContentSize:true, show:false, webPreferences:{ sandbox:true, contextIsolation:true, nodeIntegration:false, preload } });
    const preloadUrl = require('node:url').pathToFileURL(preload).href;
    host.webContents.session.webRequest.onBeforeRequest((details, callback) => callback({ cancel: details.url !== preloadUrl && !['data:', 'about:', 'blob:'].includes(new URL(details.url).protocol) }));
    let saved = { enabled:false, side:'workspace', left:'coding', right:null, ratio:0.5 };
    const requests = [];
    const controller = createSocialController({ WebContentsView, env:{}, openExternal:async () => { throw Error('External navigation prohibited'); }, copyText:() => {},
      onState:(_host, state) => { if (!host.isDestroyed()) host.webContents.send('qa:community-state', state); } });
    ipcMain.handle('qa:workspace', (event, request) => {
      if (event.sender !== host.webContents) throw Error('Unexpected test sender');
      if (request.action === 'pane-layout') return { ...saved };
      if (request.action === 'set-pane-layout') return { ...(saved = validateLayout(request.layout)) };
      throw Error('Unsupported test request');
    });
    ipcMain.handle('qa:community', (event, request) => {
      if (event.sender !== host.webContents) throw Error('Unexpected test sender');
      requests.push({ ...request }); return controller.action(host, request);
    });
    const read = expression => host.webContents.executeJavaScript(expression, true);
    const waitFor = async expression => {
      for (let attempt=0; attempt<100; attempt++) { if (await read(expression)) return; await new Promise(resolve => setTimeout(resolve, 25)); }
      throw Error('Timed out while waiting for isolated native layout: ' + expression);
    };
    try {
      await host.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(fixture));
      const source = fs.readFileSync(path.join(__dirname, '../../apps/neko-workbench/embedded-dsh/unified-layout-source.js'), 'utf8');
      const css = fs.readFileSync(path.join(__dirname, '../../apps/neko-workbench/embedded-dsh/unified-layout-source.css'), 'utf8');
      await read(source + '\nwindow.__qaDisposeUnified=installUnifiedLayout({window,document,bridge:window.nekoWorkbench,cssText:' + JSON.stringify(css) + '}); true;');
      await waitFor("!!document.querySelector('.neko-layout-entry')");
      const initialWidth = await read("document.querySelector('.fixture_centerCol_hash42').getBoundingClientRect().width");
      await read("document.querySelector('.neko-layout-entry').click()");
      await read("document.querySelector('[data-target=right]').click(); document.querySelector('[data-content=community]').click()");
      for (let attempt=0; attempt<100 && !(saved.enabled && saved.right==='community'); attempt++) await new Promise(resolve => setTimeout(resolve, 25));
      assert(saved.enabled && saved.right === 'community', 'config chooses community in right pane');
      await read("document.querySelector('.neko-unified-config .close').click()");
      await waitFor("document.querySelector('[data-neko-unified-slot=right]').hidden === false");
      await waitFor("document.querySelector('.fixture_centerCol_hash42').getBoundingClientRect().width < " + initialWidth);
      for (let attempt=0; attempt<100 && !host.contentView.children.some(v=>v.webContents?.getURL().startsWith('https://community.project-neko.cn/')); attempt++) await new Promise(resolve => setTimeout(resolve, 25));
      const community = host.contentView.children.find(v=>v.webContents?.getURL().startsWith('https://community.project-neko.cn/'));
      assert(community, 'community native view attached after UI configuration');
      const first = await read(`(() => { const c=document.querySelector('.fixture_centerCol_hash42').getBoundingClientRect(),
        p=document.querySelector('[data-neko-unified-slot=right]').getBoundingClientRect(),
        h=document.querySelector('[data-neko-unified-slot=right] header').getBoundingClientRect(),
        b=document.querySelector('[data-neko-unified-slot=right] header button').getBoundingClientRect();
        return {code:{left:c.left,right:c.right,width:c.width},pane:{left:p.left,right:p.right},headerBottom:h.bottom,button:{width:b.width,height:b.height},draft:document.querySelector('#draft').value}; })()`);
      assert(Math.abs(first.code.width - initialWidth / 2) < 2, 'real native coding grid is resized to half width');
      assert(first.code.right <= first.pane.left + 1, 'coding and community occupy distinct regions');
      assert(first.button.width > 0 && first.button.height > 0, 'real toolbar buttons remain visible');
      assert(community.getBounds().y >= Math.floor(first.headerBottom), 'native view starts below its toolbar');
      assert.equal(first.draft, 'local coding draft');
      const dividerRight = await read("document.querySelector('.neko-unified-divider').getBoundingClientRect().right");
      assert(community.getBounds().x >= Math.ceil(dividerRight), 'native view does not cover divider hit area');
      await community.webContents.executeJavaScript("document.body.dataset.resizeState='kept'", true);
      const originalX = community.getBounds().x;
      await read("document.querySelector('.neko-unified-divider').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}))");
      for (let attempt=0; attempt<100 && community.getBounds().x <= originalX; attempt++) await new Promise(resolve => setTimeout(resolve, 25));
      assert(community.getBounds().x > originalX, 'native view follows split changes');
      assert.equal(await community.webContents.executeJavaScript('document.body.dataset.resizeState', true), 'kept', 'resizing retains the same document');
      assert.equal(hits.filter(x => x.partition === COMMUNITY_PARTITION).length, 2, 'renderer resize does not reload community');
      await read("document.querySelector('.neko-unified-divider').dispatchEvent(new KeyboardEvent('keydown',{key:'End',bubbles:true}))");
      await waitFor("document.querySelector('.neko-unified-divider').getAttribute('aria-valuenow') === '75'");
      const narrow = await read(`(() => { const p=document.querySelector('[data-neko-unified-slot=right]'), r=p.getBoundingClientRect(), h=p.querySelector('header').getBoundingClientRect();
        return {left:r.left,right:r.right,width:r.width,headerBottom:h.bottom,buttons:[...p.querySelectorAll('header button')].filter(b=>!b.hidden).map(b=>{const x=b.getBoundingClientRect();return {left:x.left,right:x.right,top:x.top,bottom:x.bottom}})}; })()`);
      for (let attempt=0; attempt<100 && community.getBounds().y < Math.floor(narrow.headerBottom); attempt++) await new Promise(resolve => setTimeout(resolve, 25));
      assert(narrow.width <= 260, 'fixture exercises narrow toolbar');
      assert(narrow.buttons.every(b => b.left >= narrow.left && b.right <= narrow.right && b.bottom <= narrow.headerBottom), 'narrow toolbar buttons remain within panel');
      assert(community.getBounds().y >= Math.floor(narrow.headerBottom), 'native view follows wrapped toolbar height');
      await read("document.querySelector('.neko-layout-entry').click(); document.querySelector('[data-target=side]').click(); document.querySelector('[data-content=bilibili]').click()");
      for (let attempt=0; attempt<100 && saved.side!=='bilibili'; attempt++) await new Promise(resolve => setTimeout(resolve, 25));
      assert.equal(saved.side, 'bilibili');
      await read("document.querySelector('.neko-unified-config .close').click()");
      for (let attempt=0; attempt<100 && !host.contentView.children.some(v=>v.webContents?.getURL().startsWith('https://m.bilibili.com/')); attempt++) await new Promise(resolve => setTimeout(resolve, 25));
      const children = host.contentView.children;
      const video = children.find(v=>v.webContents?.getURL().startsWith('https://m.bilibili.com/'));
      assert(video && children.includes(community), 'community and video views coexist after real UI interaction');
      const sidebar = await read(`(() => {const h=document.querySelector('[data-neko-unified-slot=side] header').getBoundingClientRect(),
        dock=document.querySelector('.neko-companion-dock').getBoundingClientRect(),slot=document.querySelector('[data-slot=sidebar]').getBoundingClientRect(),
        track=document.querySelector('#side-track').getBoundingClientRect(),footer=document.querySelector('.settingsArea').getBoundingClientRect();
        return {headerBottom:h.bottom,dockTop:dock.top,slotWidth:slot.width,slotHeight:slot.height,trackWidth:track.width,footerTop:footer.top};})()`);
      assert.equal(sidebar.slotWidth, 0); assert.equal(sidebar.slotHeight, 0);
      assert(sidebar.trackWidth >= 100, 'display:contents sidebar is mapped to its visible grid track');
      assert(video.getBounds().y >= Math.floor(sidebar.headerBottom));
      assert(video.getBounds().y + video.getBounds().height <= Math.ceil(sidebar.footerTop), 'side web view does not cover settings footer');
      assert(video.getBounds().y + video.getBounds().height <= Math.ceil(sidebar.dockTop), 'side web view does not cover companion/account');
      assert.equal(await read("document.querySelector('#draft').value"), 'local coding draft');
      assert(requests.some(r=>r.action==='open' && r.slot==='right' && r.site==='community'));
      assert(requests.some(r=>r.action==='open' && r.slot==='side' && r.site==='bilibili'));
      await read('window.__qaDisposeUnified()');
      await waitFor("!document.querySelector('[data-neko-unified-coding]')");
      assert.equal(await read("document.querySelector('#draft').value"), 'local coding draft');
      return { codeWidth:Math.round(first.code.width), initialCodeWidth:Math.round(initialWidth), realRendererLayout:true, realRendererToolbar:true, realRendererDraft:true };
    } finally {
      ipcMain.removeHandler('qa:workspace'); ipcMain.removeHandler('qa:community');
      controller.dispose(); host.destroy();
    }
  }
  async function run() {
    for (const partition of [COMMUNITY_PARTITION, BILIBILI_PARTITION]) {
      const isolated = session.fromPartition(partition);
      isolated.protocol.handle('https', request => {
        hits.push({ partition, origin:new URL(request.url).origin });
        return new Response('<!doctype html><html><head><title>Local fixture</title></head><body><p>Fixture content</p></body></html>', { headers:{ 'content-type':'text/html; charset=utf-8' } });
      });
      isolated.protocol.handle('http', () => new Response('blocked', { status:403 }));
      isolated.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !['https:', 'http:', 'data:', 'about:', 'blob:'].includes(new URL(details.url).protocol) }));
    }
    const host = new BrowserWindow({ width:1200, height:800, useContentSize:true, show:false, webPreferences:{ sandbox:true, contextIsolation:true, nodeIntegration:false } });
    host.webContents.session.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !['data:', 'about:', 'blob:'].includes(new URL(details.url).protocol) }));
    await host.loadURL('data:text/html,<title>Isolated host</title><textarea>local%20draft</textarea>');
    const events = [];
    const controller = createSocialController({ WebContentsView, env:{}, openExternal:async () => { throw Error('External navigation prohibited'); }, copyText:() => {}, onState:(_host, state) => events.push(state) });
    const left = { x:300, y:40, width:400, height:650 }, right = { x:700, y:40, width:400, height:650 }, side = { x:70, y:60, width:210, height:500 };
    let layout;
    try {
      await controller.action(host, { action:'open', site:'community', slot:'left', requestId:1, bounds:left });
      await controller.action(host, { action:'open', site:'bilibili', slot:'right', requestId:2, bounds:right });
      let children = host.contentView.children;
      const community = children.find(v => v.webContents?.getURL().startsWith('https://community.project-neko.cn/'));
      const video = children.find(v => v.webContents?.getURL().startsWith('https://m.bilibili.com/'));
      assert(community && video, 'both native child views must be attached'); assert.notEqual(community, video);
      assert.deepEqual(community.getBounds(), left); assert.deepEqual(video.getBounds(), right);
      assert.equal(community.webContents.session, session.fromPartition(COMMUNITY_PARTITION));
      assert.equal(video.webContents.session, session.fromPartition(BILIBILI_PARTITION));
      assert.notEqual(community.webContents.session, video.webContents.session);
      await community.webContents.executeJavaScript("document.body.dataset.qa='kept'", true);
      await video.webContents.executeJavaScript("sessionStorage.setItem('qa','kept')", true);
      const changed = { ...right, x:760, width:340 };
      await controller.action(host, { action:'layout', slot:'right', bounds:changed });
      assert.deepEqual(video.getBounds(), changed); assert.deepEqual(community.getBounds(), left);
      await controller.action(host, { action:'open', site:'community', slot:'side', requestId:3, bounds:side });
      children = host.contentView.children;
      assert(children.includes(community) && children.includes(video), 'moving retains both original views');
      assert.deepEqual(community.getBounds(), side);
      assert.equal(await community.webContents.executeJavaScript('document.body.dataset.qa', true), 'kept');
      assert.equal(await video.webContents.executeJavaScript("sessionStorage.getItem('qa')", true), 'kept');
      assert.equal(hits.filter(x => x.partition === COMMUNITY_PARTITION).length, 1, 'moving does not reload community');
      await controller.action(host, { action:'hide', slot:'side', requestId:3 }); children = host.contentView.children;
      assert(!children.includes(community)); assert(children.includes(video), 'one slot hides independently');
      assert(events.some(e => e.slot === 'side' && e.site === 'community' && e.status === 'hidden'));
      assert.equal(await host.webContents.executeJavaScript('document.querySelector("textarea").value', true), 'local draft');
      assert.equal(hits.filter(x => x.partition === BILIBILI_PARTITION).length, 1);
      // Keep this fixture window alive while the renderer fixture opens;
      // otherwise Electron may exit on window-all-closed between tests.
      layout = await verifyRealLayout();
    } finally { controller.dispose(); host.destroy(); }
    console.log(JSON.stringify({ ok:true, electron:process.versions.electron, syntheticRequests:hits.length, isolatedPartitions:true,
      twoNativeViews:true, independentBounds:true, movedWithoutReload:true, singleSlotHide:true, hostDraftPreserved:true, ...layout }));
  }
  app.whenReady().then(run).then(() => app.quit()).catch(error => { console.error(error.stack || String(error)); app.exit(1); });
}
