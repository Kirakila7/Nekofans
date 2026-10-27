import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { electronCandidates, moduleContainerExists, launchPlan, startWorkbench } from "../../scripts/start-neko-workbench.mjs";

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "neko-launch-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const electron = join(root, "Electron with spaces");
  const cli = join(root, "dsh");
  const modulesDir = join(root, "modules");
  for (const file of [electron, cli]) { writeFileSync(file, "#!/bin/sh\nexit 0\n"); chmodSync(file, 0o755); }
  mkdirSync(modulesDir);
  const runtime = { cli, modulesDir, dataDir: join(root, "data"), workspaceDir: join(root, "workspaces"), userDataDir: join(root, "data/electron") };
  const args = { root, env: { NEKO_WORKBENCH_ELECTRON: electron, ELECTRON_RUN_AS_NODE: "1" },
    platform: "darwin", homeDir: join(root, "home"), resolvePaths: () => runtime };
  return { root, electron, runtime, args };
}

test("explicit Electron paths are authoritative; no fallback hides a typo", () => {
  assert.deepEqual(electronCandidates({ root: "/repo", homeDir: "/home/test", platform: "darwin",
    env: { NEKO_WORKBENCH_ELECTRON: "/missing/electron" } }), ["/missing/electron"]);
  assert.equal(electronCandidates({ root: "/repo", homeDir: "/home/test", platform: "darwin", env: {} }).length, 2);
  assert.equal(electronCandidates({ root: "/repo", platform: "win32", env: {} }).length, 1);
});

test("ASAR preflight checks the archive without pretending to inspect its members", t => {
  const { root } = fixture(t);
  const archive = join(root, "app.asar");
  assert.equal(moduleContainerExists(join(archive, "dsh/node_modules/@deepseek-ai")), false);
  writeFileSync(archive, "test container only");
  assert.equal(moduleContainerExists(join(archive, "dsh/node_modules/@deepseek-ai")), true);
  assert.equal(moduleContainerExists(join(root, "missing")), false);
});

test("launch plan isolates mutable paths and clears Electron's Node-only flag without mutating parent env", t => {
  const { args, runtime, root } = fixture(t);
  const plan = launchPlan(args);
  assert.deepEqual(plan.errors, []);
  assert.equal(plan.childEnv.NEKO_WORKBENCH_DATA_DIR, runtime.dataDir);
  assert.equal(plan.childEnv.NEKO_WORKBENCH_WORKSPACE, runtime.workspaceDir);
  assert.equal(plan.childEnv.NEKO_WORKBENCH_ELECTRON_USER_DATA, runtime.userDataDir);
  assert.equal(plan.childEnv.ELECTRON_RUN_AS_NODE, undefined);
  assert.equal(args.env.ELECTRON_RUN_AS_NODE, "1");
  assert.equal(existsSync(join(root, "data")), false);
});

test("missing runtime reports actionable failures and never spawns", t => {
  const { args, runtime } = fixture(t);
  const plan = launchPlan({ ...args, env: { NEKO_WORKBENCH_ELECTRON: "/missing" },
    resolvePaths: () => ({ ...runtime, cli: "/missing", modulesDir: "/missing" }) });
  const errors = [];
  let code;
  startWorkbench({ plan, spawnProcess: () => assert.fail("must not start"), logger: { error: text => errors.push(text) }, onExit: value => { code = value; } });
  assert.equal(code, 1);
  assert.equal(errors.length, 3);
});

test("check mode only examines paths and never creates data or starts a process", t => {
  const { args, runtime } = fixture(t);
  startWorkbench({ plan: launchPlan(args), checkOnly: true,
    spawnProcess: () => assert.fail("must not start"), logger: { log() {}, error() {} }, onExit: () => assert.fail("check should pass") });
  assert.equal(existsSync(runtime.dataDir), false);
});

test("launch uses an argument array and stopping the terminal stops only this child", t => {
  const { args } = fixture(t);
  const plan = launchPlan(args);
  const child = new EventEmitter();
  const signals = new EventEmitter();
  const kills = [];
  child.kill = signal => { kills.push(signal); return true; };
  let code;
  startWorkbench({ plan, signalSource: signals, logger: { log() {}, error() {} }, onExit: value => { code = value; },
    spawnProcess(executable, argv, options) {
      assert.equal(executable, plan.electron);
      assert.deepEqual(argv, [plan.appDir]);
      assert.equal(options.cwd, plan.appDir);
      assert.equal(options.shell, undefined);
      return child;
    } });
  signals.emit("SIGTERM"); signals.emit("SIGINT");
  assert.deepEqual(kills, ["SIGTERM"]);
  child.emit("exit", 0, null);
  assert.equal(code, 0);
  assert.equal(signals.listenerCount("SIGINT"), 0);
  assert.equal(signals.listenerCount("SIGTERM"), 0);
});
