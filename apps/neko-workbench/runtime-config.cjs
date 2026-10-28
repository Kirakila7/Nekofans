'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {fishEnvironment}=require('./fish-care.cjs');

function absoluteSetting(value, fallback, name) {
  if (value == null || value === '') return fallback;
  if (typeof value !== 'string' || value.includes('\0') || !path.isAbsolute(value)) {
    throw new Error(`${name} 必须是绝对路径`);
  }
  return path.resolve(value);
}

function canonicalPath(value) {
  let ancestor = path.resolve(value);
  const tail = [];
  while (!fs.existsSync(ancestor)) {
    const parent = path.dirname(ancestor);
    if (parent === ancestor) break;
    tail.unshift(path.basename(ancestor));
    ancestor = parent;
  }
  return path.join(fs.realpathSync(ancestor), ...tail);
}

function within(parent, candidate) {
  const relative = path.relative(canonicalPath(parent), canonicalPath(candidate));
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function resolveRuntimePaths({ baseDir = __dirname, env = process.env, platform = process.platform, homeDir = os.homedir() } = {}) {
  baseDir = path.resolve(baseDir);
  const dataDir = absoluteSetting(env.NEKO_WORKBENCH_DATA_DIR, path.join(baseDir, 'data'), 'NEKO_WORKBENCH_DATA_DIR');
  const workspaceDir = absoluteSetting(env.NEKO_WORKBENCH_WORKSPACE || env.NEKO_WORKBENCH_WORKSPACE_DIR,
    path.join(baseDir, 'workspaces'), 'NEKO_WORKBENCH_WORKSPACE');
  const userDataDir = absoluteSetting(env.NEKO_WORKBENCH_ELECTRON_USER_DATA, path.join(dataDir, 'electron'), 'NEKO_WORKBENCH_ELECTRON_USER_DATA');
  const sharedDsh = Boolean(env.NEKO_WORKBENCH_DSH_HOME);
  const dshHomeDir = absoluteSetting(env.NEKO_WORKBENCH_DSH_HOME, path.join(dataDir, 'dsh'), 'NEKO_WORKBENCH_DSH_HOME');
  const dshProfile = env.NEKO_WORKBENCH_DSH_PROFILE || (sharedDsh ? 'desktop' : 'web');
  if(typeof dshProfile !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(dshProfile) || dshProfile.includes('..'))throw new Error('DSH 配置名称无效');
  const globalDsh = path.join(homeDir, '.dsh');
  if (within(dataDir, workspaceDir) || within(workspaceDir, dataDir)
    || within(userDataDir, workspaceDir) || within(workspaceDir, userDataDir)) {
    throw new Error('工作区必须与工作台数据、Electron 数据目录分开');
  }
  if (within(globalDsh, dataDir) || (!sharedDsh && within(globalDsh, dshHomeDir)) || within(globalDsh, userDataDir) || within(globalDsh, workspaceDir)) {
    throw new Error('工作台不能使用全局 ~/.dsh 目录；请选择独立数据和工作区');
  }
  const macResources = '/Applications/DeepSeek Harness.app/Contents/Resources';
  const cli = absoluteSetting(env.NEKO_WORKBENCH_DSH_CLI,
    platform === 'darwin' ? path.join(macResources, 'runtime/cli/bin/dsh') : '', 'NEKO_WORKBENCH_DSH_CLI');
  const modulesDir = absoluteSetting(env.NEKO_WORKBENCH_DSH_MODULES || env.NEKO_WORKBENCH_DSH_MODULES_DIR,
    platform === 'darwin' ? path.join(macResources, 'app.asar/dsh/node_modules/@deepseek-ai') : '', 'NEKO_WORKBENCH_DSH_MODULES');
  const credentialsFile = absoluteSetting(env.NEKO_WORKBENCH_DSH_CREDENTIALS, null, 'NEKO_WORKBENCH_DSH_CREDENTIALS');
  return Object.freeze({ cli, modulesDir, dataDir, workspaceDir, userDataDir, dshHomeDir, dshProfile, sharedDsh,
    desktopResources:macResources,desktopExecutable:path.join(macResources,'../MacOS/DeepSeek Harness'),
    diagnosticsDir: path.join(dataDir, 'diagnostics'), credentialsFile });
}

function prepareRuntimeDirectories(runtime) {
  for (const directory of [runtime.dataDir, runtime.workspaceDir, runtime.userDataDir, runtime.dshHomeDir, runtime.diagnosticsDir]) {
    fs.mkdirSync(directory, { recursive: true });
  }
}

function assertDshRuntime(runtime) {
  if (!runtime.cli || !fs.existsSync(runtime.cli)) {
    throw new Error('未找到 DSH CLI，请设置 NEKO_WORKBENCH_DSH_CLI');
  }
  for (const module of ['dsh-llm', 'dsh-scope']) {
    if (!runtime.modulesDir || !fs.existsSync(path.join(runtime.modulesDir, module, 'lib/index.js'))) {
      throw new Error('未找到 DSH 模块，请设置 NEKO_WORKBENCH_DSH_MODULES 指向 @deepseek-ai 目录');
    }
  }
  if (runtime.credentialsFile && !fs.existsSync(runtime.credentialsFile)) {
    throw new Error('指定的 DSH 凭据文件不存在，请检查 NEKO_WORKBENCH_DSH_CREDENTIALS');
  }
}

function buildDshPatch(runtime, { baseDir = __dirname, skin = { rows: [], insert: [] } } = {}) {
  return [
    { id: 'credentials', config: { path: runtime.credentialsFile || path.join(runtime.dshHomeDir, '.credentials.yaml') } },
    ...(runtime.sharedDsh ? [{id:'pet',disabled:true},{id:'dsh-pet',disabled:true}] : [{ id: 'agent-default-model', config: { provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'high' } }]),
    { id: 'web-runtime', config: { openBrowser: false, printUrl: false, surfaceContext: true } },
    { id: 'ui-settings-models', config: { credentialOnboarding: false } },
    ...skin.rows,
    { insert: [{ id: 'pet-lab-bridge', name: path.join(baseDir, 'bridge.cjs') }, ...skin.insert,
      {id:'dsh-bili-whale',name:path.join(baseDir,'vendor/dsh-bili-whale/lib/index.js')},
      {id:'neko-qqbot-workbench',name:path.join(baseDir,'vendor/dsh-qqbot-workbench/index.cjs')}] },
  ];
}

function buildDshLaunch(runtime, { env = process.env, patchFile = path.join(runtime.dataDir, 'bridge.patch.json') } = {}) {
  const desktop=runtime.sharedDsh&&runtime.dshProfile==='desktop';
  return {
    command: desktop?runtime.desktopExecutable:runtime.cli,
    args: desktop?['--expose-internals',path.join(__dirname,'dsh-shared-desktop-host.cjs'),patchFile]:['--profile', runtime.dshProfile || 'web', '--patch', patchFile, '--no-open', '--host', '127.0.0.1', '--port', '0'],
    options: {
      cwd: runtime.workspaceDir,
      env: { ...env, ...fishEnvironment(runtime,env), DSH_HOME: runtime.dshHomeDir, DSH_PERMISSION_MODE: 'workspace-write', DSH_TELEMETRY_MODE: 'DISABLED',
        ...(desktop?{ELECTRON_RUN_AS_NODE:'1',DSH_DESKTOP_NODE_EXECUTABLE:runtime.desktopExecutable}:{}),
        NEKO_WORKBENCH_DATA_DIR: runtime.dataDir, NEKO_WORKBENCH_WORKSPACE: runtime.workspaceDir,
        NEKO_WORKBENCH_DSH_HOME: runtime.sharedDsh ? runtime.dshHomeDir : '', NEKO_WORKBENCH_DSH_PROFILE: runtime.dshProfile || 'web',
        NEKO_WORKBENCH_WORKSPACE_DIR: runtime.workspaceDir, NEKO_WORKBENCH_ELECTRON_USER_DATA: runtime.userDataDir,
        NEKO_WORKBENCH_DSH_CLI: runtime.cli, NEKO_WORKBENCH_DSH_MODULES: runtime.modulesDir,
        NEKO_WORKBENCH_DSH_MODULES_DIR: runtime.modulesDir, NEKO_WORKBENCH_DSH_CREDENTIALS: runtime.credentialsFile || '' },
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  };
}

module.exports = { resolveRuntimePaths, prepareRuntimeDirectories, assertDshRuntime, buildDshPatch, buildDshLaunch };
