'use strict';
// Locks lobby-config.cjs: NEKO_WORKBENCH_CHAT_* resolution. Synthetic hosts and values only.
const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../../apps/neko-workbench/lobby-config.cjs');
const { OFFICIAL_AUTH_ORIGIN } = require('../../apps/neko-workbench/community-config.cjs');

const CHAT_ERROR = /频道服务地址/;
const AUTH_ERROR = /频道登录地址/;
const CHANNEL = '0f8e9d7c-6b5a-4c3d-8e2f-1a0b9c8d7e6f';

test('an unset or empty chat URL leaves the lobby unconfigured without reading the other variables', () => {
  assert.equal(C.resolveChatUrl(undefined), null);
  assert.equal(C.resolveChatUrl(''), null);
  assert.deepEqual(C.resolveChatConfig({}), { configured: false });
  assert.deepEqual(C.resolveChatConfig({ NEKO_WORKBENCH_CHAT_URL: '' }), { configured: false });
  // Invalid companions do not break the unconfigured state (the panel just says "unconfigured").
  assert.deepEqual(C.resolveChatConfig({ NEKO_WORKBENCH_CHAT_CLIENT_ID: 'bad', NEKO_WORKBENCH_CHAT_AUTH_URL: 'http://evil.test',
    NEKO_WORKBENCH_CHAT_OAUTH_PORTS: 'x' }), { configured: false });
  assert.ok(Object.isFrozen(C.resolveChatConfig({})));
});

test('chat URL requires https except on 127.0.0.1, localhost and [::1]', () => {
  assert.equal(C.resolveChatUrl('https://chat.example.test'), 'https://chat.example.test/');
  assert.equal(C.resolveChatUrl('https://chat.example.test:8443/api/'), 'https://chat.example.test:8443/api/');
  for (const value of ['http://127.0.0.1:8091', 'http://localhost:8091', 'http://[::1]:8091', 'https://127.0.0.1:8091']) {
    assert.equal(C.resolveChatUrl(value), new URL(value).href, value);
  }
  for (const value of ['http://chat.example.test', 'http://127.0.0.2:8091', 'http://0.0.0.0:8091', 'http://localhost.example.test',
    'http://[::ffff:127.0.0.1]:8091', 'http://10.0.0.1', 'ws://127.0.0.1:8091', 'wss://chat.example.test', 'ftp://chat.example.test',
    'file:///etc/passwd', 'javascript:alert(1)', 'chat.example.test', '/relative', 'https://', ' https://chat.example.test',
    'https://chat.example.test/\n', 'https://chat.example.test/a b', `https://chat.example.test/${'a'.repeat(4100)}`, 42, {}]) {
    assert.throws(() => C.resolveChatUrl(value), CHAT_ERROR, String(value).slice(0, 60));
  }
});

test('chat URL rejects userinfo and credential-like query or fragment keys, and never echoes the value', () => {
  const secretish = ['https://user:pw@chat.example.test', 'https://user@chat.example.test', 'http://u:p@127.0.0.1:8091',
    'https://chat.example.test/?token=s3cr3t-value', 'https://chat.example.test/?Access_Token=s3cr3t-value',
    'https://chat.example.test/?api-key=s3cr3t-value', 'https://chat.example.test/?password=s3cr3t-value',
    'https://chat.example.test/?SECRET=s3cr3t-value', 'https://chat.example.test/#authorization=s3cr3t-value',
    'https://chat.example.test/?ok=1&signature=s3cr3t-value', 'http://127.0.0.1:8091/?credentials=s3cr3t-value'];
  for (const value of secretish) {
    assert.throws(() => C.resolveChatUrl(value), error => CHAT_ERROR.test(error.message)
      && !error.message.includes('s3cr3t') && !error.message.includes('chat.example.test') && !error.message.includes('pw'), value);
  }
  assert.equal(C.resolveChatUrl('https://chat.example.test/?region=cn'), 'https://chat.example.test/?region=cn');
});

test('client_id defaults to neko-chat-desktop-prod and must match ^neko-chat-desktop-[a-z]+$', () => {
  assert.equal(C.DEFAULT_CHAT_CLIENT_ID, 'neko-chat-desktop-prod');
  assert.equal(C.resolveChatClientId(undefined), 'neko-chat-desktop-prod');
  assert.equal(C.resolveChatClientId(''), 'neko-chat-desktop-prod');
  assert.equal(C.resolveChatClientId('neko-chat-desktop-dev'), 'neko-chat-desktop-dev');
  assert.equal(C.resolveChatClientId('neko-chat-desktop-qa'), 'neko-chat-desktop-qa');
  for (const value of ['neko-chat-desktop-', 'neko-chat-desktop-Prod', 'neko-chat-desktop-dev2', 'neko-chat-desktop-dev-x',
    'neko-desktop-prod', 'neko-workbench', ' neko-chat-desktop-prod', 'neko-chat-desktop-prod\n', 'xneko-chat-desktop-prod', 7]) {
    assert.throws(() => C.resolveChatClientId(value), /频道登录客户端标识无效/, String(value));
  }
});

test('auth URL defaults to the official origin and is normalised to an origin', () => {
  assert.equal(C.resolveChatAuthUrl(undefined, 'https://chat.example.test/'), OFFICIAL_AUTH_ORIGIN);
  assert.equal(C.resolveChatAuthUrl('', 'https://chat.example.test/'), OFFICIAL_AUTH_ORIGIN);
  assert.equal(C.resolveChatAuthUrl('https://auth.example.test/', 'https://chat.example.test/'), 'https://auth.example.test');
  assert.equal(C.resolveChatAuthUrl('https://auth.example.test:9443', null), 'https://auth.example.test:9443');
  for (const value of ['https://auth.example.test/oauth2', 'https://auth.example.test/?x=1', 'https://auth.example.test/#f',
    'https://u:p@auth.example.test', 'ftp://auth.example.test', 'not a url']) {
    assert.throws(() => C.resolveChatAuthUrl(value, 'https://chat.example.test/'), AUTH_ERROR, value);
  }
});

test('auth URL may use loopback http only when the chat URL is loopback too', () => {
  for (const chat of ['http://127.0.0.1:8091/', 'http://localhost:8091/', 'http://[::1]:8091/', 'https://127.0.0.1:8091/']) {
    assert.equal(C.resolveChatAuthUrl('http://127.0.0.1:8094', chat), 'http://127.0.0.1:8094', chat);
    assert.equal(C.resolveChatAuthUrl('http://localhost:8094/', chat), 'http://localhost:8094', chat);
    assert.equal(C.resolveChatAuthUrl('http://[::1]:8094', chat), 'http://[::1]:8094', chat);
  }
  for (const chat of ['https://chat.example.test/', null, undefined, 'http://chat.example.test/', 'garbage']) {
    assert.throws(() => C.resolveChatAuthUrl('http://127.0.0.1:8094', chat), AUTH_ERROR, String(chat));
  }
  // Non-loopback http auth is refused even next to a loopback chat service.
  assert.throws(() => C.resolveChatAuthUrl('http://auth.example.test', 'http://127.0.0.1:8091/'), AUTH_ERROR);
  assert.throws(() => C.resolveChatAuthUrl('http://127.0.0.2:8094', 'http://127.0.0.1:8091/'), AUTH_ERROR);
});

test('OAuth callback ports are optional, comma separated, unprivileged and unique', () => {
  assert.equal(C.resolveChatOAuthPorts(undefined), null);
  assert.equal(C.resolveChatOAuthPorts(''), null);
  assert.deepEqual(C.resolveChatOAuthPorts('53682'), [53682]);
  assert.deepEqual(C.resolveChatOAuthPorts('53682, 53683,53684'), [53682, 53683, 53684]);
  assert.ok(Object.isFrozen(C.resolveChatOAuthPorts('53682')));
  for (const value of ['0', '80', '1023', '65536', '99999', '5368a', '53682,', ',53682', '53682,,53683', '53682;53683',
    '53682,53682', '-53682', '5e4', '0x1F90', '1,2,3,4,5,6,7,8,9'.split(',').map(n => String(50000 + Number(n))).join(','), 53682]) {
    assert.throws(() => C.resolveChatOAuthPorts(value), /频道登录回调端口/, String(value));
  }
});

test('the socket base is derived as wss for https and ws for loopback http, keeping a path prefix', () => {
  assert.equal(C.chatSocketBase('https://chat.example.test/'), 'wss://chat.example.test/ws');
  assert.equal(C.chatSocketBase('https://chat.example.test:8443/api/?region=cn#x'), 'wss://chat.example.test:8443/api/ws');
  assert.equal(C.chatSocketBase('http://127.0.0.1:8091/'), 'ws://127.0.0.1:8091/ws');
  assert.equal(C.chatSocketBase('http://[::1]:8091'), 'ws://[::1]:8091/ws');
  const config = C.resolveChatConfig({ NEKO_WORKBENCH_CHAT_URL: 'https://chat.example.test' });
  assert.equal(C.chatChannelSocketUrl(config, CHANNEL), `wss://chat.example.test/ws/channels/${CHANNEL}`);
  assert.equal(C.chatChannelSocketUrl(config, CHANNEL.toUpperCase()), `wss://chat.example.test/ws/channels/${CHANNEL}`);
  for (const id of ['', 'general', `${CHANNEL}/../x`, `${CHANNEL}?token=x`, null]) {
    assert.throws(() => C.chatChannelSocketUrl(config, id), /频道标识无效/, String(id));
  }
  assert.throws(() => C.chatChannelSocketUrl({ configured: false }, CHANNEL), /频道标识无效/);
});

test('resolveChatConfig combines every variable for production and the local QA fixture', () => {
  assert.deepEqual({ ...C.resolveChatConfig({ NEKO_WORKBENCH_CHAT_URL: 'https://chat.example.test' }) }, {
    configured: true, chatUrl: 'https://chat.example.test/', wsUrl: 'wss://chat.example.test/ws',
    authUrl: OFFICIAL_AUTH_ORIGIN, clientId: 'neko-chat-desktop-prod', oauthPorts: null });
  const qa = C.resolveChatConfig({ NEKO_WORKBENCH_CHAT_URL: 'http://127.0.0.1:8091', NEKO_WORKBENCH_CHAT_AUTH_URL: 'http://127.0.0.1:8094',
    NEKO_WORKBENCH_CHAT_CLIENT_ID: 'neko-chat-desktop-dev', NEKO_WORKBENCH_CHAT_OAUTH_PORTS: '53682,53683' });
  assert.deepEqual({ ...qa, oauthPorts: [...qa.oauthPorts] }, {
    configured: true, chatUrl: 'http://127.0.0.1:8091/', wsUrl: 'ws://127.0.0.1:8091/ws', authUrl: 'http://127.0.0.1:8094',
    clientId: 'neko-chat-desktop-dev', oauthPorts: [53682, 53683] });
  assert.ok(Object.isFrozen(qa));
  // A configured chat URL with an invalid companion fails with fixed text; the controller maps that to an error state.
  assert.throws(() => C.resolveChatConfig({ NEKO_WORKBENCH_CHAT_URL: 'https://chat.example.test',
    NEKO_WORKBENCH_CHAT_AUTH_URL: 'http://127.0.0.1:8094' }), AUTH_ERROR);
  assert.throws(() => C.resolveChatConfig({ NEKO_WORKBENCH_CHAT_URL: 'https://chat.example.test',
    NEKO_WORKBENCH_CHAT_CLIENT_ID: 'neko-chat-desktop-PROD' }), /客户端标识/);
  assert.throws(() => C.resolveChatConfig({ NEKO_WORKBENCH_CHAT_URL: 'http://chat.example.test' }), CHAT_ERROR);
});

test('resolveChatConfig reads process.env by default and nothing else', () => {
  const keys = ['NEKO_WORKBENCH_CHAT_URL', 'NEKO_WORKBENCH_CHAT_AUTH_URL', 'NEKO_WORKBENCH_CHAT_CLIENT_ID', 'NEKO_WORKBENCH_CHAT_OAUTH_PORTS'];
  const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  try {
    for (const key of keys) delete process.env[key];
    assert.deepEqual(C.resolveChatConfig(), { configured: false });
    process.env.NEKO_WORKBENCH_CHAT_URL = 'http://localhost:8091';
    assert.equal(C.resolveChatConfig().wsUrl, 'ws://localhost:8091/ws');
  } finally {
    for (const key of keys) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; }
  }
});
