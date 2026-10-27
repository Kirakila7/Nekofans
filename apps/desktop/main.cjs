// Electron 44 / Node 24 load the repository's erasable TypeScript directly.
const { app, dialog } = require("electron");
const { pathToFileURL } = require("node:url");
const { join, resolve } = require("node:path");
require("./parent-lifecycle.cjs").installParentLifecycle(app);

app.setName("大肥鱼桌宠");
// A stable independent profile: never share DSH's user data, cookies, or settings.
app.setPath("userData", process.env.NEKO_FISH_DATA_DIR ? resolve(process.env.NEKO_FISH_DATA_DIR) : join(app.getPath("appData"), "neko-fish"));
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.whenReady().then(async () => {
    const { launchDesktop } = await import(pathToFileURL(join(__dirname, "desktop.ts")).href);
    await launchDesktop(require("electron"), { settings: process.argv.includes("--settings"), dsh: process.argv.includes("--dsh") });
  }).catch(() => {
    // Exceptions can contain file contents or upstream data. Show only a fixed message.
    dialog.showErrorBox("大肥鱼启动失败", "无法打开桌宠。请检查本地运行环境和用户数据目录。没有向外部发送聊天请求。");
    app.exit(1);
  });
}
