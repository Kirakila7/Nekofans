'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { EventEmitter } = require('node:events');

if (!process.argv.includes('--main-harness')) {
  test('actual main routes selected Fish/QQ channels, cancels pending login and limits state disclosure', async () => {
    await new Promise((resolve, reject) => execFile(process.execPath, [__filename, '--main-harness'],
      { timeout: 15000, maxBuffer: 2e6, windowsHide: true }, (error, stdout, stderr) => {
        if (error) return reject(new Error(stdout + '\n' + stderr));
        assert.match(stdout, /Fish\/QQ main passed/);
        resolve();
      }));
  });

  test('workbench preload exposes unified channel actions and a removable state subscription', async () => {
    const vm = require('node:vm');
    const exposed = {}, calls = [], renderer = new EventEmitter();
    renderer.invoke = async (...args) => { calls.push(args); return { ok: true }; };
    vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../../apps/neko-workbench/workbench-preload.cjs'), 'utf8'), {
      require(name) {
        assert.equal(name, 'electron');
        return { ipcRenderer: renderer, contextBridge: { exposeInMainWorld(name, value) { exposed[name] = value; } } };
      },
    });
    const bridge = exposed.nekoWorkbench;
    assert.equal(Object.isFrozen(bridge), true);
    const request = { action: 'select', selection: { fish: false, qqbot: true } };
    assert.equal((await bridge.fishQq(request)).ok, true);
    assert.deepEqual(calls, [['workbench:call', 'fish-qq', request]]);
    const received = [], state = { fishQq: { selection: request.selection, qqbot: { phase: 'bound', connected: false } } };
    const unsubscribe = bridge.subscribe(value => received.push(value));
    renderer.emit('workbench:state', { sender: 'not exposed' }, state);
    assert.deepEqual(received, [state]);
    unsubscribe();
    renderer.emit('workbench:state', {}, state);
    assert.equal(received.length, 1);
    assert.equal(renderer.listenerCount('workbench:state'), 0);
    assert.equal('invoke' in bridge, false);
  });
} else {
  runMainHarness().catch(error => { console.error(error); process.exitCode = 1; });
}

async function runMainHarness() {
  const os = require('node:os'), Module = require('node:module'), { PassThrough } = require('node:stream');
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'neko-fish-qq-main-'));
  const data = path.join(temporary, 'data'), modules = path.join(temporary, 'modules'), cli = path.join(temporary, 'dsh');
  fs.mkdirSync(data);
  // Restored selection is a preference, never permission to start on launch.
  fs.writeFileSync(path.join(data, 'state.json'), JSON.stringify({ preferences: { fishQqSelection: { fish: false, qqbot: true } } }));
  fs.writeFileSync(cli, 'fixture');
  for (const name of ['dsh-llm', 'dsh-scope']) {
    fs.mkdirSync(path.join(modules, name, 'lib'), { recursive: true });
    fs.writeFileSync(path.join(modules, name, 'lib/index.js'), '');
  }
  Object.assign(process.env, { NEKO_WORKBENCH_DATA_DIR: data, NEKO_WORKBENCH_WORKSPACE: path.join(temporary, 'work'),
    NEKO_WORKBENCH_DSH_CLI: cli, NEKO_WORKBENCH_DSH_MODULES: modules, PET_OPEN_WORKBENCH: '1', PET_WORKBENCH_ONLY: '0' });
  const handlers = new Map(), windows = [], menus = [], requests = [], broadcasts = [];
  let stopped = false, holdQqStart = false, pendingQqStart = null, holdStatus = false;
  const pendingStatuses = [];
  const paused = name => ({ enabled: false, phase: 'paused', reason: 'fixture paused',
    ...(name === 'qqbot' ? { bound: false, connected: false, scopeConfigured: false } : {}) });
  const channels = { fish: paused('fish'), qqbot: paused('qqbot') };
  const app = new EventEmitter();
  Object.assign(app, { setName() {}, setPath() {}, getPath: () => temporary, requestSingleInstanceLock: () => true,
    whenReady: () => Promise.resolve(), focus() {}, quit() {
      let prevented = false;
      app.emit('before-quit', { preventDefault() { prevented = true; } });
      if (!prevented) stopped = true;
    } });
  const child = new EventEmitter();
  Object.assign(child, { pid: 123, killed: false, stdout: new PassThrough(), stderr: new PassThrough(),
    kill() { child.killed = true; child.emit('close', 0); } });
  const emit = (method, params) => child.stdout.write(JSON.stringify({ method, params }) + '\n');
  const reply = (request, result) => child.stdout.write(JSON.stringify({ id: request.id, result }) + '\n');
  child.stdin = new EventEmitter();
  child.stdin.write = line => {
    const request = JSON.parse(line);
    requests.push(request);
    setImmediate(() => {
      if (request.method === 'init') return reply(request, { sessionId: 'root', uiUrl: 'http://127.0.0.1:12345/' });
      if (['fish-care', 'qqbot-care'].includes(request.method)) {
        const name = request.method === 'fish-care' ? 'fish' : 'qqbot';
        const action = request.params.action;
        if (action === 'status' && holdStatus) {
          pendingStatuses.push({ request, value: { ...channels[name] } });
          return;
        }
        if (action === 'pause') channels[name] = paused(name);
        if (action === 'start') {
          if (name === 'qqbot' && holdQqStart) {
            pendingQqStart = request;
            channels.qqbot = { enabled: true, phase: 'login-required', reason: 'waiting for scan', bound: false, connected: false, scopeConfigured: false };
            emit('qqbot-care-state', channels.qqbot);
            return;
          }
          channels[name] = name === 'fish' ? { enabled: false, phase: 'login-required', reason: 'fish login required' }
            : { enabled: true, phase: 'bound', reason: 'bound, gateway not connected', bound: true, connected: false, scopeConfigured: true };
        }
        return reply(request, channels[name]);
      }
      reply(request, { accepted: true });
    });
  };
  child.stdin.end = () => child.emit('close', 0);
  class Window extends EventEmitter {
    constructor(options) {
      super(); this.options = options; this.destroyed = false; this.visible = false;
      this.bounds = { x: options.x || 0, y: options.y || 0, width: options.width, height: options.height };
      const wc = new EventEmitter();
      Object.assign(wc, { url: '', mainFrame: { url: '' }, getURL: () => wc.url,
        send: (channel, value) => broadcasts.push({ channel, value: structuredClone(value) }),
        isDestroyed: () => this.destroyed, isLoading: () => false, setWindowOpenHandler() {},
        setZoomFactor: value => { wc.zoom = value; }, getZoomFactor: () => wc.zoom || 1,
        session: { cookies: { set: async () => {} } } });
      this.webContents = wc; windows.push(this);
    }
    isDestroyed() { return this.destroyed; } show() { this.visible = true; } showInactive() { this.visible = true; }
    isVisible() { return this.visible; } hide() { this.visible = false; } focus() {} setTitle() {}
    setAlwaysOnTop() {} setVisibleOnAllWorkspaces() {} getPosition() { return [this.bounds.x, this.bounds.y]; }
    setPosition(x, y) { Object.assign(this.bounds, { x, y }); } setBounds(value) { Object.assign(this.bounds, value); }
    async loadURL(url) { this.webContents.url = url; this.webContents.mainFrame.url = url; setImmediate(() => this.webContents.emit('did-finish-load')); }
    destroy() { this.destroyed = true; this.emit('closed'); } close() { this.destroy(); }
    static fromWebContents(wc) { return windows.find(w => w.webContents === wc); }
  }
  class Tray extends EventEmitter { setTitle() {} setToolTip() {} popUpContextMenu() {} }
  const electron = { app, BrowserWindow: Window, ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    screen: { getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1600, height: 1000 } }) },
    shell: { openExternal: async () => {}, openPath: async () => {} },
    Menu: { buildFromTemplate: template => ({ template, popup() { menus.push(template); } }), setApplicationMenu() {} },
    Tray, nativeImage: { createEmpty: () => ({}) },
    dialog: { showErrorBox() {}, showMessageBox: async () => {}, showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
    nativeTheme: { shouldUseDarkColors: false },
    safeStorage: { isEncryptionAvailable: () => true, encryptString: value => Buffer.from(value), decryptString: value => value.toString() } };
  const originalLoad = Module._load;
  Module._load = function(name, ...args) {
    if (name === 'electron') return electron;
    if (name === 'node:child_process') return { spawn() { setImmediate(() => emit('ready', {})); return child; } };
    return originalLoad.call(this, name, ...args);
  };
  const wait = async check => {
    for (let n = 0; n < 500; n++) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
    throw Error('main fixture timed out');
  };
  const event = window => ({ sender: window.webContents, senderFrame: window.webContents.mainFrame });
  const channelRequests = () => requests.filter(request => ['fish-care', 'qqbot-care'].includes(request.method));
  const eventsFile = path.join(data, 'events.jsonl');
  const eventsText = () => fs.existsSync(eventsFile) ? fs.readFileSync(eventsFile, 'utf8') : '';
  try {
    require('../../apps/neko-workbench/main.cjs');
    await wait(() => handlers.has('workbench:call') && windows.some(window => window.options.title === 'N.E.K.O. 工作台'));
    const pet = windows.find(window => window.options.title !== 'N.E.K.O. 工作台');
    const workbench = windows.find(window => window.options.title === 'N.E.K.O. 工作台');
    const call = (method, value) => handlers.get('workbench:call')(event(workbench), method, value);
    const get = () => call('state');
    await wait(() => workbench.webContents.getURL() === 'http://127.0.0.1:12345/' && channelRequests().length === 2);
    await wait(async () => (await get()).workbench.connection === 'ready');
    assert.deepEqual((await get()).fishQq.selection, { fish: false, qqbot: true });
    assert.deepEqual(channelRequests().map(request => [request.method, request.params.action]), [['fish-care', 'pause'], ['qqbot-care', 'status']]);

    await call('fish-qq', { action: 'select', selection: { fish: true, qqbot: true } });
    await call('fish-qq', { action: 'select', selection: { fish: false } });
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(data, 'state.json'), 'utf8')).preferences.fishQqSelection, { fish: false, qqbot: true });
    assert.equal(channelRequests().some(request => request.params.action === 'start'), false);
    const beforeStart = channelRequests().length;
    await handlers.get('pet:call')(event(pet), 'menu');
    await menus.at(-1).find(item => item.label === '开始养鱼').click();
    const started = await get();
    assert.deepEqual(channelRequests().slice(beforeStart).map(request => [request.method, request.params.action]), [['qqbot-care', 'start']]);
    assert.equal(started.fish.phase, 'paused');
    assert.equal(started.qqbot.phase, 'bound');
    assert.equal(started.qqbot.bound, true);
    assert.equal(started.qqbot.connected, false);
    assert.equal(started.fishQq.qqbot.connected, false);
    assert(started.navigation.fishSettingsRevision > 0);
    await handlers.get('pet:call')(event(pet), 'menu');
    await menus.at(-1).find(item => item.label === '暂停养鱼').click();
    assert.equal((await get()).qqbot.phase, 'paused');

    const loggedBefore = eventsText();
    const secret = 'fixture-secret-must-not-leak';
    emit('qqbot-care-state', { enabled: true, phase: 'bound', reason: 'bound only', bound: true, connected: false,
      scopeConfigured: true, appSecret: secret, qrCode: secret, nested: { token: secret } });
    emit('fish-care-state', { enabled: false, phase: 'login-required', reason: 'login required', token: secret });
    await wait(async () => (await get()).fish.phase === 'login-required');
    const observed = await get();
    assert.deepEqual(Object.keys(observed.qqbot).sort(), ['bound', 'connected', 'enabled', 'phase', 'reason', 'scopeConfigured']);
    assert.equal(observed.fishQq.qqbot.phase, 'bound');
    assert.equal(observed.fishQq.qqbot.connected, false);
    assert.equal(JSON.stringify(observed).includes(secret), false);
    assert.equal(JSON.stringify(broadcasts).includes(secret), false);
    assert.equal(eventsText(), loggedBefore);
    assert(broadcasts.some(item => item.channel === 'workbench:state' && item.value.qqbot.phase === 'bound'));

    // Polling may return newer runtime data, but must not publish or replace the
    // event-driven cache. Here the fixture runtime is paused while the cache
    // intentionally holds the independent status notifications above.
    const cachedBeforePoll = await get();
    const broadcastsBeforePoll = broadcasts.filter(item => item.channel === 'workbench:state').length;
    const polled = await call('fish-qq', { action: 'status' });
    assert.equal(polled.fish.phase, 'paused');
    assert.equal(polled.qqbot.phase, 'paused');
    assert.deepEqual(await get(), cachedBeforePoll, 'status polling must leave the cached channel states unchanged');
    assert.equal(broadcasts.filter(item => item.channel === 'workbench:state').length, broadcastsBeforePoll,
      'status polling must not cause workbench state broadcasts');

    channels.fish = { enabled: true, phase: 'running', reason: 'fixture fish running' };
    channels.qqbot = { enabled: true, phase: 'running', reason: 'fixture gateway connected', bound: true, connected: true, scopeConfigured: true };
    emit('fish-care-state', channels.fish);
    emit('qqbot-care-state', channels.qqbot);
    await wait(async () => (await get()).qqbot.phase === 'running');
    holdStatus = true;
    let statusSettled = false;
    const slowStatus = call('fish-qq', { action: 'status' }).finally(() => { statusSettled = true; });
    await wait(() => pendingStatuses.length === 2);
    const pausedAfterPoll = await call('fish-qq', { action: 'pause' });
    assert.equal(statusSettled, false);
    assert.equal(pausedAfterPoll.fish.phase, 'paused');
    assert.equal(pausedAfterPoll.qqbot.phase, 'paused');
    const cachedAfterPause = await get();
    const broadcastsAfterPause = broadcasts.filter(item => item.channel === 'workbench:state').length;
    holdStatus = false;
    for (const { request, value } of pendingStatuses.splice(0)) reply(request, value);
    const lateStatus = await slowStatus;
    assert.equal(lateStatus.fish.phase, 'paused', 'late status must reflect the pause that superseded its running snapshot');
    assert.equal(lateStatus.qqbot.phase, 'paused');
    assert.deepEqual(await get(), cachedAfterPause, 'late status must not roll back a completed pause');
    assert.equal(broadcasts.filter(item => item.channel === 'workbench:state').length, broadcastsAfterPause);

    const beforeInvalid = requests.length;
    for (const request of [null, {}, { action: 'unknown' }, { action: 'select', selection: null }, { action: 'select', selection: { fish: 'yes' } }]) {
      await assert.rejects(call('fish-qq', request));
    }
    for (const invalidEvent of [event(pet), { sender: workbench.webContents, senderFrame: { url: workbench.webContents.getURL() } }]) {
      await assert.rejects(handlers.get('workbench:call')(invalidEvent, 'fish-qq', { action: 'start' }), /工作台/);
    }
    const originalUrl = workbench.webContents.mainFrame.url;
    workbench.webContents.mainFrame.url = 'https://example.invalid/';
    await assert.rejects(call('fish-qq', { action: 'start' }), /工作台/);
    workbench.webContents.mainFrame.url = originalUrl;
    assert.equal(requests.length, beforeInvalid);

    await call('fish-qq', { action: 'pause' });
    holdQqStart = true;
    let startSettled = false;
    const pendingStart = call('fish-qq', { action: 'start' }).finally(() => { startSettled = true; });
    await wait(async () => pendingQqStart && (await get()).qqbot.phase === 'login-required');
    const pausedState = await call('fish-qq', { action: 'pause' });
    assert.equal(startSettled, false, 'pause must reach both channels without waiting for a QR login');
    assert.equal(pausedState.fish.phase, 'paused');
    assert.equal(pausedState.qqbot.phase, 'paused');
    reply(pendingQqStart, { enabled: true, phase: 'running', reason: 'late scan result', bound: true, connected: true, scopeConfigured: true });
    await pendingStart;
    assert.equal((await get()).qqbot.phase, 'paused', 'a cancelled start result cannot revive displayed state');
    assert.equal((await get()).fishQq.qqbot.phase, 'paused');
    assert.deepEqual((await get()).fishQq.selection, { fish: false, qqbot: true });
    app.quit();
    await wait(() => stopped);
    console.log('Fish/QQ main passed');
  } finally {
    if (!stopped) { app.quit(); await wait(() => stopped).catch(() => {}); }
    Module._load = originalLoad;
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}
