'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Exercise hooks, host broadcasts and user callbacks without optional DOM deps.
// Nested sections stay as elements so the real launcher and the real QQ section
// can each be driven independently, including out-of-order asynchronous replies.
function fixture(options = {}) {
  let current, entry;
  const listeners = new Set(), calls = [], scripts = [], modules = [], timers = new Map(), documentListeners = new Map();
  let qqMount = null;
  let timerId = 0;
  const initial = options.initial || { selection: { fish: true, qqbot: false }, fish: { phase: 'paused', enabled: false }, qqbot: { phase: 'paused', enabled: false }, unified: false, overall: 'idle' };
  let saved = initial;
  const bridge = {
    getState: options.getState || (async () => ({ fishQq: saved })),
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    async fishQq(payload) {
      calls.push(JSON.parse(JSON.stringify(payload)));
      if (options.action) return options.action(payload);
      if (payload.action === 'select') saved = { ...saved, selection: payload.selection };
      return saved;
    },
    qqbot: options.qqbot || (async () => initial.qqbot),
    companion: options.companion,
  };
  const window = { nekoWorkbench: bridge, __ModuleLoader__: { load(value) { entry = value; } }, addEventListener() {}, removeEventListener() {} };
  const document = { body: {}, querySelector: selector => selector === '[data-neko-qq-page]:not([hidden])' ? qqMount : null,
    addEventListener(type, fn) { documentListeners.set(type, fn); }, removeEventListener(type) { documentListeners.delete(type); }, head: { appendChild(node) { scripts.push(node); } }, getElementById: () => ({}),
    createElement(tag) { return { tag, remove() { scripts.splice(scripts.indexOf(this), 1); } }; } };
  const React = {
    Fragment: Symbol('fragment'),
    createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity) }),
    useState(initialValue) {
      const owner = current, index = owner.cursor++;
      if (!(index in owner.hooks)) owner.hooks[index] = typeof initialValue === 'function' ? initialValue() : initialValue;
      return [owner.hooks[index], next => {
        const value = typeof next === 'function' ? next(owner.hooks[index]) : next;
        if (!Object.is(value, owner.hooks[index])) { owner.hooks[index] = value; owner.dirty = true; }
      }];
    },
    useRef(initialValue) {
      const owner = current, index = owner.cursor++;
      return owner.hooks[index] ||= { current: initialValue };
    },
    useCallback(fn, deps) {
      const owner = current, index = owner.cursor++, previous = owner.hooks[index];
      if (!previous || deps.some((value, n) => !Object.is(value, previous.deps[n]))) owner.hooks[index] = { fn, deps };
      return owner.hooks[index].fn;
    },
    useEffect(fn, deps) {
      const owner = current, index = owner.cursor++, previous = owner.hooks[index];
      if (!previous || !deps || deps.some((value, n) => !Object.is(value, previous.deps[n]))) {
        owner.effects.push(() => { previous?.cleanup?.(); owner.hooks[index] = { deps, cleanup: fn() }; });
      }
    },
  };
  React.useLayoutEffect = React.useEffect;
  function OfficialPanel() {}
  const sandbox = { window, document,
    fetch: options.fetch || (async () => ({ ok: true, json: async () => ({ config: {}, state: initial.fish }) })),
    setTimeout(fn) { const id = ++timerId; timers.set(id, fn); return id; }, clearTimeout(id) { timers.delete(id); },
    setInterval(fn) { const id = ++timerId; timers.set(id, fn); return id; }, clearInterval(id) { timers.delete(id); },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../apps/neko-workbench/vendor/dsh-bili-whale/lib/client.js'), 'utf8'), sandbox);
  const api = entry.factory(name => {
    modules.push(name);
    return name === 'react' ? React : name === 'react-dom' ? { createPortal: node => node } :
      name === '@bigfish/qqbot-settings' ? { QQBotSettingsSection: OfficialPanel } : assert.fail(name);
  });
  function mount(Component, props = {}) {
    const owner = { hooks: [], effects: [], cursor: 0, dirty: true, tree: null, props };
    owner.flush = () => {
      let guard = 0;
      while (owner.dirty) {
        assert.ok(guard++ < 30, 'render must settle');
        owner.dirty = false; owner.cursor = 0; current = owner;
        owner.tree = Component(owner.props); current = null;
        for (const effect of owner.effects.splice(0)) effect();
      }
      return owner.tree;
    };
    owner.settle = async () => { for (let n = 0; n < 4; n++) { await new Promise(resolve => setImmediate(resolve)); owner.flush(); } };
    owner.unmount = () => { for (const hook of owner.hooks) hook?.cleanup?.(); };
    owner.flush();
    return owner;
  }
  return { api, mount, bridge, calls, scripts, modules, timers, listeners, OfficialPanel,
    emit(value) { for (const listener of listeners) listener(value); },
    navigateQQ(mount) { qqMount = mount; documentListeners.get('neko-qq-page-change')?.(); } };
}
function nodes(node) { return node && typeof node === 'object' ? [node, ...(node.children || []).flatMap(nodes)] : []; }
function visibleNodes(node) {
  if(!node||typeof node!=='object'||node.props.hidden)return [];
  const children=node.type==='details'&&!node.props.open?node.children.filter(child=>child?.type==='summary'):node.children;
  return [node,...children.flatMap(visibleNodes)];
}
function text(node) { return typeof node === 'string' ? node : (node?.children || []).map(text).join(''); }
function find(owner, predicate) { return nodes(owner.flush()).find(predicate); }
function button(owner, label) { const result = find(owner, node => node.type === 'button' && text(node) === label); assert.ok(result, `button ${label}`); return result; }
function tab(owner, label) { return find(owner, node => node.props.role === 'tab' && text(node) === label); }
function open(owner) { button(owner, '养鱼').props.onClick(); owner.flush(); }
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

test('the existing fish avatar is the single entry for the unified panel', () => {
  const f=fixture(),names=[];
  f.api.apply({effect(fn){fn();},slots:{inject(name,fn){names.push(name);fn();},register(){return()=>{};}}});
  assert.deepEqual(names,['sidebar.footer.action'],'do not register a duplicate old settings section');
});

test('beginner panel keeps scan and start controls visible while channel configuration is folded', async () => {
  const f=fixture(), owner=f.mount(f.api.FishLauncher); await owner.settle(); open(owner);
  const entry=find(owner,node=>node.type==='button'&&node.props['aria-label']==='养鱼设置');
  const avatar=nodes(entry).find(node=>node.type==='img');
  assert.ok(avatar?.props.src.startsWith('data:image/webp;base64,'),'the existing fish avatar remains the entry');
  assert.deepEqual(Buffer.from(avatar.props.src.split(',')[1],'base64'),fs.readFileSync(path.join(__dirname,'../../apps/neko-workbench/embedded-dsh/assets/avatars/bigfish.webp')));
  const panel=find(owner,node=>node.props['aria-label']==='连接与生活设置'&&node.type==='aside');
  assert.ok(panel.props.style.zIndex>50,'the unified panel appears above the Codex view');
  const visible=visibleNodes(owner.tree);
  assert.ok(visible.some(node=>node.type==='button'&&text(node)==='一键养鱼'));
  for(const label of ['B 站扫码','QQ 扫码'])assert.ok(visible.some(node=>node.type==='button'&&text(node)===label));
  assert.equal(visible.some(node=>node.type==='input'),false,'channel selection is not part of the basic view');
  const details=find(owner,node=>node.props['data-settings']==='channels');
  assert.ok(details&&!details.props.open);
  assert.equal(find(owner,node=>node.type===f.api.BiliWhaleSection).props.compact,true);
  tab(owner,'QQ 扫码').props.onClick(); owner.flush();
  assert.equal(find(owner,node=>node.type===f.api.QQBotSettings).props.compact,true);
  assert.equal(f.calls.length,0,'opening or switching panels never starts services');
  owner.unmount();
});

test('B站 scan stays visible and all editors and maintenance actions start folded', async () => {
  const f=fixture(),owner=f.mount(f.api.BiliWhaleSection,{compact:true}); await owner.settle();
  const visible=visibleNodes(owner.tree);
  assert.ok(visible.some(node=>node.type?.name==='QrLogin'));
  assert.equal(visible.some(node=>['input','textarea'].includes(node.type)),false);
  assert.equal(visible.some(node=>node.type==='button'),false,'compact B站 section has no duplicate start or maintenance button');
  const details=find(owner,node=>node.props['data-settings']==='bilibili');
  assert.ok(details&&!details.props.open);
  assert.ok(nodes(details).some(node=>node.type==='button'&&text(node)==='保存'));
  assert.ok(nodes(details).some(node=>node.type==='button'&&text(node)==='依赖体检'));
  assert.ok(nodes(details).some(node=>node.type?.name==='WindowsEditor'));
  assert.ok(nodes(details).some(node=>node.type?.name==='ShareEditor'));
  owner.unmount();
});

test('compact QQ keeps initial scan action and folds per-channel pause after connection',async()=>{
  const f=fixture(),owner=f.mount(f.api.QQBotSettings,{compact:true});await owner.settle();
  assert.ok(button(owner,'扫码连接 QQ'));
  f.emit({qqbot:{enabled:true,phase:'running',bound:true,connected:true}});owner.flush();
  const visible=visibleNodes(owner.tree);
  assert.equal(visible.some(node=>node.type==='button'&&text(node)==='暂停 QQ 机器人'),false);
  assert.ok(find(owner,node=>node.type===f.OfficialPanel),'official QR/binding remains available');
  assert.ok(button(owner,'暂停 QQ 机器人'),'individual pause remains available in disclosure');
  owner.unmount();
});

test('one shared panel saves channel selection and never starts on mount or checkbox change', async () => {
  const f = fixture(), owner = f.mount(f.api.FishLauncher);
  await owner.settle(); open(owner);
  assert.equal(find(owner, node => node.props['aria-label'] === '启用B 站养鱼').props.checked, true);
  const qq = find(owner, node => node.props['aria-label'] === '启用QQ 机器人');
  assert.equal(qq.props.checked, false);
  qq.props.onChange({ target: { checked: true } }); await owner.settle();
  assert.deepEqual(f.calls, [{ action: 'select', selection: { fish: true, qqbot: true } }]);
  assert.equal(find(owner, node => node.props['aria-label'] === '启用QQ 机器人').props.checked, true);
  assert.ok(find(owner, node => node.type === f.api.BiliWhaleSection), 'existing fish settings remain in the panel');
  assert.match(text(owner.tree), /额度无法确认/);
  owner.unmount();
  const reopened = f.mount(f.api.FishLauncher); await reopened.settle(); open(reopened);
  assert.equal(find(reopened, node => node.props['aria-label'] === '启用QQ 机器人').props.checked, true);
  reopened.unmount(); assert.equal(f.listeners.size, 0);
});

test('authorization guides B站 before QQ while keeping independent tabs available', async () => {
  const f = fixture(), owner = f.mount(f.api.FishLauncher); await owner.settle(); open(owner);
  const state = { selection: { fish: true, qqbot: true }, fish: { phase: 'login-required' }, qqbot: { phase: 'login-required', enabled: true }, overall: 'idle', unified: false };
  f.emit({ fishQq: state }); owner.flush();
  assert.equal(tab(owner, 'B 站扫码').props['aria-selected'], true);
  assert.equal(button(owner, '全部暂停').props.disabled, false, 'waiting authorization remains cancellable');
  tab(owner, 'QQ 扫码').props.onClick(); owner.flush();
  f.emit({ fishQq: state }); owner.flush();
  assert.equal(tab(owner, 'QQ 扫码').props['aria-selected'], true, 'unchanged broadcasts do not steal the user tab');
  tab(owner, 'B 站扫码').props.onClick(); owner.flush();
  f.emit({ fishQq: { ...state, fish: { phase: 'running', enabled: true } } }); owner.flush();
  assert.equal(tab(owner, 'QQ 扫码').props['aria-selected'], true);
  assert.ok(find(owner, node => node.type === f.api.QQBotSettings));
  owner.unmount();
});

test('pause preempts a pending unified start and rejects its late authorization response', async () => {
  const starting = deferred();
  const paused = { selection: { fish: true, qqbot: true }, fish: { phase: 'paused' }, qqbot: { phase: 'paused' }, unified: false, overall: 'idle' };
  const f = fixture({ initial: paused, action: ({ action }) => action === 'start' ? starting.promise : Promise.resolve(paused) });
  const owner = f.mount(f.api.FishLauncher); await owner.settle(); open(owner);
  button(owner, '一键养鱼').props.onClick(); owner.flush();
  assert.equal(button(owner, '全部暂停').props.disabled, false);
  tab(owner, 'QQ 扫码').props.onClick(); owner.flush();
  button(owner, '全部暂停').props.onClick(); await owner.settle();
  starting.resolve({ ...paused, fish: { phase: 'login-required' } }); await owner.settle();
  assert.deepEqual(f.calls.map(call => call.action), ['start', 'pause']);
  assert.equal(tab(owner, 'QQ 扫码').props['aria-selected'], true);
  assert.ok(button(owner, '一键养鱼'));
  assert.doesNotMatch(text(owner.tree), /等待扫码授权/);
  owner.unmount();
});

test('an old initial snapshot cannot override a newer paused broadcast or open authorization', async () => {
  const old = deferred(), f = fixture({ getState: () => old.promise }), owner = f.mount(f.api.FishLauncher); open(owner);
  tab(owner, 'QQ 扫码').props.onClick(); owner.flush();
  f.emit({ fishQq: { selection: { fish: true, qqbot: false }, fish: { phase: 'paused' }, qqbot: { phase: 'paused' }, overall: 'idle' } }); owner.flush();
  old.resolve({ fishQq: { selection: { fish: true, qqbot: true }, fish: { phase: 'login-required' }, qqbot: { phase: 'bound', enabled: true }, overall: 'idle' } });
  await owner.settle();
  assert.equal(tab(owner, 'QQ 扫码').props['aria-selected'], true);
  assert.ok(button(owner, '一键养鱼'));
  owner.unmount();
});

test('QQ-only selection does not route to B站 authorization and no selection disables start', async () => {
  const f = fixture(), owner = f.mount(f.api.FishLauncher); await owner.settle(); open(owner);
  f.emit({ fishQq: { selection: { fish: false, qqbot: true }, fish: { phase: 'login-required' }, qqbot: { phase: 'scope-required', bound: true }, overall: 'idle' } }); owner.flush();
  assert.equal(tab(owner, 'QQ 扫码').props['aria-selected'], true);
  assert.match(text(owner.tree), /已绑定；网关未连接/);
  assert.doesNotMatch(text(owner.tree), /网关已连接/);
  f.emit({ fishQq: { selection: { fish: false, qqbot: false }, overall: 'idle' } }); owner.flush();
  assert.equal(button(owner, '一键养鱼').props.disabled, true);
  owner.unmount();
});

test('QQ host broadcasts update binding and gateway status without mounting after pause', async () => {
  const old = deferred(), f = fixture({ qqbot: () => old.promise }), owner = f.mount(f.api.QQBotSettings);
  f.emit({ qqbot: { phase: 'bound', enabled: true, bound: true, connected: false } }); owner.flush();
  assert.match(text(owner.tree), /已绑定；网关未连接/);
  assert.ok(find(owner, node => node.type === f.OfficialPanel));
  f.emit({ qqbot: { phase: 'running', enabled: true, bound: true, connected: true } }); owner.flush();
  assert.match(text(owner.tree), /网关已连接/);
  f.emit({ qqbot: { phase: 'paused', enabled: false, bound: true, connected: false } }); owner.flush();
  old.resolve({ phase: 'login-required', enabled: true }); await owner.settle();
  assert.equal(find(owner, node => node.type === f.OfficialPanel), undefined);
  assert.ok(button(owner, '开始连接 QQ'));
  owner.unmount(); assert.equal(f.listeners.size, 0);
});

test('QQ waits for plugin readiness and opens binding automatically after model login', async () => {
  const f = fixture({ qqbot: async () => ({ enabled: true, phase: 'starting' }) });
  const owner = f.mount(f.api.QQBotSettings); await owner.settle();
  assert.equal(f.modules.includes('@bigfish/qqbot-settings'), false, 'even a cached official module cannot bind while starting');
  assert.equal(find(owner, node => node.type === f.OfficialPanel), undefined);
  f.emit({ qqbot: { enabled: true, phase: 'model-login-required' } }); owner.flush();
  assert.equal(f.modules.includes('@bigfish/qqbot-settings'), false);
  assert.equal(f.scripts.length, 0, 'unavailable plugin endpoint is not requested');
  assert.ok(button(owner, '登录工作台账号'));
  f.emit({ qqbot: { enabled: true, phase: 'login-required' } }); owner.flush();
  assert.ok(find(owner, node => node.type === f.OfficialPanel), 'phase transition loads binding with no retry click');
  assert.equal(f.modules.filter(name => name === '@bigfish/qqbot-settings').length, 1);
  owner.unmount();
});

test('automatic B站 QR is cancelled on pause, rejects the late QR, and can restart', async () => {
  const first = deferred(), requests = [];
  const f = fixture({ fetch: async (url, options) => {
    requests.push({ url, body: options?.body && JSON.parse(options.body) });
    if (url.endsWith('/start') && requests.filter(item => item.url.endsWith('/start')).length === 1) return first.promise;
    return { ok: true, json: async () => ({ ok: true, id: 'second', status: 'waiting', image: 'data:image/mock' }) };
  } });
  const parent = f.mount(f.api.BiliWhaleSection); await parent.settle();
  const qrElement = find(parent, node => node.type?.name === 'QrLogin'); assert.ok(qrElement);
  parent.unmount(); requests.length = 0;
  const owner = f.mount(qrElement.type, { disabled: false, onAccount: () => assert.fail('paused QR must not authorize'), onActiveChange() {}, autoStart: true });
  owner.props = { ...owner.props, autoStart: false }; owner.dirty = true; owner.flush();
  first.resolve({ ok: true, json: async () => ({ ok: true, id: 'late', status: 'waiting', image: 'data:image/late' }) }); await owner.settle();
  assert.ok(requests.some(item => item.url.endsWith('/cancel') && item.body.id === 'late'));
  assert.equal(find(owner, node => node.type === 'img'), undefined);
  assert.equal(f.timers.size, 0);
  owner.props = { ...owner.props, autoStart: true }; owner.dirty = true; owner.flush(); await owner.settle();
  assert.equal(requests.filter(item => item.url.endsWith('/start')).length, 2);
  assert.ok(find(owner, node => node.type === 'img'));
  owner.unmount();
});

test('QQ history mounts in the sidebar page, loads only the scoped route and stops refreshing on exit',async()=>{
  const calls=[];
  const f=fixture({companion:async request=>{
    calls.push(request.action);
    return [{id:'q1',role:'user',createdAt:1000,text:'手机发来的消息'},
      {id:'q2',role:'assistant',createdAt:2000,text:'接着聊'}];
  }});
  const launcher=f.mount(f.api.FishLauncher);await launcher.settle();open(launcher);
  assert.equal(tab(launcher,'QQ 会话'),undefined);
  assert.equal(find(launcher,node=>node.type===f.api.QQChatPage),undefined);
  f.navigateQQ({});
  assert(find(launcher,node=>node.type===f.api.QQChatPage));
  const page=f.mount(f.api.QQChatPage,{state:{connected:true}});
  await page.settle();
  assert.equal(find(page,node=>node.props.role==='log').props['aria-label'],'QQ 私聊消息');
  assert.match(text(page.tree),/手机发来的消息/);
  assert.match(text(page.tree),/接着聊/);
  assert.deepEqual(calls,['qq-history']);
  assert.equal(f.timers.size,1);
  f.navigateQQ(null);
  assert.equal(find(launcher,node=>node.type===f.api.QQChatPage),undefined);
  page.unmount();launcher.unmount();
  assert.equal(f.timers.size,0);
});
