'use strict';

// Lobby (N.E.K.O.Chat) sign-in: OAuth 2.0 authorization code + PKCE as a public
// native client (RFC 8252) with a one-shot 127.0.0.1 callback. The access token
// lives only in memory; the refresh token is stored through WorkbenchSecretStore
// (no plaintext fallback). Snapshots and errors carry fixed text only: no token,
// code, verifier, state or raw server response ever leaves this module.
const nodeHttp = require('node:http');
const crypto = require('node:crypto');

const SCOPES = Object.freeze(['openid', 'offline', 'profile']);
const CALLBACK_PATH = '/oauth/callback';
const CALLBACK_TTL_MS = 5 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 15000;
const REVOKE_TIMEOUT_MS = 5000;
const MAX_RESPONSE_BYTES = 65536;
const MAX_EXPIRES_IN = 30 * 24 * 3600;
const TOKEN = /^[\x21-\x7e]{16,8192}$/;
const CODE = /^[A-Za-z0-9._~+/=-]{1,2048}$/;
const CALLBACK_KEYS = new Set(['code', 'state', 'scope', 'iss', 'error', 'error_description', 'error_uri']);

const SAFE_ERROR = Object.freeze({
  unconfigured: '频道服务未配置。',
  storage: '系统加密存储不可用，无法保存频道登录；请启用系统钥匙串后重试。',
  login: '请先登录频道。',
  browser: '无法打开系统浏览器完成频道登录，请重试。',
  callback: '本机登录回调无法启动，请稍后重试。',
  denied: '已在浏览器中取消频道登录授权。',
  timeout: '频道登录等待已超时，请重试。',
  canceled: '已取消频道登录。',
  protocol: '频道登录响应不符合预期，请稍后重试。',
  rejected: '频道登录未被接受，请重新登录。',
  expired: '频道登录已失效，请重新登录。',
  unavailable: '频道登录服务暂时不可用，请稍后重试。',
});
const MESSAGE = Object.freeze({
  'signed-out': '登录后即可进入频道。',
  authorizing: '请在系统浏览器完成登录授权。',
  exchanging: '正在完成频道登录…',
  'signed-in': '已登录频道。',
});
const failure = code => Object.assign(new Error(SAFE_ERROR[code] || SAFE_ERROR.unavailable),
  { code: Object.hasOwn(SAFE_ERROR, code) ? code : 'unavailable' });

const PAGE_STYLE = 'body{font:16px/1.6 system-ui,sans-serif;margin:15vh auto;max-width:28rem;text-align:center;color:#333}';
const page = text => `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>N.E.K.O. 频道登录</title>`
  + `<style>${PAGE_STYLE}</style></head><body><p>${text}</p></body></html>`;
const DONE_PAGE = page('频道登录已完成，可以关闭此页面并回到工作台。');
const FAIL_PAGE = page('此登录回调无效或已过期，请回到工作台重新登录。');
const PAGE_HEADERS = Object.freeze({
  'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'",
  'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', Connection: 'close',
});

const base64url = buffer => Buffer.from(buffer).toString('base64url');

// RFC 7636: 32 random bytes -> 43-char verifier; challenge = BASE64URL(SHA256(verifier)).
function pkcePair(randomBytes = crypto.randomBytes) {
  const verifier = base64url(randomBytes(32));
  if (!/^[A-Za-z0-9_-]{43}$/.test(verifier)) throw failure('protocol');
  return { verifier, challenge: base64url(crypto.createHash('sha256').update(verifier, 'ascii').digest()) };
}

function sameSecret(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const a = Buffer.from(left), b = Buffer.from(right);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Same parameter set and order as community-account.cjs authorizationUrl().
function buildAuthorizationUrl({ authUrl, clientId, redirectUri, state, challenge }) {
  const url = new URL('/oauth2/auth', authUrl);
  for (const [key, value] of [['client_id', clientId], ['redirect_uri', redirectUri], ['state', state],
    ['code_challenge', challenge], ['code_challenge_method', 'S256'], ['response_type', 'code'], ['scope', SCOPES.join(' ')]]) {
    url.searchParams.set(key, value);
  }
  return url.href;
}

async function readBounded(response) {
  const declared = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    await response.body?.cancel?.().catch(() => {});
    throw failure('protocol');
  }
  if (!response.body) return '';
  const chunks = []; let bytes = 0;
  for await (const chunk of response.body) {
    const buffer = Buffer.from(chunk); bytes += buffer.length;
    if (bytes > MAX_RESPONSE_BYTES) { await response.body.cancel?.().catch(() => {}); throw failure('protocol'); }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

const parseObject = text => {
  let value;
  try { value = JSON.parse(text); } catch { return null; }
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
};

// Validates a token endpoint success body. `requireRefresh` is true for the
// authorization_code grant (offline scope must yield a refresh token).
function validateTokenResponse(value, { requireRefresh }) {
  if (!value || typeof value.token_type !== 'string' || value.token_type.toLowerCase() !== 'bearer'
      || typeof value.access_token !== 'string' || !TOKEN.test(value.access_token)
      || !Number.isInteger(value.expires_in) || value.expires_in < 1 || value.expires_in > MAX_EXPIRES_IN) throw failure('protocol');
  if (value.refresh_token !== undefined
      && (typeof value.refresh_token !== 'string' || !TOKEN.test(value.refresh_token) || value.refresh_token === value.access_token)) throw failure('protocol');
  if (requireRefresh && value.refresh_token === undefined) throw failure('protocol');
  if (value.scope !== undefined) {
    if (typeof value.scope !== 'string') throw failure('protocol');
    const granted = new Set(value.scope.split(' ').filter(Boolean));
    if (SCOPES.some(scope => !granted.has(scope))) throw failure('protocol');
  }
  return { access: value.access_token, refresh: value.refresh_token ?? null, expiresIn: value.expires_in };
}

// One POST to the token or revoke endpoint. Never follows redirects, bounded in
// time and size; errors map to SAFE_ERROR codes only. Returns { ok, status, value }.
async function postForm(fetchImpl, url, fields, { timeout, signal }) {
  const deadline = AbortSignal.timeout(timeout);
  try {
    const response = await fetchImpl(url, { method: 'POST', redirect: 'error', cache: 'no-store', credentials: 'omit',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams(fields).toString(), signal: signal ? AbortSignal.any([signal, deadline]) : deadline });
    const text = await readBounded(response);
    return { ok: response.ok, status: response.status, value: parseObject(text) };
  } catch (error) {
    if (signal?.aborted) throw failure('canceled');
    if (deadline.aborted) throw failure('timeout');
    throw failure(error?.code === 'protocol' ? 'protocol' : 'unavailable');
  }
}

function listen(server, port) {
  return new Promise((resolve, reject) => {
    const onError = error => { server.off('listening', onListening); reject(error); };
    const onListening = () => { server.off('error', onError); resolve(server.address().port); };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen({ host: '127.0.0.1', port, exclusive: true });
  });
}

// One-shot loopback redirect receiver. Accepts exactly one GET /oauth/callback
// whose state matches within `ttl`; any other request gets a static failure page
// and does not consume the slot. Resolves `result` with the authorization code.
async function startCallbackServer({ http, ports, state, authUrl, ttl, now, signal }) {
  let settle, startedAt = now(), done = false, port = 0;
  const result = new Promise((resolve, reject) => { settle = (error, code) => (error ? reject(error) : resolve(code)); });
  result.catch(() => {});
  const server = http.createServer((request, response) => {
    request.resume();
    const reply = (status, body) => {
      response.writeHead(status, PAGE_HEADERS);
      response.end(body);
    };
    if (done) return reply(410, FAIL_PAGE);
    if (now() - startedAt > ttl) { finish(failure('timeout')); return reply(410, FAIL_PAGE); }
    if (request.method !== 'GET') return reply(405, FAIL_PAGE);
    if (request.headers.host !== `127.0.0.1:${port}` || typeof request.url !== 'string' || request.url.length > 8192) return reply(400, FAIL_PAGE);
    let url;
    try { url = new URL(request.url, `http://127.0.0.1:${port}`); } catch { return reply(400, FAIL_PAGE); }
    if (url.pathname !== CALLBACK_PATH || url.hash) return reply(404, FAIL_PAGE);
    const params = url.searchParams;
    if ([...params.keys()].some(key => !CALLBACK_KEYS.has(key) || params.getAll(key).length !== 1)
        || !sameSecret(params.get('state'), state)) return reply(400, FAIL_PAGE);
    // RFC 9207: when the server names itself, it must be the configured issuer.
    const issuer = params.get('iss');
    if (issuer !== null) {
      let origin = null;
      try { const parsed = new URL(issuer); if (parsed.pathname === '/' && !parsed.search) origin = parsed.origin; } catch {}
      if (origin !== authUrl) { finish(failure('protocol')); return reply(400, FAIL_PAGE); }
    }
    if (params.has('error')) { finish(failure('denied')); return reply(400, FAIL_PAGE); }
    const code = params.get('code');
    if (!code || !CODE.test(code)) { finish(failure('protocol')); return reply(400, FAIL_PAGE); }
    finish(null, code);
    return reply(200, DONE_PAGE);
  });
  server.requestTimeout = 10000;
  server.headersTimeout = 10000;
  server.maxHeadersCount = 64;
  server.keepAliveTimeout = 1;
  let timer = null;
  const onAbort = () => finish(failure('canceled'));
  function close() {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
    server.close();
    server.closeAllConnections?.();
  }
  function finish(error, code) {
    if (done) return;
    done = true;
    settle(error, code);
    // Let the page response flush before dropping the socket.
    setImmediate(close);
  }
  let lastError = null;
  for (const candidate of ports?.length ? ports : [0]) {
    try { port = await listen(server, candidate); lastError = null; break; } catch (error) { lastError = error; }
  }
  if (lastError || !port) { close(); throw failure('callback'); }
  startedAt = now();
  timer = setTimeout(() => finish(failure('timeout')), ttl);
  timer.unref?.();
  if (signal?.aborted) onAbort(); else signal?.addEventListener('abort', onAbort, { once: true });
  return { redirectUri: `http://127.0.0.1:${port}${CALLBACK_PATH}`, port, result, close: () => finish(failure('canceled')) };
}

const REFRESH_SKEW_MS = 60000;

function createLobbyAuth({ config, secretStore, openExternal, fetchImpl = globalThis.fetch, http = nodeHttp,
  now = Date.now, randomBytes = crypto.randomBytes, onState = () => {},
  callbackTtlMs = CALLBACK_TTL_MS, requestTimeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  const configured = config?.configured === true;
  const authUrl = configured ? config.authUrl : null;
  const clientId = configured ? config.clientId : null;
  let generation = 0;          // bumped by sign-out/dispose; stale async results are dropped
  let access = null;           // { token, expiresAt } -- memory only
  let signInOperation = null;  // { abort, promise }
  let refreshing = null;       // single-flight refresh promise
  let disposed = false;
  let state = { status: configured ? (secretStore?.has?.() ? 'signed-in' : 'signed-out') : 'unconfigured', error: '' };

  const snapshot = () => {
    const status = state.status;
    const message = status === 'unconfigured' ? SAFE_ERROR.unconfigured
      : MESSAGE[status] || MESSAGE['signed-out'];
    return { status, signedIn: status === 'signed-in', message, error: state.error };
  };
  function publish(status, error = '') {
    state = { status, error };
    const value = snapshot();
    try { onState({ ...value }); } catch { /* observers never break auth */ }
    return value;
  }
  const errorText = error => SAFE_ERROR[error?.code] || SAFE_ERROR.unavailable;
  function requireConfigured() {
    if (disposed || !configured) throw failure('unconfigured');
  }
  function requireStorage() {
    let available = false;
    try { available = secretStore?.available?.() === true; } catch { available = false; }
    if (!available) throw failure('storage');
  }

  // Drops the in-memory token and the stored refresh token. Used for sign-out
  // and for invalid_grant (the server no longer honours the grant).
  async function forget() {
    access = null;
    try { await secretStore?.clear?.(); } catch { /* best-effort; file removal only */ }
  }

  async function storedRefresh() {
    let value;
    try { value = await secretStore.get(); } catch { throw failure('storage'); }
    if (typeof value !== 'string' || !TOKEN.test(value)) throw failure('login');
    return value;
  }

  async function persistRefresh(token) {
    requireStorage();
    try { await secretStore.set(token); } catch { throw failure('storage'); }
  }

  async function signInFlow(operation) {
    requireStorage();
    const { verifier, challenge } = pkcePair(randomBytes);
    const stateValue = base64url(randomBytes(32));
    if (!/^[A-Za-z0-9_-]{43}$/.test(stateValue) || stateValue === verifier) throw failure('protocol');
    const callback = await startCallbackServer({ http, ports: config.oauthPorts, state: stateValue, authUrl,
      ttl: callbackTtlMs, now, signal: operation.abort.signal });
    operation.closeCallback = callback.close;
    try {
      const url = buildAuthorizationUrl({ authUrl, clientId, redirectUri: callback.redirectUri, state: stateValue, challenge });
      publish('authorizing');
      try { await openExternal(url); } catch { throw failure('browser'); }
      const code = await callback.result;
      check(operation);
      publish('exchanging');
      const reply = await postForm(fetchImpl, `${authUrl}/oauth2/token`, { grant_type: 'authorization_code', code,
        client_id: clientId, redirect_uri: callback.redirectUri, code_verifier: verifier },
      { timeout: requestTimeoutMs, signal: operation.abort.signal });
      check(operation);
      if (!reply.ok) throw failure(reply.status >= 500 ? 'unavailable' : reply.value?.error === 'invalid_grant' ? 'rejected' : 'protocol');
      const tokens = validateTokenResponse(reply.value, { requireRefresh: true });
      // Store the refresh token first; only a persisted grant becomes "signed in".
      await persistRefresh(tokens.refresh);
      operation.wroteRefresh = true;
      if (operation.generation !== generation) { if (!disposed) await forget(); throw failure('canceled'); }
      check(operation);
      access = { token: tokens.access, expiresAt: now() + tokens.expiresIn * 1000 };
      return publish('signed-in');
    } finally { callback.close(); }
  }
  function check(operation) {
    if (disposed || operation.abort.signal.aborted || operation.generation !== generation) throw failure('canceled');
  }

  function signIn({ force = false } = {}) {
    if (disposed || !configured) return Promise.resolve(snapshot());
    if (signInOperation) return signInOperation.promise;
    if (state.status === 'signed-in' && !force) return Promise.resolve(snapshot());
    const operation = { abort: new AbortController(), generation, closeCallback: null,
      previousSignedIn: force && state.status === 'signed-in', previousAccess: access, wroteRefresh: false, rollback: null };
    signInOperation = operation;
    // Freeze new refresh attempts before retaining the old grant. An in-flight
    // refresh settles first, so rollback cannot overwrite a later rotation.
    if (operation.previousSignedIn) publish('authorizing');
    operation.promise = Promise.resolve().then(async () => {
      if (operation.previousSignedIn) {
        if (refreshing) await refreshing.catch(() => {});
        check(operation);
        operation.previousAccess = access;
        let previous;
        try { previous = await storedRefresh(); } catch (error) {
          if (error.code !== 'login') throw error;
          operation.previousSignedIn = false;
        }
        if (operation.previousSignedIn) {
          operation.rollback = typeof secretStore.prepareRollback === 'function'
            ? await secretStore.prepareRollback() : () => persistRefresh(previous);
        }
      }
      check(operation);
      return signInFlow(operation);
    }).catch(async error => {
      // Superseded by sign-out or dispose: that path already published its state.
      if (disposed || operation.generation !== generation) return snapshot();
      if (operation.previousSignedIn) {
        if (operation.wroteRefresh && operation.rollback) {
          try { await operation.rollback(); } catch {
            await forget(); return publish('signed-out', SAFE_ERROR.storage);
          }
          if (disposed || operation.generation !== generation) { if (!disposed) await forget(); return snapshot(); }
        }
        access = operation.previousAccess;
        return publish('signed-in', operation.abort.signal.aborted ? SAFE_ERROR.canceled : errorText(error));
      }
      if (operation.wroteRefresh) await forget();
      if (operation.abort.signal.aborted) return publish('signed-out', SAFE_ERROR.canceled);
      return publish('signed-out', errorText(error));
    }).finally(() => { if (signInOperation === operation) signInOperation = null; });
    return operation.promise;
  }

  function cancelSignIn() {
    const operation = signInOperation;
    if (!operation) return Promise.resolve(snapshot());
    operation.abort.abort();
    operation.closeCallback?.();
    return operation.promise;
  }

  // Single-flight. A rotated refresh token is persisted before the new access
  // token is installed; if it cannot be persisted the grant is dropped instead
  // of keeping a session that could not survive a restart.
  function refresh() {
    if (refreshing) return refreshing;
    const started = generation;
    const run = (async () => {
      requireConfigured();
      if (state.status !== 'signed-in') throw failure('login');
      const current = await storedRefresh();
      if (started !== generation) throw failure('canceled');
      const reply = await postForm(fetchImpl, `${authUrl}/oauth2/token`, { grant_type: 'refresh_token',
        refresh_token: current, client_id: clientId }, { timeout: requestTimeoutMs });
      if (started !== generation) throw failure('canceled');
      if (!reply.ok) {
        if (reply.status === 400 && reply.value?.error === 'invalid_grant') {
          await forget();
          publish('signed-out', SAFE_ERROR.expired);
          throw failure('expired');
        }
        throw failure(reply.status >= 500 || reply.status === 429 ? 'unavailable' : 'rejected');
      }
      const tokens = validateTokenResponse(reply.value, { requireRefresh: false });
      if (tokens.refresh && tokens.refresh !== current) {
        try { await persistRefresh(tokens.refresh); } catch (error) {
          await forget();
          publish('signed-out', SAFE_ERROR.storage);
          throw error;
        }
      }
      // Signed out while the rotated token was being written: do not leave it on disk.
      // (dispose() at app exit keeps the persisted, still valid grant.)
      if (started !== generation) { if (!disposed) await forget(); throw failure('canceled'); }
      access = { token: tokens.access, expiresAt: now() + tokens.expiresIn * 1000 };
      if (state.error) publish('signed-in');
      return access.token;
    })().catch(error => {
      // Transient failures keep the stored grant; the next call retries.
      if (started === generation && !disposed && state.status === 'signed-in'
          && ['unavailable', 'timeout', 'protocol', 'rejected'].includes(error.code)) publish('signed-in', errorText(error));
      throw error;
    });
    const tracked = run.finally(() => { if (refreshing === tracked) refreshing = null; });
    refreshing = tracked;
    return tracked;
  }

  // Returns a bearer token valid for at least REFRESH_SKEW_MS, refreshing when needed.
  async function getAccessToken({ forceRefresh = false } = {}) {
    requireConfigured();
    if (state.status !== 'signed-in') throw failure('login');
    if (!forceRefresh && access && access.expiresAt - now() > REFRESH_SKEW_MS) return access.token;
    return refresh();
  }

  // 401 from the chat service: forget the in-memory token so the next call refreshes.
  function invalidateAccessToken() { access = null; }

  async function signOut() {
    generation += 1;
    signInOperation?.abort.abort();
    signInOperation?.closeCallback?.();
    const revoke = [];
    try { if (secretStore?.has?.() && secretStore.available?.()) revoke.push(await secretStore.get()); } catch { /* unreadable: nothing to revoke */ }
    if (access?.token) revoke.push(access.token);
    await forget();
    const value = configured ? publish('signed-out') : snapshot();
    if (configured && !disposed) {
      await Promise.all(revoke.filter(token => typeof token === 'string' && TOKEN.test(token)).map(token =>
        postForm(fetchImpl, `${authUrl}/oauth2/revoke`, { token, client_id: clientId }, { timeout: REVOKE_TIMEOUT_MS })
          .catch(() => null)));
    }
    return value;
  }

  function dispose() {
    disposed = true;
    generation += 1;
    access = null;
    signInOperation?.abort.abort();
    signInOperation?.closeCallback?.();
  }

  // A stored grant counts only while it can actually be decrypted.
  if (configured && state.status === 'signed-in') {
    let available = false;
    try { available = secretStore.available() === true; } catch { available = false; }
    if (!available) state = { status: 'signed-out', error: SAFE_ERROR.storage };
  }

  return Object.freeze({
    signIn, cancelSignIn, signOut, refresh, getAccessToken, invalidateAccessToken, dispose,
    get state() { return snapshot(); },
    get accessExpiresAt() { return access ? access.expiresAt : null; },
  });
}

module.exports = { createLobbyAuth, buildAuthorizationUrl, validateTokenResponse, pkcePair, startCallbackServer,
  SAFE_ERROR, SCOPES, CALLBACK_PATH, CALLBACK_TTL_MS, MAX_RESPONSE_BYTES };
