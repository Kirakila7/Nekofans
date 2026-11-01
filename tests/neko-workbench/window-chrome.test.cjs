'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { workbenchWindowChrome, updateWindowChrome, toggleWindowFullscreen } = require('../../apps/neko-workbench/window-chrome.cjs');
const base = path.resolve(__dirname, '../../apps/neko-workbench');

test('Windows keeps system caption controls in a themed overlay instead of stacked native chrome', () => {
  const light = workbenchWindowChrome('win32', false), dark = workbenchWindowChrome('win32', true);
  assert.equal(light.titleBarStyle, 'hidden');
  assert.equal(light.autoHideMenuBar, true);
  assert.equal(light.titleBarOverlay.height, 36);
  assert.notEqual(light.titleBarOverlay.color, dark.titleBarOverlay.color);
  assert.notEqual(light.titleBarOverlay.symbolColor, dark.titleBarOverlay.symbolColor);
  const updates = [], host = { isDestroyed: () => false, setTitleBarOverlay: value => updates.push(value) };
  updateWindowChrome(host, true, 'win32');
  assert.deepEqual(updates, [dark.titleBarOverlay]);
  updateWindowChrome({ ...host, webContents: { getZoomFactor: () => 1.5 } }, true, 'win32');
  assert.equal(updates.at(-1).height, 54, 'system caption controls follow page zoom');
  updateWindowChrome({ isDestroyed: () => true }, false, 'win32');
  updateWindowChrome(host, false, 'darwin');
  assert.equal(updates.length, 2);
  assert.throws(() => updateWindowChrome(host, 'dark', 'win32'), TypeError);
  assert.equal(workbenchWindowChrome('darwin').titleBarStyle, 'hiddenInset');
  assert.deepEqual(workbenchWindowChrome('linux'), {});
});

test('the actual theme IPC authenticates its main frame before touching native window controls', async () => {
  const source = fs.readFileSync(path.join(base, 'main.cjs'), 'utf8');
  const validation = source.slice(source.indexOf('function isWorkbenchOrigin'), source.indexOf('function rolesState'));
  const first = source.indexOf("ipcMain.handle('workbench:call'");
  const route = source.slice(first, source.indexOf("  if(method==='workspace')", first)) + "throw Error('Unknown method');});";
  const handlers = new Map(), updates = [], contents = { mainFrame: { url: 'http://127.0.0.1:49999/' } };
  let fullscreen = false;
  const host = { webContents: contents, isDestroyed: () => false, setTitleBarOverlay: theme => updates.push(theme), isFullScreen: () => fullscreen, setFullScreen: value => { fullscreen = value; } };
  vm.runInNewContext(validation + route, { URL, dshWindow: host, dshLaunchUrl: 'http://127.0.0.1:49999/',
    updateWindowChrome, toggleWindowFullscreen, workbenchState: () => ({}), ipcMain: { handle: (name, fn) => handlers.set(name, fn) } });
  const call = handlers.get('workbench:call'), valid = { sender: contents, senderFrame: contents.mainFrame };
  for (const event of [{ sender: {}, senderFrame: contents.mainFrame }, { sender: contents, senderFrame: { url: contents.mainFrame.url } }]) {
    await assert.rejects(call(event, 'window-theme', true), /工作台/);
    await assert.rejects(call(event, 'toggle-fullscreen'), /工作台/);
  }
  const original = contents.mainFrame.url;
  contents.mainFrame.url = 'https://example.invalid/';
  await assert.rejects(call(valid, 'window-theme', true), /工作台/);
  contents.mainFrame.url = original;
  assert.equal(updates.length, 0);
  await assert.rejects(call(valid, 'window-theme', { dark: true }), /boolean/);
  await call(valid, 'window-theme', true);
  assert.equal(updates.length, process.platform === 'win32' ? 1 : 0);
  assert.equal((await call(valid, 'toggle-fullscreen')).fullscreen, true);
  assert.equal(fullscreen, true);
  assert.equal((await call(valid, 'toggle-fullscreen')).fullscreen, false);
  assert.equal(fullscreen, false);
});

test('F11 toggles only on an unmodified first keydown and leaves other keys alone', () => {
  const source = fs.readFileSync(path.join(base, 'main.cjs'), 'utf8');
  const handler = source.split('\n').find(line => line.includes("webContents.on('before-input-event'"));
  let callback, toggles = 0, prevented = 0;
  const host = { webContents: { on: (name, fn) => { assert.equal(name, 'before-input-event'); callback = fn; } } };
  vm.runInNewContext(handler, { dshWindow: host, toggleWindowFullscreen: window => { assert.equal(window, host); toggles++; } });
  for (const input of [{ type: 'keyUp', key: 'F11' }, { type: 'keyDown', key: 'Escape' }, { type: 'keyDown', key: 'F11', isAutoRepeat: true }, { type: 'keyDown', key: 'F11', alt: true }]) callback({ preventDefault: () => prevented++ }, input);
  assert.equal(toggles, 0);
  callback({ preventDefault: () => prevented++ }, { type: 'keyDown', key: 'F11' });
  assert.equal(toggles, 1); assert.equal(prevented, 1);
});

for (const [platform, expected] of [['win32', 'overlay'], ['darwin', 'inset'], ['linux', 'native']]) {
  test(`the ${platform} preload exposes only its chrome capability and a typed theme request`, async () => {
    const exposed = {}, calls = [];
    vm.runInNewContext(fs.readFileSync(path.join(base, 'workbench-preload.cjs'), 'utf8'), {
      process: { platform }, require: () => ({
        contextBridge: { exposeInMainWorld: (name, api) => { exposed[name] = api; } },
        ipcRenderer: { invoke: async (...args) => calls.push(args), on() {}, removeListener() {} },
      }),
    });
    const bridge = exposed.nekoWorkbench;
    assert.equal(bridge.windowChrome, expected);
    assert(Object.isFrozen(bridge));
    await assert.rejects(bridge.setWindowTheme({ dark: true }), /boolean/);
    assert.equal(calls.length, 0);
    await bridge.setWindowTheme(true);
    assert.deepEqual(calls, [['workbench:call', 'window-theme', true]]);
    await bridge.toggleFullscreen();
    assert.deepEqual(calls.at(-1), ['workbench:call', 'toggle-fullscreen', undefined]);
    assert.equal(bridge.process, undefined);
  });
}

let JSDOM;
try { ({ JSDOM } = require(path.join(process.env.NEKO_DOM_DEPS || '/private/tmp/neko-sidebar-dom-20261026', 'node_modules/jsdom'))); } catch {}
for (const chrome of ['overlay', 'inset', undefined]) {
  test(`${chrome || 'browser'} chrome keeps one sidebar, preserves drafts and releases owned header state`, { skip: !JSDOM }, async t => {
    const embedded = path.join(base, 'embedded-dsh');
    const read = name => fs.readFileSync(path.join(embedded, name), 'utf8');
    const dom = new JSDOM('<head><style>.fixture_logoRow{padding-top:8px}</style></head><body data-neko-side-rail-layout><div data-neko-rail-app><aside class="fixture_sidebarCol"><div data-slot="sidebar"><div class="fixture_root"><div class="fixture_logoRow"><button aria-label="收起侧边栏">toggle</button></div><div data-neko-seat-mount></div><div data-slot="sidebar.workspaces"></div></div><div data-slot="settings.launcher"></div></div></aside><main><textarea>retained native draft</textarea></main></div></body>', { runScripts: 'outside-only', pretendToBeVisual: true });
    t.after(() => dom.window.close());
    const w = dom.window, d = w.document, themes = []; let fullscreenClicks = 0;
    const bridge = { windowChrome: chrome, toggleFullscreen: async () => { fullscreenClicks++; }, setWindowTheme: async dark => themes.push(dark), action: async () => ({}), getState: async () => ({ workspaceRevision: 0, companion: { ready: true, messages: [] } }), companion: async () => ({}), workspace: async r => r.action === 'state' ? { seats: [], officeMode: 'dsh' } : r.action === 'catalog' ? { sessions: [], projects: [], providers: {} } : { items: [], approvals: [] } };
    w.eval(read('workspace-shell-source.js'));
    const stop = w.installWorkspaceShell({ window: w, document: d, bridge, cssText: read('side-rail-source.css') + '\n' + read('workspace-shell-source.css'), avatar: () => '', locateSidebar: () => ({ root: d.querySelector('.fixture_root') }) });
    t.after(stop);
    const tick = () => new Promise(resolve => setTimeout(resolve, 30));
    await tick();
    const native = d.querySelector('main textarea'), draft = d.querySelector('.neko-companion-form textarea');
    draft.value = 'retained private draft';
    assert.equal(d.querySelectorAll('.neko-window-titlebar').length, chrome === 'overlay' ? 1 : 0);
    if (chrome === 'overlay') { const button = d.querySelector('.neko-window-titlebar__fullscreen'); assert(button.getAttribute('aria-label').includes('F11')); button.click(); await tick(); assert.equal(fullscreenClicks, 1); }
    assert.equal(w.getComputedStyle(d.querySelector('[data-neko-native-brand-row]')).paddingTop, chrome === 'inset' ? '38px' : '8px');
    assert.equal(w.getComputedStyle(d.querySelector('.neko-collapsed-rail')).paddingTop, chrome === 'inset' ? '42px' : '8px');
    d.body.setAttribute('data-ds-dark-theme', ''); await tick();
    if (chrome === 'overlay') assert.deepEqual(themes, [false, true]);
    else assert.deepEqual(themes, []);
    assert.equal(native.value, 'retained native draft');
    assert.equal(draft.value, 'retained private draft');
    stop();
    assert.equal(d.querySelector('.neko-window-titlebar'), null);
    assert(!d.body.hasAttribute('data-neko-inset-titlebar'));
    assert(!d.body.hasAttribute('data-neko-overlay-titlebar'));
    assert.equal(native.value, 'retained native draft');
  });
}
