const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { verifyIdentityTicket } = require('../../apps/neko-workbench/visits/identity.cjs');
const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
const claims = { v: 1, iss: 'neko-servers', aud: 'neko-visit', kid: 'test-1', sub: 'a'.repeat(24),
  vid: 'h_' + 'b'.repeat(24), visit_id: 'c'.repeat(22), role: 'host', transport: 'livekit',
  char_tag: 'd'.repeat(32), iat: 1000, exp: 4000, jti: 'e'.repeat(22), mode: 'text' };
const pubkeys = { keys: [{ kid: 'test-1', alg: 'Ed25519', pub: publicKey.export({ format: 'jwk' }).x,
  not_before: 900, not_after: 5000 }], revoked: [] };
const options = { pubkeys, visitId: claims.visit_id, role: 'host', vid: claims.vid, transport: 'livekit', now: 2000 };
function sign(value) { const payload = Buffer.from(JSON.stringify(value)).toString('base64url'); return payload + '.' + crypto.sign(null, Buffer.from(payload), privateKey).toString('base64url'); }

test('verifies Connect two-part Ed25519 payload without manufacturing media policy claims', () => {
  assert.deepEqual(verifyIdentityTicket(sign(claims), options), claims);
  const legacy = { ...claims }; delete legacy.mode;
  const verified = verifyIdentityTicket(sign(legacy), options);
  assert.deepEqual(verified, legacy);
  assert.equal(Object.hasOwn(verified, 'mode'), false);
  assert.deepEqual(verifyIdentityTicket(sign({ ...claims, mode: 'media' }), options), { ...claims, mode: 'media' });
});
test('rejects unknown modes and mismatched room, role, participant or transport', () => {
  for (const changed of [{ ...claims, mode: 'unknown' }, { ...claims, mode: null }, { ...claims, visit_id: 'z'.repeat(22) },
    { ...claims, role: 'guest' }, { ...claims, vid: 'g_wrong' }, { ...claims, transport: 'trtc' }]) {
    assert.throws(() => verifyIdentityTicket(sign(changed), options), /invalid_identity_ticket/);
  }
});
test('rejects tamper, expired, future, invalid issuer and revoked/duplicate key', () => {
  for (const changed of [{ ...claims, exp: 1999 }, { ...claims, iat: 2100 }, { ...claims, exp: 9000 },
    { ...claims, iss: 'other' }, { ...claims, aud: 'other' }]) {
    assert.throws(() => verifyIdentityTicket(sign(changed), options), /invalid_identity_ticket/);
  }
  assert.throws(() => verifyIdentityTicket(sign(claims).replace(/^./, 'x'), options));
  assert.throws(() => verifyIdentityTicket(sign(claims), { ...options, pubkeys: { ...pubkeys, revoked: ['test-1'] } }));
  assert.throws(() => verifyIdentityTicket(sign(claims), { ...options, pubkeys: { ...pubkeys, keys: [...pubkeys.keys, ...pubkeys.keys] } }));
  assert.throws(() => verifyIdentityTicket(sign(claims), { ...options, pubkeys: { ...pubkeys, keys: [{ ...pubkeys.keys[0], not_before: 1001 }] } }));
});
