'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { createVisitsController } = require('../../apps/neko-workbench/visits/controller.cjs');
const { createVisitSession } = require('../../apps/neko-workbench/visits/session.cjs');
const { VisitStore } = require('../../apps/neko-workbench/visits/store.cjs');
const A = '10000000-0000-0000-0000-000000000001', B = '10000000-0000-0000-0000-000000000002';
const tick = () => new Promise(r => setImmediate(r));
async function until(fn, timeout = 4000) { const end = Date.now() + timeout; while (!fn()) { if (Date.now() > end) throw Error('condition timed out'); await new Promise(r => setTimeout(r, 10)); } }
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'neko-visits-controller-'));
  const controllers = [], rooms = new Map(), notices = new Map([[A, []], [B, []]]), cancels = [], generated = [], presenceWrites = [];
  let unsupportedEndAccesses = 0;
  let notificationFailure = false, transportFailure = false;
  const presence = new Map([[A, 'invisible'], [B, 'online']]);
  function social(id) {
    const other = id === A ? B : A;
    const client = {
      listFriends: async () => ({ userId: id, items: [{ id: other, is_mutual: true, online: true, display_name: other === A ? '甲' : '乙' }] }),
      presence: async value => { if (value) { presence.set(id, value); presenceWrites.push([id, value]); } return { status: presence.get(id) }; },
      notifications: async () => ({ items: notices.get(id) }),
      createRoom: async args => { rooms.set(args.visitId, { host: id, target: args.targetUserId, endpoints: new Map() }); return grant(args.visitId, 'host'); },
      joinRoom: async args => { assert.equal(rooms.get(args.visitId).target, id); return grant(args.visitId, 'guest'); },
      inviteNotification: async (target, visitId) => {
        if (notificationFailure) throw Error('notification_failed');
        notices.get(target).push({ id: randomUUID(), payload: { type: 'visit_invite', visit_id: visitId, actor_id: id, expires_at: Date.now() / 1000 + 600 } });
      },
      respondInvite: async (notificationId, accepted) => { const n = notices.get(id).find(n => n.id === notificationId); n.payload.response = accepted ? 'accepted' : 'declined'; },
      cancelRoom: async visitId => { cancels.push(visitId); }, pubkeys: async () => ({ keys: [], revoked: [] }),
    };
    // The deployed backend has no /end API. Count even a swallowed attempted
    // method access so a compatibility regression cannot pass as a quiet 404.
    return new Proxy(client, { get(target, key) { if (key === 'endRoom') unsupportedEndAccesses++; return target[key]; } });
  }
  function grant(visitId, role) { return { mode: 'text', mediaPolicy: 'client-only', role, visit_id: visitId, vid: role + '-vid', transport: 'livekit', identity_ticket: role,
    expires_at: Date.now() / 1000 + 3000, direct_invite_expires_at: Date.now() / 1000 + 600, publish: { audio: false } }; }
  async function transport(grant) {
    if (transportFailure) throw Error('rtc_failed');
    const room = rooms.get(grant.visit_id), endpoint = { message: null, backlog: [], closed: false };
    room.endpoints.set(grant.role, endpoint);
    return {
      send(frame) {
        if (endpoint.closed) return;
        const remote = room.endpoints.get(grant.role === 'host' ? 'guest' : 'host');
        if (!remote || remote.closed) return;
        const event = { senderVid: grant.vid, frame: structuredClone(frame) };
        if (remote.message) queueMicrotask(() => remote.message?.(event)); else remote.backlog.push(event);
      },
      onMessage(cb) { endpoint.message = cb; for (const ev of endpoint.backlog.splice(0)) queueMicrotask(() => endpoint.message?.(ev)); return () => { endpoint.message = null; }; },
      onDisconnect() { return () => {}; }, close() { endpoint.closed = true; endpoint.message = null; },
    };
  }
  function make(id, overrides = {}) {
    const ctl = createVisitsController({ dataDir: path.join(directory, id), repositoryRoot: path.resolve(__dirname, '../..'),
      oauth: { login: async () => {}, logout: async () => {}, close() {}, getAccessToken: async () => 'not-a-real-token' },
      social: social(id), createTransport: transport,
      getModelConfig: () => ({ protocol: 'openai-compatible', baseUrl: 'https://model.invalid', model: 'fixture' }), getModelSecret: () => 'fixture-key',
      verifyTicket: (_ticket, options) => ({ visit_id: options.visitId, vid: options.vid, role: options.role }),
      sessionFactory: opts => createVisitSession({ ...opts, retryMs: 20 }),
      generate: async input => { generated.push(input); return '猫娘' + id.slice(-1) + '说第' + (input.messages.length + 1) + '句话'; },
      pollMs: 100000, drainMs: 50, ...overrides }); controllers.push(ctl); return ctl;
  }
  t.after(async () => { for (const c of controllers) await c.close(); fs.rmSync(directory, { recursive: true, force: true }); assert.equal(unsupportedEndAccesses, 0, 'must not call the unavailable /end API'); });
  return { make, social, directory, cancels, generated, rooms, presenceWrites,
    failNotification: () => { notificationFailure = true; }, failTransport: () => { transportFailure = true; } };
}

test('community daily capability is main-only and fenced by account generation and logout', async t => {
  const f=fixture(t),service=f.social(A),sent=[];
  service.publishDaily=async value=>{value.assertCurrent();sent.push(value);return {id:'synthetic-post'};};
  const a=f.make(A,{social:service});assert.equal(a.communityIdentity(),null);await a.action({action:'login'});
  const identity=a.communityIdentity();assert.equal(identity.userId,A);
  await a.publishDaily({identity,title:'今日小记',body:'合成日常'});assert.equal(sent.length,1);assert.equal(sent[0].ownerId,A);
  await assert.rejects(a.action({action:'publishDaily',body:'renderer cannot publish'}));
  await a.action({action:'stop'});await assert.rejects(a.publishDaily({identity,title:'旧会话',body:'不能发送'}),/account_changed/);
  const current=a.communityIdentity();await a.action({action:'logout'});assert.equal(a.communityIdentity(),null);
  await assert.rejects(a.publishDaily({identity:current,title:'已退出',body:'不能发送'}),/account_changed/);assert.equal(sent.length,1);
});

test('existing backend without end API completes six lines, drains RTC and preserves isolated account history', async t => {
  const f = fixture(t), a = f.make(A), b = f.make(B);
  await a.action({ action: 'login' }); await b.action({ action: 'login' });
  await a.action({ action: 'savePersona', name: '甲猫', description: '公开介绍' });
  const invited = await a.action({ action: 'invite', userId: B }); assert.equal(invited.busy, false); await b.action({ action: 'refresh' });
  assert.equal(b.snapshot().invitations.length, 1);
  await b.action({ action: 'accept', notificationId: b.snapshot().invitations[0].notificationId });
  await until(() => a.snapshot().session.phase === 'ended' && b.snapshot().session.phase === 'ended');
  assert.equal(a.snapshot().session.messages.length, 6); assert.equal(b.snapshot().session.messages.length, 6);
  assert.deepEqual(a.snapshot().session.messages, b.snapshot().session.messages);
  assert.equal(f.generated.length, 6);
  assert.ok(f.generated.every(input => Object.keys(input).sort().join(',') === 'messages,persona,signal'));
  const visitId = a.snapshot().session.visitId;
  assert.equal((await a.action({ action: 'history', visitId })).history.messages.length, 6);
  assert.ok([...f.rooms.get(visitId).endpoints.values()].every(e => !e.closed));
  assert.equal(a.snapshot().error, null); assert.equal(b.snapshot().error, null);
  assert.equal(a.snapshot().session.cloudEndConfirmed, undefined);
  assert.ok(!fs.existsSync(path.join(f.directory, A, 'main-chat')));
  await a.action({ action: 'logout' }); assert.equal(a.snapshot().history.length, 0);
  await assert.rejects(a.action({ action: 'history', visitId }), /login_required/);
  assert.deepEqual(f.presenceWrites.filter(([id]) => id === A).at(-1), [A, 'invisible']);
  await b.action({ action: 'logout' }); assert.ok(f.presenceWrites.filter(([id]) => id === B).every(([, status]) => status === 'online'));
  assert.equal(f.cancels.length, 0);
  assert.ok([...f.rooms.get(visitId).endpoints.values()].every(e => e.closed));
});

test('notification and transport failures roll back created rooms', async t => {
  const f = fixture(t), a = f.make(A); await a.action({ action: 'login' });
  f.failNotification(); await assert.rejects(a.action({ action: 'invite', userId: B }), /notification_failed/);
  assert.equal(f.cancels.length, 1); assert.equal(a.snapshot().session.phase, 'error');
  f.failTransport(); await assert.rejects(a.action({ action: 'invite', userId: B }), /rtc_failed/);
  assert.equal(f.cancels.length, 2);
});

test('missing OAuth registration stays signed out and exposes configuration error', async t => {
  const f = fixture(t), a = f.make(A, { oauth: undefined, social: undefined });
  assert.equal(a.snapshot().configured, false);
  await assert.rejects(a.action({ action: 'login' }), /config_not_ready/);
  assert.equal(a.snapshot().account.signedIn, false); assert.equal(a.snapshot().error, 'config_not_ready');
});

test('no model prevents room creation and missing mutual online friends cannot be invited', async t => {
  const f = fixture(t), a = f.make(A, { getModelSecret: () => null }); await a.action({ action: 'login' });
  await assert.rejects(a.action({ action: 'invite', userId: B }), /chat_model_not_ready/); assert.equal(f.rooms.size, 0);
  const b = f.make(B); await b.action({ action: 'login' });
  await assert.rejects(b.action({ action: 'invite', userId: randomUUID() }), /friend_not_available/); assert.equal(f.rooms.size, 0);
});

test('stop fences a late room result and prevents transport creation', async t => {
  const f = fixture(t), gate = deferred(), service = f.social(A); let transports = 0;
  const createRoom = service.createRoom; service.createRoom = async args => { await gate.promise; return createRoom(args); };
  const a = f.make(A, { social: service, createTransport: async () => { transports++; throw Error('must not run'); } });
  await a.action({ action: 'login' }); const creating = a.action({ action: 'invite', userId: B });
  await until(() => a.snapshot().session?.phase === 'connecting');
  await a.action({ action: 'stop' }); gate.resolve(); await assert.rejects(creating, /visit_cancelled/);
  assert.equal(transports, 0); assert.equal(f.cancels.length, 1); assert.equal(a.snapshot().session.phase, 'ended');
});

test('single in-flight visit and abort signal stop a pending RTC join', async t => {
  const f = fixture(t), gate = deferred(); let signal, lateClosed = false;
  const a = f.make(A, { createTransport: async (_grant, s) => { signal = s; await gate.promise; return { close() { lateClosed = true; } }; } });
  await a.action({ action: 'login' }); const creating = a.action({ action: 'invite', userId: B });
  await until(() => !!signal); await assert.rejects(a.action({ action: 'invite', userId: B }), /visit_busy/);
  await a.action({ action: 'stop' }); assert.equal(signal.aborted, true); gate.resolve(); await assert.rejects(creating, /visit_cancelled/);
  assert.equal(lateClosed, true);
});

test('stop while generating discards late output and leaves private chat untouched', async t => {
  const f = fixture(t), gate = deferred(); let generating = false;
  const a = f.make(A, { generate: async ({ signal }) => { generating = true; await gate.promise; assert.equal(signal.aborted, true); return 'late secret-looking text'; } }), b = f.make(B);
  await a.action({ action: 'login' }); await b.action({ action: 'login' });
  await a.action({ action: 'invite', userId: B }); await b.action({ action: 'refresh' });
  await b.action({ action: 'accept', notificationId: b.snapshot().invitations[0].notificationId });
  await until(() => generating); await a.action({ action: 'stop' }); gate.resolve(); await tick(); await tick();
  assert.equal(a.snapshot().session.messages.length, 0); assert.equal(b.snapshot().session.messages.length, 0);
});

test('logout during accept cannot reactivate session or expose old history', async t => {
  const f = fixture(t), a = f.make(A), service = f.social(B), gate = deferred(); const join = service.joinRoom;
  service.joinRoom = async args => { await gate.promise; return join(args); };
  const b = f.make(B, { social: service }); await a.action({ action: 'login' }); await b.action({ action: 'login' });
  await a.action({ action: 'invite', userId: B }); await b.action({ action: 'refresh' });
  const accepting = b.action({ action: 'accept', notificationId: b.snapshot().invitations[0].notificationId });
  await until(() => b.snapshot().session?.phase === 'connecting'); const leaving = b.action({ action: 'logout' });
  gate.resolve(); await assert.rejects(accepting, /visit_cancelled/); await leaving;
  assert.equal(b.snapshot().account.signedIn, false); assert.equal(b.snapshot().session, null); assert.deepEqual(b.snapshot().history, []);
});

test('invite waits out an earlier refresh epoch without losing the new operation', async t => {
  const f = fixture(t), service = f.social(A), a = f.make(A, { social: service }), gate = deferred();
  await a.action({ action: 'login' }); const original = service.notifications; let waiting = true;
  service.notifications = async () => { if (waiting) { waiting = false; await gate.promise; } return original(); };
  const refreshing = a.action({ action: 'refresh' }); await tick();
  const inviting = a.action({ action: 'invite', userId: B }); gate.resolve();
  await assert.rejects(refreshing, /visit_cancelled/); const result = await inviting;
  assert.equal(result.busy, false); assert.equal(result.session.phase, 'connecting');
});

test('logout waits for an in-flight heartbeat before restoring owned presence', async t => {
  const f = fixture(t), service = f.social(A), a = f.make(A, { social: service }), gate = deferred();
  await a.action({ action: 'login' }); const original = service.presence; let pending = false;
  service.presence = async value => { if (value === 'online') { pending = true; await gate.promise; } return original(value); };
  const refreshing = a.action({ action: 'refresh' }); await until(() => pending);
  const leaving = a.action({ action: 'logout' }); gate.resolve();
  await assert.rejects(refreshing, /visit_cancelled/); await leaving;
  assert.deepEqual(f.presenceWrites.at(-1), [A, 'invisible']); assert.equal(a.snapshot().account.signedIn, false);
});

test('switching accounts on the same controller cannot read previous account history', async t => {
  const f = fixture(t), service = f.social(A), a = f.make(A, { social: service });
  await a.action({ action: 'login' }); await a.action({ action: 'invite', userId: B });
  const visitId = a.snapshot().session.visitId; assert.equal(a.snapshot().history.length, 1);
  await a.action({ action: 'logout' }); Object.assign(service, f.social(B));
  await a.action({ action: 'login' }); assert.equal(a.snapshot().account.id, B); assert.deepEqual(a.snapshot().history, []);
  await assert.rejects(a.action({ action: 'history', visitId }), /history_not_found/);
});

test('startup without saved credentials stays signed out and does not open the browser', async t => {
  const f = fixture(t); let browserLogins = 0, reads = 0;
  const a = f.make(A, { oauth: { getAccessToken: async () => { reads++; return null; },
    login: async () => { browserLogins++; }, logout: async () => {}, close() {} } });
  const result = await a.initialize();
  assert.equal(result.account.signedIn, false); assert.equal(result.busy, false);
  await a.initialize(); assert.equal(reads, 1); assert.equal(browserLogins, 0);
  await a.action({ action: 'login' }); assert.equal(browserLogins, 1);
  assert.equal(a.snapshot().account.signedIn, true);
});

test('restart restores saved account and history without rejoining or generating', async t => {
  const f = fixture(t), first = f.make(A);
  await first.action({ action: 'login' }); await first.action({ action: 'invite', userId: B });
  const visitId = first.snapshot().session.visitId;
  await first.close();
  let browserLogins = 0, transports = 0;
  const restored = f.make(A, { oauth: { getAccessToken: async () => 'fixture-restored-token',
    login: async () => { browserLogins++; }, logout: async () => {}, close() {} },
    createTransport: async () => { transports++; throw Error('must_not_rejoin'); } });
  const firstRestore = restored.initialize(); assert.equal(restored.initialize(), firstRestore);
  const result = await firstRestore;
  assert.equal(result.account.id, A); assert.equal(result.busy, false);
  assert.equal(result.history[0].visitId, visitId); assert.equal(result.history[0].phase, 'ended');
  assert.equal(result.session, null); assert.equal(browserLogins, 0);
  assert.equal(transports, 0); assert.equal(f.generated.length, 0);
  await restored.action({ action: 'logout' });
  assert.equal((await restored.initialize()).account.signedIn, false);
});

test('logout during saved credential restoration fences late account activation', async t => {
  const f = fixture(t), gate = deferred(); let reads = 0, browserLogins = 0, signedOut = false;
  const a = f.make(A, { oauth: { getAccessToken: async () => { reads++; await gate.promise; return 'late-fixture-token'; },
    login: async () => { browserLogins++; }, logout: async () => { signedOut = true; }, close() {} } });
  const restoring = a.initialize(); const rejected = assert.rejects(restoring, /visit_cancelled/);
  await until(() => reads === 1);
  const leaving = a.action({ action: 'logout' }); gate.resolve();
  await rejected; await leaving;
  assert.equal(signedOut, true); assert.equal(browserLogins, 0);
  assert.equal(a.snapshot().account.signedIn, false); assert.equal(a.snapshot().busy, false);
  assert.deepEqual(a.snapshot().history, []); assert.deepEqual(f.presenceWrites, []);
  assert.equal((await a.initialize()).account.signedIn, false);
});

test('rejected saved credentials require explicit login and never open a browser at startup', async t => {
  const f = fixture(t); let browserLogins = 0, saved = true;
  const a = f.make(A, { oauth: { getAccessToken: async () => {
    if (saved) { saved = false; throw Object.assign(Error('fixture-expired'), { status: 401 }); }
    return null;
  }, login: async () => { browserLogins++; }, logout: async () => {}, close() {} } });
  await assert.rejects(a.initialize(), /login_required/);
  assert.equal(a.snapshot().account.signedIn, false); assert.equal(browserLogins, 0);
  assert.equal(a.snapshot().error, 'login_required');
  await a.action({ action: 'login' });
  assert.equal(browserLogins, 1); assert.equal(a.snapshot().account.signedIn, true);
  assert.equal(a.snapshot().error, null);
});

test('ordinary shutdown during saved-token restoration preserves credentials without activating an account', async t => {
  const f = fixture(t), gate = deferred(); let reading = false, logouts = 0, browserLogins = 0, closed = 0;
  const a = f.make(A, { oauth: { getAccessToken: async () => { reading = true; await gate.promise; return 'saved-token'; },
    login: async () => { browserLogins++; }, logout: async () => { logouts++; }, close() { closed++; } } });
  const restoring = a.initialize(), rejected = assert.rejects(restoring, /visit_cancelled/);
  await until(() => reading); const closing = a.close(); gate.resolve();
  await rejected; await closing;
  assert.equal(logouts, 0); assert.equal(browserLogins, 0); assert.equal(closed, 1);
  assert.equal(a.snapshot().account.signedIn, false);
  assert.deepEqual(f.presenceWrites, []);
});

test('panel stop rolls back a partially restored account and allows a fresh restoration', async t => {
  const f = fixture(t), gate = deferred(), service = f.social(A), presence = service.presence;
  let reading = false, block = true, storeCloses = 0;
  service.presence = async value => { if (block && value === undefined) { reading = true; await gate.promise; } return presence(value); };
  const a = f.make(A, { social: service, createStore: file => {
    const store = new VisitStore(file), close = store.close.bind(store);
    store.close = () => { storeCloses++; close(); }; return store;
  } });
  const restoring = a.initialize(), rejected = assert.rejects(restoring, /visit_cancelled/);
  await until(() => reading); assert.equal(a.snapshot().account.signedIn, true);
  const stopping = a.action({ action: 'stop' });
  await assert.rejects(a.action({ action: 'login' }), /visit_busy/);
  block = false; gate.resolve(); await rejected; await stopping;
  assert.equal(storeCloses, 1); assert.equal(a.snapshot().account.signedIn, false);
  assert.equal(a.snapshot().busy, false); assert.deepEqual(a.snapshot().history, []);
  const restored = await a.initialize(); assert.equal(restored.account.id, A); assert.equal(restored.busy, false);
  assert.equal(storeCloses, 1);
});

test('panel stop waits for a late online write and restores presence before another login', async t => {
  const f = fixture(t), gate = deferred(), service = f.social(A), presence = service.presence;
  let writing = false, block = true;
  service.presence = async value => { if (block && value === 'online') { writing = true; await gate.promise; } return presence(value); };
  const a = f.make(A, { social: service });
  const restoring = a.initialize(), rejected = assert.rejects(restoring, /visit_cancelled/);
  await until(() => writing); const stopping = a.action({ action: 'stop' });
  block = false; gate.resolve(); await rejected; await stopping;
  assert.equal(a.snapshot().account.signedIn, false);
  assert.deepEqual(f.presenceWrites.at(-1), [A, 'invisible']);
  await a.action({ action: 'login' }); assert.equal(a.snapshot().account.id, A);
});

test('ordinary shutdown cancels a pending browser login without leaving its callback alive', async t => {
  const f = fixture(t); let rejectLogin, logouts = 0, closed = 0;
  const a = f.make(A, { oauth: { getAccessToken: async () => null,
    login: () => new Promise((_, reject) => { rejectLogin = reject; }),
    logout: async () => { logouts++; rejectLogin?.(Object.assign(Error('login_cancelled'), { code: 'login_cancelled' })); },
    close() { closed++; } } });
  const loggingIn = a.action({ action: 'login' }), rejected = assert.rejects(loggingIn, /login_cancelled/);
  await until(() => !!rejectLogin); await a.close(); await rejected;
  assert.equal(logouts, 1); assert.equal(closed, 1); assert.equal(a.snapshot().account.signedIn, false);
});

test('unreadable token store fails silent restoration but explicit login clears it and starts PKCE', async t => {
  const f = fixture(t); let broken = true, browserLogins = 0, logouts = 0;
  const a = f.make(A, { oauth: { getAccessToken: async () => {
    if (broken) throw Object.assign(Error('token_store_unavailable'), { code: 'token_store_unavailable' }); return null;
  }, login: async () => { browserLogins++; }, logout: async () => { logouts++; broken = false; }, close() {} } });
  await assert.rejects(a.initialize(), /token_store_unavailable/);
  assert.equal(browserLogins, 0); assert.equal(logouts, 0); assert.equal(a.snapshot().account.signedIn, false);
  assert.equal(a.snapshot().error, 'token_store_unavailable');
  await a.action({ action: 'login' });
  assert.equal(logouts, 1); assert.equal(browserLogins, 1); assert.equal(a.snapshot().account.id, A);
});

test('server-rejected cached token requires explicit login and receives only one PKCE retry', async t => {
  const f = fixture(t), service = f.social(A), listFriends = service.listFriends;
  let stale = true, browserLogins = 0, logouts = 0;
  service.listFriends = async () => { if (stale) throw Object.assign(Error('service_request_failed'), { status: 401 }); return listFriends(); };
  const a = f.make(A, { social: service, oauth: { getAccessToken: async () => 'locally-unexpired-token',
    login: async () => { browserLogins++; stale = false; }, logout: async () => { logouts++; }, close() {} } });
  await assert.rejects(a.initialize(), /login_required/);
  assert.equal(browserLogins, 0); assert.equal(logouts, 0); assert.equal(a.snapshot().account.signedIn, false);
  await a.action({ action: 'login' });
  assert.equal(browserLogins, 1); assert.equal(logouts, 1); assert.equal(a.snapshot().account.id, A);
});

test('a fresh browser token rejected by the server does not trigger a login loop', async t => {
  const f = fixture(t), service = f.social(A); let browserLogins = 0, logouts = 0;
  service.listFriends = async () => { throw Object.assign(Error('service_request_failed'), { status: 401 }); };
  const a = f.make(A, { social: service, oauth: { getAccessToken: async () => null,
    login: async () => { browserLogins++; }, logout: async () => { logouts++; }, close() {} } });
  await assert.rejects(a.action({ action: 'login' }), /login_required/);
  assert.equal(browserLogins, 1); assert.equal(logouts, 0); assert.equal(a.snapshot().account.signedIn, false);
});

test('service outage preserves cached credentials and does not start unsolicited reauthentication', async t => {
  const f = fixture(t), service = f.social(A); let browserLogins = 0, logouts = 0;
  service.listFriends = async () => { throw Object.assign(Error('service_request_failed'), { status: 503 }); };
  const a = f.make(A, { social: service, oauth: { getAccessToken: async () => 'saved-token',
    login: async () => { browserLogins++; }, logout: async () => { logouts++; }, close() {} } });
  await assert.rejects(a.initialize(), /service_request_failed/);
  await assert.rejects(a.action({ action: 'login' }), /service_request_failed/);
  assert.equal(browserLogins, 0); assert.equal(logouts, 0); assert.equal(a.snapshot().account.signedIn, false);
});
