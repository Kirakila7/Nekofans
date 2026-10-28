'use strict';

// Reuse the official local N.E.K.O. OAuth owner. No cloud token, local
// credential file or account profile is copied into the workbench/DSH.
const { localBase } = require('./neko-chat.cjs');
const { DEFAULT_COMMUNITY_URL, OFFICIAL_AUTH_ORIGIN, resolveCommunityUrl } = require('./community-config.cjs');
const { setTimeout: delay } = require('node:timers/promises');
const PROOF = /^[A-Za-z0-9_-]{32,256}$/;
const SAFE_ERROR = {
  unavailable: '本机 N.E.K.O. 社区服务不可用，请启动本体后重试；仍可直接浏览社区。',
  unsupported: '本机 N.E.K.O. 尚不支持此社区接口，请更新本体后重试。',
  unverified: '桌面登录暂时无法验证，请稍后重试；已保存的登录不会被清除。',
  login: '请先完成官方账号授权，再连接桌面身份。',
  protocol: '社区接入响应不匹配，请更新本体后重试。',
  destination: '桌面身份只连接官方喵宇宙社区，请恢复官方社区地址后重试。',
  timeout: '本次授权等待已结束，请点击“连接桌面身份”重试。',
  canceled: '已取消本次连接。',
  page: '桌面身份交接页面未能加载，请在社区内重试。',
};
const failure = code => Object.assign(new Error(SAFE_ERROR[code]), { code });

function validateAccountAction(value) {
  if (!['status', 'connect', 'cancel'].includes(value)) throw new Error('未知社区身份操作');
  return value;
}

function officialFeed(value) {
  const url = new URL(resolveCommunityUrl(value));
  if (url.origin !== new URL(DEFAULT_COMMUNITY_URL).origin || url.pathname !== '/feed' || url.hash) throw failure('destination');
  return url;
}

function authorizationUrl(payload, base) {
  let url;
  try { url = new URL(payload.auth_url); } catch { throw failure('protocol'); }
  const params = url.searchParams;
  const callback = new URL('/oauth/callback', base);
  callback.hostname = '127.0.0.1';
  const redirect = callback.href;
  const scopes = (params.get('scope') || '').split(' ').filter(Boolean).sort().join(' ');
  if (url.origin !== OFFICIAL_AUTH_ORIGIN || url.pathname !== '/oauth2/auth' || url.username || url.password || url.hash
      || [...params.keys()].some(key => params.getAll(key).length !== 1)
      || [...params.keys()].some(key => !['client_id', 'redirect_uri', 'state', 'code_challenge', 'code_challenge_method', 'response_type', 'scope'].includes(key))
      || params.get('redirect_uri') !== redirect || params.get('state') !== payload.state || !PROOF.test(payload.state || '')
      || params.get('client_id') !== 'neko-servers-desktop-prod' || params.get('response_type') !== 'code'
      || params.get('code_challenge_method') !== 'S256' || !/^[A-Za-z0-9_-]{43}$/.test(params.get('code_challenge') || '')
      || scopes !== 'email offline openid profile' || payload.relay_origin) throw failure('protocol');
  return url.href;
}

function createCommunityAccount({ getBaseUrl, getCommunityUrl, openExternal, handoff,
  onState = () => {}, fetchImpl = globalThis.fetch, sleep = delay, now = Date.now,
  pollMs = 2000, requestTimeout = 120000 } = {}) {
  let current = null, snapshot = { status: 'idle', message: '连接桌面身份可复用本体登录与角色。' };
  const publish = (operation, value) => {
    if (current === operation && !operation.abort.signal.aborted) { snapshot = value; onState({ ...value }); }
    return { ...snapshot };
  };
  function check(operation) {
    if (current !== operation || operation.abort.signal.aborted) throw failure('canceled');
    if (localBase(getBaseUrl()) !== operation.base || officialFeed(getCommunityUrl()).href !== operation.feed) throw failure('canceled');
  }
  async function request(operation, route, { method = 'GET', timeout = requestTimeout } = {}) {
    check(operation);
    let response, value;
    try {
      response = await fetchImpl(operation.base + route, { method, redirect: 'error', cache: 'no-store',
        // Official proof endpoints require the local-UI metadata contract.
        // This trusted native adapter fixes both origin and TCP destination;
        // neither is supplied by DSH or the remote community renderer.
        headers: { Accept: 'application/json', Origin: operation.base, 'Sec-Fetch-Site': 'same-origin' },
        signal: AbortSignal.any([operation.abort.signal, AbortSignal.timeout(timeout)]) });
      if (response.status === 404) throw failure('unsupported');
      if (!response.ok) throw failure(response.status === 409 ? 'login' : 'unverified');
      // Bound local responses too; paths/profiles/tokens from older servers
      // must never become IPC values or diagnostic errors.
      const chunks = []; let bytes = 0;
      for await (const chunk of response.body) {
        const buffer = Buffer.from(chunk); bytes += buffer.length;
        if (bytes > 65536) { await response.body.cancel?.().catch(() => {}); throw failure('protocol'); }
        chunks.push(buffer);
      }
      value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw failure('protocol');
    } catch (error) {
      check(operation);
      throw failure(Object.hasOwn(SAFE_ERROR, error.code) ? error.code : 'unavailable');
    }
    check(operation);
    return value;
  }
  async function status(operation) {
    const value = await request(operation, '/api/card-drop/oauth/status', { timeout: 15000 });
    if (typeof value.logged_in !== 'boolean') throw failure('protocol');
    if (value.community_base_url && new URL(value.community_base_url).origin !== new URL(operation.feed).origin) throw failure('destination');
    if (!value.logged_in && value.session_saved) throw failure('unverified');
    return value.logged_in;
  }
  async function transfer(operation) {
    publish(operation, { status: 'connecting', message: '正在交接桌面身份…' });
    const delegate = await request(operation, '/api/card-drop/native-delegate');
    const ticket = await request(operation, '/api/card-drop/sync-ticket');
    const client = await request(operation, '/api/system/client-id', { timeout: 15000 });
    if (!PROOF.test(delegate.native_delegate || '') || !PROOF.test(ticket.sync_ticket || '')) throw failure('protocol');
    if (typeof client.client_id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(client.client_id)) throw failure('protocol');
    const url = new URL(operation.feed);
    url.searchParams.set('neko_source_origin', operation.base);
    url.searchParams.set('cid', client.client_id);
    url.hash = new URLSearchParams({ native_sync: ticket.sync_ticket, native_delegate: delegate.native_delegate }).toString();
    check(operation);
    try { await handoff(url.href); } catch { check(operation); throw failure('page'); }
    check(operation);
    // A loaded page is not proof that SPA bootstrap/client binding succeeded.
    return publish(operation, { status: 'handed-off', message: '桌面身份已交接，角色绑定结果请在原社区内确认。' });
  }
  async function connect(operation) {
    if (await status(operation)) return transfer(operation);
    const start = await request(operation, '/api/card-drop/oauth/start', { method: 'POST' });
    const url = authorizationUrl(start, operation.base);
    const ttl = Math.min(600000, Number(start.expires_in) * 1000);
    if (!Number.isFinite(ttl) || ttl <= 0) throw failure('protocol');
    check(operation);
    publish(operation, { status: 'authorizing', message: '请在系统浏览器完成官方授权；完成后会回到此社区。' });
    await openExternal(url);
    check(operation);
    const deadline = now() + ttl;
    while (now() < deadline) {
      const result = await request(operation, '/api/card-drop/oauth/completion?state=' + encodeURIComponent(start.state), { timeout: 15000 });
      if (result.logged_in === true) return transfer(operation);
      if (result.logged_in !== false) throw failure('protocol');
      await sleep(Math.min(pollMs, Math.max(1, deadline - now())), undefined, { signal: operation.abort.signal });
      check(operation);
    }
    throw failure('timeout');
  }
  function cancel() {
    if (current) current.abort.abort();
    current = null;
    snapshot = { status: 'idle', message: '连接桌面身份可复用本体登录与角色。' };
    onState({ ...snapshot });
    return { ...snapshot };
  }
  function action(value) {
    validateAccountAction(value);
    if (value === 'cancel') return Promise.resolve(cancel());
    if (current) return value === 'connect' ? current.promise : Promise.resolve({ ...snapshot });
    const operation = { abort: new AbortController() };
    current = operation;
    operation.promise = Promise.resolve().then(async () => {
      operation.base = localBase(getBaseUrl());
      operation.feed = officialFeed(getCommunityUrl()).href;
      publish(operation, { status: 'checking', message: '正在检查桌面社区连接…' });
      if (value === 'connect') return connect(operation);
      const loggedIn = await status(operation);
      return publish(operation, { status: loggedIn ? 'available' : 'signed-out',
        message: loggedIn ? '本机桌面已登录，可连接到当前社区。' : '本机桌面尚未登录；社区网页可独立登录。' });
    }).catch(error => {
      if (current !== operation || operation.abort.signal.aborted) return { status: 'canceled', message: SAFE_ERROR.canceled };
      return publish(operation, { status: 'error', message: SAFE_ERROR[error.code] || SAFE_ERROR.unavailable });
    }).finally(() => { if (current === operation) current = null; });
    return operation.promise;
  }
  return Object.freeze({ action, cancel, get state() { return { ...snapshot }; } });
}

module.exports = { createCommunityAccount, validateAccountAction, authorizationUrl };
