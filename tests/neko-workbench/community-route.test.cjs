'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { DEFAULT_COMMUNITY_URL, COMMUNITY_PARTITION, resolveCommunityUrl,
  classifyCommunityNavigation, createCommunityController, validateCommunityRequest,
  communityBounds, createSocialController, BILIBILI_URL, BILIBILI_HOME_URL, BILIBILI_PARTITION, BILIBILI_DESKTOP_USER_AGENT,
  classifyBilibiliNavigation, bilibiliVideoShareUrl, bilibiliOfficialPlayerUrl } = require('../../apps/neko-workbench/community-config.cjs');

const tick = () => new Promise(resolve => setImmediate(resolve));
const bounds = { x: 300, y: 80, width: 800, height: 650 };
const desktopUA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.7871.212 Safari/537.36';
function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
function fixture(env = {}, useSocial = false, extra = {}) {
  const views = [], external = [], states = [], errors = [], copied = [];
  let copyError = null;
  class Contents extends EventEmitter {
    constructor() {
      super(); this.loads = []; this.destroyed = false; this.url = ''; this.closed = []; this.behavior = null;
      this.history = []; this.index = -1;
      this.navigationHistory = {
        canGoBack: () => this.index > 0,
        goBack: () => { if (this.index > 0) { this.url = this.history[--this.index]; this.emit('did-navigate-in-page', {}, this.url, true); } },
      };
    }
    setWindowOpenHandler(handler) { this.popup = handler; }
    setUserAgent(value) { this.userAgent = value; }
    getUserAgent() { return this.userAgent || (extra.rawUserAgent ?? 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) TestApp/0.1 Chrome/150.0.7871.212 Electron/43.3.0 Safari/537.36'); }
    isDestroyed() { return this.destroyed; }
    getURL() { return this.url; }
    focus() { this.focused = (this.focused || 0) + 1; }
    async loadURL(url) {
      this.loads.push(url); this.url = url;
      this.history.splice(++this.index); this.history.push(url);
      this.emit('did-start-navigation', {}, url, false, true);
      if (this.behavior) await this.behavior(url);
      this.emit('did-navigate', {}, url, this.responseCode || 200, 'status');
      this.emit('did-finish-load');
    }
    close(options) { this.closed.push(options); this.destroyed = true; this.emit('destroyed'); }
  }
  class MockView {
    constructor(options) { this.options = options; this.webContents = new Contents(); this.rectangles = []; views.push(this); }
    setBounds(value) { this.rectangles.push(value); this.bounds = value; }
  }
  class MockHost extends EventEmitter {
    constructor() {
      super(); this.destroyed = false; this.size = [1100, 780]; this.scale = 1; this.focused = false; this.children = new Set(); this.additions = 0;
      this.webContents = new Contents(); this.webContents.getZoomFactor = () => this.scale;
      this.contentView = { addChildView: view => { this.additions++; this.children.add(view); }, removeChildView: view => this.children.delete(view) };
    }
    isDestroyed() { return this.destroyed; }
    getContentSize() { return this.size; }
    isFocused() { return this.focused; }
    destroy() { this.emit('close'); this.destroyed = true; this.emit('closed'); }
  }
  class Popup extends EventEmitter {
    constructor(options) { super(); this.options = options; this.webContents = new Contents(); this.destroyed = false; }
    loadURL(url) { return this.webContents.loadURL(url); }
    isDestroyed() { return this.destroyed; }
    destroy() { this.destroyed = true; this.webContents.close(); this.emit('closed'); }
  }
  const controller = (useSocial ? createSocialController : createCommunityController)({ WebContentsView: MockView, env, ...extra,
    openExternal: async url => external.push(url), copyText: text => { if (copyError) throw copyError; copied.push(text); },
    onState: (host, value) => states.push({ host, ...value }), onExternalError: error => errors.push(error) });
  const host = new MockHost();
  const action = request => controller.action(host, request);
  const open = (value = bounds) => action({ action: 'open', bounds: value });
  return { controller, views, external, states, errors, copied, failCopy: () => { copyError = new Error('private clipboard failure'); }, MockHost, Popup, host, action, open };
}

test('identity handoff is confined to active official community and switches cancel it', async () => {
  let cancellations = 0;
  const f = fixture({}, true, { onHide: () => { cancellations++; } });
  const url = DEFAULT_COMMUNITY_URL + '#native_sync=' + 's'.repeat(43) + '&native_delegate=' + 'd'.repeat(43);
  await f.action({ action: 'open', site: 'community', bounds });
  assert.equal(f.controller.isOpen, true);
  await f.controller.handoff(f.host, url);
  const community = f.views[0];
  assert.equal(community.webContents.loads.at(-1), url);
  secure(community.options);
  for (const invalid of [
    'https://evil.invalid/feed',
    'https://user:password@community.project-neko.cn/feed',
    'http://community.project-neko.cn/feed',
    'https://community.project-neko.cn/other',
  ]) await assert.rejects(f.controller.handoff(f.host, invalid), /地址无效/);
  await f.action({ action: 'open', site: 'bilibili', bounds });
  assert.equal(cancellations, 1);
  assert.equal(f.controller.isOpen, false);
  await assert.rejects(f.controller.handoff(f.host, url), /隐藏/);
  assert.equal(f.views[1].webContents.loads.at(-1), BILIBILI_URL);
  await f.action({ action: 'hide' });
  assert.equal(cancellations, 1, 'hiding Bilibili must not cancel a community transfer twice');
  f.controller.dispose();
});

test('identity handoff cannot target an alternate configured community', async () => {
  const f = fixture({ NEKO_WORKBENCH_COMMUNITY_URL: 'https://custom.example/feed' }, true);
  await f.action({ action: 'open', site: 'community', bounds });
  await assert.rejects(f.controller.handoff(f.host, DEFAULT_COMMUNITY_URL + '#native_sync=proof'), /地址无效/);
  assert.equal(f.views[0].webContents.loads.at(-1), 'https://custom.example/feed');
  f.controller.dispose();
});

test('switch to Bilibili during identity handoff fences the late navigation', async () => {
  let cancellations = 0;
  const f = fixture({}, true, { onHide: () => { cancellations++; } });
  await f.action({ action: 'open', site: 'community', bounds });
  const gate = deferred();
  f.views[0].webContents.behavior = () => gate.promise;
  const url = DEFAULT_COMMUNITY_URL + '#native_sync=' + 's'.repeat(43) + '&native_delegate=' + 'd'.repeat(43);
  const pending = f.controller.handoff(f.host, url);
  const canceled = assert.rejects(pending, /隐藏|未能打开/);
  await tick();
  await f.action({ action: 'open', site: 'bilibili', bounds });
  gate.resolve();
  await canceled;
  assert.equal(cancellations, 1);
  assert.equal(f.host.children.has(f.views[0]), false);
  assert.equal(f.host.children.has(f.views[1]), true);
  f.controller.dispose();
});

test('community account handoff remains available alongside Bilibili and is cancelled only when community closes', async () => {
  let cancellations = 0;
  const f = fixture({}, true, { onHide: () => { cancellations++; } });
  const url = DEFAULT_COMMUNITY_URL + '#native_sync=' + 's'.repeat(43) + '&native_delegate=' + 'd'.repeat(43);
  await f.action({ action: 'open', site: 'community', slot: 'left', requestId: 1, bounds });
  await f.action({ action: 'open', site: 'bilibili', slot: 'right', requestId: 2, bounds });
  assert.equal(f.controller.isOpen, true, 'Bilibili is active but community is still open');
  await f.controller.handoff(f.host, url);
  assert.equal(f.views[0].webContents.loads.at(-1), url);
  await f.action({ action: 'hide', slot: 'right', requestId: 2 });
  assert.equal(cancellations, 0, 'hiding Bilibili must not cancel community identity');
  assert.equal(f.controller.isOpen, true);
  const gate = deferred();
  f.views[0].webContents.behavior = () => gate.promise;
  const pending = f.controller.handoff(f.host, url);
  const cancelled = assert.rejects(pending, /隐藏|未能打开/);
  await tick();
  await f.action({ action: 'hide', slot: 'left', requestId: 1 });
  gate.resolve(); await cancelled;
  assert.equal(cancellations, 1);
  assert.equal(f.controller.isOpen, false);
  f.controller.dispose();
});

test('opening Bilibili in another slot does not cancel an in-flight community handoff', async () => {
  const f = fixture({}, true);
  const url = DEFAULT_COMMUNITY_URL + '#native_sync=' + 's'.repeat(43) + '&native_delegate=' + 'd'.repeat(43);
  await f.action({ action: 'open', site: 'community', slot: 'left', bounds });
  const gate = deferred();
  f.views[0].webContents.behavior = () => gate.promise;
  const pending = f.controller.handoff(f.host, url);
  await tick();
  await f.action({ action: 'open', site: 'bilibili', slot: 'right', bounds });
  gate.resolve(); await pending;
  assert.equal(f.controller.isOpen, true);
  assert(f.host.children.has(f.views[0]));
  assert(f.host.children.has(f.views[1]));
  f.controller.dispose();
});
function navigate(contents, type, url) {
  let prevented = false;
  contents.emit(type, { preventDefault() { prevented = true; } }, url);
  return prevented;
}
function secure(options) {
  const { webPreferences } = options;
  assert.equal(webPreferences.partition, COMMUNITY_PARTITION);
  assert.notEqual(webPreferences.partition, 'persist:pet-dsh');
  assert.equal(webPreferences.nodeIntegration, false);
  assert.equal(webPreferences.contextIsolation, true);
  assert.equal(webPreferences.sandbox, true);
  assert.equal(webPreferences.webSecurity, true);
  assert.equal(webPreferences.webviewTag, false);
  assert.equal(webPreferences.allowRunningInsecureContent, false);
  assert.equal('preload' in webPreferences, false);
}

test('community and Bilibili occupy independent slots and moving one reuses its exact view', async () => {
  const f = fixture({}, true);
  const left = { x: 300, y: 80, width: 390, height: 650 };
  const right = { x: 700, y: 80, width: 390, height: 650 };
  const side = { x: 60, y: 80, width: 230, height: 650 };
  await f.action({ action: 'open', site: 'community', slot: 'left', requestId: 1, bounds: left });
  await f.action({ action: 'open', site: 'bilibili', slot: 'right', requestId: 2, bounds: right });
  assert.equal(f.views.length, 2); assert.equal(f.host.children.size, 2);
  const [community, video] = f.views;
  assert.equal(community.options.webPreferences.partition, COMMUNITY_PARTITION);
  assert.equal(video.options.webPreferences.partition, BILIBILI_PARTITION);
  assert.deepEqual(community.bounds, left); assert.deepEqual(video.bounds, right);
  assert(f.states.some(value => value.site === 'community' && value.slot === 'left' && value.status === 'ready'));
  assert(f.states.some(value => value.site === 'bilibili' && value.slot === 'right' && value.status === 'ready'));
  const adjusted = { ...right, width: 350 };
  await f.action({ action: 'layout', slot: 'right', bounds: adjusted });
  assert.deepEqual(community.bounds, left); assert.deepEqual(video.bounds, adjusted);
  await f.action({ action: 'open', site: 'community', slot: 'side', requestId: 3, bounds: side });
  assert.equal(f.views.length, 2); assert.equal(f.host.children.size, 2);
  assert.deepEqual(community.bounds, side); assert.equal(community.webContents.loads.length, 1);
  assert.deepEqual(await f.action({ action: 'hide', slot: 'left', requestId: 1 }), { ok: true });
  assert.deepEqual(await f.action({ action: 'hide', slot: 'side', requestId: 1 }), { ok: true, stale: true });
  assert.equal(f.host.children.size, 2);
  await f.action({ action: 'hide', slot: 'side', requestId: 3 });
  assert.equal(f.host.children.has(community), false); assert.equal(f.host.children.has(video), true);
  await f.action({ action: 'hide' }); assert.equal(f.host.children.size, 0);
});

test('opening, moving and refreshing split views never steals the DSH focus', async () => {
  const f = fixture({}, true); f.host.focused = true;
  await f.action({ action: 'open', site: 'community', slot: 'left', bounds });
  await f.action({ action: 'open', site: 'bilibili', slot: 'right', bounds });
  const [community, video] = f.views;
  assert.equal(community.webContents.focused || 0, 0);
  assert.equal(video.webContents.focused || 0, 0);
  await f.action({ action: 'reload', slot: 'right' });
  await f.action({ action: 'open', site: 'community', slot: 'side', bounds });
  assert.equal(community.webContents.focused || 0, 0);
  assert.equal(video.webContents.focused || 0, 0);
  await f.action({ action: 'open', site: 'bilibili', bounds });
  assert.equal(video.webContents.focused, 1, 'legacy single-pane open retains its focus behaviour');
});

test('a coalesced old single-pane open does not steal focus after being moved into a slot', async () => {
  const f = fixture({}, true), gate = deferred(); f.host.focused = true;
  const first = f.action({ action: 'open', site: 'community', bounds });
  const view = f.views[0]; view.webContents.behavior = () => gate.promise;
  await tick();
  const moved = f.action({ action: 'open', site: 'community', slot: 'left', bounds });
  gate.resolve(); await Promise.all([first, moved]);
  assert.equal(view.webContents.focused || 0, 0);
  assert.equal(f.host.children.size, 1);
});

test('replacing a slot during loading cancels only its old view and retains other slots', async () => {
  const f = fixture({}, true), gate = deferred();
  const first = f.action({ action: 'open', site: 'community', slot: 'left', bounds });
  const firstRejected = assert.rejects(first, /社区已隐藏|未能打开/);
  f.views[0].webContents.behavior = () => gate.promise;
  await tick();
  await f.action({ action: 'open', site: 'bilibili', slot: 'left', bounds });
  await firstRejected;
  assert.equal(f.host.children.size, 1); assert.equal(f.host.children.has(f.views[1]), true);
  gate.resolve(); await tick(); assert.equal(f.host.children.has(f.views[0]), false);
  for (const slot of ['middle', '', null, 1]) assert.throws(() => validateCommunityRequest({ action: 'hide', slot }));
});

test('a new slot assignment supersedes an in-flight legacy hide without closing either new view', async () => {
  const f = fixture({}, true);
  await f.action({ action: 'open', site: 'community', slot: 'left', requestId: 1, bounds });
  await f.action({ action: 'open', site: 'bilibili', slot: 'right', requestId: 2, bounds });
  const staleHide = f.action({ action: 'hide' });
  const side = { x: 70, y: 80, width: 220, height: 600 };
  const reopened = f.action({ action: 'open', site: 'community', slot: 'side', requestId: 3, bounds: side });
  assert.deepEqual(await staleHide, { ok: true, stale: true });
  await reopened;
  assert.equal(f.host.children.size, 2);
  assert.equal(f.host.children.has(f.views[0]), true); assert.equal(f.host.children.has(f.views[1]), true);
  assert.deepEqual(f.views[0].bounds, side);
  const before = f.views[0].bounds;
  assert.deepEqual(await f.action({ action: 'layout', bounds: { x: 2, y: 3, width: 900, height: 500 } }), { ok: true, stale: true });
  assert.deepEqual(f.views[0].bounds, before);
});

test('a new slot assignment wins over a legacy open awaiting slot cleanup', async () => {
  const f = fixture({}, true);
  await f.action({ action: 'open', site: 'community', slot: 'left', bounds });
  await f.action({ action: 'open', site: 'bilibili', slot: 'right', bounds });
  const staleOpen = f.action({ action: 'open', site: 'bilibili', bounds });
  const canceled = assert.rejects(staleOpen, /社区已隐藏/);
  const side = { x: 70, y: 80, width: 220, height: 600 };
  await f.action({ action: 'open', site: 'community', slot: 'side', bounds: side });
  await canceled;
  assert.equal(f.host.children.size, 2);
  assert.deepEqual(f.views[0].bounds, side);
});

test('later slot wins if the same site is assigned while exiting a legacy view', async () => {
  const f = fixture({}, true);
  await f.action({ action: 'open', site: 'bilibili', bounds });
  const first = f.action({ action: 'open', site: 'community', slot: 'left', bounds });
  const canceled = assert.rejects(first, /社区已隐藏/);
  const right = { x: 700, y: 80, width: 390, height: 650 };
  await f.action({ action: 'open', site: 'community', slot: 'right', bounds: right });
  await canceled;
  assert.equal(f.host.children.size, 1);
  assert.deepEqual(f.views[1].bounds, right);
  assert.deepEqual(await f.action({ action: 'hide', slot: 'left' }), { ok: true });
  assert.equal(f.host.children.has(f.views[1]), true);
});

test('only official Bilibili video URLs become clean public links', () => {
  assert.equal(bilibiliVideoShareUrl('https://m.bilibili.com/video/BV1WYnd6DEAw?p=2&token=secret&share_source=copy#fragment'), 'https://www.bilibili.com/video/BV1WYnd6DEAw?p=2');
  assert.equal(bilibiliVideoShareUrl('https://www.bilibili.com/video/av12345/?p=0&secret=x'), 'https://www.bilibili.com/video/av12345');
  for (const invalid of ['https://m.bilibili.com/', 'https://m.bilibili.com/video/BV1', 'https://m.bilibili.com/video/BV1WYnd6DEAw/extra', 'https://m.bilibili.com.evil.invalid/video/BV1WYnd6DEAw', 'https://u:p@m.bilibili.com/video/BV1WYnd6DEAw', 'http://m.bilibili.com/video/BV1WYnd6DEAw', 'https://m.bilibili.com:8443/video/BV1WYnd6DEAw', 'file:///video/BV1WYnd6DEAw']) assert.equal(bilibiliVideoShareUrl(invalid), null);
});

test('official player URLs are reconstructed from supported Bilibili video identities only', () => {
  const source = 'https://m.bilibili.com/video/BV1WYnd6DEAw?p=2&token=private#fragment';
  const player = 'https://player.bilibili.com/player.html?bvid=BV1WYnd6DEAw&p=2&autoplay=0';
  assert.equal(bilibiliOfficialPlayerUrl(source), player);
  assert.equal(bilibiliOfficialPlayerUrl('https://www.bilibili.com/video/BV1WYnd6DEAw?p=2'), player);
  assert.equal(bilibiliVideoShareUrl(player), 'https://www.bilibili.com/video/BV1WYnd6DEAw?p=2');
  assert.equal(classifyBilibiliNavigation(player).kind, 'internal');
  for (const url of ['https://m.bilibili.com/', 'https://m.bilibili.com/video/av123',
    'https://m.bilibili.com/video/BV1WYnd6DEAw?p=1&p=2', 'https://m.bilibili.com/video/BV1WYnd6DEAw?p=1001',
    'https://m.bilibili.com.evil.invalid/video/BV1WYnd6DEAw', 'https://u:p@m.bilibili.com/video/BV1WYnd6DEAw']) {
    assert.equal(bilibiliOfficialPlayerUrl(url), null);
  }
  for (const url of ['https://player.bilibili.com/player.html?bvid=BV1WYnd6DEAw&next=https://evil.invalid',
    'https://player.bilibili.com/player.html?bvid=BV1WYnd6DEAw&bvid=BV1BBnb6aEww',
    'https://player.bilibili.com/player.html?bvid=BV1WYnd6DEAw&p=1001',
    'https://player.bilibili.com/player.html?bvid=BV1WYnd6DEAw&autoplay=1',
    'https://player.bilibili.com/other?bvid=BV1WYnd6DEAw',
    'https://player.bilibili.com.evil.invalid/player.html?bvid=BV1WYnd6DEAw']) {
    assert.notEqual(classifyBilibiliNavigation(url).kind, 'internal');
    assert.equal(bilibiliVideoShareUrl(url), null);
  }
});

test('official playback is user initiated, stays in the same isolated view, copies identity, and returns to the video', async () => {
  const f = fixture({}, true);
  assert.throws(() => validateCommunityRequest({ action: 'play-official', url: 'https://evil.invalid' }));
  await f.action({ action: 'open', site: 'bilibili', bounds });
  const contents = f.views[0].webContents;
  assert.equal(f.states.at(-1).canPlayOfficial, false);
  await assert.rejects(f.action({ action: 'play-official' }), /请先打开/);
  await contents.loadURL('https://www.bilibili.com/video/BV1WYnd6DEAw?p=2&token=private');
  assert.equal(f.states.at(-1).canPlayOfficial, true);
  assert.deepEqual(await f.action({ action: 'play-official' }), { ok: true });
  assert.equal(contents.getURL(), 'https://player.bilibili.com/player.html?bvid=BV1WYnd6DEAw&p=2&autoplay=0');
  assert.equal(contents.userAgent, desktopUA);
  assert.equal(f.views.length, 1); assert.equal(f.host.children.size, 1);
  assert.equal(f.states.at(-1).isOfficialPlayer, true); assert.equal(f.states.at(-1).canPlayOfficial, false);
  assert.equal(f.states.at(-1).canShare, true);
  await f.action({ action: 'copy-video-link' });
  assert.deepEqual(f.copied, ['https://www.bilibili.com/video/BV1WYnd6DEAw?p=2']);
  await f.action({ action: 'back' });
  assert.match(contents.getURL(), /^https:\/\/www\.bilibili\.com\/video\/BV1WYnd6DEAw/);
  assert.equal(contents.userAgent, desktopUA);
  assert.equal(f.states.at(-1).canPlayOfficial, true);
  await f.action({ action: 'back' }); assert.equal(contents.getURL(), BILIBILI_URL);
  assert.equal(f.states.at(-1).canPlayOfficial, false);
  f.controller.dispose();
});

test('pending official player navigation is canceled when leaving, with no stale attachment', async () => {
  const f = fixture({}, true); await f.action({ action: 'open', site: 'bilibili', bounds });
  const contents = f.views[0].webContents;
  await contents.loadURL('https://m.bilibili.com/video/BV1WYnd6DEAw');
  const gate = deferred(); contents.behavior = () => gate.promise;
  const playing = f.action({ action: 'play-official' });
  const canceled = assert.rejects(playing, /已隐藏|离开|未能打开/);
  await tick(); await f.action({ action: 'open', site: 'community', bounds }); await canceled;
  assert.equal(contents.isDestroyed(), true);
  assert.equal(f.host.children.has(f.views[0]), false);
  const states = f.states.length; gate.resolve(); await tick(); assert.equal(f.states.length, states);
  f.controller.dispose();
});

test('asynchronous history back publishes loading instead of stale player state and prevents overlapping back clicks', async () => {
  const f = fixture({}, true); await f.action({ action: 'open', site: 'bilibili', bounds });
  const contents = f.views[0].webContents;
  await contents.loadURL('https://m.bilibili.com/video/BV1WYnd6DEAw');
  await f.action({ action: 'play-official' });
  const playerUrl = contents.url;
  let traversals = 0;
  contents.navigationHistory.goBack = () => { traversals++; }; // real Electron begins asynchronously
  await f.action({ action: 'back' });
  assert.equal(contents.url, playerUrl);
  assert.equal(f.states.at(-1).status, 'loading');
  assert.equal(f.states.at(-1).canGoBack, false);
  assert.equal(f.states.at(-1).canPlayOfficial, false);
  assert.equal(f.states.at(-1).canShare, false);
  await f.action({ action: 'back' }); assert.equal(traversals, 1);
  contents.url = 'https://m.bilibili.com/video/BV1WYnd6DEAw';
  contents.emit('did-start-navigation', {}, contents.url, false, true);
  contents.emit('did-navigate', {}, contents.url, 200, 'OK');
  contents.emit('did-finish-load');
  assert.equal(f.states.at(-1).status, 'ready');
  assert.equal(f.states.at(-1).canPlayOfficial, true);
  assert.equal(f.states.at(-1).canShare, true);
  assert.equal(f.host.children.has(f.views[0]), true);
  f.controller.dispose();
});

test('same-document history completion clears pending state and recomputes the page identity', async () => {
  const f = fixture({}, true); await f.action({ action: 'open', site: 'bilibili', bounds });
  const contents = f.views[0].webContents;
  await contents.loadURL('https://m.bilibili.com/video/BV1WYnd6DEAw');
  contents.navigationHistory.goBack = () => {};
  await f.action({ action: 'back' }); assert.equal(f.states.at(-1).status, 'loading');
  contents.url = BILIBILI_URL;
  contents.emit('did-navigate-in-page', {}, contents.url, true);
  assert.equal(f.states.at(-1).status, 'ready'); assert.equal(f.states.at(-1).canShare, false);
  assert.equal(f.states.at(-1).canPlayOfficial, false);
  f.controller.dispose();
});

test('copy uses the visible loaded Bilibili video, strips private parameters, and never accepts a supplied URL', async () => {
  const f = fixture({}, true);
  assert.throws(() => validateCommunityRequest({ action: 'copy-video-link', url: 'https://evil.invalid/' }));
  await f.action({ action: 'open', site: 'bilibili', bounds });
  assert.equal(f.states.at(-1).canShare, false);
  await assert.rejects(f.action({ action: 'copy-video-link' }), /请先打开/);
  const contents = f.views[0].webContents;
  await contents.loadURL('https://m.bilibili.com/video/BV1WYnd6DEAw?p=2&token=secret');
  assert.equal(f.states.at(-1).canShare, true);
  assert.deepEqual(await f.action({ action: 'copy-video-link' }), { ok: true });
  assert.deepEqual(f.copied, ['https://www.bilibili.com/video/BV1WYnd6DEAw?p=2']);
  await f.action({ action: 'hide' });
  await assert.rejects(f.action({ action: 'copy-video-link' }), /请先打开/);
  await f.action({ action: 'open', site: 'community', bounds });
  await assert.rejects(f.action({ action: 'copy-video-link' }), /请先打开/);
  assert.equal(f.copied.length, 1);
  f.controller.dispose();
});

test('copy is disabled during navigation, and clipboard errors have a fixed safe message', async () => {
  const f = fixture({}, true); await f.action({ action: 'open', site: 'bilibili', bounds });
  const contents = f.views[0].webContents;
  await contents.loadURL('https://m.bilibili.com/video/BV1WYnd6DEAw');
  const gate = deferred(); contents.behavior = () => gate.promise;
  const pending = contents.loadURL('https://m.bilibili.com/video/BV1BBnb6aEww');
  assert.equal(f.states.at(-1).canShare, false);
  await assert.rejects(f.action({ action: 'copy-video-link' }), /请先打开/);
  gate.resolve(); await pending;
  assert.equal(f.states.at(-1).canShare, true);
  f.failCopy(); await assert.rejects(f.action({ action: 'copy-video-link' }), /^Error: 复制链接失败，请重试$/);
  assert.deepEqual(f.copied, []);
  f.controller.dispose();
});

test('in-page navigation recalculates the available share action using the current page', async () => {
  const f = fixture({}, true); await f.action({ action: 'open', site: 'bilibili', bounds });
  const contents = f.views[0].webContents;
  contents.url = 'https://m.bilibili.com/video/BV1WYnd6DEAw?p=3&token=private';
  contents.emit('did-navigate-in-page', {}, contents.url, true);
  assert.equal(f.states.at(-1).canShare, true);
  await f.action({ action: 'copy-video-link' });
  assert.deepEqual(f.copied, ['https://www.bilibili.com/video/BV1WYnd6DEAw?p=3']);
  contents.url = 'https://m.bilibili.com/search?token=private';
  contents.emit('did-navigate-in-page', {}, contents.url, true);
  assert.equal(f.states.at(-1).canShare, false);
  await assert.rejects(f.action({ action: 'copy-video-link' }), /请先打开/);
  assert.equal(f.copied.length, 1);
  f.controller.dispose();
});

test('native feed is an isolated child WebContentsView with no BrowserWindow or focus', async () => {
  const f = fixture();
  assert.equal(DEFAULT_COMMUNITY_URL, 'https://community.project-neko.cn/feed');
  assert.equal(resolveCommunityUrl(''), DEFAULT_COMMUNITY_URL);
  assert.deepEqual(await f.open(), { ok: true });
  assert.equal(f.views.length, 1); secure(f.views[0].options);
  assert.deepEqual(f.views[0].webContents.loads, [DEFAULT_COMMUNITY_URL]);
  assert.deepEqual(f.views[0].bounds, bounds);
  assert.equal(f.host.children.has(f.views[0]), true);
  assert.deepEqual(f.states.map(value => value.status), ['loading', 'ready']);
  f.controller.dispose();
});

test('Bilibili is an isolated desktop view with page history and preserved community', async () => {
  const f = fixture({}, true); await f.open(); const community = f.views[0];
  community.webContents.scrollFixture = 240;
  await f.action({ action: 'open', site: 'bilibili', bounds });
  assert.equal(f.views.length, 2); const bili = f.views[1];
  assert.equal(f.host.children.size, 1); assert.equal(f.host.children.has(bili), true);
  assert.equal(community.webContents.isDestroyed(), false);
  assert.equal(bili.options.webPreferences.partition, BILIBILI_PARTITION);
  assert.notEqual(BILIBILI_PARTITION, COMMUNITY_PARTITION);
  assert.equal(bili.options.webPreferences.sandbox, true);
  assert.equal(bili.options.webPreferences.contextIsolation, true);
  assert.equal(bili.options.webPreferences.nodeIntegration, false);
  assert.equal('preload' in bili.options.webPreferences, false);
  assert.equal(BILIBILI_URL, 'https://www.bilibili.com/');
  assert.equal(bili.webContents.userAgent, desktopUA);
  assert.equal(community.webContents.userAgent, undefined, 'Bilibili UA is restricted to the isolated Bilibili view');
  assert.deepEqual(bili.webContents.loads, [BILIBILI_URL]);
  assert.equal(f.states.at(-1).site, 'bilibili'); assert.equal(f.states.at(-1).canGoBack, false);
  assert.equal(bili.webContents.popup({ url: 'https://www.bilibili.com/video/BV1fixture' }).action, 'deny');
  await tick();
  assert.equal(bili.webContents.loads.at(-1), 'https://www.bilibili.com/video/BV1fixture');
  assert.equal(bili.webContents.userAgent, desktopUA);
  assert.equal(f.states.at(-1).canGoBack, true);
  await f.action({ action: 'back' }); assert.equal(bili.webContents.getURL(), BILIBILI_URL);
  assert.equal(f.states.at(-1).canGoBack, false);
  await f.action({ action: 'open', site: 'community', bounds });
  assert.equal(f.host.children.size, 1); assert.equal(f.host.children.has(community), true);
  assert.equal(community.webContents.scrollFixture, 240); assert.equal(community.webContents.loads.length, 1);
  await f.action({ action: 'open', site: 'bilibili', bounds });
  assert.equal(f.views.length, 2); assert.equal(f.host.children.has(bili), true);
  await f.action({ action: 'hide' }); assert.equal(f.host.children.size, 0); f.controller.dispose();
});

test('Bilibili navigation allows only explicit official HTTPS origins and never creates another window', async () => {
  const f = fixture({}, true); await f.action({ action: 'open', site: 'bilibili', bounds }); const contents = f.views[0].webContents;
  for (const url of ['https://m.bilibili.com/video/BV1test', 'https://www.bilibili.com/', 'https://www.bilibili.com/video/BV1WYnd6DEAw', 'https://passport.bilibili.com/login']) {
    assert.equal(classifyBilibiliNavigation(url).kind, 'internal');
    assert.equal(navigate(contents, 'will-navigate', url), false);
    assert.equal(contents.userAgent, desktopUA, 'all Bilibili navigation keeps the same desktop UA');
    assert.equal(contents.popup({ url }).action, 'deny');
  }
  for (const url of ['https://bilibili.com.evil.invalid/', 'https://m.bilibili.com:8443/', 'file:///tmp/test', 'javascript:alert(1)', 'https://user@bilibili.com/']) {
    assert.notEqual(classifyBilibiliNavigation(url).kind, 'internal');
    assert.equal(navigate(contents, 'will-navigate', url), true);
  }
  assert.throws(() => validateCommunityRequest({ action: 'open', site: 'https://evil.invalid', bounds }));
  assert.throws(() => validateCommunityRequest({ action: 'back', site: 'bilibili' }));
  f.controller.dispose();
});

test('Bilibili desktop UA fallback remains desktop when Chromium UA cannot be parsed', async () => {
  const f = fixture({}, true, { rawUserAgent: 'unparseable' });
  await f.action({ action: 'open', site: 'bilibili', bounds });
  assert.equal(f.views[0].webContents.userAgent, BILIBILI_DESKTOP_USER_AGENT);
  assert(!BILIBILI_DESKTOP_USER_AGENT.includes('Mobile'));
  assert(!BILIBILI_DESKTOP_USER_AGENT.includes('Electron'));
  f.controller.dispose();
});

test('the rail home action returns an existing B站 video view to the official homepage', async () => {
  const f = fixture({}, true);
  await f.action({ action: 'open', site: 'bilibili', bounds });
  const content = f.views[0].webContents;
  await content.loadURL('https://m.bilibili.com/video/BV1234567890');
  await f.action({ action: 'open', site: 'bilibili', bounds, home: true });
  assert.equal(content.getURL(), BILIBILI_HOME_URL);
  assert.equal(f.views.length, 1, 'the home action reuses the existing isolated view');
  assert(!content.getUserAgent().includes('Mobile'));
  assert(!content.getUserAgent().includes('Electron'));
  assert.throws(() => validateCommunityRequest({ action: 'open', site: 'community', bounds, home: true }));
  assert.throws(() => validateCommunityRequest({ action: 'reload', home: true }));
  assert.throws(() => validateCommunityRequest({ action: 'open', site: 'bilibili', bounds, home: 'https://evil.invalid' }));
  f.controller.dispose();
});

test('switching sites while the previous site loads cancels the old view without stale attachments', async () => {
  const f = fixture({}, true); const gate = deferred();
  const opening = f.action({ action: 'open', site: 'community', bounds });
  const canceled = assert.rejects(opening, /已隐藏|离开/);
  const old = f.views[0]; old.webContents.behavior = () => gate.promise; await tick();
  await f.action({ action: 'open', site: 'bilibili', bounds }); await canceled;
  assert.equal(old.webContents.isDestroyed(), true);
  assert.equal(f.host.children.size, 1); assert.equal(f.host.children.has(f.views[1]), true);
  const count = f.states.length; gate.resolve(); await tick();
  assert.equal(f.states.length, count); assert.equal(f.states.at(-1).site, 'bilibili');
  f.controller.dispose();
});

test('same-site reopen labels events and rejects stale hides while host hide remains authoritative', async () => {
  const f = fixture({}, true);
  await f.action({ action: 'open', site: 'bilibili', requestId: 1, bounds });
  assert.equal(f.states.at(-1).requestId, 1);
  await f.action({ action: 'hide', requestId: 1 });
  const oldHidden = f.states.at(-1);
  assert.equal(oldHidden.status, 'hidden'); assert.equal(oldHidden.requestId, 1);
  await f.action({ action: 'open', site: 'bilibili', requestId: 2, bounds });
  assert.equal(f.states.at(-1).requestId, 2);
  const count = f.states.length;
  assert.deepEqual(await f.action({ action: 'hide', requestId: 1 }), { ok: true, stale: true });
  assert.equal(f.states.length, count);
  assert.equal(f.host.children.has(f.views[0]), true);
  await f.action({ action: 'hide' }); // fish/settings and other native callers
  assert.equal(f.host.children.size, 0);
  assert.equal(f.states.at(-1).status, 'hidden'); assert.equal(f.states.at(-1).requestId, 2);
  f.controller.dispose();
});

test('stale hide cannot cancel a newer site open and request IDs are narrowly validated', async () => {
  const f = fixture({}, true);
  await f.action({ action: 'open', site: 'community', requestId: 1, bounds });
  const newer = f.action({ action: 'open', site: 'bilibili', requestId: 2, bounds });
  assert.deepEqual(await f.action({ action: 'hide', requestId: 1 }), { ok: true, stale: true });
  assert.deepEqual(await newer, { ok: true });
  assert.equal(f.host.children.size, 1); assert.equal(f.states.at(-1).requestId, 2);
  for (const requestId of [0, -1, 1.2, Number.MAX_SAFE_INTEGER + 1, '2', null]) {
    assert.throws(() => validateCommunityRequest({ action: 'open', requestId, bounds }));
  }
  assert.throws(() => validateCommunityRequest({ action: 'copy-video-link', requestId: 2 }));
  f.controller.dispose();
});

test('concurrent opens and hide/reopen reuse the page, session and scroll without reloading', async () => {
  const f = fixture({ NEKO_WORKBENCH_COMMUNITY_URL: 'https://community.example.org/topics?sort=latest#news' });
  await Promise.all([f.open(), f.open()]);
  const view = f.views[0]; view.webContents.scrollFixture = 240;
  await f.action({ action: 'hide' }); assert.equal(f.host.children.size, 0);
  assert.equal(view.webContents.isDestroyed(), false);
  await f.open();
  assert.equal(f.views.length, 1); assert.equal(view.webContents.loads.length, 1);
  assert.equal(view.webContents.scrollFixture, 240); assert.equal(f.host.children.has(view), true);
  f.controller.dispose(); assert.equal(f.controller.view, null);
  assert.deepEqual(view.webContents.closed, [{ waitForBeforeUnload: false }]);
  await f.open(); assert.equal(f.views.length, 2); f.controller.dispose();
});

test('bounds accept only finite CSS pixels, scale by host zoom and clamp the view to content DIP', async () => {
  const f = fixture(); f.host.scale = 1.25;
  assert.deepEqual(communityBounds(f.host, { x: -5, y: 40, width: 1000, height: 900 }), { x: 0, y: 50, width: 1100, height: 730 });
  await f.open(); assert.deepEqual(f.views[0].bounds, { x: 375, y: 100, width: 725, height: 680 });
  f.host.size = [700, 500]; f.host.emit('resize');
  assert.deepEqual(f.views[0].bounds, { x: 375, y: 100, width: 325, height: 400 });
  await f.action({ action: 'layout', bounds: { x: 100, y: 60, width: 400, height: 300 } });
  assert.deepEqual(f.views[0].bounds, { x: 125, y: 75, width: 500, height: 375 });
  f.host.scale = 1; f.host.emit('zoom-changed'); f.host.webContents.emit('zoom-changed');
  assert.deepEqual(f.views[0].bounds, { x: 100, y: 60, width: 400, height: 300 });
  await f.action({ action: 'layout', bounds: { x: 900, y: 60, width: 400, height: 300 } }); assert.equal(f.host.children.size, 0);
  const invalid = [undefined, { action: 'open' }, { action: 'layout', bounds: { ...bounds, width: 0 } },
    { action: 'open', bounds: { ...bounds, x: NaN } }, { action: 'open', bounds: { ...bounds, width: Infinity } },
    { action: 'open', bounds: { ...bounds, url: DEFAULT_COMMUNITY_URL } }, { action: 'hide', url: DEFAULT_COMMUNITY_URL },
    { action: 'navigate', bounds }, { action: 'open', bounds: { ...bounds, x: 10000000 } }];
  for (const request of invalid) assert.throws(() => validateCommunityRequest(request));
  await assert.rejects(f.open({ x: 1000, y: 10, width: 10, height: 10 }), /布局/);
  f.controller.dispose();
});

test('credentials, unsafe protocols and malformed configured URLs fail before creating a view', async () => {
  for (const value of ['http://community.example.org', 'javascript:alert(1)', 'file:///private-fixture',
    'https://user:password@community.example.org', 'https://user@community.example.org',
    'https://community.example.org/?access_token=fixture-only', 'https://community.example.org/#api_key=fixture-only',
    'https://community.example.org/\nnew-path', '//community.example.org', 'not a URL']) {
    assert.throws(() => resolveCommunityUrl(value), /HTTPS/);
    const f = fixture({ NEKO_WORKBENCH_COMMUNITY_URL: value });
    await assert.rejects(f.open(), /HTTPS/); assert.equal(f.views.length, 0); assert.deepEqual(f.external, []); f.controller.dispose();
  }
});

test('community/auth origins stay internal; external navigation and redirects use the system browser', async () => {
  const f = fixture(); await f.open(); const contents = f.views[0].webContents;
  for (const type of ['will-navigate', 'will-redirect']) {
    assert.equal(navigate(contents, type, 'https://community.project-neko.cn/topics/1'), false);
    assert.equal(navigate(contents, type, 'https://auth.project-neko.cn/login'), false);
    assert.equal(navigate(contents, type, 'https://community.project-neko.cn.evil.invalid/'), true);
    assert.equal(navigate(contents, type, 'http://external.example.org/page'), true);
    for (const value of ['javascript:alert(1)', 'file:///private-fixture', 'data:text/html,fixture', 'https://user:password@example.org']) assert.equal(navigate(contents, type, value), true);
  }
  await tick(); assert.deepEqual(f.external, ['https://community.project-neko.cn.evil.invalid/', 'http://external.example.org/page', 'https://community.project-neko.cn.evil.invalid/', 'http://external.example.org/page']);
  assert.equal(classifyCommunityNavigation('https://auth.project-neko.cn:8443/login').kind, 'external'); f.controller.dispose();
});

test('only auth may popup; community blank links stay embedded, auth popups share isolated session and close with host', async () => {
  const f = fixture(); await f.open(); const contents = f.views[0].webContents;
  assert.equal(contents.popup({ url: 'https://community.project-neko.cn/topics/1' }).action, 'deny'); await tick();
  assert.equal(contents.loads.at(-1), 'https://community.project-neko.cn/topics/1');
  const allowed = contents.popup({ url: 'https://auth.project-neko.cn/login' }); assert.equal(allowed.action, 'allow');
  assert.equal(allowed.overrideBrowserWindowOptions.parent, f.host); secure(allowed.overrideBrowserWindowOptions);
  const popup = new f.Popup(allowed.overrideBrowserWindowOptions); contents.emit('did-create-window', popup);
  assert.equal(navigate(popup.webContents, 'will-redirect', 'https://external.example.org/'), true);
  for (const url of ['file:///private-fixture', 'javascript:alert(1)', 'https://external.example.org/']) assert.equal(contents.popup({ url }).action, 'deny');
  await tick(); assert.equal(f.external.length, 2);
  f.controller.dispose(); assert.equal(popup.destroyed, true);
  assert.equal(contents.isDestroyed(), true);
});

test('network and HTTP failures detach content and report failure rather than accepting loadURL resolution', async () => {
  const f = fixture(); const first = f.open(); const contents = f.views[0].webContents;
  contents.behavior = async () => { throw Error('network fixture only'); };
  await assert.rejects(first, /未能打开/); assert.equal(f.host.children.size, 0); assert.equal(f.states.at(-1).status, 'error');
  contents.behavior = null; contents.responseCode = 503;
  await assert.rejects(f.action({ action: 'reload' }), /未能打开/); assert.equal(f.host.children.size, 0);
  contents.responseCode = 200; assert.deepEqual(await f.action({ action: 'reload' }), { ok: true }); assert.equal(f.host.children.size, 1);
  contents.emit('did-start-navigation', {}, DEFAULT_COMMUNITY_URL, false, true);
  contents.emit('did-navigate', {}, DEFAULT_COMMUNITY_URL, 404, 'not found'); contents.emit('did-finish-load');
  assert.equal(f.host.children.size, 0); assert.equal(f.states.at(-1).status, 'error');
  await f.action({ action: 'reload' }); assert.equal(f.host.children.size, 1);
  contents.emit('did-fail-load', {}, -105, 'fixture dns', DEFAULT_COMMUNITY_URL, true); contents.emit('did-finish-load');
  assert.equal(f.host.children.size, 0); assert.equal(f.states.at(-1).error.includes('fixture'), false); f.controller.dispose();
});

test('hide cancels a pending native call immediately; new open never waits on the old view or ERR_ABORTED', async () => {
  const f = fixture(); const gate = deferred(); const first = f.open(); const contents = f.views[0].webContents;
  const canceled = assert.rejects(first, /已隐藏/);
  contents.behavior = () => gate.promise; await tick(); const stateCount = f.states.length;
  await f.action({ action: 'hide' }); await canceled;
  assert.equal(contents.isDestroyed(), true); assert.equal(f.host.children.size, 0);
  assert.equal(f.states.length, stateCount + 1);
  assert.equal(f.states.at(-1).status, 'hidden');
  await f.open(); assert.equal(f.views.length, 2); assert.equal(f.host.children.has(f.views[1]), true);
  const readyCount = f.states.length;
  gate.reject(Error('ERR_ABORTED from retired navigation')); await tick();
  assert.equal(f.states.length, readyCount); assert.equal(f.states.at(-1).status, 'ready');
  assert.equal(f.host.children.has(f.views[1]), true); f.controller.dispose();
});

test('open and reload focus only the child view of an already focused host; layout never changes focus', async () => {
  const f = fixture(); await f.open(); const contents = f.views[0].webContents;
  assert.equal(contents.focused || 0, 0);
  f.host.focused = true; await f.open(); assert.equal(contents.focused, 1);
  await f.action({ action: 'reload' }); assert.equal(contents.focused, 2);
  await f.action({ action: 'layout', bounds }); assert.equal(contents.focused, 2);
  f.host.focused = false; await f.action({ action: 'reload' }); assert.equal(contents.focused, 2);
  f.controller.dispose();
});

test('host and explicit hide notify hidden; loaded explicit hide keeps the view', async () => {
  const f = fixture(); await f.open(); const contents = f.views[0].webContents;
  const stateCount = f.states.length;
  await f.action({ action: 'hide' }); assert.equal(f.states.length, stateCount + 1);
  assert.equal(f.states.at(-1).status, 'hidden');
  await f.action({ action: 'hide' }); assert.equal(f.states.length, stateCount + 1);
  assert.equal(contents.isDestroyed(), false); await f.open(); assert.equal(f.views.length, 1);
  f.host.emit('close'); assert.equal(f.states.at(-1).status, 'hidden');
  assert.equal(contents.isDestroyed(), true); assert.equal(f.controller.view, null);
  await f.open(); assert.equal(f.views.length, 2); assert.equal(f.host.children.has(f.views[1]), true); f.controller.dispose();
});

test('host navigation/reload/close/render destruction disposes child webContents and fences late loads', async () => {
  for (const event of ['will-navigate', 'did-start-navigation', 'close', 'render-process-gone', 'destroyed']) {
    const f = fixture(); const gate = deferred(); const first = f.open(); const contents = f.views[0].webContents;
    contents.behavior = () => gate.promise; await tick();
    if (event === 'close') f.host.emit('close');
    else if (event === 'did-start-navigation') f.host.webContents.emit(event, {}, 'http://127.0.0.1:59000/', false, true);
    else f.host.webContents.emit(event, {}, 'http://127.0.0.1:59000/');
    assert.equal(contents.isDestroyed(), true); assert.equal(f.states.at(-1).status, 'hidden');
    gate.resolve(); await assert.rejects(first, /已隐藏|离开/);
    assert.equal(f.host.children.size, 0); assert.equal(f.controller.view, null); f.controller.dispose();
  }
});

test('concurrent refreshes coalesce and neither may attach or publish stale state after hide', async () => {
  const f = fixture(); await f.open(); const contents = f.views[0].webContents;
  const gate = deferred(); let requests = 0;
  contents.behavior = () => { requests++; return gate.promise; };
  const first = f.action({ action: 'reload' }); await tick(); const second = f.action({ action: 'reload' }); await tick();
  assert.equal(requests, 1); assert.equal(f.host.children.size, 0);
  const rejected = [assert.rejects(first, /已隐藏/), assert.rejects(second, /已隐藏/)];
  const stateCount = f.states.length;
  await f.action({ action: 'hide' }); await Promise.all(rejected); gate.resolve(); await tick();
  assert.equal(f.host.children.size, 0); assert.equal(f.states.length, stateCount + 1);
  assert.equal(f.states.at(-1).status, 'hidden'); f.controller.dispose();
});

test('repeated refresh clicks share one navigation and all return the real successful outcome', async () => {
  const f = fixture(); await f.open(); const contents = f.views[0].webContents;
  const gate = deferred(); let requests = 0;
  contents.behavior = () => { requests++; return gate.promise; };
  const first = f.action({ action: 'reload' }); await tick(); const second = f.action({ action: 'reload' }); await tick();
  gate.resolve(); assert.deepEqual(await first, { ok: true }); assert.deepEqual(await second, { ok: true });
  assert.equal(requests, 1); assert.equal(f.host.children.size, 1); f.controller.dispose();
});

test('failure from a canceled hidden view cannot publish an error or reattach content', async () => {
  const f = fixture(); const gate = deferred(); const first = f.open(); const contents = f.views[0].webContents;
  const canceled = assert.rejects(first, /已隐藏/);
  contents.behavior = () => gate.promise; await tick(); const stateCount = f.states.length;
  await f.action({ action: 'hide' }); await canceled;
  gate.reject(Error('fixture failure')); await tick();
  assert.equal(f.states.length, stateCount + 1); assert.equal(f.states.at(-1).status, 'hidden');
  assert.equal(f.host.children.size, 0); f.controller.dispose();
});
