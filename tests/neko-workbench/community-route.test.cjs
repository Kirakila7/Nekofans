'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { DEFAULT_COMMUNITY_URL, COMMUNITY_PARTITION, resolveCommunityUrl,
  classifyCommunityNavigation, createCommunityController, validateCommunityRequest,
  communityBounds } = require('../../apps/neko-workbench/community-config.cjs');

const tick = () => new Promise(resolve => setImmediate(resolve));
const bounds = { x: 300, y: 80, width: 800, height: 650 };
function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
function fixture(env = {}) {
  const views = [], external = [], states = [], errors = [];
  class Contents extends EventEmitter {
    constructor() { super(); this.loads = []; this.destroyed = false; this.url = ''; this.closed = []; this.behavior = null; }
    setWindowOpenHandler(handler) { this.popup = handler; }
    isDestroyed() { return this.destroyed; }
    getURL() { return this.url; }
    focus() { this.focused = (this.focused || 0) + 1; }
    async loadURL(url) {
      this.loads.push(url); this.url = url;
      this.emit('did-start-navigation', {}, url, false, true);
      if (this.behavior) await this.behavior(url);
      this.emit('did-navigate', {}, url, this.responseCode || 200, 'status');
      this.emit('did-finish-load');
    }
    close(options) { this.closed.push(options); this.destroyed = true; this.emit('destroyed'); }
  }
  class MockView {
    constructor(options) { this.options = options; this.webContents = new Contents(); this.rectangles = []; views.push(this); }
    setBounds(value) { this.rectangles.push(value); this.bounds = value; }
  }
  class MockHost extends EventEmitter {
    constructor() {
      super(); this.destroyed = false; this.size = [1100, 780]; this.scale = 1; this.focused = false; this.children = new Set(); this.additions = 0;
      this.webContents = new Contents(); this.webContents.getZoomFactor = () => this.scale;
      this.contentView = { addChildView: view => { this.additions++; this.children.add(view); }, removeChildView: view => this.children.delete(view) };
    }
    isDestroyed() { return this.destroyed; }
    getContentSize() { return this.size; }
    isFocused() { return this.focused; }
    destroy() { this.emit('close'); this.destroyed = true; this.emit('closed'); }
  }
  class Popup extends EventEmitter {
    constructor(options) { super(); this.options = options; this.webContents = new Contents(); this.destroyed = false; }
    loadURL(url) { return this.webContents.loadURL(url); }
    isDestroyed() { return this.destroyed; }
    destroy() { this.destroyed = true; this.webContents.close(); this.emit('closed'); }
  }
  const controller = createCommunityController({ WebContentsView: MockView, env,
    openExternal: async url => external.push(url), onState: (host, value) => states.push({ host, ...value }), onExternalError: error => errors.push(error) });
  const host = new MockHost();
  const action = request => controller.action(host, request);
  const open = (value = bounds) => action({ action: 'open', bounds: value });
  return { controller, views, external, states, errors, MockHost, Popup, host, action, open };
}
function navigate(contents, type, url) {
  let prevented = false;
  contents.emit(type, { preventDefault() { prevented = true; } }, url);
  return prevented;
}
function secure(options) {
  const { webPreferences } = options;
  assert.equal(webPreferences.partition, COMMUNITY_PARTITION);
  assert.notEqual(webPreferences.partition, 'persist:pet-dsh');
  assert.equal(webPreferences.nodeIntegration, false);
  assert.equal(webPreferences.contextIsolation, true);
  assert.equal(webPreferences.sandbox, true);
  assert.equal(webPreferences.webSecurity, true);
  assert.equal(webPreferences.webviewTag, false);
  assert.equal(webPreferences.allowRunningInsecureContent, false);
  assert.equal('preload' in webPreferences, false);
}

test('native feed is an isolated child WebContentsView with no BrowserWindow or focus', async () => {
  const f = fixture();
  assert.equal(DEFAULT_COMMUNITY_URL, 'https://community.project-neko.cn/feed');
  assert.equal(resolveCommunityUrl(''), DEFAULT_COMMUNITY_URL);
  assert.deepEqual(await f.open(), { ok: true });
  assert.equal(f.views.length, 1); secure(f.views[0].options);
  assert.deepEqual(f.views[0].webContents.loads, [DEFAULT_COMMUNITY_URL]);
  assert.deepEqual(f.views[0].bounds, bounds);
  assert.equal(f.host.children.has(f.views[0]), true);
  assert.deepEqual(f.states.map(value => value.status), ['loading', 'ready']);
  f.controller.dispose();
});

test('concurrent opens and hide/reopen reuse the page, session and scroll without reloading', async () => {
  const f = fixture({ NEKO_WORKBENCH_COMMUNITY_URL: 'https://community.example.org/topics?sort=latest#news' });
  await Promise.all([f.open(), f.open()]);
  const view = f.views[0]; view.webContents.scrollFixture = 240;
  await f.action({ action: 'hide' }); assert.equal(f.host.children.size, 0);
  assert.equal(view.webContents.isDestroyed(), false);
  await f.open();
  assert.equal(f.views.length, 1); assert.equal(view.webContents.loads.length, 1);
  assert.equal(view.webContents.scrollFixture, 240); assert.equal(f.host.children.has(view), true);
  f.controller.dispose(); assert.equal(f.controller.view, null);
  assert.deepEqual(view.webContents.closed, [{ waitForBeforeUnload: false }]);
  await f.open(); assert.equal(f.views.length, 2); f.controller.dispose();
});

test('bounds accept only finite CSS pixels, scale by host zoom and clamp the view to content DIP', async () => {
  const f = fixture(); f.host.scale = 1.25;
  assert.deepEqual(communityBounds(f.host, { x: -5, y: 40, width: 1000, height: 900 }), { x: 0, y: 50, width: 1100, height: 730 });
  await f.open(); assert.deepEqual(f.views[0].bounds, { x: 375, y: 100, width: 725, height: 680 });
  f.host.size = [700, 500]; f.host.emit('resize');
  assert.deepEqual(f.views[0].bounds, { x: 375, y: 100, width: 325, height: 400 });
  await f.action({ action: 'layout', bounds: { x: 100, y: 60, width: 400, height: 300 } });
  assert.deepEqual(f.views[0].bounds, { x: 125, y: 75, width: 500, height: 375 });
  f.host.scale = 1; f.host.emit('zoom-changed'); f.host.webContents.emit('zoom-changed');
  assert.deepEqual(f.views[0].bounds, { x: 100, y: 60, width: 400, height: 300 });
  await f.action({ action: 'layout', bounds: { x: 900, y: 60, width: 400, height: 300 } }); assert.equal(f.host.children.size, 0);
  const invalid = [undefined, { action: 'open' }, { action: 'layout', bounds: { ...bounds, width: 0 } },
    { action: 'open', bounds: { ...bounds, x: NaN } }, { action: 'open', bounds: { ...bounds, width: Infinity } },
    { action: 'open', bounds: { ...bounds, url: DEFAULT_COMMUNITY_URL } }, { action: 'hide', url: DEFAULT_COMMUNITY_URL },
    { action: 'navigate', bounds }, { action: 'open', bounds: { ...bounds, x: 10000000 } }];
  for (const request of invalid) assert.throws(() => validateCommunityRequest(request));
  await assert.rejects(f.open({ x: 1000, y: 10, width: 10, height: 10 }), /布局/);
  f.controller.dispose();
});

test('credentials, unsafe protocols and malformed configured URLs fail before creating a view', async () => {
  for (const value of ['http://community.example.org', 'javascript:alert(1)', 'file:///private-fixture',
    'https://user:password@community.example.org', 'https://user@community.example.org',
    'https://community.example.org/?access_token=fixture-only', 'https://community.example.org/#api_key=fixture-only',
    'https://community.example.org/\nnew-path', '//community.example.org', 'not a URL']) {
    assert.throws(() => resolveCommunityUrl(value), /HTTPS/);
    const f = fixture({ NEKO_WORKBENCH_COMMUNITY_URL: value });
    await assert.rejects(f.open(), /HTTPS/); assert.equal(f.views.length, 0); assert.deepEqual(f.external, []); f.controller.dispose();
  }
});

test('community/auth origins stay internal; external navigation and redirects use the system browser', async () => {
  const f = fixture(); await f.open(); const contents = f.views[0].webContents;
  for (const type of ['will-navigate', 'will-redirect']) {
    assert.equal(navigate(contents, type, 'https://community.project-neko.cn/topics/1'), false);
    assert.equal(navigate(contents, type, 'https://auth.project-neko.cn/login'), false);
    assert.equal(navigate(contents, type, 'https://community.project-neko.cn.evil.invalid/'), true);
    assert.equal(navigate(contents, type, 'http://external.example.org/page'), true);
    for (const value of ['javascript:alert(1)', 'file:///private-fixture', 'data:text/html,fixture', 'https://user:password@example.org']) assert.equal(navigate(contents, type, value), true);
  }
  await tick(); assert.deepEqual(f.external, ['https://community.project-neko.cn.evil.invalid/', 'http://external.example.org/page', 'https://community.project-neko.cn.evil.invalid/', 'http://external.example.org/page']);
  assert.equal(classifyCommunityNavigation('https://auth.project-neko.cn:8443/login').kind, 'external'); f.controller.dispose();
});

test('only auth may popup; community blank links stay embedded, auth popups share isolated session and close with host', async () => {
  const f = fixture(); await f.open(); const contents = f.views[0].webContents;
  assert.equal(contents.popup({ url: 'https://community.project-neko.cn/topics/1' }).action, 'deny'); await tick();
  assert.equal(contents.loads.at(-1), 'https://community.project-neko.cn/topics/1');
  const allowed = contents.popup({ url: 'https://auth.project-neko.cn/login' }); assert.equal(allowed.action, 'allow');
  assert.equal(allowed.overrideBrowserWindowOptions.parent, f.host); secure(allowed.overrideBrowserWindowOptions);
  const popup = new f.Popup(allowed.overrideBrowserWindowOptions); contents.emit('did-create-window', popup);
  assert.equal(navigate(popup.webContents, 'will-redirect', 'https://external.example.org/'), true);
  for (const url of ['file:///private-fixture', 'javascript:alert(1)', 'https://external.example.org/']) assert.equal(contents.popup({ url }).action, 'deny');
  await tick(); assert.equal(f.external.length, 2);
  f.controller.dispose(); assert.equal(popup.destroyed, true);
  assert.equal(contents.isDestroyed(), true);
});

test('network and HTTP failures detach content and report failure rather than accepting loadURL resolution', async () => {
  const f = fixture(); const first = f.open(); const contents = f.views[0].webContents;
  contents.behavior = async () => { throw Error('network fixture only'); };
  await assert.rejects(first, /未能打开/); assert.equal(f.host.children.size, 0); assert.equal(f.states.at(-1).status, 'error');
  contents.behavior = null; contents.responseCode = 503;
  await assert.rejects(f.action({ action: 'reload' }), /未能打开/); assert.equal(f.host.children.size, 0);
  contents.responseCode = 200; assert.deepEqual(await f.action({ action: 'reload' }), { ok: true }); assert.equal(f.host.children.size, 1);
  contents.emit('did-start-navigation', {}, DEFAULT_COMMUNITY_URL, false, true);
  contents.emit('did-navigate', {}, DEFAULT_COMMUNITY_URL, 404, 'not found'); contents.emit('did-finish-load');
  assert.equal(f.host.children.size, 0); assert.equal(f.states.at(-1).status, 'error');
  await f.action({ action: 'reload' }); assert.equal(f.host.children.size, 1);
  contents.emit('did-fail-load', {}, -105, 'fixture dns', DEFAULT_COMMUNITY_URL, true); contents.emit('did-finish-load');
  assert.equal(f.host.children.size, 0); assert.equal(f.states.at(-1).error.includes('fixture'), false); f.controller.dispose();
});

test('hide cancels a pending native call immediately; new open never waits on the old view or ERR_ABORTED', async () => {
  const f = fixture(); const gate = deferred(); const first = f.open(); const contents = f.views[0].webContents;
  const canceled = assert.rejects(first, /已隐藏/);
  contents.behavior = () => gate.promise; await tick(); const stateCount = f.states.length;
  await f.action({ action: 'hide' }); await canceled;
  assert.equal(contents.isDestroyed(), true); assert.equal(f.host.children.size, 0);
  assert.equal(f.states.length, stateCount, 'explicit hide emits no delayed hidden event');
  await f.open(); assert.equal(f.views.length, 2); assert.equal(f.host.children.has(f.views[1]), true);
  const readyCount = f.states.length;
  gate.reject(Error('ERR_ABORTED from retired navigation')); await tick();
  assert.equal(f.states.length, readyCount); assert.equal(f.states.at(-1).status, 'ready');
  assert.equal(f.host.children.has(f.views[1]), true); f.controller.dispose();
});

test('open and reload focus only the child view of an already focused host; layout never changes focus', async () => {
  const f = fixture(); await f.open(); const contents = f.views[0].webContents;
  assert.equal(contents.focused || 0, 0);
  f.host.focused = true; await f.open(); assert.equal(contents.focused, 1);
  await f.action({ action: 'reload' }); assert.equal(contents.focused, 2);
  await f.action({ action: 'layout', bounds }); assert.equal(contents.focused, 2);
  f.host.focused = false; await f.action({ action: 'reload' }); assert.equal(contents.focused, 2);
  f.controller.dispose();
});

test('host close-to-tray notifies hidden before disposing; loaded explicit hide keeps the view and emits nothing', async () => {
  const f = fixture(); await f.open(); const contents = f.views[0].webContents;
  const stateCount = f.states.length;
  await f.action({ action: 'hide' }); assert.equal(f.states.length, stateCount);
  assert.equal(contents.isDestroyed(), false); await f.open(); assert.equal(f.views.length, 1);
  f.host.emit('close'); assert.equal(f.states.at(-1).status, 'hidden');
  assert.equal(contents.isDestroyed(), true); assert.equal(f.controller.view, null);
  await f.open(); assert.equal(f.views.length, 2); assert.equal(f.host.children.has(f.views[1]), true); f.controller.dispose();
});

test('host navigation/reload/close/render destruction disposes child webContents and fences late loads', async () => {
  for (const event of ['will-navigate', 'did-start-navigation', 'close', 'render-process-gone', 'destroyed']) {
    const f = fixture(); const gate = deferred(); const first = f.open(); const contents = f.views[0].webContents;
    contents.behavior = () => gate.promise; await tick();
    if (event === 'close') f.host.emit('close');
    else if (event === 'did-start-navigation') f.host.webContents.emit(event, {}, 'http://127.0.0.1:59000/', false, true);
    else f.host.webContents.emit(event, {}, 'http://127.0.0.1:59000/');
    assert.equal(contents.isDestroyed(), true); assert.equal(f.states.at(-1).status, 'hidden');
    gate.resolve(); await assert.rejects(first, /已隐藏|离开/);
    assert.equal(f.host.children.size, 0); assert.equal(f.controller.view, null); f.controller.dispose();
  }
});

test('concurrent refreshes coalesce and neither may attach or publish stale state after hide', async () => {
  const f = fixture(); await f.open(); const contents = f.views[0].webContents;
  const gate = deferred(); let requests = 0;
  contents.behavior = () => { requests++; return gate.promise; };
  const first = f.action({ action: 'reload' }); await tick(); const second = f.action({ action: 'reload' }); await tick();
  assert.equal(requests, 1); assert.equal(f.host.children.size, 0);
  const rejected = [assert.rejects(first, /已隐藏/), assert.rejects(second, /已隐藏/)];
  const stateCount = f.states.length;
  await f.action({ action: 'hide' }); await Promise.all(rejected); gate.resolve(); await tick();
  assert.equal(f.host.children.size, 0); assert.equal(f.states.length, stateCount); f.controller.dispose();
});

test('repeated refresh clicks share one navigation and all return the real successful outcome', async () => {
  const f = fixture(); await f.open(); const contents = f.views[0].webContents;
  const gate = deferred(); let requests = 0;
  contents.behavior = () => { requests++; return gate.promise; };
  const first = f.action({ action: 'reload' }); await tick(); const second = f.action({ action: 'reload' }); await tick();
  gate.resolve(); assert.deepEqual(await first, { ok: true }); assert.deepEqual(await second, { ok: true });
  assert.equal(requests, 1); assert.equal(f.host.children.size, 1); f.controller.dispose();
});

test('failure from a canceled hidden view cannot publish an error or reattach content', async () => {
  const f = fixture(); const gate = deferred(); const first = f.open(); const contents = f.views[0].webContents;
  const canceled = assert.rejects(first, /已隐藏/);
  contents.behavior = () => gate.promise; await tick(); const stateCount = f.states.length;
  await f.action({ action: 'hide' }); await canceled;
  gate.reject(Error('fixture failure')); await tick();
  assert.equal(f.states.length, stateCount); assert.equal(f.host.children.size, 0); f.controller.dispose();
});
