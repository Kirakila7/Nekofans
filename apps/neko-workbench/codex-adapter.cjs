'use strict';

// Codex app-server is owned by the main process. Callers must resolve cwd from
// their trusted, shared project registry, never directly from renderer input.
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function findCodexCommand({ env = process.env, homeDir = os.homedir(), platform = process.platform, fsApi = fsSync } = {}) {
  const executable = platform === 'win32' ? 'codex.exe' : 'codex';
  const paths = [path.join(homeDir, '.local', 'bin')];
  if (platform === 'darwin') paths.push('/opt/homebrew/bin', '/usr/local/bin');
  paths.push(...(env.PATH || '').split(path.delimiter).filter(Boolean));
  for (const directory of paths) {
    if (!path.isAbsolute(directory)) continue;
    const candidate = path.join(directory, executable);
    try { fsApi.accessSync(candidate, fsApi.constants.X_OK); if (fsApi.statSync(candidate).isFile()) return candidate; } catch (_) {}
  }
  // Keep startup lazy: absence of Codex must not prevent the workbench opening.
  return path.join(homeDir, '.local', 'bin', executable);
}

function createCodexAdapter({ onEvent = () => {}, command = findCodexCommand(), spawnProcess = spawn, requestTimeoutMs = 30000, approvalTimeoutMs = 60000 } = {}) {
  let child, ready, disposed = false, nextId = 1, buffer = '';
  const pending = new Map(), threads = new Map(), approvals = new Map();
  const emit = event => { try { onEvent(event); } catch (_) { /* UI callbacks cannot break the transport. */ } };
  const write = message => {
    if (!child || !child.stdin || child.stdin.destroyed) throw new Error('Codex 服务未运行');
    child.stdin.write(JSON.stringify(message) + '\n');
  };
  function failPending(message) {
    for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error(message)); }
    pending.clear();
    for (const a of approvals.values()) clearTimeout(a.timer);
    approvals.clear();
  }
  function request(method, params) {
    if (disposed) return Promise.reject(new Error('Codex 服务已关闭'));
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Codex 请求超时：${method}`)); }, requestTimeoutMs);
      pending.set(id, { resolve, reject, timer });
      try { write({ id, method, params }); } catch (error) { clearTimeout(timer); pending.delete(id); reject(error); }
    });
  }
  function safeMessage(error) {
    const msg = typeof error?.message === 'string' ? error.message : 'Codex 请求失败';
    return msg.replace(/(sk-[A-Za-z0-9_-]{8,}|Bearer\s+\S+)/gi, '[已隐藏]').slice(0, 500);
  }
  function replyApproval(requestId, decision) {
    const a = approvals.get(String(requestId));
    if (!a) throw new Error('审批请求不存在或已过期');
    if (!['accept', 'decline', 'cancel'].includes(decision)) throw new Error('无效的审批选择');
    clearTimeout(a.timer); approvals.delete(String(requestId));
    write({ id: a.id, result: { decision } });
  }
  function handle(message) {
    if (message.method && Object.hasOwn(message, 'id')) {
      const p = message.params || {};
      if (['item/commandExecution/requestApproval', 'item/fileChange/requestApproval'].includes(message.method) && threads.has(p.threadId)) {
        const key = String(message.id);
        const timer = setTimeout(() => { try { replyApproval(key, 'decline'); } catch (_) {} }, approvalTimeoutMs);
        approvals.set(key, { id: message.id, timer });
        emit({ type: 'approval-request', threadId: p.threadId, turnId: p.turnId, requestId: key,
          kind: message.method === 'item/commandExecution/requestApproval' ? 'command' : 'file',
          command: p.command || null, cwd: p.cwd || null, reason: p.reason || null, grantRoot: p.grantRoot || null });
      } else {
        // Unsupported server requests must not silently approve or block a turn.
        write({ id: message.id, error: { code: -32601, message: 'Request unsupported by this client' } });
      }
      return;
    }
    if (Object.hasOwn(message, 'id')) {
      const p = pending.get(message.id); if (!p) return;
      clearTimeout(p.timer); pending.delete(message.id);
      if (message.error) p.reject(new Error(safeMessage(message.error))); else p.resolve(message.result);
      return;
    }
    const p = message.params || {}, threadId = p.threadId;
    if (!threads.has(threadId)) return;
    if (message.method === 'item/agentMessage/delta' && typeof p.delta === 'string') {
      emit({ type: 'delta', threadId, turnId: p.turnId, itemId: p.itemId, delta: p.delta });
    } else if (message.method === 'turn/started') {
      emit({ type: 'turn-started', threadId, turnId: p.turn?.id });
    } else if (message.method === 'turn/completed') {
      emit({ type: 'turn-completed', threadId, turnId: p.turn?.id, status: p.turn?.status, error: p.turn?.error ? safeMessage(p.turn.error) : null });
    } else if (message.method === 'error') {
      emit({ type: 'error', threadId, turnId: p.turnId, message: safeMessage(p.error) });
    }
  }
  function start() {
    if (disposed) return Promise.reject(new Error('Codex 服务已关闭'));
    if (ready) return ready;
    ready = (async () => {
      child = spawnProcess(command, ['app-server'], { stdio: ['pipe', 'pipe', 'pipe'], shell: false });
      child.stdin.on('error', () => failPending('Codex 服务连接已断开'));
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', chunk => {
        buffer += chunk;
        if (buffer.length > 8 * 1024 * 1024) { child.kill(); return; }
        let index;
        while ((index = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
          try { handle(JSON.parse(line)); } catch (_) { /* Invalid server messages are ignored. */ }
        }
      });
      child.stderr.resume(); // Do not expose logs: they may contain local or account data.
      child.on('error', () => { failPending('无法启动 Codex，请检查 Codex 是否已安装'); emit({ type: 'error', message: '无法启动 Codex，请检查 Codex 是否已安装' }); });
      child.on('close', () => { failPending('Codex 服务已退出'); if (!disposed) emit({ type: 'error', message: 'Codex 服务已退出' }); });
      try {
        await request('initialize', { clientInfo: { name: 'neko_workbench', title: 'N.E.K.O. Workbench', version: '0.1.0' }, capabilities: null });
        write({ method: 'initialized' });
      } catch (error) {
        child.kill();
        throw error;
      }
    })();
    return ready;
  }
  async function projectPath(cwd) {
    if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) throw new Error('请选择有效的项目目录');
    let resolved;
    try { resolved = await fs.realpath(cwd); if (!(await fs.stat(resolved)).isDirectory()) throw new Error(); }
    catch (_) { throw new Error('项目目录不存在或无法访问'); }
    return resolved;
  }
  function requireThread(threadId) {
    if (!threads.has(threadId)) throw new Error('此 Codex 会话不属于当前工作台');
  }
  return {
    async createSession({ cwd }) {
      const dir = await projectPath(cwd); await start();
      const result = await request('thread/start', { cwd: dir, sandbox: 'workspace-write', approvalPolicy: 'on-request' });
      if (!result?.thread?.id || !result.cwd || await projectPath(result.cwd) !== dir) throw new Error('Codex 未创建所选项目的会话');
      const threadId = result.thread.id; threads.set(threadId, dir); return { threadId };
    },
    async resumeSession({ cwd, threadId }) {
      const dir = await projectPath(cwd); await start();
      if (typeof threadId !== 'string' || !threadId) throw new Error('无效的会话');
      // The main process must only supply IDs persisted by this workbench.
      const metadata = await request('thread/read', { threadId, includeTurns: false });
      if (!metadata?.thread?.cwd || await projectPath(metadata.thread.cwd) !== dir) throw new Error('Codex 会话与所选项目不匹配');
      const result = await request('thread/resume', { threadId, cwd: dir, sandbox: 'workspace-write', approvalPolicy: 'on-request', excludeTurns: true });
      if (result?.thread?.id !== threadId) throw new Error('Codex 会话恢复失败');
      threads.set(threadId, dir); return { threadId };
    },
    async sendMessage({ threadId, text }) {
      requireThread(threadId);
      if (typeof text !== 'string' || !text.trim() || text.length > 200000) throw new Error('请输入有效的消息');
      const result = await request('turn/start', { threadId, input: [{ type: 'text', text, text_elements: [] }] });
      if (!result?.turn?.id) throw new Error('Codex 未能启动任务');
      return { turnId: result.turn.id };
    },
    async cancel({ threadId, turnId }) {
      requireThread(threadId);
      if (typeof turnId !== 'string' || !turnId) throw new Error('无效的任务');
      await request('turn/interrupt', { threadId, turnId });
    },
    respondApproval({ requestId, decision }) { replyApproval(requestId, decision); },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const key of [...approvals.keys()]) { try { replyApproval(key, 'decline'); } catch (_) {} }
      failPending('Codex 服务已关闭');
      if (child) { child.stdin.end(); child.kill(); }
      threads.clear();
    }
  };
}
module.exports = { createCodexAdapter, findCodexCommand };
