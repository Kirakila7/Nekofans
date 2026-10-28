'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { resolveRuntimePaths, prepareRuntimeDirectories, assertDshRuntime, buildDshPatch, buildDshLaunch } = require('../../apps/neko-workbench/runtime-config.cjs');

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'neko-workbench-runtime-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const baseDir = path.join(directory, 'checkout/apps/neko-workbench');
  const homeDir = path.join(directory, 'home');
  fs.mkdirSync(homeDir);
  return { directory, baseDir, homeDir, options: { baseDir, homeDir, env: {}, platform: 'darwin' } };
}

test('two checkouts own separate data, DSH homes, workspaces and Electron locks without creating directories', t => {
  const f = fixture(t);
  const a = resolveRuntimePaths(f.options);
  const b = resolveRuntimePaths({ ...f.options, baseDir: path.join(f.directory, 'other-copy') });
  for (const name of ['dataDir', 'workspaceDir', 'dshHomeDir', 'userDataDir', 'diagnosticsDir']) {
    assert.notEqual(a[name], b[name]);
    assert(!fs.existsSync(a[name]), 'path resolution must not touch user data');
  }
  assert.equal(a.dataDir, path.join(f.baseDir, 'data'));
  assert.equal(a.userDataDir, path.join(a.dataDir, 'electron'));
  assert.equal(a.credentialsFile, null, 'global credentials require explicit opt-in');
  assert(!a.dshHomeDir.startsWith(f.homeDir));
  prepareRuntimeDirectories(a);
  assert(fs.statSync(a.dshHomeDir).isDirectory());
  assert(fs.statSync(a.userDataDir).isDirectory());
  assert(!fs.existsSync(b.dataDir));
});

test('explicit runtime paths propagate to the child, overriding inherited global profile settings', t => {
  const f = fixture(t);
  const env = {
    DSH_HOME: path.join(f.homeDir, '.dsh'),
    NEKO_WORKBENCH_DATA_DIR: path.join(f.directory, 'local-data'),
    NEKO_WORKBENCH_WORKSPACE: path.join(f.directory, 'local-work'),
    NEKO_WORKBENCH_ELECTRON_USER_DATA: path.join(f.directory, 'local-electron'),
    NEKO_WORKBENCH_DSH_CLI: path.join(f.directory, 'runtime/bin/dsh'),
    NEKO_WORKBENCH_DSH_MODULES: path.join(f.directory, 'runtime/node_modules/@deepseek-ai'),
  };
  const runtime = resolveRuntimePaths({ ...f.options, env });
  const launch = buildDshLaunch(runtime, { env });
  assert.equal(launch.command, env.NEKO_WORKBENCH_DSH_CLI);
  assert.equal(launch.options.cwd, env.NEKO_WORKBENCH_WORKSPACE);
  assert.equal(launch.options.env.DSH_HOME, path.join(env.NEKO_WORKBENCH_DATA_DIR, 'dsh'));
  assert.equal(launch.options.env.NEKO_WORKBENCH_DSH_MODULES, env.NEKO_WORKBENCH_DSH_MODULES);
  assert.equal(launch.options.env.NEKO_WORKBENCH_WORKSPACE, runtime.workspaceDir);
  assert.equal(launch.options.env.NEKO_WORKBENCH_WORKSPACE_DIR, runtime.workspaceDir);
  assert.equal(launch.options.env.DSH_PERMISSION_MODE, 'workspace-write');
  assert.equal(launch.options.env.DSH_TELEMETRY_MODE, 'DISABLED');
  assert.deepEqual(launch.args.slice(-4), ['--host', '127.0.0.1', '--port', '0']);
  assert.equal(env.DSH_HOME, path.join(f.homeDir, '.dsh'), 'caller environment is not mutated');
});

test('workspace and private state cannot overlap or resolve through a symlink into the global DSH home', t => {
  const f = fixture(t);
  const data = path.join(f.directory, 'private');
  for (const workspace of [data, path.join(data, 'child'), f.directory]) {
    assert.throws(() => resolveRuntimePaths({ ...f.options, env: {
      NEKO_WORKBENCH_DATA_DIR: data, NEKO_WORKBENCH_WORKSPACE: workspace,
    } }), /工作区/);
  }
  const global = path.join(f.homeDir, '.dsh');
  fs.mkdirSync(global);
  const alias = path.join(f.directory, 'global-alias');
  fs.symlinkSync(global, alias, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => resolveRuntimePaths({ ...f.options, env: { NEKO_WORKBENCH_DATA_DIR: path.join(alias, 'new-copy') } }), /全局/);
  assert.throws(() => resolveRuntimePaths({ ...f.options, env: { NEKO_WORKBENCH_ELECTRON_USER_DATA: path.join(global, 'electron') } }), /全局/);
  assert.throws(() => resolveRuntimePaths({ ...f.options, env: { NEKO_WORKBENCH_WORKSPACE: path.join(global, 'projects') } }), /全局/);
  fs.mkdirSync(data);
  fs.symlinkSync(global, path.join(data, 'dsh'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => resolveRuntimePaths({ ...f.options, env: { NEKO_WORKBENCH_DATA_DIR: data } }), /全局/);
  assert.throws(() => resolveRuntimePaths({ ...f.options, env: { NEKO_WORKBENCH_DSH_CLI: 'relative/dsh' } }), /绝对路径/);
});

test('runtime preflight and opt-in credentials validate only the selected fixture files', t => {
  const f = fixture(t);
  const cli = path.join(f.directory, 'runtime/dsh');
  const modulesDir = path.join(f.directory, 'runtime/@deepseek-ai');
  const credentialsFile = path.join(f.directory, 'fixture-credentials.yaml');
  const env = { NEKO_WORKBENCH_DSH_CLI: cli, NEKO_WORKBENCH_DSH_MODULES: modulesDir };
  const runtime = resolveRuntimePaths({ ...f.options, env });
  assert.throws(() => assertDshRuntime(runtime), /DSH CLI/);
  fs.mkdirSync(path.dirname(cli), { recursive: true });
  fs.writeFileSync(cli, 'fixture only');
  assert.throws(() => assertDshRuntime(runtime), /DSH 模块/);
  for (const module of ['dsh-llm', 'dsh-scope']) {
    const entry = path.join(modulesDir, module, 'lib/index.js');
    fs.mkdirSync(path.dirname(entry), { recursive: true });
    fs.writeFileSync(entry, 'export {};');
  }
  assert.doesNotThrow(() => assertDshRuntime(runtime));
  assert.deepEqual(buildDshPatch(runtime)[0], { id: 'credentials', config: { path: path.join(runtime.dshHomeDir, '.credentials.yaml') } });
  const explicit = resolveRuntimePaths({ ...f.options, env: { ...env, NEKO_WORKBENCH_DSH_CREDENTIALS: credentialsFile } });
  assert.throws(() => assertDshRuntime(explicit), /凭据文件不存在/);
  fs.writeFileSync(credentialsFile, '# test fixture, no credential');
  assert.doesNotThrow(() => assertDshRuntime(explicit));
  assert.deepEqual(buildDshPatch(explicit)[0], { id: 'credentials', config: { path: credentialsFile } });
  const skin = { rows: [{ id: 'ui-brand-official', disabled: true }], insert: [{ id: 'fixture-skin', name: '/fixture/skin.js' }] };
  const patch = buildDshPatch(runtime, { baseDir: f.baseDir, skin });
  assert.deepEqual(patch.find(row => row.id === 'ui-settings-models'), {
    id: 'ui-settings-models', config: { credentialOnboarding: false },
  }, 'startup credential onboarding is disabled without replacing the account service');
  assert.equal(patch.at(-1).insert[0].name, path.join(f.baseDir, 'bridge.cjs'));
  assert.equal(patch.at(-1).insert[1].id, 'fixture-skin');
  assert(!fs.existsSync(path.join(f.homeDir, '.dsh')));
});

test('explicit shared DSH home reuses desktop plugins and credentials without rewriting the profile', t => {
  const f=fixture(t),dsh=path.join(f.homeDir,'.dsh'),profile=path.join(dsh,'profiles','desktop');
  fs.mkdirSync(profile,{recursive:true});
  const file=path.join(profile,'cordis.patch.yml'),original='- id: custom-plugin\n  disabled: false\n';fs.writeFileSync(file,original);
  const env={NEKO_WORKBENCH_DSH_HOME:dsh};
  const runtime=resolveRuntimePaths({...f.options,env});prepareRuntimeDirectories(runtime);
  assert.equal(runtime.dshHomeDir,dsh);assert.equal(runtime.dshProfile,'desktop');assert.equal(runtime.sharedDsh,true);
  const launch=buildDshLaunch(runtime,{env}),patch=buildDshPatch(runtime);
  assert.equal(launch.command,runtime.desktopExecutable);assert(launch.args[1].endsWith('dsh-shared-desktop-host.cjs'));assert.equal(launch.options.env.DSH_HOME,dsh);
  const {desktopOptions}=require('../../apps/neko-workbench/dsh-shared-desktop-host.cjs');
  const boot=desktopOptions(runtime,'/fixture/overlay.json',{});
  assert.equal(boot.profileDir,profile);assert.deepEqual(boot.options.patchFiles,['/fixture/overlay.json']);
  assert.equal(boot.options.profile,'desktop');assert.deepEqual(boot.options.args.slice(-4),['--host','127.0.0.1','--port','0']);
  assert.equal(launch.options.env.NEKO_WORKBENCH_DSH_HOME,dsh);
  assert.equal(patch[0].config.path,path.join(dsh,'.credentials.yaml'));
  assert(!patch.some(row=>row.id==='agent-default-model'),'shared model selection is preserved');
  assert(patch.some(row=>row.id==='pet'&&row.disabled===true),'only the launch overlay hides the old pet');
  assert(patch.some(row=>row.id==='dsh-pet'&&row.disabled===true),'the installed bundle entry is hidden too');
  assert.equal(fs.readFileSync(file,'utf8'),original);assert(!fs.existsSync(path.join(runtime.dataDir,'dsh')));
  assert.throws(()=>resolveRuntimePaths({...f.options,env:{...env,NEKO_WORKBENCH_DSH_PROFILE:'../desktop'}}),/配置名称/);
});
