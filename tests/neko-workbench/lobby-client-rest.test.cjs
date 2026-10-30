'use strict';
// Locks the REST half of lobby-client.cjs against docs/protocol.md v1 and the
// plan's REST list: Bearer header, one refresh + retry on 401, redirect:'error',
// timeouts, 64 KB / 512 KB caps, fixed zh-CN error text (server detail never
// echoed), cursor and argument checks, admin endpoints. Injected fetch and auth
// only; synthetic hosts, ids and tokens; nothing leaves the process.
const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../../apps/neko-workbench/lobby-client.cjs');

const CHAT = 'https://chat.example.test/';
const API = 'https://chat.example.test/api/v1';
const CONFIG = Object.freeze({ configured: true, chatUrl: CHAT });
const U = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const CH = U(1), ALICE = U(2), BOB = U(3), KITTY = U(4), M1 = U(10), A1 = U(30);
const TOKEN_1 = 'fixture-access-1-aaaaaaaaaaaaaaaaaaaaaaaa';
const TOKEN_2 = 'fixture-access-2-bbbbbbbbbbbbbbbbbbbbbbbb';
const LEAK = 'fixture-server-leak-Zq81 <script>';

const json = (value, status = 200, headers = {}) => new Response(JSON.stringify(value),
  { status, headers: { 'Content-Type': 'application/json', ...headers } });

function fakeAuth({ tokens = [TOKEN_1, TOKEN_2], fail = null } = {}) {
  const auth = { calls: [], invalidated: 0, index: 0 };
  auth.getAccessToken = async ({ forceRefresh = false } = {}) => {
    auth.calls.push(forceRefresh);
    if (fail) throw Object.assign(new Error(LEAK), { code: fail });
    if (forceRefresh) auth.index = Math.min(auth.index + 1, tokens.length - 1);
    return tokens[auth.index];
  };
  auth.invalidateAccessToken = () => { auth.invalidated += 1; };
  return auth;
}

// routes: array of (request) => Response, consumed in order.
function fakeFetch(...routes) {
  const requests = [];
  const fetchImpl = async (url, init) => {
    requests.push({ url, ...init, headers: { ...init.headers } });
    const route = routes.shift();
    if (!route) throw new Error('unexpected request');
    return route({ url, ...init });
  };
  return { fetchImpl, requests };
}

const client = (fetch, auth = fakeAuth(), extra = {}) => C.createLobbyRest({ config: CONFIG, auth, fetchImpl: fetch.fetchImpl, ...extra });
const channel = (extra = {}) => ({ id: CH, name: '大厅', topic: '', slow_mode_seconds: 0, cats_enabled: true,
  cat_free_mode_allowed: false, last_seq: 3, ...extra });
const human = (extra = {}) => ({ kind: 'human', user_id: ALICE, name: '张三', display_name: '张三',
  avatar: { kind: 'hue', hue: 210, text: '张' }, ...extra });
const catView = (extra = {}) => ({ id: KITTY, owner_user_id: ALICE, owner_name: '张三', name: '大肥鱼',
  display_name: '张三的大肥鱼', avatar_key: 'fish-blue', reply_mode: 'mention', enabled: true, admin_disabled: false, ...extra });
const message = (seq, extra = {}) => ({ id: U(100 + seq), seq, channel_id: CH, created_at: 1730000000000 + seq, deleted: false,
  text: `第${seq}条`, origin: 'human', label: '张三', author: human(), mentions: [], reply_to: null, cat_depth: 0, ...extra });
const page = (messages, extra = {}) => ({ messages, next_before_seq: null, has_more: false, ...extra });

async function rejectsWith(promise, code) {
  const error = await promise.then(() => null, e => e);
  assert.ok(error instanceof Error, `expected rejection ${code}`);
  assert.equal(error.code, code);
  assert.equal(error.message, C.SAFE_ERROR[code]);
  assert.ok(!error.message.includes(LEAK) && !String(error.stack).includes(LEAK));
  return error;
}

test('every request carries the Bearer token, no-redirect, no cookies, under /api/v1', async () => {
  const fetch = fakeFetch(() => json(channel()));
  const result = await client(fetch).lobby();
  assert.deepEqual(result, channel());
  const [request] = fetch.requests;
  assert.equal(request.url, `${API}/channels/lobby`);
  assert.equal(request.method, 'GET');
  assert.equal(request.redirect, 'error');
  assert.equal(request.credentials, 'omit');
  assert.equal(request.cache, 'no-store');
  assert.equal(request.headers.Authorization, `Bearer ${TOKEN_1}`);
  assert.equal(request.body, undefined);
  assert.ok(!request.url.includes(TOKEN_1));
  assert.ok(request.signal instanceof AbortSignal);
});

test('a path prefix in the chat URL is kept; unconfigured clients never fetch', async () => {
  assert.equal(C.apiBase('https://chat.example.test/neko/'), 'https://chat.example.test/neko/api/v1');
  assert.equal(C.apiBase('http://127.0.0.1:8080'), 'http://127.0.0.1:8080/api/v1');
  const fetch = fakeFetch();
  const rest = C.createLobbyRest({ config: { configured: false }, auth: fakeAuth(), fetchImpl: fetch.fetchImpl });
  assert.equal(rest.configured, false);
  await rejectsWith(rest.me(), 'unconfigured');
  assert.equal(fetch.requests.length, 0);
});

test('401 drops the in-memory token, refreshes once and retries with the new token', async () => {
  const auth = fakeAuth();
  const fetch = fakeFetch(() => json({ detail: 'invalid_token' }, 401), () => json(channel()));
  assert.deepEqual(await client(fetch, auth).lobby(), channel());
  assert.deepEqual(auth.calls, [false, true]);
  assert.equal(auth.invalidated, 1);
  assert.deepEqual(fetch.requests.map(r => r.headers.Authorization), [`Bearer ${TOKEN_1}`, `Bearer ${TOKEN_2}`]);
});

test('a second 401 stops after one retry with the fixed expired error', async () => {
  const auth = fakeAuth();
  const fetch = fakeFetch(() => json({ detail: LEAK }, 401), () => json({ detail: 'invalid_token' }, 401));
  const error = await rejectsWith(client(fetch, auth).me(), 'expired');
  assert.equal(error.status, 401);
  assert.equal(fetch.requests.length, 2);
  assert.equal(auth.invalidated, 2);
});

test('auth failures map to fixed codes and never reach the network', async () => {
  for (const [code, expected] of [['login', 'login'], ['rejected', 'expired'], ['storage', 'storage'],
    ['unconfigured', 'unconfigured'], ['protocol', 'login'], ['something_else', 'login']]) {
    const fetch = fakeFetch();
    await rejectsWith(client(fetch, fakeAuth({ fail: code })).me(), expected);
    assert.equal(fetch.requests.length, 0);
  }
  const refreshFails = fakeAuth();
  const fetch = fakeFetch(() => json({}, 401));
  const original = refreshFails.getAccessToken;
  refreshFails.getAccessToken = async options => {
    if (options?.forceRefresh) throw Object.assign(new Error(LEAK), { code: 'rejected' });
    return original(options);
  };
  await rejectsWith(client(fetch, refreshFails).me(), 'expired');
  assert.equal(fetch.requests.length, 1);
});
test('server detail codes map through the fixed zh-CN table; unknown text is never echoed', async () => {
  const cases = [
    [{ detail: 'channel_muted' }, 403, 'channel_muted'],
    [{ detail: 'cat_mode_not_allowed' }, 400, 'cat_mode_not_allowed'],
    [{ detail: { code: 'slow_mode', retry_after_ms: 4000 } }, 429, 'slow_mode'],
    [{ detail: 'invalid_cursor' }, 400, 'invalid_cursor'],
    [{ detail: 'channel_not_found' }, 404, 'channel_not_found'],
    [{ detail: 'member_not_found' }, 404, 'member_not_found'],
    [{ detail: LEAK }, 403, 'forbidden'],
    [{ detail: 'some_new_server_code' }, 404, 'not_found'],
    [{ detail: [{ loc: ['body'], msg: LEAK }] }, 422, 'request'],
    [{ detail: 'Rate_Limited' }, 429, 'rate_limited'],
    [LEAK, 500, 'unavailable'],
  ];
  for (const [body, status, code] of cases) {
    const fetch = fakeFetch(() => (typeof body === 'string' ? new Response(body, { status }) : json(body, status)));
    const error = await rejectsWith(client(fetch).me(), code);
    assert.equal(error.status, status);
  }
  for (const code of ['rate_limited', 'cat_cooldown', 'reply_target_too_old', 'assist_cat_invalid', 'frame_too_large', 'identity_not_linked']) {
    assert.equal(typeof C.SAFE_ERROR[code], 'string');
    assert.ok(!/[a-z]_[a-z]/.test(C.SAFE_ERROR[code]), 'fixed text, not the code');
  }
});

test('retry_after_ms comes from the body or a numeric Retry-After header, bounded', async () => {
  let fetch = fakeFetch(() => json({ detail: { code: 'rate_limited', retry_after_ms: 5000 } }, 429));
  assert.equal((await rejectsWith(client(fetch).me(), 'rate_limited')).retryAfterMs, 5000);
  fetch = fakeFetch(() => json({ detail: 'rate_limited', retry_after_ms: 1200 }, 429));
  assert.equal((await rejectsWith(client(fetch).me(), 'rate_limited')).retryAfterMs, 1200);
  fetch = fakeFetch(() => json({ detail: 'rate_limited' }, 429, { 'Retry-After': '7' }));
  assert.equal((await rejectsWith(client(fetch).me(), 'rate_limited')).retryAfterMs, 7000);
  fetch = fakeFetch(() => json({ detail: 'rate_limited', retry_after_ms: -5 }, 429, { 'Retry-After': 'Wed, 21 Oct 2026' }));
  assert.equal((await rejectsWith(client(fetch).me(), 'rate_limited')).retryAfterMs, null);
});

test('network failures, redirects and timeouts map to fixed codes', async () => {
  let fetch = fakeFetch(() => { throw new TypeError(`fetch failed ${LEAK}`); });
  await rejectsWith(client(fetch).me(), 'unavailable');
  // redirect:'error' makes fetch reject on a 3xx; the injected fetch models that.
  fetch = fakeFetch(() => { throw new TypeError('redirect mode is set to error'); });
  await rejectsWith(client(fetch).me(), 'unavailable');
  assert.equal(fetch.requests[0].redirect, 'error');

  const hang = { fetchImpl: (url, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason))), requests: [] };
  await rejectsWith(client(hang, fakeAuth(), { timeoutMs: 20 }).me(), 'timeout');

  const outer = new AbortController();
  const pending = client(hang).me({ signal: outer.signal });
  outer.abort();
  await rejectsWith(pending, 'canceled');
});

test('abortAll cancels in-flight requests and keeps the client usable; dispose refuses later calls', async () => {
  let release;
  const fetch = fakeFetch(
    (req) => new Promise((resolve, reject) => { release = resolve; req.signal.addEventListener('abort', () => reject(req.signal.reason)); }),
    () => json(channel()));
  const rest = client(fetch);
  const pending = rest.lobby();
  await new Promise(resolve => setImmediate(resolve));
  rest.abortAll();
  await rejectsWith(pending, 'canceled');
  assert.deepEqual(await rest.lobby(), channel());
  rest.dispose();
  await rejectsWith(rest.lobby(), 'canceled');
  assert.equal(fetch.requests.length, 2);
  assert.equal(typeof release, 'function');
});

test('responses are capped: 64 KB by default, 512 KB for history and members', async () => {
  const big = n => new Response('x'.repeat(n), { status: 200 });
  let fetch = fakeFetch(() => big(C.MAX_RESPONSE_BYTES + 1));
  await rejectsWith(client(fetch).me(), 'protocol');
  fetch = fakeFetch(() => new Response('{}', { status: 200, headers: { 'Content-Length': String(C.MAX_RESPONSE_BYTES + 1) } }));
  await rejectsWith(client(fetch).lobby(), 'protocol');

  // A ~100 KB history page is fine; > 512 KB is not.
  const messages = Array.from({ length: 50 }, (_, i) => message(i + 1, { text: '喵'.repeat(600) }));
  const body = JSON.stringify(page(messages));
  assert.ok(Buffer.byteLength(body) > C.MAX_RESPONSE_BYTES && Buffer.byteLength(body) < C.MAX_HISTORY_BYTES);
  fetch = fakeFetch(() => new Response(body, { status: 200 }));
  assert.equal((await client(fetch).history(CH)).messages.length, 50);
  fetch = fakeFetch(() => big(C.MAX_HISTORY_BYTES + 1));
  await rejectsWith(client(fetch).history(CH), 'protocol');
  fetch = fakeFetch(() => big(C.MAX_HISTORY_BYTES + 1));
  await rejectsWith(client(fetch).members(CH), 'protocol');
  // Error bodies are capped too.
  fetch = fakeFetch(() => new Response('x'.repeat(C.MAX_RESPONSE_BYTES + 1), { status: 500 }));
  await rejectsWith(client(fetch).me(), 'protocol');
});

test('malformed success bodies are protocol errors', async () => {
  for (const body of ['not json', '[]', JSON.stringify(channel({ slow_mode_seconds: 7 })), JSON.stringify({ id: CH })]) {
    const fetch = fakeFetch(() => new Response(body, { status: 200 }));
    await rejectsWith(client(fetch).lobby(), 'protocol');
  }
});

test('history: latest page, before_seq and after_seq cursors, limits and ordering', async () => {
  let fetch = fakeFetch(() => json(page([message(2), message(3)], { next_before_seq: 2, has_more: true })));
  const latest = await client(fetch).history(CH);
  assert.equal(fetch.requests[0].url, `${API}/channels/${CH}/messages?limit=50`);
  assert.deepEqual(latest.messages.map(m => m.seq), [2, 3]);
  assert.equal(latest.next_before_seq, 2);
  assert.equal(latest.has_more, true);
  assert.equal(latest.dropped, 0);

  fetch = fakeFetch(() => json(page([message(1)])));
  await client(fetch).history(CH.toUpperCase(), { beforeSeq: 2, limit: 10 });
  assert.equal(fetch.requests[0].url, `${API}/channels/${CH}/messages?limit=10&before_seq=2`);

  fetch = fakeFetch(() => json(page([message(4), message(5)], { has_more: true })));
  const resume = await client(fetch).history(CH, { afterSeq: 3 });
  assert.equal(fetch.requests[0].url, `${API}/channels/${CH}/messages?limit=200&after_seq=3`);
  assert.deepEqual(resume.messages.map(m => m.seq), [4, 5]);

  fetch = fakeFetch(() => json(page([message(5), message(4)])));
  await rejectsWith(client(fetch).history(CH), 'protocol');
  fetch = fakeFetch(() => json(page([message(2)])));
  await rejectsWith(client(fetch).history(CH, { beforeSeq: 2 }), 'protocol');
  fetch = fakeFetch(() => json(page([message(3)])));
  await rejectsWith(client(fetch).history(CH, { afterSeq: 3 }), 'protocol');
  fetch = fakeFetch(() => json(page(Array.from({ length: 51 }, (_, i) => message(i + 1)))));
  await rejectsWith(client(fetch).history(CH), 'protocol');
  fetch = fakeFetch(() => json({ messages: [], next_before_seq: 0, has_more: false }));
  await rejectsWith(client(fetch).history(CH), 'protocol');
});

test('history keeps origin, label, assist_cat and reply_to origin/label; malformed entries are dropped', async () => {
  const coReply = message(2, { origin: 'human_ai', label: '人＋AI 共同回复 · 张三与大肥鱼',
    author: human({ assist_cat: { cat_id: KITTY, name: '大肥鱼' } }), reply_to: { id: U(101), seq: 1, origin: 'human', label: '张三' } });
  const catReply = message(3, { origin: 'cat', label: 'AI 独立发言 · 张三的大肥鱼', cat_depth: 1,
    author: { kind: 'cat', cat_id: KITTY, owner_user_id: ALICE, owner_name: '张三', name: '大肥鱼', display_name: '张三的大肥鱼', avatar_key: 'fish-blue' },
    reply_to: { id: coReply.id, seq: 2, origin: 'human_ai', label: '人＋AI 共同回复 · 张三与大肥鱼' } });
  const forged = message(4, { label: 'AI 独立发言 · 张三的大肥鱼', origin: 'cat', author: human() });
  const fetch = fakeFetch(() => json(page([message(1), coReply, catReply, forged, message(5, { text: 7 })])));
  const result = await client(fetch).history(CH);
  assert.deepEqual(result.messages.map(m => m.seq), [1, 2, 3]);
  assert.equal(result.dropped, 2);
  assert.deepEqual(result.messages[1].author.assist_cat, { cat_id: KITTY, name: '大肥鱼' });
  assert.equal(result.messages[1].origin, 'human_ai');
  assert.deepEqual(result.messages[2].reply_to, { id: coReply.id, seq: 2, origin: 'human_ai', label: '人＋AI 共同回复 · 张三与大肥鱼' });
});

test('history argument checks fail before any request', async () => {
  const fetch = fakeFetch();
  const rest = client(fetch);
  for (const [id, options] of [['lobby', {}], [CH, { beforeSeq: 2, afterSeq: 1 }], [CH, { beforeSeq: 0 }], [CH, { afterSeq: -1 }],
    [CH, { limit: 51 }], [CH, { afterSeq: 1, limit: 201 }], [CH, { limit: 0 }], [CH, { beforeSeq: 1.5 }], [`${CH}/../x`, {}]]) {
    await rejectsWith(rest.history(id, options), 'invalid');
  }
  assert.equal(fetch.requests.length, 0);
});
test('GET /me is rebuilt from known fields; members list keeps human and cat entries', async () => {
  let fetch = fakeFetch(() => json({ user: human({ secret: LEAK }), role: 'admin', is_admin: true, muted_until: null, banned_at: null,
    cat: catView(), limits: { human_burst: 5, cat_hourly: 60, extra: LEAK, slow_mode_seconds: -1 }, token: LEAK }));
  const me = await client(fetch).me();
  assert.deepEqual(me, { user: { user_id: ALICE, name: '张三', display_name: '张三', avatar: { kind: 'hue', hue: 210, text: '张' } },
    role: 'admin', is_admin: true, muted_until: null, banned_at: null, cat: { ...catView(), deleted: false },
    limits: { human_burst: 5, cat_hourly: 60 } });
  assert.ok(!JSON.stringify(me).includes(LEAK));
  for (const bad of [{ role: 'owner' }, { is_admin: 'yes' }, { user: null }, { muted_until: 'soon' }]) {
    fetch = fakeFetch(() => json({ user: human(), role: 'member', is_admin: false, cat: null, ...bad }));
    await rejectsWith(client(fetch).me(), 'protocol');
  }

  fetch = fakeFetch(() => json({ members: [
    { ...human(), role: 'member', muted_until: 1730000000000, banned_at: null, online: true },
    { kind: 'cat', cat_id: KITTY, owner_user_id: ALICE, owner_name: '张三', name: '大肥鱼', display_name: '张三的大肥鱼',
      avatar_key: 'fish-blue', enabled: true, admin_disabled: false, online: false },
    { kind: 'human', user_id: 'nope' }, { kind: 'robot' }, null,
  ] }));
  const members = await client(fetch).members(CH);
  assert.equal(fetch.requests[0].url, `${API}/channels/${CH}/members`);
  assert.equal(members.dropped, 3);
  assert.deepEqual(members.members[0], { kind: 'human', user_id: ALICE, name: '张三', display_name: '张三',
    avatar: { kind: 'hue', hue: 210, text: '张' }, role: 'member', muted_until: 1730000000000, banned_at: null, online: true });
  assert.equal(members.members[1].kind, 'cat');
  assert.equal(members.members[1].cat_id, KITTY);
  assert.equal(members.members[1].online, false);
});

test('/me/cat: get (null when none), put body and validation, delete', async () => {
  let fetch = fakeFetch(() => json({ detail: 'cat_not_found' }, 404));
  assert.equal(await client(fetch).getCat(), null);
  fetch = fakeFetch(() => json(catView()));
  assert.deepEqual(await client(fetch).getCat(), { ...catView(), deleted: false });
  fetch = fakeFetch(() => json({ detail: 'channel_not_found' }, 404));
  await rejectsWith(client(fetch).getCat(), 'channel_not_found');

  fetch = fakeFetch(() => json({ type: 'cat.updated', event_seq: 9, cat: catView({ reply_mode: 'owner_or_mention' }) }));
  const saved = await client(fetch).putCat({ name: '大肥鱼', avatarKey: 'fish-blue', replyMode: 'owner_or_mention', enabled: true });
  assert.equal(saved.reply_mode, 'owner_or_mention');
  const [put] = fetch.requests;
  assert.equal(put.method, 'PUT');
  assert.equal(put.url, `${API}/me/cat`);
  assert.equal(put.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(put.body), { name: '大肥鱼', avatar_key: 'fish-blue', reply_mode: 'owner_or_mention', enabled: true });

  fetch = fakeFetch(() => json({ detail: 'cat_mode_not_allowed' }, 400));
  await rejectsWith(client(fetch).putCat({ name: '大肥鱼', avatarKey: 'fish-blue', replyMode: 'free', enabled: true }), 'cat_mode_not_allowed');

  const none = fakeFetch();
  for (const bad of [{ name: '' }, { name: 'x'.repeat(33) }, { name: 'a\u0007b' }, { avatarKey: '../x' }, { replyMode: 'always' }, { enabled: 1 }]) {
    await rejectsWith(client(none).putCat({ name: '大肥鱼', avatarKey: 'fish-blue', replyMode: 'mention', enabled: true, ...bad }), 'invalid');
  }
  assert.equal(none.requests.length, 0);

  fetch = fakeFetch(() => json({ type: 'cat.updated', event_seq: 10, cat: catView({ enabled: false, deleted: false }) }));
  const frames = await client(fetch).deleteCat();
  assert.equal(fetch.requests[0].method, 'DELETE');
  assert.equal(frames[0].type, 'cat.updated');
  assert.equal(frames[0].cat.enabled, false);
});

test('admin endpoints: paths, methods and bodies', async () => {
  const frame = { type: 'member.updated', event_seq: 11, user_id: BOB, changes: { role: 'member', muted_until: 1730000600000, banned_at: null } };
  const fetch = fakeFetch(...Array.from({ length: 10 }, () => () => json(frame)));
  const rest = client(fetch);
  await rest.updateChannel(CH, { name: '新大厅', topic: '', slow_mode_seconds: 30, cats_enabled: false, cat_free_mode_allowed: true });
  await rest.deleteMessage(CH, M1);
  await rest.mute(CH, BOB, { minutes: 60, reason: '刷屏' });
  await rest.unmute(CH, BOB);
  await rest.ban(CH, BOB, { reason: '广告' });
  await rest.unban(CH, BOB);
  await rest.setRole(CH, BOB, 'admin');
  await rest.disableCat(CH, KITTY);
  await rest.enableCat(CH, KITTY);
  const deleted = await rest.ban(CH, BOB);
  assert.deepEqual(deleted, [frame]);
  assert.deepEqual(fetch.requests.map(r => [r.method, r.url.slice(API.length), r.body === undefined ? undefined : JSON.parse(r.body)]), [
    ['PATCH', `/channels/${CH}`, { name: '新大厅', topic: '', slow_mode_seconds: 30, cats_enabled: false, cat_free_mode_allowed: true }],
    ['DELETE', `/channels/${CH}/messages/${M1}`, undefined],
    ['POST', `/channels/${CH}/members/${BOB}/mute`, { minutes: 60, reason: '刷屏' }],
    ['DELETE', `/channels/${CH}/members/${BOB}/mute`, undefined],
    ['POST', `/channels/${CH}/members/${BOB}/ban`, { reason: '广告' }],
    ['DELETE', `/channels/${CH}/members/${BOB}/ban`, undefined],
    ['PUT', `/channels/${CH}/members/${BOB}/role`, { role: 'admin' }],
    ['POST', `/channels/${CH}/cats/${KITTY}/disable`, undefined],
    ['POST', `/channels/${CH}/cats/${KITTY}/enable`, undefined],
    ['POST', `/channels/${CH}/members/${BOB}/ban`, {}],
  ]);
  for (const r of fetch.requests) assert.equal(r.headers.Authorization, `Bearer ${TOKEN_1}`);
});

test('every method rejects (never throws synchronously) on bad arguments', () => {
  const rest = client(fakeFetch());
  const calls = [() => rest.deleteMessage(CH, '1'), () => rest.unmute(CH, 'b'), () => rest.unban(CH, 'b'), () => rest.disableCat(CH, 'c'),
    () => rest.enableCat(CH, 'c'), () => rest.history('x'), () => rest.members('x'), () => rest.setRole(CH, BOB, 'x')];
  return Promise.all(calls.map(call => {
    let promise;
    assert.doesNotThrow(() => { promise = call(); });
    return rejectsWith(promise, 'invalid');
  }));
});

test('admin argument checks fail before any request; forbidden maps to fixed text', async () => {
  const none = fakeFetch();
  const rest = client(none);
  const attempts = [
    () => rest.updateChannel(CH, {}), () => rest.updateChannel(CH, { slow_mode_seconds: 7 }), () => rest.updateChannel(CH, { owner: ALICE }),
    () => rest.updateChannel(CH, { name: '' }), () => rest.updateChannel(CH, { cats_enabled: 'yes' }),
    () => rest.updateChannel(CH, { topic: 'x'.repeat(501) }),
    () => rest.mute(CH, BOB, { minutes: 9 }), () => rest.mute(CH, BOB, { minutes: 10081 }), () => rest.mute(CH, BOB, { minutes: 60, reason: 'x'.repeat(501) }),
    () => rest.mute(CH, 'bob', { minutes: 60 }), () => rest.setRole(CH, BOB, 'owner'), () => rest.deleteMessage(CH, '1'),
    () => rest.disableCat(CH, '../x'), () => rest.unmute(CH, 'bob'), () => rest.unban('x', BOB),
    () => rest.members('lobby'), () => rest.moderationActions(CH, { before: 'yesterday' }),
  ];
  for (const attempt of attempts) await rejectsWith(attempt(), 'invalid');
  assert.equal(none.requests.length, 0);

  const fetch = fakeFetch(() => json({ detail: 'forbidden' }, 403));
  await rejectsWith(client(fetch).setRole(CH, BOB, 'admin'), 'forbidden');
});

test('moderation actions: before cursor and rebuilt rows', async () => {
  const row = { id: A1, action: 'member.mute', actor_user_id: ALICE, target_user_id: BOB, target_message_id: null, target_cat_id: null,
    reason: '刷屏', params: { minutes: 60, secret: LEAK }, created_at: '2026-10-29T12:00:00.123456+00:00' };
  let fetch = fakeFetch(() => json([row]));
  const actions = await client(fetch).moderationActions(CH, { before: U(31) });
  assert.equal(fetch.requests[0].url, `${API}/channels/${CH}/moderation-actions?before=${U(31)}`);
  assert.deepEqual(actions, [{ ...row, params: { minutes: 60 } }]);
  fetch = fakeFetch(() => json({ actions: [row] }));
  assert.equal((await client(fetch).moderationActions(CH)).length, 1);
  fetch = fakeFetch(() => json([{ ...row, action: '<b>x</b>' }]));
  await rejectsWith(client(fetch).moderationActions(CH), 'protocol');
});

test('no token, server text or message body reaches console output', async t => {
  const output = [];
  for (const method of ['log', 'info', 'warn', 'error', 'debug']) t.mock.method(console, method, (...args) => output.push(args));
  const fetch = fakeFetch(() => json({ detail: LEAK }, 401), () => json({ detail: LEAK }, 401),
    () => json(page([message(1, { text: LEAK })])), () => json({ detail: LEAK }, 500));
  const rest = client(fetch);
  await rejectsWith(rest.me(), 'expired');
  const history = await rest.history(CH);
  assert.equal(history.messages[0].text, LEAK, 'message text is returned to the caller only');
  await rejectsWith(rest.lobby(), 'unavailable');
  assert.deepEqual(output, []);
  const serialized = JSON.stringify(output);
  for (const secret of [TOKEN_1, TOKEN_2, LEAK]) assert.ok(!serialized.includes(secret));
});
