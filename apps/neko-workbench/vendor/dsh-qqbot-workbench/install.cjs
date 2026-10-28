'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execFileAsync = promisify(execFile);
const ARCHIVE = path.join(__dirname,'upstream','tencent-connect-dsh-qqbot-0.5.3.tgz');
const SHA = 'f4b2280792ea95a550f9a95e96be7b437973ed07a32408463409de67ac7b6986';
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
  const runtimeImport = (name, members) => `const { pathToFileURL: __qqPathToFileURL } = await import('node:url');\nconst { join: __qqJoin } = await import('node:path');\n${members} = await import(__qqPathToFileURL(__qqJoin(process.env.NEKO_WORKBENCH_DSH_MODULES, '${name}')).href);`;
  // Upstream uses homedir() for preferences and DSH settings, which would
  // silently mix this instance with an unrelated global QQ bot/profile.
  // Keep the adapted code fail-closed and scoped to the host-owned directory.
  const privateFiles = `
import * as __nekoFs from 'node:fs';
import * as __nekoPath from 'node:path';
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
  if (!st.isDirectory() || st.isSymbolicLink() || (st.mode & 0o077) !== 0 ||
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
    if ((st.mode & 0o077) !== 0) throw Error('QQ profile file unavailable');
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
  change(path.join(pluginDir,'dist/config.js'),s=>replaceOnce(s,"import Schema from '@deepseek-ai/schemastery';",runtimeImport('schemastery/lib/index.mjs','const { default: Schema }'),'schema runtime'));
  change(path.join(pluginDir,'dist/session/session-manager.js'),s=>replaceOnce(s,"import { SessionId } from '@deepseek-ai/dsh-session';",runtimeImport('dsh-session/lib/index.js','const { SessionId }'),'session runtime'));
  change(path.join(pluginDir,'dist/session/session-manager.js'),s=>{
    const from=s.indexOf('    async composePreset(presetId) {');
    const to=s.indexOf('    /** 获取或恢复或创建会话',from);
    if(from<0||to<0)throw Error('官方插件版本不匹配：agent preset guard');
    const guardPath=JSON.stringify(path.join(__dirname,'agent-guard.cjs'));
    const method=`    async composePreset(presetId) {\n        const { createRequire } = await import('node:module');\n        const { installQQAgentGuard } = createRequire(import.meta.url)(${guardPath});\n        const guardSetup = (setup) => async (agentCtx) => {\n            await installQQAgentGuard(agentCtx);\n            if (setup) await setup(agentCtx);\n        };\n        const presets = this.getPresetsService();\n        if (!presets) return { setup: guardSetup() };\n        try {\n            const resolved = await presets.resolve(presetId);\n            const resolvedId = resolved.id;\n            return { agentPreset: resolvedId, setup: guardSetup(async (agentCtx) => { await presets.mount(agentCtx, resolvedId); }) };\n        } catch {\n            return { setup: guardSetup() };\n        }\n    }\n`;
    s=s.slice(0,from)+method+s.slice(to);
    s=replaceOnce(s,'async setModelOverride(scope, peerId, route) {',"async setModelOverride(scope, peerId, route) {\n        throw new Error('QQ 会话暂不支持远程切换模型。');",'disable model override');
    s=replaceOnce(s,'async rebuildSession(record, options) {',"async rebuildSession(record, options) {\n        throw new Error('QQ 会话暂不支持远程重建。');",'disable rebuild');
    return replaceOnce(s,'if (live) {\n            agent = live;',`if (live) {\n            const { createRequire: __nekoCreateRequire } = await import('node:module');\n            const { installQQAgentGuard: __nekoInstallGuard } = __nekoCreateRequire(import.meta.url)(${JSON.stringify(path.join(__dirname,'agent-guard.cjs'))});\n            await __nekoInstallGuard(live.ctx);\n            agent = live;`,'live agent guard');
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
    s=replaceOnce(s,"let appId = resolveEnv(config.appId, 'QQBOT_APPID');","let appId = config.appId || '';",'appid env');
    return replaceOnce(s,"let appSecret = resolveEnv(config.appSecret, 'QQBOT_SECRET');","let appSecret = config.appSecret || '';",'secret env');
  });
  change(path.join(pluginDir,'dist/gateway/bootstrap.js'),s=>{
    s=replaceOnce(s,"process.env.QQBOT_BASE_URL?.replace(/\\/+$/, '') || 'https://api.bot.qq.com'","'https://api.bot.qq.com'",'gateway origin');
    s=replaceOnce(s,"process.env.QQBOT_TOKEN_BASE_URL?.replace(/\\/+$/, '') || 'https://api.bot.qq.com'","'https://api.bot.qq.com'",'token origin');
    return replaceOnce(s,'registerSendFileTool(ctx, mediaSender, manager, config, logger);',"// File transfer is disabled in the workbench adapter.",'file send tool');
  });
  change(path.join(pluginDir,'dist/transport/inbound.js'),s=>{
    const line='logger.info(`Processing: scope=${scope} peerId=${peerId} body="${agentBody.slice(0, 200)}"`);';
    return replaceOnce(s,line,"logger.info('Processing an incoming QQ message');",'message logging');
  });
  change(path.join(pluginDir,'lib/client.js'),s=>{
    s=replaceOnce(s,'id: "@tencent-connect/dsh-qqbot",','id: "@bigfish/qqbot-settings",','client module id');
    s=replaceOnce(s,'function QQBotSettingsSection() {','function QQBotSettingsSection() {\n            installPanelStyles();','client styles');
    return replaceOnce(s,'exports.apply = apply;','exports.QQBotSettingsSection = QQBotSettingsSection;\n        exports.apply = apply;','client export');
  });
  fs.writeFileSync(path.join(root,'installed-adapter.json'),JSON.stringify({version:'0.5.3',revision:7})+'\n',{encoding:'utf8',mode:0o600});
}
async function install(root, modulesDir, options={}) {
  const actual=crypto.createHash('sha256').update(fs.readFileSync(ARCHIVE)).digest('hex');
  if(actual!==SHA)throw Error('QQ 官方插件包校验失败');
  const profile=prepareProfile(root), pkg=path.join(root,'node_modules/@tencent-connect/dsh-qqbot');
  const marker=path.join(root,'installed-adapter.json');
  let ready=false; try{const m=JSON.parse(fs.readFileSync(marker,'utf8'));ready=m.version==='0.5.3'&&m.revision===7&&fs.existsSync(path.join(pkg,'dist/index.js'));}catch{}
  if(!ready){
    fs.writeFileSync(path.join(root,'package.json'),JSON.stringify({name:'neko-qqbot-runtime',version:'1.0.0',private:true,dependencies:{'@tencent-connect/dsh-qqbot':'file:./dsh-qqbot.tgz'}})+'\n',{mode:0o600});
    fs.copyFileSync(ARCHIVE,path.join(root,'dsh-qqbot.tgz'));
    fs.copyFileSync(path.join(__dirname,'upstream','runtime-install.lock.json'),path.join(root,'package-lock.json'));
    try { await execFileAsync('npm',['ci','--ignore-scripts','--no-audit','--no-fund','--legacy-peer-deps','--omit=dev'],{cwd:root,timeout:70000,signal:options.signal,maxBuffer:1024*1024,env:{...process.env,QQBOT_APPID:'',QQBOT_SECRET:''}}); }
    catch { throw Error('QQ 插件依赖安装失败，请检查 npm 与网络后重试。'); }
    adaptPlugin(root,pkg);
  }
  for(const name of ['schemastery/lib/index.mjs','dsh-session/lib/index.js','dsh-llm/lib/index.js'])
    if(!fs.existsSync(path.join(modulesDir,name)))throw Error('当前 DSH 缺少 QQ 插件依赖。');
  return {profile,pkg};
}
module.exports={install,adaptPlugin,prepareProfile,ARCHIVE,SHA};
