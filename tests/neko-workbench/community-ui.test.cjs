'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function bundle() {
  const file = path.resolve(__dirname, '../../apps/neko-workbench/embedded-dsh/b0-skin/packages/dsh-client-ui-white-label/lib/client.js');
  let entry;
  const sandbox = { window: { __ModuleLoader__: { load(value) { entry = value; } } }, setTimeout, clearTimeout };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(file, 'utf8'), sandbox, { filename: file });
  const React = {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
    useState: initial => [typeof initial === 'function' ? initial() : initial, () => {}],
    useEffect: () => {}, useRef: () => ({ current: null }),
  };
  return entry.factory(name => {
    if (name === 'react') return React;
    if (name === 'react-dom') return { createPortal: (node, host) => ({ node, host }) };
    throw new Error(`Unexpected dependency: ${name}`);
  });
}

const tick = () => new Promise(resolve => setImmediate(resolve));
function bridge(getState = async () => ({ workbench: { connection: 'starting' } })) {
  const actions = [];
  return { actions, getState, subscribe: () => () => {},
    openCommunity: async () => { actions.push('community-pane'); return { ok: true }; },
    setAvatar: () => { throw new Error('community must not change avatar'); },
    uploadAvatar: () => { throw new Error('community must not change avatar'); },
    action: async name => { actions.push(name); return { ok: true }; } };
}

test('community button is disabled until a real native handshake; failed handshake remains disabled', async () => {
  const api = bundle();
  const native = bridge();
  const store = api.createStore(native);
  assert.equal(api.CommunityEntry({ snap: store.get(), store }).props.disabled, true);
  assert.equal(await store.runAction('open-community'), false);
  assert.deepEqual(native.actions, []);
  await tick();
  assert.equal(api.CommunityEntry({ snap: store.get(), store }).props.disabled, false);
  store.dispose();
  const failed = api.createStore(bridge(async () => { throw new Error('native window gone'); }));
  await tick();
  assert.equal(failed.get().ready, true);
  assert.equal(failed.get().bridgeReady, false);
  const unavailable = api.CommunityEntry({ snap: failed.get(), store: failed });
  assert.equal(unavailable.props.disabled, true);
  assert.equal(unavailable.props.title, '社区尚未就绪');
  failed.dispose();
});

test('native keyboard button opens the coding pane and leaves role/session state intact', async () => {
  const api = bundle();
  const native = bridge();
  const store = api.createStore(native, { openCommunity: () => native.openCommunity() });
  await tick();
  const before = JSON.stringify(store.get().state);
  const entry = api.CommunityEntry({ snap: store.get(), store });
  assert.equal(entry.type, 'button'); // Native Enter/Space activation and tab navigation.
  assert.equal(entry.props.type, 'button');
  assert.equal(entry.props['aria-label'], '社区');
  assert.equal(entry.props.tabIndex, undefined, 'retain native keyboard tab order');
  assert.equal(entry.props.href, undefined, 'renderer does not supply any destination');
  assert.equal(entry.props.disabled, false);
  let stopped = 0;
  await entry.props.onClick({ stopPropagation() { stopped++; } });
  assert.equal(stopped, 1, 'do not bubble into session navigation');
  assert.deepEqual(native.actions, ['community-pane']);
  assert.equal(JSON.stringify(store.get().state), before);
  assert.equal(await store.runAction('https://untrusted.invalid'), false);
  assert.deepEqual(native.actions, ['community-pane']);
  store.dispose();
});

test('community and B站 share an accessible action row before the three role seats', () => {
  const api = bundle();
  const roles = { get: () => ({ preview: true, state: { roles: api.ROLE_DEFAULTS }, pending: {}, notice: null }), subscribe: () => () => {} };
  const tree = api.RoleSeats({ store: roles, tools: null });
  const actions = tree.children[0];
  assert.equal(actions.props.className, 'neko-social-actions');
  assert.equal(actions.children.length, 2);
  assert.equal(actions.children[0].type, api.CommunityEntry);
  const bili = actions.children[1].type({ snap: { preview: false, bridgeReady: true, pending: {} }, store: {} });
  assert.equal(bili.type, 'button');
  assert.equal(bili.props.type, 'button');
  assert.equal(bili.props['aria-label'], 'B站');
  assert.equal(bili.props.tabIndex, undefined, 'retain native keyboard tab order');
  assert.equal(bili.props.href, undefined);
  assert.equal(bili.children[0].props['aria-hidden'], 'true');
  assert.equal(bili.children[0].props.focusable, 'false');
  const group = tree.children.find(node => node?.props?.className === 'neko-roles');
  assert.deepEqual(Array.from(group.children.slice(0, 3), node => node.props.role.id), ['yui', 'bigfish', 'claude']);
  const entry = api.CommunityEntry({ snap: { preview: false, bridgeReady: true, pending: {} }, store: {} });
  assert.equal(entry.children[0].props['aria-hidden'], 'true');
  assert.equal(entry.children[0].props.focusable, 'false');
  assert.match(entry.props.title, /右侧内容区/);
  assert.match(api.CSS, /container-type: inline-size/);
  assert.match(api.CSS, /@container \(max-width: 84px\)/);
  assert.match(api.CSS, /\.neko-community__label \{ display: none; \}/);
  assert.match(api.CSS, /\.neko-community:focus-visible/);
});

test('preview and pending actions cannot open the community; failure appears beside its own entry', async () => {
  const api = bundle();
  const preview = api.createStore(null);
  const entry = api.CommunityEntry({ snap: preview.get(), store: preview });
  assert.equal(entry.props.disabled, true);
  assert.equal(entry.props.onClick({ stopPropagation() {} }), undefined);
  preview.dispose();
  const native = bridge();
  let finish;
  native.openCommunity = () => new Promise(resolve => { finish = resolve; });
  const store = api.createStore(native, { openCommunity: () => native.openCommunity() });
  await tick();
  const opening = store.runAction('open-community');
  const busy = api.CommunityEntry({ snap: store.get(), store });
  assert.equal(busy.props.disabled, true);
  assert.equal(busy.props['aria-busy'], 'true');
  assert.equal(await store.runAction('open-community'), false);
  finish({ ok: true });
  await opening;
  native.openCommunity = async () => { throw new Error('社区暂时不可用'); };
  assert.equal(await store.runAction('open-community'), false);
  assert.equal(store.get().notice.scope, 'community');
  assert.match(store.get().notice.text, /社区暂时不可用/);
  store.dispose();
});
