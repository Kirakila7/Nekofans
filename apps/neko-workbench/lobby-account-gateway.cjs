'use strict';
const { createCompanionAccountProvider } = require('./companion-account-provider.cjs');

// Public-chat requests have their own bridge and cancellation scope. Never use
// the private chat service, its history, turn lock or memory for this transport.
function createLobbyAccountGateway({ rpc, isReady, onChange = () => {} }) {
  let disposed = false, signedIn = false, generation = 0, pending = null;
  const routes = Object.freeze({
    'companion-account-chat': 'lobby-account-chat',
    'companion-account-cancel': 'lobby-account-cancel',
  });
  const accountProvider = createCompanionAccountProvider((method, input) => {
    if (!Object.hasOwn(routes, method)) throw Error('大厅账号仅支持独立聊天');
    if (method !== 'companion-account-cancel' && (disposed || !isReady() || !signedIn)) throw Error('大厅账号聊天尚未就绪');
    return rpc(routes[method], input);
  });
  // The shared account adapter also exposes private-memory extraction. Public
  // chat deliberately exports only its stream capability.
  const provider = Object.freeze({ stream: input => accountProvider.stream(input) });
  function invalidate() {
    generation++; pending = null;
    const changed = signedIn; signedIn = false;
    if (changed && !disposed) onChange();
  }
  function refresh() {
    if (disposed || !isReady()) { invalidate(); return Promise.resolve(); }
    if (pending) return pending;
    const ticket = generation;
    const current = Promise.resolve().then(() => rpc('lobby-account-status')).catch(() => null).then(value => {
      if (disposed || ticket !== generation || !isReady()) return;
      const next = value?.status === 'signed-in';
      if (next !== signedIn) { signedIn = next; onChange(); }
    }).finally(() => { if (pending === current) pending = null; });
    pending = current;
    return current;
  }
  return { refresh, invalidate,
    provider: () => !disposed && isReady() && signedIn ? provider : null,
    dispose() { disposed = true; invalidate(); } };
}
module.exports = { createLobbyAccountGateway };
