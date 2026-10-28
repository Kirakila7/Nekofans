'use strict';
const { randomBytes, createHash } = require('node:crypto');

// A local, authenticated action arms one private-chat challenge. No account
// identifier or conversation is returned by this capability or written to logs.
function createPrivatePairing({ readConfig, now = Date.now }) {
  let pending = null;
  const retired = new Map();
  const fingerprint = value => JSON.stringify([value.appId, createHash('sha256').update(value.appSecret || '').digest('hex'), value.access]);
  const fail = code => { throw Object.assign(new Error(code), { code }); };
  function retire() {
    if (pending) retired.set(pending.challenge, now() + 900000);
    pending = null;
    for (const [key, expiry] of retired) if (now() >= expiry) retired.delete(key);
    while (retired.size > 32) retired.delete(retired.keys().next().value);
  }
  function live() {
    if (pending && now() >= pending.expiresAt) retire();
    return pending;
  }
  return {
    cancel() { retire(); },
    status() { const item = live(); return { active: !!item, matched: !!item?.senderId, expiresAt: item?.expiresAt || 0 }; },
    begin() {
      if (live()) fail('PAIRING_ALREADY_ACTIVE');
      const value = readConfig(), access = value.access;
      const firstPairing = ['disabled', 'allowlist'].includes(access?.c2cMode) && access.c2cAllow?.length === 0;
      const replacement = access?.c2cMode === 'allowlist' && access.c2cAllow?.length === 1;
      if (!value.appId || !value.appSecret || (!firstPairing && !replacement) ||
          access.groupMode !== 'disabled' || access.groupAllow?.length !== 0) fail('PAIRING_SCOPE_CHANGED');
      pending = { challenge: randomBytes(16).toString('hex'), expiresAt: now() + 300000,
        fingerprint: fingerprint(value), senderId: null };
      return { ...this.status(), challenge: pending.challenge };
    },
    capture(message) {
      if (typeof message?.content !== 'string') return false;
      const text = message.content.trim();
      const prefixed = /^QQ配对\s+([a-f0-9]{32})$/.exec(text);
      const code = prefixed ? prefixed[1] : text;
      const item = live();
      if (message.kind !== 'c2c') return !!prefixed || retired.has(code) || !!item && code === item.challenge;
      if (!item || code !== item.challenge) return !!prefixed || retired.has(code);
      if (!/^[A-Za-z0-9_-]{8,256}$/.test(message.senderId || '')) return true;
      try {
        if (fingerprint(readConfig()) !== item.fingerprint) { retire(); return true; }
      } catch { retire(); return true; }
      if (item.senderId && item.senderId !== message.senderId) return true;
      item.senderId = message.senderId;
      return true; // Consume the challenge; never forward it to the model.
    },
    confirm(saveAccess) {
      const item = live();
      if (!item?.senderId) fail('PAIRING_NOT_MATCHED');
      const value = readConfig();
      if (fingerprint(value) !== item.fingerprint) { retire(); fail('PAIRING_SCOPE_CHANGED'); }
      retire();
      if (saveAccess({ ...value.access, c2cMode: 'allowlist', c2cAllow: [item.senderId] }) !== true) fail('PAIRING_SAVE_FAILED');
      return { ok: true, privateMode: 'allowlist', whitelistCount: 1, groupMode: 'disabled' };
    },
  };
}
module.exports = { createPrivatePairing };
