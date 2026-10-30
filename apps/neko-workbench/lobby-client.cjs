'use strict';

// N.E.K.O.Chat lobby client (docs/protocol.md v1). createLobbyRest is the REST
// half; createLobbyClient (below) is the WebSocket half built on top of it.
// REST: Bearer auth through lobby-auth, one retry after a token refresh on 401,
// bounded responses (512 KB for history and members, 64 KB otherwise),
// redirect:'error', timeouts, and server `detail` codes mapped through a fixed
// zh-CN table. Server text is never echoed; errors carry fixed text, a code,
// the HTTP status and an optional retryAfterMs. No token, message text or
// response body goes to a log, an error or a snapshot.
const { randomUUID } = require('node:crypto');
const F = require('./lobby-frames.cjs');

const API_PREFIX = '/api/v1';
const REQUEST_TIMEOUT_MS = 15000;
const MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_HISTORY_BYTES = 512 * 1024;
const HISTORY_PAGE_LIMIT = 50;
const RESUME_PAGE_LIMIT = 200;
const MAX_MEMBERS = 5000;
const MAX_ACTIONS = 100;
const MAX_REASON_CHARS = 500;
const MUTE_MINUTES = Object.freeze({ min: 10, max: 10080 });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CODE = /^[a-z][a-z0-9_]{0,63}$/;

// Fixed text for every server code in protocol.md plus local codes. Unknown
// server codes fall back to a status-based local code; nothing is echoed.
const SAFE_ERROR = Object.freeze({
  // local
  unconfigured: '频道服务未配置。',
  login: '请先登录频道。',
  expired: '频道登录已失效，请重新登录。',
  storage: '系统加密存储不可用，无法读取频道登录；请启用系统钥匙串后重试。',
  unavailable: '频道服务暂时不可用，请稍后重试。',
  timeout: '频道请求超时，请稍后重试。',
  canceled: '频道请求已取消。',
  protocol: '频道服务响应不符合预期，请稍后重试。',
  invalid: '频道请求参数无效。',
  request: '频道请求未被接受。',
  not_found: '请求的频道内容不存在。',
  // auth
  unauthenticated: '频道登录已失效，请重新登录。',
  invalid_token: '频道登录已失效，请重新登录。',
  insufficient_scope: '频道登录权限不足，请重新登录。',
  identity_not_linked: '频道账号尚未关联，请重新登录。',
  auth_platform_unavailable: '账号服务暂时不可用，请稍后重试。',
  // channel
  channel_banned: '你已被禁止进入频道。',
  channel_muted: '你正在禁言中，暂时不能发言。',
  forbidden: '没有权限执行此操作。',
  channel_not_found: '频道不存在。',
  member_not_found: '成员不存在。',
  too_many_connections: '频道连接过多，请关闭其他窗口后重试。',
  // rate
  rate_limited: '发送太快了，请稍后再试。',
  slow_mode: '频道处于慢速模式，请稍后再发。',
  // text
  text_empty: '内容不能为空。',
  text_too_long: '内容太长了。',
  invalid_mentions: '提及的成员无效或过多。',
  // reply
  reply_target_not_found: '要回复的消息不存在或已删除。',
  reply_target_too_old: '要回复的消息太旧了。',
  // cat
  cat_not_found: '还没有设置猫娘。',
  cat_disabled: '猫娘已被停用。',
  cats_disabled: '频道暂未开放猫娘参与。',
  cat_mode_not_allowed: '频道不允许自由发言模式。',
  cat_trigger_not_satisfied: '这条消息不满足猫娘发言条件。',
  cat_cooldown: '猫娘刚说过话，稍后再来。',
  cat_reply_limit: '这条消息的猫娘回复已满。',
  cat_depth_limit: '猫娘之间的接话已到上限。',
  cat_duplicate_reply: '猫娘已经回复过这条消息。',
  cat_limiter_unavailable: '猫娘防刷屏服务暂时不可用。',
  assist_cat_invalid: '共同回复的猫娘无效。',
  // protocol
  frame_invalid: '请求格式无效。',
  frame_too_large: '内容太大了。',
  message_not_found: '消息不存在或已删除。',
  invalid_cursor: '历史位置无效。',
});

function failure(code, { status = null, retryAfterMs = null } = {}) {
  const known = Object.hasOwn(SAFE_ERROR, code) ? code : 'unavailable';
  return Object.assign(new Error(SAFE_ERROR[known]), { code: known, status, retryAfterMs });
}

function statusCode(status) {
  if (status === 401) return 'login';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not_found';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'unavailable';
  return 'request';
}

// FastAPI shapes: {"detail": "code"} or {"detail": {"code": "...", "retry_after_ms": n}}.
function serverError(status, body, headers) {
  const detail = body && typeof body === 'object' ? body.detail : undefined;
  const raw = typeof detail === 'string' ? detail : detail && typeof detail === 'object' ? detail.code : undefined;
  const code = typeof raw === 'string' && CODE.test(raw) && Object.hasOwn(SAFE_ERROR, raw) ? raw : statusCode(status);
  let retryAfterMs = null;
  const fromBody = detail && typeof detail === 'object' ? detail.retry_after_ms : body?.retry_after_ms;
  if (Number.isSafeInteger(fromBody) && fromBody >= 0 && fromBody <= F.MAX_RETRY_AFTER_MS) retryAfterMs = fromBody;
  else {
    const header = headers?.get?.('retry-after');
    if (typeof header === 'string' && /^[0-9]{1,5}$/.test(header)) retryAfterMs = Number(header) * 1000;
  }
  return failure(code, { status, retryAfterMs });
}

async function readBounded(response, limit) {
  const declared = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > limit) {
    await response.body?.cancel?.().catch(() => {});
    throw failure('protocol', { status: response.status });
  }
  if (!response.body) return '';
  const chunks = []; let bytes = 0;
  for await (const chunk of response.body) {
    const buffer = Buffer.from(chunk); bytes += buffer.length;
    if (bytes > limit) {
      await response.body.cancel?.().catch(() => {});
      throw failure('protocol', { status: response.status });
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

// undefined = empty body; BAD_JSON = unparsable body.
const BAD_JSON = Symbol('bad-json');
const parseJson = text => {
  if (!text) return undefined;
  try { return JSON.parse(text); } catch { return BAD_JSON; }
};
// ---- argument checks (fail before any network call) ----
const invalid = () => failure('invalid');
const uuidArg = value => (typeof value === 'string' && UUID.test(value) ? value.toLowerCase() : (() => { throw invalid(); })());
const intArg = (value, min, max) => (Number.isSafeInteger(value) && value >= min && value <= max ? value : (() => { throw invalid(); })());
const charCount = value => Array.from(value).length;
function textArg(value, min, max) {
  if (typeof value !== 'string' || /[\u0000-\u001f\u007f]/.test(value)) throw invalid();
  const n = charCount(value);
  if (n < min || n > max) throw invalid();
  return value;
}
const reasonArg = value => (value === undefined || value === null || value === '' ? undefined : textArg(value, 1, MAX_REASON_CHARS));

// ---- response checks: rebuild from known fields; protocol error otherwise ----
const protocol = status => failure('protocol', { status });
const isObject = value => !!value && typeof value === 'object' && !Array.isArray(value);
const optTime = value => (value === undefined || value === null ? null
  : Number.isSafeInteger(value) && value >= 0 ? value : (() => { throw protocol(); })());

function channelResponse(value) {
  const channel = F.guard(F.channel)(value);
  if (!channel) throw protocol(200);
  return channel;
}

function catResponse(value) {
  const cat = F.guard(F.cat)(value);
  if (!cat) throw protocol(200);
  return cat;
}

// GET /me: { user: <human view>, role, is_admin, muted_until, banned_at, cat, limits }.
const LIMIT_KEYS = ['human_burst', 'human_burst_window_seconds', 'human_per_minute', 'slow_mode_seconds',
  'cat_cooldown_seconds', 'cat_free_cooldown_seconds', 'cat_hourly', 'channel_cat_per_minute',
  'cat_reply_limit', 'cat_depth_limit', 'human_text_max', 'cat_text_max'];
function meResponse(value) {
  if (!isObject(value) || !isObject(value.user)) throw protocol(200);
  const user = F.guard(user => F.humanAuthor(user, 'human'))(value.user);
  if (!user || typeof value.is_admin !== 'boolean' || !F.ROLES.has(value.role)) throw protocol(200);
  const limits = {};
  if (isObject(value.limits)) {
    for (const key of LIMIT_KEYS) {
      const n = value.limits[key];
      if (Number.isSafeInteger(n) && n >= 0) limits[key] = n;
    }
  }
  return {
    user: { user_id: user.user_id, name: user.name, display_name: user.display_name, avatar: user.avatar },
    role: value.role, is_admin: value.is_admin,
    muted_until: optTime(value.muted_until), banned_at: optTime(value.banned_at),
    cat: value.cat === undefined || value.cat === null ? null : catResponse(value.cat),
    limits,
  };
}

// GET /channels/{id}/messages: { messages: [...], next_before_seq, has_more }.
// Malformed entries are dropped (counted); order and cursor bounds are enforced.
function historyResponse(value, { beforeSeq, afterSeq, limit }) {
  if (!isObject(value) || !Array.isArray(value.messages) || value.messages.length > limit
      || typeof value.has_more !== 'boolean') throw protocol(200);
  const next = value.next_before_seq;
  if (next !== undefined && next !== null && !(Number.isSafeInteger(next) && next >= 1)) throw protocol(200);
  const messages = []; let dropped = 0; let previous = 0;
  for (const raw of value.messages) {
    const message = F.guard(F.message)(raw);
    if (!message) { dropped += 1; continue; }
    if (message.seq <= previous || (beforeSeq !== undefined && message.seq >= beforeSeq)
        || (afterSeq !== undefined && message.seq <= afterSeq)) throw protocol(200);
    previous = message.seq;
    messages.push(message);
  }
  return { messages, next_before_seq: next ?? null, has_more: value.has_more, dropped };
}

// GET /channels/{id}/members: { members: [human | cat entries] }.
const memberEntry = F.guard(value => {
  if (!isObject(value)) return null;
  const online = typeof value.online === 'boolean' ? value.online : false;
  if (value.kind === 'cat') {
    const cat = F.cat({ ...value, id: value.cat_id ?? value.id });
    return { kind: 'cat', cat_id: cat.id, owner_user_id: cat.owner_user_id, owner_name: cat.owner_name, name: cat.name,
      display_name: cat.display_name, avatar_key: cat.avatar_key, enabled: cat.enabled, admin_disabled: cat.admin_disabled, online };
  }
  if (value.kind !== 'human') return null;
  const human = F.humanAuthor({ ...value, assist_cat: undefined }, 'human');
  const state = F.stateChanges({ role: value.role ?? 'member', muted_until: value.muted_until ?? null, banned_at: value.banned_at ?? null });
  return { kind: 'human', user_id: human.user_id, name: human.name, display_name: human.display_name, avatar: human.avatar,
    role: state.role, muted_until: state.muted_until, banned_at: state.banned_at, online };
});
function membersResponse(value) {
  if (!isObject(value) || !Array.isArray(value.members) || value.members.length > MAX_MEMBERS) throw protocol(200);
  const members = []; let dropped = 0;
  for (const raw of value.members) {
    const entry = memberEntry(raw);
    if (entry) members.push(entry); else dropped += 1;
  }
  return { members, dropped };
}

// GET /channels/{id}/moderation-actions: [...] or { actions: [...] }.
const ACTION = /^[a-z]+\.[a-z_]+$/;
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T[0-9:.]+(?:Z|[+-]\d{2}:\d{2})?$/;
function actionsResponse(value) {
  const list = Array.isArray(value) ? value : isObject(value) && Array.isArray(value.actions) ? value.actions : null;
  if (!list || list.length > MAX_ACTIONS) throw protocol(200);
  const nullableId = raw => (raw === null || raw === undefined ? null : UUID.test(raw) ? raw.toLowerCase() : (() => { throw protocol(200); })());
  return list.map(row => {
    if (!isObject(row) || typeof row.id !== 'string' || !UUID.test(row.id) || typeof row.action !== 'string' || !ACTION.test(row.action)
        || typeof row.actor_user_id !== 'string' || !UUID.test(row.actor_user_id)
        || typeof row.created_at !== 'string' || !ISO_TIME.test(row.created_at)) throw protocol(200);
    const reason = typeof row.reason === 'string' && charCount(row.reason) <= MAX_REASON_CHARS ? row.reason : null;
    const params = {};
    if (isObject(row.params)) {
      if (Number.isSafeInteger(row.params.minutes)) params.minutes = row.params.minutes;
      if (F.ROLES.has(row.params.role)) params.role = row.params.role;
    }
    return { id: row.id.toLowerCase(), action: row.action, actor_user_id: row.actor_user_id.toLowerCase(),
      target_user_id: nullableId(row.target_user_id), target_message_id: nullableId(row.target_message_id),
      target_cat_id: nullableId(row.target_cat_id), reason, params, created_at: row.created_at };
  });
}
// Write endpoints answer with the persisted event frame(s) (moderation/service.py).
// The same events also arrive over WS, so a malformed body is not an error.
function framesResponse(value) {
  const list = Array.isArray(value) ? value : isObject(value) ? [value] : [];
  return list.map(F.validateFrame).filter(isObject);
}

// lobby-auth errors that may pass through as-is; anything else means "sign in".
const AUTH_PASS = new Set(['unconfigured', 'storage', 'login', 'expired', 'unavailable', 'timeout', 'canceled']);
const authFailure = error => failure(error?.code === 'rejected' ? 'expired'
  : AUTH_PASS.has(error?.code) ? error.code : 'login');

function apiBase(chatUrl) {
  const url = new URL(chatUrl);
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}${API_PREFIX}`;
}

// createLobbyRest({ config, auth, fetchImpl, timeoutMs })
//   config: resolveChatConfig() result; auth: lobby-auth instance
//   (getAccessToken({forceRefresh}), invalidateAccessToken()).
// Every method rejects with an Error whose message is SAFE_ERROR text and whose
// code is a SAFE_ERROR key.
function createLobbyRest({ config, auth, fetchImpl = globalThis.fetch, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  const configured = !!config?.configured;
  const base = configured ? apiBase(config.chatUrl) : null;
  let lifetime = new AbortController();
  let disposed = false;

  async function attempt(method, url, { body, maxBytes, signal, forceRefresh }) {
    let token;
    try { token = await auth.getAccessToken({ forceRefresh }); } catch (error) { throw authFailure(error); }
    if (typeof token !== 'string' || !token) throw failure('login');
    const life = lifetime.signal;
    if (life.aborted || signal?.aborted) throw failure('canceled');
    const deadline = AbortSignal.timeout(timeoutMs);
    const signals = [life, deadline, ...(signal ? [signal] : [])];
    const headers = { Accept: 'application/json', Authorization: `Bearer ${token}` };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    try {
      const response = await fetchImpl(url, { method, redirect: 'error', cache: 'no-store', credentials: 'omit',
        headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.any(signals) });
      const text = await readBounded(response, maxBytes);
      return { status: response.status, ok: response.ok, headers: response.headers, value: parseJson(text) };
    } catch (error) {
      if (life.aborted || signal?.aborted) throw failure('canceled');
      if (deadline.aborted) throw failure('timeout');
      if (error instanceof Error && error.code === 'protocol' && error.message === SAFE_ERROR.protocol) throw error;
      throw failure('unavailable');
    }
  }

  // One request; on 401 drop the in-memory token, refresh, and retry once.
  async function request(method, path, { query, body, maxBytes = MAX_RESPONSE_BYTES, signal, allow404 = false } = {}) {
    if (!configured) throw failure('unconfigured');
    if (disposed) throw failure('canceled');
    const search = query ? new URLSearchParams(Object.entries(query).filter(([, v]) => v !== undefined)
      .map(([k, v]) => [k, String(v)])).toString() : '';
    const url = `${base}${path}${search ? `?${search}` : ''}`;
    let result = await attempt(method, url, { body, maxBytes, signal, forceRefresh: false });
    if (result.status === 401) {
      try { auth.invalidateAccessToken(); } catch { /* best effort */ }
      result = await attempt(method, url, { body, maxBytes, signal, forceRefresh: true });
      if (result.status === 401) {
        try { auth.invalidateAccessToken(); } catch { /* best effort */ }
        throw failure('expired', { status: 401 });
      }
    }
    if (allow404 && result.status === 404) return { notFound: true, value: result.value === BAD_JSON ? undefined : result.value };
    const value = result.value === BAD_JSON ? undefined : result.value;
    if (!result.ok) throw serverError(result.status, value, result.headers);
    if (result.value === BAD_JSON) throw protocol(result.status);
    return { notFound: false, value: result.value };
  }

  const channelPath = channelId => `/channels/${uuidArg(channelId)}`;
  const memberPath = (channelId, userId) => `${channelPath(channelId)}/members/${uuidArg(userId)}`;
  const write = async (method, path, options) => framesResponse((await request(method, path, options)).value);

  async function history(channelId, { beforeSeq, afterSeq, limit, signal } = {}) {
    const path = `${channelPath(channelId)}/messages`;
    if (beforeSeq !== undefined && afterSeq !== undefined) throw invalid();
    const cap = afterSeq !== undefined ? RESUME_PAGE_LIMIT : HISTORY_PAGE_LIMIT;
    const size = limit === undefined ? cap : intArg(limit, 1, cap);
    const query = { limit: size };
    if (beforeSeq !== undefined) query.before_seq = intArg(beforeSeq, 1, Number.MAX_SAFE_INTEGER);
    if (afterSeq !== undefined) query.after_seq = intArg(afterSeq, 0, Number.MAX_SAFE_INTEGER);
    const { value } = await request('GET', path, { query, maxBytes: MAX_HISTORY_BYTES, signal });
    return historyResponse(value, { beforeSeq, afterSeq, limit: size });
  }

  async function putCat({ name, avatarKey, replyMode, enabled } = {}, { signal } = {}) {
    textArg(name, 1, 32);
    if (typeof avatarKey !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(avatarKey) || !F.REPLY_MODES.has(replyMode)
        || typeof enabled !== 'boolean') throw invalid();
    const { value } = await request('PUT', '/me/cat', { body: { name, avatar_key: avatarKey, reply_mode: replyMode, enabled }, signal });
    // Accepts the cat view itself, a cat.updated frame, or { cat: <view> }.
    const view = isObject(value) && !Object.hasOwn(value, 'id') && isObject(value.cat) ? value.cat : value;
    return catResponse(view);
  }
  async function updateChannel(channelId, changes = {}, { signal } = {}) {
    const path = channelPath(channelId);
    if (!isObject(changes)) throw invalid();
    const body = {};
    for (const key of Object.keys(changes)) {
      const value = changes[key];
      if (key === 'name') body.name = textArg(value, 1, 32);
      else if (key === 'topic') body.topic = textArg(value, 0, F.MAX_TOPIC_CHARS);
      else if (key === 'slow_mode_seconds') { if (!F.SLOW_MODES.has(value)) throw invalid(); body[key] = value; }
      else if (key === 'cats_enabled' || key === 'cat_free_mode_allowed') { if (typeof value !== 'boolean') throw invalid(); body[key] = value; }
      else throw invalid();
    }
    if (!Object.keys(body).length) throw invalid();
    return write('PATCH', path, { body, signal });
  }

  async function mute(channelId, userId, { minutes, reason } = {}, { signal } = {}) {
    const path = `${memberPath(channelId, userId)}/mute`;
    const body = { minutes: intArg(minutes, MUTE_MINUTES.min, MUTE_MINUTES.max) };
    const why = reasonArg(reason); if (why !== undefined) body.reason = why;
    return write('POST', path, { body, signal });
  }

  async function ban(channelId, userId, { reason } = {}, { signal } = {}) {
    const path = `${memberPath(channelId, userId)}/ban`;
    const why = reasonArg(reason);
    return write('POST', path, { body: why === undefined ? {} : { reason: why }, signal });
  }

  async function setRole(channelId, userId, role, { signal } = {}) {
    const path = `${memberPath(channelId, userId)}/role`;
    if (!F.ROLES.has(role)) throw invalid();
    return write('PUT', path, { body: { role }, signal });
  }

  async function setCatDisabled(channelId, catId, disabled, { signal } = {}) {
    if (typeof disabled !== 'boolean') throw invalid();
    const path = `${channelPath(channelId)}/cats/${uuidArg(catId)}/${disabled ? 'disable' : 'enable'}`;
    return write('POST', path, { signal });
  }

  async function moderationActions(channelId, { before, signal } = {}) {
    const path = `${channelPath(channelId)}/moderation-actions`;
    const query = before === undefined ? undefined : { before: uuidArg(before) };
    const { value } = await request('GET', path, { query, signal });
    return actionsResponse(value);
  }

  // abortAll(): cancel in-flight requests (sign-out, leaving the lobby); the
  // client stays usable. dispose(): cancel and refuse every later request.
  function abortAll() {
    lifetime.abort();
    lifetime = new AbortController();
  }
  function dispose() {
    disposed = true;
    lifetime.abort();
  }

  return Object.freeze({
    get configured() { return configured; },
    me: async ({ signal } = {}) => meResponse((await request('GET', '/me', { signal })).value),
    lobby: async ({ signal } = {}) => channelResponse((await request('GET', '/channels/lobby', { signal })).value),
    history,
    members: async (channelId, { signal } = {}) => membersResponse((await request('GET', `${channelPath(channelId)}/members`,
      { maxBytes: MAX_HISTORY_BYTES, signal })).value),
    // null when the user has no cat (404 cat_not_found).
    getCat: async ({ signal } = {}) => {
      const result = await request('GET', '/me/cat', { signal, allow404: true });
      if (result.notFound) {
        const detail = result.value?.detail;
        const code = typeof detail === 'string' ? detail : detail?.code;
        if (code === undefined || code === 'cat_not_found') return null;
        throw serverError(404, result.value);
      }
      return result.value === null ? null : catResponse(result.value);
    },
    putCat,
    deleteCat: async ({ signal } = {}) => write('DELETE', '/me/cat', { signal }),
    deleteMessage: async (channelId, messageId, { signal } = {}) => {
      const path = `${channelPath(channelId)}/messages/${uuidArg(messageId)}`;
      return write('DELETE', path, { signal });
    },
    updateChannel,
    mute,
    unmute: async (channelId, userId, { signal } = {}) => write('DELETE', `${memberPath(channelId, userId)}/mute`, { signal }),
    ban,
    unban: async (channelId, userId, { signal } = {}) => write('DELETE', `${memberPath(channelId, userId)}/ban`, { signal }),
    setRole,
    disableCat: async (channelId, catId, options) => setCatDisabled(channelId, catId, true, options),
    enableCat: async (channelId, catId, options) => setCatDisabled(channelId, catId, false, options),
    moderationActions,
    abortAll,
    dispose,
  });
}

// ---------------------------------------------------------------------------
// WebSocket half (protocol.md "Connection", "Handshake", "Event sequence and
// resume"). The access token goes only in the first `auth` frame and in
// `auth.refresh`, never in the URL. Everything lives in memory; nothing is
// written to disk, logged, or put in an error message.
const WS_LIMITS = Object.freeze({
  HELLO_TIMEOUT_MS: 10000,      // open, then hello, each within 10 s
  PING_INTERVAL_MS: 20000,
  IDLE_TIMEOUT_MS: 60000,       // no inbound frame for 60 s = dead
  BACKOFF_BASE_MS: 1000,
  BACKOFF_MAX_MS: 30000,
  STABLE_MS: 60000,             // backoff resets after 60 s online
  SEND_TIMEOUT_MS: 30000,       // outbox entry fails after 30 s without ack
  REFRESH_LEAD_MS: 120000,      // auth.refresh 2 min before token_expires_at
  REFRESH_MIN_DELAY_MS: 1000,
  REFRESH_RETRY_MS: 30000,
  REFRESH_FALLBACK_MS: 600000,
  CATCHUP_GRACE_MS: 2000,       // pong ahead of us: wait for in-flight events first
  TYPING_THROTTLE_MS: 3000,
  MAX_MESSAGES: 500,
  MAX_OUTBOX: 50,
  MAX_BUFFERED: 1000,
  MAX_CAT_TEXT_CHARS: 500,
  MAX_CAT_TEXT_LINES: 12,
});
const SOCKET_OPEN = 1;
const CLOSE_NORMAL = 1000;
const CLOSE_RECONNECT = 4000;
const CLOSE_AUTH_FAILED = 4401;
const CLOSE_BANNED = 4403;
const CLOSE_TOO_MANY = 4429;
const CAT_TRIGGERS = new Set(['mention', 'owner', 'free']);
const CAT_STATES = new Set(['ready', 'unavailable']);
// Codes after which reconnecting cannot help; the client stops and reports.
const STOP_CODES = new Set(['login', 'expired', 'insufficient_scope', 'storage', 'unconfigured', 'channel_banned']);
const SIGNED_OUT_CODES = new Set(['login', 'expired', 'insufficient_scope']);
const APP_VERSION = (() => {
  try {
    const { version } = require('./package.json');
    return typeof version === 'string' && /^[0-9A-Za-z.+-]{1,32}$/.test(version) ? version : '0.0.0';
  } catch { return '0.0.0'; }
})();

const codeOf = error => {
  const code = error?.code === 'rejected' ? 'expired' : error?.code;
  return typeof code === 'string' && Object.hasOwn(SAFE_ERROR, code) ? code : 'unavailable';
};

function socketUrl(chatUrl, channelId) {
  const url = new URL(chatUrl);
  const scheme = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${scheme}//${url.host}${url.pathname.replace(/\/+$/, '')}/ws/channels/${encodeURIComponent(uuidArg(channelId))}`;
}

// message.send body without client_message_id (protocol.md "Human message").
function humanFrame({ text, replyToId, origin = 'human', assistCatId } = {}) {
  if (typeof text !== 'string' || !text.trim() || text.length > F.MAX_TEXT_CHARS * 2 || charCount(text) > F.MAX_TEXT_CHARS) throw invalid();
  if (origin !== 'human' && origin !== 'human_ai') throw invalid();
  const frame = { type: 'message.send', text, origin };
  if (replyToId !== undefined && replyToId !== null) frame.reply_to_id = uuidArg(replyToId);
  if (origin === 'human_ai') frame.assist_cat_id = uuidArg(assistCatId);
  else if (assistCatId !== undefined && assistCatId !== null) throw invalid();
  return frame;
}

// cat.message.send body without client_message_id (protocol.md "Cat message").
function catFrame({ cat_id: catId, in_reply_to: inReplyTo, trigger, text } = {}) {
  if (typeof text !== 'string' || !text.trim() || text.length > WS_LIMITS.MAX_CAT_TEXT_CHARS * 2
      || charCount(text) > WS_LIMITS.MAX_CAT_TEXT_CHARS || text.split('\n').length > WS_LIMITS.MAX_CAT_TEXT_LINES) throw invalid();
  if (!CAT_TRIGGERS.has(trigger)) throw invalid();
  return { type: 'cat.message.send', cat_id: uuidArg(catId), in_reply_to: uuidArg(inReplyTo), trigger, text };
}

const presenceKey = (kind, id) => `${kind}:${id}`;
const deletedCopy = message => ({ ...message, deleted: true, text: null, mentions: [] });

// createLobbyClient({ config, auth, rest, fetchImpl, WebSocketImpl, timers, now, random, newId, onChange, onEvent })
//   config/auth: as for createLobbyRest; rest defaults to createLobbyRest(...).
//   WebSocketImpl: WHATWG-style constructor (Node/Electron global WebSocket or a fake).
//   onChange(reason): state changed; read snapshot(). onEvent(type, payload):
//   'message.new' {message}, 'message.deleted' {messageId, seq}, 'channel.updated',
//   'member.updated', 'cat.updated', 'typing', 'ack', 'error' {code, ref, retryAfterMs},
//   'outbox.failed' {clientMessageId, kind, code}, 'resync', 'signed-out' {code}.
// Status: unconfigured | idle | connecting | loading | online | reconnecting | stopped.
function createLobbyClient({
  config, auth, rest, fetchImpl, WebSocketImpl = globalThis.WebSocket, timers = globalThis, now = Date.now,
  random = Math.random, newId = randomUUID, onChange = () => {}, onEvent = () => {}, clientVersion = APP_VERSION,
  limits = {},
} = {}) {
  const L = { ...WS_LIMITS, ...limits };
  const configured = !!config?.configured;
  const api = rest || createLobbyRest({ config, auth, fetchImpl });
  let generation = 0;          // bumped by connect / disconnect / reset; stale async work checks it
  let socket = null;           // current { ws, id, hello, timers... } or null
  let socketCount = 0;
  let status = configured ? 'idle' : 'unconfigured';
  let lastError = null;        // SAFE_ERROR code or null
  let channel = null;
  let userId = null;
  let members = [];
  const presence = new Set();
  let messages = [];
  let hasMore = false;
  let nextBeforeSeq = null;
  let lastEventSeq = 0;        // highest contiguous event_seq applied
  let needsReload = true;      // next hello loads channel, members and latest page over REST
  let attempt = 0;             // reconnect backoff exponent
  let reconnectTimer = null;
  let forceRefresh = false;    // next token fetch must refresh (after 4401)
  let authFailures = 0;        // 4401 closes without a hello in between
  let gapRetries = 0;
  const outbox = new Map();    // client_message_id -> entry (insertion order kept)
  const stats = { dropped: 0, duplicates: 0, gaps: 0, reconnects: 0, resyncs: 0 };
  const catStates = new Map();  // cat_id -> 'ready' | 'unavailable', re-sent after every hello
  const typingAt = new Map();
  let session = 0;             // bumped whenever the message list is replaced; guards loadOlder
  let disposed = false;

  const emit = (type, payload = {}) => { try { onEvent(type, payload); } catch { /* observers never break the client */ } };
  const changed = reason => { try { onChange(reason); } catch { /* observers never break the client */ } };
  const clear = id => { if (id !== null && id !== undefined) timers.clearTimeout(id); };
  const later = (ms, fn) => timers.setTimeout(fn, Math.max(0, ms));
  const setStatus = (next, reason = 'status') => { if (status !== next) { status = next; changed(reason); } };

  // ---- local state ----
  function insertMessage(message) {
    if (!channel || message.channel_id !== channel.id) return false;
    const index = messages.findIndex(m => m.id === message.id);
    if (index >= 0) {
      messages[index] = messages[index].deleted ? deletedCopy(message) : message;
      return false;
    }
    let at = messages.length;
    while (at > 0 && messages[at - 1].seq > message.seq) at -= 1;
    messages.splice(at, 0, message);
    if (messages.length > L.MAX_MESSAGES) {
      messages.splice(0, messages.length - L.MAX_MESSAGES);
      hasMore = true;
      nextBeforeSeq = messages[0].seq;
    }
    return true;
  }

  function markDeleted(messageId) {
    const index = messages.findIndex(m => m.id === messageId);
    if (index >= 0 && !messages[index].deleted) messages[index] = deletedCopy(messages[index]);
  }

  function applyMember(frame) {
    const member = members.find(m => m.kind === 'human' && m.user_id === frame.user_id);
    if (member) Object.assign(member, frame.changes);
  }

  function applyCat(cat) {
    const index = members.findIndex(m => m.kind === 'cat' && m.cat_id === cat.id);
    if (cat.deleted) { if (index >= 0) members.splice(index, 1); return; }
    const entry = { kind: 'cat', cat_id: cat.id, owner_user_id: cat.owner_user_id, owner_name: cat.owner_name, name: cat.name,
      display_name: cat.display_name, avatar_key: cat.avatar_key, enabled: cat.enabled, admin_disabled: cat.admin_disabled };
    if (index >= 0) Object.assign(members[index], entry); else members.push({ ...entry, online: false });
  }

  // Event-log state only. Presence belongs to the connection (presence.snapshot
  // follows every hello), so a resync keeps it; reset() clears it.
  function clearState() {
    session += 1;
    messages = []; members = [];
    hasMore = false; nextBeforeSeq = null;
  }

  // Persistent event (has event_seq), already known to be lastEventSeq + 1.
  // `live`: newer than the hello's last_event_seq, i.e. not a resume replay.
  function applyEvent(frame, sock) {
    lastEventSeq = frame.event_seq;
    gapRetries = 0;
    if (frame.type === 'message.new') {
      if (insertMessage(frame.message)) emit('message.new', { message: frame.message, live: !!sock?.hello && frame.event_seq > sock.hello.last_event_seq });
    } else if (frame.type === 'message.deleted') {
      markDeleted(frame.message_id);
      emit('message.deleted', { messageId: frame.message_id, seq: frame.seq, deletedBy: frame.deleted_by });
    } else if (frame.type === 'channel.updated') {
      if (!channel || frame.channel.id === channel.id) { channel = frame.channel; emit('channel.updated', { channel }); }
    } else if (frame.type === 'member.updated') {
      applyMember(frame);
      emit('member.updated', { userId: frame.user_id, changes: frame.changes });
    } else if (frame.type === 'cat.updated') {
      applyCat(frame.cat);
      emit('cat.updated', { cat: frame.cat });
    }
  }

  function applyPresence(frame) {
    if (frame.type === 'presence.snapshot') {
      presence.clear();
      for (const m of frame.members) {
        if (!m.online) continue;
        if (m.user_id) presence.add(presenceKey('u', m.user_id));
        if (m.cat_id) presence.add(presenceKey('c', m.cat_id));
      }
      return;
    }
    const op = frame.type === 'presence.join' ? 'add' : 'delete';
    presence[op](presenceKey('u', frame.user_id));
    if (frame.cat_id) presence[op](presenceKey('c', frame.cat_id));
  }

  // ---- socket lifecycle ----
  function dropSocket(sock, code = CLOSE_NORMAL) {
    if (!sock || sock.dead) return;
    sock.dead = true;
    sock.token = null;
    for (const key of ['helloTimer', 'idleTimer', 'pingTimer', 'refreshTimer', 'stableTimer', 'catchupTimer']) clear(sock[key]);
    const { ws } = sock;
    ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
    try { ws.close(code); } catch { /* already closing */ }
    if (socket === sock) socket = null;
  }

  function scheduleReconnect({ immediate = false } = {}) {
    clear(reconnectTimer);
    let delay = 0;
    if (!immediate) {
      const cap = Math.min(L.BACKOFF_MAX_MS, L.BACKOFF_BASE_MS * 2 ** Math.min(attempt, 30));
      delay = Math.floor(random() * cap);   // full jitter
      attempt += 1;
    }
    stats.reconnects += 1;
    setStatus('reconnecting');
    const gen = generation;
    reconnectTimer = later(delay, () => { reconnectTimer = null; if (gen === generation) void open(); });
  }

  function stop(code) {
    generation += 1;
    clear(reconnectTimer); reconnectTimer = null;
    dropSocket(socket);
    lastError = code;
    for (const entry of outbox.values()) if (entry.status !== 'failed') failEntry(entry, code);
    setStatus('stopped', 'error');
    if (SIGNED_OUT_CODES.has(code)) emit('signed-out', { code });
  }

  function send(sock, frame) {
    if (!sock || sock.dead || sock.ws.readyState !== SOCKET_OPEN) return false;
    try { sock.ws.send(JSON.stringify(frame)); return true; } catch { return false; }
  }

  async function open() {
    if (!configured) { setStatus('unconfigured'); return; }
    const gen = ++generation;
    dropSocket(socket);
    if (status !== 'reconnecting') setStatus('connecting');
    let token;
    try {
      token = await auth.getAccessToken({ forceRefresh });
      if (typeof token !== 'string' || !token) throw failure('login');
      if (gen === generation && !channel) channel = await api.lobby();
    } catch (error) {
      if (gen !== generation) return;
      const code = error?.status === undefined ? authFailure(error).code : codeOf(error);
      lastError = code;
      if (STOP_CODES.has(code)) stop(code); else scheduleReconnect();
      return;
    }
    if (gen !== generation) return;
    forceRefresh = false;
    if (typeof WebSocketImpl !== 'function') { stop('unavailable'); return; }
    let ws;
    try {
      ws = new WebSocketImpl(socketUrl(config.chatUrl, channel.id));
    } catch {
      lastError = 'unavailable'; scheduleReconnect(); return;
    }
    try { ws.binaryType = 'arraybuffer'; } catch { /* optional */ }
    const sock = { ws, id: ++socketCount, gen, token, hello: null, loading: false, buffer: [], dead: false };
    socket = sock;
    const alive = () => socket === sock && !sock.dead && gen === generation;
    sock.helloTimer = later(L.HELLO_TIMEOUT_MS, () => { if (alive()) { lastError = 'timeout'; dropSocket(sock); scheduleReconnect(); } });
    ws.onopen = () => {
      if (!alive()) return;
      clear(sock.helloTimer);
      sock.helloTimer = later(L.HELLO_TIMEOUT_MS, () => { if (alive()) { lastError = 'timeout'; dropSocket(sock); scheduleReconnect(); } });
      const frame = { type: 'auth', token: sock.token, client: { name: 'neko-workbench', version: clientVersion } };
      if (!needsReload && lastEventSeq > 0) frame.last_event_seq = lastEventSeq;
      sock.token = null;
      send(sock, frame);
      resetIdle(sock, alive);
    };
    ws.onmessage = event => { if (alive()) onFrame(sock, alive, event?.data); };
    ws.onerror = () => { /* onclose follows; nothing from the event is kept */ };
    ws.onclose = event => { if (alive()) onClose(sock, Number(event?.code) || 1006); };
  }

  function resetIdle(sock, alive) {
    clear(sock.idleTimer);
    sock.idleTimer = later(L.IDLE_TIMEOUT_MS, () => {
      if (!alive()) return;
      lastError = 'timeout';
      dropSocket(sock, CLOSE_RECONNECT);
      scheduleReconnect();
    });
  }

  function onClose(sock, code) {
    dropSocket(sock);
    if (code === CLOSE_AUTH_FAILED) {
      try { auth.invalidateAccessToken(); } catch { /* best effort */ }
      forceRefresh = true;
      authFailures += 1;
      if (authFailures >= 2) { stop('expired'); return; }
      lastError = 'expired';
      scheduleReconnect({ immediate: authFailures === 1 && !!sock.hello });
      return;
    }
    if (code === CLOSE_BANNED) { stop('channel_banned'); return; }
    lastError = code === CLOSE_TOO_MANY ? 'too_many_connections' : 'unavailable';
    scheduleReconnect();
  }

  // ---- inbound frames ----
  function reconnectForGap(sock) {
    stats.gaps += 1;
    gapRetries += 1;
    if (gapRetries > 3) needsReload = true;   // replay keeps failing: resync from REST
    dropSocket(sock, CLOSE_RECONNECT);
    scheduleReconnect({ immediate: gapRetries <= 1 });
  }

  // Dedupe by event_seq; a jump means a lost event, so reconnect and replay.
  function handleEvent(sock, frame) {
    if (frame.event_seq <= lastEventSeq) { stats.duplicates += 1; return true; }
    if (frame.event_seq !== lastEventSeq + 1) { reconnectForGap(sock); return false; }
    applyEvent(frame, sock);
    if (sock.catchupTarget && lastEventSeq >= sock.catchupTarget) { clear(sock.catchupTimer); sock.catchupTimer = null; sock.catchupTarget = 0; }
    changed('event');
    return true;
  }

  function onHello(sock, alive, frame) {
    sock.hello = frame;
    userId = frame.user_id;
    authFailures = 0;
    lastError = null;
    clear(sock.helloTimer); sock.helloTimer = null;
    const ping = () => {
      if (!alive()) return;
      send(sock, { type: 'ping', t: now() });
      sock.pingTimer = later(L.PING_INTERVAL_MS, ping);
    };
    sock.pingTimer = later(L.PING_INTERVAL_MS, ping);
    sock.stableTimer = later(L.STABLE_MS, () => { if (alive()) attempt = 0; });
    scheduleRefresh(sock, alive, frame.token_expires_at);
    if (!needsReload && frame.last_event_seq < lastEventSeq) needsReload = true;   // server history went backwards
    if (needsReload) void reload(sock, alive, frame.last_event_seq);
    else setStatus('online');
    for (const entry of outbox.values()) if (entry.status !== 'failed') transmit(entry);
    for (const [catId, state] of catStates) send(sock, { type: 'cat.status', cat_id: catId, state });
  }

  function onFrame(sock, alive, data) {
    resetIdle(sock, alive);
    const frame = F.parseFrame(data);
    if (typeof frame === 'string') { stats.dropped += 1; return; }
    if (frame.type === 'error') { onError(frame); return; }
    if (!sock.hello) {
      if (frame.type === 'hello') onHello(sock, alive, frame); else stats.dropped += 1;
      return;
    }
    switch (frame.type) {
      case 'hello': stats.dropped += 1; return;
      case 'ack': onAck(frame); return;
      case 'pong': onPong(sock, alive, frame); return;
      case 'presence.snapshot': case 'presence.join': case 'presence.leave':
        applyPresence(frame); changed('presence'); return;
      case 'typing': emit('typing', { userId: frame.user_id, kind: frame.kind, catId: frame.cat_id }); return;
      case 'resync.required':
        if (sock.loading) return;           // already reloading from this hello's baseline
        stats.resyncs += 1;
        needsReload = true;
        clearState(); changed('resync');
        void reload(sock, alive, sock.hello.last_event_seq);
        return;
      default:
        if (!Number.isSafeInteger(frame.event_seq)) { stats.dropped += 1; return; }
        if (sock.loading) {
          if (sock.buffer.length >= L.MAX_BUFFERED) { needsReload = true; reconnectForGap(sock); return; }
          sock.buffer.push(frame);
          return;
        }
        handleEvent(sock, frame);
    }
  }

  function onPong(sock, alive, frame) {
    if (sock.loading || frame.last_event_seq <= lastEventSeq) return;
    // Events may still be in flight behind the pong; give them a moment, then replay.
    sock.catchupTarget = Math.max(sock.catchupTarget || 0, frame.last_event_seq);
    if (sock.catchupTimer) return;
    sock.catchupTimer = later(L.CATCHUP_GRACE_MS, () => {
      sock.catchupTimer = null;
      if (alive() && lastEventSeq < sock.catchupTarget) reconnectForGap(sock);
    });
  }

  // Latest page, members and channel over REST, then the frames that arrived meanwhile.
  async function reload(sock, alive, baseline) {
    sock.loading = true;
    sock.buffer = [];
    setStatus('loading');
    try {
      const fresh = await api.lobby();
      const [page, roster] = await Promise.all([api.history(fresh.id), api.members(fresh.id)]);
      if (!alive()) return;
      channel = fresh;
      clearState();
      members = roster.members.map(m => ({ ...m }));
      for (const m of page.messages.slice(-L.MAX_MESSAGES)) messages.push(m);
      hasMore = page.has_more || page.messages.length > messages.length;
      nextBeforeSeq = page.next_before_seq ?? (messages[0]?.seq ?? null);
      if (hasMore && nextBeforeSeq === null && messages.length) nextBeforeSeq = messages[0].seq;
      lastEventSeq = baseline;
      needsReload = false;
      gapRetries = 0;
      sock.loading = false;
      const buffered = sock.buffer; sock.buffer = [];
      emit('resync', {});
      setStatus('online', 'reload');
      for (const frame of buffered) if (!handleEvent(sock, frame)) return;
    } catch (error) {
      if (!alive()) return;
      sock.loading = false;
      const code = codeOf(error);
      if (STOP_CODES.has(code)) { stop(code); return; }
      lastError = code;
      dropSocket(sock, CLOSE_RECONNECT);
      scheduleReconnect();
    }
  }

  function scheduleRefresh(sock, alive, expiresAt) {
    clear(sock.refreshTimer);
    const left = Number.isSafeInteger(expiresAt) ? expiresAt - now() : NaN;
    const delay = Number.isFinite(left) && left > 0 ? Math.max(L.REFRESH_MIN_DELAY_MS, left - L.REFRESH_LEAD_MS) : L.REFRESH_FALLBACK_MS;
    sock.refreshTimer = later(delay, async () => {
      sock.refreshTimer = null;
      if (!alive()) return;
      let token;
      try {
        token = await auth.getAccessToken({ forceRefresh: true });
        if (typeof token !== 'string' || !token) throw failure('login');
      } catch (error) {
        if (!alive()) return;
        const code = authFailure(error).code;
        if (STOP_CODES.has(code)) { stop(code); return; }
        sock.refreshTimer = later(L.REFRESH_RETRY_MS, () => scheduleRefresh(sock, alive, now() + L.REFRESH_LEAD_MS));
        return;
      }
      if (!alive()) return;
      send(sock, { type: 'auth.refresh', token });
      token = null;
      // An expiry that is already inside the lead window would refresh again at
      // once; use the fallback interval instead so a stale expiry cannot loop.
      const next = auth.accessExpiresAt;
      const usable = Number.isSafeInteger(next) && next - now() > L.REFRESH_LEAD_MS + L.REFRESH_MIN_DELAY_MS;
      scheduleRefresh(sock, alive, usable ? next : now() + L.REFRESH_FALLBACK_MS + L.REFRESH_LEAD_MS);
    });
  }

  // ---- outbox: keyed by client_message_id, resent on every hello until ack or 30 s ----

  function transmit(entry) {
    const sock = socket;
    if (!sock || !sock.hello || sock.dead) return;
    if (send(sock, { ...entry.frame, client_message_id: entry.clientMessageId })) entry.status = 'sent';
  }

  function armTimeout(entry) {
    clear(entry.timer);
    entry.timer = later(L.SEND_TIMEOUT_MS - (now() - entry.startedAt), () => {
      entry.timer = null;
      if (outbox.get(entry.clientMessageId) === entry && entry.status !== 'failed') failEntry(entry, 'timeout');
    });
  }

  function failEntry(entry, code, retryAfterMs = null) {
    clear(entry.timer); entry.timer = null;
    entry.status = 'failed';
    entry.code = Object.hasOwn(SAFE_ERROR, code) ? code : 'unavailable';
    entry.retryAfterMs = retryAfterMs;
    const settle = entry.settle; entry.settle = null;
    settle?.reject(failure(entry.code, { retryAfterMs }));
    emit('outbox.failed', { clientMessageId: entry.clientMessageId, kind: entry.kind, code: entry.code, retryAfterMs });
    changed('outbox');
  }

  function track(entry) {
    const promise = new Promise((resolve, reject) => { entry.settle = { resolve, reject }; });
    promise.catch(() => {});   // callers may ignore the result; failures are also in the snapshot
    entry.status = 'pending'; entry.code = null; entry.retryAfterMs = null; entry.startedAt = now();
    armTimeout(entry);
    transmit(entry);
    changed('outbox');
    return promise;
  }

  function enqueue(kind, frame) {
    if (!configured) return Promise.reject(failure('unconfigured'));
    if (disposed) return Promise.reject(failure('canceled'));
    if (status === 'idle' || status === 'stopped') return Promise.reject(failure(status === 'stopped' && lastError ? lastError : 'unavailable'));
    if (outbox.size >= L.MAX_OUTBOX) return Promise.reject(failure('rate_limited'));
    const clientMessageId = String(newId()).toLowerCase();
    if (!UUID.test(clientMessageId) || outbox.has(clientMessageId)) return Promise.reject(failure('invalid'));
    const entry = { clientMessageId, kind, frame, status: 'pending', code: null, retryAfterMs: null, startedAt: 0, timer: null, settle: null };
    outbox.set(clientMessageId, entry);
    return track(entry);
  }

  function onAck(frame) {
    const entry = outbox.get(frame.client_message_id);
    if (!entry) return;
    clear(entry.timer);
    outbox.delete(frame.client_message_id);
    const result = { clientMessageId: entry.clientMessageId, messageId: frame.message_id, seq: frame.seq, duplicate: frame.duplicate };
    const settle = entry.settle; entry.settle = null;
    settle?.resolve(result);
    emit('ack', result);
    changed('outbox');
  }

  function onError(frame) {
    const code = codeOf(frame);
    const entry = frame.ref ? outbox.get(frame.ref) : null;
    if (entry && entry.status !== 'failed') failEntry(entry, code, frame.retry_after_ms);
    emit('error', { code, ref: frame.ref, retryAfterMs: frame.retry_after_ms });
  }

  function failAll(code, { remove = false } = {}) {
    for (const entry of [...outbox.values()]) {
      if (entry.status !== 'failed') failEntry(entry, code);
      if (remove) { clear(entry.timer); outbox.delete(entry.clientMessageId); }
    }
  }

  // ---- public API ----
  function connect() {
    if (disposed) return;
    if (!configured) { setStatus('unconfigured'); return; }
    if (socket || reconnectTimer !== null || status === 'connecting' || status === 'reconnecting') return;
    attempt = 0; authFailures = 0; gapRetries = 0; lastError = null;
    void open();
  }

  // Leave the lobby: close the socket, ignore anything still in flight, keep the
  // last page so the view does not flash empty; pending sends fail as canceled.
  function disconnect() {
    generation += 1; session += 1;
    clear(reconnectTimer); reconnectTimer = null;
    dropSocket(socket);
    failAll('canceled');
    if (configured) setStatus('idle');
  }

  // Sign-out: disconnect and forget everything (messages, cursor, outbox).
  function reset() {
    disconnect();
    try { api.abortAll?.(); } catch { /* best effort */ }
    failAll('canceled', { remove: true });
    clearState();
    channel = null; userId = null; lastEventSeq = 0; needsReload = true; lastError = null;
    presence.clear(); catStates.clear(); typingAt.clear();
    changed('reset');
  }

  async function loadOlder() {
    if (!channel || !hasMore || nextBeforeSeq === null) return { added: 0, hasMore };
    if (messages.length >= L.MAX_MESSAGES) return { added: 0, hasMore, capped: true };
    const mine = session, channelId = channel.id, before = nextBeforeSeq;
    const page = await api.history(channelId, { beforeSeq: before });
    if (mine !== session || !channel || channel.id !== channelId || nextBeforeSeq !== before) return { added: 0, hasMore, stale: true };
    const room = L.MAX_MESSAGES - messages.length;
    const known = new Set(messages.map(m => m.id));
    const older = page.messages.filter(m => !known.has(m.id) && m.seq < before).slice(-room);
    messages.unshift(...older);
    hasMore = page.has_more || older.length < page.messages.length;
    nextBeforeSeq = hasMore ? (page.next_before_seq ?? messages[0]?.seq ?? null) : null;
    changed('history');
    return { added: older.length, hasMore, capped: messages.length >= L.MAX_MESSAGES };
  }

  function typing({ kind = 'human', catId } = {}) {
    if (status !== 'online') return false;
    const frame = kind === 'cat' ? { type: 'typing', kind: 'cat', cat_id: uuidArg(catId) } : { type: 'typing', kind: 'human' };
    const key = kind === 'cat' ? frame.cat_id : 'human';
    if (now() - (typingAt.get(key) ?? -Infinity) < L.TYPING_THROTTLE_MS) return false;
    if (!send(socket, frame)) return false;
    typingAt.set(key, now());
    return true;
  }

  function setCatStatus(catId, state) {
    const id = uuidArg(catId);
    if (!CAT_STATES.has(state)) throw invalid();
    if (catStates.get(id) === state) return;
    catStates.set(id, state);
    if (socket?.hello) send(socket, { type: 'cat.status', cat_id: id, state });
  }

  function retry(clientMessageId) {
    const entry = outbox.get(String(clientMessageId).toLowerCase());
    if (!entry || entry.status !== 'failed') return Promise.reject(failure('invalid'));
    if (status === 'idle' || status === 'stopped' || !configured) return Promise.reject(failure(lastError || 'unavailable'));
    return track(entry);
  }

  function discard(clientMessageId) {
    const entry = outbox.get(String(clientMessageId).toLowerCase());
    if (!entry || entry.status !== 'failed') return false;
    outbox.delete(entry.clientMessageId);
    changed('outbox');
    return true;
  }

  const outboxView = entry => ({ clientMessageId: entry.clientMessageId, kind: entry.kind, status: entry.status, code: entry.code,
    error: entry.code ? SAFE_ERROR[entry.code] : null, retryAfterMs: entry.retryAfterMs, text: entry.frame.text,
    replyToId: entry.frame.reply_to_id ?? entry.frame.in_reply_to ?? null, origin: entry.frame.origin ?? 'cat',
    assistCatId: entry.frame.assist_cat_id ?? null, catId: entry.frame.cat_id ?? null });

  function snapshot() {
    return {
      status, error: lastError ? { code: lastError, message: SAFE_ERROR[lastError] } : null,
      userId, channel: channel ? { ...channel } : null,
      messages: messages.map(m => ({ ...m })), hasMore, nextBeforeSeq,
      members: members.map(m => ({ ...m, online: presence.has(m.kind === 'cat' ? presenceKey('c', m.cat_id) : presenceKey('u', m.user_id)) })),
      online: [...presence], lastEventSeq,
      outbox: [...outbox.values()].map(outboxView),
      stats: { ...stats },
    };
  }

  function dispose() {
    if (disposed) return;
    reset();
    disposed = true;
    if (!rest) try { api.dispose(); } catch { /* best effort */ }
  }

  return Object.freeze({
    get configured() { return configured; },
    get status() { return status; },
    get generation() { return generation; },
    rest: api,
    connect, disconnect, reset, dispose, snapshot, loadOlder, typing, setCatStatus, retry, discard,
    send: (input = {}) => { try { return enqueue('human', humanFrame(input)); } catch (error) { return Promise.reject(error); } },
    sendCat: (input = {}) => { try { return enqueue('cat', catFrame(input)); } catch (error) { return Promise.reject(error); } },
  });
}

module.exports = { createLobbyRest, createLobbyClient, SAFE_ERROR, API_PREFIX, REQUEST_TIMEOUT_MS, MAX_RESPONSE_BYTES, MAX_HISTORY_BYTES,
  HISTORY_PAGE_LIMIT, RESUME_PAGE_LIMIT, MUTE_MINUTES, WS_LIMITS, apiBase, serverError, socketUrl, humanFrame, catFrame };
