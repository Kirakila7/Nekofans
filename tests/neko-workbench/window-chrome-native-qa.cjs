'use strict';
// Loads the actual workbench and local DSH UI with an empty, disposable profile.
// No login, supplier call, channel message, existing profile or foreground focus.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
if (!process.versions.electron || process.env.NEKO_CHROME_QA_CHILD !== '1') {
  const { spawnSync } = require('node:child_process');
  const electron = process.env.NEKO_WORKBENCH_ELECTRON;
  if (!electron || !path.isAbsolute(electron)) throw Error('Set NEKO_WORKBENCH_ELECTRON');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'neko-chrome-qa-'));
  if (path.dirname(dir) !== path.resolve(os.tmpdir())) throw Error('Unexpected QA profile location');
  try {
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'neko-chrome-qa', version: '1.0.0', main: 'bootstrap.cjs' }));
    fs.writeFileSync(path.join(dir, 'bootstrap.cjs'), 'require(' + JSON.stringify(__filename) + ')');
    const env = { ...process.env, NEKO_CHROME_QA_CHILD: '1', NEKO_CHROME_QA_DIR: dir,
      NEKO_WORKBENCH_DATA_DIR: path.join(dir, 'data'), NEKO_WORKBENCH_WORKSPACE: path.join(dir, 'work'),
      NEKO_WORKBENCH_ELECTRON_USER_DATA: path.join(dir, 'electron'), NEKO_WORKBENCH_DSH_HOME: '',
      NEKO_WORKBENCH_DSH_CREDENTIALS: '', NEKO_WORKBENCH_DSH_PROFILE: 'web',
      NEKO_WORKBENCH_CHAT_URL: '', NEKO_WORKBENCH_CHAT_AUTH_URL: '', PET_OPEN_WORKBENCH: '1', PET_WORKBENCH_ONLY: '1' };
    delete env.ELECTRON_RUN_AS_NODE;
    const result = spawnSync(electron, [dir], { env, encoding: 'utf8', timeout: 100000, windowsHide: true });
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    if (result.error) throw result.error;
    process.exitCode = result.status === 0 ? 0 : 1;
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
} else {
  const electron = require('electron'), Module = require('node:module'), assert = require('node:assert/strict');
  const windows = [], OriginalWindow = electron.BrowserWindow;
  class QuietWindow extends OriginalWindow {
    constructor(options) { super({ ...options, webPreferences: { ...options.webPreferences, offscreen: process.env.NEKO_CHROME_QA_VISIBLE !== '1' } }); this.qaOptions = options; this.webContents.setBackgroundThrottling(false); windows.push(this); }
    show() { if (process.env.NEKO_CHROME_QA_VISIBLE === '1') this.showInactive(); } focus() {}
  }
  electron.app.focus = () => {};
  const load = Module._load;
  Module._load = function(name, ...args) { return name === 'electron' ? { ...electron, BrowserWindow: QuietWindow } : load.call(this, name, ...args); };
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const until = async check => { for (let n = 0; n < 50; n++) { if (await check()) return; await wait(100); } throw Error('Window layout did not settle'); };
  let failed = false;
  electron.app.once('will-quit', event => { event.preventDefault(); electron.app.exit(failed ? 1 : 0); });
  const timer = setTimeout(() => { failed = true; console.error('Window chrome QA timed out'); electron.app.quit(); }, 85000);
  const output = process.env.NEKO_CHROME_QA_OUTPUT;
  require('../../apps/neko-workbench/main.cjs');
  (async () => {
    try {
      let host;
      for (let attempt = 0; attempt < 120; attempt++) {
        host = windows.find(win => win.qaOptions.title === 'N.E.K.O. 工作台');
        if (host && /^http:\/\/127\.0\.0\.1:/.test(host.webContents.getURL()) && await host.webContents.executeJavaScript('!!document.querySelector(".neko-window-titlebar")').catch(() => false)) break;
        await wait(500);
      }
      assert(host, 'actual main created the workbench window');
      assert.equal(host.qaOptions.titleBarStyle, 'hidden');
      assert.equal(host.qaOptions.titleBarOverlay.height, 36);
      assert.equal(host.qaOptions.autoHideMenuBar, true);
      const run = source => host.webContents.executeJavaScript(source);
      assert.equal(await run('window.nekoWorkbench.windowChrome'), 'overlay');
      assert.equal(await run('document.querySelectorAll(".neko-window-titlebar").length'), 1);
      if (output) fs.mkdirSync(output, { recursive: true });
      const measurements = [];
      const initialViewport = await run('({width:innerWidth,height:innerHeight})');
      for (const zoom of [1, 1.25, 1.5]) {
        host.webContents.setZoomFactor(zoom);
        await until(() => run(`(()=>{const r=document.querySelector('[data-neko-rail-app]').getBoundingClientRect(),l=document.querySelector('.neko-lobby-panel').getBoundingClientRect();return Math.abs(innerWidth-${initialViewport.width / zoom})<=1&&Math.abs(innerHeight-${initialViewport.height / zoom})<=1&&Math.abs(l.bottom-innerHeight)<1&&Math.abs(l.right-innerWidth)<1&&r.y===36&&Math.abs(r.bottom-innerHeight)<1})()`));
        const state = await run(`(()=>{const rect=n=>{const r=n?.getBoundingClientRect();return r&&{x:r.x,y:r.y,width:r.width,height:r.height,bottom:r.bottom,right:r.right}};return {zoom:${zoom},viewport:{width:innerWidth,height:innerHeight},header:rect(document.querySelector('.neko-window-titlebar')),root:rect(document.querySelector('[data-neko-rail-app]')),account:rect(document.querySelector('[data-slot="settings.launcher"] button[aria-haspopup="menu"]')),lobby:rect(document.querySelector('.neko-lobby-panel')),inset:document.body.hasAttribute('data-neko-inset-titlebar')}})()`);
        assert.equal(state.inset, false);
        assert.equal(state.header.y, 0); assert.equal(state.header.height, 36);
        assert(state.root.y >= 36 && state.root.bottom <= state.viewport.height + 1, 'content fits below the titlebar');
        assert(state.lobby.y >= 36, 'main room does not cover the titlebar');
        assert(state.lobby.bottom <= state.viewport.height + 1 && state.lobby.right <= state.viewport.width + 1, 'room fits the zoomed content area');
        assert(state.account.height > 0 && state.account.bottom <= state.viewport.height + 1, 'native account remains visible');
        measurements.push(state);
      }
      host.webContents.setZoomFactor(1);
      await until(() => run(`innerWidth===${initialViewport.width}`));
      await run('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(true))))');
      await wait(1200); // DSH's viewport store must leave its narrow-screen mode too.
      await run(`document.querySelector('.neko-companion-form textarea').value='QA retained private draft';document.querySelector('[data-neko-native-sidebar-toggle]').click()`);
      try { await until(() => run('document.body.hasAttribute("data-neko-sidebar-collapsed")')); }
      catch(error) { console.error(await run(`JSON.stringify({toggle:document.querySelector('[data-neko-native-sidebar-toggle]')?.outerHTML,collapsed:[...document.querySelectorAll('[data-sidebar-collapsed],[data-collapsed]')].map(n=>({tag:n.tagName,cls:n.className,sidebar:n.getAttribute('data-sidebar-collapsed'),collapsed:n.getAttribute('data-collapsed')}))})`)); throw error; }
      const collapsed = await run(`(()=>{const r=document.querySelector('.neko-collapsed-rail').getBoundingClientRect();return {top:r.top,width:r.width,draft:document.querySelector('.neko-companion-form textarea').value}})()`);
      assert.equal(collapsed.top, 36); assert.equal(collapsed.width, 72); assert.equal(collapsed.draft, 'QA retained private draft');
      await run('document.querySelector(".neko-collapsed-rail__button").click()');
      await until(() => run('!document.body.hasAttribute("data-neko-sidebar-collapsed")'));
      assert.equal(await run('document.querySelector(".neko-companion-form textarea").value'), 'QA retained private draft');
      await run('document.querySelector(".neko-companion-form textarea").value=""');
      for (const dark of [false, true]) {
        await run(`document.body.toggleAttribute('data-ds-dark-theme',${dark});`); await wait(300);
        for (const mode of ['Chat', 'Work']) {
          await run(`[...document.querySelectorAll('.neko-home-work-switch button')].find(b=>b.textContent==='${mode}').click()`);
          await until(() => run(`document.body.hasAttribute('data-neko-chatroom-active')===${mode === 'Chat'}`));
          await run('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(true))))');
          await wait(250);
          if (output) fs.writeFileSync(path.join(output, `${mode.toLowerCase()}-${dark ? 'dark' : 'light'}.png`), (await host.webContents.capturePage()).toPNG());
        }
      }
      if (output) fs.writeFileSync(path.join(output, 'native-measurements.json'), JSON.stringify(measurements, null, 2));
      if (output && process.env.NEKO_CHROME_QA_VISIBLE === '1') {
        const { execFile } = require('node:child_process');
        const capture = path.join(output, 'capture-window.ps1');
        fs.writeFileSync(capture, `param([long]$WindowHandle,[string]$OutputPath)\nAdd-Type -AssemblyName System.Drawing\nAdd-Type -TypeDefinition @'\nusing System;using System.Runtime.InteropServices;public class NekoCapture { [StructLayout(LayoutKind.Sequential)]public struct R{public int L,T,Ri,B;} [DllImport("user32.dll")]public static extern bool GetWindowRect(IntPtr h,out R r);[DllImport("user32.dll")]public static extern bool PrintWindow(IntPtr h,IntPtr dc,uint f);}\n'@\n$bounds=New-Object NekoCapture+R\n[NekoCapture]::GetWindowRect([IntPtr]$WindowHandle,[ref]$bounds)|Out-Null\n$bitmap=New-Object Drawing.Bitmap(($bounds.Ri-$bounds.L),($bounds.B-$bounds.T))\n$graphics=[Drawing.Graphics]::FromImage($bitmap)\n$dc=$graphics.GetHdc()\ntry {if(-not [NekoCapture]::PrintWindow([IntPtr]$WindowHandle,$dc,2)){throw 'Window capture failed'}}finally{$graphics.ReleaseHdc($dc);$graphics.Dispose()}\ntry{$bitmap.Save($OutputPath,[Drawing.Imaging.ImageFormat]::Png)}finally{$bitmap.Dispose()}\n`);
        await new Promise((resolve, reject) => execFile('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', capture, '-WindowHandle', host.getNativeWindowHandle().readBigUInt64LE().toString(), '-OutputPath', path.join(output, 'native-window.png')], { windowsHide: true, timeout: 15000 }, error => error ? reject(error) : resolve()));
      }
      console.log('Actual Windows workbench chrome: native overlay, 3 zooms, Chat/Work and both themes passed; isolated profile, no foreground or messages.');
    } catch (error) { failed = true; console.error(error.stack); }
    finally { clearTimeout(timer); electron.app.quit(); }
  })();
}
