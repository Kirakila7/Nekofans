import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { BrowserWindowLike, ElectronMainLike } from "../../packages/app-coordinator/src/pet-window.ts";
import type { PetMode } from "../../packages/app-coordinator/src/pet-mode.ts";
import { DesktopRuntime } from "./runtime.ts";
import { isSettingsSender, SETTINGS_CHANNELS, type SettingsSection, type SettingsSender } from "./settings.ts";
import { DshDesktop, type DshElectron } from "./dsh.ts";
import { desktopRuntimePaths } from "./runtime-paths.ts";

interface Preventable { preventDefault(): void }
interface MenuItem { label?: string; type?: "separator"; click?: () => void; submenu?: MenuItem[] }
interface DesktopWindow extends BrowserWindowLike {
  webContents: BrowserWindowLike["webContents"] & {
    mainFrame: unknown;
    getURL(): string;
    on(name: string, listener: (event: Preventable) => void): void;
    setWindowOpenHandler(fn: () => { action: "deny" }): void;
    session: { setPermissionRequestHandler(fn: (contents: unknown, permission: string, callback: (allowed: boolean) => void) => void): void };
  };
  show(): void;
  focus(): void;
}
interface DesktopElectron extends Omit<ElectronMainLike, "BrowserWindow"> {
  dialog: DshElectron["dialog"];
  shell: DshElectron["shell"];
  BrowserWindow: new (options: Record<string, unknown>) => DesktopWindow;
  app: {
    isPackaged?: boolean;
    getPath(name: string): string;
    on(event: string, listener: (event: Preventable) => void): void;
    quit(): void;
  };
  Menu: {
    buildFromTemplate(items: MenuItem[]): { popup(options: { window: DesktopWindow }): void };
    setApplicationMenu(menu: null): void;
  };
}

const directory = dirname(fileURLToPath(import.meta.url));
const settingsUrl = pathToFileURL(resolve(directory, "settings.html")).href;

export async function launchDesktop(electron: DesktopElectron, startup: { settings?: boolean; dsh?: boolean } = {}): Promise<DesktopRuntime> {
  const { app, ipcMain } = electron;
  electron.Menu.setApplicationMenu(null);
  let settingsWindow: DesktopWindow | null = null;
  let section: SettingsSection = "api";
  let quitting = false;
  let shutdownDone = false;
  const repositoryRoot = resolve(directory, "../..");
  const resources = desktopRuntimePaths({ repositoryRoot, packaged: app.isPackaged === true,
    resourcesPath: (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath });
  const dsh = new DshDesktop({ electron, repositoryRoot, dataDir: app.getPath("userData"), ...resources });

  const openSettings = (target: SettingsSection) => {
    section = target;
    if (settingsWindow && !settingsWindow.isDestroyed()) {
      settingsWindow.webContents.send(SETTINGS_CHANNELS.section, section);
      settingsWindow.show();
      settingsWindow.focus();
      return;
    }
    const win = new electron.BrowserWindow({
      title: "大肥鱼 · 设置", width: 640, height: 760, minWidth: 520, minHeight: 620, show: false,
      backgroundColor: "#f2f8fc", autoHideMenuBar: true,
      webPreferences: { preload: resolve(directory, "preload.cjs"), contextIsolation: true, sandbox: true, nodeIntegration: false, webviewTag: false, partition: "neko-fish-settings" },
    });
    settingsWindow = win;
    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    win.webContents.on("will-navigate", (event) => event.preventDefault());
    win.webContents.on("will-attach-webview", (event) => event.preventDefault());
    win.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    win.once("closed", () => { if (settingsWindow === win) settingsWindow = null; });
    win.once("ready-to-show", () => win.show());
    win.loadURL(settingsUrl).catch(() => { if (!win.isDestroyed()) win.close(); });
  };

  const configurePet = (mode: PetMode) => {
    const win = mode.window()?.window as DesktopWindow | undefined;
    if (!win) return;
    win.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    const menu = electron.Menu.buildFromTemplate([
      { label: "打开内置 DSH", click: () => { void dsh.open(); } },
      { label: "子代理显示数量", click: () => dsh.showLimitMenu(win) },
      { type: "separator" },
      { label: "API 设置", click: () => openSettings("api") },
      { label: "角色设定", click: () => openSettings("persona") },
      { label: "记忆管理", click: () => { void mode.overlay.handleCommand({ type: "show-memories" }).catch(() => {}); } },
      { label: "完整回复", click: () => { win.webContents.send("neko-pet:show-history"); } },
      { label: "全局设置", submenu: [
        { label: "子代理显示数量", click: () => dsh.showLimitMenu(win) },
        { label: "将桌宠移回可见区域", click: () => { mode.window()?.ensureVisible(); dsh.ensureHelpersVisible(); } },
      ] },
      { type: "separator" },
      { label: "退出", click: () => app.quit() },
    ]);
    win.webContents.on("context-menu", (event) => { event.preventDefault(); menu.popup({ window: win }); });
  };

  const runtime = new DesktopRuntime({
    electron,
    dataDir: app.getPath("userData"),
    repositoryRoot,
    assetsDir: resources.assetsDir,
    onPetReady: configurePet,
    onStop: () => dsh.stop(),
  });
  const validSender = (event: unknown) => settingsWindow !== null && !settingsWindow.isDestroyed()
    && isSettingsSender(event as SettingsSender, settingsWindow.webContents, settingsUrl);

  ipcMain.handle(SETTINGS_CHANNELS.read, (event) => {
    if (!validSender(event)) return { ok: false, error: "设置请求被拒绝。" };
    try { return { ok: true, section, ...runtime.read() }; }
    catch { return { ok: false, error: "设置读取失败，请检查用户数据目录。" }; }
  });
  ipcMain.handle(SETTINGS_CHANNELS.api, async (event, payload) => {
    if (!validSender(event)) return { ok: false, error: "设置请求被拒绝。" };
    try { await runtime.saveApi(payload); return { ok: true, hasKey: runtime.read().hasKey }; }
    catch { return { ok: false, error: "保存失败。请检查地址、模型、密钥和用户数据目录后重试。" }; }
  });
  ipcMain.handle(SETTINGS_CHANNELS.persona, async (event, payload) => {
    if (!validSender(event)) return { ok: false, error: "设置请求被拒绝。" };
    try { await runtime.savePersona(payload); return { ok: true }; }
    catch { return { ok: false, error: "保存失败。请检查角色名称、设定内容和用户数据目录后重试。" }; }
  });

  app.on("window-all-closed", () => {
    // A restart clears runtime.pet() before closing its window. Alt+F4 on the last
    // real window should exit instead of leaving an invisible process behind.
    if (runtime.pet()) app.quit();
  });
  app.on("second-instance", () => {
    const mode = runtime.pet();
    if (mode) {
      const hadWindow = mode.window() !== null;
      mode.openWindow();
      if (!hadWindow) configurePet(mode);
      mode.overlay.showDialog();
    } else openSettings("api");
  });
  app.on("before-quit", (event) => {
    if (shutdownDone) return;
    event.preventDefault();
    if (quitting) return;
    quitting = true;
    for (const channel of [SETTINGS_CHANNELS.read, SETTINGS_CHANNELS.api, SETTINGS_CHANNELS.persona]) ipcMain.removeHandler(channel);
    settingsWindow?.close();
    runtime.stop().finally(() => { shutdownDone = true; app.quit(); });
  });
  try {
    await runtime.start();
    if (startup.settings) openSettings("api");
    if (startup.dsh) await dsh.open();
  } catch (error) { await runtime.stop(); throw error; }
  return runtime;
}
