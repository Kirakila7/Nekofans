'use strict';

// Inbound N.E.K.O.Chat frame validation (docs/protocol.md v1). Every server
// frame is checked against a per-type schema and rebuilt from known fields only;
// unknown types, malformed frames and frames over 64 KiB are dropped. Drop
// reasons are fixed codes. Nothing here logs or echoes frame content.

const MAX_FRAME_BYTES = 64 * 1024;
const MAX_TEXT_CHARS = 2000;
const MAX_LABEL_CHARS = 200;
const MAX_NAME_CHARS = 64;
const MAX_TOPIC_CHARS = 500;
const MAX_MENTIONS = 10;
const MAX_PRESENCE = 5000;
const MAX_CAT_DEPTH = 2;
const MAX_RETRY_AFTER_MS = 24 * 3600 * 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const AVATAR_KEY = /^[A-Za-z0-9_-]{1,64}$/;
const ERROR_CODE = /^[a-z][a-z0-9_]{0,63}$/;
const SLOW_MODES = new Set([0, 5, 10, 30, 60]);
const ORIGINS = new Set(['human', 'human_ai', 'cat']);
const ROLES = new Set(['member', 'admin']);
const REPLY_MODES = new Set(['mention', 'owner_or_mention', 'free']);
const MENTION_KINDS = new Set(['user', 'cat']);
const TYPING_KINDS = new Set(['human', 'cat']);
// Server-generated label prefixes (app/core/display.py message_label).
const ORIGIN_PREFIX = Object.freeze({ human_ai: '人＋AI 共同回复 · ', cat: 'AI 独立发言 · ' });

const INVALID = Symbol('invalid');
const fail = () => { throw INVALID; };
const isObject = value => !!value && typeof value === 'object' && !Array.isArray(value);
const obj = value => (isObject(value) ? value : fail());
const chars = value => { let n = 0; for (const _ of value) n += 1; return n; };
function str(value, max, min = 1) {
  if (typeof value !== 'string' || value.length > max * 2) fail();
  const n = chars(value);
  return n >= min && n <= max ? value : fail();
}
const optStr = (value, max, min = 1) => (value === undefined || value === null ? null : str(value, max, min));
const id = value => (typeof value === 'string' && UUID.test(value) ? value.toLowerCase() : fail());
const optId = value => (value === undefined || value === null ? null : id(value));
const int = (value, min, max = Number.MAX_SAFE_INTEGER) =>
  (Number.isSafeInteger(value) && value >= min && value <= max ? value : fail());
const optInt = (value, min, max) => (value === undefined || value === null ? null : int(value, min, max));
const bool = value => (typeof value === 'boolean' ? value : fail());
const oneOf = (value, set) => (set.has(value) ? value : fail());
const timestamp = value => int(value, 0);

function guard(validate) {
  return value => {
    try { return validate(value); } catch (error) { if (error === INVALID) return null; throw error; }
  };
}

function avatar(value) {
  obj(value);
  if (value.kind === 'image') {
    const url = str(value.url, 1024);
    if (!url.startsWith('https://')) fail();
    return { kind: 'image', url };
  }
  if (value.kind === 'hue') return { kind: 'hue', hue: int(value.hue, 0, 359), text: str(value.text, 4, 0) };
  return fail();
}
const optAvatar = value => (value === undefined || value === null ? null : avatar(value));

// Label must agree with origin for AI-involved messages; human labels are names.
function label(value, origin) {
  const text = str(value, MAX_LABEL_CHARS);
  const prefix = ORIGIN_PREFIX[origin];
  if (prefix && (!text.startsWith(prefix) || text.length === prefix.length)) fail();
  return text;
}

function humanAuthor(value, origin) {
  const author = {
    kind: 'human', user_id: id(value.user_id),
    name: optStr(value.name, MAX_NAME_CHARS), display_name: optStr(value.display_name, MAX_NAME_CHARS),
    avatar: optAvatar(value.avatar),
  };
  if (origin === 'human_ai') {
    const assist = obj(value.assist_cat);
    author.assist_cat = { cat_id: id(assist.cat_id), name: str(assist.name, MAX_NAME_CHARS) };
  } else if (value.assist_cat !== undefined && value.assist_cat !== null) fail();
  return author;
}

function catAuthor(value) {
  return {
    kind: 'cat', cat_id: optId(value.cat_id), owner_user_id: id(value.owner_user_id),
    owner_name: str(value.owner_name, MAX_NAME_CHARS), name: str(value.name, MAX_NAME_CHARS),
    display_name: str(value.display_name, MAX_NAME_CHARS * 2 + 1), avatar_key: str(value.avatar_key, 64),
  };
}

function mentions(value) {
  if (!Array.isArray(value) || value.length > MAX_MENTIONS) fail();
  return value.map(item => {
    obj(item);
    return { kind: oneOf(item.kind, MENTION_KINDS), id: id(item.id) };
  });
}

function replyTo(value) {
  if (value === undefined || value === null) return null;
  obj(value);
  const origin = oneOf(value.origin, ORIGINS);
  return { id: id(value.id), seq: int(value.seq, 1), origin, label: label(value.label, origin) };
}

function message(value) {
  obj(value);
  const origin = oneOf(value.origin, ORIGINS);
  const author = obj(value.author);
  if ((author.kind === 'cat') !== (origin === 'cat')) fail();
  const deleted = bool(value.deleted);
  const text = deleted ? (value.text === null || value.text === undefined ? null : fail()) : str(value.text, MAX_TEXT_CHARS);
  const depth = int(value.cat_depth, 0, MAX_CAT_DEPTH);
  if ((origin === 'cat') !== (depth > 0)) fail();
  return {
    id: id(value.id), seq: int(value.seq, 1), channel_id: id(value.channel_id), created_at: timestamp(value.created_at),
    deleted, text, origin, label: label(value.label, origin),
    author: origin === 'cat' ? catAuthor(author) : author.kind === 'human' ? humanAuthor(author, origin) : fail(),
    mentions: deleted ? [] : mentions(value.mentions ?? []),
    reply_to: replyTo(value.reply_to),
    cat_depth: depth,
  };
}

function channel(value) {
  obj(value);
  return {
    id: id(value.id), name: str(value.name, MAX_NAME_CHARS), topic: str(value.topic ?? '', MAX_TOPIC_CHARS, 0),
    slow_mode_seconds: oneOf(value.slow_mode_seconds, SLOW_MODES), cats_enabled: bool(value.cats_enabled),
    cat_free_mode_allowed: bool(value.cat_free_mode_allowed), last_seq: int(value.last_seq, 0),
  };
}

// Cat profile as sent in cat.updated and GET/PUT /me/cat. name, reply_mode and
// deleted are sent by the backend's cat_view but are optional in protocol.md.
function cat(value) {
  obj(value);
  return {
    id: id(value.id), owner_user_id: id(value.owner_user_id), owner_name: str(value.owner_name, MAX_NAME_CHARS),
    name: optStr(value.name, MAX_NAME_CHARS), display_name: str(value.display_name, MAX_NAME_CHARS * 2 + 1),
    avatar_key: typeof value.avatar_key === 'string' && AVATAR_KEY.test(value.avatar_key) ? value.avatar_key : fail(),
    reply_mode: value.reply_mode === undefined || value.reply_mode === null ? null : oneOf(value.reply_mode, REPLY_MODES),
    enabled: bool(value.enabled), admin_disabled: bool(value.admin_disabled),
    deleted: value.deleted === undefined ? false : bool(value.deleted),
  };
}
function presenceMember(value) {
  obj(value);
  const member = { user_id: optId(value.user_id), cat_id: optId(value.cat_id), online: bool(value.online) };
  if (!member.user_id && !member.cat_id) fail();
  return member;
}

function presenceSnapshot(value) {
  obj(value);
  const members = Array.isArray(value.members) ? value.members : fail();
  if (members.length > MAX_PRESENCE) fail();
  return members.map(presenceMember);
}

// member.updated changes: only keys that are present are returned, so a
// profile-only update ({display_name, avatar}) never reads as "unmuted".
// null for muted_until / banned_at means cleared.
const CHANGE_KEYS = Object.freeze({
  display_name: value => str(value, MAX_NAME_CHARS),
  avatar,
  role: value => oneOf(value, ROLES),
  muted_until: value => (value === null ? null : timestamp(value)),
  banned_at: value => (value === null ? null : timestamp(value)),
});
function stateChanges(value) {
  obj(value);
  const changes = {};
  for (const [key, check] of Object.entries(CHANGE_KEYS)) {
    if (value[key] !== undefined) changes[key] = check(value[key]);
  }
  return changes;
}

const KNOWN_TYPES = Object.freeze({
  hello: value => ({
    type: 'hello', user_id: id(value.user_id), token_expires_at: timestamp(value.token_expires_at),
    last_event_seq: int(value.last_event_seq, 0),
  }),
  ack: value => ({
    type: 'ack', client_message_id: id(value.client_message_id), message_id: id(value.message_id),
    seq: int(value.seq, 1), duplicate: bool(value.duplicate),
  }),
  error: value => ({
    type: 'error', ref: optId(value.ref), code: ERROR_CODE.test(value.code ?? '') ? value.code : fail(),
    retry_after_ms: optInt(value.retry_after_ms, 0, MAX_RETRY_AFTER_MS),
  }),
  'message.new': value => ({ type: 'message.new', event_seq: int(value.event_seq, 1), message: message(value.message) }),
  'message.deleted': value => ({
    type: 'message.deleted', event_seq: int(value.event_seq, 1), message_id: id(value.message_id),
    seq: int(value.seq, 1), deleted_by: id(value.deleted_by),
  }),
  'channel.updated': value => ({
    type: 'channel.updated', event_seq: int(value.event_seq, 1), channel: channel(value.channel),
  }),
  'member.updated': value => ({
    type: 'member.updated', event_seq: int(value.event_seq, 1), user_id: id(value.user_id),
    changes: stateChanges(value.changes),
  }),
  'cat.updated': value => ({ type: 'cat.updated', event_seq: int(value.event_seq, 1), cat: cat(value.cat) }),
  'presence.snapshot': value => ({ type: 'presence.snapshot', members: presenceSnapshot(value) }),
  'presence.join': value => ({ type: 'presence.join', user_id: id(value.user_id), cat_id: optId(value.cat_id) }),
  'presence.leave': value => ({ type: 'presence.leave', user_id: id(value.user_id), cat_id: optId(value.cat_id) }),
  typing: value => ({
    type: 'typing', user_id: id(value.user_id),
    kind: oneOf(value.kind, TYPING_KINDS),
    cat_id: value.kind === 'cat' ? id(value.cat_id) : (value.cat_id === undefined || value.cat_id === null ? null : fail()),
  }),
  'resync.required': () => ({ type: 'resync.required' }),
  pong: value => ({ type: 'pong', t: timestamp(value.t), last_event_seq: int(value.last_event_seq, 0) }),
});

// validateFrame(value): rebuilt frame | 'unknown' | 'oversized' | 'invalid'.
// 'unknown' = type not in the protocol (skip it); 'oversized' / 'invalid' =
// drop it. Only fixed codes come back; nothing from the frame is echoed.
function validateFrame(value) {
  if (!isObject(value)) return 'invalid';
  let serialized;
  try { serialized = JSON.stringify(value); } catch { return 'invalid'; }
  if (Buffer.byteLength(serialized, 'utf8') > MAX_FRAME_BYTES) return 'oversized';
  const validate = typeof value.type === 'string' && Object.hasOwn(KNOWN_TYPES, value.type) ? KNOWN_TYPES[value.type] : null;
  if (typeof value.type !== 'string') return 'invalid';
  if (!validate) return 'unknown';
  try { return validate(value); } catch (error) { if (error === INVALID) return 'invalid'; throw error; }
}

// parseFrame(data): raw WebSocket data (string, Buffer, ArrayBuffer or typed
// array). The size cap is checked on the raw bytes before JSON.parse.
function parseFrame(data) {
  let bytes;
  if (typeof data === 'string') bytes = Buffer.byteLength(data, 'utf8');
  else if (Buffer.isBuffer(data) || ArrayBuffer.isView(data)) bytes = data.byteLength;
  else if (data instanceof ArrayBuffer) bytes = data.byteLength;
  else return 'invalid';
  if (bytes > MAX_FRAME_BYTES) return 'oversized';
  const text = typeof data === 'string' ? data
    : Buffer.from(data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength)).toString('utf8');
  let value;
  try { value = JSON.parse(text); } catch { return 'invalid'; }
  return validateFrame(value);
}

const KNOWN_FRAME_TYPES = Object.freeze(Object.keys(KNOWN_TYPES));

module.exports = { MAX_FRAME_BYTES, MAX_TEXT_CHARS, MAX_LABEL_CHARS, MAX_NAME_CHARS, MAX_TOPIC_CHARS,
  MAX_MENTIONS, MAX_PRESENCE, MAX_CAT_DEPTH, MAX_RETRY_AFTER_MS, SLOW_MODES, ORIGINS, ROLES, REPLY_MODES,
  ORIGIN_PREFIX, KNOWN_FRAME_TYPES, validateFrame, parseFrame, guard, avatar, label, humanAuthor, catAuthor, mentions, replyTo, message,
  channel, cat, presenceSnapshot, stateChanges };

