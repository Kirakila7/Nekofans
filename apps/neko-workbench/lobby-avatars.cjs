'use strict';

// Lobby member avatars, fetched in the main process so the renderer never
// loads an external image URL. Only https URLs on the community origin
// (/static/avatars/<uuid>.<ext>, the same path rule as Verse
// profile_directory._public_avatar_url and N.E.K.O.Chat display.py) or a Steam
// CDN host are fetched. Responses are bounded (5 s, 256 KB), never follow
// redirects, must start with PNG/JPEG/WebP/GIF magic bytes and are handed out
// as data: URLs. Anything else falls back to a hue + first-character avatar.
// Errors are swallowed; URLs never appear in logs or error text.
const { DEFAULT_COMMUNITY_URL } = require('./community-config.cjs');

const CACHE_SIZE = 200;
const MAX_AVATAR_BYTES = 256 * 1024;
const FETCH_TIMEOUT_MS = 5000;
const FAILURE_RETRY_MS = 10 * 60 * 1000;
const MAX_URL_LENGTH = 1024;
const STEAM_HOSTS = new Set(['steamcdn-a.akamaihd.net']);
const STEAM_SUFFIX = '.steamstatic.com';
const COMMUNITY_AVATAR_PATH = /^\/static\/avatars\/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(?:png|jpg|webp|gif)$/;

// Copied from N.E.K.O.Verse web/src/config.js hashHue (FNV-1a + murmur3
// fmix32 over UTF-16 code units). Keep identical; the test pins fixed samples.
function hashHue(s) {
  let h = 2166136261 >>> 0; s = String(s == null ? '' : s);
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  h ^= h >>> 16; h = Math.imul(h, 2246822507); h ^= h >>> 13; h = Math.imul(h, 3266489909); h ^= h >>> 16;
  return (h >>> 0) % 360;
}

// First code point of the display name, like N.E.K.O.Chat `name[:1]`.
// Control and format characters (bidi overrides) are skipped.
function firstChar(name) {
  if (typeof name !== 'string') return '';
  for (const char of name) if (!/[\p{Cc}\p{Cf}\p{Cs}\p{Z}]/u.test(char)) return char;
  return '';
}

function hueAvatar(seed, name) {
  return Object.freeze({ kind: 'hue', hue: hashHue(seed), text: firstChar(name) });
}

function detectImageType(bytes) {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes.toString('latin1', 1, 4) === 'PNG'
      && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 12 && bytes.toString('latin1', 0, 4) === 'RIFF' && bytes.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  if (bytes.length >= 6 && /^GIF8[79]a$/.test(bytes.toString('latin1', 0, 6))) return 'image/gif';
  return null;
}

function communityOriginOf(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password ? url.origin : null;
  } catch { return null; }
}

// Returns the normalized href when the URL may be fetched, otherwise null.
function allowedAvatarUrl(value, communityOrigin) {
  if (typeof value !== 'string' || !value || value.length > MAX_URL_LENGTH || /[\u0000-\u0020\u007f]/.test(value)) return null;
  let url;
  try { url = new URL(value); } catch { return null; }
  if (url.protocol !== 'https:' || !url.hostname || url.username || url.password || url.hash
      || (url.port && url.port !== '443') || url.pathname.toLowerCase().endsWith('.svg')) return null;
  const host = url.hostname.toLowerCase();
  if (STEAM_HOSTS.has(host) || (host.endsWith(STEAM_SUFFIX) && host.length > STEAM_SUFFIX.length)) return url.href;
  if (communityOrigin && url.origin === communityOrigin && !url.search && COMMUNITY_AVATAR_PATH.test(url.pathname)) return url.href;
  return null;
}

async function readCapped(response, limit) {
  const declared = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > limit) return null;
  if (!response.body) return null;
  const chunks = []; let size = 0;
  for await (const chunk of response.body) {
    const buffer = Buffer.from(chunk); size += buffer.length;
    if (size > limit) { await response.body.cancel?.().catch(() => {}); return null; }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function validHue(value) {
  return Number.isInteger(value) && value >= 0 && value <= 359;
}

// The only avatar shapes a snapshot may carry: a data: image or a hue.
function isSnapshotAvatar(value) {
  if (!value || typeof value !== 'object') return false;
  if (value.kind === 'image') return typeof value.url === 'string' && /^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+=*$/.test(value.url);
  return value.kind === 'hue' && validHue(value.hue) && typeof value.text === 'string';
}

// createLobbyAvatars({ communityUrl, fetchImpl, now, onChange, cacheSize, timeoutMs, maxBytes })
//   get(avatar, { seed, name })     sync; cached data: image, else hue. Starts a
//                                   background fetch if none is running.
//   onChange()                      called once each time a new image is cached.
//   resolve(avatar, { seed, name }) async; waits for the fetch.
//   clear()                         drops the cache (sign-out); pending fetches are ignored.
// `avatar` is the protocol avatar object ({kind:'image',url} | {kind:'hue',hue,text}).
// `seed` (the member user_id) feeds hashHue when the server gave no usable hue.
function createLobbyAvatars({ communityUrl = DEFAULT_COMMUNITY_URL, fetchImpl = globalThis.fetch, now = Date.now,
  onChange = null, cacheSize = CACHE_SIZE, timeoutMs = FETCH_TIMEOUT_MS, maxBytes = MAX_AVATAR_BYTES } = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('头像下载不可用');
  const communityOrigin = communityOriginOf(communityUrl);
  const cache = new Map(); // href -> { dataUrl } | { failedAt }
  const pending = new Map(); // href -> Promise<string|null>
  let generation = 0;

  function remember(href, entry) {
    cache.delete(href);
    cache.set(href, entry);
    while (cache.size > cacheSize) cache.delete(cache.keys().next().value);
  }

  function lookup(href) {
    const entry = cache.get(href);
    if (!entry) return undefined;
    if (entry.failedAt !== undefined && now() - entry.failedAt >= FAILURE_RETRY_MS) { cache.delete(href); return undefined; }
    cache.delete(href); cache.set(href, entry); // LRU touch
    return entry;
  }

  async function download(href) {
    const deadline = AbortSignal.timeout(timeoutMs);
    try {
      const response = await fetchImpl(href, { method: 'GET', redirect: 'error', credentials: 'omit', cache: 'no-store',
        referrerPolicy: 'no-referrer', headers: { Accept: 'image/png,image/jpeg,image/webp,image/gif' }, signal: deadline });
      if (!response || !response.ok || response.redirected || (response.status >= 300 && response.status < 400)) {
        await response?.body?.cancel?.().catch(() => {});
        return null;
      }
      const bytes = await readCapped(response, maxBytes);
      if (!bytes || deadline.aborted) return null;
      const type = detectImageType(bytes);
      return type ? `data:${type};base64,${bytes.toString('base64')}` : null;
    } catch { return null; }
  }

  function fetchOnce(href) {
    const running = pending.get(href);
    if (running) return running;
    const started = generation;
    const job = download(href).then(dataUrl => {
      if (pending.get(href) === job) pending.delete(href);
      if (started !== generation) return null;
      remember(href, dataUrl ? { dataUrl } : { failedAt: now() });
      // One notification per new image, however many callers waited on it.
      if (dataUrl && typeof onChange === 'function') { try { onChange(); } catch { /* listener errors stay local */ } }
      return dataUrl;
    });
    pending.set(href, job);
    return job;
  }

  function fallback(avatar, { seed, name } = {}) {
    if (avatar && avatar.kind === 'hue' && validHue(avatar.hue)) {
      return Object.freeze({ kind: 'hue', hue: avatar.hue, text: firstChar(typeof avatar.text === 'string' ? avatar.text : name) });
    }
    return hueAvatar(seed, name);
  }

  const imageOf = dataUrl => Object.freeze({ kind: 'image', url: dataUrl });
  const targetOf = avatar => avatar && avatar.kind === 'image' ? allowedAvatarUrl(avatar.url, communityOrigin) : null;

  function get(avatar, options = {}) {
    const href = targetOf(avatar);
    if (!href) return fallback(avatar, options);
    const entry = lookup(href);
    if (entry?.dataUrl) return imageOf(entry.dataUrl);
    if (!entry) fetchOnce(href);
    return fallback(avatar, options);
  }

  async function resolve(avatar, options = {}) {
    const href = targetOf(avatar);
    if (!href) return fallback(avatar, options);
    const entry = lookup(href);
    if (entry) return entry.dataUrl ? imageOf(entry.dataUrl) : fallback(avatar, options);
    const dataUrl = await fetchOnce(href);
    return dataUrl ? imageOf(dataUrl) : fallback(avatar, options);
  }

  function clear() {
    generation += 1;
    cache.clear();
    pending.clear();
  }

  return Object.freeze({ get, resolve, clear, size: () => cache.size, communityOrigin });
}

module.exports = { CACHE_SIZE, MAX_AVATAR_BYTES, FETCH_TIMEOUT_MS, FAILURE_RETRY_MS, STEAM_HOSTS, STEAM_SUFFIX,
  hashHue, firstChar, hueAvatar, detectImageType, allowedAvatarUrl, isSnapshotAvatar, createLobbyAvatars };
