import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const installedElectron = resolve(root, "node_modules/electron/dist/electron.exe");
const electron = process.env.NEKO_FISH_ELECTRON || (existsSync(installedElectron) ? installedElectron : resolve(root, "../_sandbox/f01-dsh-desktop/src/apps/desktop/node_modules/electron/dist/electron.exe"));
const assets = process.env.NEKO_FISH_ASSETS_DIR || resolve(root, "assets");
const exists = (path, directory) => existsSync(path) && (directory ? statSync(path).isDirectory() : statSync(path).isFile());

if (process.platform !== "win32") {
  console.error("此开发入口目前仅支持 Windows（密钥由 Windows DPAPI 保护）。");
  process.exitCode = 1;
} else if (!exists(electron, false)) {
  console.error("未找到 Electron。请设置 NEKO_FISH_ELECTRON 指向本机 Electron 44 或更新版本的 electron.exe。");
  process.exitCode = 1;
} else {
  const hasAssets = exists(assets, true);
  console.log(`Electron: ${electron}`);
  console.log(hasAssets ? `动画素材: ${assets}` : "未找到动画素材，将显示文字占位角色。");
  console.log("数据保存在 %APPDATA%/neko-fish；右键桌宠可配置 API、编辑角色、管理记忆或退出。");
  const dsh = process.env.NEKO_FISH_DSH_RUNTIME || resolve(root, "../_sandbox/f01-dsh-desktop/src/apps/desktop/.desktop-build/development/project");
  console.log(exists(resolve(dsh, "node_modules/@deepseek-ai/dsh-desktop-host/lib/index.js"), false)
    ? "内置 DSH 可用：从右键菜单按需启动，退出桌宠时一同关闭。" : "未找到内置 DSH 构建；可用 NEKO_FISH_DSH_RUNTIME 指定目录，陪伴聊天仍可运行。");
  if (!process.argv.includes("--check")) {
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    if (hasAssets) env.NEKO_FISH_ASSETS_DIR = assets;
    else delete env.NEKO_FISH_ASSETS_DIR;
    // Run in the current terminal. No detached process or hidden helper is left behind.
    const child = spawn(electron, [resolve(root, "apps/desktop/main.cjs")], { cwd: root, env, stdio: ["inherit", "inherit", "inherit", "ipc"], windowsHide: false });
    let stopping = false;
    let shutdownTimer;
    const stop = () => {
      if (stopping) return;
      stopping = true;
      if (child.connected) child.send({ type: "neko-fish:shutdown" }, (error) => { if (error && !child.killed) child.kill(); });
      else if (!child.killed) child.kill();
      // A stuck renderer/driver must not keep this terminal alive forever.
      shutdownTimer = setTimeout(() => { if (!child.killed) child.kill(); }, 5000);
      shutdownTimer.unref();
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    child.once("error", () => { console.error("Electron 启动失败，请检查可执行文件。"); process.exitCode = 1; });
    child.once("exit", (code, signal) => {
      clearTimeout(shutdownTimer);
      process.removeListener("SIGINT", stop);
      process.removeListener("SIGTERM", stop);
      process.exitCode = code ?? (signal ? 1 : 0);
    });
  }
}
