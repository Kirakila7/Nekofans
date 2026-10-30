'use strict';
// Locks lobby-avatars.cjs: main-process avatar fetch, whitelist, bounds, magic
// bytes, LRU, dedupe and the Verse-identical hashHue. Fake fetch, synthetic hosts.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const A = require('../../apps/neko-workbench/lobby-avatars.cjs');

const COMMUNITY = 'https://community.example.test/feed';
const UUID = '3c9d1c2e-7a54-4f0b-9e7d-1b2c3d4e5f60';
const COMMUNITY_AVATAR = `https://community.example.test/static/avatars/${UUID}.png`;
const STEAM_AVATAR = 'https://avatars.steamstatic.com/abc_full.jpg';
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('synthetic-png')]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('synthetic-jpeg')]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([1, 0, 0, 0]), Buffer.from('WEBPVP8 synthetic')]);
const GIF = Buffer.from('GIF89a-synthetic');
const SEED = '8f14e45f-ceea-467a-9575-2a1ed6c0a1b2';

// Captured by running N.E.K.O.Verse web/src/config.js hashHue in node 24; the
// same samples are pinned in N.E.K.O.Chat tests/test_display.py.
const VERSE_HASH_HUE = {
  '': 203, a: 315, 0: 145, '张三': 61, '大肥鱼': 187, '喵友-1a2b': 1, 'user@example.com': 52,
  '8f14e45f-ceea-467a-9575-2a1ed6c0a1b2': 338, '00000000-0000-0000-0000-000000000000': 104,
  '3c9d1c2e-7a54-4f0b-9e7d-1b2c3d4e5f60': 99, 'auth-user-123': 81, '🐱cat': 94, 'a\u{1F600}b': 263,
};

function fakeFetch(routes) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    const route = routes[url];
    if (!route) throw new TypeError('fetch failed');
    return typeof route === 'function' ? route(init) : new Response(route, { status: 200, headers: { 'content-type': 'image/png' } });
  };
  impl.calls = calls;
  return impl;
}

const flush = () => new Promise(resolve => setImmediate(resolve));
const dataUrl = (type, bytes) => `data:${type};base64,${bytes.toString('base64')}`;
const hueFor = (seed, name) => ({ kind: 'hue', hue: A.hashHue(seed), text: [...name][0] || '' });

test('hashHue is identical to N.E.K.O.Verse web/src/config.js on fixed samples', () => {
  for (const [input, hue] of Object.entries(VERSE_HASH_HUE)) assert.equal(A.hashHue(input), hue, JSON.stringify(input));
  assert.equal(A.hashHue(null), A.hashHue(''));
  assert.equal(A.hashHue(undefined), A.hashHue(''));
});

test('hashHue matches the live Verse source when the Verse checkout is present', async t => {
  const config = path.resolve(__dirname, '../../../N.E.K.O.Verse/web/src/config.js');
  if (!fs.existsSync(config)) { t.skip('N.E.K.O.Verse checkout not found next to neko-workbench'); return; }
  const verse = await import(pathToFileURL(config).href);
  for (const input of Object.keys(VERSE_HASH_HUE)) assert.equal(A.hashHue(input), verse.hashHue(input), JSON.stringify(input));
});

test('allowedAvatarUrl accepts only https community avatar paths and Steam CDN hosts', () => {
  const origin = 'https://community.example.test';
  for (const url of [COMMUNITY_AVATAR, `https://community.example.test:443/static/avatars/${UUID}.webp`, STEAM_AVATAR,
    'https://shared.cloudflare.steamstatic.com/a.gif', 'https://steamcdn-a.akamaihd.net/steamcommunity/public/a.jpg',
    'https://AVATARS.STEAMSTATIC.COM/a.png']) {
    assert.ok(A.allowedAvatarUrl(url, origin), url);
  }
  for (const url of [
    `http://community.example.test/static/avatars/${UUID}.png`, // plain http
    'https://community.example.test/static/avatars/not-a-uuid.png', // community path rule
    `https://community.example.test/uploads/${UUID}.png`,
    `https://community.example.test/static/avatars/${UUID}.png?x=1`,
    `https://community.example.test:8443/static/avatars/${UUID}.png`, // other port
    `https://evil.example.test/static/avatars/${UUID}.png`, // other host
    `https://community.example.test.evil.test/static/avatars/${UUID}.png`,
    'https://steamstatic.com.evil.test/a.png', 'https://evilsteamstatic.com/a.png', 'https://.steamstatic.com/a.png',
    'https://avatars.steamstatic.com/a.svg', 'https://avatars.steamstatic.com/a.SVG',
    'https://avatars.steamstatic.com/a.png#frag', 'https://user:pw@avatars.steamstatic.com/a.png',
    'https://avatars.steamstatic.com:8443/a.png', 'data:image/png;base64,AAAA', 'file:///etc/passwd', 'hue:120',
    'https://avatars.steamstatic.com/a b.png', `https://avatars.steamstatic.com/${'a'.repeat(1100)}.png`, '', null, 5, {},
  ]) {
    assert.equal(A.allowedAvatarUrl(url, origin), null, String(url).slice(0, 80));
  }
  assert.equal(A.allowedAvatarUrl(COMMUNITY_AVATAR, null), null, 'no community origin means only Steam is allowed');
});

test('a whitelisted image is fetched without redirects, credentials or referrer and returned as a data: URL', async () => {
  const fetchImpl = fakeFetch({ [COMMUNITY_AVATAR]: PNG });
  const avatars = A.createLobbyAvatars({ communityUrl: COMMUNITY, fetchImpl });
  assert.equal(avatars.communityOrigin, 'https://community.example.test');
  const result = await avatars.resolve({ kind: 'image', url: COMMUNITY_AVATAR }, { seed: SEED, name: '张三' });
  assert.deepEqual(result, { kind: 'image', url: dataUrl('image/png', PNG) });
  assert.ok(Object.isFrozen(result));
  assert.equal(fetchImpl.calls.length, 1);
  const { init } = fetchImpl.calls[0];
  assert.equal(init.redirect, 'error');
  assert.equal(init.credentials, 'omit');
  assert.equal(init.referrerPolicy, 'no-referrer');
  assert.ok(init.signal instanceof AbortSignal);
  assert.equal(init.headers.Authorization, undefined);
});

test('png, jpeg, webp and gif magic bytes map to their data: MIME type', async () => {
  const urls = ['a.png', 'b.jpg', 'c.webp', 'd.gif'].map(name => `https://avatars.steamstatic.com/${name}`);
  const fetchImpl = fakeFetch({ [urls[0]]: PNG, [urls[1]]: JPEG, [urls[2]]: WEBP, [urls[3]]: GIF });
  const avatars = A.createLobbyAvatars({ communityUrl: COMMUNITY, fetchImpl });
  const expected = [['image/png', PNG], ['image/jpeg', JPEG], ['image/webp', WEBP], ['image/gif', GIF]];
  for (const [index, url] of urls.entries()) {
    const result = await avatars.resolve({ kind: 'image', url }, { seed: SEED, name: 'x' });
    assert.equal(result.url, dataUrl(...expected[index]), url);
    assert.ok(A.isSnapshotAvatar(result));
  }
});

test('non-whitelisted, http, svg and malformed avatars fall back to hue without any fetch', async () => {
  const fetchImpl = fakeFetch({});
  const avatars = A.createLobbyAvatars({ communityUrl: COMMUNITY, fetchImpl });
  for (const avatar of [
    { kind: 'image', url: `https://evil.example.test/static/avatars/${UUID}.png` },
    { kind: 'image', url: `http://community.example.test/static/avatars/${UUID}.png` },
    { kind: 'image', url: 'https://avatars.steamstatic.com/a.svg' },
    { kind: 'image', url: 'javascript:alert(1)' }, { kind: 'image' }, { kind: 'other', url: STEAM_AVATAR }, null, undefined, 'x',
  ]) {
    assert.deepEqual(avatars.get(avatar, { seed: SEED, name: '张三' }), hueFor(SEED, '张三'));
    assert.deepEqual(await avatars.resolve(avatar, { seed: SEED, name: '张三' }), hueFor(SEED, '张三'));
  }
  assert.equal(fetchImpl.calls.length, 0);
});

test('a server hue avatar is kept as is; its text is reduced to one visible character', async () => {
  const avatars = A.createLobbyAvatars({ communityUrl: COMMUNITY, fetchImpl: fakeFetch({}) });
  assert.deepEqual(avatars.get({ kind: 'hue', hue: 210, text: '张' }, { seed: SEED, name: '李四' }), { kind: 'hue', hue: 210, text: '张' });
  assert.deepEqual(avatars.get({ kind: 'hue', hue: 210, text: '‮张三' }, { seed: SEED }), { kind: 'hue', hue: 210, text: '张' });
  assert.deepEqual(avatars.get({ kind: 'hue', hue: 210 }, { seed: SEED, name: '\u{1F431}猫' }), { kind: 'hue', hue: 210, text: '\u{1F431}' });
  for (const hue of [-1, 360, 1.5, '210', null]) {
    assert.deepEqual(avatars.get({ kind: 'hue', hue, text: '张' }, { seed: SEED, name: '张三' }), hueFor(SEED, '张三'), String(hue));
  }
});

test('redirects, error statuses, timeouts, oversized bodies and wrong magic bytes all fall back to hue', async () => {
  const base = 'https://avatars.steamstatic.com/';
  const stream = (size, chunk = 32 * 1024) => new ReadableStream({
    start(controller) { for (let sent = 0; sent < size; sent += chunk) controller.enqueue(new Uint8Array(Math.min(chunk, size - sent)).fill(0x89)); controller.close(); },
  });
  const routes = {
    [`${base}redirect.png`]: init => { if (init.redirect === 'error') throw new TypeError('fetch failed: redirect'); return new Response(PNG); },
    [`${base}status302.png`]: () => new Response(null, { status: 302, headers: { location: 'https://evil.example.test/' } }),
    [`${base}redirected.png`]: () => ({ ok: true, status: 200, redirected: true, headers: new Headers(), body: new Response(PNG).body }),
    [`${base}notfound.png`]: () => new Response(PNG, { status: 404 }),
    [`${base}timeout.png`]: init => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason))),
    [`${base}declared.png`]: () => new Response(PNG, { headers: { 'content-length': String(A.MAX_AVATAR_BYTES + 1) } }),
    [`${base}streamed.png`]: () => new Response(stream(A.MAX_AVATAR_BYTES + 1)),
    [`${base}svg.png`]: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'),
    [`${base}html.png`]: Buffer.from('<!doctype html><title>x</title>'),
    [`${base}short.png`]: Buffer.from([0x89, 0x50]),
    [`${base}empty.png`]: () => new Response(null, { status: 200 }),
    [`${base}riff.png`]: Buffer.from('RIFF\u0001\u0000\u0000\u0000WAVEfmt '),
  };
  const fetchImpl = fakeFetch(routes);
  const avatars = A.createLobbyAvatars({ communityUrl: COMMUNITY, fetchImpl, timeoutMs: 50 });
  for (const url of Object.keys(routes)) {
    assert.deepEqual(await avatars.resolve({ kind: 'image', url }, { seed: SEED, name: '张三' }), hueFor(SEED, '张三'), url);
  }
  assert.ok(fetchImpl.calls.every(call => call.init.redirect === 'error'));
  const exact = `${base}exact.png`;
  routes[exact] = Buffer.concat([PNG, Buffer.alloc(A.MAX_AVATAR_BYTES - PNG.length)]);
  assert.equal((await avatars.resolve({ kind: 'image', url: exact }, { seed: SEED, name: 'x' })).kind, 'image', 'exactly 256 KB is accepted');
});

test('concurrent requests for one URL share a single download', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const fetchImpl = fakeFetch({ [STEAM_AVATAR]: async () => { await gate; return new Response(JPEG); } });
  const avatars = A.createLobbyAvatars({ communityUrl: COMMUNITY, fetchImpl });
  const avatar = { kind: 'image', url: STEAM_AVATAR };
  const waits = Array.from({ length: 5 }, () => avatars.resolve(avatar, { seed: SEED, name: 'a' }));
  assert.deepEqual(avatars.get(avatar, { seed: SEED, name: 'a' }), hueFor(SEED, 'a'));
  release();
  const results = await Promise.all(waits);
  assert.equal(fetchImpl.calls.length, 1);
  for (const result of results) assert.equal(result.url, dataUrl('image/jpeg', JPEG));
  assert.equal((await avatars.resolve(avatar, { seed: SEED, name: 'a' })).kind, 'image');
  assert.equal(fetchImpl.calls.length, 1, 'cache hit does not refetch');
});

test('get() returns hue first, fetches in the background and calls onChange once the image is cached', async () => {
  let changes = 0;
  const fetchImpl = fakeFetch({ [STEAM_AVATAR]: PNG });
  const avatars = A.createLobbyAvatars({ communityUrl: COMMUNITY, fetchImpl, onChange: () => { changes += 1; } });
  const avatar = { kind: 'image', url: STEAM_AVATAR };
  assert.deepEqual(avatars.get(avatar, { seed: SEED, name: 'b' }), hueFor(SEED, 'b'));
  avatars.get(avatar, { seed: SEED, name: 'b' });
  for (let i = 0; i < 5 && changes === 0; i++) await flush();
  assert.equal(changes, 1);
  assert.equal(fetchImpl.calls.length, 1);
  assert.equal(avatars.get(avatar, { seed: SEED, name: 'b' }).url, dataUrl('image/png', PNG));
});

test('the cache keeps the 200 most recently used images and evicts the oldest', async () => {
  const urls = Array.from({ length: A.CACHE_SIZE + 1 }, (_, i) => `https://avatars.steamstatic.com/u${i}.png`);
  const fetchImpl = fakeFetch(Object.fromEntries(urls.map(url => [url, PNG])));
  const avatars = A.createLobbyAvatars({ communityUrl: COMMUNITY, fetchImpl });
  for (const url of urls.slice(0, A.CACHE_SIZE)) await avatars.resolve({ kind: 'image', url }, { seed: SEED, name: 'x' });
  assert.equal(avatars.size(), A.CACHE_SIZE);
  await avatars.resolve({ kind: 'image', url: urls[0] }, { seed: SEED, name: 'x' }); // touch u0
  await avatars.resolve({ kind: 'image', url: urls[A.CACHE_SIZE] }, { seed: SEED, name: 'x' }); // evicts u1
  assert.equal(avatars.size(), A.CACHE_SIZE);
  assert.equal(fetchImpl.calls.length, A.CACHE_SIZE + 1);
  await avatars.resolve({ kind: 'image', url: urls[0] }, { seed: SEED, name: 'x' });
  assert.equal(fetchImpl.calls.length, A.CACHE_SIZE + 1, 'u0 survived because it was used recently');
  await avatars.resolve({ kind: 'image', url: urls[1] }, { seed: SEED, name: 'x' });
  assert.equal(fetchImpl.calls.length, A.CACHE_SIZE + 2, 'u1 was evicted and is downloaded again');
});

test('a failed download is not retried until the retry interval passes', async () => {
  let clock = 1_000_000, ok = false;
  const fetchImpl = fakeFetch({ [STEAM_AVATAR]: () => (ok ? new Response(PNG) : new Response(null, { status: 503 })) });
  const avatars = A.createLobbyAvatars({ communityUrl: COMMUNITY, fetchImpl, now: () => clock });
  const avatar = { kind: 'image', url: STEAM_AVATAR };
  assert.equal((await avatars.resolve(avatar, { seed: SEED, name: 'x' })).kind, 'hue');
  ok = true;
  assert.equal((await avatars.resolve(avatar, { seed: SEED, name: 'x' })).kind, 'hue');
  avatars.get(avatar, { seed: SEED, name: 'x' });
  assert.equal(fetchImpl.calls.length, 1);
  clock += A.FAILURE_RETRY_MS;
  assert.equal((await avatars.resolve(avatar, { seed: SEED, name: 'x' })).kind, 'image');
  assert.equal(fetchImpl.calls.length, 2);
});

test('clear() drops cached images and ignores downloads that finish afterwards', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let changes = 0;
  const fetchImpl = fakeFetch({ [STEAM_AVATAR]: async () => { await gate; return new Response(PNG); } });
  const avatars = A.createLobbyAvatars({ communityUrl: COMMUNITY, fetchImpl, onChange: () => { changes += 1; } });
  const avatar = { kind: 'image', url: STEAM_AVATAR };
  avatars.get(avatar, { seed: SEED, name: 'x' });
  avatars.clear();
  release();
  for (let i = 0; i < 5; i++) await flush();
  assert.equal(changes, 0);
  assert.equal(avatars.size(), 0);
});

test('every avatar handed to the renderer is a data: image or a hue; no external URL ever leaves the module', async () => {
  const fetchImpl = fakeFetch({ [COMMUNITY_AVATAR]: PNG, [STEAM_AVATAR]: Buffer.from('not an image') });
  const logged = [];
  const originals = {};
  for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
    originals[level] = console[level];
    console[level] = (...args) => { logged.push(args.join(' ')); };
  }
  try {
    const avatars = A.createLobbyAvatars({ communityUrl: COMMUNITY, fetchImpl, onChange: () => { throw new Error('listener'); } });
    const inputs = [
      { kind: 'image', url: COMMUNITY_AVATAR }, { kind: 'image', url: STEAM_AVATAR },
      { kind: 'image', url: 'https://evil.example.test/a.png' }, { kind: 'hue', hue: 12, text: 'Z' }, null,
    ];
    const outputs = [];
    for (const avatar of inputs) outputs.push(avatars.get(avatar, { seed: SEED, name: 'n' }));
    for (let i = 0; i < 5; i++) await flush();
    for (const avatar of inputs) {
      outputs.push(avatars.get(avatar, { seed: SEED, name: 'n' }));
      outputs.push(await avatars.resolve(avatar, { seed: SEED, name: 'n' }));
    }
    const snapshot = JSON.stringify(outputs);
    assert.doesNotMatch(snapshot, /https?:|example\.test|steamstatic/);
    assert.ok(outputs.every(A.isSnapshotAvatar));
    assert.ok(outputs.some(avatar => avatar.kind === 'image'));
  } finally {
    Object.assign(console, originals);
  }
  assert.deepEqual(logged, [], 'nothing is logged');
});

test('isSnapshotAvatar rejects external URLs and malformed shapes', () => {
  assert.ok(A.isSnapshotAvatar({ kind: 'image', url: dataUrl('image/png', PNG) }));
  assert.ok(A.isSnapshotAvatar({ kind: 'hue', hue: 0, text: '' }));
  for (const value of [{ kind: 'image', url: STEAM_AVATAR }, { kind: 'image', url: 'data:image/svg+xml;base64,PHN2Zz4=' },
    { kind: 'image', url: 'data:text/html;base64,PGI+' }, { kind: 'hue', hue: 360, text: 'a' }, { kind: 'hue', hue: 1 }, null, 'x']) {
    assert.equal(A.isSnapshotAvatar(value), false, JSON.stringify(value));
  }
});

test('createLobbyAvatars requires a fetch implementation and ignores a non-https community URL', () => {
  assert.throws(() => A.createLobbyAvatars({ fetchImpl: null }), /头像下载不可用/);
  const avatars = A.createLobbyAvatars({ communityUrl: 'http://community.example.test/', fetchImpl: fakeFetch({}) });
  assert.equal(avatars.communityOrigin, null);
  assert.equal(A.createLobbyAvatars({ fetchImpl: fakeFetch({}) }).communityOrigin, 'https://community.project-neko.cn');
});
