'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createCommunityAccount, authorizationUrl, validateAccountAction } = require('../../apps/neko-workbench/community-account.cjs');
const BASE = 'http://127.0.0.1:48911';
const FEED = 'https://community.project-neko.cn/feed';
const STATE = 's'.repeat(43), TICKET = 't'.repeat(43), DELEGATE = 'd'.repeat(43);
const tick = () => new Promise(resolve => setImmediate(resolve));
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
function startPayload() {
  return { state: STATE, expires_in: 600, auth_url: 'https://auth.project-neko.cn/oauth2/auth?' + new URLSearchParams({
    client_id: 'neko-servers-desktop-prod', redirect_uri: BASE + '/oauth/callback', state: STATE,
    response_type: 'code', scope: 'openid email profile offline', code_challenge_method: 'S256', code_challenge: 'c'.repeat(43),
  }) };
}
function fixture(overrides = {}) {
  const calls = [], opened = [], handoffs = [], states = [];
  let base = BASE, feed = FEED, clock = 0;
  const replies = {
    '/api/card-drop/oauth/status': () => json({ logged_in: true, community_base_url: 'https://community.project-neko.cn',
      user: { email: 'fixture@example.invalid' }, session_paths: ['/private/fixture'], access_token: 'must-stay-private' }),
    '/api/card-drop/oauth/start': () => json(startPayload()),
    ['/api/card-drop/oauth/completion?state=' + STATE]: () => json({ logged_in: true }),
    '/api/card-drop/native-delegate': () => json({ native_delegate: DELEGATE, expires_in: 600 }),
    '/api/card-drop/sync-ticket': () => json({ sync_ticket: TICKET, expires_in: 60 }),
    '/api/system/client-id': () => json({ client_id: 'fixture-client-id' }),
  };
  const account = createCommunityAccount({ getBaseUrl: () => base, getCommunityUrl: () => feed,
    fetchImpl: async (url, options) => { calls.push({ url, options }); return replies[new URL(url).pathname + new URL(url).search]?.(options) || json({}, 404); },
    openExternal: async url => opened.push(url), handoff: async url => handoffs.push(url), onState: state => states.push(state),
    now: () => clock, sleep: async ms => { clock += ms; }, ...overrides });
  return { account, calls, replies, opened, handoffs, states, setBase(value) { base = value; }, setFeed(value) { feed = value; } };
}

test('desktop handoff is opt-in and sends only one-time/scoped proofs to the official feed', async () => {
  const f = fixture();
  assert.equal(f.calls.length, 0);
  assert.equal((await f.account.action('connect')).status, 'handed-off');
  assert.equal(f.opened.length, 0, 'an existing desktop login needs no new authorization');
  assert.equal(f.handoffs.length, 1);
  const url = new URL(f.handoffs[0]), proof = new URLSearchParams(url.hash.slice(1));
  assert.equal(url.origin + url.pathname, FEED);
  assert.equal(url.searchParams.get('neko_source_origin'), BASE);
  assert.equal(url.searchParams.get('cid'), 'fixture-client-id');
  assert.equal(proof.get('native_sync'), TICKET); assert.equal(proof.get('native_delegate'), DELEGATE);
  assert(!url.search.includes(TICKET)); assert(!url.search.includes(DELEGATE));
  for (const call of f.calls) {
    assert.equal(new URL(call.url).origin, BASE);
    assert.equal(call.options.redirect, 'error'); assert.equal(call.options.cache, 'no-store');
    assert.deepEqual(call.options.headers, { Accept: 'application/json', Origin: BASE, 'Sec-Fetch-Site': 'same-origin' });
  }
  const ipc = JSON.stringify([f.account.state, f.states]);
  for (const secret of [TICKET, DELEGATE, 'must-stay-private', 'fixture@example.invalid', '/private/fixture']) assert(!ipc.includes(secret));
  assert.match(f.account.state.message, /绑定结果.*社区内确认/, 'page loading must not claim verified client binding');
});

test('signed-out desktop uses official PKCE and waits for this exact attempt completion', async () => {
  const f = fixture(); let polls = 0;
  f.replies['/api/card-drop/oauth/status'] = () => json({ logged_in: false, session_saved: false });
  f.replies['/api/card-drop/oauth/completion?state=' + STATE] = () => json({ logged_in: ++polls === 3 });
  const first = f.account.action('connect'), second = f.account.action('connect');
  assert.equal(first, second, 'double clicks share one flow');
  assert.equal((await first).status, 'handed-off');
  assert.equal(f.opened.length, 1); assert.equal(polls, 3);
  assert.equal(f.calls.filter(call => call.url.endsWith('/oauth/start')).length, 1);
  assert.equal(f.calls.find(call => call.url.endsWith('/oauth/start')).options.method, 'POST');
  assert.equal(f.calls.filter(call => call.url.endsWith('/oauth/status')).length, 1, 'global login status cannot complete a different attempt');
  assert.equal(new URL(f.opened[0]).origin, 'https://auth.project-neko.cn');
});

test('read-only status exposes readiness without starting OAuth, handing off, or copying account details', async () => {
  const f = fixture();
  assert.equal((await f.account.action('status')).status, 'available');
  assert.equal(f.handoffs.length, 0); assert.equal(f.opened.length, 0); assert.equal(f.calls.length, 1);
  f.replies['/api/card-drop/oauth/status'] = () => json({ logged_in: false });
  assert.equal((await f.account.action('status')).status, 'signed-out');
  for (const value of [{ action: 'connect' }, 'logout', 'https://evil.invalid', null]) assert.throws(() => validateAccountAction(value), /未知/);
});

test('temporary offline validation preserves saved login and does not launch another authorization', async () => {
  const f = fixture();
  f.replies['/api/card-drop/oauth/status'] = () => json({ logged_in: false, session_saved: true });
  const state = await f.account.action('connect');
  assert.equal(state.status, 'error'); assert.match(state.message, /暂时无法验证/);
  assert.equal(f.calls.length, 1); assert.equal(f.opened.length, 0);
});

test('non-loopback backends and non-official/custom community destinations cannot receive native identity', async () => {
  for (const base of ['https://127.0.0.1:48911', 'http://192.0.2.1:48911', 'http://127.0.0.1:48911/private', 'http://user:pass@localhost:48911']) {
    const f = fixture(); f.setBase(base);
    assert.equal((await f.account.action('connect')).status, 'error'); assert.equal(f.calls.length, 0);
  }
  for (const feed of ['https://evil.invalid/feed', 'https://community.project-neko.cn:8443/feed', 'https://community.project-neko.cn/feed#native_sync=old', 'https://community.project-neko.cn/cards']) {
    const f = fixture(); f.setFeed(feed);
    assert.equal((await f.account.action('connect')).status, 'error'); assert.equal(f.calls.length, 0);
  }
  const f = fixture(); f.replies['/api/card-drop/oauth/status'] = () => json({ logged_in: true, community_base_url: 'https://other.invalid' });
  assert.equal((await f.account.action('connect')).status, 'error'); assert.equal(f.handoffs.length, 0);
});

test('authorization destination, client, callback, scope, state and PKCE are validated before opening a browser', () => {
  const payload = startPayload();
  assert.equal(authorizationUrl(payload, BASE), payload.auth_url);
  assert.equal(authorizationUrl(payload, 'http://localhost:48911'), payload.auth_url, 'official server always returns a 127.0.0.1 callback');
  for (const [key, value] of [['client_id', 'unrelated-client'], ['redirect_uri', 'https://evil.invalid/callback'], ['state', 'other'],
    ['scope', 'openid email profile offline admin'], ['code_challenge_method', 'plain'], ['code_challenge', 'short'], ['response_type', 'token']]) {
    const url = new URL(payload.auth_url); url.searchParams.set(key, value);
    assert.throws(() => authorizationUrl({ ...payload, auth_url: url.href }, BASE), /响应不匹配/);
  }
  for (const value of ['https://evil.invalid/oauth2/auth', 'https://auth.project-neko.cn.evil.invalid/oauth2/auth', 'javascript:alert(1)']) {
    assert.throws(() => authorizationUrl({ ...payload, auth_url: value }, BASE), /响应不匹配/);
  }
  assert.throws(() => authorizationUrl({ ...payload, relay_origin: 'https://evil.invalid' }, BASE), /响应不匹配/);
  assert.throws(() => authorizationUrl({ ...payload, auth_url: payload.auth_url + '&state=extra' }, BASE), /响应不匹配/);
  assert.throws(() => authorizationUrl({ ...payload, auth_url: payload.auth_url + '&access_token=private' }, BASE), /响应不匹配/);
});

test('cancel and config changes fence late results without completing or navigating a hidden community', async () => {
  for (const change of ['cancel', 'base', 'feed']) {
    const f = fixture(); let finish;
    f.replies['/api/card-drop/native-delegate'] = () => new Promise(resolve => { finish = resolve; });
    const pending = f.account.action('connect'); await tick();
    if (change === 'cancel') await f.account.action('cancel');
    else if (change === 'base') f.setBase('http://127.0.0.1:48912');
    else f.setFeed('https://other.invalid/feed');
    finish(json({ native_delegate: DELEGATE }));
    assert.notEqual((await pending).status, 'handed-off'); assert.equal(f.handoffs.length, 0);
    assert.equal(f.calls.length, 2);
    assert(!f.states.some(state => state.status === 'handed-off'));
  }
});

test('cancel during authorization and expiration stop polling and never reuse old login success', async () => {
  const f = fixture(); let cancelSleep;
  f.replies['/api/card-drop/oauth/status'] = () => json({ logged_in: false });
  f.replies['/api/card-drop/oauth/completion?state=' + STATE] = () => json({ logged_in: false });
  const waiting = fixture({ sleep: () => new Promise(resolve => { cancelSleep = resolve; }) });
  waiting.replies['/api/card-drop/oauth/status'] = f.replies['/api/card-drop/oauth/status'];
  waiting.replies['/api/card-drop/oauth/completion?state=' + STATE] = f.replies['/api/card-drop/oauth/completion?state=' + STATE];
  const pending = waiting.account.action('connect'); await tick();
  assert.equal(waiting.account.state.status, 'authorizing');
  await waiting.account.action('cancel'); cancelSleep(); await pending;
  assert.equal(waiting.handoffs.length, 0); assert.equal(waiting.account.state.status, 'idle');
  f.replies['/api/card-drop/oauth/start'] = () => json({ ...startPayload(), expires_in: 0.001 });
  const result = await f.account.action('connect');
  assert.equal(result.status, 'error'); assert.match(result.message, /等待已结束/); assert.equal(f.handoffs.length, 0);
});

test('unavailable/old/malformed servers produce safe retryable errors and never forward raw diagnostics', async () => {
  for (const reply of [() => { throw new Error('private-fixture-token'); }, () => json({ detail: 'private-fixture-token' }, 503),
    () => new Response('<html>private-fixture-token</html>'), () => json({}), () => json({ logged_in: 'yes' }),
    () => new Response('x'.repeat(65537)), () => json({}, 404)]) {
    const f = fixture(); f.replies['/api/card-drop/oauth/status'] = reply;
    const result = await f.account.action('connect');
    assert.equal(result.status, 'error'); assert(!JSON.stringify([result, f.states]).includes('private-fixture-token'));
    assert.equal(f.opened.length, 0); assert.equal(f.handoffs.length, 0);
    f.replies['/api/card-drop/oauth/status'] = () => json({ logged_in: true });
    assert.equal((await f.account.action('connect')).status, 'handed-off', 'a failure does not block retry');
  }
  for (const field of ['native_delegate', 'sync_ticket']) {
    const f = fixture(), route = field === 'native_delegate' ? '/api/card-drop/native-delegate' : '/api/card-drop/sync-ticket';
    f.replies[route] = () => json({ [field]: 'bad#proof' });
    assert.equal((await f.account.action('connect')).status, 'error'); assert.equal(f.handoffs.length, 0);
  }
});

test('production HTTP transport follows the local OAuth/completion/proof contract without forwarding redirects', async t => {
  const http = require('node:http');
  let base, loggedIn = false; const requests = [], transfers = [];
  const server = http.createServer((req, res) => {
    requests.push({ path: req.url, method: req.method, origin: req.headers.origin, site: req.headers['sec-fetch-site'] });
    res.setHeader('Content-Type', 'application/json');
    if (req.headers.origin !== base || req.headers['sec-fetch-site'] !== 'same-origin') { res.statusCode = 403; res.end('{}'); return; }
    const start = startPayload(), url = new URL(start.auth_url); url.searchParams.set('redirect_uri', base + '/oauth/callback'); start.auth_url = url.href;
    const result = {
      '/api/card-drop/oauth/status': { logged_in: loggedIn }, '/api/card-drop/oauth/start': start,
      ['/api/card-drop/oauth/completion?state=' + STATE]: { logged_in: loggedIn },
      '/api/card-drop/native-delegate': { native_delegate: DELEGATE }, '/api/card-drop/sync-ticket': { sync_ticket: TICKET },
      '/api/system/client-id': { client_id: 'local-http-fixture' },
    }[req.url];
    res.end(JSON.stringify(result || {}));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  base = 'http://127.0.0.1:' + server.address().port;
  const account = createCommunityAccount({ getBaseUrl: () => base, getCommunityUrl: () => FEED,
    openExternal: async url => { assert.equal(new URL(url).searchParams.get('redirect_uri'), base + '/oauth/callback'); loggedIn = true; },
    handoff: async url => transfers.push(url) });
  assert.equal((await account.action('connect')).status, 'handed-off');
  assert.equal(requests.find(item => item.path === '/api/card-drop/oauth/start').method, 'POST');
  assert.equal(transfers.length, 1);
  server.removeAllListeners('request');
  server.on('request', (_req, res) => { res.writeHead(302, { Location: 'https://evil.invalid/fixture' }); res.end(); });
  assert.equal((await account.action('status')).status, 'error', 'the native fetch rejects redirects before any credential/proof request can leave loopback');
});
