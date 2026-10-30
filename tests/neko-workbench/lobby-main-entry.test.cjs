'use strict';
// Main-entry: lobby controller + ipcMain.handle, assertWorkbenchCaller, before-quit disposal.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.resolve(__dirname, '../../apps/neko-workbench/main.cjs'), 'utf8');
const preload = fs.readFileSync(path.resolve(__dirname, '../../apps/neko-workbench/workbench-preload.cjs'), 'utf8');

test('workbench:lobby IPC delegates to lobbyController.request and calls assertWorkbenchCaller', async () => {
  const handlers = new Map(), controllerCalls = [];
  const host = { webContents: { mainFrame: { url: 'http://127.0.0.1:59099/coding' }, getURL: () => 'http://127.0.0.1:59099/coding' }, isDestroyed: () => false };
  const caller = { sender: host.webContents, senderFrame: host.webContents.mainFrame };
  const validation = source.slice(source.indexOf('function isWorkbenchOrigin'), source.indexOf('function rolesState'));
  const routes = source.slice(source.indexOf("ipcMain.handle('workbench:lobby'"), source.indexOf("ipcMain.handle('workbench:community'"));
  const injected = `
    ${validation}
    const lobbyController = { request: async r => { controllerCalls.push(r); return { ok: true, state: {} }; } };
    const screenShare = { hide: () => {} };
    const communityController = { action: async () => ({}) };
    ${routes}
  `;
  vm.runInNewContext(injected, { URL, dshWindow: host, dshLaunchUrl: 'http://127.0.0.1:59099/', ipcMain: { handle: (name, fn) => handlers.set(name, fn) },
    controllerCalls });

  const result = await handlers.get('workbench:lobby')(caller, { action: 'state' });
  assert.equal(result.ok, true);
  assert.deepEqual(controllerCalls, [{ action: 'state' }]);

  await assert.rejects(handlers.get('workbench:lobby')({ ...caller, senderFrame: { url: 'https://example.com/' } }, { action: 'state' }), /工作台/);
  assert.deepEqual(controllerCalls, [{ action: 'state' }], 'the hostile frame was rejected');

  controllerCalls.length = 0;
  const openReq = { action: 'open' };
  const openResult = await handlers.get('workbench:lobby')(caller, openReq);
  assert.equal(openResult.ok, true);
  assert.deepEqual(controllerCalls, [openReq], 'open was delegated to the controller');
});

test('preload exposes lobby/subscribeLobby', () => {
  const calls = [];
  const listeners = new Map();
  const bridges = new Map();
  const ipcRenderer = {
    invoke: (name, request) => { calls.push({ name, request }); return Promise.resolve({ ok: true }); },
    on: (event, fn) => { if (!listeners.has(event)) listeners.set(event, new Set()); listeners.get(event).add(fn); },
    removeListener: (event, fn) => { listeners.get(event)?.delete(fn); },
  };
  vm.runInNewContext(preload, { require: name => {
    assert.equal(name, 'electron');
    return { ipcRenderer, contextBridge: { exposeInMainWorld: (key, api) => bridges.set(key, api) } };
  } });
  const ctx = { nekoWorkbench: bridges.get('nekoWorkbench') };

  assert.equal(typeof ctx.nekoWorkbench.lobby, 'function');
  assert.equal(typeof ctx.nekoWorkbench.subscribeLobby, 'function');

  void ctx.nekoWorkbench.lobby({ action: 'state' });
  assert.deepEqual(calls.at(-1), { name: 'workbench:lobby', request: { action: 'state' } });

  const states = [];
  const stop = ctx.nekoWorkbench.subscribeLobby(state => { states.push(state); });
  assert(listeners.has('workbench:lobby-state'));
  const emit = state => { for (const fn of listeners.get('workbench:lobby-state') || []) fn(null, state); };
  emit({ connection: 'online' });
  assert.deepEqual(states, [{ connection: 'online' }]);
  stop();
  emit({ connection: 'offline' });
  assert.equal(states.length, 1, 'unsubscribe removes the listener');
  assert.throws(() => ctx.nekoWorkbench.subscribeLobby('not a function'), /callback must be a function/);
  assert.throws(() => ctx.nekoWorkbench.subscribeLobby(null), /callback must be a function/);
});

test('before-quit disposes the lobby controller', () => {
  const calls = [];
  const quitHandlers = new Map();
  const lines = source.split('\n');
  const quitStart = lines.findIndex(line => line.startsWith("app.on('before-quit',event=>{"));
  const quitEnd = lines.findIndex((line, i) => i > quitStart && line.startsWith('});'));
  const quit = lines.slice(quitStart, quitEnd + 1).join('\n');
  const ctx = {
    app: { on: (name, fn) => quitHandlers.set(name, fn), quit: () => calls.push('app.quit') },
    shutdownComplete: false, shutdownStarted: false, quitting: false,
    lobbyController: { dispose: () => calls.push('lobby.dispose') },
    nativeDividerController: { dispose: () => calls.push('divider.dispose') },
    communityController: { dispose: () => calls.push('community.dispose') },
    communityAccount: { cancel: () => calls.push('community.cancel') },
    screenShare: { dispose: () => calls.push('screen.dispose') },
    catMotion: { dispose: () => calls.push('motion.dispose') },
    clearTimeout: () => {}, nekoRetry: null, rosterTimer: null, terminalTimers: new Map(), nekoChat: { close: () => calls.push('neko.close') },
    save: () => calls.push('save'), childLifecycle: null, mainChatRuntime: null, visitsController: null, codexAccount: { dispose: async () => {} },
    codexWorkspace: { dispose: async () => {} }, Promise: globalThis.Promise,
  };
  vm.runInNewContext(quit, ctx);
  assert(quitHandlers.has('before-quit'));
  const event = { preventDefault: () => calls.push('prevent') };
  quitHandlers.get('before-quit')(event);
  assert.deepEqual(calls.slice(0, 6), ['prevent', 'divider.dispose', 'community.dispose', 'community.cancel', 'lobby.dispose', 'screen.dispose'],
    'lobby.dispose (which persists the open experience segment) runs before quit completes');
  quitHandlers.get('before-quit')(event);
  assert.equal(calls.filter(call => call === 'lobby.dispose').length, 1, 'a second before-quit does not dispose twice');
});
