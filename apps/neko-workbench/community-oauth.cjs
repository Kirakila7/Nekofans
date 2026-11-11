'use strict';
const crypto = require('node:crypto');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { endpoint, requestJson } = require('./community-social-client.cjs');

function fail(code) { const error = new Error(code); error.code = code; return error; }
// Requires a registered public client (token_endpoint_auth_method=none) and an
// exact loopback redirect URI. No assumed/shared desktop client registration.
function createOAuthSession({ authorizationUrl, tokenUrl, clientId, redirectUri,
  scope = 'openid email profile offline', openExternal, safeStorage, tokenFile,
  fetch: fetchImpl = globalThis.fetch, allowLoopbackForTests = false,
  loginTimeoutMs = 120000, requestTimeoutMs = 15000, now = Date.now } = {}) {
  const authorization = endpoint(authorizationUrl, allowLoopbackForTests);
  const tokenEndpoint = endpoint(tokenUrl, allowLoopbackForTests);
  let callback;
  try { callback = new URL(redirectUri); } catch { throw fail('invalid_oauth_config'); }
  if (authorization.origin !== tokenEndpoint.origin ||
      typeof clientId !== 'string' || !/^[A-Za-z0-9._-]{1,256}$/.test(clientId) ||
      callback.protocol !== 'http:' || callback.hostname !== '127.0.0.1' || !callback.port || Number(callback.port) < 1 ||
      callback.pathname !== '/oauth/callback' || callback.search || callback.hash || callback.username || callback.password ||
      typeof openExternal !== 'function' || !safeStorage || !path.isAbsolute(tokenFile || '') ||
      typeof scope !== 'string' || scope.length > 512 || /[\r\n]/.test(scope) ||
      !Number.isFinite(loginTimeoutMs) || loginTimeoutMs <= 0 || loginTimeoutMs > 300000) throw fail('invalid_oauth_config');
  const binding = crypto.createHash('sha256').update(JSON.stringify([authorization.href, tokenEndpoint.href, clientId, callback.href])).digest('hex');
  let tokens = null, loaded = false, loadFlight = null, loginFlight = null, refreshFlight = null, cancelLogin = null, generation = 0, closed = false;
  let writeQueue = Promise.resolve();
  function encryptedStorageAvailable() {
    return safeStorage.isEncryptionAvailable() && safeStorage.getSelectedStorageBackend?.() !== 'basic_text';
  }
  function status() { return { authenticated: Boolean(tokens), loginPending: Boolean(loginFlight) }; }
  function persist(snapshot, epoch) {
    // Serialize mutation so logout cannot be overtaken by an earlier token save.
    const operation = writeQueue.catch(() => {}).then(async () => {
      if (epoch !== generation) return;
      if (!snapshot) { await fs.rm(tokenFile, { force: true }); return; }
      if (!encryptedStorageAvailable()) throw fail('secure_storage_unavailable');
      const data = safeStorage.encryptString(JSON.stringify({ v: 1, binding, tokens: snapshot }));
      await fs.mkdir(path.dirname(tokenFile), { recursive: true, mode: 0o700 });
      const temporary = `${tokenFile}.${crypto.randomBytes(8).toString('hex')}.tmp`;
      try {
        await fs.writeFile(temporary, data, { flag: 'wx', mode: 0o600 });
        if (epoch === generation) await fs.rename(temporary, tokenFile);
      } finally { await fs.rm(temporary, { force: true }); }
    });
    writeQueue = operation; return operation;
  }
  function validateTokens(value, oldRefresh) {
    if (!value || typeof value.access_token !== 'string' || !value.access_token || value.access_token.length > 8192 || /\s/.test(value.access_token) ||
        value.token_type?.toLowerCase() !== 'bearer' || !Number.isFinite(value.expires_in) || value.expires_in <= 0 || value.expires_in > 31536000 ||
        (value.refresh_token !== undefined && (typeof value.refresh_token !== 'string' || !value.refresh_token || value.refresh_token.length > 16384))) throw fail('invalid_token_response');
    return { accessToken: value.access_token, refreshToken: value.refresh_token || oldRefresh || null,
      expiresAt: now() + value.expires_in * 1000 };
  }
  async function readStore() {
    const epoch = generation;
    if (!encryptedStorageAvailable()) return;
    try {
      if ((await fs.stat(tokenFile)).size > 65536) throw fail('invalid_token_store');
      const saved = JSON.parse(safeStorage.decryptString(await fs.readFile(tokenFile)));
      if (saved.v !== 1 || saved.binding !== binding || typeof saved.tokens?.accessToken !== 'string' ||
          !Number.isFinite(saved.tokens.expiresAt) ||
          (saved.tokens.refreshToken !== null && typeof saved.tokens.refreshToken !== 'string')) throw fail('invalid_token_store');
      if (epoch === generation && !closed) tokens = saved.tokens;
    } catch (error) { if (error.code !== 'ENOENT') throw fail('token_store_unavailable'); }
  }
  async function load() {
    if (loaded) return;
    if (!loadFlight) loadFlight = readStore().then(() => { loaded = true; }).finally(() => { loadFlight = null; });
    return loadFlight;
  }
  async function exchange(fields) {
    return requestJson(tokenEndpoint.href, { fetch: fetchImpl, method: 'POST', timeoutMs: requestTimeoutMs, maxBytes: 65536,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({ ...fields, client_id: clientId }).toString() });
  }
  async function commit(next, epoch) {
    if (epoch !== generation || closed) throw fail('login_cancelled');
    await persist(next, epoch);
    if (epoch !== generation || closed) throw fail('login_cancelled');
    tokens = next; loaded = true;
  }
  function login() {
    if (closed) return Promise.reject(fail('oauth_closed'));
    if (loginFlight) return loginFlight;
    if (!encryptedStorageAvailable()) return Promise.reject(fail('secure_storage_unavailable'));
    const epoch = ++generation;
    const state = crypto.randomBytes(32).toString('base64url');
    const verifier = crypto.randomBytes(48).toString('base64url');
    const authorize = new URL(authorization);
    for (const [key, value] of Object.entries({ response_type: 'code', client_id: clientId, redirect_uri: callback.href,
      scope, state, code_challenge_method: 'S256', code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url') })) authorize.searchParams.set(key, value);
    const flow = new Promise((resolve, reject) => {
      let consumed = false, settled = false;
      const server = http.createServer((request, response) => {
        response.setHeader('Content-Type', 'text/plain; charset=utf-8');
        response.setHeader('Cache-Control', 'no-store');
        response.setHeader('Content-Security-Policy', "default-src 'none'");
        let incoming;
        try { incoming = new URL(request.url, callback.origin); } catch { response.writeHead(400); response.end('Invalid callback'); return; }
        if (request.method !== 'GET' || request.headers.host !== callback.host || incoming.origin !== callback.origin || incoming.pathname !== callback.pathname) {
          response.writeHead(404); response.end('Not found'); return;
        }
        const receivedState = incoming.searchParams.get('state');
        if (incoming.searchParams.getAll('state').length !== 1 || !receivedState || !/^[A-Za-z0-9_-]+$/.test(receivedState) || receivedState.length !== state.length ||
            !crypto.timingSafeEqual(Buffer.from(receivedState), Buffer.from(state))) {
          response.writeHead(400); response.end('Invalid state'); return;
        }
        if (consumed) { response.writeHead(409); response.end('Callback already received'); return; }
        consumed = true;
        if (incoming.searchParams.has('error')) { response.writeHead(400); response.end('Login declined'); finish(fail('login_declined')); return; }
        const code = incoming.searchParams.get('code');
        if (!code || code.length > 8192 || incoming.searchParams.getAll('code').length !== 1) {
          response.writeHead(400); response.end('Invalid callback'); finish(fail('invalid_oauth_callback')); return;
        }
        response.end('Login received. You can return to N.E.K.O.');
        exchange({ grant_type: 'authorization_code', code, redirect_uri: callback.href, code_verifier: verifier })
          .then(value => commit(validateTokens(value), epoch)).then(() => finish(null, status()), error => finish(error));
      });
      server.maxHeadersCount = 30; server.headersTimeout = 10000; server.requestTimeout = 10000;
      const timer = setTimeout(() => finish(fail('login_timeout')), loginTimeoutMs);
      function finish(error, value) {
        if (settled) return; settled = true;
        // A timed-out exchange must not save tokens after this flow has ended.
        let cleanup;
        if (error && epoch === generation) {
          ++generation; tokens = null; loaded = true;
          // rename may already be in flight past persist's generation check.
          // Queue deletion behind that write and finish failure only after it
          // completes, so a failed login cannot be restored on this or next run.
          cleanup = persist(null, generation);
        }
        clearTimeout(timer); server.close(); server.closeAllConnections(); cancelLogin = null;
        if (error) Promise.resolve(cleanup).then(() => reject(error), () => reject(fail('token_store_unavailable')));
        else resolve(value);
      }
      cancelLogin = () => finish(fail('login_cancelled'));
      server.once('error', () => finish(fail('oauth_callback_unavailable')));
      server.listen(Number(callback.port), '127.0.0.1', () => {
        if (settled) { server.close(); return; }
        Promise.resolve().then(() => openExternal(authorize.href)).catch(() => finish(fail('browser_open_failed')));
      });
    });
    loginFlight = flow.finally(() => { loginFlight = null; }).then(() => status());
    return loginFlight;
  }
  async function getAccessToken() {
    if (closed) throw fail('oauth_closed');
    await load();
    if (tokens && tokens.expiresAt > now() + 30000) return tokens.accessToken;
    if (!tokens?.refreshToken) return null;
    if (!refreshFlight) {
      const epoch = generation; const oldRefresh = tokens.refreshToken;
      refreshFlight = (async () => {
        try {
          const value = await exchange({ grant_type: 'refresh_token', refresh_token: oldRefresh });
          await commit(validateTokens(value, oldRefresh), epoch);
          return tokens.accessToken;
        } catch (error) {
          if (epoch === generation && (error.status === 400 || error.status === 401 || error.code === 'invalid_token_response')) {
            tokens = null; await persist(null, epoch);
          }
          throw error;
        }
      })().finally(() => { refreshFlight = null; });
    }
    return refreshFlight;
  }
  async function logout() {
    ++generation; cancelLogin?.(); tokens = null; loaded = true;
    await persist(null, generation); return status();
  }
  function close() {
    closed = true; ++generation; cancelLogin?.(); tokens = null;
    // Preserve established sessions on ordinary application shutdown, but a
    // pending login must not leave behind an incomplete token save.
    if (loginFlight) { loaded = true; return persist(null, generation); }
    return writeQueue;
  }
  return Object.freeze({ login, getAccessToken, logout, status, close });
}
module.exports = { createOAuthSession };
