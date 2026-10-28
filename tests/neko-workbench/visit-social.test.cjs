const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const { createSocialClient, requestJson } = require('../../apps/neko-workbench/visits/social-client.cjs');
const { verifyIdentityTicket } = require('../../apps/neko-workbench/visits/identity.cjs');
const me = '11111111-1111-4111-8111-111111111111';
const friend = '22222222-2222-4222-8222-222222222222';
const notification = '33333333-3333-4333-8333-333333333333';
const visitId = 'a'.repeat(22);
async function server(t, handler) {
  const instance = http.createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    await handler(req, res, body ? JSON.parse(body) : undefined);
  });
  await new Promise(resolve => instance.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { instance.close(resolve); instance.closeAllConnections(); }));
  return `http://127.0.0.1:${instance.address().port}`;
}
function client(baseUrl, extra = {}) { return createSocialClient({ baseUrl, clientId: 'test-workbench', getAccessToken: async () => 'fake-bearer', allowLoopbackForTests: true, ...extra }); }
function json(res, body) { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(body)); }

test('uses real Verse paths, paginates mutual friends and carries credentials only to fixed origin', async t => {
  const calls = [];
  const base = await server(t, (req, res, body) => {
    calls.push({ url: req.url, method: req.method, body });
    assert.equal(req.headers.authorization, 'Bearer fake-bearer');
    assert.equal(req.headers['x-client-id'], 'test-workbench');
    if (req.url === '/api/users/me') return json(res, { user: { id: me } });
    if (req.url.includes('/following?') && req.url.endsWith('offset=0')) return json(res, { items: [{ id: friend, is_mutual: true }, { id: me, is_mutual: false }], total: 3 });
    if (req.url.includes('/following?')) return json(res, { items: [{ id: null, is_mutual: true }], total: 3 });
    json(res, { ok: true });
  });
  const api = client(base);
  assert.deepEqual(await api.listFriends(), { items: [{ id: friend, is_mutual: true }], total: 1, userId: me });
  await api.presence('online'); await api.presence();
  await api.notifications(); await api.inviteNotification(friend, visitId);
  await api.respondInvite(notification, true); await api.cancelRoom(visitId);
  assert(calls.some(call => call.url === `/api/notifications/${notification}/visit-response` && call.body.accepted));
  assert(calls.some(call => call.url === `/api/users/${friend}/visit-invite` && call.body.visit_id === visitId));
  assert(calls.some(call => call.url === `/api/visit/rooms/${visitId}/cancel` && call.method === 'POST'));
  assert.equal(api.endRoom, undefined, 'does not expose an endpoint absent from deployed Connect');
  assert.equal(calls.some(call => call.url.endsWith('/end')), false);
});
test('uses deployed credentials request and normalizes legacy response with client-only text policy', async t => {
  let count = 0;
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const now = Math.floor(Date.now() / 1000);
  const pubkeys = { keys: [{ kid: 'deployed-test', alg: 'Ed25519', pub: publicKey.export({ format: 'jwk' }).x,
    not_before: now - 60, not_after: now + 7200 }], revoked: [] };
  const base = await server(t, (req, res, body) => {
    count++; assert.equal(req.url, '/api/visit/credentials');
    assert.equal(Object.hasOwn(body, 'mode'), false); assert.equal(body.tier, 'sd600'); assert.equal(body.direct, true);
    assert.equal(body.visit_id, visitId);
    assert.equal(body.target_user_id, body.role === 'host' ? friend : undefined);
    const claims = { v: 1, iss: 'neko-servers', aud: 'neko-visit', kid: 'deployed-test', sub: 'c'.repeat(24),
      vid: `${body.role[0]}_${'d'.repeat(24)}`, visit_id: visitId, role: body.role, transport: 'livekit',
      char_tag: body.char_tag, iat: now, exp: now + (body.role === 'host' ? 3000 : 2400), jti: 'e'.repeat(22) };
    const encoded = Buffer.from(JSON.stringify(claims)).toString('base64url');
    const identity_ticket = encoded + '.' + crypto.sign(null, Buffer.from(encoded), privateKey).toString('base64url');
    // Current Connect lacks visit_id/role/mode/publish.video in this response.
    json(res, { transport: 'livekit', expires_at: claims.exp, vendor_expires_at: claims.exp,
      vendor: { livekit: { url: 'wss://rtc.example.test', token: 'fake-vendor-token', ttl_s: 2400 } },
      identity_ticket, visit_uid: claims.sub, vid: claims.vid, cross_region: false, publish: { audio: true },
      ...(body.role === 'host' ? { direct: true, target_user_id: friend, direct_invite_expires_at: now + 600 } : { peer_vid: 'h_' + 'd'.repeat(24) }) });
  });
  const api = client(base); const input = { visitId, charTag: 'b'.repeat(32), displayName: '猫', targetUserId: friend };
  for (const [grant, role] of [[await api.createRoom(input), 'host'], [await api.joinRoom(input), 'guest']]) {
    assert.equal(grant.role, role); assert.equal(grant.visit_id, visitId);
    assert.equal(grant.mode, 'text'); assert.equal(grant.mediaPolicy, 'client-only');
    assert.deepEqual(grant.publish, { audio: true }, 'preserve actual server rights, do not manufacture server media restrictions');
    const signed = verifyIdentityTicket(grant.identity_ticket, { pubkeys, visitId, role, vid: grant.vid, transport: grant.transport, now });
    assert.equal(Object.hasOwn(signed, 'mode'), false, 'no text capability claim added to signed payload');
  }
  assert.equal(count, 2);
});
test('rejects conflicting server room or role without retry and preserves HTTP failures', async t => {
  let response = { visit_id: 'z'.repeat(22) }; let count = 0;
  const base = await server(t, (_req, res) => { count++; json(res, response); });
  const api = client(base); const input = { visitId, charTag: 'b'.repeat(32), displayName: '猫', targetUserId: friend };
  for (const conflict of [{ visit_id: 'z'.repeat(22) }, { role: 'guest' }, { mode: 'unknown' }, null, []]) {
    response = conflict;
    await assert.rejects(api.createRoom(input), { code: 'invalid_service_response' });
  }
  assert.equal(count, 5);
  response = { visit_id: visitId, role: 'host', mode: 'media', publish: { audio: true, video: true } };
  assert.equal((await api.createRoom(input)).mediaPolicy, 'client-only');
  const refused = client(base, { fetch: async () => new Response('{}', { status: 422 }) });
  await assert.rejects(refused.createRoom(input), { code: 'service_request_failed', status: 422 });
});
test('never forwards bearer on redirects and keeps public keys unauthenticated', async t => {
  let received = 0;
  const target = await server(t, (_req, res) => { received++; json(res, {}); });
  const base = await server(t, (req, res) => {
    if (req.url.endsWith('pubkeys')) { assert.equal(req.headers.authorization, undefined); return json(res, { keys: [], revoked: [] }); }
    res.writeHead(302, { Location: target }); res.end();
  });
  const api = client(base);
  assert.deepEqual(await api.pubkeys(), { keys: [], revoked: [] });
  await assert.rejects(api.presence(), { code: 'service_unavailable' }); assert.equal(received, 0);
});
test('enforces HTTPS, explicit loopback opt-in, validation and bounded responses', async () => {
  for (const baseUrl of ['http://example.com', 'https://user:password@example.com', 'https://example.com/path', 'https://example.com?secret=x']) {
    assert.throws(() => client(baseUrl));
  }
  assert.throws(() => createSocialClient({ baseUrl: 'http://127.0.0.1:1234', clientId: 'test', getAccessToken: () => '' }));
  const api = client('https://example.com');
  assert.throws(() => api.cancelRoom('../secret')); assert.throws(() => api.respondInvite(notification, 'yes'));
  await assert.rejects(requestJson('https://example.com', { maxBytes: 3, fetch: async () => new Response('1234') }), { code: 'response_too_large' });
  await assert.rejects(requestJson('https://example.com', { timeoutMs: 5, fetch: (_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')))) }), { code: 'service_timeout' });
});
