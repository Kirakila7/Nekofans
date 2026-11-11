'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execFileAsync = promisify(execFile);
const ARCHIVE = path.join(__dirname,'upstream','tencent-connect-dsh-qqbot-0.5.3.tgz');
const SHA = 'f4b2280792ea95a550f9a95e96be7b437973ed07a32408463409de67ac7b6986';
const NPM_ARGS = ['ci','--ignore-scripts','--no-audit','--no-fund','--legacy-peer-deps','--omit=dev'];
function npmError(code, message) { return Object.assign(new Error(message), { code }); }
function npmCli(file) {
  try {
    if (!path.isAbsolute(file)) return null;
    const resolved = fs.realpathSync(file);
    if (path.basename(resolved) !== 'npm-cli.js' || !fs.statSync(resolved).isFile()) return null;
    const manifest = JSON.parse(fs.readFileSync(path.join(path.dirname(resolved),'..','package.json'),'utf8'));
    return manifest.name === 'npm' ? resolved : null;
  } catch { return null; }
}
function resolveNpmLaunch({ env = process.env, execPath = process.execPath,
  electronVersion = process.versions.electron } = {}) {
  // npm.cmd cannot be passed to execFile on Windows. Run the installed CLI
  // with Node directly; never interpolate environment paths into a shell.
  const explicitNode = env.DSH_DESKTOP_NODE_EXECUTABLE;
  let command = execPath;
  if (explicitNode) {
    try {
      if (typeof explicitNode !== 'string' || !path.isAbsolute(explicitNode) ||
          (process.platform === 'win32' && path.extname(explicitNode).toLowerCase() !== '.exe') ||
          !fs.statSync(explicitNode).isFile()) throw Error();
      fs.accessSync(explicitNode,fs.constants.X_OK);
      command = fs.realpathSync(explicitNode);
    } catch { throw npmError('QQ_NODE_INVALID','DSH_DESKTOP_NODE_EXECUTABLE 必须指向已安装的 Node 可执行文件。'); }
  }
  let cli;
  if (env.npm_execpath) {
    cli = npmCli(env.npm_execpath);
    if (!cli) throw npmError('QQ_NPM_INVALID','npm_execpath 配置无效，请将其指向已安装的 npm-cli.js 或清除此设置。');
  } else {
    // Covers Windows Node installs, Unix prefixes, and npm symlinks on PATH.
    const pathKey = Object.keys(env).find(key => key.toLowerCase() === 'path');
    const dirs = [path.dirname(command),path.dirname(execPath),
      ...String(env[pathKey] || '').split(path.delimiter).map(dir => dir.replace(/^"|"$/g,''))];
    for (const dir of new Set(dirs)) {
      if (!path.isAbsolute(dir)) continue;
      for (const file of [path.join(dir,'node_modules/npm/bin/npm-cli.js'),
        path.join(dir,'../lib/node_modules/npm/bin/npm-cli.js'),path.join(dir,'npm')]) {
        cli = npmCli(file);
        if (cli) break;
      }
      if (cli) break;
    }
    if (!cli) throw npmError('QQ_NPM_MISSING','未找到 npm-cli.js，请安装包含 npm 的 Node.js 后重试。');
  }
  const childEnv = { ...env, QQBOT_APPID: '', QQBOT_SECRET: '' };
  delete childEnv.ELECTRON_RUN_AS_NODE;
  if (electronVersion && fs.realpathSync(command) === fs.realpathSync(execPath)) childEnv.ELECTRON_RUN_AS_NODE = '1';
  return { command, args: [cli,...NPM_ARGS], env: childEnv };
}
function checkInstallAbort(signal) {
  if (signal?.aborted) throw Object.assign(new Error('QQ 插件依赖安装已取消。'), { name: 'AbortError', code: 'ABORT_ERR' });
}
async function runNpmInstall(root, options = {}) {
  checkInstallAbort(options.signal);
  const launch = resolveNpmLaunch(options);
  let closed;
  try {
    const pending = execFileAsync(launch.command,launch.args,{cwd:root,timeout:70000,signal:options.signal,
      maxBuffer:1024*1024,windowsHide:true,env:launch.env});
    closed = new Promise(resolve => pending.child.once('close',resolve));
    await pending;
  } catch (error) {
    // Abort rejects execFile before the process has closed its files. Wait for
    // closure so a later start cannot race an installer still holding the lock.
    if (options.signal?.aborted || error.code === 'ABORT_ERR') await closed;
    checkInstallAbort(options.signal);
    // execFile errors include command paths and captured output. Do not expose
    // those details, which may contain credentials or registry configuration.
    if (error.code === 'ABORT_ERR') throw Object.assign(new Error('QQ 插件依赖安装已取消。'), { name: 'AbortError', code: 'ABORT_ERR' });
    throw npmError('QQ_NPM_INSTALL_FAILED','QQ 插件依赖安装失败，请检查 npm 与网络后重试。');
  }
  checkInstallAbort(options.signal);
}
function replaceOnce(text, from, to, label) {
  const first = text.indexOf(from);
  if (first < 0 || text.indexOf(from, first + from.length) >= 0) throw new Error(`官方插件版本不匹配：${label}`);
  return text.slice(0,first) + to + text.slice(first + from.length);
}
function change(file,transform) { const before=fs.readFileSync(file,'utf8'); const after=transform(before); fs.writeFileSync(file,after,{encoding:'utf8',mode:0o600}); }
function ensureDir(dir) {
  fs.mkdirSync(dir,{recursive:true,mode:0o700});
  const st=fs.lstatSync(dir);if(!st.isDirectory()||st.isSymbolicLink())throw Error('QQ 数据目录不可用');
  fs.chmodSync(dir,0o700);
}
function prepareProfile(root) {
  ensureDir(root);
  const profile=path.join(root,'cordis.patch.yml');
  try { const fd=fs.openSync(profile,'wx',0o600);fs.writeFileSync(fd,'[]\n');fs.closeSync(fd); }
  catch(e){ if(e.code!=='EEXIST')throw e; const st=fs.lstatSync(profile);if(!st.isFile()||st.isSymbolicLink())throw Error('QQ 配置文件不可用');fs.chmodSync(profile,0o600); }
  return profile;
}
function adaptPlugin(root, pluginDir) {
  const stateImport = `import { createRequire as __nekoRuntimeRequire } from 'node:module';\nconst { createQQRuntime: __nekoRuntimeFor, hasScope: __nekoHasScope, guardQQBot: __nekoGuardBot } = __nekoRuntimeRequire(import.meta.url)(${JSON.stringify(path.join(__dirname,'runtime-state.cjs'))});\n`;
  const runtimeImport = (name, members) => `const { pathToFileURL: __qqPathToFileURL } = await import('node:url');\nconst { join: __qqJoin } = await import('node:path');\n${members} = await import(__qqPathToFileURL(__qqJoin(process.env.NEKO_WORKBENCH_DSH_MODULES, '${name}')).href);`;
  // Upstream uses homedir() for preferences and DSH settings, which would
  // silently mix this instance with an unrelated global QQ bot/profile.
  // Keep the adapted code fail-closed and scoped to the host-owned directory.
  const privateFiles = `
import * as __nekoFs from 'node:fs';
import * as __nekoPath from 'node:path';
// Windows reports synthetic POSIX mode bits; rely on the per-user profile ACL there.
const __nekoPosixMode = process.platform !== 'win32';
function __nekoPrivatePath(name) {
  const root = process.env.NEKO_WORKBENCH_QQBOT_PROFILE;
  const data = process.env.NEKO_WORKBENCH_DATA_DIR;
  if (!root || !data || !__nekoPath.isAbsolute(root) || !__nekoPath.isAbsolute(data) ||
      __nekoPath.resolve(root) !== __nekoPath.resolve(data, 'qqbot-runtime') ||
      !['settings.yaml', 'model-prefs.json'].includes(name)) throw Error('QQ profile unavailable');
  const parent = __nekoFs.lstatSync(data);
  if (!parent.isDirectory() || parent.isSymbolicLink() ||
      (typeof process.getuid === 'function' && parent.uid !== process.getuid())) throw Error('QQ profile unavailable');
  const st = __nekoFs.lstatSync(root);
  if (!st.isDirectory() || st.isSymbolicLink() || (__nekoPosixMode && (st.mode & 0o077) !== 0) ||
      (typeof process.getuid === 'function' && st.uid !== process.getuid())) throw Error('QQ profile unavailable');
  return __nekoPath.join(root, name);
}
function __nekoFileOK(fd) {
  const st = __nekoFs.fstatSync(fd);
  if (!st.isFile() || st.nlink !== 1 || (typeof process.getuid === 'function' && st.uid !== process.getuid())) throw Error('QQ profile file unavailable');
  return st;
}
function __nekoReadPrivate(file) {
  const fd = __nekoFs.openSync(file, __nekoFs.constants.O_RDONLY | __nekoFs.constants.O_NOFOLLOW);
  try {
    const st = __nekoFileOK(fd);
    if (__nekoPosixMode && (st.mode & 0o077) !== 0) throw Error('QQ profile file unavailable');
    return __nekoFs.readFileSync(fd, 'utf8');
  } finally { __nekoFs.closeSync(fd); }
}
function __nekoWritePrivate(file, value) {
  const fd = __nekoFs.openSync(file, __nekoFs.constants.O_WRONLY | __nekoFs.constants.O_CREAT | __nekoFs.constants.O_NOFOLLOW, 0o600);
  try {
    __nekoFileOK(fd);
    __nekoFs.fchmodSync(fd, 0o600);
    __nekoFs.ftruncateSync(fd, 0);
    __nekoFs.writeFileSync(fd, value, 'utf8');
  } finally { __nekoFs.closeSync(fd); }
}
`;
  change(path.join(pluginDir,'dist/model/settings-reader.js'),s=>{
    s=replaceOnce(s,"import { homedir } from 'node:os';",privateFiles,'settings private helpers');
    s=replaceOnce(s,"const settingsPath = resolve(homedir(), '.dsh', 'settings.yaml');","const settingsPath = __nekoPrivatePath('settings.yaml');",'private model settings');
    return replaceOnce(s,"const content = readFileSync(settingsPath, 'utf8');","const content = __nekoReadPrivate(settingsPath);",'private settings read');
  });
  change(path.join(pluginDir,'dist/model/prefs-store.js'),s=>{
    s=replaceOnce(s,"import { homedir } from 'node:os';",privateFiles,'preferences private helpers');
    s=replaceOnce(s,"this.prefsPath = resolve(homedir(), '.dsh-qqbot', 'model-prefs.json');","this.prefsPath = __nekoPrivatePath('model-prefs.json');",'private preferences path');
    s=replaceOnce(s,"const content = readFileSync(this.prefsPath, 'utf8');","const content = __nekoReadPrivate(this.prefsPath);",'private preferences read');
    s=replaceOnce(s,"mkdirSync(dirname(this.prefsPath), { recursive: true });",'', 'private preferences directory');
    return replaceOnce(s,"writeFileSync(this.prefsPath, JSON.stringify(data, null, 2), 'utf8');","__nekoWritePrivate(this.prefsPath, JSON.stringify(data, null, 2));",'private preferences write');
  });
  change(path.join(pluginDir,'dist/config.js'),s=>{
    s=replaceOnce(s,"import Schema from '@deepseek-ai/schemastery';",runtimeImport('schemastery/lib/index.mjs','const { default: Schema }'),'schema runtime');
    s=replaceOnce(s,"    provider: Schema.string().description('LLM provider name'),","    provider: Schema.string().description('Workbench account provider (locked)'),");
    s=replaceOnce(s,"    model: Schema.string().description('Model name'),","    model: Schema.string().description('Workbench account model (locked)'),");
    return s;
  });
  change(path.join(pluginDir,'dist/session/session-manager.js'),s=>replaceOnce(s,"import { SessionId } from '@deepseek-ai/dsh-session';",runtimeImport('dsh-session/lib/index.js','const { SessionId }'),'session runtime'));
  change(path.join(pluginDir,'dist/session/session-manager.js'),s=>{
    s=stateImport+s;
    s=replaceOnce(s,'this.ctx = ctx;','this.ctx = ctx;\n        this.__nekoRuntime = __nekoRuntimeFor(ctx);','session runtime');
    s=replaceOnce(s,'async getOrCreate(scope, peerId, senderId, replyTarget) {',"async getOrCreate(scope, peerId, senderId, replyTarget) {\n        if (!this.__nekoRuntime.active()) throw Error('QQ 机器人已暂停。');",'session entry guard');
    s=replaceOnce(s,'const composed = await this.composePreset(presetId);',"const composed = await this.composePreset(presetId);\n            if (!this.__nekoRuntime.active()) throw Error('QQ 机器人已暂停。');",'session setup guard');
    s=replaceOnce(s,'catch {\n                const created = await this.agents.create({',"catch {\n                if (!this.__nekoRuntime.active()) throw Error('QQ 机器人已暂停。');\n                const created = await this.agents.create({",'late create guard');
    const from=s.indexOf('    async composePreset(presetId) {');
    const to=s.indexOf('    /** 获取或恢复或创建会话',from);
    if(from<0||to<0)throw Error('官方插件版本不匹配：agent preset guard');
    const guardPath=JSON.stringify(path.join(__dirname,'agent-guard.cjs'));
    const accountPath=JSON.stringify(path.join(__dirname,'..','..','account-route.cjs'));
    const method=`    async composePreset() {\n        const { createRequire } = await import('node:module');\n        const { installQQAgentGuard } = createRequire(import.meta.url)(${guardPath});\n        return { setup: installQQAgentGuard };\n    }\n`;
    s=s.slice(0,from)+method+s.slice(to);
    s=replaceOnce(s,'return `qqbot:${this.config.appId}:${scope}:${peerId}`;','return `qqbot:${this.config.appId}:chat-v1:${scope}:${peerId}`;','chat-only session namespace');
    // Every QQ session (new, resumed or already live) records the workbench
    // account route before use; a recorded selection outranks agentOptions.
    s=replaceOnce(s,'        const record = {\n            sessionKey: key,',`        const { createRequire: __nekoRouteRequire } = await import('node:module');\n        const __nekoRoute = __nekoRouteRequire(import.meta.url)(${accountPath}).accountRoute();\n        if (!this.__nekoRuntime.active()) {\n            agent.cancel({ kind: 'user' });\n            await handle?.dispose();\n            throw Error('QQ 机器人已暂停。');\n        }\n        agent.model.select(__nekoRoute);\n        const record = {\n            sessionKey: key,`,'pin account route');
    s=replaceOnce(s,'async setModelOverride(scope, peerId, route) {',"async setModelOverride(scope, peerId, route) {\n        throw new Error('QQ 会话暂不支持远程切换模型。');",'disable model override');
    s=replaceOnce(s,'async rebuildSession(record, options) {',"async rebuildSession(record, options) {\n        throw new Error('QQ 会话暂不支持远程重建。');",'disable rebuild');
    return replaceOnce(s,'if (live) {\n            agent = live;',`if (live) {\n            const { createRequire: __nekoCreateRequire } = await import('node:module');\n            const { installQQAgentGuard: __nekoInstallGuard } = __nekoCreateRequire(import.meta.url)(${JSON.stringify(path.join(__dirname,'agent-guard.cjs'))});\n            await __nekoInstallGuard(live.ctx);\n            agent = live;`,'live agent guard');
  });
  change(path.join(pluginDir,'dist/model/model-resolver.js'),s=>{
    const accountPath=JSON.stringify(path.join(__dirname,'..','..','account-route.cjs'));
    s=replaceOnce(s,'import { PrefsStore } from "./prefs-store.js";',`import { PrefsStore } from "./prefs-store.js";\nimport { createRequire as __nekoCreateRequire } from 'node:module';\nconst { accountRoute: __nekoAccountRoute } = __nekoCreateRequire(import.meta.url)(${accountPath});`,'account route import');
    // Stale per-peer overrides, plugin config, settings.yaml and the upstream
    // deepseek-official fallback must not pick a different key or model.
    s=replaceOnce(s,'    getEffectiveRoute(sessionKey) {','    getEffectiveRoute(sessionKey) {\n        return __nekoAccountRoute();','effective route');
    s=replaceOnce(s,'    getResumeRoute(sessionKey) {','    getResumeRoute(sessionKey) {\n        return __nekoAccountRoute();','resume route');
    return replaceOnce(s,'    resolveDefault() {','    resolveDefault() {\n        return __nekoAccountRoute();','default route');
  });
  change(path.join(pluginDir,'dist/commands/index.js'),s=>replaceOnce(s,'modelCommand(deps),',"{ name: 'model', category: 'agent', description: 'QQ 会话暂不支持远程切换模型', handler: async () => 'QQ 会话暂不支持远程切换模型，请在工作台配置。' },",'disable model command'));
  change(path.join(pluginDir,'dist/transport/inbound.js'),s=>replaceOnce(s,"import { createUserMessage } from '@deepseek-ai/dsh-llm';",runtimeImport('dsh-llm/lib/index.js','const { createUserMessage }'),'llm runtime'));
  change(path.join(pluginDir,'dist/media/vision-tool.js'),s=>replaceOnce(s,"import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm';",runtimeImport('dsh-llm/lib/index.js','const { BlockAssembler, createUserMessage }'),'vision runtime'));
  const persist=path.join(pluginDir,'dist/setup/persist.js');
  change(persist,s=>{
    s=replaceOnce(s,"import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';","import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync } from 'node:fs';",'persist imports');
    s=replaceOnce(s,'printEnvInstructions(credentials);',"log.warn('无法定位隔离配置目录，凭据未保存。');",'env secret logging');
    s=replaceOnce(s,'printYamlInstructions(credentials, patchPath);',"log.warn('凭据未保存，请重新尝试。');",'yaml secret logging');
    s=replaceOnce(s,"writeFileSync(patchPath, output, 'utf8');","writeFileSync(patchPath, output, { encoding: 'utf8', mode: 0o600 }); chmodSync(patchPath, 0o600); process.emit('neko-qqbot-config-changed');",'credentials write');
    const from="writeFileSync(patchPath, yaml.dump(entries), 'utf8');";
    if(s.split(from).length!==3)throw Error('官方插件版本不匹配：config writes');
    s=s.split(from).join("writeFileSync(patchPath, yaml.dump(entries), { encoding: 'utf8', mode: 0o600 }); chmodSync(patchPath, 0o600); process.emit('neko-qqbot-config-changed');");
    return s;
  });
  change(path.join(pluginDir,'dist/shared/utils.js'),s=>replaceOnce(s,"export function getProfileDir(baseDir = PLUGIN_ROOT) {","export function getProfileDir(baseDir = PLUGIN_ROOT) {\n    if (process.env.NEKO_WORKBENCH_QQBOT_PROFILE) return process.env.NEKO_WORKBENCH_QQBOT_PROFILE;",'profile path'));
  change(path.join(pluginDir,'dist/setup/bind-routes.js'),s=>replaceOnce(s,'function trusted(req) {',"function trusted(req) {\n    const guard = globalThis[Symbol.for('neko.qqbot.connection.guard')];\n    try { if (typeof guard !== 'function' || !guard(req)) return false; } catch { return false; }",'route guard'));
  change(path.join(pluginDir,'dist/index.js'),s=>{
    s=stateImport+s;
    s=replaceOnce(s,'export async function apply(ctx, config) {',"export async function apply(ctx, config) {\n    const __nekoRuntime = __nekoRuntimeFor(ctx);\n    if (!__nekoRuntime.active()) return;",'runtime lifecycle');
    s=replaceOnce(s,"let appId = resolveEnv(config.appId, 'QQBOT_APPID');","let appId = config.appId || '';",'appid env');
    s=replaceOnce(s,"let appSecret = resolveEnv(config.appSecret, 'QQBOT_SECRET');","let appSecret = config.appSecret || '';",'secret env');
    s=replaceOnce(s,'if (!appId || !appSecret) {',"if (!appId || !appSecret) {\n        __nekoRuntime.report('login-required');",'binding status');
    s=replaceOnce(s,'.then((credentials) => {',".then((credentials) => {\n            if (!__nekoRuntime.active()) return;",'late binding guard');
    s=replaceOnce(s,'if (!credentials) {',"if (!credentials) {\n                __nekoRuntime.report('error');",'binding failure status');
    s=replaceOnce(s,"logger.warn('凭据未能持久化，本次进程将使用环境变量凭据启动（重启后需重新绑定）');","__nekoRuntime.report('error');\n            logger.warn('QQ 绑定凭据保存失败，请重试。');\n            return;",'fail closed on unsaved credentials');
    s=replaceOnce(s,'// 全兜：unhandled rejection',"__nekoRuntime.report('error');\n            // 全兜：unhandled rejection",'binding exception status');
    return s;
  });
  change(path.join(pluginDir,'dist/setup/index.js'),s=>{
    s=stateImport+s;
    s=replaceOnce(s,'const service = new BindingService({ source, logger });',"const __nekoRuntime = __nekoRuntimeFor(ctx);\n    const service = new BindingService({ source, logger });\n    service.subscribe(() => {\n        if (service.currentPhase.kind === 'failed') __nekoRuntime.report('error');\n        else if (service.currentPhase.kind === 'waiting') __nekoRuntime.report('login-required');\n    });",'binding progress');
    s=replaceOnce(s,'onManualCredentials: (credentials) => {',"onManualCredentials: (credentials) => {\n                if (!__nekoRuntime.active()) return { persisted: false, error: 'QQ 机器人已暂停，请重新开始。' };",'late manual binding guard');
    s=replaceOnce(s,'export function registerBoundCredentialRoutes(ctx, logger, appId, config) {',"export function registerBoundCredentialRoutes(ctx, logger, appId, config) {\n    const __nekoRuntime = __nekoRuntimeFor(ctx);",'bound runtime');
    return replaceOnce(s,'onManualCredentials: (credentials) => persistCredentials(credentials, logger),',"onManualCredentials: (credentials) => __nekoRuntime.active() ? persistCredentials(credentials, logger) : { persisted: false, error: 'QQ 机器人已暂停，请重新开始。' },",'late rebound guard');
  });
  change(path.join(pluginDir,'dist/gateway/bootstrap.js'),s=>{
    s=stateImport+s;
    s=replaceOnce(s,'export async function bootstrapGateway(ctx, agents, config, logger) {',"export async function bootstrapGateway(ctx, agents, config, logger) {\n    const __nekoRuntime = __nekoRuntimeFor(ctx);\n    if (!__nekoRuntime.active()) return;\n    if (!__nekoHasScope(config.access) && !__nekoRuntime.allowPairing()) { __nekoRuntime.report('scope-required'); return; }\n    __nekoRuntime.report('connecting');",'gateway state');
    s=replaceOnce(s,"transport: 'websocket',","transport: 'websocket',\n        // QQ shares one intent bit for C2C/group; middleware enforces each scope.\n        intents: (1 << 25) | (1 << 26),",'QQ-only gateway intents');
    s=replaceOnce(s,"bot.on('message', async (mCtx) => {","bot.on('message', async (mCtx) => {\n        __nekoRuntime.mark('handlerEntered');\n        if (!__nekoRuntime.active()) { __nekoRuntime.mark('inactiveDropped'); return; }",'late inbound guard');
    s=replaceOnce(s,"bot.on('interaction', async (_iCtx, event) => {","bot.on('interaction', async (_iCtx, event) => {\n        if (!__nekoRuntime.active()) return;",'late interaction guard');
    s=replaceOnce(s,"bot.on('error', (err) => {","bot.on('error', (err) => {\n        __nekoRuntime.report('error');",'gateway error status');
    s=replaceOnce(s,"bot.on('disconnected', (event) => {","bot.on('disconnected', (event) => {\n            __nekoRuntime.report(event.willReconnect ? 'connecting' : 'error');",'gateway disconnected status');
    s=replaceOnce(s,"bot.on('ready', () => {","bot.on('ready', () => {\n        if (!__nekoRuntime.active()) return;\n        __nekoRuntime.report('running');",'gateway ready status');
    s=replaceOnce(s,'logger.info(`QQBot SDK initialized', '__nekoGuardBot(bot, __nekoRuntime);\n    logger.info(`QQBot SDK initialized', 'gateway send guard');
    s=replaceOnce(s,".effect(() => {\n        logger.info", ".effect(() => {\n        if (!__nekoRuntime.active()) return;\n        logger.info",'gateway start guard');
    s=replaceOnce(s,"bot.start().catch((err) => {","bot.start().catch((err) => {\n            __nekoRuntime.report('error');",'gateway start failure');
    s=replaceOnce(s,'await manager.disposeAll();\n            bot.stop();','await bot.stop();\n            await manager.disposeAll();','stop gateway before sessions');
    s=replaceOnce(s,"process.env.QQBOT_BASE_URL?.replace(/\\/+$/, '') || 'https://api.bot.qq.com'","'https://api.bot.qq.com'",'gateway origin');
    s=replaceOnce(s,"process.env.QQBOT_TOKEN_BASE_URL?.replace(/\\/+$/, '') || 'https://api.bot.qq.com'","'https://bots.qq.com'",'token origin');
    return replaceOnce(s,'registerSendFileTool(ctx, mediaSender, manager, config, logger);',"// File transfer is disabled in the workbench adapter.",'file send tool');
  });
  change(path.join(pluginDir,'dist/gateway/middleware-setup.js'),s=>{
    s=replaceOnce(s,'    bot.use(errorHandler());',"    bot.use(async (ctx, next) => {\n        manager.__nekoRuntime?.mark('received');\n        const matched = manager.__nekoRuntime?.capture?.(ctx.message);\n        if (matched || manager.__nekoRuntime?.pairingOnly?.()) { ctx.stop('private-pairing'); return; }\n        await next();\n    });\n    bot.use(errorHandler());",'inbound counter');
    s=replaceOnce(s,'onBlock: (_mCtx, reason) => {',"onBlock: (_mCtx, reason) => {\n            manager.__nekoRuntime?.mark('accessDenied');",'access counter');
    s=replaceOnce(s,'    bot.use(historyBuffer({',"    bot.use(async (_ctx, next) => { manager.__nekoRuntime?.mark('accessAllowed'); await next(); });\n    bot.use(historyBuffer({",'allowed counter');
    // The SDK otherwise treats guild as open and shares the C2C policy with
    // guild DMs. Only the two scopes represented by workbench settings exist.
    s=replaceOnce(s,'    bot.use(accessPolicy({',`    bot.use(async (ctx, next) => {\n        if (ctx.message.kind !== 'c2c' && ctx.message.kind !== 'group') {\n            ctx.stop('access:unsupported scope');\n            return;\n        }\n        await next();\n    });\n    bot.use(accessPolicy({\n        guild: { mode: 'disabled' },`,'workbench QQ scopes');
    s=replaceOnce(s,"allow: config.access.c2cAllow.length > 0 ? config.access.c2cAllow : ['*'],",'allow: config.access.c2cAllow,','private allowlist stays empty');
    return replaceOnce(s,"allow: config.access.groupAllow.length > 0 ? config.access.groupAllow : ['*'],",'allow: config.access.groupAllow,','group allowlist stays empty');
  });
  change(path.join(pluginDir,'dist/transport/inbound.js'),s=>{
    s=stateImport+s;
    const accountPath=JSON.stringify(path.join(__dirname,'..','..','account-route.cjs'));
    s=`const { accountRoute: __nekoAccountRoute } = __nekoRuntimeRequire(import.meta.url)(${accountPath});\n`+s;
    s=replaceOnce(s,'const msg = ctx.message;',"if (!manager.__nekoRuntime.active()) return;\n    const msg = ctx.message;",'inbound runtime');
    s=replaceOnce(s,'record = await manager.getOrCreate(scope, peerId, msg.senderId, replyTarget);',"record = await manager.getOrCreate(scope, peerId, msg.senderId, replyTarget);\n        if (!manager.__nekoRuntime.active()) return;",'late inbound session');
    s=replaceOnce(s,'logger.error(`ERROR creating session:',"if (!manager.__nekoRuntime.active()) return;\n        logger.error(`ERROR creating session:",'late fallback guard');
    s=replaceOnce(s,'record.agent.followup(message);',"if (!manager.__nekoRuntime.active()) return;\n    record.agent.model.select(__nekoAccountRoute());\n    record.agent.followup(message);",'per-message account route');
    s=replaceOnce(s,'    // ── 组装 agentBody', "    const continuation = manager.__nekoRuntime.companion(msg);\n    if (continuation) {\n        const reply = await continuation;\n        if (reply && manager.__nekoRuntime.canReplyCompanion(msg)) await bot.sendMarkdown(replyTarget, reply);\n        return;\n    }\n    // ── 组装 agentBody",'private companion continuation');
    const line='logger.info(`Processing: scope=${scope} peerId=${peerId} body="${agentBody.slice(0, 200)}"`);';
    s=replaceOnce(s,line,"manager.__nekoRuntime.mark('bodyReady');\n    logger.info('Processing an incoming QQ message');",'message logging');
    return replaceOnce(s,'record.agent.followup(message);',"record.agent.followup(message);\n    manager.__nekoRuntime.mark('modelQueued');\n    manager.__nekoRuntime.experience?.({messageId:msg.messageId,text:msg.content,scope});",'model queued counter');
  });
  change(path.join(pluginDir,'dist/transport/outbound.js'),s=>{
    const policyPath=JSON.stringify(path.join(__dirname,'chat-policy.cjs'));
    s=`import { createRequire as __nekoReplyRequire } from 'node:module';\nconst { chatReply: __nekoChatReply } = __nekoReplyRequire(import.meta.url)(${policyPath});\n`+s;
    // Only complete assistant messages reach QQ. Partial chunks can split a
    // protocol marker, so filtering them independently would leak the prefix.
    s=replaceOnce(s,'    appendChunk(sessionId, record, text) {','    appendChunk(sessionId, record, text) {\n        return;','buffer complete chat replies');
    s=replaceOnce(s,'    onToolResult(record, event) {','    onToolResult(record, event) {\n        return;','hide internal tool results');
    s=replaceOnce(s,'    async send(record, text, tag) {','    async send(record, text, tag) {\n        text = __nekoChatReply(text);','validate complete reply');
    return replaceOnce(s,'`⚠️ 本轮异常结束\\n\\`${failure.code}\\`: ${failure.message}`',"'本次回复未完成，请稍后重试。'",'hide internal turn errors');
  });
  change(path.join(pluginDir,'lib/client.js'),s=>{
    s=replaceOnce(s,'id: "@tencent-connect/dsh-qqbot",','id: "@bigfish/qqbot-settings",','client module id');
    s=replaceOnce(s,'function QQBotSettingsSection() {','function QQBotSettingsSection() {\n            installPanelStyles();','client styles');
    s=replaceOnce(s,'(0, react.createElement)(ConfigPanel));',
      '(0, react.createElement)("details", { className: "blw-details", "data-settings": "qq" }, (0, react.createElement)("summary", null, "QQ 详细设置"), (0, react.createElement)(ConfigPanel)));','collapse QQ settings');
    s=replaceOnce(s,'`AppID ${appId} · 私聊与群聊已接入`','"授权已保存"','concise binding status');
    s=replaceOnce(s,'(0, react.createElement)("div", { className: "imqb-status-actions" },',
      '(0, react.createElement)("details", { className: "blw-details" }, (0, react.createElement)("summary", null, "绑定详细设置"), (0, react.createElement)("p", { className: "imqb-status-sub imqb-mono" }, `AppID ${appId}`),','collapse binding management');
    s=replaceOnce(s,'}, "手动填写")));', '}, "手动填写"))));','manual credentials disclosure end');
    s=replaceOnce(s,'}, "刷新二维码"), (0, react.createElement)("button", {',
      '}, "刷新二维码"), (0, react.createElement)("details", { className: "blw-details" }, (0, react.createElement)("summary", null, "手动绑定"), (0, react.createElement)("button", {','collapse manual credentials');
    s=replaceOnce(s,'exports.apply = apply;','exports.QQBotSettingsSection = QQBotSettingsSection;\n        exports.apply = apply;','client export');
    // The native boot loader requests the package's original client ID on a
    // page reload. Satisfy it without installing upstream's duplicate menus;
    // the workbench owns mounting the aliased QR and settings section.
    return s+'\nwindow.__ModuleLoader__.load({id:"@tencent-connect/dsh-qqbot",factory:()=>({apply(){}})});\n';
  });
  fs.writeFileSync(path.join(root,'installed-adapter.json'),JSON.stringify({version:'0.5.3',revision:18})+'\n',{encoding:'utf8',mode:0o600});
}
async function install(root, modulesDir, options={}) {
  checkInstallAbort(options.signal);
  const actual=crypto.createHash('sha256').update(fs.readFileSync(ARCHIVE)).digest('hex');
  if(actual!==SHA)throw Error('QQ 官方插件包校验失败');
  const profile=prepareProfile(root), pkg=path.join(root,'node_modules/@tencent-connect/dsh-qqbot');
  const marker=path.join(root,'installed-adapter.json');
  let ready=false; try{const m=JSON.parse(fs.readFileSync(marker,'utf8'));ready=m.version==='0.5.3'&&m.revision===18&&fs.existsSync(path.join(pkg,'dist/index.js'));}catch{}
  if(!ready){
    fs.writeFileSync(path.join(root,'package.json'),JSON.stringify({name:'neko-qqbot-runtime',version:'1.0.0',private:true,dependencies:{'@tencent-connect/dsh-qqbot':'file:./dsh-qqbot.tgz'}})+'\n',{mode:0o600});
    fs.copyFileSync(ARCHIVE,path.join(root,'dsh-qqbot.tgz'));
    fs.copyFileSync(path.join(__dirname,'upstream','runtime-install.lock.json'),path.join(root,'package-lock.json'));
    await runNpmInstall(root,options);
    adaptPlugin(root,pkg);
  }
  for(const name of ['schemastery/lib/index.mjs','dsh-session/lib/index.js','dsh-llm/lib/index.js'])
    if(!fs.existsSync(path.join(modulesDir,name)))throw Error('当前 DSH 缺少 QQ 插件依赖。');
  return {profile,pkg};
}
module.exports={install,adaptPlugin,prepareProfile,resolveNpmLaunch,runNpmInstall,ARCHIVE,SHA};
