'use strict';
// Read-only official app-server client. Tokens, account identifiers and upstream
// diagnostics never cross the workbench IPC boundary or enter its state files.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');

function resolveCodex({ env = process.env, home = os.homedir(), exists = fs.existsSync } = {}) {
  const candidates = env.NEKO_WORKBENCH_CODEX_CLI ? [env.NEKO_WORKBENCH_CODEX_CLI] : [
    path.join(home, '.local/bin/codex'), path.join(home, '.codex/bin/codex'),
    '/opt/homebrew/bin/codex', '/usr/local/bin/codex',
    ...(env.PATH || '').split(path.delimiter).filter(p => path.isAbsolute(p)).map(p => path.join(p, process.platform === 'win32' ? 'codex.exe' : 'codex')),
  ];
  return candidates.find(p => path.isAbsolute(p) && exists(p)) || null;
}

function normalizeRateLimits(result) {
  const multi = result?.rateLimitsByLimitId;
  const entries = multi && typeof multi === 'object' && !Array.isArray(multi) && Object.keys(multi).length
    ? Object.entries(multi) : result?.rateLimits ? [[result.rateLimits.limitId || 'codex', result.rateLimits]] : [];
  const buckets = entries.slice(0, 12).flatMap(([id, value]) => {
    if (!value || typeof value !== 'object') return [];
    const windows = ['primary', 'secondary'].flatMap(key => {
      const w = value[key];
      if (!w || typeof w.usedPercent !== 'number' || !Number.isFinite(w.usedPercent)) return [];
      const usedPercent = Math.min(100, Math.max(0, w.usedPercent));
      return [{ usedPercent, remainingPercent: 100 - usedPercent,
        windowDurationMins: Number.isFinite(w.windowDurationMins) && w.windowDurationMins > 0 ? w.windowDurationMins : null,
        resetsAt: Number.isFinite(w.resetsAt) && w.resetsAt > 0 ? w.resetsAt : null }];
    });
    return [{ id: String(id).slice(0, 80), name: typeof value.limitName === 'string' ? value.limitName.slice(0, 80) : String(id).slice(0, 80), windows }];
  });
  return { buckets, ordinaryUsageAllowed: typeof result?.ordinaryUsageAllowed === 'boolean' ? result.ordinaryUsageAllowed : null };
}

function accountSummary(result) {
  const account = result?.account;
  if (!account) return { status: result?.requiresOpenaiAuth === false ? 'external' : 'signed-out', authType: null, planType: null };
  return { status: 'signed-in', authType: ['chatgpt', 'apiKey', 'amazonBedrock'].includes(account.type) ? account.type : 'other',
    planType: typeof account.planType === 'string' ? account.planType.slice(0, 40) : null };
}

function openProtocol(executable, { spawnProcess = spawn, env = process.env, timeoutMs = 12000, jobs = new Set() } = {}) {
  const child = spawnProcess(executable, ['app-server', '--listen', 'stdio://'], {
    cwd: os.tmpdir(), env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: false,
  });
  const waiting = new Map();
  let nextId = 0, buffer = '', closed = false, closePromise;
  jobs.add(child);
  function failAll() {
    for (const entry of waiting.values()) { clearTimeout(entry.timer); entry.reject(Error('Codex account service unavailable')); }
    waiting.clear();
  }
  child.once('error', failAll);
  child.once('close', () => { closed = true; jobs.delete(child); failAll(); });
  child.stdin.on('error', failAll);
  child.stderr.on('data', () => {}); // Drain without retaining or forwarding diagnostics.
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    buffer += chunk;
    if (buffer.length > 1024 * 1024) { failAll(); child.kill(); return; }
    let end;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      if (!line.trim()) continue;
      let message; try { message = JSON.parse(line); } catch { failAll(); child.kill(); return; }
      const entry = waiting.get(message.id);
      if (entry && !message.method) {
        waiting.delete(message.id); clearTimeout(entry.timer);
        if (message.error) entry.reject(Error('Codex account request failed'));
        else entry.resolve(message.result);
      } else if (message.method && message.id != null && !closed) {
        // This client never authorizes tools, inference, OAuth or remote actions.
        child.stdin.write(JSON.stringify({ id: message.id, error: { code: -32601, message: 'Read-only account client' } }) + '\n');
      }
    }
  });
  function request(method, params) {
    if (closed) return Promise.reject(Error('Codex account service closed'));
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { waiting.delete(id); reject(Error('Codex account request timed out')); }, timeoutMs);
      waiting.set(id, { resolve, reject, timer });
      child.stdin.write(JSON.stringify({ id, method, ...(params === undefined ? {} : { params }) }) + '\n');
    });
  }
  function close() {
    if (closePromise) return closePromise;
    closePromise = new Promise(resolve => {
      if (closed) return resolve();
      const term = setTimeout(() => child.kill('SIGTERM'), 500);
      const kill = setTimeout(() => child.kill('SIGKILL'), 2000);
      const deadline = setTimeout(done, 2500);
      function done() { clearTimeout(term); clearTimeout(kill); clearTimeout(deadline); resolve(); }
      child.once('close', done); child.stdin.end();
    });
    return closePromise;
  }
  return { request, notifyInitialized: () => child.stdin.write('{"method":"initialized"}\n'), close };
}

async function queryCodex(executable, { includeQuota = false, ...options } = {}) {
  const client = openProtocol(executable, options);
  try {
    await client.request('initialize', { clientInfo: { name: 'neko_workbench_accounts', version: '0.25.2' }, capabilities: null });
    client.notifyInitialized();
    const before = await client.request('account/read', { refreshToken: false });
    const summary = accountSummary(before);
    let quota = { status: 'idle', buckets: [], ordinaryUsageAllowed: null };
    if (includeQuota && summary.status === 'signed-in') {
      if (summary.authType !== 'chatgpt') quota.status = 'not-applicable';
      else {
        try {
          const raw = await client.request('account/rateLimits/read');
          const after = await client.request('account/read', { refreshToken: false });
          // Discard old-account limits when native authentication changes mid-read.
          if (JSON.stringify(before.account) !== JSON.stringify(after.account)) return { ...accountSummary(after), quota: { ...quota, status: 'unavailable' } };
          const normalized = normalizeRateLimits(raw);
          quota = { status: normalized.buckets.some(b => b.windows.length) ? 'ready' : 'unavailable', ...normalized };
        } catch { quota.status = 'unavailable'; }
      }
    }
    return { ...summary, quota };
  } finally { await client.close(); }
}

function createCodexAccountService({ env = process.env, resolveExecutable = () => resolveCodex({ env }), query = queryCodex, now = Date.now, cacheMs = 30000 } = {}) {
  const jobs = new Set();
  let disposed = false, pending = null, snapshot = null, fetched = 0, quotaFetched = 0;
  async function read({ includeQuota = false, force = false } = {}) {
    if (disposed) return { status: 'unavailable', quota: { status: 'unavailable', buckets: [] } };
    if (pending) { await pending; return read({ includeQuota, force: false }); }
    if (!force && snapshot && now() - fetched < cacheMs && (!includeQuota || quotaFetched && now() - quotaFetched < cacheMs)) return snapshot;
    pending = (async () => {
      const executable = resolveExecutable();
      let next;
      if (!executable) next = { status: 'not-installed', authType: null, planType: null, quota: { status: 'unavailable', buckets: [] } };
      else {
        try { next = await query(executable, { includeQuota, env, jobs }); }
        catch { next = { status: 'unavailable', authType: null, planType: null, quota: { status: 'unavailable', buckets: [] } }; }
      }
      if (!disposed) { fetched = now(); quotaFetched = includeQuota ? fetched : 0; snapshot = Object.freeze({ ...next, fetchedAt: new Date(fetched).toISOString() }); }
    })();
    try { await pending; } finally { pending = null; }
    return snapshot || { status: 'unavailable', quota: { status: 'unavailable', buckets: [] } };
  }
  async function dispose() {
    disposed = true;
    const waits = [...jobs].map(child => new Promise(resolve => {
      const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 2000);
      child.once('close', () => { clearTimeout(timer); resolve(); }); child.kill('SIGTERM');
    }));
    await Promise.allSettled(waits);
  }
  return { read, dispose };
}
module.exports = { resolveCodex, normalizeRateLimits, accountSummary, openProtocol, queryCodex, createCodexAccountService };
