'use strict';
const {createCommunitySocialClient, DEFAULT_BASE_URL, requestJson, endpoint, UUID, check, fail} = require('../community-social-client.cjs');
const VISIT_ID = /^[A-Za-z0-9_-]{22}$/;

function createSocialClient({appVersion = '0.1', community, ...options} = {}) {
  if (!/^\d+\.\d+$/.test(appVersion)) throw fail('invalid_social_config');
  const {request, ...shared} = community ?? createCommunitySocialClient(options);
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
    ...shared,
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
  });
}
module.exports = { createSocialClient, DEFAULT_BASE_URL, requestJson, endpoint };
