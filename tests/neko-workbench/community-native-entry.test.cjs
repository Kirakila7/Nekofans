'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const base = path.resolve(__dirname, '../../apps/neko-workbench');

test('actual dedicated native community IPC authenticates the current workbench main frame', async () => {
  const source = fs.readFileSync(path.join(base, 'main.cjs'), 'utf8');
  const handlers = new Map(), calls = [];
  const contents = { mainFrame: { url: 'http://127.0.0.1:59099/coding?fixture=1' } };
  const host = { webContents: contents, isDestroyed: () => false };
  const validation = source.slice(source.indexOf('function isWorkbenchOrigin'), source.indexOf('function rolesState'));
  const route = source.slice(source.indexOf("ipcMain.handle('workbench:community'"), source.indexOf("ipcMain.handle('workbench:roles'"));
  assert(route.includes('assertWorkbenchCaller(event)'));
  vm.runInNewContext(validation + route, { URL, dshWindow: host, dshLaunchUrl: 'http://127.0.0.1:59099/?fixture=1',
    ipcMain: { handle: (name, fn) => handlers.set(name, fn) },
    communityController: { action: async (window, request) => { calls.push({ window, request }); return { ok: true }; } } });
  const handle = handlers.get('workbench:community'); assert.equal(typeof handle, 'function');
  const request = { action: 'open', bounds: { x: 280, y: 88, width: 820, height: 650 } };
  assert.equal((await handle({ sender: contents, senderFrame: contents.mainFrame }, request)).ok, true);
  assert.equal(calls[0].window, host); assert.equal(calls[0].request, request);
  for (const event of [
    { sender: { mainFrame: contents.mainFrame }, senderFrame: contents.mainFrame },
    { sender: contents, senderFrame: { url: contents.mainFrame.url } },
  ]) await assert.rejects(handle(event, request), /工作台/);
  contents.mainFrame.url = 'https://community.project-neko.cn/feed';
  await assert.rejects(handle({ sender: contents, senderFrame: contents.mainFrame }, request), /工作台/);
  contents.mainFrame.url = 'http://127.0.0.1:59098/';
  await assert.rejects(handle({ sender: contents, senderFrame: contents.mainFrame }, request), /工作台/);
  assert.equal(calls.length, 1);
  const legacy = source.slice(source.indexOf('async function workbenchAction'), source.indexOf('function workbenchOptions'));
  const legacyAction = vm.runInNewContext(`${legacy};workbenchAction`, {});
  await assert.rejects(legacyAction('open-community'), /内嵌社区/);
  assert.match(source, /communityController\.bindHost\(dshWindow\)/);
  assert.match(source, /quitting=true;communityController\.dispose\(\)/);
});

test('workbench preload exposes only the named community bridge and removable status subscription', async () => {
  const exposed = {}, invokes = [], listeners = new Map();
  const ipcRenderer = { invoke: async (...args) => { invokes.push(args); return { ok: true }; },
    on: (name, fn) => listeners.set(name, fn), removeListener: (name, fn) => { if (listeners.get(name) === fn) listeners.delete(name); } };
  vm.runInNewContext(fs.readFileSync(path.join(base, 'workbench-preload.cjs'), 'utf8'), {
    require: name => { assert.equal(name, 'electron'); return { contextBridge: { exposeInMainWorld: (name, value) => { exposed[name] = value; } }, ipcRenderer }; },
  });
  const bridge = exposed.nekoWorkbench;
  assert.equal(Object.isFrozen(bridge), true);
  const request = { action: 'open', bounds: { x: 300, y: 100, width: 700, height: 600 } };
  assert.equal((await bridge.community(request)).ok, true);
  assert.deepEqual(invokes, [['workbench:community', request]]);
  let received; const unsubscribe = bridge.subscribeCommunity(value => { received = value; });
  const status = { status: 'error', error: '社区页面未能打开，请检查网络后重试' };
  listeners.get('workbench:community-state')({}, status); assert.equal(received, status);
  unsubscribe(); assert.equal(listeners.size, 0);
  assert.equal('invoke' in bridge, false); assert.equal('openURL' in bridge, false);
});
