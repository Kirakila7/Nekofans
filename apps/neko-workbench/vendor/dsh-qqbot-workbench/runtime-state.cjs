'use strict';
const RUNTIME = Symbol.for('neko.qqbot.runtime');
const runtimes = new WeakMap();
function hasScope(access) {
  return ['c2c', 'group'].some(key => access?.[`${key}Mode`] === 'open' ||
    (access?.[`${key}Mode`] === 'allowlist' && Array.isArray(access[`${key}Allow`]) &&
      access[`${key}Allow`].some(value => typeof value === 'string' && value.trim().length > 0)));
}
function guardQQBot(bot, runtime) {
  // Check at the actual send boundary, including subsequent chunks after an
  // awaited send and delayed stream updates. Already sent requests cannot be recalled.
  for (const name of ['send', 'sendMarkdown', 'sendImage', 'sendVideo', 'sendVoice', 'sendFile', 'acknowledgeInteraction']) {
    if (typeof bot[name] !== 'function') continue;
    const send = bot[name].bind(bot);
    bot[name] = (...args) => runtime.active() && !runtime.pairingOnly?.() ? send(...args) : Promise.resolve();
  }
  if (typeof bot.openStream === 'function') {
    const open = bot.openStream.bind(bot);
    bot.openStream = (...args) => {
      const stream = runtime.active() && !runtime.pairingOnly?.() ? open(...args) : null;
      return {
        update: (...values) => runtime.active() && !runtime.pairingOnly?.() && stream ? stream.update(...values) : Promise.resolve(),
        complete: (...values) => runtime.active() && !runtime.pairingOnly?.() && stream ? stream.complete(...values) : Promise.resolve(),
      };
    };
  }
}
// Capture the user-start generation once per plugin fiber. Looking up the
// global capability on every callback would let old callbacks enter a new run.
function createQQRuntime(ctx) {
  if (runtimes.has(ctx)) return runtimes.get(ctx);
  const host = globalThis[RUNTIME]?.();
  let disposed = false;
  const runtime = {
    active: () => !disposed && host?.active?.() === true,
    capture(message) { return runtime.active() && host?.capture?.(message) === true; },
    allowPairing() { return runtime.active() && host?.allowPairing?.() === true; },
    pairingOnly() { return !runtime.active() || host?.pairingOnly?.() === true; },
    mark(key) { host?.mark?.(key); },
    experience(entry) { if(runtime.active())host?.experience?.(entry); },
    report(phase) { if (runtime.active()) host.report(phase); },
  };
  ctx.on('dispose', () => { disposed = true; });
  runtimes.set(ctx, runtime);
  return runtime;
}
module.exports = { RUNTIME, createQQRuntime, hasScope, guardQQBot };
