'use strict';
// Locks the WebSocket half of lobby-client.cjs (createLobbyClient) against
// docs/protocol.md v1 and the plan: token only in the first `auth` frame,
// hello within 10 s, ping every 20 s, dead after 60 s idle, 1 s -> 30 s full
// jitter backoff reset after 60 s stable, resume with last_event_seq, dedupe by
// event_seq, gap and pong catch-up reconnects, replayed message.deleted,
// resync.required reload, outbox keyed by client_message_id (resend until ack,
// 30 s -> failed + retry), auth.refresh before token_expires_at, generation
// guard after disconnect / sign-out, 500-message cap, nothing on disk.
// Fake WebSocket class, fake timers, injected REST and auth; synthetic ids only.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { fakeTimers, flush } = require('./lobby-fixtures.cjs');
const C = require('../../apps/neko-workbench/lobby-client.cjs');

const CHAT = 'https://chat.example.test/';
const CONFIG = Object.freeze({ configured: true, chatUrl: CHAT });
const U = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const CH = U(1), OWNER = U(2), OTHER = U(3), CAT = U(4), REPLY = U(5);
const TOKEN_1 = 'fixture-ws-token-1-aaaaaaaaaaaaaaaa';
const TOKEN_2 = 'fixture-ws-token-2-bbbbbbbbbbbbbbbb';
const SECRET_TEXT = 'fixture-secret-text-Qx7';
const HOUR = 3600 * 1000;

const channel = (extra = {}) => ({ id: CH, name: '大厅', topic: '', slow_mode_seconds: 0, cats_enabled: true,
  cat_free_mode_allowed: false, last_seq: 10, ...extra });
const humanMember = { kind: 'human', user_id: OTHER, name: '阿布', display_name: '阿布', avatar: { kind: 'hue', hue: 10, text: '阿' },
  role: 'member', muted_until: null, banned_at: null, online: false };
const catMember = { kind: 'cat', cat_id: CAT, owner_user_id: OTHER, owner_name: '阿布', name: '小黑', display_name: '阿布的小黑',
  avatar_key: 'cat-black', enabled: true, admin_disabled: false, online: false };
const message = (seq, extra = {}) => ({ id: U(1000 + seq), seq, channel_id: CH, created_at: 1730000000000 + seq, deleted: false,
  text: `合成消息 ${seq}`, origin: 'human', label: '阿布',
  author: { kind: 'human', user_id: OTHER, name: '阿布', display_name: '阿布', avatar: { kind: 'hue', hue: 10, text: '阿' } },
  mentions: [], reply_to: null, cat_depth: 0, ...extra });
const newFrame = (eventSeq, seq) => ({ type: 'message.new', event_seq: eventSeq, message: message(seq) });

function fakeWebSocket() {
  const sockets = [];
  class FakeSocket {
    constructor(url, protocols) {
      this.url = url; this.protocols = protocols; this.readyState = 0;
      this.onopen = this.onmessage = this.onclose = this.onerror = null;
      this.sent = []; this.closeCode = null;
      sockets.push(this);
    }
    send(data) { if (this.readyState !== 1) throw new Error('not open'); this.sent.push(JSON.parse(data)); }
    close(code) { if (this.closeCode === null) this.closeCode = code ?? 1000; this.readyState = 3; }
    // server side
    open() { this.readyState = 1; this.onopen?.({}); }
    receive(frame) { this.onmessage?.({ data: typeof frame === 'string' ? frame : JSON.stringify(frame) }); }
    serverClose(code) { this.readyState = 3; this.onerror?.({}); this.onclose?.({ code }); }
    frames(type) { return this.sent.filter(f => f.type === type); }
  }
  return { WebSocketImpl: FakeSocket, sockets, last: () => sockets[sockets.length - 1] };
}

function fakeAuth({ tokens = [TOKEN_1, TOKEN_2], expiresAt = null } = {}) {
  let index = 0;
  const auth = {
    calls: [], invalidated: 0, expiresAt,
    async getAccessToken({ forceRefresh = false } = {}) {
      auth.calls.push(forceRefresh);
      if (forceRefresh) index = Math.min(index + 1, tokens.length - 1);
      return tokens[index];
    },
    invalidateAccessToken() { auth.invalidated += 1; },
    get accessExpiresAt() { return auth.expiresAt; },
  };
  return auth;
}

// hold: true makes history() wait for release().
function fakeRest({ history = [], hold = false, older = [] } = {}) {
  const gates = [];
  const rest = {
    calls: [], page: history.slice(), hold,
    release() { while (gates.length) gates.shift()(); },
    async lobby() { rest.calls.push('lobby'); return channel(); },
    async history(channelId, options = {}) {
      rest.calls.push(options.beforeSeq ? `older:${options.beforeSeq}` : 'history');
      if (rest.hold && !options.beforeSeq) await new Promise(resolve => gates.push(resolve));
      if (options.beforeSeq) return { messages: older, next_before_seq: null, has_more: false, dropped: 0 };
      return { messages: rest.page.slice(), next_before_seq: rest.page.length ? rest.page[0].seq : null,
        has_more: rest.page.length > 0 && rest.page[0].seq > 1, dropped: 0 };
    },
    async members() { rest.calls.push('members'); return { members: [{ ...humanMember }, { ...catMember }], dropped: 0 }; },
    abortAll() { rest.calls.push('abortAll'); },
    dispose() { rest.calls.push('dispose'); },
  };
  return rest;
}

function setup({ history = [message(1), message(2)], hold = false, older, random = () => 0, limits, tokens, rest } = {}) {
  const clock = fakeTimers();
  const ws = fakeWebSocket();
  const auth = fakeAuth({ tokens });
  const api = rest || fakeRest({ history, hold, older });
  const changes = [], events = [];
  let n = 0;
  const client = C.createLobbyClient({
    config: CONFIG, auth, rest: api, WebSocketImpl: ws.WebSocketImpl, timers: clock.timers, now: clock.now,
    random, newId: () => U(5000 + ++n), clientVersion: '0.28.0', limits,
    onChange: reason => changes.push(reason), onEvent: (type, payload) => events.push([type, payload]),
  });
  return { clock, ws, auth, rest: api, client, changes, events };
}

const hello = (s, lastEventSeq, expiresIn = HOUR) =>
  ({ type: 'hello', user_id: OWNER, token_expires_at: s.clock.now() + expiresIn, last_event_seq: lastEventSeq });

// The newest socket still waiting to open; runs the reconnect timer if needed.
async function freshSocket(s) {
  for (let i = 0; i < 20; i++) {
    const sock = s.ws.last();
    if (sock && sock.readyState === 0 && sock.closeCode === null) return sock;
    const wait = Math.min(...s.clock.pending());
    await s.clock.advance(Number.isFinite(wait) ? wait : 0);
  }
  throw new Error('no reconnect');
}

// connect (or wait for the reconnect), open, hello, presence; returns the socket.
async function online(s, lastEventSeq = 100, { connect = true, expiresIn } = {}) {
  if (connect) s.client.connect();
  await flush();
  const sock = await freshSocket(s);
  sock.open();
  sock.receive(hello(s, lastEventSeq, expiresIn));
  sock.receive({ type: 'presence.snapshot', members: [{ user_id: OTHER, online: true }] });
  await flush();
  assert.equal(s.client.status, 'online');
  return sock;
}

// Advance while answering every ping, so the 60 s idle timer never fires.
async function advanceAlive(s, ms) {
  const step = 20000;
  for (let left = ms; left > 0; left -= step) {
    await s.clock.advance(Math.min(step, left));
    const sock = s.ws.last();
    if (sock.readyState === 1) sock.receive({ type: 'pong', t: s.clock.now(), last_event_seq: s.client.snapshot().lastEventSeq });
    await flush();
  }
}

const seqs = s => s.client.snapshot().messages.map(m => m.seq);

test('auth is the first frame; the token is never in the URL; first connect sends no cursor', async () => {
  const s = setup();
  s.client.connect();
  await flush();
  const sock = s.ws.last();
  assert.equal(sock.url, `wss://chat.example.test/ws/channels/${CH}`);
  assert.equal(sock.protocols, undefined);
  assert.ok(!sock.url.includes(TOKEN_1));
  assert.equal(sock.sent.length, 0);
  sock.open();
  assert.deepEqual(sock.sent[0], { type: 'auth', token: TOKEN_1, client: { name: 'neko-workbench', version: '0.28.0' } });
  sock.receive(hello(s, 100));
  await flush();
  assert.equal(s.client.status, 'online');
  assert.deepEqual(s.rest.calls.slice(0, 1), ['lobby']);
  assert.ok(s.rest.calls.includes('history') && s.rest.calls.includes('members'));
  const snap = s.client.snapshot();
  assert.deepEqual(seqs(s), [1, 2]);
  assert.equal(snap.lastEventSeq, 100);
  assert.equal(snap.userId, OWNER);
  assert.ok(!JSON.stringify(snap).includes(TOKEN_1));
  s.client.dispose();
});

test('http chat URL maps to ws://; unconfigured client never opens a socket', async () => {
  assert.equal(C.socketUrl('http://127.0.0.1:8091', CH), `ws://127.0.0.1:8091/ws/channels/${CH}`);
  assert.equal(C.socketUrl('https://chat.example.test/base/', CH), `wss://chat.example.test/base/ws/channels/${CH}`);
  const ws = fakeWebSocket();
  const client = C.createLobbyClient({ config: { configured: false }, auth: fakeAuth(), rest: fakeRest(), WebSocketImpl: ws.WebSocketImpl,
    timers: fakeTimers().timers });
  assert.equal(client.status, 'unconfigured');
  client.connect();
  await flush();
  assert.equal(ws.sockets.length, 0);
  const error = await client.send({ text: '你好' }).then(() => null, e => e);
  assert.equal(error.code, 'unconfigured');
  client.dispose();
});

test('hello must arrive within 10 s of connecting and of open, or the socket is replaced', async () => {
  const s = setup();
  s.client.connect();
  await flush();
  const first = s.ws.last();
  await s.clock.advance(9999);
  assert.equal(s.ws.sockets.length, 1);
  await s.clock.advance(1);
  assert.equal(first.closeCode, 1000);
  assert.equal(s.client.status, 'reconnecting');
  await s.clock.advance(0);
  const second = s.ws.last();
  assert.notEqual(second, first);
  second.open();
  await s.clock.advance(9999);
  assert.equal(second.closeCode, null);
  await s.clock.advance(1);
  assert.equal(second.closeCode, 1000);
  s.client.dispose();
});

test('ping every 20 s; 60 s without any inbound frame closes and reconnects', async () => {
  const s = setup();
  const sock = await online(s);
  await s.clock.advance(19999);
  assert.equal(sock.frames('ping').length, 0);
  await s.clock.advance(1);
  assert.deepEqual(sock.frames('ping'), [{ type: 'ping', t: s.clock.now() }]);
  await s.clock.advance(20000);
  assert.equal(sock.frames('ping').length, 2);
  assert.equal(sock.closeCode, null);
  await s.clock.advance(19999);
  assert.equal(sock.closeCode, null);
  await s.clock.advance(1);
  assert.equal(sock.closeCode, 4000);
  assert.equal(s.client.status, 'reconnecting');
  // an inbound frame resets the idle clock
  await s.clock.advance(0);
  const next = await online(s, 100, { connect: false });
  await s.clock.advance(50000);
  next.receive({ type: 'pong', t: 1, last_event_seq: 100 });
  await s.clock.advance(50000);
  assert.equal(next.closeCode, null);
  s.client.dispose();
});

test('reconnect backoff is full jitter from 1 s up to 30 s and resets after 60 s stable', async () => {
  const s = setup({ random: () => 0.999 });
  s.client.connect();
  await flush();
  const delays = [];
  for (let i = 0; i < 7; i++) {
    s.ws.last().serverClose(1006);
    const [delay] = s.clock.pending();
    delays.push(delay);
    await s.clock.advance(delay);
    await flush();
  }
  assert.deepEqual(delays, [999, 1998, 3996, 7992, 15984, 29970, 29970]);
  const sock = await online(s, 100, { connect: false });
  await advanceAlive(s, 40000);
  sock.serverClose(1006);
  assert.deepEqual(s.clock.pending(), [29970], 'not yet stable: backoff keeps growing');
  await s.clock.advance(29970);
  const stable = await online(s, 100, { connect: false });
  await advanceAlive(s, 60000);
  stable.serverClose(1006);
  assert.deepEqual(s.clock.pending(), [999], 'stable for 60 s: backoff resets');
  // jitter really uses random(): a low draw gives a short delay
  const low = setup({ random: () => 0.25 });
  low.client.connect();
  await flush();
  low.ws.last().serverClose(1006);
  assert.deepEqual(low.clock.pending(), [250]);
  low.client.dispose();
  s.client.dispose();
});

test('reconnect resumes with last_event_seq; replayed events apply without a REST reload', async () => {
  const s = setup();
  const sock = await online(s, 100);
  sock.receive(newFrame(101, 3));
  assert.deepEqual(seqs(s), [1, 2, 3]);
  sock.serverClose(1012);
  await s.clock.advance(0);
  const restCalls = s.rest.calls.length;
  const next = s.ws.last();
  next.open();
  assert.equal(next.sent[0].type, 'auth');
  assert.equal(next.sent[0].last_event_seq, 101);
  next.receive(hello(s, 103));
  next.receive(newFrame(102, 4));
  next.receive({ type: 'message.deleted', event_seq: 103, message_id: message(1).id, seq: 1, deleted_by: OWNER });
  await flush();
  assert.equal(s.client.status, 'online');
  assert.equal(s.rest.calls.length, restCalls, 'resume does not touch REST');
  const snap = s.client.snapshot();
  assert.deepEqual(seqs(s), [1, 2, 3, 4]);
  assert.equal(snap.lastEventSeq, 103);
  assert.equal(snap.messages[0].deleted, true, 'replayed deletion marks the old message');
  assert.equal(snap.messages[0].text, null);
  assert.ok(s.events.some(([type, p]) => type === 'message.deleted' && p.messageId === message(1).id));
  s.client.dispose();
});

test('dedupe by event_seq; a gap reconnects at once with the old cursor to replay it', async () => {
  const s = setup();
  const sock = await online(s, 100);
  sock.receive(newFrame(101, 3));
  sock.receive(newFrame(101, 3));
  sock.receive(newFrame(100, 2));
  assert.deepEqual(seqs(s), [1, 2, 3]);
  assert.equal(s.client.snapshot().stats.duplicates, 2);
  sock.receive(newFrame(103, 5));
  assert.equal(sock.closeCode, 4000, 'gap closes the socket');
  assert.deepEqual(seqs(s), [1, 2, 3], 'the frame after the gap is not applied');
  assert.deepEqual(s.clock.pending().filter(ms => ms === 0).length, 1, 'immediate reconnect');
  await s.clock.advance(0);
  const next = s.ws.last();
  next.open();
  assert.equal(next.sent[0].last_event_seq, 101);
  next.receive(hello(s, 103));
  next.receive(newFrame(102, 4));
  next.receive(newFrame(103, 5));
  assert.deepEqual(seqs(s), [1, 2, 3, 4, 5]);
  assert.equal(s.client.snapshot().stats.gaps, 1);
  s.client.dispose();
});

test('pong.last_event_seq ahead of us waits briefly for in-flight events, then reconnects to catch up', async () => {
  const s = setup();
  const sock = await online(s, 100);
  sock.receive({ type: 'pong', t: 1, last_event_seq: 101 });
  sock.receive(newFrame(101, 3));
  await s.clock.advance(5000);
  assert.equal(sock.closeCode, null, 'the event arrived within the grace period');
  sock.receive({ type: 'pong', t: 2, last_event_seq: 102 });
  await s.clock.advance(1999);
  assert.equal(sock.closeCode, null);
  await s.clock.advance(1);
  assert.equal(sock.closeCode, 4000);
  const next = s.ws.last();
  assert.notEqual(next, sock);
  next.open();
  assert.equal(next.sent[0].last_event_seq, 101);
  s.client.dispose();
});

test('resync.required clears state and reloads channel, members and the latest page; buffered events apply after', async () => {
  const s = setup({ history: [message(1), message(2)] });
  const sock = await online(s, 100);
  s.rest.page = [message(7), message(8)];
  s.rest.hold = true;
  s.rest.calls.length = 0;
  sock.receive({ type: 'resync.required' });
  assert.deepEqual(s.client.snapshot().messages, [], 'local state is discarded');
  assert.equal(s.client.status, 'loading');
  await flush();
  sock.receive(newFrame(101, 9));   // arrives while the page loads
  s.rest.release();
  await flush();
  assert.deepEqual(s.rest.calls, ['lobby', 'history', 'members']);
  assert.equal(s.client.status, 'online');
  assert.deepEqual(seqs(s), [7, 8, 9]);
  assert.equal(s.client.snapshot().lastEventSeq, 101);
  assert.equal(s.client.snapshot().members.find(m => m.kind === 'human').online, true);
  assert.ok(s.changes.includes('resync') && s.events.some(([type]) => type === 'resync'));
  // after a resync the next reconnect carries the new baseline
  sock.serverClose(1006);
  await s.clock.advance(0);
  s.ws.last().open();
  assert.equal(s.ws.last().sent[0].last_event_seq, 101);
  s.client.dispose();
});

test('send({text, replyToId, origin, assistCatId}) builds message.send; bad input fails before the socket', async () => {
  const s = setup();
  const sock = await online(s);
  const sent = s.client.send({ text: '<@c:' + CAT + '> 你好', replyToId: REPLY.toUpperCase(), origin: 'human_ai', assistCatId: CAT });
  assert.deepEqual(sock.frames('message.send'), [{ type: 'message.send', text: '<@c:' + CAT + '> 你好', origin: 'human_ai',
    reply_to_id: REPLY, assist_cat_id: CAT, client_message_id: U(5001) }]);
  sock.receive({ type: 'ack', client_message_id: U(5001), message_id: U(900), seq: 3, duplicate: false });
  assert.deepEqual(await sent, { clientMessageId: U(5001), messageId: U(900), seq: 3, duplicate: false });
  s.client.send({ text: '纯手写' });
  assert.deepEqual(sock.frames('message.send')[1], { type: 'message.send', text: '纯手写', origin: 'human', client_message_id: U(5002) });
  for (const bad of [{ text: '' }, { text: '   ' }, { text: 'x'.repeat(2001) }, { text: 'a', origin: 'cat' },
    { text: 'a', origin: 'human_ai' }, { text: 'a', origin: 'human', assistCatId: CAT }, { text: 'a', replyToId: 'nope' }]) {
    const error = await s.client.send(bad).then(() => null, e => e);
    assert.equal(error.code, 'invalid');
    assert.equal(error.message, C.SAFE_ERROR.invalid);
  }
  assert.equal(sock.frames('message.send').length, 2);
  s.client.dispose();
});

test('outbox is keyed by client_message_id and resent with the same id after every reconnect until ack', async () => {
  const s = setup();
  const sock = await online(s);
  const pending = s.client.send({ text: SECRET_TEXT });
  assert.equal(sock.frames('message.send').length, 1);
  sock.serverClose(1006);
  assert.equal(s.client.snapshot().outbox[0].status, 'sent');
  await s.clock.advance(0);
  const second = await online(s, 100, { connect: false });
  assert.deepEqual(second.frames('message.send').map(f => f.client_message_id), [U(5001)]);
  second.serverClose(1013);
  await s.clock.advance(1000);
  const third = await online(s, 100, { connect: false });
  assert.deepEqual(third.frames('message.send').map(f => f.client_message_id), [U(5001)]);
  third.receive({ type: 'ack', client_message_id: U(5001), message_id: U(900), seq: 3, duplicate: true });
  assert.equal((await pending).duplicate, true);
  assert.deepEqual(s.client.snapshot().outbox, []);
  third.serverClose(1006);
  await s.clock.advance(5000);
  const fourth = await online(s, 100, { connect: false });
  assert.equal(fourth.frames('message.send').length, 0, 'acked entries are not resent');
  s.client.dispose();
});

test('no ack within 30 s marks the entry failed; retry resends the same id, discard drops it', async () => {
  const s = setup();
  const sock = await online(s);
  const pending = s.client.send({ text: SECRET_TEXT });
  sock.serverClose(1006);            // reconnect sockets never open: the server never answers
  await s.clock.advance(29999);
  assert.notEqual(s.client.snapshot().outbox[0].status, 'failed');
  await s.clock.advance(1);
  const error = await pending.then(() => null, e => e);
  assert.equal(error.code, 'timeout');
  assert.ok(!error.message.includes(SECRET_TEXT));
  const [entry] = s.client.snapshot().outbox;
  assert.equal(entry.status, 'failed');
  assert.equal(entry.code, 'timeout');
  assert.equal(entry.error, C.SAFE_ERROR.timeout);
  assert.ok(s.events.some(([type, p]) => type === 'outbox.failed' && p.clientMessageId === U(5001) && !JSON.stringify(p).includes(SECRET_TEXT)));
  const next = await online(s, 100, { connect: false });
  assert.equal(next.frames('message.send').length, 0, 'failed entries wait for an explicit retry');
  const retried = s.client.retry(U(5001));
  assert.deepEqual(next.frames('message.send').map(f => f.client_message_id), [U(5001)]);
  next.receive({ type: 'ack', client_message_id: U(5001), message_id: U(900), seq: 3, duplicate: false });
  assert.equal((await retried).messageId, U(900));
  const other = s.client.send({ text: '第二条' });
  next.receive({ type: 'error', ref: U(5002), code: 'slow_mode', retry_after_ms: 5000 });
  const slow = await other.then(() => null, e => e);
  assert.equal(slow.code, 'slow_mode');
  assert.equal(slow.retryAfterMs, 5000);
  assert.equal(s.client.discard(U(5002)), true);
  assert.deepEqual(s.client.snapshot().outbox, []);
  assert.equal(s.client.discard(U(5002)), false);
  s.client.dispose();
});

test('auth.refresh goes out before token_expires_at with a freshly refreshed token', async () => {
  const s = setup();
  s.auth.expiresAt = null;
  // Like lobby-auth, a forced refresh stores the new token's expiry before it
  // returns the token.
  let refreshedAt = null;
  const getAccessToken = s.auth.getAccessToken;
  s.auth.getAccessToken = async (options = {}) => {
    const token = await getAccessToken(options);
    if (options.forceRefresh) { refreshedAt = s.clock.now(); s.auth.expiresAt = refreshedAt + 90 * 60 * 1000; }
    return token;
  };
  const sock = await online(s, 100, { expiresIn: 10 * 60 * 1000 });
  await advanceAlive(s, (10 - 2) * 60 * 1000 - 1000);
  assert.equal(sock.frames('auth.refresh').length, 0, 'still before the 2 min lead window');
  await s.clock.advance(1001);
  assert.deepEqual(sock.frames('auth.refresh'), [{ type: 'auth.refresh', token: TOKEN_2 }]);
  assert.equal(s.auth.calls.at(-1), true, 'refresh asks lobby-auth for a new token');
  assert.equal(sock.closeCode, null);
  // the next refresh is scheduled from the expiry the first refresh produced, not the old hello
  await advanceAlive(s, refreshedAt + (90 - 2) * 60 * 1000 - 1000 - s.clock.now());
  assert.equal(sock.frames('auth.refresh').length, 1, 'still before new expiry - 2 min');
  await advanceAlive(s, 1001);
  assert.equal(sock.frames('auth.refresh').length, 2);
  s.client.dispose();
});

test('4401 refreshes the token and reconnects once; a second 4401 stops and reports sign-out', async () => {
  const s = setup();
  const sock = await online(s);
  sock.serverClose(4401);
  assert.equal(s.auth.invalidated, 1);
  await s.clock.advance(0);
  const next = s.ws.last();
  next.open();
  assert.equal(next.sent[0].token, TOKEN_2);
  assert.equal(s.auth.calls.at(-1), true);
  next.serverClose(4401);
  await flush();
  assert.equal(s.client.status, 'stopped');
  assert.equal(s.client.snapshot().error.code, 'expired');
  assert.ok(s.events.some(([type, p]) => type === 'signed-out' && p.code === 'expired'));
  await s.clock.advance(60000);
  assert.equal(s.ws.sockets.length, 2, 'no reconnect after the stop');
  // 4403 (banned) stops too
  const b = setup();
  (await online(b)).serverClose(4403);
  assert.equal(b.client.status, 'stopped');
  assert.equal(b.client.snapshot().error.code, 'channel_banned');
  b.client.dispose();
  s.client.dispose();
});

test('generation guard: frames, REST pages and timers from before a disconnect or sign-out are ignored', async () => {
  const s = setup();
  const sock = await online(s, 100);
  const gen = s.client.generation;
  const pending = s.client.send({ text: '还没送达' });
  s.client.disconnect();
  assert.ok(s.client.generation > gen);
  assert.equal(s.client.status, 'idle');
  assert.equal((await pending.then(() => null, e => e)).code, 'canceled');
  sock.receive(newFrame(101, 3));
  sock.receive({ type: 'resync.required' });
  sock.serverClose(1006);
  await s.clock.advance(120000);
  assert.deepEqual(seqs(s), [1, 2], 'nothing from the old socket applies');
  assert.equal(s.ws.sockets.length, 1, 'no reconnect after disconnect');
  // a REST reload still in flight when the user signs out is dropped
  const r = setup({ hold: true });
  r.client.connect();
  await flush();
  const rs = r.ws.last();
  rs.open();
  rs.receive(hello(r, 100));
  await flush();
  r.client.reset();
  r.rest.release();
  await flush();
  const snap = r.client.snapshot();
  assert.deepEqual(snap.messages, []);
  assert.equal(snap.channel, null);
  assert.equal(snap.lastEventSeq, 0);
  assert.equal(r.client.status, 'idle');
  assert.ok(r.rest.calls.includes('abortAll'));
  // after sign-out the next connect starts fresh, without a cursor
  r.client.connect();
  await flush();
  r.ws.last().open();
  assert.equal(r.ws.last().sent[0].last_event_seq, undefined);
  r.client.dispose();
  s.client.dispose();
});

test('memory keeps at most 500 messages; loadOlder fills only up to the cap', async () => {
  const history = Array.from({ length: 50 }, (_, i) => message(451 + i));
  const s = setup({ history, older: Array.from({ length: 50 }, (_, i) => message(401 + i)) });
  const sock = await online(s, 1000);
  for (let i = 1; i <= 460; i++) sock.receive(newFrame(1000 + i, 500 + i));
  const snap = s.client.snapshot();
  assert.equal(snap.messages.length, 500);
  assert.equal(snap.messages[0].seq, 461);
  assert.equal(snap.messages.at(-1).seq, 960);
  assert.equal(snap.hasMore, true);
  assert.equal(snap.nextBeforeSeq, 461);
  const result = await s.client.loadOlder();
  assert.equal(result.added, 0);
  assert.equal(result.capped, true);
  assert.ok(!s.rest.calls.some(c => c.startsWith('older:')), 'no request when already at the cap');
  // below the cap, loadOlder prepends the older page
  const t = setup({ history, older: Array.from({ length: 50 }, (_, i) => message(401 + i)) });
  await online(t, 1000);
  const page = await t.client.loadOlder();
  assert.equal(page.added, 50);
  assert.deepEqual(seqs(t).slice(0, 2), [401, 402]);
  assert.equal(seqs(t).length, 100);
  t.client.dispose();
  s.client.dispose();
});

test('malformed, oversized and unknown frames are dropped; the socket stays up', async () => {
  const s = setup();
  const sock = await online(s, 100);
  sock.receive('not json');
  sock.receive({ type: 'message.new', event_seq: 101, message: { id: 'bad' } });
  sock.receive({ type: 'surprise', event_seq: 101 });
  sock.receive(JSON.stringify({ type: 'typing', user_id: OTHER, kind: 'human', pad: 'x'.repeat(70 * 1024) }));
  sock.receive({ type: 'hello', user_id: OWNER, token_expires_at: 1, last_event_seq: 999 });
  assert.equal(s.client.snapshot().stats.dropped, 5);
  assert.equal(s.client.snapshot().lastEventSeq, 100);
  assert.equal(sock.closeCode, null);
  sock.receive(newFrame(101, 3));
  assert.deepEqual(seqs(s), [1, 2, 3]);
  s.client.dispose();
});

test('cat.status is re-sent after reconnect; typing is throttled to one per 3 s', async () => {
  const s = setup();
  const sock = await online(s);
  s.client.setCatStatus(CAT, 'ready');
  s.client.setCatStatus(CAT, 'ready');
  assert.deepEqual(sock.frames('cat.status'), [{ type: 'cat.status', cat_id: CAT, state: 'ready' }]);
  assert.equal(s.client.typing(), true);
  assert.equal(s.client.typing(), false);
  await s.clock.advance(3000);
  assert.equal(s.client.typing(), true);
  assert.equal(sock.frames('typing').length, 2);
  const cat = s.client.sendCat({ cat_id: CAT, in_reply_to: REPLY, trigger: 'mention', text: '喵' });
  assert.deepEqual(sock.frames('cat.message.send'), [{ type: 'cat.message.send', cat_id: CAT, in_reply_to: REPLY, trigger: 'mention',
    text: '喵', client_message_id: U(5001) }]);
  sock.serverClose(1006);
  await s.clock.advance(0);
  const next = await online(s, 100, { connect: false });
  assert.deepEqual(next.frames('cat.status'), [{ type: 'cat.status', cat_id: CAT, state: 'ready' }]);
  assert.equal(next.frames('cat.message.send').length, 1, 'cat sends use the outbox too');
  next.receive({ type: 'ack', client_message_id: U(5001), message_id: U(901), seq: 4, duplicate: false });
  assert.equal((await cat).seq, 4);
  s.client.dispose();
});

test('the client source never touches the disk, logs or console', () => {
  const source = fs.readFileSync(path.join(__dirname, '../../apps/neko-workbench/lobby-client.cjs'), 'utf8');
  assert.ok(!/require\(['"](?:node:)?fs(?:\/promises)?['"]\)/.test(source));
  assert.ok(!/console\.|process\.stdout|process\.stderr|logger/.test(source));
  assert.ok(!/localStorage|sessionStorage|indexedDB/.test(source));
});
