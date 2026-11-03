'use strict';
// Locks lobby-auth.cjs: PKCE sign-in with a real 127.0.0.1 callback server on
// port 0, an injected token endpoint, refresh rotation and secrecy. Synthetic
// hosts, codes and tokens only; nothing leaves loopback.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const A = require('../../apps/neko-workbench/lobby-auth.cjs');
const { WorkbenchSecretStore } = require('../../apps/neko-workbench/main-chat-secret.cjs');

const AUTH = 'https://auth.example.test';
const CLIENT = 'neko-chat-desktop-dev';
const CODE = 'fixture-code-Q7wq0Rk2bXv9';
const tokenSet = n => ({ access: `fixture-access-${n}-${'a'.repeat(24)}`, refresh: `fixture-refresh-${n}-${'r'.repeat(24)}` });
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
const grant = (n, extra = {}) => json({ access_token: tokenSet(n).access, refresh_token: tokenSet(n).refresh, token_type: 'bearer',
  expires_in: 3600, scope: 'openid offline profile', id_token: 'fixture.id.token', ...extra });
const tick = () => new Promise(resolve => setImmediate(resolve));

function memoryStore({ available = true, value = null } = {}) {
  return {
    log: [], value, availableFlag: available, gate: null, failSet: false,
    available() { return this.availableFlag; },
    has() { return this.value !== null; },
    async get() { this.log.push('get'); return this.value; },
    async set(secret) {
      this.log.push('set:start');
      if (this.gate) await this.gate;
      if (this.failSet) throw new Error('fixture set failure');
      this.value = secret; this.log.push('set:done');
    },
    async clear() { this.log.push('clear'); this.value = null; },
  };
}

function fixture({ store = memoryStore(), token = () => grant(1), revoke = () => new Response(null, { status: 200 }),
  config = {}, clock = { t: Date.parse('2026-10-29T12:00:00Z') }, ...options } = {}) {
  const calls = [], states = [], opened = [];
  const fetchImpl = async (url, init) => {
    const body = Object.fromEntries(new URLSearchParams(init.body));
    calls.push({ url, init, body });
    if (url === `${AUTH}/oauth2/token`) return token(body, init);
    if (url === `${AUTH}/oauth2/revoke`) return revoke(body, init);
    return json({}, 404);
  };
  const auth = A.createLobbyAuth({
    config: { configured: true, authUrl: AUTH, clientId: CLIENT, oauthPorts: null, ...config },
    secretStore: store, fetchImpl, now: () => clock.t, onState: value => states.push(value),
    openExternal: async url => { opened.push(url); }, ...options,
  });
  // Resolves with the n-th authorization URL handed to the system browser.
  async function opened$(n = 1) {
    for (let i = 0; i < 500 && opened.length < n; i++) await new Promise(resolve => setTimeout(resolve, 2));
    assert.ok(opened.length >= n, 'browser was not opened');
    return opened[n - 1];
  }
  return { auth, store, calls, states, opened, clock, opened$ };
}

// Raw loopback GET so the test controls method, path and Host exactly.
function hit(redirectUri, { path: route, method = 'GET', host } = {}) {
  const base = new URL(redirectUri);
  return new Promise((resolve, reject) => {
    const request = http.request({ host: '127.0.0.1', port: base.port, method, path: route ?? base.pathname + base.search,
      headers: { Host: host ?? base.host }, agent: false }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    request.on('error', reject);
    request.end();
  });
}
const callbackPath = (redirectUri, params) => `${new URL(redirectUri).pathname}?${new URLSearchParams(params)}`;

async function signedIn(f = fixture()) {
  const done = f.auth.signIn();
  const url = new URL(await f.opened$());
  const redirect = url.searchParams.get('redirect_uri');
  const reply = await hit(redirect, { path: callbackPath(redirect, { code: CODE, state: url.searchParams.get('state'), scope: 'openid offline profile' }) });
  assert.equal(reply.status, 200);
  assert.equal((await done).status, 'signed-in');
  return { ...f, url, redirect };
}

test('forced authorization is single-flight and cancel preserves the prior grant and access token',async()=>{
 const f=await signedIn();const first=f.auth.signIn({force:true}),second=f.auth.signIn({force:true});assert.equal(first,second);await f.opened$(2);await f.auth.cancelSignIn();assert.equal((await first).status,'signed-in');assert.equal(f.store.value,tokenSet(1).refresh);assert.equal(await f.auth.getAccessToken(),tokenSet(1).access);f.auth.dispose();
});
test('forced authorization replaces the grant only after a successful independent code exchange',async()=>{
 let issued=0;const f=await signedIn(fixture({token:()=>grant(++issued)}));const done=f.auth.signIn({force:true}),url=new URL(await f.opened$(2)),redirect=url.searchParams.get('redirect_uri');await hit(redirect,{path:callbackPath(redirect,{code:CODE,state:url.searchParams.get('state')})});assert.equal((await done).status,'signed-in');assert.equal(f.store.value,tokenSet(2).refresh);assert.equal(await f.auth.getAccessToken(),tokenSet(2).access);f.auth.dispose();
});
test('cancel during replacement persistence rolls back the previous grant; concurrent sign-out cannot revive it',async()=>{
 for(const signingOut of [false,true]){
  let issued=0;const f=await signedIn(fixture({token:()=>grant(++issued)}));let release;f.store.gate=new Promise(r=>release=r);
  const done=f.auth.signIn({force:true}),url=new URL(await f.opened$(2)),redirect=url.searchParams.get('redirect_uri');await hit(redirect,{path:callbackPath(redirect,{code:CODE,state:url.searchParams.get('state')})});while(f.calls.filter(c=>c.body.grant_type==='authorization_code').length<2)await tick();await tick();
  const interrupted=signingOut?f.auth.signOut():f.auth.cancelSignIn();release();await interrupted;await done;assert.equal(f.store.value,signingOut?null:tokenSet(1).refresh);assert.equal(f.auth.state.status,signingOut?'signed-out':'signed-in');f.auth.dispose();
 }
});
test('a replacement waits for in-flight refresh rotation, then cancellation preserves the rotated grant',async()=>{
 let finishRefresh;const f=await signedIn(fixture({token:body=>body.grant_type==='refresh_token'?new Promise(r=>finishRefresh=r):grant(1)}));f.clock.t+=3600000;
 const refreshing=f.auth.getAccessToken();while(!finishRefresh)await tick();const replacement=f.auth.signIn({force:true});await tick();assert.equal(f.opened.length,1);finishRefresh(grant(2));await refreshing;await f.opened$(2);await f.auth.cancelSignIn();await replacement;assert.equal(f.store.value,tokenSet(2).refresh);assert.equal(await f.auth.getAccessToken(),tokenSet(2).access);f.auth.dispose();
});

test('replacement token endpoint failure retains the original usable authorization',async()=>{
 let issued=0;const f=await signedIn(fixture({token:()=>++issued===1?grant(1):json({error:'invalid_grant'},400)}));const done=f.auth.signIn({force:true}),url=new URL(await f.opened$(2)),redirect=url.searchParams.get('redirect_uri');await hit(redirect,{path:callbackPath(redirect,{code:CODE,state:url.searchParams.get('state')})});assert.equal((await done).status,'signed-in');assert(f.auth.state.error);assert.equal(f.store.value,tokenSet(1).refresh);assert.equal(await f.auth.getAccessToken(),tokenSet(1).access);f.auth.dispose();
});

// Everything the module may expose to the renderer or to logs, flattened.
function exposed(f, errors = []) {
  return JSON.stringify({ states: f.states, state: f.auth.state, errors: errors.map(error => ({ message: error?.message, code: error?.code })) });
}

test('authorization URL has the community-account shape, S256 challenge, exact loopback redirect and scope', async () => {
  const f = await signedIn();
  const { url, redirect } = f;
  assert.equal(url.origin, AUTH);
  assert.equal(url.pathname, '/oauth2/auth');
  assert.equal(url.hash, '');
  assert.deepEqual([...url.searchParams.keys()], ['client_id', 'redirect_uri', 'state', 'code_challenge', 'code_challenge_method', 'response_type', 'scope']);
  assert.equal(url.searchParams.get('client_id'), CLIENT);
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('scope'), 'openid offline profile');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.match(url.searchParams.get('state'), /^[A-Za-z0-9_-]{43}$/);
  assert.match(url.searchParams.get('code_challenge'), /^[A-Za-z0-9_-]{43}$/);
  assert.match(redirect, /^http:\/\/127\.0\.0\.1:[0-9]{4,5}\/oauth\/callback$/);
  assert.notEqual(new URL(redirect).port, '0');

  const exchange = f.calls.find(call => call.body.grant_type === 'authorization_code');
  assert.deepEqual(Object.keys(exchange.body).sort(), ['client_id', 'code', 'code_verifier', 'grant_type', 'redirect_uri']);
  assert.equal(exchange.body.client_id, CLIENT, 'public client: client_id only, no secret');
  assert.equal(exchange.body.code, CODE);
  assert.equal(exchange.body.redirect_uri, redirect);
  assert.match(exchange.body.code_verifier, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(crypto.createHash('sha256').update(exchange.body.code_verifier).digest('base64url'), url.searchParams.get('code_challenge'));
  assert.notEqual(exchange.body.code_verifier, url.searchParams.get('state'));
  assert.equal(exchange.init.redirect, 'error');
  assert.equal(exchange.init.method, 'POST');
  assert.ok(exchange.init.signal instanceof AbortSignal);
  assert.equal(exchange.init.headers.Authorization, undefined);
  assert.equal(await f.auth.getAccessToken(), tokenSet(1).access);
  assert.equal(f.store.value, tokenSet(1).refresh);
});

test('PKCE pair and authorization URL builder are deterministic for given bytes', () => {
  const bytes = n => Buffer.alloc(n, 7);
  const { verifier, challenge } = A.pkcePair(bytes);
  assert.equal(verifier, Buffer.alloc(32, 7).toString('base64url'));
  assert.equal(challenge, crypto.createHash('sha256').update(verifier).digest('base64url'));
  const href = A.buildAuthorizationUrl({ authUrl: AUTH, clientId: CLIENT, redirectUri: 'http://127.0.0.1:50000/oauth/callback',
    state: 's'.repeat(43), challenge });
  assert.equal(new URL(href).searchParams.get('redirect_uri'), 'http://127.0.0.1:50000/oauth/callback');
});

test('callback accepts one exact-state GET /oauth/callback and serves a static no-store done page', async () => {
  const f = fixture();
  const done = f.auth.signIn();
  const url = new URL(await f.opened$());
  const redirect = url.searchParams.get('redirect_uri');
  const state = url.searchParams.get('state');
  const rejected = [
    await hit(redirect, { path: callbackPath(redirect, { code: CODE, state: state.slice(0, -1) + (state.endsWith('A') ? 'B' : 'A') }) }),
    await hit(redirect, { path: callbackPath(redirect, { code: CODE, state: state + 'x' }) }),
    await hit(redirect, { path: callbackPath(redirect, { code: CODE }) }),
    await hit(redirect, { path: `/oauth/callback?code=${CODE}&state=${state}&state=${state}` }),
    await hit(redirect, { path: `/oauth/callback?code=${CODE}&state=${state}&extra=1` }),
    await hit(redirect, { path: `/oauth/other?${new URLSearchParams({ code: CODE, state })}` }),
    await hit(redirect, { path: `/oauth/callback/?${new URLSearchParams({ code: CODE, state })}` }),
    await hit(redirect, { path: '/' }),
    await hit(redirect, { method: 'POST', path: callbackPath(redirect, { code: CODE, state }) }),
    await hit(redirect, { host: `localhost:${new URL(redirect).port}`, path: callbackPath(redirect, { code: CODE, state }) }),
  ];
  for (const reply of rejected) {
    assert.ok(reply.status >= 400, String(reply.status));
    assert.doesNotMatch(reply.body, new RegExp(`${CODE}|${state}`));
  }
  assert.equal(f.calls.length, 0, 'no rejected request reaches the token endpoint');
  assert.equal(f.auth.state.status, 'authorizing');

  const ok = await hit(redirect, { path: callbackPath(redirect, { code: CODE, state, iss: `${AUTH}/` }) });
  assert.equal(ok.status, 200);
  assert.equal(ok.headers['cache-control'], 'no-store');
  assert.match(ok.headers['content-security-policy'], /default-src 'none'/);
  assert.equal(ok.headers['content-type'], 'text/html; charset=utf-8');
  assert.match(ok.body, /频道登录已完成/);
  assert.doesNotMatch(ok.body, /<script|fixture-code|http:\/\//);
  assert.equal((await done).status, 'signed-in');

  // The server is gone after the single accepted callback.
  await assert.rejects(hit(redirect, { path: callbackPath(redirect, { code: CODE, state }) }), /ECONNREFUSED|ECONNRESET|socket hang up/);
  assert.equal(f.calls.filter(call => call.body.grant_type === 'authorization_code').length, 1);
});

test('the callback server binds 127.0.0.1 only and closes after a denied authorization', async () => {
  const f = fixture();
  const done = f.auth.signIn();
  const url = new URL(await f.opened$());
  const redirect = url.searchParams.get('redirect_uri');
  const reply = await hit(redirect, { path: callbackPath(redirect, { error: 'access_denied', error_description: 'user said no',
    state: url.searchParams.get('state') }) });
  assert.equal(reply.status, 400);
  assert.doesNotMatch(reply.body, /user said no/);
  const result = await done;
  assert.equal(result.status, 'signed-out');
  assert.equal(result.error, A.SAFE_ERROR.denied);
  assert.equal(f.calls.length, 0);
  await assert.rejects(hit(redirect, { path: '/oauth/callback' }));
});

test('a callback naming a different issuer is rejected without a token exchange', async () => {
  const f = fixture();
  const done = f.auth.signIn();
  const url = new URL(await f.opened$());
  const redirect = url.searchParams.get('redirect_uri');
  const reply = await hit(redirect, { path: callbackPath(redirect, { code: CODE, state: url.searchParams.get('state'), iss: 'https://evil.example.test' }) });
  assert.equal(reply.status, 400);
  assert.equal((await done).error, A.SAFE_ERROR.protocol);
  assert.equal(f.calls.length, 0);
});

test('a callback arriving after the 5 minute window is refused and sign-in times out', async () => {
  assert.equal(A.CALLBACK_TTL_MS, 5 * 60 * 1000);
  const f = fixture();
  const done = f.auth.signIn();
  const url = new URL(await f.opened$());
  const redirect = url.searchParams.get('redirect_uri');
  f.clock.t += A.CALLBACK_TTL_MS + 1;
  const reply = await hit(redirect, { path: callbackPath(redirect, { code: CODE, state: url.searchParams.get('state') }) });
  assert.equal(reply.status, 410);
  const result = await done;
  assert.equal(result.status, 'signed-out');
  assert.equal(result.error, A.SAFE_ERROR.timeout);
  assert.equal(f.calls.length, 0);
});

test('the real-time callback deadline fires without any request', async () => {
  const f = fixture({ callbackTtlMs: 60 });
  const result = await f.auth.signIn();
  assert.equal(result.error, A.SAFE_ERROR.timeout);
  const redirect = new URL(f.opened[0]).searchParams.get('redirect_uri');
  await assert.rejects(hit(redirect, { path: '/oauth/callback' }));
});

test('sign-in can be canceled, and concurrent sign-in calls share one flow', async () => {
  const f = fixture();
  const first = f.auth.signIn(), second = f.auth.signIn();
  assert.equal(first, second);
  await f.opened$();
  const redirect = new URL(f.opened[0]).searchParams.get('redirect_uri');
  const canceled = await f.auth.cancelSignIn();
  assert.equal(canceled.status, 'signed-out');
  assert.equal(canceled.error, A.SAFE_ERROR.canceled);
  assert.equal(f.opened.length, 1);
  await assert.rejects(hit(redirect, { path: '/oauth/callback' }));
});

test('configured callback ports are tried in order', async () => {
  const blocker = http.createServer();
  await new Promise(resolve => blocker.listen(0, '127.0.0.1', resolve));
  const busy = blocker.address().port;
  const probe = http.createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const free = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  try {
    const f = fixture({ config: { oauthPorts: [busy, free] } });
    const done = f.auth.signIn();
    const redirect = new URL(await f.opened$()).searchParams.get('redirect_uri');
    assert.equal(redirect, `http://127.0.0.1:${free}/oauth/callback`);
    await f.auth.cancelSignIn();
    await done;

    const g = fixture({ config: { oauthPorts: [busy] } });
    const result = await g.auth.signIn();
    assert.equal(result.error, A.SAFE_ERROR.callback);
    assert.equal(g.opened.length, 0);
  } finally { await new Promise(resolve => blocker.close(resolve)); }
});

test('the callback listener is bound to 127.0.0.1 with an OS-assigned port', async () => {
  const listens = [];
  const spy = { createServer(...args) {
    const server = http.createServer(...args);
    const listen = server.listen.bind(server);
    server.listen = (options, ...rest) => { listens.push(options); return listen(options, ...rest); };
    return server;
  } };
  const f = fixture({ http: spy });
  const done = f.auth.signIn();
  await f.opened$();
  assert.deepEqual(listens, [{ host: '127.0.0.1', port: 0, exclusive: true }]);
  await f.auth.cancelSignIn();
  await done;
});

test('token responses are validated before anything is stored', async () => {
  const valid = { access_token: tokenSet(1).access, refresh_token: tokenSet(1).refresh, token_type: 'Bearer', expires_in: 3600 };
  assert.deepEqual(A.validateTokenResponse(valid, { requireRefresh: true }), { access: tokenSet(1).access, refresh: tokenSet(1).refresh, expiresIn: 3600 });
  assert.equal(A.validateTokenResponse({ ...valid, refresh_token: undefined }, { requireRefresh: false }).refresh, null);
  for (const bad of [null, [], { ...valid, token_type: 'mac' }, { ...valid, token_type: undefined }, { ...valid, access_token: 'short' },
    { ...valid, access_token: 'has space'.repeat(4) }, { ...valid, access_token: 7 }, { ...valid, expires_in: 0 }, { ...valid, expires_in: '3600' },
    { ...valid, expires_in: 1.5 }, { ...valid, expires_in: 10 ** 9 }, { ...valid, refresh_token: valid.access_token },
    { ...valid, refresh_token: 42 }, { ...valid, scope: 'openid profile' }, { ...valid, scope: ['openid'] }]) {
    assert.throws(() => A.validateTokenResponse(bad, { requireRefresh: false }), error => error.code === 'protocol' && error.message === A.SAFE_ERROR.protocol);
  }
  assert.throws(() => A.validateTokenResponse({ ...valid, refresh_token: undefined }, { requireRefresh: true }), { code: 'protocol' });

  const cases = [
    [() => json({ access_token: tokenSet(1).access, token_type: 'bearer', expires_in: 3600 }), A.SAFE_ERROR.protocol],
    [() => new Response('not json', { status: 200 }), A.SAFE_ERROR.protocol],
    [() => json({ error: 'invalid_grant', error_description: `code ${CODE} used` }, 400), A.SAFE_ERROR.rejected],
    [() => json({ error: 'invalid_client' }, 401), A.SAFE_ERROR.protocol],
    [() => json({ error: 'server_error' }, 503), A.SAFE_ERROR.unavailable],
    [() => { throw new TypeError(`redirect mode is set to error: ${CODE}`); }, A.SAFE_ERROR.unavailable],
    [() => new Response('x'.repeat(A.MAX_RESPONSE_BYTES + 1), { status: 200 }), A.SAFE_ERROR.protocol],
    [() => new Response(new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array(16384)); } }), { status: 200 }), A.SAFE_ERROR.protocol],
  ];
  for (const [token, error] of cases) {
    const f = fixture({ token });
    const done = f.auth.signIn();
    const url = new URL(await f.opened$());
    const redirect = url.searchParams.get('redirect_uri');
    await hit(redirect, { path: callbackPath(redirect, { code: CODE, state: url.searchParams.get('state') }) });
    const result = await done;
    assert.equal(result.status, 'signed-out');
    assert.equal(result.error, error);
    assert.equal(f.store.value, null, 'nothing is persisted from a rejected exchange');
    assert.deepEqual(f.store.log, []);
    assert.doesNotMatch(exposed(f), new RegExp(`${CODE}|fixture-access|fixture-refresh|server_error|invalid_`));
  }
});

test('token requests time out with a fixed error', async () => {
  const f = fixture({ requestTimeoutMs: 30, token: (body, init) => new Promise((resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
  }) });
  const done = f.auth.signIn();
  const url = new URL(await f.opened$());
  const redirect = url.searchParams.get('redirect_uri');
  await hit(redirect, { path: callbackPath(redirect, { code: CODE, state: url.searchParams.get('state') }) });
  assert.equal((await done).error, A.SAFE_ERROR.timeout);
});

test('sign-in refuses to start when only basic_text (plaintext) storage is available', async () => {
  const f = fixture({ store: memoryStore({ available: false }) });
  const result = await f.auth.signIn();
  assert.equal(result.status, 'signed-out');
  assert.equal(result.error, A.SAFE_ERROR.storage);
  assert.equal(f.opened.length, 0, 'the browser is not opened when the grant could not be kept');
  assert.equal(f.calls.length, 0);

  // Real WorkbenchSecretStore with a fake safeStorage reporting the basic_text backend.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'neko-lobby-auth-'));
  try {
    const safeStorage = { isEncryptionAvailable: () => true, getSelectedStorageBackend: () => 'basic_text',
      encryptString: value => Buffer.from(value), decryptString: buffer => buffer.toString() };
    const store = new WorkbenchSecretStore(path.join(dir, 'lobby', 'secrets', 'refresh-token.encrypted'), safeStorage);
    const g = fixture({ store });
    assert.equal((await g.auth.signIn()).error, A.SAFE_ERROR.storage);
    assert.equal(fs.existsSync(path.join(dir, 'lobby')), false, 'no plaintext fallback file');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('storage that turns unavailable mid-flow drops the grant instead of signing in', async () => {
  const store = memoryStore();
  const f = fixture({ store });
  const done = f.auth.signIn();
  const url = new URL(await f.opened$());
  store.availableFlag = false;
  const redirect = url.searchParams.get('redirect_uri');
  await hit(redirect, { path: callbackPath(redirect, { code: CODE, state: url.searchParams.get('state') }) });
  const result = await done;
  assert.equal(result.status, 'signed-out');
  assert.equal(result.error, A.SAFE_ERROR.storage);
  await assert.rejects(f.auth.getAccessToken(), { code: 'login' });
});

test('a stored grant is not reported as signed in while encrypted storage is unavailable', () => {
  const f = fixture({ store: memoryStore({ available: false, value: tokenSet(0).refresh }) });
  assert.equal(f.auth.state.status, 'signed-out');
  assert.equal(f.auth.state.error, A.SAFE_ERROR.storage);
  const g = fixture({ store: memoryStore({ value: tokenSet(0).refresh }) });
  assert.equal(g.auth.state.status, 'signed-in');
  const h = A.createLobbyAuth({ config: { configured: false }, secretStore: memoryStore(), fetchImpl: async () => assert.fail('no fetch') });
  assert.equal(h.state.status, 'unconfigured');
  assert.equal(h.state.message, A.SAFE_ERROR.unconfigured);
});

const refreshCalls = f => f.calls.filter(call => call.body.grant_type === 'refresh_token');

test('access tokens are cached in memory and refreshed shortly before expiry', async () => {
  let n = 1;
  const f = await signedIn(fixture({ token: () => grant(n++) }));
  assert.equal(await f.auth.getAccessToken(), tokenSet(1).access);
  f.clock.t += 3600 * 1000 - 61000;
  assert.equal(await f.auth.getAccessToken(), tokenSet(1).access);
  assert.equal(refreshCalls(f).length, 0);
  f.clock.t += 2000;
  assert.equal(await f.auth.getAccessToken(), tokenSet(2).access);
  const [call] = refreshCalls(f);
  assert.deepEqual(call.body, { grant_type: 'refresh_token', refresh_token: tokenSet(1).refresh, client_id: CLIENT });
  assert.equal(call.init.redirect, 'error');
  assert.equal(f.store.value, tokenSet(2).refresh);
  f.auth.invalidateAccessToken();
  assert.equal(await f.auth.getAccessToken(), tokenSet(3).access);
  assert.equal(await f.auth.getAccessToken({ forceRefresh: true }), tokenSet(4).access);
});

test('refresh is single-flight and persists the rotated refresh token before using the new access token', async () => {
  let n = 1;
  const f = await signedIn(fixture({ token: () => grant(n++) }));
  let release;
  f.store.gate = new Promise(resolve => { release = resolve; });
  f.store.log.length = 0;
  f.auth.invalidateAccessToken();
  const results = [f.auth.getAccessToken(), f.auth.getAccessToken(), f.auth.refresh()];
  let settled = false;
  Promise.all(results).then(() => { settled = true; });
  for (let i = 0; i < 20; i++) await tick();
  assert.equal(refreshCalls(f).length, 1, 'one refresh request for concurrent callers');
  assert.deepEqual(f.store.log, ['get', 'set:start']);
  assert.equal(settled, false, 'the new access token is not handed out before the rotated refresh token is stored');
  assert.equal(f.auth.accessExpiresAt, null);
  release();
  assert.deepEqual(await Promise.all(results), [tokenSet(2).access, tokenSet(2).access, tokenSet(2).access]);
  assert.deepEqual(f.store.log, ['get', 'set:start', 'set:done']);
  assert.equal(f.store.value, tokenSet(2).refresh);

  // A response without a new refresh token keeps the stored one.
  const g = await signedIn(fixture({ token: body => body.grant_type === 'refresh_token'
    ? json({ access_token: tokenSet(9).access, token_type: 'bearer', expires_in: 600 }) : grant(1) }));
  g.auth.invalidateAccessToken();
  assert.equal(await g.auth.getAccessToken(), tokenSet(9).access);
  assert.equal(g.store.value, tokenSet(1).refresh);
});

test('a rotated refresh token that cannot be stored signs out instead of using the new access token', async () => {
  let n = 1;
  const f = await signedIn(fixture({ token: () => grant(n++) }));
  f.store.failSet = true;
  f.auth.invalidateAccessToken();
  await assert.rejects(f.auth.getAccessToken(), error => error.code === 'storage' && error.message === A.SAFE_ERROR.storage);
  assert.equal(f.auth.state.status, 'signed-out');
  assert.equal(f.store.value, null);
  await assert.rejects(f.auth.getAccessToken(), { code: 'login' });
});

test('invalid_grant clears the store and signs out; transient failures keep the grant', async () => {
  let mode = 'grant', n = 1;
  const f = await signedIn(fixture({ token: () => mode === 'grant' ? grant(n++)
    : mode === 'down' ? json({ error: 'temporarily_unavailable' }, 503)
      : json({ error: 'invalid_grant', error_description: `refresh ${tokenSet(1).refresh} revoked` }, 400) }));
  mode = 'down';
  f.auth.invalidateAccessToken();
  await assert.rejects(f.auth.getAccessToken(), error => error.code === 'unavailable' && error.message === A.SAFE_ERROR.unavailable);
  assert.equal(f.auth.state.status, 'signed-in');
  assert.equal(f.auth.state.error, A.SAFE_ERROR.unavailable);
  assert.equal(f.store.value, tokenSet(1).refresh);

  mode = 'grant';
  assert.equal(await f.auth.getAccessToken(), tokenSet(2).access);
  assert.equal(f.auth.state.error, '');

  mode = 'revoked';
  f.auth.invalidateAccessToken();
  const errors = [];
  await f.auth.getAccessToken().catch(error => errors.push(error));
  assert.equal(errors[0].code, 'expired');
  assert.equal(f.auth.state.status, 'signed-out');
  assert.equal(f.auth.state.error, A.SAFE_ERROR.expired);
  assert.equal(f.store.value, null);
  assert.ok(f.store.log.includes('clear'));
  await assert.rejects(f.auth.getAccessToken(), { code: 'login' });
  assert.doesNotMatch(exposed(f, errors), /fixture-|invalid_grant|revoked/);
});

test('sign-out revokes best-effort, clears the store and drops an in-flight refresh', async () => {
  let n = 1;
  const f = await signedIn(fixture({ token: () => grant(n++), revoke: () => { throw new TypeError('offline'); } }));
  const result = await f.auth.signOut();
  assert.equal(result.status, 'signed-out');
  assert.equal(result.error, '');
  assert.equal(f.store.value, null);
  const revoked = f.calls.filter(call => call.url === `${AUTH}/oauth2/revoke`);
  assert.deepEqual(revoked.map(call => call.body).sort((a, b) => a.token.localeCompare(b.token)),
    [{ token: tokenSet(1).access, client_id: CLIENT }, { token: tokenSet(1).refresh, client_id: CLIENT }]);
  assert.ok(revoked.every(call => call.init.redirect === 'error' && call.init.signal instanceof AbortSignal));
  await assert.rejects(f.auth.getAccessToken(), { code: 'login' });

  // Sign-out while a rotation is being written: the rotated token does not survive.
  const g = await signedIn(fixture({ token: () => grant(n++) }));
  let release;
  g.store.gate = new Promise(resolve => { release = resolve; });
  g.auth.invalidateAccessToken();
  const pending = g.auth.getAccessToken();
  for (let i = 0; i < 20; i++) await tick();
  const signOut = g.auth.signOut();
  release();
  await signOut;
  await assert.rejects(pending, { code: 'canceled' });
  for (let i = 0; i < 20; i++) await tick();
  assert.equal(g.store.value, null);
  assert.equal(g.auth.state.status, 'signed-out');
});

test('tokens, code, verifier and state never appear in snapshots, errors or the callback page', async () => {
  let n = 1;
  const f = fixture({ token: () => grant(n++) });
  const errors = [];
  const done = f.auth.signIn();
  const url = new URL(await f.opened$());
  const redirect = url.searchParams.get('redirect_uri');
  const page = await hit(redirect, { path: callbackPath(redirect, { code: CODE, state: url.searchParams.get('state') }) });
  await done;
  f.auth.invalidateAccessToken();
  await f.auth.getAccessToken();
  f.store.failSet = true;
  f.auth.invalidateAccessToken();
  await f.auth.getAccessToken().catch(error => errors.push(error));
  await f.auth.signOut();
  const verifier = f.calls.find(call => call.body.code_verifier).body.code_verifier;
  const secrets = [CODE, verifier, url.searchParams.get('state'), url.searchParams.get('code_challenge'),
    tokenSet(1).access, tokenSet(1).refresh, tokenSet(2).access, tokenSet(2).refresh, 'fixture.id.token'];
  const surface = exposed(f, errors) + page.body + JSON.stringify(Object.keys(f.auth));
  for (const secret of secrets) assert.ok(!surface.includes(secret), 'secret leaked into an exposed surface');
  for (const state of f.states) assert.deepEqual(Object.keys(state).sort(), ['error', 'message', 'signedIn', 'status']);
  assert.ok(Object.isFrozen(f.auth));
  assert.equal(Object.values(A.SAFE_ERROR).every(text => typeof text === 'string' && !/https?:/.test(text)), true);
});

test('dispose stops a pending sign-in and keeps a stored grant for the next launch', async () => {
  const f = await signedIn();
  f.auth.dispose();
  assert.equal(f.store.value, tokenSet(1).refresh);
  await assert.rejects(f.auth.getAccessToken(), { code: 'unconfigured' });

  const g = fixture();
  const done = g.auth.signIn();
  const redirect = new URL(await g.opened$()).searchParams.get('redirect_uri');
  g.auth.dispose();
  await done;
  await assert.rejects(hit(redirect, { path: '/oauth/callback' }));
  assert.equal(g.calls.length, 0);
});
