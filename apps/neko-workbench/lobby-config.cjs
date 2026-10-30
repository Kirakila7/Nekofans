'use strict';

// Lobby (N.E.K.O.Chat) endpoint configuration. Values come only from the
// environment; there is no production default for the chat service yet, so an
// unset NEKO_WORKBENCH_CHAT_URL means the lobby panel shows "unconfigured".
// Error text never echoes the configured value.
const { OFFICIAL_AUTH_ORIGIN } = require('./community-config.cjs');

const DEFAULT_CHAT_CLIENT_ID = 'neko-chat-desktop-prod';
const CHAT_CLIENT_ID_PATTERN = /^neko-chat-desktop-[a-z]+$/;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);
const MAX_OAUTH_PORTS = 8;
// Must match CHAT_DESKTOP_REDIRECT_URIS registered in neko-auth-platform: Hydra
// compares redirect URIs exactly, so an OS-chosen port would be rejected.
const DEFAULT_CHAT_OAUTH_PORTS = Object.freeze([48921, 48922, 48923]);
const CREDENTIAL_KEY = /^(?:token|access[-_]?token|api[-_]?key|authorization|password|passwd|secret|credentials?|signature)$/i;

const CHAT_URL_ERROR = '频道服务地址必须是不含账号凭据的 HTTPS 地址（仅本机地址可用 HTTP）';
const AUTH_URL_ERROR = '频道登录地址必须是 HTTPS 源地址（仅频道服务也在本机时可用本机 HTTP）';
const CLIENT_ID_ERROR = '频道登录客户端标识无效';
const OAUTH_PORTS_ERROR = '频道登录回调端口必须是以逗号分隔的 1024-65535 端口';

// Same shape as community-config.cjs parseWebUrl: printable, absolute
// http(s), a host and no userinfo.
function parseWebUrl(value) {
  if (typeof value !== 'string' || value.length > 4096 || /[\u0000-\u0020\u007f]/.test(value)) return null;
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password) return null;
    return url;
  } catch { return null; }
}

function isLoopbackUrl(url) {
  return !!url && LOOPBACK_HOSTS.has(url.hostname);
}

function hasCredentialParameter(url) {
  for (const fields of [url.searchParams, new URLSearchParams(url.hash.slice(1))]) {
    for (const key of fields.keys()) if (CREDENTIAL_KEY.test(key)) return true;
  }
  return false;
}

// Returns null when unset. https everywhere; http only on loopback hosts.
function resolveChatUrl(value = process.env.NEKO_WORKBENCH_CHAT_URL) {
  if (value == null || value === '') return null;
  const url = parseWebUrl(value);
  if (!url || (url.protocol !== 'https:' && !isLoopbackUrl(url)) || hasCredentialParameter(url)) throw new Error(CHAT_URL_ERROR);
  return url.href;
}

function resolveChatClientId(value = process.env.NEKO_WORKBENCH_CHAT_CLIENT_ID) {
  const raw = value == null || value === '' ? DEFAULT_CHAT_CLIENT_ID : value;
  if (typeof raw !== 'string' || !CHAT_CLIENT_ID_PATTERN.test(raw)) throw new Error(CLIENT_ID_ERROR);
  return raw;
}

// The auth server is an origin (lobby-auth appends /oauth2/... itself). Plain
// http is accepted only for a loopback auth server paired with a loopback chat
// service, i.e. the local dev-auth fixture.
function resolveChatAuthUrl(value = process.env.NEKO_WORKBENCH_CHAT_AUTH_URL, chatUrl = null) {
  const raw = value == null || value === '' ? OFFICIAL_AUTH_ORIGIN : value;
  const url = parseWebUrl(raw);
  if (!url || url.pathname !== '/' || url.search || url.hash) throw new Error(AUTH_URL_ERROR);
  if (url.protocol !== 'https:') {
    const chat = typeof chatUrl === 'string' ? parseWebUrl(chatUrl) : null;
    if (!isLoopbackUrl(url) || !isLoopbackUrl(chat)) throw new Error(AUTH_URL_ERROR);
  }
  return url.origin;
}

// Fixed loopback callback ports, tried in order. Unset uses the ports the
// official auth platform registers; the override is for other deployments.
function resolveChatOAuthPorts(value = process.env.NEKO_WORKBENCH_CHAT_OAUTH_PORTS) {
  if (value == null || value === '') return DEFAULT_CHAT_OAUTH_PORTS;
  if (typeof value !== 'string') throw new Error(OAUTH_PORTS_ERROR);
  const parts = value.split(',').map(part => part.trim());
  if (parts.length > MAX_OAUTH_PORTS) throw new Error(OAUTH_PORTS_ERROR);
  const ports = [];
  for (const part of parts) {
    if (!/^[0-9]{4,5}$/.test(part)) throw new Error(OAUTH_PORTS_ERROR);
    const port = Number(part);
    if (port < 1024 || port > 65535 || ports.includes(port)) throw new Error(OAUTH_PORTS_ERROR);
    ports.push(port);
  }
  return Object.freeze(ports);
}

// WebSocket base for `ws[s]://<host>/ws/channels/<channel_id>` (protocol.md).
// Keeps any path prefix of the chat URL, drops query and fragment.
function chatSocketBase(chatUrl) {
  const url = new URL(chatUrl);
  const prefix = url.pathname.replace(/\/+$/, '');
  return `${url.protocol === 'https:' ? 'wss:' : 'ws:'}//${url.host}${prefix}/ws`;
}

function chatChannelSocketUrl(config, channelId) {
  if (!config?.configured || typeof channelId !== 'string'
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(channelId)) throw new Error('频道标识无效');
  return `${config.wsUrl}/channels/${channelId.toLowerCase()}`;
}

// Throws (with fixed text) on an invalid configuration; the lobby controller
// catches it so the private companion chat is never affected.
function resolveChatConfig(env = process.env) {
  const chatUrl = resolveChatUrl(env.NEKO_WORKBENCH_CHAT_URL);
  if (!chatUrl) return Object.freeze({ configured: false });
  return Object.freeze({
    configured: true,
    chatUrl,
    wsUrl: chatSocketBase(chatUrl),
    authUrl: resolveChatAuthUrl(env.NEKO_WORKBENCH_CHAT_AUTH_URL, chatUrl),
    clientId: resolveChatClientId(env.NEKO_WORKBENCH_CHAT_CLIENT_ID),
    oauthPorts: resolveChatOAuthPorts(env.NEKO_WORKBENCH_CHAT_OAUTH_PORTS),
  });
}

module.exports = { OFFICIAL_AUTH_ORIGIN, DEFAULT_CHAT_CLIENT_ID, CHAT_CLIENT_ID_PATTERN, LOOPBACK_HOSTS,
  resolveChatUrl, resolveChatClientId, resolveChatAuthUrl, resolveChatOAuthPorts,
  chatSocketBase, chatChannelSocketUrl, resolveChatConfig };
