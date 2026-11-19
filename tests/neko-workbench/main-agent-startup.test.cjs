'use strict';

const assert = require('node:assert/strict');
const {spawnSync} = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {test} = require('node:test');
const workbench = path.resolve(__dirname, '../../apps/neko-workbench');
const legacyAddress = 'http://127.0.0.1:49120';
const legacyMessage = {role:'user',text:'旧档聊天测试'};

if (process.versions.electron && process.env.NEKO_GUIDE_STARTUP_CHILD) {
  const {app, BrowserWindow} = require('electron');
  const legacy = process.env.NEKO_GUIDE_STARTUP_CHILD === 'legacy';
  let localChatRequests = 0;
  if (legacy) {
    const fetch = globalThis.fetch;
    globalThis.fetch = (input, ...args) => {
      if (String(input).startsWith(legacyAddress)) {
        localChatRequests++;
        return Promise.reject(Error('legacy chat fixture'));
      }
      return fetch(input, ...args);
    };
  }
  app.commandLine.appendSwitch('disable-background-networking');
  app.commandLine.appendSwitch('host-resolver-rules', 'MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1');
  require(path.join(workbench, 'main.cjs'));
  const deadline = Date.now() + 10000;
  const poll = setInterval(async () => {
    const windows = BrowserWindow.getAllWindows().filter(window => !window.isDestroyed());
    const guide = windows.find(window => window.isVisible() && window.webContents.getURL().includes('view=main-agent-guide'));
    const desktop = windows.find(window => window.isVisible() && window.webContents.getURL().includes('view=pet'));
    // The offline test uses the workbench's connection placeholder.
    const launcher = windows.some(window => window.webContents.getURL().startsWith('data:text/html'));
    if (Date.now() >= deadline) {
      clearInterval(poll);
      console.error('Expected desktop pet, first-run guide and startup workbench windows', windows.map(w => [w.isVisible(),w.webContents.getURL().slice(0,170)]));
      app.exit(1);
    } else if (legacy && desktop && !desktop.webContents.isLoading()) {
      try {
        const state = await desktop.webContents.executeJavaScript('window.pet.call("state")');
        if (!state.mainChat) return;
        clearInterval(poll);
        assert.equal(localChatRequests,0);
        assert.equal(state.actors[0].chatBackend,null);
        assert.equal(state.mainChat.ready,false);
        assert.match(state.mainChat.error,/独立工具/);
        assert.deepEqual(state.neko.history,[legacyMessage]);
        const refused = await desktop.webContents.executeJavaScript('window.pet.call("prompt",{id:"main",text:"回归测试"}).then(() => "", error => error.message)');
        assert.match(refused,/独立工具/);
        console.log('LEGACY_CHAT_STARTUP_OK');
        app.quit();
      } catch (error) {
        clearInterval(poll);
        console.error(error);
        app.exit(1);
      }
    } else if (!legacy && guide && desktop && launcher && !guide.webContents.isLoading()) {
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
  const skip = !electron || process.platform !== 'win32';
  function launchFixture(mode, expected) {
    const temporary = fs.realpathSync(os.tmpdir());
    const profile = fs.mkdtempSync(path.join(temporary, 'neko-guide-startup-'));
    const env = {...process.env, NEKO_GUIDE_STARTUP_CHILD:mode, PET_OPEN_WORKBENCH:mode === 'fresh' ? '1' : '', PET_WORKBENCH_ONLY:'',
      NEKO_WORKBENCH_DATA_DIR:path.join(profile,'data'), NEKO_WORKBENCH_WORKSPACE:path.join(profile,'workspace'),
      NEKO_WORKBENCH_ELECTRON_USER_DATA:path.join(profile,'electron'), NEKO_WORKBENCH_DSH_HOME:'',
      NEKO_WORKBENCH_DSH_CLI:'', NEKO_WORKBENCH_DSH_MODULES:'', NEKO_WORKBENCH_DSH_CREDENTIALS:''};
    delete env.ELECTRON_RUN_AS_NODE;
    try {
      if (mode === 'legacy') {
        fs.mkdirSync(env.NEKO_WORKBENCH_DATA_DIR);
        fs.writeFileSync(path.join(env.NEKO_WORKBENCH_DATA_DIR,'state.json'),JSON.stringify({
          actors:[{id:'main',name:'大肥鱼',chatBackend:'neko',messages:[legacyMessage]}],
          neko:{enabled:true,baseUrl:legacyAddress,character:'旧角色'},
        }));
      }
      const child = spawnSync(electron, [__filename], {env, encoding:'utf8', timeout:18000, windowsHide:true});
      if (child.error) throw child.error;
      assert.equal(child.status, 0, child.stdout + child.stderr);
      assert.match(child.stdout, expected);
    } finally {
      if (path.dirname(fs.realpathSync(profile)) === temporary) fs.rmSync(profile, {recursive:true, force:true});
    }
  }
  test('fresh desktop opens the guide when Windows also opens the workbench', {skip}, () => launchFixture('fresh',/GUIDE_STARTUP_OK/));
  test('a legacy local chat profile opens the pet without connecting or selecting an account', {skip}, () => launchFixture('legacy',/LEGACY_CHAT_STARTUP_OK/));
}
