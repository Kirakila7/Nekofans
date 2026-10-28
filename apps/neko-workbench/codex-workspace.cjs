'use strict';
const { spawn } = require('node:child_process');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { resolveCodex } = require('./codex-account.cjs');
const text = (value, max = 20000) => typeof value === 'string' ? value.slice(0, max) : '';
const validId = id => typeof id === 'string' && /^[A-Za-z0-9_:-]{1,180}$/.test(id);
function threadRow(t) {
  if (!validId(t?.id) || t.ephemeral || t.parentThreadId) return null;
  return { id: t.id, provider: 'codex', title: text(t.name || t.preview || 'Codex 会话', 160), cwd: text(t.cwd, 4096), updatedAt: Number(t.updatedAt) * 1000 || 0, status: text(t.status?.type, 40), model: text(t.model, 160) };
}
function visibleItem(item) {
  if (!item || typeof item.id !== 'string') return null;
  if (item.type === 'userMessage') return { id: item.id, kind: 'user', text: (item.content || []).filter(c => c.type === 'text').map(c => text(c.text, 40000)).join('\n') };
  if (item.type === 'agentMessage') return { id: item.id, kind: 'assistant', text: text(item.text, 80000) };
  if (item.type === 'plan') return { id: item.id, kind: 'activity', title: '计划', text: text(item.text) };
  if (item.type === 'commandExecution') return { id: item.id, kind: 'activity', title: '终端 · ' + text(item.status, 50), text: text(item.command, 4000) + (item.aggregatedOutput ? '\n' + text(item.aggregatedOutput) : '') };
  if (item.type === 'fileChange') return { id: item.id, kind: 'activity', title: '文件修改 · ' + text(item.status, 50), text: (item.changes || []).slice(0, 30).map(c => text(c.path, 4096) + '\n' + text(c.diff, 10000)).join('\n\n').slice(0, 50000) };
  if (item.type === 'mcpToolCall') return { id: item.id, kind: 'activity', title: text(item.server, 100) + ' / ' + text(item.tool, 100), text: text(item.status, 80) };
  return null;
}
function createCodexWorkspace({ env = process.env, spawnProcess = spawn, resolveExecutable = () => resolveCodex({ env }), defaultCwd, onState = () => {}, timeoutMs = 25000 } = {}) {
  let child = null, ready = null, closed = false, seq = 0, selectionVersion = 0, buffer = '', selected = null, view = { status: 'idle', thread: null, items: [], approvals: [], error: '' };
  const pending = new Map(), rows = new Map(), loaded = new Set(), ownedTurns = new Map(), finishedTurns = new Set(), starting = new Set(), approvals = new Map(), roots = new Set([defaultCwd].filter(Boolean));
  const emit = () => onState(structuredClone(view));
  function failure() { return Error('Codex 本地接口暂不可用，请检查原生登录或稍后重试'); }
  function write(message) { if (!child || child.stdin.destroyed) throw failure(); child.stdin.write(JSON.stringify(message) + '\n'); }
  function failAll() { for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(failure()); } pending.clear(); }
  function request(method, params) {
    return new Promise((resolve, reject) => {
      const id = ++seq, timer = setTimeout(() => { pending.delete(id); reject(failure()); }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      try { write({ id, method, ...(params === undefined ? {} : { params }) }); } catch { clearTimeout(timer); pending.delete(id); reject(failure()); }
    });
  }
  function mergeItem(item) {
    const value = visibleItem(item); if (!value) return;
    const at = view.items.findIndex(i => i.id === value.id);
    if (at < 0) view.items.push(value); else view.items[at] = value;
    if (view.items.length > 240) view.items.splice(0, view.items.length - 240);
  }
  function notification(method, p = {}) {
    if (method === 'turn/completed') {
      ownedTurns.delete(p.threadId); if (p.turn?.id) { finishedTurns.add(p.turn.id); if (finishedTurns.size > 200) finishedTurns.delete(finishedTurns.values().next().value); }
      for (const [key, a] of approvals) if (a.threadId === p.threadId) approvals.delete(key);
      view.approvals = [...approvals.values()].map(a => a.display);
    }
    if (method === 'turn/started' && starting.has(p.threadId) && p.turn?.id) ownedTurns.set(p.threadId, p.turn.id);
    if (p.threadId !== selected) return;
    if (method === 'item/started' || method === 'item/completed') mergeItem(p.item);
    else if (method === 'item/agentMessage/delta') {
      let item = view.items.find(i => i.id === p.itemId);
      if (!item) { item = { id: p.itemId, kind: 'assistant', text: '' }; view.items.push(item); }
      item.text = (item.text + text(p.delta, 20000)).slice(-100000);
    } else if (method === 'turn/started') { view.status = 'working';  }
    else if (method === 'turn/completed') {
      view.status = p.turn?.status === 'failed' ? 'error' : 'idle';
      if (p.turn?.status === 'failed') view.error = 'Codex 本轮未完成，请检查原生账号与项目状态';
      ownedTurns.delete(selected); for (const item of p.turn?.items || []) mergeItem(item);
    } else if (method === 'thread/status/changed') view.status = p.status?.type === 'active' ? 'working' : 'idle';
    else return;
    emit();
  }
  function serverRequest(message) {
    const p = message.params || {};
    if (['item/commandExecution/requestApproval', 'item/fileChange/requestApproval'].includes(message.method) && (ownedTurns.has(p.threadId) || starting.has(p.threadId))) {
      const key = randomUUID(), display = { key, threadId: p.threadId, threadTitle: rows.get(p.threadId)?.title || 'Codex 会话', title: message.method.includes('fileChange') ? '批准文件修改' : '批准命令执行', command: text(p.command, 12000), reason: text(p.reason, 4000), cwd: text(p.cwd, 4096) };
      approvals.set(key, { id: message.id, threadId: p.threadId, display });
      view.approvals.push(display); emit();
    } else {
      // Unknown interactive extensions are never granted automatically.
      write({ id: message.id, error: { code: -32601, message: 'This workbench does not support that interactive request.' } });
    }
  }
  async function ensure() {
    if (closed) throw failure();
    if (ready) return ready;
    ready = (async () => {
      const executable = resolveExecutable(); if (!executable) throw Error('未找到本机 Codex，请先安装并登录');
      child = spawnProcess(executable, ['app-server', '--listen', 'stdio://'], { cwd: os.tmpdir(), env, stdio: ['pipe', 'pipe', 'pipe'], shell: false, windowsHide: true });
      buffer = '';
      const own = child;
      own.stderr.on('data', () => {}); own.stdin.on('error', failAll); own.once('error', failAll);
      own.once('close', () => { if (child !== own) return; child = null; ready = null; loaded.clear(); failAll(); const hadWork = ownedTurns.size || starting.size; ownedTurns.clear(); approvals.clear(); view.approvals = []; if (!closed && hadWork) { view.status = 'error'; view.error = 'Codex 连接已断开，请在原生客户端核对任务状态'; emit(); } });
      own.stdout.setEncoding('utf8'); own.stdout.on('data', chunk => {
        if (child !== own) return;
        buffer += chunk; if (buffer.length > 16 * 1024 * 1024) { failAll(); own.kill(); return; }
        let end; while ((end = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, end); buffer = buffer.slice(end + 1); if (!line.trim()) continue;
          let m; try { m = JSON.parse(line); } catch { failAll(); own.kill(); return; }
          if (m.method && m.id != null) { try { serverRequest(m); } catch { failAll(); own.kill(); } }
          else if (m.method) notification(m.method, m.params);
          else if (pending.has(m.id)) { const e = pending.get(m.id); pending.delete(m.id); clearTimeout(e.timer); m.error ? e.reject(failure()) : e.resolve(m.result); }
        }
      });
      await request('initialize', { clientInfo: { name: 'neko_workbench', title: 'N.E.K.O. 工作台', version: '0.27.0' }, capabilities: null });
      write({ method: 'initialized' });
    })();
    try { await ready; } catch (error) { ready = null; child?.kill('SIGTERM'); throw error; }
  }
  async function list() {
    await ensure(); let cursor = null, more = false; const found = [];
    for (let page = 0; page < 20; page++) {
      const result = await request('thread/list', { cursor, limit: 100, sortKey: 'updated_at', sourceKinds: ['cli', 'vscode', 'exec', 'appServer', 'unknown'], archived: false, useStateDbOnly: true });
      for (const raw of result?.data || []) { const row = threadRow(raw); if (row) { rows.set(row.id, row); if (path.isAbsolute(row.cwd)) roots.add(row.cwd); found.push(row); } }
      cursor = result?.nextCursor; more = !!cursor; if (!cursor) break;
    }
    return { sessions: found, more, status: 'ready' };
  }
  async function read(id) {
    if (!validId(id) || !rows.has(id)) throw Error('请从会话列表选择 Codex 会话');
    const version = ++selectionVersion; selected = id; await ensure();
    const metadata = await request('thread/read', { threadId: id, includeTurns: false });
    if (version !== selectionVersion) return structuredClone(view);
    const row = threadRow(metadata.thread) || rows.get(id); rows.set(id, row);
    let turns;
    try { turns = (await request('thread/turns/list', { threadId: id, limit: 20, sortDirection: 'desc', itemsView: 'full' })).data || []; turns.reverse(); }
    catch { turns = (await request('thread/read', { threadId: id, includeTurns: true })).thread?.turns || []; }
    if (version !== selectionVersion) return structuredClone(view);
    view = { status: row.status === 'active' ? 'working' : 'idle', thread: row, items: [], approvals: [...approvals.values()].map(a => a.display), error: '' };
    for (const turn of turns.slice(-30)) for (const item of turn.items || []) mergeItem(item);
    emit(); return structuredClone(view);
  }
  function allowRoot(cwd) { if (typeof cwd !== 'string' || !path.isAbsolute(cwd) || !fs.statSync(cwd).isDirectory()) throw Error('请选择存在的项目目录'); roots.add(cwd); return cwd; }
  async function send({ id = null, cwd = defaultCwd, message }) {
    if (typeof message !== 'string' || !message.trim() || message.length > 30000) throw Error('请输入 1–30000 字的任务');
    if (view.status === 'working' && selected === id) throw Error('当前会话正在运行，请等待完成或先停止');
    if (!roots.has(cwd)) throw Error('请从已有项目选择目录');
    await ensure();
    let raw;
    if (id) { if (!validId(id) || !rows.has(id)) throw Error('会话不存在'); if (!loaded.has(id)) raw = (await request('thread/resume', { threadId: id, excludeTurns: true })).thread; }
    else raw = (await request('thread/start', { cwd, ephemeral: false })).thread;
    if (raw) { const row = threadRow(raw); if (!row) throw failure(); rows.set(row.id, row); id = raw.id; loaded.add(id); }
    selected = id; ++selectionVersion; if (view.thread?.id !== id) view = { status: 'idle', thread: rows.get(id), items: [], approvals: [...approvals.values()].map(a => a.display), error: '' };
    starting.add(id);
    try {
      const result = await request('turn/start', { threadId: id, input: [{ type: 'text', text: message.trim(), text_elements: [] }] });
      const turn = result.turn;
      const finished = finishedTurns.has(turn?.id) || ['completed', 'interrupted', 'failed'].includes(turn?.status);
      if (turn?.id && !finished) ownedTurns.set(id, turn.id);
      if (selected === id) { view.status = finished ? (turn?.status === 'failed' ? 'error' : 'idle') : 'working'; view.error = ''; for (const item of turn?.items || []) mergeItem(item); emit(); }
      return structuredClone(view);
    } finally { starting.delete(id); }
  }
  async function stop() { const turnId = ownedTurns.get(selected); if (!turnId) throw Error('没有本工作台启动的运行中任务'); await request('turn/interrupt', { threadId: selected, turnId }); return { accepted: true }; }
  function approve(key, decision) {
    if (!['accept', 'decline', 'cancel'].includes(decision)) throw Error('审批选项无效'); const requestRecord = approvals.get(key);
    if (!requestRecord || !(ownedTurns.has(requestRecord.threadId) || starting.has(requestRecord.threadId))) throw Error('审批请求已结束');
    write({ id: requestRecord.id, result: { decision } }); approvals.delete(key); view.approvals = view.approvals.filter(a => a.key !== key); emit(); return true;
  }
  async function dispose() {
    closed = true;
    for (const item of approvals.values()) { try { write({ id: item.id, result: { decision: 'cancel' } }); } catch {} }
    for (const [threadId, turnId] of ownedTurns) { try { write({ id: ++seq, method: 'turn/interrupt', params: { threadId, turnId } }); } catch {} }
    const own = child; if (!own) return;
    await new Promise(resolve => { const term = setTimeout(() => own.kill('SIGTERM'), 500), kill = setTimeout(() => own.kill('SIGKILL'), 2500), deadline = setTimeout(done, 3000); function done() { clearTimeout(term); clearTimeout(kill); clearTimeout(deadline); resolve(); } own.once('close', done); own.stdin.end(); });
    failAll();
  }
  return { list, read, send, stop, approve, allowRoot, dispose, snapshot: () => structuredClone(view) };
}
module.exports = { createCodexWorkspace, threadRow, visibleItem };
