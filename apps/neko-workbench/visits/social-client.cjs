'use strict';

// Main-process only: OAuth bearer tokens must never enter a webContents.
const DEFAULT_BASE_URL = 'https://community.project-neko.cn';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const VISIT_ID = /^[A-Za-z0-9_-]{22}$/;
function fail(code, status) {
  const error = new Error(code); error.code = code;
  if (status !== undefined) error.status = status;
  return error;
}
function endpoint(value, allowLoopbackForTests = false) {
  let url;
  try { url = new URL(value); } catch { throw fail('invalid_service_url'); }
  if (url.username || url.password || url.search || url.hash ||
      (url.protocol !== 'https:' && !(allowLoopbackForTests && url.protocol === 'http:' &&
        ['127.0.0.1', '[::1]'].includes(url.hostname)))) throw fail('invalid_service_url');
  return url;
}
async function requestJson(url, { fetch: fetchImpl = globalThis.fetch, method = 'GET', headers = {}, body,
  timeoutMs = 15000, maxBytes = 1024 * 1024, signal } = {}) {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { method, headers, body, redirect: 'error', signal: signal ? AbortSignal.any([abort.signal,signal]) : abort.signal });
    if (response.redirected || (response.status >= 300 && response.status < 400)) throw fail('redirect_refused');
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw fail('service_request_failed', response.status);
    }
    if (response.status === 204) return null;
    const length = Number(response.headers?.get('content-length'));
    if (length > maxBytes) { await response.body?.cancel().catch(() => {}); throw fail('response_too_large'); }
    if (!response.body?.getReader) throw fail('invalid_service_response');
    const reader = response.body.getReader();
    let total = 0; const chunks = [];
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) { await reader.cancel(); throw fail('response_too_large'); }
        chunks.push(Buffer.from(value));
      }
    } finally { reader.releaseLock(); }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw fail('invalid_service_response'); }
  } catch (error) {
    if (error.code && ['redirect_refused', 'service_request_failed', 'response_too_large', 'invalid_service_response'].includes(error.code)) throw error;
    throw fail(abort.signal.aborted ? 'service_timeout' : 'service_unavailable');
  } finally { clearTimeout(timer); }
}
function check(value, pattern, code) { if (typeof value !== 'string' || !pattern.test(value)) throw fail(code); return value; }

function createSocialClient({ baseUrl = DEFAULT_BASE_URL, getAccessToken, fetch: fetchImpl = globalThis.fetch,
  clientId, appVersion = '0.1', allowLoopbackForTests = false, timeoutMs = 15000 } = {}) {
  const base = endpoint(baseUrl, allowLoopbackForTests);
  if (base.pathname !== '/' || typeof getAccessToken !== 'function' || typeof clientId !== 'string' ||
      !clientId.length || clientId.length > 256 || /[\r\n]/.test(clientId) || !/^\d+\.\d+$/.test(appVersion)) throw fail('invalid_social_config');
  async function request(path, { method = 'GET', body, public: isPublic = false } = {}) {
    const headers = { Accept: 'application/json', 'X-Client-Id': clientId };
    if (!isPublic) {
      const token = await getAccessToken();
      if (typeof token !== 'string' || !token || token.length > 8192 || /[\s]/.test(token)) throw fail('login_required');
      headers.Authorization = `Bearer ${token}`;
    }
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    return requestJson(new URL(path, base).href, { fetch: fetchImpl, headers, method,
      body: body === undefined ? undefined : JSON.stringify(body), timeoutMs });
  }
  async function credentials(role, { visitId, charTag, displayName, targetUserId } = {}) {
    check(visitId, VISIT_ID, 'invalid_visit_id'); check(charTag, /^[0-9a-f]{32}$/, 'invalid_char_tag');
    if (typeof displayName !== 'string' || !displayName.trim() || displayName.length > 64 || displayName.includes('\0')) throw fail('invalid_display_name');
    if (role === 'host') check(targetUserId, UUID, 'invalid_target_user');
    const result = await request('/api/visit/credentials', { method: 'POST', body: {
      role, visit_id: visitId, char_tag: charTag, display_name: displayName,
      tier: 'sd600', region_hint: 'unknown', app_version: appVersion, direct: true,
      ...(role === 'host' ? { target_user_id: targetUserId } : {}),
    } });
    if (!result || typeof result !== 'object' || Array.isArray(result) ||
        (result.visit_id !== undefined && result.visit_id !== visitId) ||
        (result.role !== undefined && result.role !== role) ||
        (result.mode !== undefined && !['media', 'text'].includes(result.mode))) throw fail('invalid_service_response');
    // Existing Connect omits these request bindings and can grant media rights.
    // "text" is our local client policy, not a claim that the server or signed
    // ticket prevents media. Both clients' RTC adapters disable media locally.
    return { ...result, visit_id: visitId, role, mode: 'text', mediaPolicy: 'client-only' };
  }
  return Object.freeze({
    async listFriends() {
      const { user: me } = await request('/api/users/me');
      check(me?.id, UUID, 'invalid_service_response');
      const items = []; let offset = 0;
      // Bound pagination; fail visibly instead of presenting an incomplete list.
      for (let page = 0; page < 100; page++) {
        const result = await request(`/api/users/${me.id}/following?limit=100&offset=${offset}`);
        if (!Array.isArray(result?.items) || !Number.isSafeInteger(result.total) || result.total < 0) throw fail('invalid_service_response');
        items.push(...result.items.filter(item => item?.is_mutual === true && UUID.test(item.id || '') &&
          !item.blocked_by_viewer && !item.blocks_viewer));
        offset += result.items.length;
        if (offset >= result.total) return { items, total: items.length, userId: me.id };
        if (!result.items.length) break;
      }
      throw fail('friends_page_limit');
    },
    presence(status) {
      if (status === undefined) return request('/api/users/me/presence');
      if (!['online', 'away', 'invisible'].includes(status)) throw fail('invalid_presence');
      return request('/api/users/me/presence', { method: 'PUT', body: { status } });
    },
    notifications({ cursor, limit = 100 } = {}) {
      if (!Number.isInteger(limit) || limit < 1 || limit > 100 || (cursor !== undefined && (typeof cursor !== 'string' || cursor.length > 4096))) throw fail('invalid_notification_query');
      const query = new URLSearchParams({ limit: String(limit) });
      if (cursor) query.set('cursor', cursor);
      return request(`/api/notifications?${query}`);
    },
    inviteNotification(userId, visitId, expiresAt) {
      check(userId, UUID, 'invalid_target_user'); check(visitId, VISIT_ID, 'invalid_visit_id');
      if (expiresAt !== undefined && (!Number.isFinite(expiresAt) || expiresAt <= Date.now() / 1000)) throw fail('invalid_invite_expiry');
      return request(`/api/users/${userId}/visit-invite`, { method: 'POST', body: { visit_id: visitId, ...(expiresAt === undefined ? {} : { expires_at: expiresAt }) } });
    },
    respondInvite(notificationId, accepted) {
      check(notificationId, UUID, 'invalid_notification_id');
      if (typeof accepted !== 'boolean') throw fail('invalid_invite_response');
      return request(`/api/notifications/${notificationId}/visit-response`, { method: 'POST', body: { accepted } });
    },
    createRoom: options => credentials('host', options), joinRoom: options => credentials('guest', options),
    cancelRoom(visitId) {
      check(visitId, VISIT_ID, 'invalid_visit_id');
      return request(`/api/visit/rooms/${visitId}/cancel`, { method: 'POST' });
    },
    pubkeys: () => request('/api/visit/pubkeys', { public: true }),
    async publishDaily({title,body,ownerId,signal,assertCurrent=()=>{}}){
      check(ownerId,UUID,'invalid_owner');
      if(typeof title!=='string'||!title.trim()||title.length>80||typeof body!=='string'||!body.trim()||body.length>500)throw fail('invalid_daily_post');
      const token=await getAccessToken();
      if(typeof token!=='string'||!token||token.length>8192||/\s/.test(token))throw fail('login_required');
      const headers={Accept:'application/json','X-Client-Id':clientId,Authorization:`Bearer ${token}`};
      // Use one captured token for both identity proof and write. Never refresh
      // to a different account in between or fall back to the browser's login.
      const me=await requestJson(new URL('/api/users/me',base).href,{fetch:fetchImpl,headers,timeoutMs,signal});
      if(me?.user?.id!==ownerId)throw fail('account_changed');assertCurrent();
      const form=new FormData();for(const [key,value] of Object.entries({title,body,visibility:'public',tags:'[]',image_ids:'[]',image_crops:'[]'}))form.append(key,value);
      const result=await requestJson(new URL('/api/posts',base).href,{fetch:fetchImpl,method:'POST',headers,body:form,timeoutMs,signal});
      if(!result||typeof result.id!=='string'||!result.id||result.id.length>128)throw fail('invalid_service_response');
      return {id:result.id};
    },
  });
}
module.exports = { createSocialClient, DEFAULT_BASE_URL, requestJson, endpoint };
