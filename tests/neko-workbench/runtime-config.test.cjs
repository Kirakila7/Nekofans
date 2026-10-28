'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
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
  assert.equal(launch.options.windowsHide, true);
  assert.equal(launch.options.env.ELECTRON_RUN_AS_NODE, undefined);
});

test('JavaScript CLI runs with Chinese and spaced paths as separate arguments in its private runtime', t => {
  const f = fixture(t);
  const cli = path.join(f.directory, '运行 时', 'dsh entry.cjs');
  const runtime = resolveRuntimePaths({ ...f.options, env: { NEKO_WORKBENCH_DSH_CLI: cli } });
  prepareRuntimeDirectories(runtime);
  fs.mkdirSync(path.dirname(cli), { recursive: true });
  fs.writeFileSync(cli, "process.stdout.write(JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), dshHome: process.env.DSH_HOME }));");
  const patchFile = path.join(runtime.dataDir, '中文 patch.json');
  const launch = buildDshLaunch(runtime, { env: {}, patchFile });
  const result = spawnSync(launch.command, launch.args, { ...launch.options, encoding: 'utf8' });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    args: ['--profile', 'web', '--patch', patchFile, '--no-open', '--host', '127.0.0.1', '--port', '0'],
    cwd: runtime.workspaceDir,
    dshHome: runtime.dshHomeDir,
  });
});

test('JavaScript CLI uses Electron node mode only for its own executable and supports an explicit Node', t => {
  const f = fixture(t);
  const runtime = resolveRuntimePaths(f.options);
  const execPath = path.join(f.directory, 'Electron runtime', 'electron.exe');
  const nodePath = path.join(f.directory, 'Node runtime', 'node.exe');
  for (const extension of ['js', 'mjs', 'cjs']) {
    const script = { ...runtime, cli: path.join(f.directory, `中文 runtime/bin.${extension}`) };
    const env = { ELECTRON_RUN_AS_NODE: '0' };
    const launch = buildDshLaunch(script, { env, execPath, electronVersion: '44.7.0' });
    assert.equal(launch.command, execPath);
    assert.equal(launch.args[0], script.cli);
    assert.equal(launch.options.env.ELECTRON_RUN_AS_NODE, '1');
    assert.equal(env.ELECTRON_RUN_AS_NODE, '0', 'caller environment is not mutated');
    const explicit = buildDshLaunch(script, { env: { DSH_DESKTOP_NODE_EXECUTABLE: nodePath }, execPath, electronVersion: '44.7.0' });
    assert.equal(explicit.command, nodePath);
    assert.equal(explicit.args[0], script.cli);
    assert.equal(explicit.options.env.ELECTRON_RUN_AS_NODE, undefined);
  }
  for (const cli of [path.join(f.directory, 'dsh.exe'), path.join(f.directory, 'dsh')]) {
    const launch = buildDshLaunch({ ...runtime, cli }, { env: { DSH_DESKTOP_NODE_EXECUTABLE: nodePath }, execPath, electronVersion: '44.7.0' });
    assert.equal(launch.command, cli);
    assert.equal(launch.args[0], '--profile');
    assert.equal(launch.options.env.ELECTRON_RUN_AS_NODE, undefined);
  }
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
