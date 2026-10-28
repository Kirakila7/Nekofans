'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createOAuthSession } = require('./oauth.cjs');
const { createSocialClient } = require('./social-client.cjs');
const { verifyIdentityTicket } = require('./identity.cjs');
const { VisitStore } = require('./store.cjs');
const { createVisitSession } = require('./session.cjs');
const { createVisitGenerator, publicPersona } = require('./generator.cjs');
const DONE = new Set(['ended', 'error', 'closed']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
function fail(code) { const e = new Error(code); e.code = code; return e; }

function createVisitsController({ dataDir, repositoryRoot, safeStorage, openExternal, createTransport,
  getModelConfig = () => null, getModelSecret = () => null, onChange = () => {}, config = {},
  oauth: injectedOAuth, social: injectedSocial, createStore = file => new VisitStore(file),
  sessionFactory = createVisitSession, generate: injectedGenerate, verifyTicket = verifyIdentityTicket,
  pollMs = 15000, drainMs = 6500 } = {}) {
  const directory = path.join(dataDir, 'visits');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, 'config.json');
  let saved;
  try { saved = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw fail('visit_config_invalid'); }
  const settings = { clientId: saved?.clientId || crypto.randomUUID(), charTag: saved?.charTag || crypto.randomBytes(16).toString('hex'),
    persona: publicPersona(saved?.persona || { name: '大肥鱼', description: '喜欢和朋友轻松聊天的猫娘。' }) };
  if (!UUID.test(settings.clientId) || !/^[0-9a-f]{32}$/.test(settings.charTag)) throw fail('visit_config_invalid');
  function save() { fs.writeFileSync(file + '.tmp', JSON.stringify(settings), { mode: 0o600 }); fs.renameSync(file + '.tmp', file); }
  if (!saved) save();
  let oauth = injectedOAuth, social = injectedSocial;
  const configured = !!injectedOAuth || ['authorizationUrl', 'tokenUrl', 'clientId', 'redirectUri'].every(k => typeof config[k] === 'string' && config[k]);
  if (!oauth && configured) oauth = createOAuthSession({ ...config, safeStorage, openExternal, tokenFile: path.join(directory, 'oauth.encrypted') });
  if (!social && oauth) social = createSocialClient({ baseUrl: config.baseUrl, getAccessToken: () => oauth.getAccessToken(), clientId: settings.clientId });
  const generate = injectedGenerate || createVisitGenerator({ repositoryRoot, getConfig: getModelConfig, getSecret: getModelSecret });
  let account = null, accountOwner = null, store = null, friends = [], invitations = [], sessionState = null, error = null;
  let current = null, operation = null, epoch = 0, closed = false, departing = false, polling = null, refreshFlight = null, refreshEpoch, closeFlight;
  let presenceOwned = false, presencePrevious = null;
  let initialized = false, initialization = null;
  const draining = new Set();
  const snapshot = () => structuredClone({ account: { signedIn: !!account, id: account?.id, displayName: account?.name },
    configured, persona: settings.persona, friends, invitations, session: sessionState, error,
    busy: !!operation || departing, history: store && !departing ? store.listVisits().map(v => ({ ...v, startedAt: v.createdAt })) : [] });
  function publish() { if (!closed) { try { onChange(snapshot()); } catch {} } }
  function assertLive(e) { if (closed || e !== epoch) throw fail('visit_cancelled'); }
  function requireAccount() { if (!account || !social || departing) throw fail('login_required'); }
  function active() { return !!operation || !!current || !!sessionState && !DONE.has(sessionState.phase); }
  function setError(e) { error = /^[a-z_]{1,80}$/.test(e?.code || e?.message) ? (e.code || e.message) : 'visit_operation_failed'; publish(); }
  async function modelReady() {
    const model = await getModelConfig(), key = await getModelSecret();
    if (!model || !['openai-compatible', 'anthropic'].includes(model.protocol) || !model.baseUrl || !model.model || typeof key !== 'string' || !key.trim()) throw fail('chat_model_not_ready');
  }
  function retire(record, immediate = false) {
    if (!record || record.retired) return;
    record.retired = true; draining.add(record);
    record.drained = new Promise(resolve => { record.resolveDrain = resolve; });
    const cleanup = () => {
      if (record.cleaned) return record.drained;
      record.cleaned = true; clearTimeout(record.timer);
      // Existing Connect has no participant /end endpoint. Leaving RTC lets its
      // vendor observation/lifecycle reclaim the room; local completion is not
      // evidence that the cloud room or billing state has already been closed.
      try { record.session?.close(); if (!record.session) record.transport?.close(); }
      catch { if (!closed) { error = 'transport_cleanup_failed'; publish(); } }
      finally { draining.delete(record); record.resolveDrain(); }
    };
    record.cleanup = cleanup;
    if (immediate) void cleanup(); else { record.timer = setTimeout(() => { void cleanup(); }, drainMs); }
  }
  async function rollback(record) {
    if (!record?.visitId || !record.granted || record.cancelled || !social) return;
    if (record.role !== 'host' || record.session?.snapshot().peer) { if (!record.retired) retire(record, !record.session); return; }
    record.cancelled = true;
    try { await social.cancelRoom(record.visitId); } catch { record.cancelled = false; if (!closed) { error = 'room_cleanup_failed'; publish(); } }
  }
  async function stop(reason = 'stopped') {
    ++epoch;
    const pending = operation;
    // A cancelled login still owns its partially opened account/store until its
    // in-flight read or presence write settles. Do not allow a new login to race
    // that cleanup, or abandon it merely because the epoch has changed.
    if (pending?.kind !== 'login') operation = null;
    pending?.abort.abort();
    const record = current || pending?.record;
    current = null;
    if (record?.session) { record.session.stop(reason); sessionState = record.session.snapshot(); retire(record); }
    else if (record) { record.transport?.close(); sessionState = { visitId: record.visitId, phase: 'ended', reason, messages: [] }; }
    else if (sessionState && !DONE.has(sessionState.phase)) sessionState = { ...sessionState, phase: 'ended', reason };
    publish();
    if (pending?.browserLoginPending) await oauth?.logout();
    if (record) await rollback(record);
    if (pending?.kind === 'login') await pending.done;
    return snapshot();
  }
  async function restorePresence() {
    if (!presenceOwned || !social) return;
    presenceOwned = false;
    // Only undo a status this controller changed. Never force an already-online
    // account offline, because another official client may own its presence.
    try { const now = await social.presence(); if ((now?.presence_status || now?.status) === 'online') await social.presence(presencePrevious || 'invisible'); } catch {}
  }
  async function refresh(e = epoch) {
    requireAccount();
    if (refreshFlight) {
      if (refreshEpoch === e) return refreshFlight;
      await refreshFlight.catch(() => {}); assertLive(e); return refresh(e);
    }
    const task = (async () => {
      const [list, notices, online] = await Promise.all([social.listFriends(), social.notifications(), social.presence()]); assertLive(e);
      if ((online?.status || online?.presence_status) === 'online') { await social.presence('online'); assertLive(e); }
      if (list.userId !== account.id) throw fail('account_changed');
      friends = list.items.filter(f => f.is_mutual === true && !f.blocked_by_viewer && !f.blocks_viewer).map(f => ({
        id: f.id, displayName: String(f.display_name || f.username || '好友').slice(0, 100), online: f.online === true,
        // Presence permits an invitation; it does not prove a remote model is ready.
        available: f.online === true }));
      invitations = (notices.items || []).flatMap(n => {
        const p = n.payload;
        if (p?.type !== 'visit_invite' || p.response || !UUID.test(n.id || '') || !/^[A-Za-z0-9_-]{22}$/.test(p.visit_id || '')
          || !friends.some(f => f.id === p.actor_id) || (p.expires_at && p.expires_at * 1000 <= Date.now())) return [];
        return [{ notificationId: n.id, visitId: p.visit_id, userId: p.actor_id,
          displayName: String(p.actor_display_name || '好友').slice(0, 100), expiresAt: p.expires_at ? new Date(p.expires_at * 1000).toISOString() : null }];
      });
      const refused = (notices.items || []).some(n => n.payload?.type === 'visit_invite_response' && n.payload.accepted === false
        && n.payload.visit_id === current?.visitId && n.payload.actor_id === current?.targetUserId);
      if (refused) await stop('declined');
      error = null; publish(); return snapshot();
    })();
    refreshFlight = task; refreshEpoch = e;
    try { return await task; } finally { if (refreshFlight === task) refreshFlight = null; }
  }
  async function login(restoreOnly = false) {
    if (!configured || !oauth || !social) throw fail('config_not_ready');
    if (operation || account || departing) throw fail('visit_busy');
    initialized = true;
    const token = { abort: new AbortController(), kind: 'login', browserLoginPending: false }, e = ++epoch; token.done = new Promise(r => { token.finish = r; }); operation = token; error = null; publish();
    async function interactiveLogin() {
      assertLive(e); token.browserLoginPending = true;
      try { await oauth.login(); assertLive(e); }
      finally { token.browserLoginPending = false; }
    }
    try {
      let accessToken;
      try { accessToken = await oauth.getAccessToken?.(); }
      catch (err) {
        assertLive(e);
        // The OAuth layer clears rejected refresh credentials. Only an explicit
        // login may then open a browser; startup must remain non-interactive.
        const brokenStore = err.code === 'token_store_unavailable';
        if (!brokenStore && err.status !== 400 && err.status !== 401) throw err;
        if (restoreOnly) throw brokenStore ? err : fail('login_required');
        await oauth.logout(); assertLive(e);
      }
      assertLive(e);
      if (!accessToken) {
        if (restoreOnly) return snapshot();
        await interactiveLogin();
      }
      let list;
      try { list = await social.listFriends(); assertLive(e); }
      catch (err) {
        assertLive(e);
        if (err.status !== 401) throw err;
        // A locally unexpired access token can already be revoked server-side.
        // Retry once, and only through an explicitly requested browser login.
        if (restoreOnly || !accessToken) throw fail('login_required');
        await oauth.logout(); assertLive(e); await interactiveLogin();
        list = await social.listFriends(); assertLive(e);
      }
      if (!UUID.test(list.userId || '')) throw fail('invalid_account');
      account = { id: list.userId, name: '已登录社区' }; accountOwner = token;
      store = createStore(path.join(directory, 'accounts', list.userId, 'visits.sqlite'));
      const presence = await social.presence(); assertLive(e);
      presencePrevious = presence?.presence_status || presence?.status;
      if (presencePrevious === 'invisible' || presencePrevious === 'away') {
        // Mark before the request so cancellation can undo a late successful write.
        presenceOwned = true; await social.presence('online'); assertLive(e);
      }
      await refresh(e); assertLive(e);
      polling = setInterval(() => { if (account && !closed && !departing) void refresh().catch(err => { if (err?.code !== 'visit_cancelled') setError(err); }); }, pollMs); polling.unref?.();
    } catch (e2) {
      if (e === epoch || accountOwner === token) {
        await restorePresence(); store?.close(); store = null; account = null; accountOwner = null; friends = []; invitations = [];
      }
      if (e !== epoch && !departing && !closed) initialized = false;
      throw e2;
    }
    finally { token.finish(); if (operation === token) operation = null; publish(); }
    return snapshot();
  }
  function initialize() {
    if (initialization) return initialization;
    if (closed || initialized || !configured || departing) return Promise.resolve(snapshot());
    initialization = login(true).catch(err => {
      if (err.code !== 'visit_cancelled') setError(err);
      throw err;
    }).then(() => snapshot()).finally(() => { initialization = null; });
    return initialization;
  }
  async function establish(kind, input) {
    requireAccount(); if (active()) throw fail('visit_busy');
    const token = { abort: new AbortController(), record: null }, e = ++epoch; token.done = new Promise(r => { token.finish = r; }); operation = token; error = null; publish();
    let record;
    try {
      await modelReady(); assertLive(e); await refresh(e); assertLive(e);
      let target, visitId;
      if (kind === 'invite') {
        target = friends.find(f => f.id === input.userId && f.available); if (!target) throw fail('friend_not_available');
        visitId = crypto.randomBytes(16).toString('base64url');
      } else {
        target = invitations.find(n => n.notificationId === input.notificationId); if (!target) throw fail('invitation_not_available');
        visitId = target.visitId;
      }
      record = { visitId, targetUserId: kind === 'invite' ? target.id : target.userId, role: kind === 'invite' ? 'host' : 'guest' };
      token.record = record;
      sessionState = { visitId, phase: 'connecting', messages: [], startedAt: new Date().toISOString() }; publish();
      const args = { visitId, charTag: settings.charTag, displayName: settings.persona.name.slice(0, 64), targetUserId: record.targetUserId };
      const grant = await (kind === 'invite' ? social.createRoom(args) : social.joinRoom(args)); record.granted = true; assertLive(e);
      const pubkeys = await social.pubkeys(); assertLive(e);
      if (grant.visit_id !== visitId || grant.role !== record.role) throw fail('invalid_visit_grant');
      verifyTicket(grant.identity_ticket, { pubkeys, visitId, role: record.role, vid: grant.vid, transport: grant.transport });
      record.transport = await createTransport(grant, token.abort.signal); assertLive(e);
      if (record.transport.ready) { await record.transport.ready; assertLive(e); }
      const initialTime = sessionState.startedAt;
      record.session = sessionFactory({ grant, persona: settings.persona, store, transport: record.transport, generate,
        handshakeTimeoutMs: kind === 'invite' ? Math.max(20000, Math.min(600000, ((grant.direct_invite_expires_at || (Date.now() / 1000 + 600)) * 1000 - Date.now()))) : 30000,
        verifyPeer: ({ ticket, senderVid, role }) => verifyTicket(ticket, { pubkeys, visitId, role, vid: senderVid, transport: grant.transport }),
        onChange: value => {
          if (current !== record) return;
          sessionState = { ...value, startedAt: initialTime };
          if (DONE.has(value.phase)) { current = null; retire(record); }
          publish();
        } });
      current = record;
      record.session.start(); assertLive(e);
      if (kind === 'invite') await social.inviteNotification(target.id, visitId, grant.direct_invite_expires_at || Date.now() / 1000 + 600);
      else await social.respondInvite(input.notificationId, true);
      assertLive(e);
      if (kind !== 'invite') invitations = invitations.filter(n => n.notificationId !== input.notificationId);
    } catch (e2) {
      if (record) { record.session?.stop(); if (!record.session) record.transport?.close(); await rollback(record); retire(record, !record.session); }
      if (current === record) current = null;
      if (e === epoch) sessionState = { visitId: record?.visitId, phase: 'error', reason: 'setup_failed', messages: [] };
      throw e2;
    } finally { token.finish(); if (operation === token) operation = null; publish(); }
    return snapshot();
  }
  async function logout() {
    if (departing) throw fail('visit_busy'); departing = true;
    initialized = true;
    clearInterval(polling); polling = null;
    // Cancel OAuth immediately; its callback must not revive a logged-out account.
    const pending = operation;
    const signout = pending && !account ? oauth?.logout() : null;
    await stop('owner_left'); await pending?.done; await refreshFlight?.catch(() => {});
    await Promise.all([...draining].map(r => r.drained)); await restorePresence();
    if (signout) await signout; else await oauth?.logout();
    store?.close(); store = null; account = null; accountOwner = null; friends = []; invitations = []; sessionState = null; error = null; departing = false; publish(); return snapshot();
  }
  async function action(input = {}) {
    if (closed) throw fail('visits_closed');
    try {
      if (input.action === 'getState') return snapshot();
      if (input.action === 'login') return await login();
      if (input.action === 'logout') return await logout();
      if (input.action === 'stop') return await stop();
      if (input.action === 'refresh') return await refresh();
      if (input.action === 'savePersona') {
        if (active()) throw fail('visit_busy'); settings.persona = publicPersona(input); save(); publish(); return snapshot();
      }
      if (input.action === 'invite' || input.action === 'accept') return await establish(input.action, input);
      if (input.action === 'decline') {
        requireAccount(); if (!invitations.some(n => n.notificationId === input.notificationId)) throw fail('invitation_not_available');
        const e = epoch; await social.respondInvite(input.notificationId, false); assertLive(e);
        invitations = invitations.filter(n => n.notificationId !== input.notificationId); publish(); return snapshot();
      }
      if (input.action === 'history') { requireAccount(); const value = store.getVisit(input.visitId); if (!value) throw fail('history_not_found'); return { history: { ...value, startedAt: value.createdAt } }; }
      throw fail('unknown_visit_action');
    } catch (e) { if (e?.code !== 'visit_cancelled') setError(e); throw e; }
  }
  function close() {
    if (closeFlight) return closeFlight;
    closeFlight = (async () => {
      if (closed) return;
      departing = true; clearInterval(polling); const pending = operation;
      await stop('shutdown'); await pending?.done; await refreshFlight?.catch(() => {});
      await Promise.all([...draining].map(r => r.drained)); await restorePresence();
      closed = true; await oauth?.close(); store?.close(); store = null;
    })();
    return closeFlight;
  }
  return { action, snapshot, initialize, close };
}
module.exports = { createVisitsController };
