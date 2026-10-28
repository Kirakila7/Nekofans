'use strict';
const fs = require('node:fs'), path = require('node:path');
const { pathToFileURL } = require('node:url');
const { install } = require('./install.cjs');
const { RUNTIME, hasScope } = require('./runtime-state.cjs');
const { qqDiagnostics } = require('./diagnostics.cjs');
const { createPrivatePairing } = require('./private-pairing.cjs');
const privatePairing = createPrivatePairing({ readConfig: config });
const GUARD = Symbol.for('neko.qqbot.connection.guard');
let context = null, entryId = null, entryContext = null, enabled = false, generation = 0;
let pending = null, stopping = null, updateTail = Promise.resolve(), aborter = null;
let profileRoot = '', pluginDir = '';
let pendingModel = false, accountWatch = null, accountService = null, accountEpoch = 0, accountStatus = null;
let state = { phase: 'paused', reason: 'QQ 机器人未启动。', bound: false, connected: false, scopeConfigured: false };
const counterKeys = ['received', 'accessDenied', 'accessAllowed', 'handlerEntered', 'inactiveDropped', 'bodyReady', 'modelQueued'];
let counters = Object.fromEntries(counterKeys.map(key => [key, 0]));
const reasons = {
  starting: '正在准备 QQ 机器人插件…',
  'model-login-required': '请登录工作台左下角的账号，登录后自动继续；可用额度暂未确认。',
  'login-required': '请扫码绑定 QQ 机器人；绑定完成后还需连接网关。',
  'scope-required': 'QQ 机器人已绑定，请先选择私聊或群聊服务范围。',
  connecting: 'QQ 机器人已绑定，正在连接网关；消息收发尚未验证。',
  running: 'QQ 网关已连接；实际消息收发和账号扣费仍需验证。',
  error: 'QQ 连接或授权失败，请检查网络和绑定状态后重试。',
  paused: 'QQ 机器人已暂停。',
};
function snapshot() { return { enabled, ...state }; }
function publish(patch) {
  state = { ...state, ...patch };
  process.emit('neko-qqbot-state', snapshot());
  return snapshot();
}
function trusted(req) {
  try {
    const conn = context?.get?.('connection');
    if (!enabled || !conn || typeof conn.requestRejection !== 'function') return false;
    const value = conn.requestRejection(req);
    return value === undefined || value === null || value === false;
  } catch { return false; }
}
function config() {
  const yaml = require(path.join(profileRoot, 'node_modules/js-yaml'));
  const entries = yaml.load(fs.readFileSync(path.join(profileRoot, 'cordis.patch.yml'), 'utf8'));
  if (!Array.isArray(entries)) throw Error('QQ 配置不可读取');
  const saved = entries.find(e => e && e.id === 'im-qqbot')?.config || {};
  const access = { c2cMode: 'disabled', c2cAllow: [], groupMode: 'disabled', groupAllow: [] };
  for (const key of ['c2c', 'group']) {
    if (['open', 'allowlist', 'disabled'].includes(saved.access?.[`${key}Mode`])) access[`${key}Mode`] = saved.access[`${key}Mode`];
    if (Array.isArray(saved.access?.[`${key}Allow`])) access[`${key}Allow`] = saved.access[`${key}Allow`].filter(value => typeof value === 'string' && value.trim().length > 0);
  }
  return { ...saved, appId: typeof saved.appId === 'string' ? saved.appId : '', appSecret: typeof saved.appSecret === 'string' ? saved.appSecret : '', cwd: path.join(profileRoot, 'workspace'), access, sendFile: { restrictPaths: true, extraRoots: [], sendPresentedFiles: false, maxFiles: 0 }, media: { enabled: false, maxMB: 0, ttlHours: 24 }, debug: false };
}
function projectConfig(value) {
  const bound = Boolean(value.appId && value.appSecret), scopeConfigured = hasScope(value.access);
  const phase = !bound ? 'login-required' : !scopeConfigured ? 'scope-required' : 'connecting';
  publish({ phase, reason: reasons[phase], bound, connected: false, scopeConfigured });
}
function runtimeFor(revision) {
  return {
    active: () => enabled && revision === generation,
    capture(message) { return enabled && revision === generation && privatePairing.capture(message); },
    mark(key) {
      if (enabled && revision === generation && counterKeys.includes(key)) counters[key] = Math.min(counters[key] + 1, 1000000);
    },
    report(phase) {
      if (!enabled || revision !== generation || !Object.hasOwn(reasons, phase)) return;
      if (phase === 'running' && !state.scopeConfigured) phase = 'scope-required';
      publish({ phase, reason: reasons[phase], connected: phase === 'running',
        ...(phase === 'login-required' ? { bound: false } : {}),
        ...(['connecting', 'running', 'scope-required'].includes(phase) ? { bound: true } : {}) });
    },
  };
}
async function removeEntry(id, owner) {
  if (!id || !owner?.loader) return;
  const entry = owner.loader.resolve(id);
  owner.loader.remove(id);
  if (entryId === id && entryContext === owner) { entryId = null; entryContext = null; }
  await entry?.fiber?.dispose?.();
}
function refresh() {
  const revision = generation, starting = pending;
  updateTail = updateTail.then(async () => {
    if (starting) await starting;
    if (!enabled || !entryId || revision !== generation) return;
    const owner = entryContext, value = config();
    projectConfig(value);
    await owner.loader.update(entryId, { config: value });
    await owner.loader.await();
  }).catch(() => {
    if (revision === generation && enabled) publish({ phase: 'error', reason: 'QQ 配置保存后重新加载失败，请暂停并重试。', connected: false });
  });
}
function accountChanged(view) {
  accountEpoch++;
  accountStatus = view?.status;
  if (accountStatus !== 'credential-stored') {
    // Invalidate immediately: never await a pending start inside the watch loop.
    if (enabled && !pendingModel) void pause();
    return;
  }
  if (!enabled || !pendingModel) return;
  const revision = generation;
  void Promise.resolve(pending).then(() => {
    if (enabled && pendingModel && revision === generation && accountStatus === 'credential-stored') {
      pendingModel = false; enabled = false;
      return start();
    }
  });
}
async function start() {
  const requestedGeneration = generation;
  if (stopping) {
    await stopping;
    if (requestedGeneration !== generation) return snapshot();
  }
  if (pending) return pending;
  if (enabled && state.phase === 'error') await pause();
  if (enabled) return snapshot();
  const revision = ++generation, owner = context;
  privatePairing.cancel();
  counters = Object.fromEntries(counterKeys.map(key => [key, 0]));
  enabled = true;
  publish({ phase: 'starting', reason: reasons.starting, connected: false });
  const controller = new AbortController(); aborter = controller;
  pending = (async () => {
    let id = null;
    try {
      if (!owner?.loader || typeof owner.loader.create !== 'function') throw Error('loader unavailable');
      pendingModel = true;
      let account = accountService;
      try { account ??= owner.get?.('deepseekAccount'); } catch {}
      const epoch = accountEpoch;
      const view = account?.getState ? await account.getState() : null;
      if (revision !== generation) return snapshot();
      const status = epoch === accountEpoch ? view?.status : accountStatus;
      if (status !== 'credential-stored') {
        publish({ phase: 'model-login-required', reason: reasons['model-login-required'], connected: false });
        return snapshot();
      }
      pendingModel = false;
      const data = process.env.NEKO_WORKBENCH_DATA_DIR, modules = process.env.NEKO_WORKBENCH_DSH_MODULES;
      if (!data || !path.isAbsolute(data) || !modules || !path.isAbsolute(modules)) throw Error('runtime unavailable');
      profileRoot = path.join(data, 'qqbot-runtime');
      const installed = await install(profileRoot, modules, { signal: controller.signal });
      if (revision !== generation) return snapshot();
      pluginDir = installed.pkg;
      fs.mkdirSync(path.join(profileRoot, 'workspace'), { recursive: true, mode: 0o700 });
      process.env.NEKO_WORKBENCH_QQBOT_PROFILE = profileRoot;
      globalThis[GUARD] = trusted;
      globalThis[RUNTIME] = () => runtimeFor(revision);
      const value = config(); projectConfig(value);
      id = await owner.loader.create({ id: 'neko-qqbot-active', name: pathToFileURL(path.join(pluginDir, 'dist/index.js')).href, config: value });
      entryId = id; entryContext = owner;
      await owner.loader.await();
      if (revision !== generation) { await removeEntry(id, owner); return snapshot(); }
      const entry = owner.loader.resolve(id);
      if (!entry?.fiber || entry.fiber.state !== 2) throw Error('plugin did not load');
      return snapshot();
    } catch {
      if (id) { try { await removeEntry(id, owner); } catch {} }
      if (revision === generation) {
        enabled = false;
        publish({ phase: 'error', reason: 'QQ 插件准备或加载失败，请检查 npm、网络和 DSH 运行环境后重试。', connected: false });
      }
      return snapshot();
    }
  })().finally(() => { pending = null; if (aborter === controller) aborter = null; });
  return pending;
}
function pause() {
  privatePairing.cancel();
  ++generation; aborter?.abort(); enabled = false; pendingModel = false;
  publish({ phase: 'paused', reason: reasons.paused, connected: false });
  if (stopping) return stopping;
  const inflight = pending;
  stopping = (async () => {
    if (inflight) await inflight;
    await updateTail;
    try { await removeEntry(entryId, entryContext); }
    catch { publish({ phase: 'error', reason: 'QQ 机器人停止状态未能确认。', connected: false }); }
    return snapshot();
  })().finally(() => { stopping = null; });
  return stopping;
}
async function qqbotAction(action) {
  if (action === 'status') return snapshot();
  if (action === 'start') return start();
  if (action === 'pause') return pause();
  throw Error('未知 QQ 机器人操作');
}
exports.name = 'neko-qqbot-workbench';
exports.inject = ['loader', 'connection'];
exports.apply = function apply(ctx) {
  context = ctx;
  process.on('neko-qqbot-config-changed', refresh);
  ctx.inject(['deepseekAccount'], scoped => {
    accountWatch?.abort();
    accountService = scoped.deepseekAccount;
    const controller = new AbortController(); accountWatch = controller;
    if (accountService?.watch) void (async () => {
      try {
        for await (const view of accountService.watch(controller.signal)) {
          if (controller.signal.aborted) break;
          accountChanged(view);
        }
      } catch { if (!controller.signal.aborted) accountChanged(null); }
    })();
    scoped.effect?.(() => () => {
      controller.abort();
      if (accountWatch === controller) { accountService = null; accountChanged(null); }
    }, 'neko.qqbot.account');
  });
  ctx.inject(['webServer'], scoped => {
    const dispose = scoped.webServer.register({ kind: 'exact', path: '/qqbot-workbench/client.js', handler(req, res) {
      if (!trusted(req)) { res.statusCode = 403; res.end(); return; }
      if (req.method !== 'GET' || !entryId || !pluginDir) { res.statusCode = 404; res.end(); return; }
      try {
        const content = fs.readFileSync(path.join(pluginDir, 'lib/client.js'));
        res.writeHead(200, { 'content-type': 'application/javascript; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
        res.end(content);
      } catch { res.statusCode = 503; res.end(); }
    } });
    const disposeDiagnostics = scoped.webServer.register({ kind: 'exact', path: '/qqbot-workbench/diagnostics', handler(req, res) {
      if (!trusted(req)) { res.statusCode = 403; res.end(); return; }
      if (req.method !== 'GET') { res.statusCode = 405; res.end(); return; }
      let buffer;
      try { buffer = context?.logger?.buffer; } catch {}
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
      res.end(JSON.stringify({ available: Array.isArray(buffer), records: Array.isArray(buffer) ? Math.min(buffer.length, 1000) : 0, counters: { ...counters }, ...qqDiagnostics(buffer) }));
    } });
    const disposePairing = scoped.webServer.register({ kind: 'exact', path: '/qqbot-workbench/private-pairing', async handler(req, res) {
      if (!trusted(req)) { res.statusCode = 403; res.end(); return; }
      const send = (status, value) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }); res.end(JSON.stringify(value)); };
      if (req.method === 'GET') { send(200, privatePairing.status()); return; }
      if (req.method !== 'POST') { send(405, { ok: false }); return; }
      try {
        let body = '';
        for await (const chunk of req) { body += chunk; if (body.length > 1024) throw Error(); }
        const { action } = JSON.parse(body);
        if (action === 'cancel') { privatePairing.cancel(); send(200, { ok: true }); return; }
        if (!enabled || state.phase !== 'running') { send(409, { ok: false, code: 'PAIRING_NOT_CONNECTED' }); return; }
        if (action === 'begin') { send(200, privatePairing.begin()); return; }
        if (action !== 'confirm') { send(400, { ok: false }); return; }
        const revision = generation;
        const { updateProfileConfig } = await import(pathToFileURL(path.join(pluginDir, 'dist/setup/persist.js')).href);
        if (revision !== generation || !trusted(req)) { send(409, { ok: false, code: 'PAIRING_CANCELLED' }); return; }
        send(200, privatePairing.confirm(access => updateProfileConfig({ access }, profileRoot, { info() {}, warn() {} })));
      } catch (error) {
        const code = ['PAIRING_SCOPE_CHANGED', 'PAIRING_NOT_MATCHED', 'PAIRING_SAVE_FAILED'].includes(error?.code) ? error.code : 'PAIRING_REQUEST_FAILED';
        send(400, { ok: false, code });
      }
    } });
    scoped.effect(() => () => { dispose(); disposeDiagnostics(); disposePairing(); }, 'neko.qqbot.client');
  });
  ctx.on('dispose', async () => {
    process.removeListener('neko-qqbot-config-changed', refresh);
    accountWatch?.abort(); accountService = null;
    delete globalThis[GUARD]; delete globalThis[RUNTIME];
    await pause();
    if (context === ctx) context = null;
  });
};
exports.qqbotAction = qqbotAction;
