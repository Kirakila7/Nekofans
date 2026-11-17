'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const vm = require('node:vm');
const dshUpdater = require('../../apps/neko-workbench/windows-dsh-update.cjs');
const { createDshUpdateStore, isNewer, parseFeed } = dshUpdater;

const bundledVersion = '0.2.2-rc.1';
const previousVersion = '0.2.2-rc.2';
const trialVersion = '0.2.2-rc.3';
const tick = () => new Promise(resolve => setImmediate(resolve));

function updateStore(t) {
  const data = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'neko-dsh-updater-test-'));
  t.after(() => fs.rmSync(data, { recursive: true, force: true }));
  const store = createDshUpdateStore(data);
  fs.mkdirSync(store.root);
  return store;
}

function stage(store, version, directory, currentVersion) {
  const resources = store.resources({ version, directory });
  const host = path.join(resources, 'app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host');
  for (const dir of [host, path.join(resources, 'app.asar.unpacked'), path.join(resources, 'runtime/primary-runtime')]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(path.join(host, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-desktop-host', version }));
  store.activate(version, directory, currentVersion);
  return resources;
}

test('official feed supports the installer YAML format and rejects another download origin', () => {
  const url = 'https://download.deepseek.com/dsh-desk/bin/win-x64/deepseek-harness-0.2.2-rc.2-win-x64.exe';
  const hash = Buffer.alloc(64, 1).toString('base64');
  const body = ['version: 0.2.2-rc.2', 'path: >-', '  '+url, 'sha512: >-', '  '+hash].join('\r\n');
  assert.deepEqual(parseFeed(body), { version: '0.2.2-rc.2', url, sha512: hash, date: '' });
  assert.throws(() => parseFeed(body.replace('download.deepseek.com', 'example.com')));
  assert.throws(() => parseFeed(body.replace('rc.2-win', 'rc.1-win')));
  assert(isNewer('0.2.2-rc.10', '0.2.2-rc.2'));
  assert(isNewer('0.2.2', '0.2.2-rc.10'));
  assert(!isNewer('0.2.2-rc.1', '0.2.2'));
});

test('failed trial restores the last confirmed engine and never trusts an invalid directory', t => {
  const store = updateStore(t);
  fs.writeFileSync(path.join(store.root, 'active.json'), 'null');
  assert.deepEqual(store.read(), {});
  assert.equal(store.resources({ version: '0.2.2', directory: '../outside' }), null);
  const previous = stage(store, previousVersion, 'engine-abc123', bundledVersion);
  assert.equal(store.confirm(previousVersion), true);
  store.activate(trialVersion, 'engine-abc124', previousVersion);
  assert.deepEqual(store.select(bundledVersion), { resources: previous, version: previousVersion, trial: false }, 'partial trial files fall back before spawning');
  const replacement = '0.2.2-rc.4';
  stage(store, replacement, 'engine-abc125', previousVersion);
  assert.equal(store.read().previous.version, previousVersion, 'a later update keeps the available verified fallback');
  assert.equal(store.rollback(replacement), true);
  assert.deepEqual(store.read(), { version: previousVersion, directory: 'engine-abc123', verified: true });
  assert.equal(store.rollback(previousVersion), false);
});

function startFixture(t, { withPrevious = true, page, status = 200 } = {}) {
  const store = updateStore(t);
  if (withPrevious) {
    stage(store, previousVersion, 'engine-abc123', bundledVersion);
    store.confirm(previousVersion);
  }
  stage(store, trialVersion, 'engine-abc124', withPrevious ? previousVersion : bundledVersion);
  const trace = [];
  const deadlines = new Map();
  const contents = new EventEmitter();
  let location = '';
  contents.session = {};
  contents.getURL = () => location;
  const window = {
    webContents: contents,
    isDestroyed: () => false,
    async loadURL(url) {
      trace.push('load');
      await page;
      location = url;
      contents.emit('did-navigate', {}, location, status);
    },
  };
  const state = { actors: [], dshRoot: {}, rootId: 'previous-root', connection: 'starting' };
  const main = fs.readFileSync(path.resolve(__dirname, '../../apps/neko-workbench/main.cjs'), 'utf8');
  const context = vm.createContext({
    URL, Error, state, dshUpdater, dshUpdateStore: store, dshUpdateTrial: true, dshUpdateTrialFailed: false,
    dshUpdateVersion: trialVersion, quitting: false, child: null, connectingChild: null, startPromise: null,
    dshWindow: window, dshSkin: '', dshLaunchUrl: null, dshUpdateTrialTimer: null, childLifecycle: null,
    dshCookieFilter: { setUrl() {} }, mainChatRuntime: null, earlyFrames: new Map(), channelRevisions: {},
    fishQqCoordinator: { snapshot: () => ({ selection: {} }), async pause() {} },
    async channelAction() { return {}; }, acceptChannelState() {}, broadcast() {}, update() {},
    async openDsh() { trace.push('splash'); }, async applySkinCookie() {}, checkDshUpdateInBackground() {},
    app: { relaunch: () => trace.push('relaunch'), quit: () => trace.push('quit') },
    setTimeout(callback, delay) { const id = Symbol(); deadlines.set(id, { callback, delay }); return id; },
    clearTimeout(id) { deadlines.delete(id); },
    async rpc(method) {
      assert.equal(method, 'init');
      trace.push('init');
      return { sessionId: 'new-root', uiUrl: 'http://127.0.0.1:12345/' };
    },
    runtimePaths: {}, fs: { writeFileSync() {} }, path, base: '.', data: '.',
    assertDshRuntime() {}, prepareFishCare() {}, skinPatch: () => ({ skin: '' }), buildDshPatch: () => ({}),
    buildDshLaunch: () => ({ command: 'fixture', args: [], options: {} }),
    spawn() { trace.push('spawn'); return { stderr: new EventEmitter(), stdout: {} }; },
    createDshLifecycle: () => ({}), readline: { createInterface: () => new EventEmitter() },
  });
  vm.runInContext(main.slice(main.indexOf('function receive('), main.indexOf('function restart()')), context);
  return {
    state, trace, store, contents,
    start: () => context.startEngine(),
    ready: () => context.receive({ method: 'ready' }),
    error: () => context.engineError(new Error('child failed')),
    expire() {
      const [deadline] = deadlines.values();
      assert.equal(deadline?.delay, 120_000);
      deadline.callback();
      assert.equal(deadlines.size, 0);
    },
    deadlines,
  };
}

test('first workbench navigation confirms the update only after a successful page load', async t => {
  const page = Promise.withResolvers();
  const fixture = startFixture(t, { page: page.promise });
  await fixture.start();
  fixture.ready();
  fixture.ready();
  await tick();
  assert.deepEqual(fixture.trace, ['splash', 'spawn', 'init', 'load']);
  assert.equal(fixture.store.select(bundledVersion).trial, true);
  assert.equal(fixture.state.rootId, 'previous-root');
  page.resolve();
  await tick();
  assert.equal(fixture.store.select(bundledVersion).trial, false);
  assert.equal(fixture.state.connection, 'ready');
  assert.equal(fixture.state.rootId, 'new-root');
  assert.equal(fixture.deadlines.size, 0);
  assert.equal(fixture.contents.listenerCount('did-navigate'), 0);
  fixture.error();
  assert.equal(fixture.state.connection, 'error');
  assert.equal(fixture.store.select(bundledVersion).version, trialVersion);
  assert(!fixture.trace.includes('relaunch'));
});

test('renderer load rejection rolls back before relaunching and preserves the previous session', async t => {
  const page = Promise.withResolvers();
  const fixture = startFixture(t, { page: page.promise });
  await fixture.start();
  fixture.ready();
  await tick();
  page.reject(new Error('ERR_CONNECTION_REFUSED'));
  await tick();
  assert.deepEqual(fixture.trace, ['splash', 'spawn', 'init', 'load', 'relaunch', 'quit']);
  assert.equal(fixture.store.select(bundledVersion).version, previousVersion);
  assert.equal(fixture.state.rootId, 'previous-root');
  assert.equal(fixture.deadlines.size, 0);
  assert.equal(fixture.contents.listenerCount('did-navigate'), 0);
});

test('an HTTP error page falls back to the bundled engine when no update is verified', async t => {
  const fixture = startFixture(t, { withPrevious: false, status: 503 });
  await fixture.start();
  fixture.ready();
  await tick();
  assert.deepEqual(fixture.trace, ['splash', 'spawn', 'init', 'load', 'relaunch', 'quit']);
  assert.equal(fixture.store.select(bundledVersion), null);
  assert.deepEqual(fixture.store.read(), {});
});

test('an engine that never sends ready rolls back once and late ready is ignored', async t => {
  const fixture = startFixture(t);
  await fixture.start();
  fixture.expire();
  fixture.ready();
  fixture.error();
  await tick();
  assert.deepEqual(fixture.trace, ['splash', 'spawn', 'relaunch', 'quit']);
  assert.equal(fixture.store.select(bundledVersion).version, previousVersion);
});

test('navigation that completes after the trial deadline cannot confirm a failed update', async t => {
  const page = Promise.withResolvers();
  const fixture = startFixture(t, { page: page.promise });
  await fixture.start();
  fixture.ready();
  await tick();
  fixture.expire();
  page.resolve();
  await tick();
  assert.deepEqual(fixture.trace, ['splash', 'spawn', 'init', 'load', 'relaunch', 'quit']);
  assert.equal(fixture.store.select(bundledVersion).version, previousVersion);
  assert.equal(fixture.state.rootId, 'previous-root');
});
