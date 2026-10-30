const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { createOAuthSession } = require('../../apps/neko-workbench/visits/oauth.cjs');
const key = crypto.randomBytes(32);
const safeStorage = {
  isEncryptionAvailable: () => true,
  encryptString(value) { const iv = crypto.randomBytes(12); const cipher = crypto.createCipheriv('aes-256-gcm', key, iv); const data = Buffer.concat([cipher.update(value), cipher.final()]); return Buffer.concat([iv, cipher.getAuthTag(), data]); },
  decryptString(value) { const cipher = crypto.createDecipheriv('aes-256-gcm', key, value.subarray(0, 12)); cipher.setAuthTag(value.subarray(12, 28)); return Buffer.concat([cipher.update(value.subarray(28)), cipher.final()]).toString(); },
};
async function config(t, extra = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'neko-visit-oauth-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const listener = http.createServer();
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  return { authorizationUrl: 'https://auth.example.test/oauth2/auth', tokenUrl: 'https://auth.example.test/oauth2/token',
    clientId: 'registered-workbench', redirectUri: `http://127.0.0.1:${port}/oauth/callback`, safeStorage,
    tokenFile: path.join(dir, 'oauth.bin'), loginTimeoutMs: 2000, ...extra };
}
function reply(body = {}) { return new Response(JSON.stringify({ access_token: 'fake-access', refresh_token: 'fake-refresh', token_type: 'Bearer', expires_in: 120, ...body })); }
function callbackUrl(authorize, extra = {}) { const url = new URL(authorize); const callback = new URL(url.searchParams.get('redirect_uri')); callback.search = new URLSearchParams({ code: 'fake-code', state: url.searchParams.get('state'), ...extra }); return callback; }

test('PKCE loopback flow opens once, validates state, exchanges exactly once and persists only ciphertext', async t => {
  let opens = 0, exchanges = 0, challenge;
  const options = await config(t, {
    async openExternal(url) {
      opens++; const auth = new URL(url);
      assert.equal(auth.searchParams.get('code_challenge_method'), 'S256'); challenge = auth.searchParams.get('code_challenge');
      const bad = callbackUrl(url, { state: 'wrong', error: 'access_denied' });
      assert.equal((await fetch(bad)).status, 400);
      assert.equal((await fetch(callbackUrl(url))).status, 200);
    },
    async fetch(url, init) {
      exchanges++; assert.equal(url, 'https://auth.example.test/oauth2/token'); assert.equal(init.redirect, 'error');
      const params = new URLSearchParams(init.body);
      assert.equal(params.get('client_id'), 'registered-workbench'); assert.equal(params.get('grant_type'), 'authorization_code');
      assert.equal(crypto.createHash('sha256').update(params.get('code_verifier')).digest('base64url'), challenge);
      return reply();
    },
  });
  const session = createOAuthSession(options); t.after(() => session.close());
  const first = session.login(); assert.equal(session.login(), first);
  assert.deepEqual(await first, { authenticated: true, loginPending: false });
  assert.equal(await session.getAccessToken(), 'fake-access'); assert.equal(opens, 1); assert.equal(exchanges, 1);
  const stored = await fs.readFile(options.tokenFile); assert(!stored.includes(Buffer.from('fake-access'))); assert(!stored.includes(Buffer.from('fake-refresh')));
  await assert.rejects(fetch(options.redirectUri), /fetch failed/);
  const restored = createOAuthSession(options); t.after(() => restored.close());
  assert.equal(await restored.getAccessToken(), 'fake-access');
});
test('occupied callback port fails before browser launch and permits retry after release', async t => {
  let opens = 0;
  const options = await config(t, {
    openExternal: async url => { opens++; await fetch(callbackUrl(url)); },
    fetch: async () => reply(),
  });
  const occupied = http.createServer();
  await new Promise(resolve => occupied.listen(Number(new URL(options.redirectUri).port), '127.0.0.1', resolve));
  t.after(() => { if (occupied.listening) occupied.close(); });
  const session = createOAuthSession(options); t.after(() => session.close());
  await assert.rejects(session.login(), { code: 'oauth_callback_unavailable' });
  assert.equal(opens, 0);
  assert.equal(session.status().loginPending, false);
  await new Promise(resolve => occupied.close(resolve));
  assert.equal((await session.login()).authenticated, true);
  assert.equal(opens, 1);
});

test('refresh coalesces, rotates tokens and logout prevents an in-flight refresh from restoring login', async t => {
  let clock = 100000, calls = 0, resolveRefresh, enteredRefresh;
  const refreshEntered = new Promise(resolve => { enteredRefresh = resolve; });
  const options = await config(t, {
    now: () => clock,
    openExternal: url => fetch(callbackUrl(url)),
    fetch: async (_url, init) => {
      calls++; const params = new URLSearchParams(init.body);
      if (params.get('grant_type') === 'authorization_code') return reply();
      assert.equal(params.get('refresh_token'), 'fake-refresh');
      return new Promise(resolve => { resolveRefresh = resolve; enteredRefresh(); });
    },
  });
  const session = createOAuthSession(options); t.after(() => session.close());
  await session.login(); clock += 121000;
  const a = session.getAccessToken(), b = session.getAccessToken();
  await refreshEntered;
  const rejected = Promise.allSettled([a, b]);
  await session.logout(); resolveRefresh(reply({ access_token: 'rotated-access', refresh_token: 'rotated-refresh' }));
  const results = await rejected; assert(results.every(result => result.status === 'rejected'));
  assert.equal(calls, 2); assert.equal(await session.getAccessToken(), null);
  await assert.rejects(fs.stat(options.tokenFile), { code: 'ENOENT' });
});
test('a cancelled login exchange cannot save tokens, and close releases the callback port', async t => {
  let resolveExchange, entered;
  const waiting = new Promise(resolve => { entered = resolve; });
  const options = await config(t, { openExternal: url => fetch(callbackUrl(url)), fetch: () => new Promise(resolve => { resolveExchange = resolve; entered(); }) });
  const session = createOAuthSession(options);
  const result = assert.rejects(session.login(), { code: 'login_cancelled' });
  await waiting; session.close(); resolveExchange(reply()); await result;
  await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(fs.stat(options.tokenFile), { code: 'ENOENT' });
  await assert.rejects(fetch(options.redirectUri), /fetch failed/);
});
test('successful refresh rotates the family and preserves the last refresh token when omitted', async t => {
  let clock = 100000, refreshCount = 0;
  const options = await config(t, { now: () => clock, openExternal: url => fetch(callbackUrl(url)),
    fetch: async (_url, init) => {
      const params = new URLSearchParams(init.body);
      if (params.get('grant_type') === 'authorization_code') return reply();
      refreshCount++;
      assert.equal(params.get('refresh_token'), refreshCount === 1 ? 'fake-refresh' : 'rotated-refresh');
      if (refreshCount === 1) return reply({ access_token: 'rotated-access', refresh_token: 'rotated-refresh' });
      return reply({ access_token: 'later-access', refresh_token: undefined });
    } });
  const session = createOAuthSession(options); t.after(() => session.close());
  await session.login(); clock += 121000;
  assert.equal(await session.getAccessToken(), 'rotated-access'); clock += 121000;
  assert.equal(await session.getAccessToken(), 'later-access'); clock += 121000;
  assert.equal(await session.getAccessToken(), 'later-access'); assert.equal(refreshCount, 3);
});
test('invalid refresh clears the persisted session and a different client cannot load it', async t => {
  let clock = 100000;
  const options = await config(t, { now: () => clock, openExternal: url => fetch(callbackUrl(url)),
    fetch: async (_url, init) => new URLSearchParams(init.body).get('grant_type') === 'authorization_code' ? reply() :
      new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 }) });
  const session = createOAuthSession(options); t.after(() => session.close()); await session.login();
  const wrongClient = createOAuthSession({ ...options, clientId: 'different-client' }); t.after(() => wrongClient.close());
  await assert.rejects(wrongClient.getAccessToken(), { code: 'token_store_unavailable' });
  clock += 121000;
  await assert.rejects(session.getAccessToken(), { status: 400 });
  assert.equal(await session.getAccessToken(), null);
  await assert.rejects(fs.stat(options.tokenFile), { code: 'ENOENT' });
});
test('times out and rejects unavailable encryption before opening a browser', async t => {
  const options = await config(t, { openExternal() {}, loginTimeoutMs: 20 });
  const session = createOAuthSession(options); t.after(() => session.close());
  await assert.rejects(session.login(), { code: 'login_timeout' });
  await assert.rejects(fetch(options.redirectUri), /fetch failed/);
  const insecure = createOAuthSession({ ...options, safeStorage: { ...safeStorage, getSelectedStorageBackend: () => 'basic_text' } });
  await assert.rejects(insecure.login(), { code: 'secure_storage_unavailable' }); insecure.close();
});
test('timeout deletes a token rename already in flight before settling and cannot restore it', async t => {
  let releaseRename, notifyRename;
  const renameStarted = new Promise(resolve => { notifyRename = resolve; });
  const renameGate = new Promise(resolve => { releaseRename = resolve; });
  const options = await config(t, { openExternal: url => fetch(callbackUrl(url)), fetch: async () => reply(), loginTimeoutMs: 100 });
  const originalRename = fs.rename;
  fs.rename = async (from, to) => {
    if (to === options.tokenFile) { notifyRename(); await renameGate; }
    return originalRename(from, to);
  };
  t.after(() => { fs.rename = originalRename; releaseRename(); });
  const session = createOAuthSession(options); t.after(() => session.close());
  let settled = false;
  const rejected = assert.rejects(session.login(), { code: 'login_timeout' }).then(() => { settled = true; });
  await renameStarted;
  await new Promise(resolve => setTimeout(resolve, 125));
  assert.equal(settled, false, 'failure awaits the fenced disk cleanup');
  releaseRename(); await rejected;
  assert.equal(await session.getAccessToken(), null);
  assert.deepEqual(session.status(), { authenticated: false, loginPending: false });
  await assert.rejects(fs.stat(options.tokenFile), { code: 'ENOENT' });
  const restored = createOAuthSession(options); t.after(() => restored.close());
  assert.equal(await restored.getAccessToken(), null, 'restart cannot restore the cancelled login');
});
test('browser failure after callback fences an already-started token rename', async t => {
  let releaseRename, notifyRename;
  const renameStarted = new Promise(resolve => { notifyRename = resolve; });
  const renameGate = new Promise(resolve => { releaseRename = resolve; });
  const options = await config(t, { fetch: async () => reply(),
    async openExternal(url) { await fetch(callbackUrl(url)); await renameStarted; throw new Error('simulated browser launcher failure'); } });
  const originalRename = fs.rename;
  fs.rename = async (from, to) => {
    if (to === options.tokenFile) { notifyRename(); await renameGate; }
    return originalRename(from, to);
  };
  t.after(() => { fs.rename = originalRename; releaseRename(); });
  const session = createOAuthSession(options); t.after(() => session.close());
  const rejected = assert.rejects(session.login(), { code: 'browser_open_failed' });
  await renameStarted;
  await new Promise(resolve => setImmediate(resolve));
  releaseRename(); await rejected;
  assert.equal(await session.getAccessToken(), null);
  await assert.rejects(fs.stat(options.tokenFile), { code: 'ENOENT' });
});
test('rejects malformed callbacks and unregistered-style/unsafe configuration', async t => {
  const options = await config(t, { openExternal: url => fetch(callbackUrl(url, { error: 'access_denied' })) });
  const session = createOAuthSession(options); t.after(() => session.close());
  await assert.rejects(session.login(), { code: 'login_declined' });
  for (const extra of [ { redirectUri: 'https://evil.test/oauth/callback' }, { redirectUri: 'http://0.0.0.0:8080/oauth/callback' },
    { redirectUri: 'http://127.0.0.1:0/oauth/callback' }, { tokenUrl: 'https://other.test/oauth2/token' },
    { authorizationUrl: 'http://auth.example.test/oauth2/auth' }, { tokenFile: 'relative.bin' } ]) {
    assert.throws(() => createOAuthSession({ ...options, ...extra }));
  }
});
