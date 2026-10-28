'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { createCodexAdapter } = require('./codex-adapter.cjs');

// The resolver runs in the DSH host and returns its authoritative registry path.
function createCodexController({ resolveWorkspace, publish = () => {}, adapterFactory = createCodexAdapter }) {
  let current = null, activeTurn = null, sending = false, starting = false, disposed = false;
  const sessions = new Map(), approvals = new Map(), settled = new Set();
  const adapter = adapterFactory({ onEvent(event) {
    if (event.type === 'error' && !event.threadId) {
      current = null; activeTurn = null; sending = false; sessions.clear(); approvals.clear();
      publish(event); return;
    }
    if (!current || event.threadId !== current.threadId) return;
    if (event.type === 'turn-started') activeTurn = event.turnId;
    if (event.type === 'turn-completed') {
      settled.add(event.turnId); if (activeTurn === event.turnId) activeTurn = null;
      for (const [key, value] of approvals) if (value.turnId === event.turnId) approvals.delete(key);
    }
    if (event.type === 'approval-request') approvals.set(event.requestId, { threadId: event.threadId, turnId: event.turnId });
    publish({ ...event, workspaceId: current.workspaceId });
  } });
  async function realDir(value) {
    if (typeof value !== 'string' || !path.isAbsolute(value) || value.includes('\0')) throw new Error('请选择有效的工作区');
    try { const dir = await fs.realpath(value); if (!(await fs.stat(dir)).isDirectory()) throw new Error(); return dir; }
    catch { throw new Error('工作区目录不存在或无法访问'); }
  }
  return {
    async start({ workspaceId, path: proposedPath } = {}) {
      if (disposed) throw new Error('Codex 服务已关闭');
      if (starting || sending || activeTurn) throw new Error('Codex 正在处理任务，请等待完成或先停止');
      if (typeof workspaceId !== 'string' || !workspaceId || workspaceId.length > 256) throw new Error('请选择工作区');
      starting = true;
      try {
        const record = await resolveWorkspace(workspaceId);
        if (!record || record.workspaceId !== workspaceId) throw new Error('无法验证所选工作区');
        const cwd = await realDir(record.path);
        if (proposedPath !== undefined && await realDir(proposedPath) !== cwd) throw new Error('所选工作区与目录不匹配，请刷新后重试');
        let session = sessions.get(workspaceId);
        if (session && session.cwd !== cwd) { sessions.delete(workspaceId); session = null; }
        if (!session) { const result = await adapter.createSession({ cwd }); session = { workspaceId, cwd, threadId: result.threadId }; sessions.set(workspaceId, session); }
        current = session;
        return { threadId: current.threadId };
      } finally { starting = false; }
    },
    async send({ text } = {}) {
      if (!current) throw new Error('请先选择 Codex 工作区');
      if (starting || sending || activeTurn) throw new Error('Codex 正在处理上一条消息');
      sending = true; settled.clear();
      try {
        const result = await adapter.sendMessage({ threadId: current.threadId, text });
        if (!settled.has(result.turnId)) activeTurn = result.turnId;
        return result;
      } finally { sending = false; }
    },
    async cancel() {
      if (!current || !activeTurn) throw new Error('当前没有可停止的 Codex 任务');
      await adapter.cancel({ threadId: current.threadId, turnId: activeTurn });
      return { accepted: true };
    },
    approval({ requestId, decision } = {}) {
      if (!current || !approvals.has(requestId) || approvals.get(requestId).threadId !== current.threadId) throw new Error('审批请求不存在或已过期');
      adapter.respondApproval({ requestId, decision }); approvals.delete(requestId);
      return { accepted: true };
    },
    dispose() { if (disposed) return; disposed = true; adapter.dispose(); current = null; sessions.clear(); approvals.clear(); }
  };
}
module.exports = { createCodexController };
