'use strict';

const assert = require('node:assert/strict');
const {spawnSync} = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {test} = require('node:test');
const workbench = path.resolve(__dirname, '../../apps/neko-workbench');

if (process.versions.electron && process.env.NEKO_GUIDE_STARTUP_CHILD === '1') {
  const {app, BrowserWindow} = require('electron');
  app.commandLine.appendSwitch('disable-background-networking');
  app.commandLine.appendSwitch('host-resolver-rules', 'MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1');
  require(path.join(workbench, 'main.cjs'));
  const deadline = Date.now() + 10000;
  const poll = setInterval(async () => {
    const windows = BrowserWindow.getAllWindows().filter(window => !window.isDestroyed());
    const guide = windows.find(window => window.isVisible() && window.webContents.getURL().includes('view=main-agent-guide'));
    const desktop = windows.some(window => window.isVisible() && window.webContents.getURL().includes('view=pet'));
    // The offline test uses the workbench's connection placeholder.
    const launcher = windows.some(window => window.webContents.getURL().startsWith('data:text/html'));
    if (Date.now() >= deadline) {
      clearInterval(poll);
      console.error('Expected desktop pet, first-run guide and startup workbench windows', windows.map(w => [w.isVisible(),w.webContents.getURL().slice(0,170)]));
      app.exit(1);
    } else if (guide && desktop && launcher && !guide.webContents.isLoading()) {
      try {
        const ready = await guide.webContents.executeJavaScript('Boolean(document.querySelector("[data-name]"))');
        if (!ready) return;
        clearInterval(poll);
        console.log('GUIDE_STARTUP_OK');
        app.quit();
      } catch {}
    }
  }, 80);
} else {
  const electron = process.env.NEKO_WORKBENCH_ELECTRON;
  test('fresh desktop opens the guide when Windows also opens the workbench', {skip: !electron || process.platform !== 'win32'}, () => {
    const temporary = fs.realpathSync(os.tmpdir());
    const profile = fs.mkdtempSync(path.join(temporary, 'neko-guide-startup-'));
    const env = {...process.env, NEKO_GUIDE_STARTUP_CHILD:'1', PET_OPEN_WORKBENCH:'1', PET_WORKBENCH_ONLY:'',
      NEKO_WORKBENCH_DATA_DIR:path.join(profile,'data'), NEKO_WORKBENCH_WORKSPACE:path.join(profile,'workspace'),
      NEKO_WORKBENCH_ELECTRON_USER_DATA:path.join(profile,'electron'), NEKO_WORKBENCH_DSH_HOME:'',
      NEKO_WORKBENCH_DSH_CLI:'', NEKO_WORKBENCH_DSH_MODULES:'', NEKO_WORKBENCH_DSH_CREDENTIALS:''};
    delete env.ELECTRON_RUN_AS_NODE;
    try {
      const child = spawnSync(electron, [__filename], {env, encoding:'utf8', timeout:18000, windowsHide:true});
      if (child.error) throw child.error;
      assert.equal(child.status, 0, child.stdout + child.stderr);
      assert.match(child.stdout, /GUIDE_STARTUP_OK/);
    } finally {
      if (path.dirname(fs.realpathSync(profile)) === temporary) fs.rmSync(profile, {recursive:true, force:true});
    }
  });
}
