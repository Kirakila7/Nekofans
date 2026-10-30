'use strict';
// Plain-node E2E against a running N.E.K.O.Chat stack (no Electron). Skipped unless
// NEKO_WORKBENCH_CHAT_E2E=1. Start the stack first:
//   cd N.E.K.O.Chat && docker compose --profile dev-auth up -d --build
//   NEKO_WORKBENCH_CHAT_E2E=1 node --test tests/neko-workbench/lobby-e2e.test.cjs
// Optional: NEKO_WORKBENCH_CHAT_URL (default http://127.0.0.1:8091),
//           NEKO_WORKBENCH_CHAT_AUTH_URL (default http://127.0.0.1:8094).
// Two synthetic subjects get tokens from scripts/dev_fake_auth.py (POST /dev/tokens);
// each token goes into a real lobby-client through a fake auth object. The companion
// side is the real lobby-cat with a fake ChatProvider. Nothing here prints message
// text or tokens; failures name the check only.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createLobbyClient } = require('../../apps/neko-workbench/lobby-client.cjs');
const { createLobbyCat } = require('../../apps/neko-workbench/lobby-cat.cjs');

const ENABLED = process.env.NEKO_WORKBENCH_CHAT_E2E === '1';
const CHAT_URL = process.env.NEKO_WORKBENCH_CHAT_URL || 'http://127.0.0.1:8091';
const AUTH_URL = (process.env.NEKO_WORKBENCH_CHAT_AUTH_URL || 'http://127.0.0.1:8094').replace(/\/+$/, '');
const CONFIG = Object.freeze({ configured: true, chatUrl: CHAT_URL });
const RUN = Date.now().toString(36);
const A = { name: `e2e-a-${RUN}`, display: 'A', catName: 'A的猫' };
const B = { name: `e2e-b-${RUN}`, display: 'B', catName: '小黑' };
const SUGGESTION = '合成建议：大家晚上好呀。';
const CAT_REPLY = '合成回复：喵，我在呢。';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function mint(user) {
  const response = await fetch(`${AUTH_URL}/dev/tokens`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: user.name, display_name: user.display, avatar: true, expires_in: 900 }),
  });
  assert.equal(response.status, 200, 'dev_fake_auth /dev/tokens');
  const body = await response.json();
  assert.equal(typeof body.access_token, 'string');
  return { token: body.access_token, sub: body.sub, expiresAt: Date.now() + body.expires_in * 1000 };
}

// The lobby-auth surface lobby-client uses, holding one injected token in memory.
function fakeAuth({ token, expiresAt }) {
  return { async getAccessToken() { return token; }, invalidateAccessToken() {}, get accessExpiresAt() { return expiresAt; } };
}

// WebSocket that records only the cursor of each auth frame (never the token).
function recordingWebSocket(authFrames) {
  return class RecordingWebSocket extends globalThis.WebSocket {
    send(data) {
      try {
        const frame = JSON.parse(data);
        if (frame.type === 'auth') authFrames.push({ lastEventSeq: frame.last_event_seq ?? null });
      } catch { /* not ours to judge */ }
      return super.send(data);
    }
  };
}

// onEvent sink with waitFor(predicate) that also scans events already recorded since `from`.
function recorder(forward = () => {}) {
  const events = [], waiters = new Set();
  return {
    events,
    mark: () => events.length,
    onEvent(type, payload) {
      events.push({ type, payload });
      try { forward(type, payload); } catch { /* observer */ }
      for (const wake of [...waiters]) wake();
    },
    since: (from, type) => events.slice(from).filter(e => e.type === type).map(e => e.payload),
    waitFor(type, predicate, label, { from = 0, ms = 10000 } = {}) {
      return new Promise((resolve, reject) => {
        let timer = null;
        const check = () => {
          for (let i = from; i < events.length; i++) {
            if (events[i].type === type && predicate(events[i].payload)) { finish(); resolve(events[i].payload); return true; }
          }
          return false;
        };
        const finish = () => { clearTimeout(timer); waiters.delete(check); };
        timer = setTimeout(() => { finish(); reject(new Error(`${label}: timed out`)); }, ms);
        if (!check()) waiters.add(check);
      });
    },
  };
}

async function until(fn, label, ms = 10000) {
  const start = Date.now();
  while (Date.now() - start < ms) { if (fn()) return; await sleep(50); }
  throw new Error(`${label}: timed out`);
}

// Fake ChatProvider: one fixed reply; records memory counts, never the prompt.
function fakeProvider(reply) {
  const calls = [];
  return {
    calls,
    async *stream(request) {
      calls.push({ memories: Array.isArray(request.memories) ? request.memories.length : -1 });
      yield { type: 'delta', text: reply };
      yield { type: 'complete', text: reply };
    },
  };
}
const persona = () => ({ name: '大肥鱼', prompt: '合成人设：一只温和的猫娘。' });

// Same shape as lobby-controller's lobbyContext().
function lobbyContext(side) {
  const snap = side.client.snapshot();
  if (snap.status !== 'online' || !side.me) return null;
  const names = new Map();
  for (const m of snap.members) names.set(m.kind === 'cat' ? m.cat_id : m.user_id, m.display_name);
  return { ownerId: side.me.user.user_id, ownerName: side.me.user.display_name, catId: side.cat?.id || null,
    catReady: !!side.cat && !side.cat.admin_disabled, catName: side.user.catName,
    catsEnabled: snap.channel?.cats_enabled !== false, freeAllowed: !!snap.channel?.cat_free_mode_allowed,
    mutedUntil: side.me.muted_until ?? null, note: '', messages: snap.messages, names };
}

// One person's workbench: lobby-client + lobby-cat wired like lobby-controller does.
function workbench(user, creds, { mode, reply }) {
  const side = { user, creds, me: null, cat: null, authFrames: [], provider: fakeProvider(reply) };
  side.events = recorder((type, payload) => {
    if (type === 'message.new' && payload.live) side.lobbyCat?.onMessage(payload.message, { live: true });
    if (type === 'message.deleted') side.lobbyCat?.onDeleted(payload.messageId);
  });
  side.client = createLobbyClient({ config: CONFIG, auth: fakeAuth(creds), WebSocketImpl: recordingWebSocket(side.authFrames),
    onEvent: side.events.onEvent });
  side.lobbyCat = createLobbyCat({ mode, trigger: 'mention', getProvider: () => side.provider, getPersona: persona,
    getLobby: () => lobbyContext(side), catSend: frame => side.client.sendCat(frame), recallMemory: null });
  return side;
}

const findMessage = (side, id) => side.client.snapshot().messages.find(m => m.id === id);

test('lobby e2e against a running N.E.K.O.Chat (two synthetic subjects)', {
  skip: ENABLED ? false : 'set NEKO_WORKBENCH_CHAT_E2E=1 with N.E.K.O.Chat running (docker compose --profile dev-auth up -d)',
  timeout: 120000,
}, async t => {
  assert.equal(typeof globalThis.WebSocket, 'function', 'Node 22+ global WebSocket');
  const [credsA, credsB] = await Promise.all([mint(A), mint(B)]);
  const a = workbench(A, credsA, { mode: 'assist', reply: SUGGESTION });
  const b = workbench(B, credsB, { mode: 'independent', reply: CAT_REPLY });
  let firstId = null;
  try {
    await t.test('both clients reach online with their own identity and cat', async () => {
      a.client.connect(); b.client.connect();
      await until(() => a.client.status === 'online' && b.client.status === 'online', 'online');
      for (const side of [a, b]) {
        side.me = await side.client.rest.me();
        // user_id is N.E.K.O.Chat's own id, not the auth subject; hello reports the same one.
        assert.match(side.me.user.user_id, /^[0-9a-f-]{36}$/);
        assert.equal(side.client.snapshot().userId, side.me.user.user_id);
        assert.equal(side.me.user.display_name, side.user.display, 'display name from the fake profile directory');
        const from = side.events.mark();
        side.cat = await side.client.rest.putCat({ name: side.user.catName, avatarKey: 'default', replyMode: 'mention', enabled: true });
        await side.events.waitFor('cat.updated', p => p.cat?.id === side.cat.id, 'own cat.updated', { from });
      }
      b.client.setCatStatus(b.cat.id, 'ready');
      assert.notEqual(a.me.user.user_id, b.me.user.user_id);
      assert.equal(a.client.snapshot().channel.id, b.client.snapshot().channel.id);
    });

    await t.test("A's message reaches B", async () => {
      const from = b.events.mark();
      const ack = await a.client.send({ text: '合成消息：大家好' });
      firstId = ack.messageId;
      const got = await b.events.waitFor('message.new', p => p.message.id === ack.messageId, 'B receives', { from });
      assert.equal(got.live, true);
      assert.equal(got.message.origin, 'human');
      assert.equal(got.message.label, 'A');
      assert.equal(got.message.author.user_id, a.me.user.user_id);
      assert.equal(got.message.text, '合成消息：大家好');
    });

    await t.test('an assist suggestion produces no lobby message until A confirms it', async () => {
      const fromA = a.events.mark(), fromB = b.events.mark(), seqB = b.client.snapshot().lastEventSeq;
      const result = await a.lobbyCat.requestSuggestion({ targetMessageId: null, instruction: '' });
      assert.equal(result.text, SUGGESTION);
      assert.equal(a.lobbyCat.snapshot().suggestion.state, 'ready');
      assert.equal(a.provider.calls.length, 1);
      await sleep(1500);   // anything sent would have reached B by now
      assert.deepEqual(b.events.since(fromB, 'message.new'), []);
      assert.deepEqual(a.events.since(fromA, 'ack'), []);
      assert.equal(a.client.snapshot().outbox.length, 0);
      assert.equal(b.client.snapshot().lastEventSeq, seqB);
      assert.ok(!b.client.snapshot().messages.some(m => m.text === SUGGESTION));
      a.lobbyCat.discardSuggestion();
    });

    await t.test('A sends an assisted (human_ai) message; B sees 「人＋AI 共同回复 · A与A的猫」', async () => {
      const from = b.events.mark();
      const ack = await a.client.send({ text: SUGGESTION, origin: 'human_ai', assistCatId: a.cat.id });
      const got = await b.events.waitFor('message.new', p => p.message.id === ack.messageId, 'B receives human_ai', { from });
      assert.equal(got.message.origin, 'human_ai');
      assert.equal(got.message.label, '人＋AI 共同回复 · A与A的猫');
      assert.equal(got.message.author.assist_cat?.cat_id, a.cat.id);
    });

    await t.test("B's cat (independent, fake provider) answers a mention with the AI 独立发言 label", async () => {
      const fromA = a.events.mark();
      const ack = await a.client.send({ text: `<@c:${b.cat.id}> 合成提问：在吗？` });
      const got = await a.events.waitFor('message.new', p => p.message.origin === 'cat' && p.message.reply_to?.id === ack.messageId,
        'A receives the cat reply', { from: fromA, ms: 15000 });
      assert.equal(got.message.label, 'AI 独立发言 · B的小黑');
      assert.equal(got.message.author.cat_id, b.cat.id);
      assert.equal(got.message.text, CAT_REPLY);
      assert.equal(b.provider.calls.length, 1);
      assert.equal(b.provider.calls[0].memories, 0, 'independent turns carry no memories');
      assert.equal(a.provider.calls.length, 1, "A's assist-mode cat never generated on its own");
    });

    await t.test('B disconnects, A deletes an old message, B resumes with last_event_seq and gets the deletion', async () => {
      const seqB = b.client.snapshot().lastEventSeq, authCount = b.authFrames.length;
      b.client.disconnect();
      assert.equal(b.client.status, 'idle');
      const fromA = a.events.mark();
      await a.client.rest.deleteMessage(a.client.snapshot().channel.id, firstId);
      await a.events.waitFor('message.deleted', p => p.messageId === firstId, 'A sees the deletion', { from: fromA });
      const fromB = b.events.mark();
      b.client.connect();
      const got = await b.events.waitFor('message.deleted', p => p.messageId === firstId, 'B replays the deletion', { from: fromB });
      assert.equal(got.deletedBy, a.me.user.user_id);
      assert.equal(b.authFrames.length, authCount + 1);
      assert.equal(b.authFrames.at(-1).lastEventSeq, seqB, 'auth frame carries the cursor');
      assert.deepEqual(b.events.since(fromB, 'resync'), [], 'replayed, not reloaded');
      await until(() => b.client.status === 'online', 'B online again');
      const old = findMessage(b, firstId);
      assert.equal(old.deleted, true);
      assert.equal(old.text, null);
      assert.ok(b.client.snapshot().lastEventSeq > seqB);
    });
  } finally {
    for (const side of [a, b]) { side.lobbyCat.dispose(); side.client.dispose(); }
  }
});
