'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const base = path.resolve(__dirname, '../../apps/neko-workbench');
function between(source, start, end) {
  const first = source.indexOf(start), last = source.indexOf(end, first + start.length);
  assert(first >= 0 && last > first, `missing or reordered IPC boundary: ${start} → ${end}`);
  return source.slice(first, last);
}

test('actual dedicated native community IPC authenticates the current workbench main frame', async () => {
  const source = fs.readFileSync(path.join(base, 'main.cjs'), 'utf8');
  const handlers = new Map(), calls = [], dividerCalls = [];
  const contents = { mainFrame: { url: 'http://127.0.0.1:59099/coding?fixture=1' } };
  const host = { webContents: contents, isDestroyed: () => false };
  const validation = source.slice(source.indexOf('function isWorkbenchOrigin'), source.indexOf('function rolesState'));
  const route = between(source, "ipcMain.handle('workbench:community'", "ipcMain.handle('workbench:community-account'");
  assert(route.includes('assertWorkbenchCaller(event)'));
  let screenHides=0;
  vm.runInNewContext(validation + route, { URL, dshWindow: host, dshLaunchUrl: 'http://127.0.0.1:59099/?fixture=1', screenShare: { hide: () => screenHides++ },
    ipcMain: { handle: (name, fn) => handlers.set(name, fn) },
    communityController: { hasVisibleView:true, action: async (window, request) => { calls.push({ window, request }); return { ok: true }; } },
    nativeDividerController: { setEnabled:value=>dividerCalls.push(['enabled',value]), raise:value=>dividerCalls.push(['raise',value]), place:(window,request)=>{dividerCalls.push(['place',window,request]);return {ok:true};} } });
  const handle = handlers.get('workbench:community'); assert.equal(typeof handle, 'function');
  const request = { action: 'open', bounds: { x: 280, y: 88, width: 820, height: 650 } };
  assert.equal((await handle({ sender: contents, senderFrame: contents.mainFrame }, request)).ok, true);
  assert.equal(calls[0].window, host); assert.equal(calls[0].request, request);
  assert.equal(screenHides,1,'opening community pauses the competing screen panel');
  assert.deepEqual(dividerCalls.slice(0,2),[['enabled',true],['raise',true]]);
  const divider=handlers.get('workbench:divider'), geometry={action:'place',id:'chat',rect:{x:320,y:0,width:12,height:500}};
  assert.equal(divider({sender:contents,senderFrame:contents.mainFrame},geometry).ok,true);
  assert.equal(dividerCalls.at(-1)[1],host);assert.equal(dividerCalls.at(-1)[2],geometry);
  for (const event of [
    { sender: { mainFrame: contents.mainFrame }, senderFrame: contents.mainFrame },
    { sender: contents, senderFrame: { url: contents.mainFrame.url } },
  ]) { await assert.rejects(handle(event, request), /工作台/); assert.throws(()=>divider(event,geometry),/工作台/); }
  contents.mainFrame.url = 'https://community.project-neko.cn/feed';
  await assert.rejects(handle({ sender: contents, senderFrame: contents.mainFrame }, request), /工作台/);
  assert.throws(()=>divider({sender:contents,senderFrame:contents.mainFrame},geometry),/工作台/);
  contents.mainFrame.url = 'http://127.0.0.1:59098/';
  await assert.rejects(handle({ sender: contents, senderFrame: contents.mainFrame }, request), /工作台/);
  assert.equal(calls.length, 1);
  const legacy = source.slice(source.indexOf('async function workbenchAction'), source.indexOf('function workbenchOptions'));
  const legacyAction = vm.runInNewContext(`${legacy};workbenchAction`, {});
  await assert.rejects(legacyAction('open-community'), /内嵌社区/);
  assert.match(source, /communityController\.bindHost\(dshWindow\)/);
  assert.match(source, /quitting=true;nativeDividerController\.dispose\(\);communityController\.dispose\(\)/);
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
  await bridge.communityAccount('connect');
  assert.deepEqual(invokes.at(-1), ['workbench:community-account', 'connect']);
  let account; const unsubscribeAccount = bridge.subscribeCommunityAccount(value => { account = value; });
  const accountState = { status: 'checking', message: '正在检查桌面社区连接…' };
  listeners.get('workbench:community-account-state')({}, accountState); assert.equal(account, accountState);
  unsubscribeAccount(); assert.equal(listeners.size, 0);
  assert.throws(() => bridge.subscribeCommunityAccount(null), /callback must be a function/);
  assert.equal('invoke' in bridge, false); assert.equal('openURL' in bridge, false);
});

test('desktop identity IPC rejects remote and subframe callers and requires an open community', async () => {
  const source = fs.readFileSync(path.join(base, 'main.cjs'), 'utf8'), handlers = new Map(), calls = [];
  const contents = { mainFrame: { url: 'http://127.0.0.1:59099/' } };
  const host = { webContents: contents, isDestroyed: () => false }, controller = { isOpen: true };
  const validation = source.slice(source.indexOf('function isWorkbenchOrigin'), source.indexOf('function rolesState'));
  const route = between(source, "ipcMain.handle('workbench:community-account'", "ipcMain.handle('workbench:roles'");
  vm.runInNewContext(validation + route, { URL, dshWindow: host, dshLaunchUrl: contents.mainFrame.url,
    ipcMain: { handle: (name, fn) => handlers.set(name, fn) }, communityController: controller,
    communityAccount: { action: async action => { calls.push(action); return { status: 'available' }; } } });
  const handle = handlers.get('workbench:community-account'), event = { sender: contents, senderFrame: contents.mainFrame };
  assert.equal((await handle(event, 'connect')).status, 'available');
  for (const invalid of [{ sender: {}, senderFrame: contents.mainFrame }, { sender: contents, senderFrame: { url: contents.mainFrame.url } }]) await assert.rejects(handle(invalid, 'connect'), /工作台/);
  contents.mainFrame.url = 'https://community.project-neko.cn/feed';
  await assert.rejects(handle(event, 'connect'), /工作台/);
  contents.mainFrame.url = 'http://127.0.0.1:59098/';
  await assert.rejects(handle(event, 'connect'), /工作台/);
  await assert.rejects(handle(event, 'cancel'), /工作台/);
  contents.mainFrame.url = 'http://127.0.0.1:59099/'; controller.isOpen = false;
  await assert.rejects(handle(event, 'connect'), /先打开社区/);
  await handle(event, 'cancel'); assert.deepEqual(calls, ['connect', 'cancel']);
  host.isDestroyed = () => true;
  await assert.rejects(handle(event, 'cancel'), /工作台/);
  assert.deepEqual(calls, ['connect', 'cancel'], 'rejected callers never reach the identity controller');
});
