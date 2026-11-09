'use strict';

// IPC errors may contain credential-bearing request details. Only expose the
// explicitly authored, non-sensitive messages to the workbench renderer.
function safeGamePairError(error) {
  const allowed = new Set(['请先登录自己的 DeepSeek 工作台账号', '配对码无效、已使用或已过期']);
  return allowed.has(error?.message) ? error.message : '席位关联暂不可用，请稍后重试。';
}

// This adapter must be called by the trusted main process, never by generated
// game code. Calling share is an explicit user action; suggestion is private.
function createGameHubBridge({ getProvider, lobbyController }) {
  return {
    async suggest({ ownState, question, signal }) {
      const provider = getProvider?.();
      if (!provider) throw new Error('主 agent 聊天线路不可用');
      const { askTeammate } = await import('./game-assistant.mjs');
      return askTeammate({ provider, ownState, question, signal });
    },
    async share({ title, roomUrl }) {
      const url = new URL(roomUrl);
      if (url.protocol !== 'https:' || ['localhost', '127.0.0.1', '::1'].includes(url.hostname)) throw new Error('聊天室分享需要公开的 HTTPS 房间链接');
      const { invitationText } = await import('./game-assistant.mjs');
      const text = invitationText(title, roomUrl);
      if (!lobbyController?.request) throw new Error('聊天室不可用');
      return lobbyController.request({ action: 'send', origin: 'human', text });
    },
  };
}

module.exports = { createGameHubBridge, safeGamePairError };
