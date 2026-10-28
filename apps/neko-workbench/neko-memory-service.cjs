'use strict';
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
function unusedPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer(); server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(error => error ? reject(error) : resolve(port)); });
  });
}
class NekoMemoryService {
  constructor({ repositoryRoot, dataDir, spawnProcess = spawn, fetchImpl = globalThis.fetch } = {}) {
    this.root = repositoryRoot; this.dataDir = dataDir; this.spawnProcess = spawnProcess; this.fetch = fetchImpl;
    this.child = null; this.url = ''; this.error = ''; this.stopping = false; this.ready = false;
  }
  async start() {
    if (this.child) throw Error('记忆服务已启动');
    const distribution = path.resolve(this.root, '..');
    const python = process.env.NEKO_MEMORY_PYTHON || path.join(distribution, 'memory-runtime', 'python.exe');
    const launcher = path.join(this.root, 'services', 'neko-memory', 'workbench-launcher.py');
    if (!fs.existsSync(python) || !fs.existsSync(launcher)) throw Error('N.E.K.O. 记忆组件不完整');
    const port = await unusedPort(); this.url = `http://127.0.0.1:${port}`; this.stopping = false;
    const child = this.spawnProcess(python, ['-u', launcher, '--enable-shutdown'], {
      cwd: this.root, windowsHide: true, stdio: 'ignore',
      env: { ...process.env, PYTHONUTF8: '1', NEKO_MEMORY_LLM: 'free', NEKO_MEMORY_SERVER_PORT: String(port),
        NEKO_DATA_ROOT: path.join(this.dataDir, 'neko-memory') },
    });
    this.child = child;
    let processError = null; child.once('error', error => { processError = error; });
    child.once('exit', () => { if (this.child === child) { this.child = null; this.ready = false; if (!this.stopping) this.error = 'N.E.K.O. 记忆服务已停止'; } });
    const deadline = Date.now() + 45000;
    while (Date.now() < deadline && this.child === child && !processError) {
      try {
        const health = await this.request('/health', { timeoutMs: 1200 });
        if (health.app === 'N.E.K.O' && health.service === 'memory' && health.status === 'ok') {
          const created = await this.request('/register', { method: 'POST', body: { character_id: 'character_00000000000000000000000000002704', name: '大肥鱼' }, timeoutMs: 5000 });
          if (!created.success && !String(created.message || '').includes('already exists')) throw Error('记忆角色注册失败');
          if (created.success) { const reloaded = await this.request('/reload', { method: 'POST', body: {}, timeoutMs: 20000 }); if (reloaded.status !== 'success') throw Error('记忆角色加载失败'); }
          this.error = ''; this.ready = true; return this;
        }
      } catch (error) { if (error.message === '记忆角色注册失败' || error.message === '记忆角色加载失败') { await this.close(); throw error; } }
      await pause(350);
    }
    await this.close(); throw Error('N.E.K.O. 记忆服务启动失败');
  }
  async request(route, { method = 'GET', body, timeoutMs = 10000 } = {}) {
    if (!this.url) throw Error('记忆服务未启动');
    const response = await this.fetch(this.url + route, { method, ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }), signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) throw Error(`记忆服务错误（${response.status}）`);
    const result = response.headers.get('content-type')?.includes('application/json') ? await response.json() : await response.text();
    if (result?.status === 'error' || result?.error_code) throw Error('记忆服务操作失败');
    return result;
  }
  async close() {
    this.ready = false; const child = this.child; if (!child) return;
    this.stopping = true;
    try { await this.request('/shutdown', { method: 'POST', body: {}, timeoutMs: 1500 }); } catch {}
    const deadline = Date.now() + 2500; while (this.child === child && Date.now() < deadline) await pause(50);
    if (this.child === child) child.kill(); this.child = null;
  }
}
module.exports = { NekoMemoryService };
