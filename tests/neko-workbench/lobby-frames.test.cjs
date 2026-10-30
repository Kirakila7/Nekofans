'use strict';
// Locks lobby-frames.cjs: every server frame in docs/protocol.md v1 is checked
// against a per-type schema and rebuilt from known fields; unknown types come
// back as 'unknown', malformed as 'invalid', >64 KiB as 'oversized'. Synthetic
// ids and text only.
const test = require('node:test');
const assert = require('node:assert/strict');
const F = require('../../apps/neko-workbench/lobby-frames.cjs');

const U = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const CH = U(1), ALICE = U(2), BOB = U(3), KITTY = U(4), M1 = U(10), M2 = U(11), CMID = U(20);

const humanAuthor = (extra = {}) => ({ kind: 'human', user_id: ALICE, name: '张三', display_name: '张三',
  avatar: { kind: 'hue', hue: 210, text: '张' }, ...extra });
const catAuthor = (extra = {}) => ({ kind: 'cat', cat_id: KITTY, owner_user_id: ALICE, owner_name: '张三',
  name: '大肥鱼', display_name: '张三的大肥鱼', avatar_key: 'fish-blue', ...extra });
function message(extra = {}) {
  return { id: M1, seq: 5, channel_id: CH, created_at: 1730000000000, deleted: false, text: '大家好',
    origin: 'human', label: '张三', author: humanAuthor(), mentions: [], reply_to: null, cat_depth: 0, ...extra };
}
const humanAi = (extra = {}) => message({ origin: 'human_ai', label: '人＋AI 共同回复 · 张三与大肥鱼',
  author: humanAuthor({ assist_cat: { cat_id: KITTY, name: '大肥鱼' } }), ...extra });
const catMessage = (extra = {}) => message({ origin: 'cat', label: 'AI 独立发言 · 张三的大肥鱼', author: catAuthor(),
  cat_depth: 1, reply_to: { id: M2, seq: 4, origin: 'human', label: '李四' }, ...extra });
const newFrame = msg => ({ type: 'message.new', event_seq: 100, message: msg });
const channel = (extra = {}) => ({ id: CH, name: '大厅', topic: '欢迎', slow_mode_seconds: 10, cats_enabled: true,
  cat_free_mode_allowed: false, last_seq: 125, ...extra });
const cat = (extra = {}) => ({ id: KITTY, owner_user_id: ALICE, owner_name: '张三', name: '大肥鱼', display_name: '张三的大肥鱼',
  avatar_key: 'fish-blue', reply_mode: 'mention', enabled: true, admin_disabled: false, ...extra });

test('every protocol server frame type has a schema', () => {
  assert.deepEqual([...F.KNOWN_FRAME_TYPES].sort(), ['ack', 'cat.updated', 'channel.updated', 'error', 'hello',
    'member.updated', 'message.deleted', 'message.new', 'pong', 'presence.join', 'presence.leave', 'presence.snapshot',
    'resync.required', 'typing'].sort());
});

test('hello, ack, pong and resync.required are rebuilt from known fields only', () => {
  assert.deepEqual(F.validateFrame({ type: 'hello', user_id: ALICE.toUpperCase(), token_expires_at: 1730000000000, last_event_seq: 1234, extra: 'x' }),
    { type: 'hello', user_id: ALICE, token_expires_at: 1730000000000, last_event_seq: 1234 });
  assert.equal(F.validateFrame({ type: 'hello', user_id: null, token_expires_at: 1, last_event_seq: 0 }), 'invalid');
  assert.equal(F.validateFrame({ type: 'hello', user_id: ALICE, token_expires_at: -1, last_event_seq: 0 }), 'invalid');
  assert.equal(F.validateFrame({ type: 'hello', user_id: ALICE, token_expires_at: 1, last_event_seq: 1.5 }), 'invalid');

  const ack = { type: 'ack', client_message_id: CMID, message_id: M1, seq: 123, duplicate: false };
  assert.deepEqual(F.validateFrame(ack), ack);
  assert.equal(F.validateFrame({ ...ack, seq: 0 }), 'invalid');
  assert.equal(F.validateFrame({ ...ack, duplicate: 'no' }), 'invalid');
  assert.equal(F.validateFrame({ ...ack, client_message_id: 'cmid-1' }), 'invalid');

  assert.deepEqual(F.validateFrame({ type: 'pong', t: 1730000000000, last_event_seq: 1240 }), { type: 'pong', t: 1730000000000, last_event_seq: 1240 });
  assert.equal(F.validateFrame({ type: 'pong', t: 1, last_event_seq: -1 }), 'invalid');
  assert.deepEqual(F.validateFrame({ type: 'resync.required', reason: 'old' }), { type: 'resync.required' });
});

test('error frames keep only a code-shaped code, an optional uuid ref and a bounded retry_after_ms', () => {
  assert.deepEqual(F.validateFrame({ type: 'error', ref: CMID, code: 'rate_limited', retry_after_ms: 5000, detail: '原文' }),
    { type: 'error', ref: CMID, code: 'rate_limited', retry_after_ms: 5000 });
  assert.deepEqual(F.validateFrame({ type: 'error', code: 'slow_mode' }), { type: 'error', ref: null, code: 'slow_mode', retry_after_ms: null });
  for (const code of ['Rate Limited', '<b>x</b>', '', 'a'.repeat(65), 42]) {
    assert.equal(F.validateFrame({ type: 'error', code }), 'invalid');
  }
  assert.equal(F.validateFrame({ type: 'error', code: 'rate_limited', ref: 'not-a-uuid' }), 'invalid');
  assert.equal(F.validateFrame({ type: 'error', code: 'rate_limited', retry_after_ms: F.MAX_RETRY_AFTER_MS + 1 }), 'invalid');
});

test('message.new human: author, mentions and reply_to origin/label are rebuilt', () => {
  const reply = { id: M2, seq: 4, origin: 'human_ai', label: '人＋AI 共同回复 · 李四与小橘' };
  const out = F.validateFrame(newFrame(message({ mentions: [{ kind: 'user', id: BOB }, { kind: 'cat', id: KITTY }],
    reply_to: reply, author: humanAuthor({ secret: 'x' }) })));
  assert.equal(out.type, 'message.new');
  assert.equal(out.event_seq, 100);
  assert.deepEqual(out.message.author, humanAuthor());
  assert.deepEqual(out.message.reply_to, reply);
  assert.deepEqual(out.message.mentions, [{ kind: 'user', id: BOB }, { kind: 'cat', id: KITTY }]);
  assert.equal(out.message.origin, 'human');
  assert.equal(out.message.label, '张三');
  assert.equal(Object.hasOwn(out.message.author, 'assist_cat'), false);
});

test('message.new human_ai requires author.assist_cat and the co-reply label prefix', () => {
  const out = F.validateFrame(newFrame(humanAi()));
  assert.deepEqual(out.message.author.assist_cat, { cat_id: KITTY, name: '大肥鱼' });
  assert.equal(out.message.label, '人＋AI 共同回复 · 张三与大肥鱼');
  assert.equal(F.validateFrame(newFrame(humanAi({ author: humanAuthor() }))), 'invalid');
  assert.equal(F.validateFrame(newFrame(humanAi({ label: '张三' }))), 'invalid');
  assert.equal(F.validateFrame(newFrame(humanAi({ label: '人＋AI 共同回复 · ' }))), 'invalid');
  // A human message cannot carry assist_cat, and a human name that imitates the cat label is not an AI label.
  assert.equal(F.validateFrame(newFrame(message({ author: humanAuthor({ assist_cat: { cat_id: KITTY, name: '大肥鱼' } }) }))), 'invalid');
  assert.equal(F.validateFrame(newFrame(message({ label: '张三的大肥鱼' }))).message.origin, 'human');
});

test('message.new cat: cat author, independent-speech label and depth 1..2', () => {
  const out = F.validateFrame(newFrame(catMessage()));
  assert.deepEqual(out.message.author, catAuthor());
  assert.equal(out.message.cat_depth, 1);
  assert.deepEqual(out.message.reply_to, { id: M2, seq: 4, origin: 'human', label: '李四' });
  assert.equal(F.validateFrame(newFrame(catMessage({ cat_depth: 2 }))).message.cat_depth, 2);
  for (const bad of [{ cat_depth: 0 }, { cat_depth: 3 }, { label: '张三的大肥鱼' }, { author: humanAuthor() },
    { origin: 'human', label: '张三' }]) {
    assert.equal(F.validateFrame(newFrame(catMessage(bad))), 'invalid', JSON.stringify(Object.keys(bad)));
  }
  assert.equal(F.validateFrame(newFrame(message({ cat_depth: 1 }))), 'invalid');
});

test('reply_to label must agree with its origin; deleted messages carry no text or mentions', () => {
  assert.equal(F.validateFrame(newFrame(message({ reply_to: { id: M2, seq: 4, origin: 'cat', label: '李四' } }))), 'invalid');
  assert.equal(F.validateFrame(newFrame(message({ reply_to: { id: M2, seq: 4, origin: 'robot', label: '李四' } }))), 'invalid');
  assert.equal(F.validateFrame(newFrame(message({ reply_to: { id: M2, seq: 0, origin: 'human', label: '李四' } }))), 'invalid');
  const deleted = F.validateFrame(newFrame(message({ deleted: true, text: null, mentions: [{ kind: 'user', id: BOB }] })));
  assert.equal(deleted.message.text, null);
  assert.deepEqual(deleted.message.mentions, []);
  assert.equal(F.validateFrame(newFrame(message({ deleted: true, text: '还在' }))), 'invalid');
});
test('message fields are bounded: text length, mention count, avatar shape', () => {
  assert.equal(F.validateFrame(newFrame(message({ text: '喵'.repeat(F.MAX_TEXT_CHARS) }))).message.text.length, F.MAX_TEXT_CHARS);
  assert.equal(F.validateFrame(newFrame(message({ text: '喵'.repeat(F.MAX_TEXT_CHARS + 1) }))), 'invalid');
  assert.equal(F.validateFrame(newFrame(message({ text: '' }))), 'invalid');
  assert.equal(F.validateFrame(newFrame(message({ mentions: Array.from({ length: F.MAX_MENTIONS + 1 }, () => ({ kind: 'user', id: BOB })) }))), 'invalid');
  assert.equal(F.validateFrame(newFrame(message({ mentions: [{ kind: 'role', id: BOB }] }))), 'invalid');
  const image = F.validateFrame(newFrame(message({ author: humanAuthor({ avatar: { kind: 'image', url: 'https://community.example.test/a.png' } }) })));
  assert.deepEqual(image.message.author.avatar, { kind: 'image', url: 'https://community.example.test/a.png' });
  for (const avatar of [{ kind: 'image', url: 'http://community.example.test/a.png' }, { kind: 'image', url: 'javascript:alert(1)' },
    { kind: 'hue', hue: 360, text: '张' }, { kind: 'svg', url: 'https://x.test/a.svg' }]) {
    assert.equal(F.validateFrame(newFrame(message({ author: humanAuthor({ avatar }) }))), 'invalid');
  }
  assert.equal(F.validateFrame(newFrame(message({ id: 'm-1' }))), 'invalid');
  assert.equal(F.validateFrame({ type: 'message.new', event_seq: 0, message: message() }), 'invalid');
});

test('message.deleted, channel.updated, member.updated and cat.updated', () => {
  const deleted = { type: 'message.deleted', event_seq: 1236, message_id: M1, seq: 124, deleted_by: BOB };
  assert.deepEqual(F.validateFrame(deleted), deleted);
  assert.equal(F.validateFrame({ ...deleted, deleted_by: undefined }), 'invalid');

  assert.deepEqual(F.validateFrame({ type: 'channel.updated', event_seq: 1237, channel: channel() }),
    { type: 'channel.updated', event_seq: 1237, channel: channel() });
  assert.equal(F.validateFrame({ type: 'channel.updated', event_seq: 1, channel: channel({ slow_mode_seconds: 7 }) }), 'invalid');
  assert.equal(F.validateFrame({ type: 'channel.updated', event_seq: 1, channel: channel({ cats_enabled: 1 }) }), 'invalid');
  assert.equal(F.validateFrame({ type: 'channel.updated', event_seq: 1, channel: channel({ topic: 'x'.repeat(F.MAX_TOPIC_CHARS + 1) }) }), 'invalid');

  const member = { type: 'member.updated', event_seq: 1238, user_id: BOB,
    changes: { display_name: '新昵称', avatar: { kind: 'hue', hue: 1, text: '新' }, role: 'admin', muted_until: 1730000000000, banned_at: null } };
  assert.deepEqual(F.validateFrame(member), member);
  assert.equal(F.validateFrame({ ...member, changes: { role: 'owner' } }), 'invalid');
  // A profile-only update must not read as "unmuted" / "unbanned".
  const profile = F.validateFrame({ ...member, changes: { display_name: '新昵称', avatar: { kind: 'hue', hue: 1, text: '新' } } });
  assert.deepEqual(Object.keys(profile.changes).sort(), ['avatar', 'display_name']);
  assert.deepEqual(F.validateFrame({ ...member, changes: { role: 'member', muted_until: null, banned_at: null } }).changes,
    { role: 'member', muted_until: null, banned_at: null });

  const updated = F.validateFrame({ type: 'cat.updated', event_seq: 1239, cat: cat() });
  assert.deepEqual(updated, { type: 'cat.updated', event_seq: 1239, cat: { ...cat(), deleted: false } });
  assert.equal(F.validateFrame({ type: 'cat.updated', event_seq: 1, cat: cat({ deleted: true }) }).cat.deleted, true);
  // protocol.md leaves name and reply_mode out of cat.updated; both are optional.
  const minimal = F.validateFrame({ type: 'cat.updated', event_seq: 1, cat: cat({ name: undefined, reply_mode: undefined }) });
  assert.equal(minimal.cat.name, null);
  assert.equal(minimal.cat.reply_mode, null);
  for (const bad of [{ reply_mode: 'always' }, { avatar_key: '../x' }, { enabled: 'yes' }, { owner_user_id: 'u' }]) {
    assert.equal(F.validateFrame({ type: 'cat.updated', event_seq: 1, cat: cat(bad) }), 'invalid');
  }
});

test('presence and typing frames (ephemeral, no event_seq)', () => {
  const snapshot = F.validateFrame({ type: 'presence.snapshot', members: [{ user_id: ALICE, online: true }, { cat_id: KITTY, online: false }] });
  assert.deepEqual(snapshot, { type: 'presence.snapshot', members: [{ user_id: ALICE, cat_id: null, online: true },
    { user_id: null, cat_id: KITTY, online: false }] });
  assert.equal(F.validateFrame({ type: 'presence.snapshot', members: [{ online: true }] }), 'invalid');
  assert.equal(F.validateFrame({ type: 'presence.snapshot', members: 'all' }), 'invalid');
  assert.equal(F.validateFrame({ type: 'presence.snapshot', members: Array.from({ length: F.MAX_PRESENCE + 1 }, () => ({ user_id: ALICE, online: true })) }),
    'oversized');

  assert.deepEqual(F.validateFrame({ type: 'presence.join', user_id: ALICE, cat_id: KITTY }), { type: 'presence.join', user_id: ALICE, cat_id: KITTY });
  assert.deepEqual(F.validateFrame({ type: 'presence.leave', user_id: ALICE }), { type: 'presence.leave', user_id: ALICE, cat_id: null });
  assert.equal(F.validateFrame({ type: 'presence.join', cat_id: KITTY }), 'invalid');

  assert.deepEqual(F.validateFrame({ type: 'typing', user_id: ALICE, kind: 'human' }), { type: 'typing', user_id: ALICE, kind: 'human', cat_id: null });
  assert.deepEqual(F.validateFrame({ type: 'typing', user_id: ALICE, kind: 'cat', cat_id: KITTY }), { type: 'typing', user_id: ALICE, kind: 'cat', cat_id: KITTY });
  assert.equal(F.validateFrame({ type: 'typing', user_id: ALICE, kind: 'cat' }), 'invalid');
  assert.equal(F.validateFrame({ type: 'typing', user_id: ALICE, kind: 'human', cat_id: KITTY }), 'invalid');
});

test('unknown types are reported as unknown; non-objects and bad types as invalid', () => {
  for (const type of ['message.edit', 'toString', '__proto__', 'constructor', 'hasOwnProperty']) {
    assert.equal(F.validateFrame({ type }), 'unknown', type);
  }
  for (const value of [null, undefined, 42, 'hello', [], [{ type: 'hello' }]]) assert.equal(F.validateFrame(value), 'invalid');
  assert.equal(F.validateFrame({ type: 7 }), 'invalid');
  assert.equal(F.validateFrame(), 'invalid');
});

test('frames over 64 KiB are oversized, by bytes, before and after JSON.parse', () => {
  const big = { type: 'typing', user_id: ALICE, kind: 'human', pad: '喵'.repeat(22000) }; // ~66 KB in UTF-8, 22k chars
  assert.equal(F.validateFrame(big), 'oversized');
  assert.equal(F.parseFrame(JSON.stringify(big)), 'oversized');
  assert.equal(F.parseFrame(Buffer.from(JSON.stringify(big))), 'oversized');
  assert.equal(F.parseFrame('x'.repeat(F.MAX_FRAME_BYTES + 1)), 'oversized');
});

test('parseFrame accepts string, Buffer, ArrayBuffer and typed arrays; bad JSON is invalid', () => {
  const raw = JSON.stringify({ type: 'pong', t: 1, last_event_seq: 2 });
  const expected = { type: 'pong', t: 1, last_event_seq: 2 };
  assert.deepEqual(F.parseFrame(raw), expected);
  assert.deepEqual(F.parseFrame(Buffer.from(raw)), expected);
  const bytes = new TextEncoder().encode(raw);
  assert.deepEqual(F.parseFrame(bytes), expected);
  assert.deepEqual(F.parseFrame(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)), expected);
  const padded = new Uint8Array(bytes.length + 4); padded.set(bytes, 2);
  assert.deepEqual(F.parseFrame(padded.subarray(2, 2 + bytes.length)), expected);
  assert.equal(F.parseFrame('{"type":'), 'invalid');
  assert.equal(F.parseFrame(42), 'invalid');
  assert.equal(F.parseFrame(JSON.stringify({ type: 'nope' })), 'unknown');
});

test('validation never echoes frame content and never logs', t => {
  const secret = 'fixture-secret-text-Zq81';
  const calls = [];
  for (const method of ['log', 'info', 'warn', 'error', 'debug']) t.mock.method(console, method, (...args) => calls.push(args));
  const results = [
    F.validateFrame({ type: 'error', code: secret }),
    F.validateFrame(newFrame(message({ text: 42, label: secret }))),
    F.validateFrame({ type: secret }),
    F.parseFrame(`{"type":"hello","token":"${secret}"`),
    F.parseFrame(JSON.stringify({ type: 'hello', user_id: ALICE, token_expires_at: 1, last_event_seq: 0, token: secret })),
  ];
  assert.ok(!JSON.stringify(results).includes(secret));
  assert.deepEqual(calls, []);
});

