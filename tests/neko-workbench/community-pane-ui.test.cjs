'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function bundle() {
  let entry;
  const context = { window: { __ModuleLoader__: { load(value) { entry = value; } } }, setTimeout, clearTimeout };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../apps/neko-workbench/embedded-dsh/b0-skin/packages/dsh-client-ui-white-label/lib/client.js'), 'utf8'), context);
  return entry.factory(name => name === 'react' ? { createElement() {} } : { createPortal() {} });
}
class Element extends EventTarget {
  constructor(tag) { super(); this.tag = tag; this.children = []; this.style = {}; this.attributes = new Map(); this.isConnected = true; this.classList = { contains: name => (this.className || '').split(/\s+/).includes(name) }; }
  append(...elements) { this.children.push(...elements); }
  appendChild(element) { this.append(element); }
  setAttribute(key, value) { this.attributes.set(key, String(value)); }
  hasAttribute(key) { return this.attributes.has(key); }
  getAttribute(key) { return this.attributes.get(key) ?? null; }
  removeAttribute(key) { this.attributes.delete(key); }
  getBoundingClientRect() { return { top: 0, height: 48 }; }
  contains(node) { return this === node || this.children.some(child => child.contains(node)); }
  remove() { this.isConnected = false; }
  focus() { this.focused = true; }
}
function fixture(options = {}) {
  const api = bundle(), win = new EventTarget(), body = new Element('body'), main = new Element('main'), button = new Element('button'), root = new Element('aside');
  let right = 280;
  root.getBoundingClientRect = () => ({ right, top: 0 });
  const strip = { getBoundingClientRect: () => ({ top: 700, height: 24 }) };
  const doc = new EventTarget();
  Object.assign(doc, { body, createElement: tag => new Element(tag),
    querySelector: selector => selector === '.neko-strip' ? strip : selector === '.neko-community' || selector === '.neko-community:not(.neko-bilibili)' ? button : null,
    querySelectorAll: selector => selector === 'main' ? [main] : selector === '.neko-community' ? [button] : [] });
  let observer, resizeObserver;
  Object.assign(win, { innerWidth: 1100, innerHeight: 724,
    requestAnimationFrame: callback => setImmediate(callback), cancelAnimationFrame: clearImmediate,
    MutationObserver: class { constructor(callback) { this.callback = callback; observer = this; } observe() {} disconnect() { this.disconnected = true; } },
    ResizeObserver: class { constructor(callback) { this.callback = callback; resizeObserver = this; } observe() {} disconnect() { this.disconnected = true; } } });
  const calls = [];
  let notify = () => {}, notifyWorkbench = () => {}, unsubscribed = false, workbenchUnsubscribed = false;
  const bridge = { community: async request => { calls.push(JSON.parse(JSON.stringify(request))); return { ok: true }; },
    getState: options.getState || (() => Promise.resolve({})),
    subscribe(callback) { notifyWorkbench = callback; return () => { workbenchUnsubscribed = true; }; },
    subscribeCommunity(callback) { notify = callback; return () => { unsubscribed = true; }; } };
  Object.assign(bridge, options.bridge || {});
  const pane = api.createCommunityPane({ window: win, document: doc, bridge, locate: () => ({ root }) });
  return { api, pane, bridge, calls, doc, win, main, button, root, body, panel: body.children[0], observer, resizeObserver,
    notify(state) { notify(state); }, navigate(state) { notifyWorkbench(state); }, get unsubscribed() { return unsubscribed; },
    get workbenchUnsubscribed() { return workbenchUnsubscribed; }, setRight(value) { right = value; } };
}
const tick = () => new Promise(resolve => setImmediate(resolve));

test('desktop identity control is community-only, cancellable, and ignores late results after switching sites', async () => {
  const actions = []; let finish, notifyAccount, unsubscribed = false;
  const f = fixture({ bridge: {
    communityAccount(action) { actions.push(action); return action === 'connect' ? new Promise(resolve => { finish = resolve; }) : Promise.resolve({ status: 'idle' }); },
    subscribeCommunityAccount(callback) { notifyAccount = callback; return () => { unsubscribed = true; }; },
  } });
  const bar = f.panel.children[0].children[8], message = bar.children[0], button = bar.children[1];
  await f.pane.open();
  assert.equal(bar.hidden, false);
  button.dispatchEvent(new Event('click'));
  assert.deepEqual(actions, ['connect']);
  assert.equal(button.textContent, '取消连接');
  notifyAccount({ status: 'authorizing', message: '请完成官方授权' });
  assert.equal(message.textContent, '请完成官方授权');
  await f.pane.open('bilibili');
  assert.deepEqual(actions, ['connect', 'cancel']);
  assert.equal(bar.hidden, true);
  finish({ status: 'handed-off', message: '迟到的结果' });
  await tick();
  assert.notEqual(message.textContent, '迟到的结果');
  notifyAccount({ status: 'error', message: '迟到的状态' });
  assert.notEqual(message.textContent, '迟到的状态');
  f.pane.dispose();
  assert.equal(unsubscribed, true);
});

test('community bounds cover only the coding region and exclude the product strip', () => {
  const api = bundle();
  assert.deepEqual(JSON.parse(JSON.stringify(api.communityPaneBounds({ right: 280.2, top: 0 }, { width: 1100, height: 724 }, { top: 700, height: 24 }))), { x: 281, y: 0, width: 819, height: 700 });
  for (const right of [NaN, -10, 1000, Infinity]) assert.equal(api.communityPaneBounds({ right, top: 0 }, { width: 1100, height: 724 }), null);
  assert.equal(api.communityPaneBounds({ right: 280, top: 650 }, { width: 1100, height: 724 }), null);
});

test('opening, resizing and returning preserve the original coding DOM and focusable sidebar', async () => {
  const f = fixture();
  f.main.textContent = 'unsent coding draft';
  await f.pane.open();
  assert.deepEqual(f.calls[0], { action: 'open', site: 'community', bounds: { x: 280, y: 48, width: 820, height: 652 }, requestId: 1 });
  assert.equal(f.panel.hidden, false);
  assert.equal(f.main.hasAttribute('inert'), true);
  assert.equal(f.root.hasAttribute('inert'), false);
  assert.equal(f.button.getAttribute('aria-pressed'), 'true');
  f.setRight(64); f.win.innerWidth = 1200;
  f.win.dispatchEvent(new Event('resize'));
  await tick(); await tick();
  assert.deepEqual(f.calls.at(-1), { action: 'layout', bounds: { x: 64, y: 48, width: 1136, height: 652 } });
  f.panel.children[0].children[0].dispatchEvent(new Event('click'));
  await tick();
  assert.equal(f.calls.at(-1).action, 'hide');
  assert.equal(f.panel.hidden, true);
  assert.equal(f.main.hasAttribute('inert'), false);
  assert.equal(f.main.textContent, 'unsent coding draft');
  assert.equal(f.button.focused, true);
  await f.pane.open();
  assert.equal(f.calls.at(-1).action, 'open');
  f.pane.dispose();
  assert.equal(f.panel.isConnected, false);
  assert.equal(f.observer.disconnected, true);
  assert.equal(f.unsubscribed, true);
  assert.equal(f.workbenchUnsubscribed, true);
});

test('B站 immersion expands the same view and restores sidebar, bounds and draft on exit', async () => {
  const f = fixture();
  f.main.textContent = 'unsent coding draft';
  const immersion = f.panel.children[0].children[4];
  await f.pane.open('bilibili');
  assert.equal(immersion.hidden, false);
  immersion.dispatchEvent(new Event('click'));
  await tick(); await tick();
  assert.equal(immersion.textContent, '退出沉浸');
  assert.equal(immersion.getAttribute('aria-pressed'), 'true');
  assert.equal(f.root.hasAttribute('inert'), true);
  assert.deepEqual(f.calls.at(-1), { action: 'layout', bounds: { x: 0, y: 48, width: 1100, height: 676 } });
  f.win.innerWidth = 1200; f.win.innerHeight = 800;
  f.win.dispatchEvent(new Event('resize')); await tick(); await tick();
  assert.deepEqual(f.calls.at(-1), { action: 'layout', bounds: { x: 0, y: 48, width: 1200, height: 752 } });
  immersion.dispatchEvent(new Event('click')); await tick(); await tick();
  assert.equal(f.root.hasAttribute('inert'), false);
  assert.equal(immersion.textContent, '沉浸观看');
  assert.deepEqual(f.calls.at(-1), { action: 'layout', bounds: { x: 280, y: 48, width: 920, height: 652 } });
  assert.equal(f.main.textContent, 'unsent coding draft');
  immersion.dispatchEvent(new Event('click')); await tick(); await tick();
  await f.pane.open('community');
  assert.equal(f.root.hasAttribute('inert'), false);
  assert.equal(immersion.hidden, true);
  assert.deepEqual(f.calls.at(-1), { action: 'open', site: 'community', bounds: { x: 280, y: 48, width: 920, height: 652 }, requestId: 2 });
  f.pane.dispose();
});

test('hiding immersion preserves a previously inert sidebar and restores on disposal', async () => {
  const f = fixture();
  f.root.setAttribute('inert', '');
  await f.pane.open('bilibili');
  f.panel.children[0].children[4].dispatchEvent(new Event('click'));
  await tick(); await tick();
  f.pane.hide();
  assert.equal(f.root.hasAttribute('inert'), true);
  assert.equal(f.panel.hidden, true);
  f.pane.dispose();
});

test('share copies only enabled B站 video links, reports success and failure, and clears on navigation', async () => {
  const f = fixture();
  const feedback = f.panel.children[0].children[5], share = f.panel.children[0].children[6];
  await f.pane.open('bilibili');
  assert.equal(share.hidden, false);
  assert.equal(share.textContent, '复制视频链接');
  assert.equal(share.disabled, true, 'no share before current video is confirmed');
  share.dispatchEvent(new Event('click')); await tick();
  assert.notEqual(f.calls.at(-1).action, 'copy-video-link');
  f.notify({ site: 'bilibili', status: 'ready', canShare: true });
  assert.equal(share.disabled, false);
  share.dispatchEvent(new Event('click')); await tick(); await tick();
  assert.deepEqual(f.calls.at(-1), { action: 'copy-video-link' });
  assert.equal(feedback.textContent, '链接已复制');
  f.bridge.community = async request => { f.calls.push(request); if (request.action === 'copy-video-link') return { ok: false }; return { ok: true }; };
  share.dispatchEvent(new Event('click')); await tick(); await tick();
  assert.equal(feedback.textContent, '复制失败，请重试');
  f.notify({ site: 'bilibili', status: 'loading', canShare: true });
  assert.equal(share.disabled, true, 'old page cannot remain shareable during navigation');
  assert.equal(feedback.textContent, '');
  f.notify({ site: 'bilibili', status: 'ready', canShare: false });
  assert.equal(share.disabled, true);
  await f.pane.open('community');
  assert.equal(share.hidden, true);
  f.pane.dispose();
});

test('late share result after navigating away does not claim a copy of the new page', async () => {
  const f = fixture();
  const feedback = f.panel.children[0].children[5], share = f.panel.children[0].children[6];
  let finish;
  f.bridge.community = request => request.action === 'copy-video-link' ? new Promise(resolve => { finish = resolve; }) : Promise.resolve({ ok: true });
  await f.pane.open('bilibili');
  f.notify({ site: 'bilibili', status: 'ready', canShare: true });
  share.dispatchEvent(new Event('click')); await tick();
  assert.equal(share.disabled, true);
  f.notify({ site: 'bilibili', status: 'loading', canShare: false });
  finish({ ok: true }); await tick(); await tick();
  assert.equal(feedback.textContent, '');
  assert.equal(share.disabled, true);
  f.pane.dispose();
});

test('official player opens only a confirmed B站 video and never claims actual playback', async () => {
  const f = fixture();
  const feedback = f.panel.children[0].children[5], official = f.panel.children[0].children[7];
  assert.equal(official.hidden, true);
  await f.pane.open('bilibili');
  assert.equal(official.hidden, false);
  assert.equal(official.disabled, true);
  official.dispatchEvent(new Event('click')); await tick();
  assert.notEqual(f.calls.at(-1).action, 'play-official');
  f.notify({ site: 'bilibili', requestId: 1, status: 'ready', canPlayOfficial: true, isOfficialPlayer: false });
  assert.equal(official.disabled, false);
  official.dispatchEvent(new Event('click')); await tick(); await tick();
  assert.deepEqual(f.calls.at(-1), { action: 'play-official' });
  assert.equal(feedback.textContent, '', 'loading the page must not claim the video played');
  f.notify({ site: 'bilibili', requestId: 1, status: 'loading', canPlayOfficial: true });
  assert.equal(official.disabled, true, 'loading prevents a second navigation');
  f.notify({ site: 'bilibili', requestId: 1, status: 'ready', canPlayOfficial: false, isOfficialPlayer: true });
  assert.equal(official.disabled, true, 'already in the official player');
  f.notify({ site: 'bilibili', requestId: 1, status: 'ready', canPlayOfficial: true, isOfficialPlayer: false });
  assert.equal(official.disabled, false, 'returning to a video page restores the action');
  await f.pane.open('community');
  assert.equal(official.hidden, true);
  f.pane.dispose();
});

test('official player errors are visible and late outcomes cannot affect another site', async () => {
  const f = fixture();
  const feedback = f.panel.children[0].children[5], official = f.panel.children[0].children[7];
  let finish;
  f.bridge.community = request => request.action === 'play-official'
    ? new Promise(resolve => { finish = resolve; }) : Promise.resolve({ ok: true });
  await f.pane.open('bilibili');
  f.notify({ site: 'bilibili', requestId: 1, status: 'ready', canPlayOfficial: true });
  official.dispatchEvent(new Event('click')); await tick();
  assert.equal(official.disabled, true);
  assert.equal(official.textContent, '正在打开…');
  await f.pane.open('community');
  finish({ ok: false }); await tick(); await tick();
  assert.equal(feedback.textContent, '', 'an old failure must not affect the new page');
  await f.pane.open('bilibili');
  f.notify({ site: 'bilibili', requestId: 3, status: 'ready', canPlayOfficial: true });
  f.bridge.community = async request => request.action === 'play-official' ? { ok: false } : { ok: true };
  official.dispatchEvent(new Event('click')); await tick(); await tick();
  assert.match(feedback.textContent, /官方播放器未能打开/);
  f.pane.dispose();
});

test('a user back while the player opens suppresses a late player error', async () => {
  const f = fixture();
  const feedback = f.panel.children[0].children[5], official = f.panel.children[0].children[7];
  const back = f.panel.children[0].children[1];
  let finish;
  f.bridge.community = request => request.action === 'play-official'
    ? new Promise(resolve => { finish = resolve; }) : Promise.resolve({ ok: true });
  await f.pane.open('bilibili');
  f.notify({ site: 'bilibili', requestId: 1, status: 'ready', canPlayOfficial: true, canGoBack: true });
  official.dispatchEvent(new Event('click')); await tick();
  back.dispatchEvent(new Event('click')); await tick();
  finish({ ok: false }); await tick(); await tick();
  assert.equal(feedback.textContent, '', 'previous page must not display a stale player failure');
  assert.equal(official.disabled, true, 'the returned page needs fresh state to re-enable');
  f.pane.dispose();
});

test('a late old navigation snapshot cannot close leisure, but new fish settings can', async () => {
  let resolveState;
  const f = fixture({ getState: () => new Promise(resolve => { resolveState = resolve; }) });
  await f.pane.open();
  resolveState({ navigation: { fishSettingsRevision: 3 } }); await tick();
  assert.equal(f.panel.hidden, false);
  assert.equal(f.api.getWorkspaceMode(), 'leisure');
  f.navigate({ navigation: { fishSettingsRevision: 4 } });
  assert.equal(f.panel.hidden, true);
  assert.equal(f.api.getWorkspaceMode(), 'work');
  f.pane.dispose();
});

test('same-site reopen ignores stale hidden and ready events but honors current host hide', async () => {
  const f = fixture();
  const share = f.panel.children[0].children[6];
  await f.pane.open('bilibili');
  const oldId = f.calls.at(-1).requestId;
  f.pane.hide();
  const reopen = f.pane.open('bilibili');
  await tick(); await reopen;
  const newId = f.calls.findLast(call => call.action === 'open').requestId;
  assert.equal(newId, oldId + 1);
  assert(f.calls.some(call => call.action === 'hide' && call.requestId === oldId));
  f.notify({ site: 'bilibili', requestId: oldId, status: 'hidden' });
  f.notify({ site: 'bilibili', requestId: oldId, status: 'ready', canShare: true });
  assert.equal(f.panel.hidden, false, 'late hidden from the old view does not close the new one');
  assert.equal(share.disabled, true, 'late state cannot enable share for the new view');
  f.notify({ site: 'bilibili', requestId: newId, status: 'ready', canShare: true });
  assert.equal(share.disabled, false);
  f.notify({ site: 'bilibili', requestId: newId, status: 'hidden' });
  assert.equal(f.panel.hidden, true, 'current host-initiated hide is honored');
  await tick();
  assert(f.calls.some(call => call.action === 'hide' && call.requestId === newId));
  f.pane.dispose();
});

test('returning while loading cannot reopen the pane when the late response arrives', async () => {
  const f = fixture();
  let finish, reject;
  f.bridge.community = request => {
    f.calls.push(request);
    return request.action === 'open' ? new Promise((resolve, fail) => { finish = resolve; reject = fail; }) : Promise.resolve({ ok: true });
  };
  const opening = f.pane.open(); await tick();
  f.pane.hide(); await tick();
  assert.equal((await opening).cancelled, true, 'return unlocks the entry while the original native load is still pending');
  finish({ ok: true }); await tick();
  assert.equal(f.panel.hidden, true);
  assert.equal(f.button.getAttribute('aria-pressed'), 'false');
  f.notify({ status: 'ready' });
  assert.equal(f.panel.hidden, true);
  assert.equal(f.main.hasAttribute('inert'), false);
  const reopening = f.pane.open(); await tick();
  f.pane.hide(); await tick();
  reject(new Error('cancelled in native host'));
  assert.equal((await reopening).cancelled, true, 'user return never becomes an error notice');
  f.pane.dispose();
});

test('covered coding divs cannot keep keyboard focus, and host disposal returns to coding', async () => {
  const f = fixture();
  const back = f.panel.children[0].children[0];
  await f.pane.open();
  assert.equal(back.focused, true);
  back.focused = false;
  const input = new Element('textarea');
  const event = new Event('focusin');
  Object.defineProperty(event, 'target', { value: input });
  f.doc.dispatchEvent(event);
  assert.equal(back.focused, true, 'focus guard also covers non-main coding surfaces');
  f.notify({ status: 'hidden' });
  assert.equal(f.panel.hidden, true);
  assert.equal(f.main.hasAttribute('inert'), false);
  f.pane.dispose();
});

test('load failure provides retry in place; removed layout and unload restore coding state', async () => {
  const f = fixture();
  f.main.setAttribute('inert', ''); // Preserve a pre-existing native restriction.
  f.bridge.community = async request => { f.calls.push(request); if (request.action === 'open') throw new Error('offline'); return { ok: true }; };
  await assert.rejects(f.pane.open(), /offline/);
  assert.match(f.panel.children[1].textContent, /未能加载/);
  const reload = f.panel.children[0].children[3];
  assert.equal(reload.disabled, false);
  reload.dispatchEvent(new Event('click')); await tick(); await tick();
  assert.equal(f.calls.at(-1).action, 'reload');
  f.notify({ status: 'error', error: 'page error' });
  assert.match(f.panel.children[1].textContent, /未能加载/);
  assert.equal(reload.disabled, false);
  f.root.isConnected = false; f.observer.callback(); await tick(); await tick();
  assert.equal(f.panel.hidden, true);
  f.pane.dispose(); f.pane.dispose();
  assert.equal(f.main.hasAttribute('inert'), true);
  await assert.rejects(f.pane.open(), /已关闭/);
});

test('old bridges cannot fall back to opening a separate community window', async () => {
  const api = bundle(); let opened = false;
  const pane = api.createCommunityPane({ window: {}, document: { body: {} }, bridge: { action() { opened = true; } } });
  await assert.rejects(pane.open(), /尚未就绪/);
  assert.equal(opened, false);
  pane.dispose();
});


test('desktop task navigation hides the active native community before selecting the exact coding session', async () => {
  const f = fixture(), opened = [], listeners = new Set();
  f.main.textContent = 'existing unsent draft';
  await f.pane.open();
  const bridge = { getState: async () => ({}), subscribe(callback) { listeners.add(callback); return () => listeners.delete(callback); } };
  const dispose = f.api.subscribeSessionNavigation(bridge, id => {
    assert.equal(f.panel.hidden, true);
    assert.equal(f.main.hasAttribute('inert'), false);
    opened.push(id);
  }, () => assert.fail('native navigation should succeed'), () => f.pane.hide());
  for (const callback of listeners) callback({ navigation: { revision: 1, sessionId: 'real-task' } });
  await tick();
  assert.deepEqual(opened, ['real-task']);
  assert.equal(f.calls.at(-1).action, 'hide');
  assert.equal(f.main.textContent, 'existing unsent draft');
  dispose(); f.pane.dispose();
});
