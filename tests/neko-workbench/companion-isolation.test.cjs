'use strict';
// W0: lock "和她私聊随时可用". The private companion chat (workbench:companion) must keep working with
// no lobby module and no NEKO_WORKBENCH_CHAT_URL, and the workspace shell must never remove, hide,
// inert or rebuild the companion dock when the user switches views. Synthetic data and local fixtures only.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { EventEmitter } = require('node:events');

const appDir = path.resolve(__dirname, '../../apps/neko-workbench');
const WORKBENCH_TITLE = 'Nekofans';

const SCENARIOS = Object.freeze({
  missing: 'actual main sends private companion chat with no lobby module and no NEKO_WORKBENCH_CHAT_URL',
  unconfigured: 'workbench:companion send works while the lobby controller is not configured',
  disconnected: 'workbench:companion send works while the lobby is disconnected',
  throws: 'workbench:companion send works when lobby controller initialisation throws',
  muted: 'workbench:companion send works while the user is muted in the lobby',
  suggesting: 'workbench:companion send does not return busy while a lobby suggestion is generating',
  independent: 'workbench:companion send works while the cat is speaking independently in the lobby',
});
// Scenarios that need a reachable lobby use a fake lobby-auth/lobby-client in the child; the real
// controller, lobby-cat and chat-api provider still run against the local fixture model server.
const FAKE_LOBBY = new Set(['disconnected', 'muted', 'suggesting', 'independent']);
const harnessIndex = process.argv.indexOf('--isolation-harness');

if (harnessIndex < 0) {
  for (const [scenario, title] of Object.entries(SCENARIOS)) test(title, async () => {
    const env = { ...process.env };
    for (const name of Object.keys(env)) if (name.startsWith('NEKO_WORKBENCH_CHAT_')) delete env[name];
    // An absent URL now selects the official channel default. An explicit
    // empty override is the supported way to exercise the unconfigured case.
    if (scenario === 'unconfigured') env.NEKO_WORKBENCH_CHAT_URL = '';
    if (FAKE_LOBBY.has(scenario)) env.NEKO_WORKBENCH_CHAT_URL = 'https://chat.fixture.test/';
    await new Promise((resolve, reject) => execFile(process.execPath, [__filename, '--isolation-harness', scenario],
      { env, timeout: 20000, maxBuffer: 2e6, windowsHide: true }, (error, stdout, stderr) => {
        if (error) return reject(new Error(stdout + '\n' + stderr));
        try { assert.match(stdout, new RegExp('companion isolation ' + scenario + ' passed')); resolve(); } catch (failure) { reject(failure); }
      }));
  });


  test('workspace shell preserves the companion dock and only hides it during social views', () => {
    const source = fs.readFileSync(path.join(appDir, 'embedded-dsh/workspace-shell-source.js'), 'utf8');
    assert.equal(source.split("el('section', 'neko-companion-dock')").length - 1, 1, 'the dock is created exactly once per install');
    const forbidden = [
      /\bdock\s*\.\s*(?:hidden|inert|remove|replaceWith|replaceChildren|innerHTML|outerHTML|textContent|style)\b/,
      /\bdock\s*\.\s*(?:setAttribute|toggleAttribute)\(\s*['"](?:hidden|inert|aria-hidden)['"]/,
      /\bdock\s*\.\s*parentNode\s*\.\s*removeChild\b/,
      /\.removeChild\(\s*dock\s*\)/,
    ];
    // Social/video takes the left pane, so the preserved dock is hidden while
    // the same character offers a desktop-pet chat fallback. No other dock
    // hiding, inerting, removal, replacement or direct style writes are allowed.
    const socialGuard = 'if (dock.hidden !== sideSocial) dock.hidden = sideSocial;';
    assert.equal(source.split(socialGuard).length - 1, 1, 'only the social-view conditional controls dock visibility');
    const remainingSource = source.replace(socialGuard, '');
    for (const pattern of forbidden) assert.doesNotMatch(remainingSource, pattern);
    const css = fs.readFileSync(path.join(appDir, 'embedded-dsh/workspace-shell-source.css'), 'utf8');
    for (const rule of css.split('}')) {
      const [selectors, body = ''] = rule.split('{');
      const targetsDock = selectors.split(',').some(selector => /\.neko-companion-dock(?:\[[^\]]*\]|:[\w-]+)*\s*$/.test(selector.trim()));
      if (targetsDock && selectors.trim() !== '.neko-companion-dock[hidden]') assert.doesNotMatch(body, /display\s*:\s*none|visibility\s*:\s*hidden/, 'only the explicit hidden state hides the dock: ' + selectors.trim());
    }
    const bundle = fs.readFileSync(path.join(appDir, 'embedded-dsh/b0-skin/packages/dsh-client-ui-white-label/lib/client.js'), 'utf8');
    assert(bundle.includes(source), 'the shipped UI bundle carries this exact shell source');
  });

  test('desktop companion chat action opens the existing pet input', async () => {
    const vm = require('node:vm');
    const source = fs.readFileSync(path.join(appDir, 'main.cjs'), 'utf8');
    const start = source.indexOf('async function workbenchAction'), end = source.indexOf('function workbenchOptions', start);
    assert(start >= 0 && end > start);
    let opened = 0;
    const action = vm.runInNewContext(source.slice(start, end) + ';workbenchAction', { showInput: () => opened++ });
    const result = await action('open-companion-chat');
    assert.equal(opened, 1); assert.equal(result.ok, true);
  });

  let JSDOM;
  try { ({ JSDOM } = require(path.join(process.env.NEKO_DOM_DEPS || '/private/tmp/neko-sidebar-dom-20261026', 'node_modules/jsdom'))); } catch {}
  test('workspace shell keeps one live companion dock, its draft and its history across workspace, Codex, community and settings views',
    { skip: JSDOM ? false : 'set NEKO_DOM_DEPS to a directory with jsdom installed' }, async t => shellViewsCase(t, JSDOM));
  test('workspace shell keeps the same companion dock while opening and leaving the lobby view',
    { skip: JSDOM ? false : 'set NEKO_DOM_DEPS to a directory with jsdom installed' }, async t => shellViewsCase(t, JSDOM, { lobby: true }));
} else {
  runIsolationHarness(process.argv[harnessIndex + 1] || 'missing').catch(error => { console.error(error); process.exitCode = 1; });
}
async function shellViewsCase(t, JSDOM, { lobby = false } = {}) {
  const dom = new JSDOM('<body><aside data-neko-side-rail><div class="neko-side-rail__theme"></div></aside><div data-slot="sidebar"><button data-neko-new-session="plus">+</button><div data-neko-seat-mount></div><div data-slot="sidebar.workspaces">native sessions</div><div data-slot="settings.launcher"></div></div><main><textarea>native draft</textarea></main></body>', { runScripts: 'outside-only' });
  t.after(() => dom.window.close());
  const { window: w } = dom, doc = w.document;
  doc.querySelector('[data-slot="sidebar"]').getBoundingClientRect = () => ({ right: 300 });
  const tick = () => new Promise(resolve => setTimeout(resolve, 15));
  let layout = { seats: [{ id: 'seat-1', name: 'DSH', provider: 'dsh', avatarId: 'bigfish', projectRoot: '' }], activeSeatId: null,
    officeMode: 'dsh', companionCollapsed: false, companionHistoryOpen: true };
  const state = { workspaceRoot: '/fixture', workspaceRevision: 0,
    companion: { name: '主agent', ready: true, working: false, messages: [{ id: 'm1', role: 'assistant', text: '合成历史' }] } };
  const sent = [];
  let subscriber, community, communityOpens = 0;
  const bridge = {
    getState: async () => state, action: async () => ({ ok: true }),
    subscribe: fn => { subscriber = fn; return () => {}; },
    subscribeCommunity: fn => { community = fn; return () => {}; },
    companion: async request => { sent.push(structuredClone(request)); return {}; },
    workspace: async request => {
      if (request.action === 'state') return structuredClone(layout);
      if (request.action === 'update') { layout = { ...layout, ...request.patch }; return structuredClone(layout); }
      if (request.action === 'codex-state') return { status: 'idle', items: [], approvals: [] };
      if (request.action === 'catalog') return { sessions: [], projects: [], providers: { dsh: 'ready', codex: 'ready' } };
      return structuredClone(layout);
    },
  };
  const lobbyCalls = [];
  if (lobby) {
    const lobbyState = { connection: 'offline', auth: { status: 'signed-in', message: '', error: '', signingIn: false },
      participation: { mode: 'assist', available: false, reason: '大厅未连接' }, me: null, channel: null, messages: [], members: [], outbox: [], hasMore: false, error: '' };
    bridge.lobby = async request => { lobbyCalls.push(request.action); return { ok: true, state: lobbyState }; };
    bridge.subscribeLobby = () => () => {};
  }
  w.eval(fs.readFileSync(path.join(appDir, 'embedded-dsh/workspace-shell-source.js'), 'utf8') + '\nwindow.install=installWorkspaceShell');
  const cleanup = w.install({ window: w, document: doc, bridge, avatar: () => '', settingsActions: [['task-notes', '任务备注']],
    openCommunity: () => { communityOpens++; community({ status: 'ready' }); }, hideSocial: () => community?.({ status: 'hidden' }),
    cssText: fs.readFileSync(path.join(appDir, 'embedded-dsh/workspace-shell-source.css'), 'utf8') });
  t.after(() => cleanup());
  await tick();

  const dock = doc.querySelector('.neko-companion-dock');
  assert(dock, 'the dock is installed');
  const parts = ['.neko-companion-character', '.neko-companion-form', '.neko-companion-form textarea', '.neko-companion-history']
    .map(selector => [selector, dock.querySelector(selector)]);
  const input = dock.querySelector('.neko-companion-form textarea');
  input.value = '未发送的私聊草稿';
  const expectIntact = label => {
    const docks = doc.querySelectorAll('.neko-companion-dock');
    assert.equal(docks.length, 1, label + ': exactly one dock');
    assert.equal(docks[0], dock, label + ': the same dock node, not a rebuilt one');
    assert(dock.isConnected, label + ': still in the document');
    assert.equal(dock.closest('[hidden],[inert],[aria-hidden="true"]'), null, label + ': neither the dock nor an ancestor is hidden or inert');
    for (const [selector, node] of parts) assert.equal(dock.querySelector(selector), node, label + ': same ' + selector);
    assert.equal(input.value, '未发送的私聊草稿', label + ': the unsent draft stays');
    assert.equal(input.disabled, false, label + ': the input stays usable');
    assert.match(dock.querySelector('.neko-companion-history').textContent, /合成历史/, label + ': chat history stays');
  };
  expectIntact('initial workspace view');
  if (lobby) {
    const lobbyButton = doc.querySelector('.neko-lobby-switch');
    assert(lobbyButton, 'fixture has the lobby rail button');
    lobbyButton.click(); await tick();
    assert(!doc.querySelector('.neko-lobby-panel').hidden, 'fixture reached the lobby view');
    assert(lobbyCalls.includes('open'));
    expectIntact('lobby view');
    lobbyButton.click(); await tick();
    assert(doc.querySelector('.neko-lobby-panel').hidden); assert.equal(lobbyCalls.at(-1), 'close');
    expectIntact('back from the lobby');
    lobbyButton.click(); await tick();
    doc.querySelector('.neko-community').click(); await tick();
    assert(doc.querySelector('.neko-lobby-panel').hidden, 'community replaces the lobby');
    expectIntact('lobby to community');
    community({ status: 'hidden' }); await tick();
    communityOpens = 0;
  }

  layout = { ...layout, officeMode: 'codex' }; subscriber({ ...state, workspaceRevision: 1 }); await tick();
  assert.equal(doc.querySelector('.neko-office-panel'),null,'the retired engine view is not mounted');
  assert(!doc.querySelector('main').hasAttribute('inert'),'DSH remains available under a legacy saved engine selection');
  assert.equal(layout.officeMode,'codex','the shell does not overwrite saved engine data');
  expectIntact('legacy saved engine projected into the DSH workspace');

  doc.querySelector('.neko-community').click(); await tick();
  assert.equal(communityOpens, 1, 'fixture reached the community view');
  expectIntact('community view');
  community({ status: 'hidden' }); await tick();
  expectIntact('back from community');

  doc.dispatchEvent(new w.CustomEvent('neko-workbench-open-settings',{detail:{section:'general'}})); await tick();
  assert(!doc.querySelector('.neko-workspace-modal').hidden, 'fixture reached the settings view');
  expectIntact('settings view');
  doc.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await tick();
  assert(doc.querySelector('.neko-workspace-modal').hidden);

  layout = { ...layout, officeMode: 'dsh' }; subscriber({ ...state, workspaceRevision: 2 }); await tick();
  expectIntact('back to the DSH workspace view');

  subscriber({ ...state, workspaceRevision: 2, companion: { ...state.companion, working: true } }); await tick();
  expectIntact('while the companion is replying');
  subscriber({ ...state, workspaceRevision: 2 }); await tick();
  input.value = '你好';
  dock.querySelector('.neko-companion-form').requestSubmit(); await tick();
  assert.deepEqual(sent.at(-1), { action: 'send', text: '你好' }, 'after every switch the dock still sends through workbench companion');
}
// Child process: load the real main.cjs with fake Electron, a fake DSH child and a local fake chat API.
// Any require of a lobby module fails as MODULE_NOT_FOUND, so the run proves the lobby is not needed.
// A fake lobby-auth/lobby-client pair for the real controller. It never opens a socket; the scenario
// decides whether the lobby comes up online, stays reconnecting, or comes up with the user muted.
function fakeLobby(scenario) {
  const ME = 'u' + '1'.repeat(32), CAT_ID = 'cccccccc-0000-4000-8000-000000000001';
  const channel = { id: 'ch-lobby', name: '大厅', topic: '', slow_mode_seconds: 0, cats_enabled: true, cat_free_mode_allowed: false };
  const fake = { onEvent: null, onChange: null, messages: [], catFrames: [], status: 'idle', CAT_ID, ME };
  const me = { user: { user_id: ME, name: 'fixture', display_name: '合成主人', avatar: { kind: 'hue', hue: 10, text: '合' } },
    role: 'member', is_admin: false, muted_until: scenario === 'muted' ? Date.now() + 3600000 : null, banned_at: null, limits: {},
    cat: { id: CAT_ID, owner_user_id: ME, name: '大肥鱼', display_name: '合成主人的大肥鱼', avatar_key: 'default', reply_mode: 'mention',
      enabled: false, admin_disabled: false, deleted: false } };
  const changed = () => setImmediate(() => fake.onChange?.());
  fake.factories = {
    auth: () => ({ state: { status: 'signed-in', signedIn: true, message: '', error: '' }, accessExpiresAt: null,
      signIn: async () => {}, cancelSignIn() {}, signOut: async () => {}, refresh: async () => {}, getAccessToken: async () => 'fixture-access',
      invalidateAccessToken() {}, dispose() {} }),
    client: deps => {
      fake.onEvent = deps.onEvent; fake.onChange = deps.onChange;
      return { configured: true,
        snapshot: () => ({ status: fake.status, error: null, userId: ME, channel: fake.status === 'online' ? channel : null, messages: fake.messages.slice(),
          hasMore: false, nextBeforeSeq: null, members: [], online: [], lastEventSeq: 0, outbox: [], stats: {} }),
        connect() { fake.status = scenario === 'disconnected' ? 'reconnecting' : 'online'; changed(); },
        disconnect() { fake.status = 'idle'; changed(); }, reset() { fake.status = 'idle'; changed(); }, dispose() { fake.status = 'idle'; },
        send: async () => {}, sendCat: async frame => { fake.catFrames.push(frame); }, retry: async () => {}, discard() {}, loadOlder: async () => ({ added: 0, hasMore: false }),
        typing() {}, setCatStatus() {},
        rest: { configured: true, me: async () => structuredClone(me),
          putCat: async input => { me.cat = { ...me.cat, name: input.name, avatar_key: input.avatarKey, reply_mode: input.replyMode, enabled: input.enabled }; return structuredClone(me.cat); },
          abortAll() {}, dispose() {} } };
    },
  };
  fake.post = text => {
    const message = { id: 'dddddddd-0000-4000-8000-00000000000' + (fake.messages.length + 1), seq: fake.messages.length + 1, channel_id: channel.id,
      created_at: Date.now(), deleted: false, text, origin: 'human', label: '阿布', mentions: [{ kind: 'cat', id: CAT_ID }], reply_to: null, cat_depth: 0,
      author: { kind: 'human', user_id: 'u' + '2'.repeat(32), display_name: '阿布', avatar: { kind: 'hue', hue: 20, text: '阿' } } };
    fake.messages.push(message);
    fake.onEvent('message.new', { message, live: true });
    return message;
  };
  return fake;
}

async function runIsolationHarness(scenario) {
  const Module = require('node:module'), { PassThrough } = require('node:stream'), { createServer } = require('node:http');
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'neko-companion-isolation-'));
  const data = path.join(temporary, 'data'), modules = path.join(temporary, 'modules'), cli = path.join(temporary, 'dsh');
  fs.writeFileSync(cli, 'fixture');
  for (const name of ['dsh-llm', 'dsh-scope']) { fs.mkdirSync(path.join(modules, name, 'lib'), { recursive: true }); fs.writeFileSync(path.join(modules, name, 'lib/index.js'), ''); }
  Object.assign(process.env, { NEKO_WORKBENCH_DATA_DIR: data, NEKO_WORKBENCH_WORKSPACE: path.join(temporary, 'work'), NEKO_WORKBENCH_DSH_CLI: cli,
    NEKO_WORKBENCH_DSH_MODULES: modules, PET_OPEN_WORKBENCH: '1', PET_WORKBENCH_ONLY: '0' });
  if (FAKE_LOBBY.has(scenario)) process.env.NEKO_WORKBENCH_CHAT_URL = 'https://chat.fixture.test/';
  const lobby = FAKE_LOBBY.has(scenario) ? fakeLobby(scenario) : null;

  const handlers = new Map(), windows = [], chatRequires = [];
  let quit = false;
  const app = new EventEmitter();
  Object.assign(app, { setName() {}, setPath() {}, getPath: () => temporary, requestSingleInstanceLock: () => true, whenReady: () => Promise.resolve(), focus() {},
    quit() { let prevented = false; app.emit('before-quit', { preventDefault() { prevented = true; } }); if (!prevented) { quit = true; app.emit('quit'); } } });
  const child = new EventEmitter();
  Object.assign(child, { pid: 4242, killed: false, stdout: new PassThrough(), stderr: new PassThrough(), kill() { child.killed = true; child.emit('close', 0); } });
  child.stdin = new EventEmitter();
  child.stdin.write = line => {
    const request = JSON.parse(line);
    const result = request.method === 'init' ? { sessionId: 'root', uiUrl: 'http://127.0.0.1:12345/' } : { accepted: true };
    setImmediate(() => child.stdout.write(JSON.stringify({ id: request.id, result }) + '\n'));
  };
  child.stdin.end = () => child.emit('close', 0);
  class Window extends EventEmitter {
    constructor(options) {
      super(); this.options = options; this.destroyed = false; this.visible = false;
      const wc = new EventEmitter();
      Object.assign(wc, { url: '', mainFrame: { url: '' }, getURL: () => wc.url, send() {}, executeJavaScript: async () => null, isDestroyed: () => this.destroyed, isLoading: () => false,
        setWindowOpenHandler() {}, setZoomFactor: value => { wc.zoom = value; }, getZoomFactor: () => wc.zoom || 1, session: { cookies: { set: async () => {} } } });
      this.webContents = wc; windows.push(this);
    }
    isDestroyed() { return this.destroyed; } show() { this.visible = true; } showInactive() { this.visible = true; } isVisible() { return this.visible; } hide() { this.visible = false; }
    focus() {} setTitle() {} setAlwaysOnTop() {} setVisibleOnAllWorkspaces() {} getPosition() { return [0, 0]; } setPosition() {} setBounds() {}
    async loadURL(url) { this.webContents.url = url; this.webContents.mainFrame.url = url; setImmediate(() => this.webContents.emit('did-finish-load')); }
    destroy() { this.destroyed = true; this.emit('closed'); } close() { this.destroy(); }
    static fromWebContents(wc) { return windows.find(window => window.webContents === wc); }
  }
  class Tray extends EventEmitter { setTitle() {} setToolTip() {} popUpContextMenu() {} }
  const electron = { app, BrowserWindow: Window, ipcMain: { handle: (name, fn) => handlers.set(name, fn), removeHandler:name=>handlers.delete(name), on: () => {}, removeListener: () => {} },
    screen: { getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1440, height: 1000 } }) },
    shell: { openExternal: async () => {}, openPath: async () => {} }, Menu: { buildFromTemplate: template => ({ template, popup() {} }), setApplicationMenu() {} }, Tray,
    nativeImage: { createEmpty: () => ({}) }, dialog: { showErrorBox() {}, showMessageBox: async () => {}, showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
    nativeTheme: { shouldUseDarkColors: false }, WebContentsView: class WebContentsView { constructor() { this.webContents = new EventEmitter(); Object.assign(this.webContents, { setWindowOpenHandler() {}, loadURL: async () => {} }); } setBounds() {} setBackgroundColor() {} },
    safeStorage: { isEncryptionAvailable: () => true, getSelectedStorageBackend: () => 'keychain',
      encryptString: value => Buffer.from('cipher:' + Buffer.from(value).toString('base64')), decryptString: bytes => Buffer.from(bytes.toString().slice(7), 'base64').toString() } };
  const originalLoad = Module._load;
  Module._load = function (name, ...args) {
    if (name === 'electron') return electron;
    const base = path.basename(name);
    if (/(?:^|[\\/])lobby-[\w-]+(?:\.c?js)?$/.test(name)) {
      chatRequires.push(base);
      if (scenario === 'missing') throw Object.assign(new Error('Cannot find module ' + base), { code: 'MODULE_NOT_FOUND' });
      if (/(?:^|[\\/])lobby-controller(?:\.c?js)?$/.test(name)) {
        const real = originalLoad.call(this, name, ...args);
        if (scenario === 'throws') return { ...real, createLobbyController() { throw new Error('fixture lobby init failure'); } };
        if (!lobby) return real;
        return { ...real, createLobbyController: deps => { lobby.controller = real.createLobbyController({ ...deps, factories: { ...lobby.factories, ...deps.factories } }); return lobby.controller; } };
      }
      return originalLoad.call(this, name, ...args);
    }
    if (name === 'node:child_process' || name === 'child_process') return { ...originalLoad.call(this, name, ...args), spawn() { setImmediate(() => child.stdout.write(JSON.stringify({ method: 'ready', params: {} }) + '\n')); return child; } };
    return originalLoad.call(this, name, ...args);
  };
  const wait = async (predicate, label) => { for (let n = 0; n < 600; n++) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 10)); } throw Error('fixture wait timed out: ' + label); };
  const frame = window => ({ sender: window.webContents, senderFrame: window.webContents.mainFrame });
  // Local fixture model server. Lobby prompts are recognisable by their transcript header; a lobby
  // request is held open until the companion send has finished, so the two really overlap.
  const prompts = [], lobbyPrompts = [];
  let releaseLobby = null;
  const lobbyHeld = new Promise(resolve => { releaseLobby = resolve; });
  const server = createServer((req, res) => {
    let body = ''; req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      const content = JSON.parse(body).messages.at(-1).content;
      const reply = text => { res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end('data: ' + JSON.stringify({ choices: [{ delta: { content: text } }] }) + '\n\ndata: [DONE]\n\n'); };
      if (typeof content === 'string' && content.startsWith('以下是大厅最近的消息')) {
        lobbyPrompts.push(content); await lobbyHeld; return reply('合成大厅回复');
      }
      prompts.push(content); reply('合成回复');
    });
  });
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    require(path.join(appDir, 'main.cjs'));
    await wait(() => handlers.has('workbench:call') && handlers.has('pet:call') && handlers.has('workbench:lobby'), 'IPC registered');
    const pet = windows[0];
    await wait(async () => !!(await handlers.get('pet:call')(frame(pet), 'state')).mainChat?.ready, 'main chat ready');
    await wait(() => windows.some(window => window.options.title === WORKBENCH_TITLE && window.webContents.url.startsWith('http://127.0.0.1:12345')), 'workbench window');
    const workbench = windows.find(window => window.options.title === WORKBENCH_TITLE);
    const call = (method, value) => handlers.get('workbench:call')(frame(workbench), method, value);
    const lobbyCall = request => handlers.get('workbench:lobby')(frame(workbench), request);

    // Configure the private chat API through the real settings window, exactly as a user would.
    await call('action', 'chat-settings');
    const settings = windows.find(window => window.options.title === '聊天 API 设置');
    assert(settings, 'chat settings window opens from the workbench');
    await handlers.get('pet:call')(frame(settings), 'chat-settings-save', { protocol: 'openai-compatible', baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
      model: 'fixture-only', requestTimeoutMs: 5000, maxOutputTokens: 256, key: { action: 'replace', value: 'isolation-fixture-key' } });

    // Bring the lobby into the scenario's state before the companion send.
    let lobbyBusy = null;
    if (scenario === 'missing') {
      assert.deepEqual(chatRequires, ['lobby-controller.cjs'], 'main.cjs only tried the controller and fell back');
    } else if (scenario === 'unconfigured' || scenario === 'throws') {
      const state = await lobbyCall({ action: 'state' });
      assert.equal(state.ok, scenario === 'unconfigured' ? true : false, 'lobby state answers without blocking');
      if (scenario === 'unconfigured') assert.equal(state.state.connection, 'unconfigured');
      assert.equal((await lobbyCall({ action: 'open' })).ok, false, 'the lobby cannot open in this scenario');
    } else {
      const mode = scenario === 'independent' ? { action: 'mode-set', mode: 'independent', trigger: 'mention' } : { action: 'mode-set', mode: 'assist' };
      assert.equal((await lobbyCall(mode)).ok, true, 'lobby mode can be set with the chat API configured');
      const opened = await lobbyCall({ action: 'open' });
      assert.equal(opened.ok, true, 'lobby open resolves');
      if (scenario === 'disconnected') {
        await wait(async () => (await lobbyCall({ action: 'state' })).state.connection === 'connecting', 'lobby reconnecting');
        assert.equal((await lobbyCall({ action: 'send', text: '大厅消息', origin: 'human' })).ok, false, 'lobby send fails while disconnected');
      } else if (scenario === 'muted') {
        await wait(async () => (await lobbyCall({ action: 'state' })).state.participation.reason === '你正在禁言中', 'lobby muted');
      } else {
        await wait(async () => (await lobbyCall({ action: 'state' })).state.participation.available === true, 'lobby participation available');
        const target = lobby.post('<@c:' + lobby.CAT_ID + '> 大厅里的问题');
        if (scenario === 'suggesting') lobbyBusy = lobbyCall({ action: 'suggest', targetMessageId: target.id, instruction: '' });
        await wait(() => lobbyPrompts.length === 1, 'lobby model request in flight');
        const busy = (await lobbyCall({ action: 'state' })).state;
        if (scenario === 'suggesting') assert.equal(busy.suggestion?.state, 'generating', 'a lobby suggestion is generating');
        else assert.equal(busy.cat.status, 'thinking', 'the cat is speaking independently');
      }
    }

    const before = await call('companion', { action: 'read' });
    assert.equal(before.backend, 'chat-api');
    assert.equal(before.ready, true, 'the private chat is ready while the lobby is ' + scenario);
    assert.equal(before.working, false, 'lobby work never marks the private chat busy');
    const accepted = await call('companion', { action: 'send', text: '私聊测试' });
    assert.equal(accepted.backend, 'chat-api');
    await wait(async () => (await call('companion', { action: 'read' })).messages.some(message => message.role === 'assistant' && message.text === '合成回复'), 'assistant reply');
    assert.deepEqual(prompts, ['私聊测试'], 'exactly one private request reached the chat API, with the user text');
    const after = await call('companion', { action: 'read' });
    assert.equal(after.working, false);
    assert.deepEqual(after.messages.filter(message => message.role === 'user').map(message => message.text), ['私聊测试']);
    assert(!after.messages.some(message => /大厅/.test(message.text)), 'no lobby text leaks into the private history');
    assert.equal(after.error, '');
    assert.equal((await call('companion', { action: 'stop' })).ready, true, 'stop works while the lobby is ' + scenario);
    await assert.rejects(call('companion', { action: 'send', text: '' }), /1–8000/);

    if (lobby && (scenario === 'suggesting' || scenario === 'independent')) {
      assert.equal(lobbyPrompts.length, 1, 'the lobby request was still open during the private send');
      releaseLobby();
      if (scenario === 'suggesting') {
        const done = await lobbyBusy;
        assert.equal(done.ok, true, 'the overlapping suggestion still finishes');
        assert.equal(done.state.suggestion?.text, '合成大厅回复');
      } else {
        await wait(() => lobby.catFrames.length === 1, 'independent cat frame');
        assert.equal(lobby.catFrames[0].text, '合成大厅回复');
        assert.equal(lobby.catFrames[0].trigger, 'mention');
      }
      assert(!lobbyPrompts[0].includes('私聊测试'), 'private chat text never reaches the lobby prompt');
    }
    releaseLobby();

    const snapshot = await call('state');
    assert(!JSON.stringify(snapshot).includes('isolation-fixture-key'), 'the key never reaches the renderer state');
    const lobbyState = await lobbyCall({ action: 'state' });
    assert(!JSON.stringify(lobbyState).includes('isolation-fixture-key'), 'the key never reaches the lobby state');
    assert(!JSON.stringify(lobbyState).includes('私聊测试'), 'private chat text never reaches the lobby state');
    app.quit(); await wait(() => quit, 'quit');
    console.log('companion isolation ' + scenario + ' passed');
  } finally {
    releaseLobby();
    if (!quit) { app.quit(); await wait(() => quit, 'quit').catch(() => {}); }
    Module._load = originalLoad;
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}
