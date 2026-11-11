'use strict';

const { createHash, randomUUID } = require('node:crypto');

function ownerBinding(config) {
  const access = config.access;
  const owner = access?.c2cAllow?.[0];
  if (!config.appId || !config.appSecret || access?.c2cMode !== 'allowlist' ||
      access.c2cAllow.length !== 1 || access.groupMode !== 'disabled' ||
      access.groupAllow?.length !== 0 || !/^[A-Za-z0-9_-]{8,256}$/.test(owner || '')) return null;
  const key = createHash('sha256').update(JSON.stringify([config.appId, config.appSecret, owner])).digest('hex');
  return { owner, key };
}

function createQQCompanionLink({ readConfig, readConsent, saveConsent, notify, timeoutMs = 120000 }) {
  let pending = null;
  const seen = new Map();

  function binding() {
    try {
      const owner = ownerBinding(readConfig());
      return owner?.key === readConsent() ? owner : null;
    } catch { return null; }
  }

  function finish(text = null) {
    if (!pending) return;
    const item = pending;
    pending = null;
    clearTimeout(item.timer);
    item.resolve(text);
  }

  return {
    enabled: () => !!binding(),
    configure(enabled) {
      const key = enabled ? ownerBinding(readConfig())?.key : null;
      if (enabled && !key) throw Error('请先确认 QQ 私聊配对');
      saveConsent(key ?? null);
      finish();
    },
    cancel: () => finish(),
    request(message, isActive) {
      const paired = binding();
      if (!isActive() || !paired || message?.kind !== 'c2c' || message.senderId !== paired.owner) return null;
      const text = typeof message.content === 'string' ? message.content.trim() : '';
      if (!text || text.length > 8000 || message.attachments?.length) return Promise.resolve('接续私聊目前只支持纯文字消息。');
      const messageId = message.messageId;
      if (typeof messageId !== 'string' || !messageId || messageId.length > 512 || seen.has(messageId)) return Promise.resolve(null);
      seen.set(messageId, true);
      if (seen.size > 256) seen.delete(seen.keys().next().value);
      if (pending) return Promise.resolve('大肥鱼正在回复，等她一下。');
      const id = randomUUID();
      return new Promise(resolve => {
        const timer = setTimeout(() => finish('大肥鱼暂时没有回复，请稍后再试。'), timeoutMs);
        timer.unref?.();
        pending = { id, text, isActive, key: paired.key, resolve, timer, taken: false };
        try { notify(id); } catch { finish('大肥鱼暂时无法连接，请稍后再试。'); }
      });
    },
    take(id) {
      if (pending?.id !== id || pending.taken || !pending.isActive() || pending.key !== binding()?.key) return null;
      pending.taken = true;
      return { text: pending.text };
    },
    reply(id, text) {
      if (pending?.id !== id || !pending.taken) return false;
      const allowed = pending.isActive() && pending.key === binding()?.key;
      finish(allowed && typeof text === 'string' && text.length <= 1500 ? text : null);
      return allowed;
    },
    canSend(message) {
      const paired = binding();
      return !!paired && message?.kind === 'c2c' && paired.owner === message.senderId;
    },
  };
}

module.exports = { createQQCompanionLink };
