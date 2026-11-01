'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const { createLobbyController, validateLobbyRequest, readSettings, defaultSettings, ACTIONS, ERR, REASON, MODES, TRIGGERS } = require('../../apps/neko-workbench/lobby-controller.cjs');
const { fakeTimers, flush, fakeProvider, message, owner, myCat, persona, OWNER, CAT, OTHER } = require('./lobby-fixtures.cjs');
const { createLobbyAuth } = require('../../apps/neko-workbench/lobby-auth.cjs');
const { createLobbyClient } = require('../../apps/neko-workbench/lobby-client.cjs');
const { createLobbyAvatars } = require('../../apps/neko-workbench/lobby-avatars.cjs');
const { createLobbyCat } = require('../../apps/neko-workbench/lobby-cat.cjs');

const CHAT = 'https://chat.example.test/', AUTH = 'https://auth.example.test/', CLIENT_ID = 'test-client';
const CONFIG = Object.freeze({ configured: true, chatUrl: CHAT, authUrl: AUTH, clientId: CLIENT_ID, oauthPorts: [17890, 17891] });
const TOKEN = 'fixture-jwt-token-aaaaaaaaaaaaa';
const U = n => `u${String(n).padStart(32, '0')}`;
const CH = 'ch-lobby', ME = U(1);
const CAT_ID = 'cccccccc-0000-4000-8000-000000000001', MSG_ID = 'dddddddd-0000-4000-8000-000000000001';

test('validateLobbyRequest accepts known actions with exact key sets', () => {
  const valid = { action: 'state' };
  assert.deepEqual(validateLobbyRequest(valid), { action: 'state' });
  assert.equal(validateLobbyRequest({ action: 'send', text: '你好', replyToId: undefined, origin: 'human', assistCatId: undefined }).action, 'send');
  assert.throws(() => validateLobbyRequest({ action: 'send', text: '你好', origin: 'human', extra: 42 }), { code: 'lobby_request' });
  assert.throws(() => validateLobbyRequest({ action: 'unknown' }), { code: 'lobby_request' });
  assert.throws(() => validateLobbyRequest('state'), { code: 'lobby_request' });
});

test('validateLobbyRequest rejects human_ai without assistCatId', () => {
  assert.throws(() => validateLobbyRequest({ action: 'send', text: '你好', origin: 'human_ai' }), { message: '共同回复需要猫娘 ID' });
  assert.throws(() => validateLobbyRequest({ action: 'send', text: '你好', origin: 'human', assistCatId: CAT_ID }), { message: '普通消息不能带猫娘 ID' });
  assert.throws(() => validateLobbyRequest({ action: 'send', text: '你好', origin: 'human_ai', assistCatId: CAT }), { code: 'lobby_request' });
  const ok = validateLobbyRequest({ action: 'send', text: '你好', origin: 'human_ai', assistCatId: CAT_ID });
  assert.equal(ok.origin, 'human_ai');
  assert.equal(ok.assistCatId, CAT_ID);
});

test('validateLobbyRequest normalizes UUIDs to lowercase', () => {
  const req = validateLobbyRequest({ action: 'admin-delete', messageId: 'AAAAAAAA-0000-4000-8000-000000000001' });
  assert.equal(req.messageId, 'aaaaaaaa-0000-4000-8000-000000000001');
});

test('readSettings merges defaultSettings with on-disk JSON', async t => {
  const tmpDir = await fs.promises.mkdtemp(os.tmpdir() + '/lobby-test-');
  t.after(() => fs.promises.rm(tmpDir, { recursive: true, force: true }));
  const file = tmpDir + '/cat.json';
  const defaults = defaultSettings();
  fs.writeFileSync(file, JSON.stringify({ version: 1, mode: 'independent', dailyLimit: 100, personaId: 'test-persona' }));
  const loaded = readSettings(file);
  assert.equal(loaded.mode, 'independent');
  assert.equal(loaded.dailyLimit, 100);
  assert.equal(loaded.personaId, 'test-persona');
  assert.equal(loaded.name, null);
  assert.equal(loaded.independentTrigger, defaults.independentTrigger);
});

test('readSettings rejects invalid JSON versions or malformed fields', async t => {
  const tmpDir = await fs.promises.mkdtemp(os.tmpdir() + '/lobby-test-');
  t.after(() => fs.promises.rm(tmpDir, { recursive: true, force: true }));
  const file = tmpDir + '/cat.json';
  fs.writeFileSync(file, JSON.stringify({ version: 99, mode: 'unknown' }));
  const loaded = readSettings(file);
  assert.deepEqual(loaded, defaultSettings());
  fs.writeFileSync(file, JSON.stringify({ version: 1, mode: 'off', dailyLimit: -5, name: 'x'.repeat(100) }));
  const rejected = readSettings(file);
  assert.equal(rejected.mode, 'off');
  assert.equal(rejected.dailyLimit, 200);
  assert.equal(rejected.name, null);
});

function mockAuth({ config, secretStore, openExternal, now, randomBytes, onState }) {
  let status = 'signed-out', generation = 0;
  const publish = next => { status = next; setImmediate(() => onState()); };
  return {
    get state() { return { status, signedIn: status === 'signed-in', message: status === 'unconfigured' ? '频道服务未配置。' : '', error: '' }; },
    accessExpiresAt: null,
    signIn: async () => { publish('signed-in'); },
    cancelSignIn: async () => { publish('signed-out'); },
    signOut: async () => { generation++; publish('signed-out'); },
    refresh: async () => {},
    getAccessToken: async () => TOKEN,
    invalidateAccessToken: () => {},
    dispose: () => {},
  };
}

function mockClient({ config, auth, onEvent, onChange, now }) {
  let status = 'idle', meValue = null, channelValue = null, connected = false, generation = 0;
  let messages = [];
  const publish = () => setImmediate(() => onChange());
  const emit = (type, payload) => setImmediate(() => onEvent(type, payload));
  return {
    configured: true,
    status, generation,
    snapshot: () => ({ status, error: null, userId: meValue?.user.user_id, channel: channelValue,
      messages, hasMore: false, nextBeforeSeq: null, members: [], online: [], lastEventSeq: 0, outbox: [], stats: {} }),
    connect: () => { status = 'online'; connected = true; publish(); },
    disconnect: () => { status = 'idle'; connected = false; publish(); },
    reset: () => { generation++; status = 'idle'; meValue = null; channelValue = null; connected = false; publish(); },
    dispose: () => { generation++; },
    loadOlder: async () => ({ added: 0, hasMore: false }),
    typing: () => {},
    setCatStatus: () => {},
    retry: async () => {},
    discard: () => {},
    send: async input => ({ clientMessageId: 'msg-' + Date.now() }),
    sendCat: async input => ({ clientMessageId: 'cat-' + Date.now() }),
    setMe: newMe => { meValue = newMe; publish(); },
    addMessages: (list) => { messages = list; publish(); },
    setChannel: ch => { channelValue = ch; publish(); },
    rest: {
      configured: true,
      me: async () => meValue || { user: { user_id: ME, name: 'user1', display_name: '用户一', avatar: { kind: 'hue', hue: 10, text: '用' } },
        role: 'member', is_admin: false, muted_until: null, banned_at: null, cat: null, limits: {} },
      lobby: async () => ({ id: CH, name: '大厅', topic: '', slow_mode_seconds: 0, cats_enabled: true, cat_free_mode_allowed: false, last_seq: 10 }),
      history: async () => ({ messages: [], has_more: false, next_before_seq: null }),
      members: async () => ({ members: [] }),
      getCat: async () => null,
      putCat: async input => ({ id: CAT, owner_user_id: ME, name: input.name, display_name: input.name, avatar_key: input.avatarKey,
        reply_mode: input.replyMode, enabled: input.enabled, admin_disabled: false, deleted: false }),
      deleteCat: async () => {},
      deleteMessage: async () => {},
      updateChannel: async () => {},
      mute: async () => {},
      unmute: async () => {},
      ban: async () => {},
      unban: async () => {},
      setRole: async () => {},
      disableCat: async () => {},
      enableCat: async () => {},
      moderationActions: async () => ({ actions: [] }),
      abortAll: () => {},
      dispose: () => {},
    },
  };
}

function mockAvatars() {
  return {
    get: (av, opts) => av || { kind: 'hue', hue: 0, text: 'X' },
    resolve: async a => a,
    clear: () => {},
    size: () => 0,
    communityOrigin: 'https://community.example.test',
  };
}

function mockCat(deps) {
  let mode = deps.mode || 'assist', trigger = deps.trigger || 'mention', modeEpoch = 0, card = null, nudge = null;
  const publish = () => setImmediate(() => deps.onChange());
  return {
    snapshot: () => ({ mode, independentTrigger: trigger, available: !!deps.getProvider(), status: 'idle', error: '',
      suggestion: card, nudge, usage: { today: 0, limit: deps.dailyLimit || 200 } }),
    token: () => ({ mode, modeEpoch, targetMessageId: null, draftEpoch: 0 }),
    setMode: (m, t) => { mode = m; if (t !== undefined) trigger = t; modeEpoch++; publish(); return {}; },
    retarget: () => {},
    requestSuggestion: async opts => { card = { id: 'sugg-1', targetId: opts.targetMessageId, text: '建议文本', state: 'ready' }; publish(); return card; },
    cancelSuggestion: () => { card = null; publish(); return {}; },
    discardSuggestion: () => { card = null; publish(); return {}; },
    onMessage: () => false,
    onDeleted: () => {},
    clearNudge: () => { nudge = null; publish(); },
    invalidate: () => { modeEpoch++; card = null; nudge = null; publish(); },
    dispose: () => {},
  };
}

function setup({ clock = fakeTimers(), config = CONFIG, secretStore = null, provider = null, persona: personaValue = persona(),
  recallMemory = null, recordSharedExperience = null, dataDir = null, env = {}, onClient = null, onAuth = null } = {}) {
  const states = [];
  const factories = {
    auth: deps => { const auth = mockAuth(deps); onAuth?.(auth); return auth; },
    client: deps => { const value = mockClient(deps); onClient?.(value, deps); return value; },
    avatars: () => mockAvatars(),
    cat: deps => mockCat(deps),
    experience: () => null,
  };
  const controller = createLobbyController({ env, config, dataDir, secretStore, openExternal: () => {}, getChatProvider: () => provider,
    getPersona: () => personaValue, recallMemory, recordSharedExperience, onState: s => states.push(s), timers: clock.timers,
    now: clock.now, random: () => 0.01, newId: () => 'test-id-' + states.length, randomBytes: n => Buffer.alloc(n),
    fetchImpl: globalThis.fetch, factories });
  return { controller, states, clock, factories };
}

test('controller unconfigured when config missing', async () => {
  const { controller } = setup({ config: { configured: false } });
  const state = controller.snapshot();
  assert.equal(state.connection, 'unconfigured');
  assert.equal(state.auth.status, 'unconfigured');
  const res = await controller.request({ action: 'state' });
  assert.equal(res.ok, true);
  assert.equal(res.state.connection, 'unconfigured');
});

test('controller reports failed sign-out instead of returning success', async () => {
  const { SAFE_ERROR } = require('../../apps/neko-workbench/lobby-auth.cjs');
  for (const throws of [false, true]) {
    const { controller } = setup({ onAuth: auth => {
      auth.signOut = async () => {
        if (throws) throw Error('synthetic private filesystem detail');
        return { status: 'signed-out', error: SAFE_ERROR.signout };
      };
    } });
    const result = await controller.request({ action: 'sign-out' });
    assert.equal(result.ok, false);
    assert(!JSON.stringify(result).includes('synthetic private'));
    if (!throws) assert.equal(result.error, SAFE_ERROR.signout);
    controller.dispose();
  }
});

test('controller projects a retry action only for pending credential cleanup', async () => {
  const { SAFE_ERROR } = require('../../apps/neko-workbench/lobby-auth.cjs');
  let state = { status: 'signed-out', error: SAFE_ERROR.signout };
  const { controller } = setup({ onAuth: auth => {
    Object.defineProperty(auth, 'state', { get: () => state });
    auth.signOut = async () => { state = { status: 'signed-out', error: '' }; return state; };
  } });
  assert.equal(controller.snapshot().auth.canRetrySignOut, true);
  const result = await controller.request({ action: 'sign-out' });
  assert.equal(result.ok, true);
  assert.equal(result.state.auth.canRetrySignOut, false);
  state = { status: 'signed-out', error: SAFE_ERROR.expired };
  assert.equal(controller.snapshot().auth.canRetrySignOut, false);
  controller.dispose();
});

test('controller sign-in and sign-out', async () => {
  const { controller, states, clock } = setup();
  await clock.advance(100);
  assert.equal(controller.snapshot().auth.status, 'signed-out');
  const signIn = await controller.request({ action: 'sign-in' });
  assert.equal(signIn.ok, true);
  await clock.advance(100);
  assert.equal(controller.snapshot().auth.status, 'signed-in');
  const signOut = await controller.request({ action: 'sign-out' });
  assert.equal(signOut.ok, true);
  await clock.advance(100);
  assert.equal(controller.snapshot().auth.status, 'signed-out');
});

test('controller requires sign-in before open', async () => {
  const { controller } = setup();
  const res = await controller.request({ action: 'open' });
  assert.equal(res.ok, false);
  assert.match(res.error, /登录/);
});

test('controller snapshot excludes tokens and raw responses', async () => {
  const { controller, clock } = setup();
  await controller.request({ action: 'sign-in' });
  await controller.request({ action: 'open' });
  await clock.advance(100);
  const snap = controller.snapshot();
  const json = JSON.stringify(snap);
  assert.ok(!json.includes(TOKEN));
  assert.ok(!json.includes('access_token'));
  assert.ok(!json.includes('fixture-secret'));
  assert.ok(snap.me);
  assert.ok(snap.me.user_id);
});

test('controller dispose stops auth and client', () => {
  const { controller } = setup();
  controller.dispose();
  const snap = controller.snapshot();
  assert.equal(snap.error, ERR.disposed);
});

test('participation.available is false without provider', async () => {
  const { controller, clock } = setup({ provider: null });
  await controller.request({ action: 'sign-in' });
  await controller.request({ action: 'open' });
  await clock.advance(100);
  const snap = controller.snapshot();
  assert.equal(snap.participation.available, false);
  assert.equal(snap.participation.reason, REASON.provider);
});

test('send action dispatches to client.send', async () => {
  const { controller, clock } = setup();
  await controller.request({ action: 'sign-in' });
  await controller.request({ action: 'open' });
  await clock.advance(100);
  const res = await controller.request({ action: 'send', text: '你好', origin: 'human' });
  assert.equal(res.ok, true);
});

test('mode-set updates settings and notifies cat', async () => {
  const { controller, clock } = setup({ provider: fakeProvider() });
  await controller.request({ action: 'sign-in' });
  await controller.request({ action: 'open' });
  await clock.advance(100);
  const res = await controller.request({ action: 'mode-set', mode: 'independent', trigger: 'owner_or_mention' });
  assert.equal(res.ok, true);
  const snap = controller.snapshot();
  assert.equal(snap.catSettings.mode, 'independent');
  assert.equal(snap.catSettings.independentTrigger, 'owner_or_mention');
});

test('admin actions require is_admin', async () => {
  const { controller, clock } = setup();
  await controller.request({ action: 'sign-in' });
  await controller.request({ action: 'open' });
  await clock.advance(100);
  const res = await controller.request({ action: 'admin-delete', messageId: MSG_ID });
  assert.equal(res.ok, false);
  assert.match(res.error, /管理员/);
});

test('admins delete any message; authors delete their own human messages', async () => {
  let client = null, events = null;
  const { controller, clock } = setup({ onClient: (value, deps) => { client = value; events = deps.onEvent; } });
  await controller.request({ action: 'sign-in' });
  await controller.request({ action: 'open' });
  await clock.advance(100);
  const own = { id: MSG_ID, seq: 1, channel_id: CH, created_at: Date.now(), deleted: false,
    text: 'my message', origin: 'human', label: '我', author: { kind: 'human', user_id: ME, name: 'user1', display_name: '用户一' }, mentions: [], reply_to: null, cat_depth: 0 };
  const other = { ...own, id: 'eeeeeeee-0000-4000-8000-000000000001', seq: 2, author: { kind: 'human', user_id: U(2), name: 'user2', display_name: '用户二' }, label: '用户二' };
  client.setChannel({ id: CH, name: '公共大厅', topic: '', slow_mode_seconds: 0, cats_enabled: true, cat_free_mode_allowed: false });
  client.addMessages([own, other]);
  await clock.advance(1);
  let res = await controller.request({ action: 'admin-delete', messageId: other.id });
  assert.equal(res.ok, false, 'members cannot delete others\' messages');
  res = await controller.request({ action: 'admin-delete', messageId: own.id });
  assert.equal(res.ok, true, 'authors delete their own human messages');
  events('member.updated', { userId: ME, changes: { role: 'admin' } });
  await clock.advance(50);
  res = await controller.request({ action: 'admin-delete', messageId: other.id });
  assert.equal(res.ok, true, 'admins delete any message');
});

test('member.updated keeps an env admin from /me and drops admin on ban', async () => {
  let client = null, events = null;
  const { controller, clock } = setup({ onClient: (value, deps) => {
    client = value; events = deps.onEvent;
    client.setMe({ user: { user_id: ME, name: 'user1', display_name: '用户一', avatar: { kind: 'hue', hue: 10, text: '用' } },
      role: 'member', is_admin: true, muted_until: null, banned_at: null, cat: null, limits: {} });
  } });
  await controller.request({ action: 'sign-in' });
  await controller.request({ action: 'open' });
  await clock.advance(100);
  assert.equal(controller.snapshot().me.is_admin, true);
  events('member.updated', { userId: ME, changes: { role: 'member', muted_until: null, banned_at: null } });
  await clock.advance(50);
  assert.equal(controller.snapshot().me.is_admin, true, 'a role change does not revoke env admin');
  events('member.updated', { userId: ME, changes: { role: 'member', muted_until: null, banned_at: 1730000000000 } });
  await clock.advance(50);
  assert.equal(controller.snapshot().me.is_admin, false, 'banned members are never admins');
});

test('cat-save writes settings file when dataDir is provided', async t => {
  const tmpDir = await fs.promises.mkdtemp(os.tmpdir() + '/lobby-test-');
  t.after(() => fs.promises.rm(tmpDir, { recursive: true, force: true }));
  const catFile = tmpDir + '/cat.json';
  const { controller, clock } = setup({ dataDir: tmpDir });
  await controller.request({ action: 'sign-in' });
  await controller.request({ action: 'open' });
  await clock.advance(100);
  const res = await controller.request({ action: 'cat-save', name: '新名字', dailyLimit: 150 });
  assert.equal(res.ok, true);
  assert.ok(fs.existsSync(catFile));
  const saved = readSettings(catFile);
  assert.equal(saved.name, '新名字');
  assert.equal(saved.dailyLimit, 150);
});
test('mode-set bumps the cat modeEpoch', async () => {
  const { controller, clock } = setup({ provider: fakeProvider() });
  await controller.request({ action: 'sign-in' });
  await controller.request({ action: 'open' });
  await clock.advance(100);
  const before = controller.snapshot().cat.modeEpoch;
  assert.equal((await controller.request({ action: 'mode-set', mode: 'off' })).ok, true);
  assert.ok(controller.snapshot().cat.modeEpoch > before);
});

test('a throwing factory is contained and requests still resolve', async () => {
  const controller = createLobbyController({ config: CONFIG, factories: { auth: () => { throw new Error('boom'); } } });
  assert.equal(controller.snapshot().connection, 'unconfigured');
  const res = await controller.request({ action: 'sign-in' });
  assert.equal(res.ok, false);
  assert.ok(!JSON.stringify(res).includes('boom'));
  controller.dispose();
});
