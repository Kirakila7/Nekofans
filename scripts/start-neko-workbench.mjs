import { spawn } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { homedir } from "node:os";
import { createRequire } from "node:module";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const defaultRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function electronCandidates({ root = defaultRoot, env = process.env,
  platform = process.platform, homeDir = homedir() } = {}) {
  // An explicit path never silently falls back to another installed version.
  if (env.NEKO_WORKBENCH_ELECTRON) return [resolve(env.NEKO_WORKBENCH_ELECTRON)];
  const relative = platform === "darwin" ? "Electron.app/Contents/MacOS/Electron"
    : platform === "win32" ? "electron.exe" : "electron";
  return [join(root, "node_modules/electron/dist", relative),
    ...(platform === "darwin" ? [join(homeDir, ".dsh/electron", relative)] : [])];
}

function executable(file, platform) {
  try {
    if (!statSync(file).isFile()) return false;
    accessSync(file, platform === "win32" ? constants.F_OK : constants.X_OK);
    return true;
  } catch { return false; }
}

export function moduleContainerExists(modulesDir) {
  // Plain Node cannot inspect Electron ASAR members. Checking the archive only
  // confirms a container is present; DSH still validates its modules on startup.
  const marker = `.asar${sep}`;
  const index = modulesDir.indexOf(marker);
  const container = index < 0 ? modulesDir : modulesDir.slice(0, index + 5);
  try { return index < 0 ? statSync(container).isDirectory() : statSync(container).isFile(); }
  catch { return false; }
}

export function launchPlan({ root = defaultRoot, env = process.env,
  platform = process.platform, homeDir = homedir(), resolvePaths } = {}) {
  const appDir = join(root, "apps/neko-workbench");
  const resolver = resolvePaths ?? require(join(appDir, "runtime-config.cjs")).resolveRuntimePaths;
  const runtime = resolver({ baseDir: appDir, env, platform, homeDir });
  const candidates = electronCandidates({ root, env, platform, homeDir });
  const electron = candidates.find(file => executable(file, platform));
  const errors = [];
  if (!electron) errors.push("未找到 Electron：设置 NEKO_WORKBENCH_ELECTRON 为 Electron 可执行文件路径。");
  if (!executable(runtime.cli, platform)) errors.push("未找到可执行的 DSH CLI：设置 NEKO_WORKBENCH_DSH_CLI。");
  if (!moduleContainerExists(runtime.modulesDir)) errors.push("未找到 DSH 模块或 ASAR 容器：设置 NEKO_WORKBENCH_DSH_MODULES。");
  const childEnv = { ...env, NEKO_WORKBENCH_DATA_DIR: runtime.dataDir,
    NEKO_WORKBENCH_WORKSPACE: runtime.workspaceDir,
    NEKO_WORKBENCH_ELECTRON_USER_DATA: runtime.userDataDir,
    NEKO_WORKBENCH_DSH_CLI: runtime.cli, NEKO_WORKBENCH_DSH_MODULES: runtime.modulesDir };
  childEnv.NEKO_WORKBENCH_DSH_HOME = runtime.sharedDsh ? runtime.dshHomeDir : '';
  childEnv.NEKO_WORKBENCH_DSH_PROFILE = runtime.dshProfile || 'web';
  delete childEnv.ELECTRON_RUN_AS_NODE;
  return { appDir, electron, runtime, errors, childEnv };
}

export function startWorkbench({ plan, checkOnly = false, spawnProcess = spawn,
  logger = console, signalSource = process, onExit = code => { process.exitCode = code; } }) {
  if (plan.errors.length) {
    for (const error of plan.errors) logger.error(error);
    onExit(1);
    return null;
  }
  logger.log(`N.E.K.O. 工作台数据：${plan.runtime.dataDir}`);
  logger.log(`工作区：${plan.runtime.workspaceDir}`);
  logger.log(`DSH 配置：${plan.runtime.dshHomeDir} / ${plan.runtime.dshProfile || 'web'}`);
  if (checkOnly) {
    logger.log("启动路径检查通过；未启动 Electron、DSH 或模型请求。");
    return null;
  }
  const child = spawnProcess(plan.electron, [plan.appDir], {
    cwd: plan.appDir, env: plan.childEnv, stdio: "inherit", windowsHide: false,
  });
  let stopping = false;
  let killTimer;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    child.kill("SIGTERM");
    killTimer = setTimeout(() => child.kill("SIGKILL"), 5000);
    killTimer.unref();
  };
  const cleanup = () => {
    clearTimeout(killTimer);
    signalSource.removeListener("SIGINT", stop);
    signalSource.removeListener("SIGTERM", stop);
  };
  signalSource.once("SIGINT", stop);
  signalSource.once("SIGTERM", stop);
  child.once("error", () => {
    cleanup();
    logger.error("Electron 启动失败，请检查 NEKO_WORKBENCH_ELECTRON。");
    onExit(1);
  });
  child.once("exit", (code, signal) => {
    cleanup();
    onExit(code ?? (signal ? 1 : 0));
  });
  return child;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.includes("--help")) {
    console.log("npm run start:neko [-- --check]\n独立的 N.E.K.O. 工作台；--check 仅检查运行路径，不启动服务。\n配置说明：docs/NEKO_LITE.md");
  } else {
    try { startWorkbench({ plan: launchPlan(), checkOnly: process.argv.includes("--check") }); }
    catch { console.error("无法读取 N.E.K.O. 工作台启动配置。请检查 apps/neko-workbench 与环境变量。"); process.exitCode = 1; }
  }
}
