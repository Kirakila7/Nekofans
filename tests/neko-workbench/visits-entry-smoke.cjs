'use strict';
// Opt-in native entry smoke. Starts the actual workbench with a fresh profile,
// no OAuth/model configuration, and no DSH runtime. It sends no social messages.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const root = path.resolve(__dirname, '../..');
if (process.env.NEKO_VISITS_ENTRY_CHILD === '1') {
  const { app, Menu, BrowserWindow } = require('electron');
  require(path.join(root, 'apps/neko-workbench/main.cjs'));
  app.whenReady().then(async () => {
    try {
      const item = Menu.getApplicationMenu().items[0].submenu.items.find(i => i.label === '猫娘串门…');
      assert.ok(item); item.click();
      const until = Date.now() + 10000;
      let panel;
      while (Date.now() < until) {
        panel = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().endsWith('/visits/panel.html'));
        if (panel && !panel.webContents.isLoading()) break;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      assert.ok(panel);
      const result = await panel.webContents.executeJavaScript(`(async()=>{
        const state=await window.nekoVisits.call('getState');
        return {title:document.querySelector('h1').textContent,signedIn:state.account.signedIn,configured:state.configured,hasBridge:!!window.nekoVisits};
      })()`);
      assert.deepEqual(result, { title: '猫娘串门', signedIn: false, configured: false, hasBridge: true });
      fs.writeFileSync(process.env.NEKO_VISITS_ENTRY_RESULT, JSON.stringify({ ok: true, actualMainEntry: true, ...result }));
      app.quit();
    } catch { app.exit(1); }
  });
} else {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'neko-visits-entry-'));
  const env = { ...process.env, NEKO_VISITS_ENTRY_CHILD: '1', NEKO_VISITS_ENTRY_RESULT: path.join(temp, 'result.json'),
    NEKO_WORKBENCH_DATA_DIR: path.join(temp, 'data'), NEKO_WORKBENCH_WORKSPACE: path.join(temp, 'workspace'),
    NEKO_WORKBENCH_ELECTRON_USER_DATA: path.join(temp, 'electron'), PET_WORKBENCH_ONLY: '1', PET_OPEN_WORKBENCH: '0' };
  for (const key of Object.keys(env)) if (key.startsWith('NEKO_VISIT_') || key.startsWith('NEKO_WORKBENCH_DSH_') || key === 'ELECTRON_RUN_AS_NODE') delete env[key];
  const electron = process.argv[2] || path.join(root, 'node_modules/electron/dist/electron.exe');
  const child = spawn(electron, [__filename], { env, stdio: 'ignore', windowsHide: true });
  const timer = setTimeout(() => { child.kill(); }, 30000);
  let finished = false;
  const finish = code => {
    if (finished) return; finished = true;
    clearTimeout(timer);
    try {
      assert.equal(code, 0);
      const result = JSON.parse(fs.readFileSync(env.NEKO_VISITS_ENTRY_RESULT, 'utf8'));
      console.log(JSON.stringify(result));
    } catch { console.error('Native visits entry smoke failed'); process.exitCode = 1; }
    finally {
      const resolved = path.resolve(temp), parent = path.resolve(os.tmpdir());
      if (path.dirname(resolved) === parent && path.basename(resolved).startsWith('neko-visits-entry-')) fs.rmSync(resolved, { recursive: true, force: true });
    }
  };
  child.once('error', () => finish(1));
  child.once('exit', finish);
}
