const { app, BrowserWindow, ipcMain, screen } = require('electron');
const { spawn, execFile } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { BridgeClient, SerialSession } = require('./bridge-client.cjs');
const { promisify } = require('node:util');
const assert = require('node:assert/strict');
const run = promisify(execFile);
const root = path.resolve(__dirname, '../..');
const data = path.join(root, '_sandbox/bilibili-native-spike');
const smoke = process.argv.includes('--smoke');
const startupClose = smoke && process.argv.includes('--close-during-startup');
const helperExe = path.join(data, 'WindowBridge.exe');
const clientExe = path.join(data, 'client/哔哩哔哩.exe');
const logPath = path.join(data, smoke ? 'smoke.jsonl' : 'interactive.jsonl');
app.setPath('userData', path.join(data, 'host-profile'));
fs.mkdirSync(data, { recursive: true });
// Also protect direct Electron invocations; don't truncate a live session's evidence.
const ownsInstance = app.requestSingleInstanceLock();
if (!ownsInstance) { app.exit(0); }
else { fs.writeFileSync(logPath, ''); }
let win, helper, bridge, client, selected, original, attached = false, needsRestore = false, closing = false, lastBounds;
const session = new SerialSession();
let guardTimer, guardBusy = false;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function record(event) {
  fs.appendFileSync(logPath, JSON.stringify({ at: new Date().toISOString(), ...event }) + '\n');
  if (win && !win.isDestroyed()) win.webContents.send('native-status', event);
}
function command(payload) { return bridge.command(payload); }
function handle() { return win.getNativeWindowHandle().readBigUInt64LE().toString(16); }
function bounds() {
  // This standalone harness has zoom=1 and a fixed reserved region in CSS DIP.
  const [width, height] = win.getContentSize();
  const factor = screen.getDisplayMatching(win.getBounds()).scaleFactor;
  return { op: 'resize', x: Math.round(240 * factor), y: Math.round(64 * factor),
    w: Math.round((width - 252) * factor), h: Math.round((height - 76) * factor) };
}
async function resize() {
  if (!attached || closing || win.isMinimized()) return;
  const next = bounds();
  if (next.w < 1 || next.h < 1 || JSON.stringify(next) === lastBounds) return;
  lastBounds = JSON.stringify(next);
  try { await command(next); } catch (error) { lastBounds = null; throw error; }
}
async function attach() {
  if (!selected || attached || closing) return;
  // A timed-out attach can still mutate the target. Require restoration even without its reply.
  needsRestore = true;
  const event = await command({ op: 'attach', host: handle(), target: selected.hwnd, pid: selected.pid });
  original = event.before;
  attached = true; needsRestore = true;
  lastBounds = null;
  try { await resize(); } catch (error) { await detach(); throw error; }
}
async function detach() {
  if (!needsRestore) return;
  attached = false;
  if (bridge.failure) {
    await bridge.waitForRestore();
    needsRestore = false;
    return;
  }
  const event = await command({ op: 'detach' });
  if (smoke && event.targetAlive) {
    assert.equal(event.regionRestored, true, 'original native window region restored');
    for (const key of ['parent', 'owner', 'style', 'exStyle', 'visible', 'rect']) assert.deepEqual(event.after[key], original[key], `restore ${key}`);
  }
  needsRestore = false;
}
async function assertEmbedded() {
  const state = await command({ op: 'inspect' });
  assert.equal(state.target.parent, handle(), 'target still belongs to host after settling');
  assert.ok((state.target.style & 0x40000000) !== 0, 'WS_CHILD remains set');
  assert.equal(state.target.minimized, false);
  assert.equal(state.target.maximized, false);
  const expected = bounds();
  assert.equal(state.target.rect.Right - state.target.rect.Left, expected.w, 'native child width follows host');
  assert.equal(state.target.rect.Bottom - state.target.rect.Top, expected.h, 'native child height follows host');
}
async function capture(name, hwnd = handle()) {
  await command({ op: 'capture', hwnd, path: path.join(data, name) });
}
async function stopHost() {
  closing = true;
  clearInterval(guardTimer);
  try {
    await session.close(async () => {
    await detach();
    if (smoke && client) {
      if (selected && !bridge.failure) await command({ op: 'close-target' });
      await sleep(2500);
      // Only the fresh test process spawned below; never attach to an existing client.
      if (client && client.exitCode === null) { client.kill(); record({ type: 'test-client-stopped', pid: client.pid }); }
    }
    if (helper && !helper.stdin.writableEnded) helper.stdin.end();
    if (bridge) await bridge.waitForRestore();
    if (startupClose) record({ type: 'smoke-complete', scope: 'close during client discovery: no late attach; native EOF restoration acknowledged' });
    win.destroy(); app.quit();
    });
  } catch (error) {
    closing = false;
    record({ type: 'error', message: `Close cancelled; restore must succeed first: ${error.message}` });
  }
}
async function initializeClient() {
  if (closing) return;
  for (const dir of ['appdata', 'localappdata', 'temp', 'client-profile']) fs.mkdirSync(path.join(data, dir), { recursive: true });
  const startedAt = new Date().toISOString();
  client = spawn(clientExe, [`--user-data-dir=${path.join(data, 'client-profile')}`], {
    cwd: path.dirname(clientExe), stdio: 'ignore', env: { ...process.env,
      APPDATA: path.join(data, 'appdata'), LOCALAPPDATA: path.join(data, 'localappdata'),
      TEMP: path.join(data, 'temp'), TMP: path.join(data, 'temp') }
  });
  client.on('error', error => record({ type: 'error', message: error.message }));
  fs.writeFileSync(path.join(data, 'pids.json'), JSON.stringify({ host: process.pid, helper: helper.pid, client: client.pid }));
  record({ type: 'client-started', pid: client.pid });
  for (let attempt = 0; attempt < 40 && !closing; attempt++) {
    const { stdout } = await run(helperExe, ['discover', clientExe, startedAt], { windowsHide: true, timeout: 8000 });
    const windows = JSON.parse(stdout.replace(/^\uFEFF/, ''));
    selected = windows.filter(w => w.className === 'Chrome_WidgetWin_1' && w.rect.Right - w.rect.Left >= 600)
      .sort((a, b) => (b.rect.Right-b.rect.Left)*(b.rect.Bottom-b.rect.Top)-(a.rect.Right-a.rect.Left)*(a.rect.Bottom-a.rect.Top))[0];
    if (selected) break;
    await sleep(750);
  }
  if (closing) return;
  if (!selected) throw new Error('No matching official client window appeared within 30 seconds');
  record({ type: 'client-selected', pid: selected.pid, launcherPid: client.pid });
  await sleep(1500);
  if (!closing) await attach();
}
async function main() {
  await app.whenReady();
  helper = spawn(helperExe, [], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  bridge = new BridgeClient(helper, { onEvent: event => {
    if (event.type !== 'guarded' || event.recovered) record(event);
  } });
  helper.on('error', error => record({ type: 'error', message: error.message }));
  helper.on('exit', code => {
    record({ type: 'helper-exit', code });
  });
  win = new BrowserWindow({ width: 1380, height: 900, minWidth: 1100, minHeight: 760,
    title: 'N.E.K.O. · 官方客户端窗口试验', backgroundColor: '#172033',
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), sandbox: true,
      contextIsolation: true, nodeIntegration: false, zoomFactor: 1 } });
  win.setMenu(null);
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', event => event.preventDefault());
  win.on('close', event => { event.preventDefault(); void stopHost(); });
  let resizeTimer;
  win.on('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (!closing) void session.run(resize).catch(error => record({ type: 'error', message: error.message }));
    }, 80);
  });
  // Real child windows move with their parent; a move listener can cause a feedback loop.
  ipcMain.handle('native-action', async (event, action) => {
    if (event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame) throw new Error('Untrusted sender');
    return session.run(async () => {
      if (action === 'attach') await attach();
      else if (action === 'detach') await detach();
      else if (action === 'capture') await capture('interactive.png');
      else throw new Error('Unknown action');
    });
  });
  await win.loadFile(path.join(__dirname, 'index.html'));
  if (closing) return;
  record({ type: 'host', pid: process.pid, electron: process.versions.electron, gpu: app.getGPUFeatureStatus(), smoke });
  const initializing = session.run(initializeClient);
  if (startupClose) setImmediate(() => win.close());
  await initializing;
  if (closing) return;
  win.show(); win.focus();
  if (!smoke) guardTimer = setInterval(async () => {
    if (!attached || closing || guardBusy) return;
    guardBusy = true;
    try { await session.run(() => command({ op: 'guard' })); }
    catch (error) { clearInterval(guardTimer); record({ type: 'error', message: error.message }); }
    finally { guardBusy = false; }
  }, 250);
  if (smoke) {
    await sleep(4000); await assertEmbedded(); await capture('attached.png');
    const controls = await command({ op: 'probe-controls' });
    assert.ok(controls.hits.every(hit => !hit.targetReceivesInput), 'all three control locations route away from client');
    for (const state of ['minimize', 'maximize']) {
      const changed = await command({ op: 'test-window-state', state });
      assert.equal(changed.after[state === 'minimize' ? 'minimized' : 'maximized'], true, `test must actually ${state} client`);
      await command({ op: 'guard' }); await sleep(300); await assertEmbedded();
    }
    win.setSize(1180, 800); await sleep(2000); await resize(); await assertEmbedded(); await capture('resized.png');
    const resizedControls = await command({ op: 'probe-controls' });
    assert.ok(resizedControls.hits.every(hit => !hit.targetReceivesInput), 'controls remain blocked after resizing');
    await detach(); await sleep(1000); await capture('detached.png', selected.hwnd);
    const detachedMinimize = await command({ op: 'test-window-state', state: 'minimize' });
    assert.equal(detachedMinimize.after.minimized, true, 'detached client can minimize normally');
    await command({ op: 'test-window-state', state: 'restore' });
    await attach(); await sleep(1500);
    win.maximize(); await sleep(500); await resize();
    assert.equal(win.isMaximized(), true, 'maximize test host before detaching');
    await detach();
    const maximizedHost = await command({ op: 'inspect' });
    assert.equal(maximizedHost.host.maximized, true, 'detach preserves current host maximized state');
    win.unmaximize(); await sleep(500);
    await attach(); await sleep(1000); await assertEmbedded();
    const gpu = app.getGPUFeatureStatus();
    await stopHost();
    if (needsRestore) throw new Error('Close did not restore target');
    record({ type: 'smoke-complete', gpu, scope: 'native controls hit-testing at two sizes; recovery from actual minimize/maximize; detached minimize; parent/bounds and original region/styles/rectangle restoration; no playback assertion' });
  }
}
if (ownsInstance) main().catch(async error => {
  record({ type: 'error', message: error.message });
  if (smoke && win) await stopHost();
});
