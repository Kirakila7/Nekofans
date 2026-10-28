'use strict';
const { randomBytes } = require('node:crypto');

// A local, authenticated action arms one private-chat challenge. No account
// identifier or conversation is returned by this capability or written to logs.
function createPrivatePairing({ readConfig, now = Date.now }) {
  let pending = null;
  const fingerprint = value => JSON.stringify([value.appId, value.access]);
  const fail = code => { throw Object.assign(new Error(code), { code }); };
  function live() {
    if (pending && now() >= pending.expiresAt) pending = null;
    return pending;
  }
  return {
    cancel() { pending = null; },
    status() { const item = live(); return { active: !!item, matched: !!item?.senderId, expiresAt: item?.expiresAt || 0 }; },
    begin() {
      const value = readConfig(), access = value.access;
      if (!value.appId || access?.c2cMode !== 'allowlist' || access.c2cAllow?.length !== 1 ||
          access.groupMode !== 'disabled' || access.groupAllow?.length !== 0) fail('PAIRING_SCOPE_CHANGED');
      pending = { challenge: randomBytes(16).toString('hex'), expiresAt: now() + 300000,
        fingerprint: fingerprint(value), senderId: null };
      return { ...this.status(), challenge: pending.challenge };
    },
    capture(message) {
      const item = live();
      if (!item || message?.kind !== 'c2c' || typeof message.content !== 'string' ||
          message.content.trim().replace(/^QQ配对\s+/, '') !== item.challenge || !/^[A-Za-z0-9_-]{8,256}$/.test(message.senderId || '')) return false;
      if (fingerprint(readConfig()) !== item.fingerprint) { pending = null; return false; }
      if (item.senderId && item.senderId !== message.senderId) return false;
      item.senderId = message.senderId;
      return true; // Consume the challenge; never forward it to the model.
    },
    confirm(saveAccess) {
      const item = live();
      if (!item?.senderId) fail('PAIRING_NOT_MATCHED');
      const value = readConfig();
      if (fingerprint(value) !== item.fingerprint) { pending = null; fail('PAIRING_SCOPE_CHANGED'); }
      pending = null;
      if (saveAccess({ ...value.access, c2cAllow: [item.senderId] }) !== true) fail('PAIRING_SAVE_FAILED');
      return { ok: true, privateMode: 'allowlist', whitelistCount: 1, groupMode: 'disabled' };
    },
  };
}
module.exports = { createPrivatePairing };
