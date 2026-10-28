'use strict';
const crypto = require('node:crypto');
function invalid() { const error = new Error('invalid_identity_ticket'); error.code = error.message; return error; }
function decode(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) throw invalid();
  const buffer = Buffer.from(value, 'base64url');
  if (buffer.toString('base64url') !== value) throw invalid();
  return buffer;
}
// Connect tickets are payload.signature (not JWT). Verify the exact encoded payload.
function verifyIdentityTicket(ticket, { pubkeys, visitId, role, vid, transport, now = Date.now() / 1000 } = {}) {
  try {
    if (typeof ticket !== 'string' || ticket.length > 2048 || !Number.isFinite(now) ||
        !/^[A-Za-z0-9_-]{22}$/.test(visitId || '') || !['host', 'guest'].includes(role) ||
        typeof vid !== 'string' || !vid || !['livekit', 'trtc'].includes(transport)) throw invalid();
    const parts = ticket.split('.'); if (parts.length !== 2) throw invalid();
    const claims = JSON.parse(decode(parts[0]).toString('utf8')); const signature = decode(parts[1]);
    if (!claims || claims.v !== 1 || claims.iss !== 'neko-servers' || claims.aud !== 'neko-visit' ||
        (claims.mode !== undefined && !['media', 'text'].includes(claims.mode)) ||
        claims.visit_id !== visitId || claims.role !== role || claims.vid !== vid || claims.transport !== transport ||
        !/^[0-9a-f]{24}$/.test(claims.sub || '') || !/^[0-9a-f]{32}$/.test(claims.char_tag || '') ||
        !/^[A-Za-z0-9_-]{22}$/.test(claims.jti || '') ||
        !Number.isSafeInteger(claims.iat) || !Number.isSafeInteger(claims.exp) ||
        claims.iat > now + 30 || claims.exp <= now || claims.exp <= claims.iat ||
        claims.exp - claims.iat > (role === 'host' ? 3000 : 2400) || signature.length !== 64 ||
        !Array.isArray(pubkeys?.keys) || !Array.isArray(pubkeys?.revoked) || pubkeys.revoked.includes(claims.kid)) throw invalid();
    const keys = pubkeys.keys.filter(key => key.kid === claims.kid);
    if (keys.length !== 1) throw invalid();
    const key = keys[0]; const raw = decode(key.pub);
    if (key.alg !== 'Ed25519' || raw.length !== 32 || !Number.isSafeInteger(key.not_before) || !Number.isSafeInteger(key.not_after) ||
        claims.iat < key.not_before || claims.iat > key.not_after) throw invalid();
    const publicKey = crypto.createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), raw]), format: 'der', type: 'spki' });
    if (!crypto.verify(null, Buffer.from(parts[0], 'ascii'), publicKey, signature)) throw invalid();
    return Object.freeze(claims);
  } catch { throw invalid(); }
}
module.exports = { verifyIdentityTicket };
