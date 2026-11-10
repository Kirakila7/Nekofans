'use strict';
// Main-process lobby controller (N.E.K.O.Chat). Composes lobby-config,
// lobby-auth, lobby-client, lobby-avatars, lobby-cat and lobby-experience
// behind one request(value) entry point and one projected snapshot.
// The snapshot never carries tokens, raw server responses, recalled memories
// or provider output other than the suggestion card text. Every failure is
// contained here: request() resolves with {ok:false, error} instead of
// throwing, so the private companion chat is never affected.
// Message text is never logged.
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { writeAtomicStateFileSync } = require('./atomic-state-file.cjs');
const { resolveChatConfig } = require('./lobby-config.cjs');
const { createLobbyAuth, SAFE_ERROR: AUTH_ERRORS } = require('./lobby-auth.cjs');
const { createLobbyClient, SAFE_ERROR: CLIENT_ERRORS, WS_LIMITS } = require('./lobby-client.cjs');
const { createLobbyAvatars, hueAvatar, isSnapshotAvatar } = require('./lobby-avatars.cjs');
const { createLobbyCat, ERRORS: CAT_ERRORS, LIMITS: CAT_LIMITS } = require('./lobby-cat.cjs');
const { createLobbyExperience } = require('./lobby-experience.cjs');
const { resolveCommunityUrl } = require('./community-config.cjs');

const MODES = Object.freeze(['off', 'assist', 'independent']);
const TRIGGERS = Object.freeze(['mention', 'owner_or_mention', 'free']);
const SLOW_MODES = Object.freeze([0, 5, 10, 30, 60]);
const MUTE_MINUTES = Object.freeze([10, 60, 1440, 10080]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NAME = /^[^\p{Cc}\p{Cf}\p{Zl}\p{Zp}]{1,32}$/u;
const AVATAR_KEY = /^[A-Za-z0-9_-]{1,64}$/;   // same as lobby-frames / PUT /me/cat
const DEFAULT_PERSONA_ID = 'bigfish';
const DEFAULT_CAT_NAME = '大肥鱼';

const ERR = Object.freeze({
  request: '大厅请求无效',
  action: '未知大厅操作',
  disposed: '大厅已关闭',
  init: '大厅初始化失败，私聊不受影响',
  unconfigured: '频道服务未配置。',
  config: '频道服务配置无效，请检查环境变量。',
  login: '请先登录频道。',
  closed: '请先打开大厅',
  loading: '大厅还在加载，请稍后再试',
  admin: '只有管理员可以执行此操作',
  cat: '请先在猫猫设置里保存她',
  assist: '共同回复只能使用你自己的猫娘',
  storage: '猫猫设置保存失败',
  failed: '大厅操作失败，请稍后重试',
  catSync: '猫娘设置尚未同步，请重试保存',
  accountChanged:'频道账号已变化，请重新保存设置',
});
const REASON = Object.freeze({
  provider: '请先连接主 agent 的聊天线路',
  accountLogin: '请先登录 DeepSeek 工作台账号',
  accountUnavailable: 'DeepSeek 工作台账号状态暂不可用，请检查工作台连接',
  cat: '先在猫猫设置里保存她',
  catsDisabled: '频道暂未开放猫娘参与',
  adminDisabled: '猫娘已被管理员停用',
  muted: '你正在禁言中',
  banned: '你已被频道封禁',
  offline: '大厅未连接',
});
const SAFE_TEXT = new Set([...Object.values(ERR), ...Object.values(AUTH_ERRORS), ...Object.values(CLIENT_ERRORS),
  ...Object.values(CAT_ERRORS)]);

const requestError = message => Object.assign(new Error(message), { code: 'lobby_request' });
const failure = key => Object.assign(new Error(ERR[key] || ERR.failed), { code: 'lobby_' + key });
// Only fixed module text reaches the renderer; anything else becomes generic text.
const safeText = error => (error instanceof Error && SAFE_TEXT.has(error.message) ? error.message : ERR.failed);

// ---- request validation (same style as validateCommunityRequest: exact key sets) ----
const chars = value => Array.from(value).length;
const isUuid = value => typeof value === 'string' && UUID.test(value);
const optional = check => value => value === undefined || value === null || check(value);
const text = (min, max) => value => typeof value === 'string' && chars(value) >= min && chars(value) <= max
  && (min === 0 || value.trim().length > 0);
const oneOf = list => value => list.includes(value);
const int = (min, max) => value => Number.isSafeInteger(value) && value >= min && value <= max;
const name = value => typeof value === 'string' && value.trim().length > 0 && NAME.test(value);
const bool = value => typeof value === 'boolean';

// field: [required, check, message]
const SPEC = Object.freeze({
  state: {}, 'sign-in': {}, 'sign-in-cancel': {}, 'sign-out': {}, open: {}, close: {},
  send: {
    text: [true, text(1, 2000), '大厅消息 1–2000 字'],
    replyToId: [false, optional(isUuid), '回复目标 ID 无效'],
    origin: [true, oneOf(['human', 'human_ai']), '来源无效'],
    assistCatId: [false, optional(isUuid), '共同回复需要猫娘 ID'],
  },
  'send-retry': { clientMessageId: [true, isUuid, '消息 ID 无效'] },
  'send-discard': { clientMessageId: [true, isUuid, '消息 ID 无效'] },
  'load-older': {},
  'mode-set': {
    mode: [true, oneOf(MODES), '参与方式无效'],
    trigger: [false, oneOf(TRIGGERS), '触发方式无效'],
  },
  suggest: {
    targetMessageId: [false, optional(isUuid), '回复目标 ID 无效'],
    instruction: [false, text(0, 500), '给她的要求最多 500 字'],
    draftEpoch: [false, int(0, Number.MAX_SAFE_INTEGER), '草稿编号无效'],
  },
  'suggest-cancel': {}, 'suggest-discard': {},
  'cat-save': {
    name: [false, optional(name), '猫娘名字 1–32 字'],
    mode: [false, oneOf(MODES), '参与方式无效'],
    independentTrigger: [false, oneOf(TRIGGERS), '触发方式无效'],
    avatarKey: [false, value => typeof value === 'string' && AVATAR_KEY.test(value), '猫娘头像无效'],
    note: [false, optional(text(0, 500)), '频道补充说明最多 500 字'],
    dailyLimit: [false, int(0, 1000), '每日上限无效'],
  },
  'admin-channel': {
    name: [false, name, '频道名字 1–32 字'],
    topic: [false, text(0, 500), '频道话题最多 500 字'],
    slowModeSeconds: [false, oneOf(SLOW_MODES), '慢速模式无效'],
    catsEnabled: [false, bool, '猫娘开关无效'],
    catFreeAllowed: [false, bool, '自由模式开关无效'],
  },
  'admin-delete': { messageId: [true, isUuid, '消息 ID 无效'] },
  'admin-mute': {
    userId: [true, isUuid, '成员 ID 无效'],
    minutes: [true, oneOf(MUTE_MINUTES), '禁言时长无效'],
    reason: [false, optional(text(0, 500)), '原因最多 500 字'],
  },
  'admin-unmute': { userId: [true, isUuid, '成员 ID 无效'] },
  'admin-ban': { userId: [true, isUuid, '成员 ID 无效'], reason: [false, optional(text(0, 500)), '原因最多 500 字'] },
  'admin-unban': { userId: [true, isUuid, '成员 ID 无效'] },
  'admin-cat': { catId: [true, isUuid, '猫娘 ID 无效'], disable: [true, bool, '禁用猫娘参数无效'] },
});
const ACTIONS = Object.freeze(Object.keys(SPEC));

/** Strict request check: plain object, known action, exact key set, typed values. Returns a clean copy. */
function validateLobbyRequest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw requestError(ERR.request);
  if (typeof value.action !== 'string' || !Object.hasOwn(SPEC, value.action)) throw requestError(ERR.action);
  const spec = SPEC[value.action];
  const out = { action: value.action };
  for (const key of Object.keys(value)) {
    if (key !== 'action' && !Object.hasOwn(spec, key)) throw requestError(ERR.request);
  }
  for (const [key, [required, check, message]] of Object.entries(spec)) {
    const present = Object.hasOwn(value, key) && value[key] !== undefined;
    if (!present) { if (required) throw requestError(message); continue; }
    if (!check(value[key])) throw requestError(message);
    out[key] = typeof value[key] === 'string' && UUID.test(value[key]) ? value[key].toLowerCase() : value[key];
  }
  if (out.action === 'send') {
    if (out.origin === 'human_ai' && !out.assistCatId) throw requestError('共同回复需要猫娘 ID');
    if (out.origin === 'human' && out.assistCatId) throw requestError('普通消息不能带猫娘 ID');
  }
  if (out.action === 'admin-channel' && Object.keys(out).length === 1) throw requestError('没有要修改的设置');
  return out;
}

// ---- data/lobby/cat.json (0600, atomic) ----
function defaultSettings() {
  return { version: 1, personaId: DEFAULT_PERSONA_ID, serverCatId: null, name: null, avatarKey: 'default', mode: 'assist',
    independentTrigger: 'mention', note: '', dailyLimit: CAT_LIMITS.dailyLimit, usage: { day: '', count: 0 } };
}
function readSettings(file) {
  const base = defaultSettings();
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > 64 * 1024) return base;
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!value || typeof value !== 'object' || value.version !== 1) return base;
    if (typeof value.personaId === 'string' && value.personaId.length <= 128) base.personaId = value.personaId;
    if (isUuid(value.serverCatId)) base.serverCatId = value.serverCatId.toLowerCase();
    if (name(value.name)) base.name = value.name;
    if (typeof value.avatarKey === 'string' && AVATAR_KEY.test(value.avatarKey)) base.avatarKey = value.avatarKey;
    if (MODES.includes(value.mode)) base.mode = value.mode;
    if (TRIGGERS.includes(value.independentTrigger)) base.independentTrigger = value.independentTrigger;
    if (typeof value.note === 'string' && chars(value.note) <= 500) base.note = value.note;
    if (int(0, 1000)(value.dailyLimit)) base.dailyLimit = value.dailyLimit;
    if (value.usage && typeof value.usage.day === 'string' && value.usage.day.length <= 16 && int(0, 1e6)(value.usage.count)) {
      base.usage = { day: value.usage.day, count: value.usage.count };
    }
  } catch { /* missing or unreadable: defaults */ }
  return base;
}
function writeSettings(file, settings) {
  fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});
  writeAtomicStateFileSync(file,JSON.stringify(settings,null,2));
  try { fs.chmodSync(file, 0o600); } catch { /* The exclusive temporary file already used 0600. */ }
}

// ---- snapshot projection ----
function projectAvatar(avatars, avatar, seed, label) {
  let value = null;
  try { value = avatars ? avatars.get(avatar, { seed, name: label }) : null; } catch { value = null; }
  if (!isSnapshotAvatar(value)) value = avatar?.kind === 'hue' && isSnapshotAvatar(avatar) ? avatar : hueAvatar(seed || 'neko', label || '');
  return { ...value };
}
function projectAuthor(avatars, author) {
  if (!author) return null;
  if (author.kind === 'cat') {
    return { kind: 'cat', cat_id: author.cat_id, owner_user_id: author.owner_user_id, owner_name: author.owner_name,
      name: author.name, display_name: author.display_name, avatar_key: author.avatar_key };
  }
  const out = { kind: 'human', user_id: author.user_id, name: author.name, display_name: author.display_name,
    avatar: projectAvatar(avatars, author.avatar, author.user_id, author.display_name || author.name) };
  if (author.assist_cat) out.assist_cat = { cat_id: author.assist_cat.cat_id, name: author.assist_cat.name };
  return out;
}
function projectMessage(avatars, m) {
  return { id: m.id, seq: m.seq, channel_id: m.channel_id, created_at: m.created_at, deleted: !!m.deleted,
    text: m.deleted ? null : m.text, origin: m.origin, label: m.label, author: projectAuthor(avatars, m.author),
    mentions: Array.isArray(m.mentions) ? m.mentions.map(x => ({ kind: x.kind, id: x.id })) : [],
    reply_to: m.reply_to ? { id: m.reply_to.id, seq: m.reply_to.seq, origin: m.reply_to.origin, label: m.reply_to.label } : null,
    cat_depth: m.cat_depth };
}
function projectMember(avatars, m) {
  if (m.kind === 'cat') {
    return { kind: 'cat', cat_id: m.cat_id, owner_user_id: m.owner_user_id, owner_name: m.owner_name, name: m.name,
      display_name: m.display_name, avatar_key: m.avatar_key, enabled: !!m.enabled, admin_disabled: !!m.admin_disabled, online: !!m.online };
  }
  return { kind: 'human', user_id: m.user_id, name: m.name, display_name: m.display_name,
    avatar: projectAvatar(avatars, m.avatar, m.user_id, m.display_name || m.name),
    role: m.role, muted_until: m.muted_until ?? null, banned_at: m.banned_at ?? null, online: !!m.online };
}
function projectChannel(c) {
  return c ? { id: c.id, name: c.name, topic: c.topic, slow_mode_seconds: c.slow_mode_seconds, cats_enabled: c.cats_enabled,
    cat_free_mode_allowed: c.cat_free_mode_allowed } : null;
}
function projectServerCat(c) {
  return c ? { id: c.id, name: c.name, display_name: c.display_name, avatar_key: c.avatar_key, reply_mode: c.reply_mode,
    enabled: !!c.enabled, admin_disabled: !!c.admin_disabled } : null;
}

const safeCall = (fn, fallback = null) => { try { return fn(); } catch { return fallback; } };
const settingsView = s => ({ personaId: s.personaId, serverCatId: s.serverCatId, name: s.name, avatarKey: s.avatarKey,
  mode: s.mode, independentTrigger: s.independentTrigger, note: s.note, dailyLimit: s.dailyLimit });
const DEFAULT_FACTORIES = Object.freeze({ auth: createLobbyAuth, client: createLobbyClient, avatars: createLobbyAvatars,
  cat: createLobbyCat, experience: createLobbyExperience });


const CLIENT_CONNECTION = Object.freeze({ online: 'online', connecting: 'connecting', reconnecting: 'connecting', loading: 'connecting' });
const blankCat = () => ({ mode: 'off', independentTrigger: 'mention', available: false, status: 'idle', error: '', modeEpoch: 0,
  suggestion: null, nudge: null, usage: { today: 0, limit: CAT_LIMITS.dailyLimit } });

function fallbackSnapshot(error) {
  return { connection: 'unconfigured', auth: { status: 'unconfigured', message: ERR.unconfigured, error: '', signingIn: false },
    participation: { mode: 'off', providerAvailable: false, available: false, reason: REASON.offline }, loading: false,
    me: null, channel: null, messages: [], hasMore: false, members: [], outbox: [], catSettings: settingsView(defaultSettings()),
    cat: blankCat(), suggestion: null, nudge: null, error };
}

/**
 * createLobbyController(deps). Never throws; every lobby failure stays inside.
 *  env                  process.env-like (NEKO_WORKBENCH_CHAT_*, NEKO_WORKBENCH_COMMUNITY_URL)
 *  config               optional resolveChatConfig() result (overrides env)
 *  dataDir              data/lobby (cat.json, pending-experience.json); null keeps settings in memory
 *  secretStore          WorkbenchSecretStore for the refresh token (lobby-auth)
 *  openExternal(url)    system browser
 *  getChatProvider()    isolated public ChatProvider | null for the selected companion route
 *  getChatProviderState() safe backend/revision/readiness codes, no credentials or history
 *  getPersona()         {name, prompt} of the workbench role named by cat.json personaId
 *  recallMemory(q,b,s)  assist only; the result never enters the snapshot
 *  recordSharedExperience(entry)  hub write-back used by lobby-experience
 *  onState(snapshot)    coalesced publication (one per microtask burst)
 *  fetchImpl, WebSocketImpl, timers, now, random, newId, randomBytes, factories (tests)
 * Returns { request(value) -> Promise<{ok, error?, state}>, snapshot(), refresh(), processPending(), dispose() }.
 */
function createLobbyController(deps = {}) {
  try { return buildController(deps || {}); } catch {
    return Object.freeze({ request: async () => ({ ok: false, error: ERR.init, state: fallbackSnapshot(ERR.init) }),
      snapshot: () => fallbackSnapshot(ERR.init), refresh: () => {}, processPending: () => {}, dispose: () => {} });
  }
}

function buildController(deps) {
  const env = deps.env || process.env;
  const timers = deps.timers || globalThis, now = deps.now || Date.now, random = deps.random || Math.random;
  const newId = deps.newId || randomUUID;
  const make = { ...DEFAULT_FACTORIES, ...(deps.factories || {}) };
  const onState = typeof deps.onState === 'function' ? deps.onState : () => {};
  const catFile = deps.dataDir ? path.join(deps.dataDir, 'cat.json') : null;
  const pendingFile = deps.dataDir ? path.join(deps.dataDir, 'pending-experience.json') : null;

  let disposed = false, scheduled = false, wantOpen = false, lastAvailable = false;
  let signingIn = false, me = null, meLoading = null, lastError = '', initError = '';
  let catSetupError='',autoCatAttempted=false,settingsTail=Promise.resolve();
  // /me 的 is_admin = 环境管理员 或 role=admin，且未封禁；记住环境管理员这一半，member.updated 时按同样规则重算。
  let meEnvAdmin = false;
  let auth = null, client = null, avatars = null, cat = null, experience = null;
  const settings = catFile ? readSettings(catFile) : defaultSettings();

  let config = { configured: false }, configError = '';
  try { config = deps.config || resolveChatConfig(env); } catch { config = { configured: false }; configError = ERR.config; }
  const configured = config?.configured === true;

  const saveSettings = () => {
    if (!catFile) return true;
    try { writeSettings(catFile, settings); return true; } catch { return false; }
  };
  const persona = () => {
    const value = safeCall(() => deps.getPersona?.(settings.personaId), null);
    return { name: typeof value?.name === 'string' && value.name.trim() ? value.name : DEFAULT_CAT_NAME,
      prompt: typeof value?.prompt === 'string' ? value.prompt : '' };
  };
  const provider = () => (disposed ? null : safeCall(() => deps.getChatProvider?.() || null, null));
  const providerState = () => safeCall(() => deps.getChatProviderState?.() || null, null);
  const providerReason = () => ({'account-signed-out':REASON.accountLogin,'account-unavailable':REASON.accountUnavailable})[providerState()?.reason] || REASON.provider;
  const providerKey = () => { const state=providerState(); return state ? `${state.backend}:${state.revision}` : ''; };
  const serverCat = () => (me?.cat && !me.cat.deleted ? me.cat : null);
  const catName = () => settings.name || serverCat()?.name || persona().name;
  const clientSnap = () => (client ? safeCall(() => client.snapshot(), null) : null);
  const authState = () => (auth ? safeCall(() => auth.state, null) : null);
  const authStatus = () => authState()?.status || 'unconfigured';
  const guard = fn => (...args) => { try { return fn(...args); } catch { return undefined; } };
  const quiet = fn => { try { fn(); } catch { /* contained */ } };

  // ---- composition: each piece is optional; a failure leaves it null and is reported as init ----
  if (configured) {
    try {
      auth = make.auth({ config, secretStore: deps.secretStore, openExternal: deps.openExternal, fetchImpl: deps.fetchImpl,
        randomBytes: deps.randomBytes, now, onState: guard(() => onAuthState()) });
    } catch { auth = null; initError = ERR.init; }
  }
  if (auth) {
    try {
      client = make.client({ config, auth, fetchImpl: deps.fetchImpl, WebSocketImpl: deps.WebSocketImpl, timers, now, random, newId,
        onChange: guard(() => { reconcile(); schedulePublish(); }), onEvent: guard((type, payload) => onClientEvent(type, payload || {})) });
    } catch { client = null; initError = ERR.init; }
    try {
      let communityUrl;
      try { communityUrl = resolveCommunityUrl(env.NEKO_WORKBENCH_COMMUNITY_URL); } catch { communityUrl = undefined; }
      avatars = make.avatars({ communityUrl, fetchImpl: deps.fetchImpl || globalThis.fetch, now, onChange: guard(() => schedulePublish()) });
    } catch { avatars = null; }
  }
  if (client) {
    try {
      cat = make.cat({
        mode: settings.mode, trigger: settings.independentTrigger, getProvider: provider, getPersona: persona,
        getLobby: () => lobbyContext(), catSend: frame => client.sendCat(frame),
        recallMemory: typeof deps.recallMemory === 'function' ? (q, b, s) => deps.recallMemory(q, b, s) : null,
        random, now, newId, timers, onChange: guard(() => schedulePublish()),
        get dailyLimit() { return settings.dailyLimit; },
        usage: { read: () => settings.usage,
          write: next => { settings.usage = { day: String(next.day), count: Number(next.count) || 0 }; saveSettings(); } },
      });
    } catch { cat = null; initError = ERR.init; }
  }
  if (client && pendingFile) {
    try {
      experience = make.experience({ file: pendingFile, getProvider: provider, now, newId, timers,
        onError:()=>{lastError='大厅待处理记忆无法保存';schedulePublish();},
        getMemory: () => (provider() && typeof deps.recordSharedExperience === 'function'
          ? { recordSharedExperience: entry => deps.recordSharedExperience(entry) } : null) });
    } catch { experience = null; }
  }
  const processPending = () => { if (experience) Promise.resolve().then(() => experience?.processPending()).catch(() => {}); };
  processPending();   // pending segments use the selected companion route when available

  // ---- derived state ----
  const healthy = () => configured && !configError && !!auth && !!client;
  function connection() {
    if (!healthy()) return 'unconfigured';
    if (authStatus() !== 'signed-in') return 'signed-out';
    const status = clientSnap()?.status;
    return CLIENT_CONNECTION[status] || 'offline';
  }
  const online = () => connection() === 'online';
  const effectiveMode = () => (provider() ? settings.mode : 'off');
  /** Lobby AI participation; separate from private-chat availability, which it never touches. */
  function participation() {
    if (!provider()) return { mode: 'off', providerAvailable:false, available: false, reason: providerReason() };
    const mode = settings.mode;
    const unavailable=reason=>({mode,providerAvailable:true,available:false,reason});
    const chan = clientSnap()?.channel;
    if (!online() || !me || !chan) return unavailable(REASON.offline);
    if (me.banned_at) return unavailable(REASON.banned);
    if (Number.isFinite(me.muted_until) && me.muted_until > now()) return unavailable(REASON.muted);
    const own = serverCat();
    if (!own) return unavailable(catSetupError||REASON.cat);
    if (chan.cats_enabled === false) return unavailable(REASON.catsDisabled);
    if (own.admin_disabled) return unavailable(REASON.adminDisabled);
    if(mode==='independent'&&!own.enabled)return unavailable(catSetupError||ERR.catSync);
    return { mode, providerAvailable:true, available: true, reason: '' };
  }
  function catView() {
    if (!cat) return blankCat();
    const value = safeCall(() => cat.snapshot(), null);
    if (!value) return blankCat();
    const epoch = safeCall(() => cat.token().modeEpoch, 0);
    return { mode: value.mode, independentTrigger: value.independentTrigger, available: !!value.available, status: value.status,
      error: typeof value.error === 'string' ? value.error : '', modeEpoch: epoch,
      suggestion: value.suggestion ? { id: value.suggestion.id, targetId: value.suggestion.targetId, text: value.suggestion.text,
        state: value.suggestion.state } : null,
      nudge: value.nudge ? { messageId: value.nudge.messageId, who: value.nudge.who } : null,
      usage: { today: value.usage?.today ?? 0, limit: value.usage?.limit ?? settings.dailyLimit } };
  }
  function meView() {
    if (!me) return null;
    const user = me.user || {};
    return { user_id: user.user_id, name: user.name, display_name: user.display_name,
      avatar: projectAvatar(avatars, user.avatar, user.user_id, user.display_name || user.name),
      role: me.role, is_admin: !!me.is_admin, muted_until: me.muted_until ?? null, banned_at: me.banned_at ?? null,
      cat: projectServerCat(serverCat()) };
  }
  function snapshot() {
    if (disposed) return fallbackSnapshot(ERR.disposed);
    const snap = clientSnap();
    const a = authState();
    const catState = catView();
    const conn = connection();
    return {
      connection: conn,
      auth: { status: a?.status || 'unconfigured', message: a?.message || ERR.unconfigured, error: a?.error || '', signingIn },
      participation: participation(),
      loading: conn === 'online' && !me,
      me: meView(),
      channel: projectChannel(snap?.channel),
      messages: (snap?.messages || []).slice(-WS_LIMITS.MAX_MESSAGES).map(m => projectMessage(avatars, m)),
      hasMore: !!snap?.hasMore,
      historyCapped: !!snap?.hasMore && snap.messages.length >= WS_LIMITS.MAX_MESSAGES,
      members: (snap?.members || []).map(m => projectMember(avatars, m)),
      outbox: (snap?.outbox || []).map(e => ({ clientMessageId: e.clientMessageId, kind: e.kind, status: e.status, error: e.error,
        retryAfterMs: e.retryAfterMs, text: e.text, replyToId: e.replyToId, origin: e.origin, assistCatId: e.assistCatId })),
      catSettings: settingsView(settings),
      cat: catState, suggestion: catState.suggestion, nudge: catState.nudge,
      error: configError || initError || catSetupError || lastError || snap?.error?.message || '',
    };
  }
  function schedulePublish() {
    if (disposed || scheduled) return;
    scheduled = true;
    queueMicrotask(() => { scheduled = false; if (!disposed) quiet(() => onState(snapshot())); });
  }

  // ---- lobby context for lobby-cat (main process only, never published) ----
  function lobbyContext() {
    const snap = clientSnap();
    if (!snap || snap.status !== 'online' || !me) return null;
    const names = new Map();
    for (const m of snap.members || []) names.set(m.kind === 'cat' ? m.cat_id : m.user_id, m.display_name);
    const own = serverCat();
    return { ownerId: me.user?.user_id, ownerName: me.user?.display_name || me.user?.name, catId: own?.id || null,
      catReady: !!own && !own.admin_disabled && (settings.mode!=='independent'||own.enabled===true), catName: catName(), catsEnabled: snap.channel?.cats_enabled !== false,
      freeAllowed: !!snap.channel?.cat_free_mode_allowed, mutedUntil: me.muted_until ?? null, note: settings.note,
      messages: snap.messages || [], names };
  }

  // ---- background reconciliation ----
  let reconciling = false, session = 0, meFailed = false, syncing = null;
  function reconcile() {
    if (disposed || reconciling) return;
    reconciling = true;
    try {
      const status = authStatus();
      if (status !== 'signed-in' && me) {      // expired or revoked elsewhere
        me = null; session += 1;autoCatAttempted=false;catSetupError='';
        if (cat) quiet(() => cat.invalidate());
        if (experience) quiet(() => experience.close());
      }
      if (wantOpen && status === 'signed-in' && client && clientSnap()?.status === 'idle') quiet(() => client.connect());
      if (wantOpen && status === 'signed-in' && !me && !meLoading && !meFailed) void ensureMe();
      const available = participation().available;
      if (lastAvailable && !available && cat) quiet(() => cat.invalidate());   // cat disabled, cats off, provider gone, muted
      lastAvailable = available;
      if (experience) quiet(() => experience.setMode(available ? settings.mode : 'off'));
      // Register the existing companion lazily in assist mode, disabled on the
      // server. This creates no message/model call and never enables autonomy.
      if(wantOpen&&online()&&me&&!serverCat()&&!autoCatAttempted&&!syncing&&settings.mode==='assist'&&provider()
        &&!me.cat?.deleted&&!me.banned_at&&clientSnap()?.channel?.cats_enabled===true){
        autoCatAttempted=true;void syncServerCat({create:true,forceDisabled:true});
      }
    } finally { reconciling = false; }
  }
  function onAuthState() { reconcile(); schedulePublish(); }

  async function ensureMe() {
    if (me || !client || authStatus() !== 'signed-in') return;
    if (meLoading) return meLoading;
    const mine = session;
    meLoading = (async () => {
      try {
        const value = await client.rest.me();
        if (disposed || mine !== session) return;
        me = value; meFailed = false; meEnvAdmin = value.is_admin === true && value.role !== 'admin';
        const id = serverCat()?.id || null;
        if (settings.serverCatId !== id) { settings.serverCatId = id; saveSettings(); }
        void syncServerCat();
      } catch (error) {
        if (!disposed && mine === session) { meFailed = true; lastError = safeText(error); }
      } finally { meLoading = null; reconcile(); schedulePublish(); }
    })();
    return meLoading;
  }

  /** One service profile, one queue. Late responses cannot bind another account. */
  async function syncServerCat({create=false,profile=false,forceDisabled=false}={}) {
    if(!client||!online()||!me||authStatus()!=='signed-in')return !create&&!profile;
    const mine=session,ownerId=me.user?.user_id;
    const current=()=>!disposed&&mine===session&&me?.user?.user_id===ownerId&&authStatus()==='signed-in'&&online();
    const previous=syncing;
    const operation=Promise.resolve(previous).catch(()=>{}).then(async()=>{
      if(!current())return false;
      const own=serverCat();if(!own&&!create)return true;
      const channel=clientSnap()?.channel;
      const enabled=!forceDisabled&&effectiveMode()==='independent'&&!me.banned_at
        &&!(Number.isFinite(me.muted_until)&&me.muted_until>now())&&channel?.cats_enabled!==false&&!own?.admin_disabled;
      const name=profile?(settings.name||own?.name||persona().name):(own?.name||settings.name||persona().name);
      const avatarKey=profile&&settings.avatarKey!=='default'?settings.avatarKey:own?.avatar_key||(settings.avatarKey!=='default'?settings.avatarKey:'bigfish');
      const replyMode=settings.independentTrigger;
      if(own&&own.enabled===enabled&&own.reply_mode===replyMode&&(!profile||own.name===name&&own.avatar_key===avatarKey))return true;
      try{
        const updated=await client.rest.putCat({name,avatarKey,replyMode,enabled});
        if(!current())return false;
        if(!updated||!isUuid(updated.id)||updated.owner_user_id!==ownerId||updated.deleted)throw Error(ERR.catSync);
        me.cat=updated;settings.serverCatId=updated.id;catSetupError='';
        if(!saveSettings()){catSetupError=ERR.storage;return false;}
        return true;
      }catch(error){if(current())catSetupError=safeText(error);return false;}
    });
    syncing=operation;
    try{return await operation;}
    finally{if(syncing===operation)syncing=null;reconcile();schedulePublish();}
  }

  const ctxFor = message => ({ channelId: message.channel_id, ownerId: me?.user?.user_id, catId: serverCat()?.id || null,
    mode: participation().available ? settings.mode : 'off' });
  function onClientEvent(type, payload) {
    if (disposed) return;
    if (type === 'message.new' && payload.message) {
      const message = payload.message, author = message.author || {};
      const own = author.kind === 'cat' ? author.cat_id === serverCat()?.id : author.user_id === me?.user?.user_id;
      if (cat && payload.live) quiet(() => cat.onMessage(message, { live: true }));
      if (experience && me && (payload.live || own)) quiet(() => experience.observe(message, ctxFor(message)));
    } else if (type === 'message.deleted') {
      if (cat) quiet(() => cat.onDeleted(payload.messageId));
      if (experience) quiet(() => experience.deleted(payload.messageId));
    } else if (type === 'member.updated' && me && payload.userId === me.user?.user_id && payload.changes) {
      for (const key of ['muted_until', 'banned_at', 'role']) if (Object.hasOwn(payload.changes, key)) me[key] = payload.changes[key];
      if (Object.hasOwn(payload.changes, 'role') || Object.hasOwn(payload.changes, 'banned_at')) {
        me.is_admin = (meEnvAdmin || me.role === 'admin') && me.banned_at == null;
      }
    } else if (type === 'cat.updated' && me && payload.cat && payload.cat.owner_user_id === me.user?.user_id) {
      me.cat = payload.cat.deleted ? null : payload.cat;
      if(payload.cat.deleted){autoCatAttempted=true;quiet(()=>cat?.invalidate());}
    } else if (type === 'resync') {
      if (cat) quiet(() => cat.invalidate());      // gap beyond the resume window: everything in flight is void
    } else if (type === 'signed-out') {
      me = null; session += 1; wantOpen = false;autoCatAttempted=false;catSetupError='';
      if (cat) quiet(() => cat.invalidate());
      if (experience) quiet(() => experience.close());
    }
    reconcile();
    schedulePublish();
  }

  // ---- request handlers ----
  const ok = () => ({ ok: true, state: snapshot() });
  const fail = error => ({ ok: false, error: typeof error === 'string' ? error : safeText(error), state: snapshot() });
  const attempt = async fn => { try { await fn(); return ok(); } catch (error) { return fail(error); } };

  function commitSettings(changes) {
    if(changes.mode!==undefined&&changes.mode!=='off'&&!provider())return providerReason();
    const previous={...settings};Object.assign(settings,changes);
    if(!saveSettings()){Object.assign(settings,previous);return ERR.storage;}
    if(cat&&(changes.mode!==undefined||changes.independentTrigger!==undefined)&&(settings.mode==='off'||provider())){
      try{cat.setMode(settings.mode,settings.independentTrigger);}
      catch(error){Object.assign(settings,previous);const restored=saveSettings();quiet(()=>cat.setMode(previous.mode,previous.independentTrigger));return restored?safeText(error):ERR.storage;}
    }
    return '';
  }
  /** Local mode changes commit before publishing and explicitly provision a missing server profile. */
  async function applyMode(mode, trigger) {
    if(mode!=='off'){
      if(!provider())return fail(providerReason());
      if(authStatus()!=='signed-in')return fail(ERR.login);
      if(!me||!online())return fail(me?ERR.closed:ERR.loading);
    }
    const error=commitSettings({mode,...(trigger!==undefined?{independentTrigger:trigger}:{})});if(error)return fail(error);
    reconcile();
    if (me && online() && !(await syncServerCat({create:mode!=='off'}))) return fail(catSetupError || ERR.catSync);
    return null;
  }

  const ADMIN_CHANNEL_KEYS = Object.freeze({ name: 'name', topic: 'topic', slowModeSeconds: 'slow_mode_seconds',
    catsEnabled: 'cats_enabled', catFreeAllowed: 'cat_free_mode_allowed' });

  async function doRequest(value) {
    let request;
    try { request = validateLobbyRequest(value); } catch (error) { return fail(error.code === 'lobby_request' ? error.message : ERR.request); }
    const action = request.action;
    if (action === 'state') { reconcile(); return ok(); }
    if(action==='mode-set'&&request.mode==='off'){const failed=await applyMode(request.mode,request.trigger);return failed||ok();}
    if (!healthy()) return fail(configError || initError || ERR.unconfigured);

    switch (action) {
      case 'sign-in': {
        return signIn(false);
      }
      case 'sign-in-cancel':
        quiet(() => auth.cancelSignIn());
        signingIn = false;
        return ok();
      case 'sign-out':
        me = null; session += 1; wantOpen = false; meFailed = false;autoCatAttempted=false;catSetupError='';
        if (cat) quiet(() => cat.invalidate());
        if (experience) quiet(() => experience.close());
        quiet(() => client.reset());
        try { await auth.signOut(); } catch { /* local state is cleared either way */ }
        return ok();
      default: break;
    }

    if (action === 'mode-set') {
      const failed = await applyMode(request.mode, request.trigger);
      return failed || ok();
    }
    if (authStatus() !== 'signed-in') return fail(ERR.login);

    if (action === 'open') {
      wantOpen = true; meFailed = false;
      quiet(() => client.connect());
      await ensureMe();
      processPending();
      return me ? ok() : fail(lastError || ERR.loading);
    }
    if (action === 'close') {
      wantOpen = false;
      if (cat) quiet(() => cat.invalidate());       // leaving the lobby voids every generation in flight
      if (experience) quiet(() => experience.close());
      quiet(() => client.disconnect());
      return ok();
    }

    if (action === 'cat-save') {
      if(!me||!online())return fail(me?ERR.closed:ERR.loading);
      const changes={};for(const key of ['mode','independentTrigger','note','dailyLimit','name','avatarKey'])if(request[key]!==undefined)changes[key]=request[key];
      const error=commitSettings(changes);if(error)return fail(error);
      if(!(await syncServerCat({create:true,profile:true})))return fail(catSetupError||ERR.catSync);
      reconcile();
      return ok();
    }

    if (!online()) return fail(ERR.closed);
    if (!me) return fail(ERR.loading);
    const channelId = clientSnap()?.channel?.id;

    switch (action) {
      case 'send':
        if (request.origin === 'human_ai' && request.assistCatId !== serverCat()?.id) return fail(ERR.assist);
        // Resolves on ack; the outbox in the snapshot shows pending/failed meanwhile.
        return attempt(() => client.send({ text: request.text, replyToId: request.replyToId, origin: request.origin,
          assistCatId: request.assistCatId }));
      case 'send-retry': return attempt(() => client.retry(request.clientMessageId));
      case 'send-discard': quiet(() => client.discard(request.clientMessageId)); return ok();
      case 'load-older': return attempt(() => client.loadOlder());
      case 'suggest':
        if (!cat) return fail(ERR.init);
        if (!provider()) return fail(providerReason());
        if(settings.mode!=='assist')return fail(CAT_ERRORS.mode);
        if(!serverCat()&&!(await syncServerCat({create:true})))return fail(catSetupError||ERR.catSync);
        if(!participation().available)return fail(participation().reason);
        return attempt(() => cat.requestSuggestion({ targetMessageId: request.targetMessageId ?? null,
          instruction: request.instruction ?? '', draftEpoch: request.draftEpoch }));
      case 'suggest-cancel': if (cat) quiet(() => cat.cancelSuggestion()); return ok();
      case 'suggest-discard': if (cat) quiet(() => cat.discardSuggestion()); return ok();
      default: break;
    }

    if (!action.startsWith('admin-')) return fail(ERR.action);
    // Same rule as the server: admins delete anything, authors delete their own human messages.
    const ownMessage = action === 'admin-delete' && (clientSnap()?.messages || []).some(m => m.id === request.messageId
      && m.author?.kind === 'human' && !!me.user?.user_id && m.author.user_id === me.user.user_id);
    if (!me.is_admin && !ownMessage) return fail(ERR.admin);
    if (!channelId) return fail(ERR.loading);
    switch (action) {
      case 'admin-channel': {
        const changes = {};
        for (const [key, wire] of Object.entries(ADMIN_CHANNEL_KEYS)) if (request[key] !== undefined) changes[wire] = request[key];
        return attempt(() => client.rest.updateChannel(channelId, changes));
      }
      case 'admin-delete': return attempt(() => client.rest.deleteMessage(channelId, request.messageId));
      case 'admin-mute': return attempt(() => client.rest.mute(channelId, request.userId, { minutes: request.minutes, reason: request.reason ?? undefined }));
      case 'admin-unmute': return attempt(() => client.rest.unmute(channelId, request.userId));
      case 'admin-ban': return attempt(() => client.rest.ban(channelId, request.userId, { reason: request.reason ?? undefined }));
      case 'admin-unban': return attempt(() => client.rest.unban(channelId, request.userId));
      case 'admin-cat': return attempt(() => (request.disable ? client.rest.disableCat(channelId, request.catId)
        : client.rest.enableCat(channelId, request.catId)));
      default: return fail(ERR.action);
    }
  }

  async function request(value) {
    const mutation=value?.action==='mode-set'||value?.action==='cat-save',requestSession=session;
    const execute=async()=>{
      if (disposed) return { ok: false, error: ERR.disposed, state: snapshot() };
      if(mutation&&requestSession!==session)return fail(ERR.accountChanged);
      try { return await doRequest(value); } catch { return { ok: false, error: ERR.failed, state: safeCall(snapshot, fallbackSnapshot(ERR.failed)) }; }
      finally { schedulePublish(); }
    };
    if(mutation){const operation=settingsTail.then(execute);settingsTail=operation.catch(()=>{});return operation;}
    return execute();
  }

  // Trusted main-process use only. No force flag is accepted from the public
  // lobby renderer request schema. Existing grants survive failed/canceled
  // replacement authorization in their original encrypted owner.
  async function signIn(force) {
    if (!healthy()) return fail(configError || initError || ERR.unconfigured);
    if (force) {
      me = null; session += 1; meFailed = false;autoCatAttempted=false;catSetupError='';
      quiet(() => cat?.invalidate()); quiet(() => experience?.close()); quiet(() => client?.reset());
    }
    signingIn = true; schedulePublish();
    try { await auth.signIn({force}); } finally { signingIn = false; }
    reconcile(); const a = authState();
    return a?.status === 'signed-in' && (!force || !a.error) ? ok() : fail(a?.error || ERR.login);
  }
  async function verifyIdentity() {
    if (disposed || !healthy() || authStatus() !== 'signed-in' || !client) return null;
    const mine = session;
    try {
      // Verify /me without opening a WebSocket, changing cat settings, or
      // projecting access/refresh credentials into the account coordinator.
      const value = await client.rest.me();
      if (disposed || mine !== session || authStatus() !== 'signed-in') return null;
      return typeof value?.user?.user_id === 'string' && value.user.user_id.length <= 128
        ? {userId:value.user.user_id} : null;
    } catch { return null; }
  }

  /** Route changes invalidate public jobs while preserving the user's participation mode. */
  function refresh() {
    if (disposed) return;
    quiet(() => {
      const had = lastProvider, key=providerKey(); lastProvider = !!provider();
      if (key !== lastProviderKey && cat) quiet(() => cat.invalidate());
      lastProviderKey=key;
      reconcile();
      if(!had&&lastProvider&&cat)quiet(()=>cat.setMode(settings.mode,settings.independentTrigger));
      if(!had&&lastProvider)processPending();
      if (had !== lastProvider && me && online()) void syncServerCat();
    });
    schedulePublish();
  }
  let lastProvider = !!provider();
  let lastProviderKey = providerKey();

  function dispose() {
    if (disposed) return;
    disposed = true;
    if (experience) quiet(() => experience.persistOnQuit());
    if (cat) quiet(() => cat.dispose());
    if (client) quiet(() => client.dispose());
    if (auth) quiet(() => auth.dispose());
  }

  /** Called by main once the selected companion route is ready. */
  function processPendingOnStart() { if (!disposed) processPending(); }

  return Object.freeze({ request, snapshot: () => safeCall(snapshot, fallbackSnapshot(ERR.failed)), reauthorize:()=>signIn(true), verifyIdentity, refresh, processPending: processPendingOnStart, dispose });
}

module.exports = { createLobbyController, validateLobbyRequest, readSettings, defaultSettings, ACTIONS, ERR, REASON, MODES, TRIGGERS };
