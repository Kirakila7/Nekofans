'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createPanel } = require('../../apps/neko-workbench/visits/panel.js');

class Element extends EventTarget {
  constructor(tag) { super(); this.tag = tag; this.children = []; this.attributes = new Map(); this.value = ''; this.disabled = false; this.hidden = false; this.scrollHeight = 200; this.clientHeight = 200; this.scrollTop = 0; this._text = ''; }
  append(...items) { this.children.push(...items); }
  replaceChildren(...items) { this.children = items; this._text = ''; }
  set textContent(value) { this._text = String(value); this.children = []; }
  get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
  setAttribute(name, value) { this.attributes.set(name, value); }
  getAttribute(name) { return this.attributes.get(name); }
  click() { if (!this.disabled) this.dispatchEvent(new Event('click')); }
}
const tick = () => new Promise(resolve => setImmediate(resolve));
const snapshot = () => ({ account: { signedIn: true, displayName: '主人' }, persona: { name: '小猫', description: '喜欢天空' }, friends: [{ id: 'f1', displayName: '好朋友', online: true, available: true }, { id: 'f2', displayName: '尚未启动', online: true, available: false }], invitations: [{ notificationId: 'n1', visitId: 'v1', displayName: '好朋友', expiresAt: '2099-01-01T00:00:00Z' }], session: null, history: [{ visitId: 'past', startedAt: '2026-10-28T10:00:00Z' }] });
function fixture(initial = snapshot(), implementation) {
  const root = new Element('div'), win = new EventTarget(), calls = []; let listener, unsubscribed = false;
  const bridge = { async call(action, payload) { calls.push({ action, payload }); return implementation ? implementation(action, payload) : initial; }, subscribe(callback) { listener = callback; return () => { unsubscribed = true; }; } };
  const panel = createPanel({ document: { createElement: tag => new Element(tag), getElementById: () => root }, window: win, bridge, root });
  return { panel, root, calls, win, notify(value) { listener(value); }, get unsubscribed() { return unsubscribed; } };
}

test('friend availability controls inviting and pending invitations reach the bridge', async () => {
  const f = fixture(); await f.panel.ready;
  const friends = f.panel.nodes.friends.children;
  assert.equal(friends[0].children[1].disabled, false);
  assert.equal(friends[1].children[1].disabled, true);
  friends[0].children[1].click(); await tick();
  assert.deepEqual(f.calls.at(-1), { action: 'invite', payload: { userId: 'f1' } });
  f.panel.nodes.invitations.children[0].children[2].children[0].click(); await tick();
  assert.deepEqual(f.calls.at(-1), { action: 'accept', payload: { notificationId: 'n1' } });
  f.panel.nodes.invitations.children[0].children[2].children[1].click(); await tick();
  assert.deepEqual(f.calls.at(-1), { action: 'decline', payload: { notificationId: 'n1' } });
  f.panel.dispose();
});

test('edited public persona survives updates and saves only explicitly entered public fields', async () => {
  const f = fixture(); await f.panel.ready;
  f.panel.nodes.name.value = '新名字'; f.panel.nodes.name.dispatchEvent(new Event('input'));
  f.panel.nodes.description.value = '公开介绍'; f.panel.nodes.description.dispatchEvent(new Event('input'));
  f.notify(snapshot());
  assert.equal(f.panel.nodes.name.value, '新名字');
  const form = f.root.children[2].children[0].children[0].children[2];
  form.dispatchEvent(new Event('submit', { cancelable: true })); await tick();
  assert.deepEqual(f.calls.at(-1), { action: 'savePersona', payload: { name: '新名字', description: '公开介绍' } });
  f.panel.dispose();
});

test('remote message text stays literal, active sessions expose stop and prevent overlapping invitations', async () => {
  const f = fixture(); await f.panel.ready;
  const next = snapshot(); next.session = { visitId: 'v1', phase: 'active', role: 'host', messages: [{ id: 'm1', role: 'guest', text: '<img src=x onerror=alert(1)>你好吗？' }] };
  f.notify(next);
  const bubble = f.panel.nodes.messages.children[0].children[1];
  assert.equal(bubble.textContent, '<img src=x onerror=alert(1)>你好吗？'); assert.equal(bubble.children.length, 0);
  assert.equal(f.panel.nodes.stop.hidden, false); assert.equal(f.panel.nodes.friends.children[0].children[1].disabled, true);
  f.panel.nodes.stop.click(); await tick(); assert.equal(f.calls.at(-1).action, 'stop');
  f.panel.dispose();
});

test('history remains visible during live updates and can return to current conversation', async () => {
  const state = snapshot();
  const f = fixture(state, action => action === 'history' ? { visitId: 'past', startedAt: '2026-10-28T10:00:00Z', messages: [{ role: 'host', text: '旧对话' }] } : state);
  await f.panel.ready; f.panel.nodes.history.children[0].click(); await tick();
  assert.match(f.panel.nodes.messages.textContent, /旧对话/);
  const live = snapshot(); live.session = { visitId: 'current', phase: 'active', messages: [{ role: 'guest', text: '新对话' }] }; f.notify(live);
  assert.match(f.panel.nodes.messages.textContent, /旧对话/);
  f.panel.nodes.live.click(); assert.match(f.panel.nodes.messages.textContent, /新对话/);
  f.panel.dispose();
});

test('failed calls re-enable controls without exposing raw credentials or server errors', async () => {
  const f = fixture(snapshot(), action => { if (action === 'refresh') throw new Error('SECRET_TOKEN database stack trace'); return snapshot(); });
  await f.panel.ready; f.panel.nodes.refresh.click(); await tick();
  assert.equal(f.panel.nodes.refresh.disabled, false); assert.equal(f.panel.nodes.alert.hidden, false);
  assert.doesNotMatch(f.root.textContent, /SECRET_TOKEN|stack trace/);
  f.win.dispatchEvent(new Event('beforeunload')); assert.equal(f.unsubscribed, true);
  f.notify({ error: 'SECRET_TOKEN' }); assert.doesNotMatch(f.root.textContent, /SECRET_TOKEN/);
});

test('preload exposes only whitelisted calls and removes exactly its own subscription', async () => {
  let exposed, handler; const calls = [], removals = [];
  const electron = { contextBridge: { exposeInMainWorld(name, bridge) { assert.equal(name, 'nekoVisits'); exposed = bridge; } }, ipcRenderer: { invoke(...args) { calls.push(args); return Promise.resolve({}); }, on(channel, callback) { assert.equal(channel, 'workbench:visits-state'); handler = callback; }, removeListener(...args) { removals.push(args); } } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../apps/neko-workbench/visits/panel-preload.cjs'), 'utf8'), { require(name) { assert.equal(name, 'electron'); return electron; } });
  await exposed.call('invite', { userId: 'friend', action: 'arbitrary' });
  assert.equal(calls[0][0], 'workbench:visits'); assert.equal(calls[0][1].action, 'invite'); assert.equal(calls[0][1].userId, 'friend');
  await assert.rejects(exposed.call('readFile'));
  let state; const off = exposed.subscribe(value => { state = value; }); handler({ secretEvent: true }, { session: null }); assert.deepEqual(state, { session: null }); off(); assert.equal(removals[0][1], handler);
});

test('switching accounts clears viewed history and unsaved persona from the previous account', async () => {
  const first = snapshot(); first.account.id = 'A';
  const f = fixture(first, action => action === 'history' ? { visitId: 'past', messages: [{ role: 'host', text: 'ACCOUNT_A_PRIVATE_VISIT' }] } : first);
  await f.panel.ready; f.panel.nodes.history.children[0].click(); await tick();
  assert.match(f.panel.nodes.messages.textContent, /ACCOUNT_A_PRIVATE_VISIT/);
  f.panel.nodes.description.value = 'ACCOUNT_A_DRAFT'; f.panel.nodes.description.dispatchEvent(new Event('input'));
  const second = snapshot(); second.account.id = 'B'; second.persona.description = 'B 的公开介绍'; second.history = [];
  f.notify(second);
  assert.doesNotMatch(f.root.textContent, /ACCOUNT_A_PRIVATE_VISIT/);
  assert.equal(f.panel.nodes.description.value, 'B 的公开介绍'); assert.equal(f.panel.nodes.live.hidden, true);
  f.panel.dispose();
});

test('logging out while history loads clears the display and rejects the late result after another login', async () => {
  const first = snapshot(); first.account.id = 'A'; let completeHistory;
  const f = fixture(first, action => action === 'history' ? new Promise(resolve => { completeHistory = resolve; }) : action === 'logout' ? { account: { signedIn: false }, history: [], session: null } : first);
  await f.panel.ready; f.panel.nodes.history.children[0].click(); await tick();
  assert.equal(f.panel.nodes.logout.disabled, false);
  f.panel.nodes.logout.click(); await tick(); assert.equal(f.calls.at(-1).action, 'logout');
  const second = snapshot(); second.account.id = 'B'; second.history = []; f.notify(second);
  completeHistory({ visitId: 'past', messages: [{ role: 'host', text: 'ACCOUNT_A_LATE_HISTORY' }] }); await tick();
  assert.doesNotMatch(f.root.textContent, /ACCOUNT_A_LATE_HISTORY/); assert.equal(f.panel.nodes.live.hidden, true);
  assert.equal(f.panel.nodes.refresh.disabled, false);
  f.panel.dispose();
});

test('known error codes have actionable safe messages while unknown errors remain generic', async () => {
  const f = fixture(); await f.panel.ready;
  for (const [code, expected] of [['config_not_ready', '登录服务尚未配置'], ['chat_model_not_ready', '聊天 API'], ['invalid_service_response', '服务返回异常'], ['login_required', '先登录'], ['timeout', '网络连接超时'], ['oauth_callback_unavailable', '登录回调端口不可用'], ['browser_open_failed', '默认浏览器'], ['login_timeout', '登录等待已超时'], ['secure_storage_unavailable', '加密存储不可用']]) {
    f.notify({ ...snapshot(), error: { code, message: 'SECRET' } }); assert.match(f.panel.nodes.alert.textContent, new RegExp(expected)); assert.doesNotMatch(f.panel.nodes.alert.textContent, /SECRET/);
  }
  f.notify({ ...snapshot(), error: 'SECRET' }); assert.doesNotMatch(f.panel.nodes.alert.textContent, /SECRET/);
  assert.match(f.panel.nodes.friends.textContent, /社区在线 · 可邀请/); assert.doesNotMatch(f.panel.nodes.friends.textContent, /猫娘可接待/);
  f.panel.dispose();
});

test('persona UTF-8 byte limit rejects oversize descriptions without truncation', async () => {
  const f = fixture(); await f.panel.ready;
  const form = f.root.children[2].children[0].children[0].children[2];
  f.panel.nodes.description.value = '猫'.repeat(342); f.panel.nodes.description.dispatchEvent(new Event('input'));
  form.dispatchEvent(new Event('submit', { cancelable: true })); await tick();
  assert.equal(f.calls.length, 1); assert.equal(f.panel.nodes.description.value, '猫'.repeat(342)); assert.match(f.panel.nodes.alert.textContent, /1024 UTF-8/);
  f.panel.nodes.description.value = '猫'.repeat(341); form.dispatchEvent(new Event('submit', { cancelable: true })); await tick();
  assert.equal(f.calls.at(-1).action, 'savePersona'); assert.equal(f.calls.at(-1).payload.description, '猫'.repeat(341));
  f.panel.dispose();
});

test('a safe state error published before a generic IPC rejection remains actionable', async () => {
  const signedOut = { ...snapshot(), account: { signedIn: false }, error: null };
  let rejectLogin;
  const f = fixture(signedOut, action => action === 'login' ? new Promise((_resolve, reject) => { rejectLogin = reject; }) : signedOut);
  await f.panel.ready;
  f.panel.nodes.login.click(); await tick();
  f.notify({ ...signedOut, error: 'config_not_ready' });
  rejectLogin(new Error('An error occurred in the IPC handler')); await tick();
  assert.match(f.panel.nodes.alert.textContent, /串门登录服务尚未配置/);
  assert.doesNotMatch(f.panel.nodes.alert.textContent, /IPC|handler/);
  // An unchanged old error must not get attributed to a subsequent failed action.
  f.panel.nodes.login.click(); await tick();
  rejectLogin(new Error('generic')); await tick();
  assert.equal(f.panel.nodes.alert.textContent, '登录未完成，请重试。');
  f.panel.dispose();
});
