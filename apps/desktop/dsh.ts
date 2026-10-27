import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DshHost } from "../../packages/dsh-bridge/src/host.ts";
import type { DshClient } from "../../packages/dsh-bridge/src/session.ts";
import { sendSubagent, stopSubagent } from "../../packages/dsh-bridge/src/subagent.ts";
import { readDshCatalog, visibleAgents, type DshAgent, type AgentPreferences } from "../../packages/dsh-bridge/src/catalog.ts";
import { DshCatalogEvents } from "../../packages/dsh-bridge/src/catalog-events.ts";
import { startOverlayServer, type OverlayServer } from "../../packages/app-coordinator/src/overlay-server.ts";
import type { BrowserWindowLike, ElectronMainLike } from "../../packages/app-coordinator/src/pet-window.ts";
import { atomicJson } from "./settings.ts";
import { managePetGeometry, type PetGeometry } from "../../packages/app-coordinator/src/window-geometry.ts";

interface AgentWindow extends BrowserWindowLike {
  show(): void;
  focus(): void;
  webContents: BrowserWindowLike["webContents"] & {
    on(event: string, handler: (event: { preventDefault(): void }, url?: string) => void): void;
    session: { setPermissionRequestHandler(handler: (contents: unknown, permission: string, callback: (allowed: boolean) => void) => void): void };
  };
}
interface MenuItem { label?: string; type?: "separator"; click?: () => void; submenu?: MenuItem[] }
export interface DshElectron extends Omit<ElectronMainLike, "BrowserWindow"> {
  BrowserWindow: new (options: Record<string, unknown>) => AgentWindow;
  Menu: { buildFromTemplate(items: MenuItem[]): { popup(options: { window: AgentWindow }): void } };
  dialog: { showErrorBox(title: string, message: string): void };
  shell: { openExternal(url: string): Promise<void> };
}
interface Helper { agent: DshAgent; win: AgentWindow; geometry: PetGeometry; url: string; lastMessage: string; busy: boolean; error: string | null }
const directory = fileURLToPath(new URL("./", import.meta.url));
const CHANNEL = "bigfish-dsh:command";
const SNAPSHOT = "bigfish-dsh:snapshot";

export function readAgentPreferences(file: string): AgentPreferences {
  let raw: Record<string, unknown> = {};
  if (existsSync(file)) {
    try { const value = JSON.parse(readFileSync(file, "utf8")); if (typeof value === "object" && value !== null && !Array.isArray(value)) raw = value; } catch { /* Keep a corrupt file untouched until the user saves. */ }
  }
  const nicknames: Record<string, string> = Object.create(null);
  if (typeof raw.nicknames === "object" && raw.nicknames !== null) for (const [id, name] of Object.entries(raw.nicknames)) {
    if (typeof name === "string" && name.trim() && name.length <= 40) nicknames[id] = name;
  }
  return { limit: Number.isInteger(raw.limit) && Number(raw.limit) >= 1 && Number(raw.limit) <= 10 ? Number(raw.limit) : 5,
    pinned: Array.isArray(raw.pinned) ? raw.pinned.filter((id): id is string => typeof id === "string").slice(0, 1000) : [], nicknames };
}

/** DSH owns tasks and files. This controller owns only its window and companion views. */
export class DshDesktop {
  private readonly electron: DshElectron;
  private readonly host: Pick<DshHost, "start" | "stop" | "pid">;
  private readonly preferencesFile: string;
  private preferences: AgentPreferences;
  private agents: DshAgent[] = [];
  private readonly helpers = new Map<string, Helper>();
  private server: OverlayServer | null = null;
  private dshWindow: AgentWindow | null = null;
  private client: DshClient | null = null;
  private url: string | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private pending: Promise<void> | null = null;
  private refreshing: Promise<void> | null = null;
  private catalogEvents: DshCatalogEvents | null = null;
  private refreshAgain = false;
  private closed = false;
  private connected = false;
  private stopping: Promise<void> | null = null;
  private readonly assetsDir?: string;

  constructor(options: { electron: DshElectron; repositoryRoot: string; dataDir: string; assetsDir?: string; dshRuntimeDir?: string; primaryRuntimeDir?: string; host?: Pick<DshHost, "start" | "stop" | "pid"> }) {
    this.electron = options.electron;
    this.assetsDir = options.assetsDir;
    this.preferencesFile = join(options.dataDir, "dsh-pets.json");
    this.preferences = readAgentPreferences(this.preferencesFile);
    const sandbox = resolve(options.repositoryRoot, "../_sandbox/f01-dsh-desktop");
    this.host = options.host ?? new DshHost({
      runtimeDir: options.dshRuntimeDir ?? (process.env.NEKO_FISH_DSH_RUNTIME || join(sandbox, "src/apps/desktop/.desktop-build/development/project")),
      primaryRuntimeDir: options.primaryRuntimeDir ?? (process.env.NEKO_FISH_DSH_PRIMARY_RUNTIME || join(sandbox, "primary-runtime-stub/primary-runtime")),
      dataDir: options.dataDir,
      onExit: () => {
        void this.catalogEvents?.stop(); this.catalogEvents = null;
        this.client = null; this.connected = false; this.url = null;
        clearTimeout(this.timer);
        this.dshWindow?.close(); this.dshWindow = null;
        for (const helper of this.helpers.values()) this.push(helper);
      },
    });
    this.electron.ipcMain.handle(CHANNEL, this.command);
  }

  pid(): number | undefined { return this.host.pid(); }
  ensureHelpersVisible(): void { for (const helper of this.helpers.values()) helper.geometry.refresh(); }
  snapshot() { return { connected: this.connected, count: this.agents.length, limit: this.preferences.limit }; }

  open(): Promise<void> {
    if (this.closed) return Promise.reject(new Error("DSH is closing."));
    return this.pending ??= this.openNow().catch(() => {
      if (!this.closed) this.electron.dialog.showErrorBox("DSH 暂时无法打开", "请检查本机 DSH 运行目录，稍后从右键菜单重试。陪伴聊天仍可使用。");
    }).finally(() => { this.pending = null; });
  }

  private async openNow(): Promise<void> {
    if (!this.client) {
      const { url, client } = await this.host.start();
      if (this.closed) return;
      this.client = client; this.url = url; this.connected = true;
      this.catalogEvents = new DshCatalogEvents(client, () => this.scheduleRefresh());
      this.server ??= await startOverlayServer({ app_dir: resolve(directory, "../agent-pet"), assets_dir: this.assetsDir });
      if (this.closed) return;
      await this.refresh();
    }
    if (this.closed) return;
    if (this.dshWindow && !this.dshWindow.isDestroyed()) { this.dshWindow.show(); this.dshWindow.focus(); return; }
    const win = new this.electron.BrowserWindow({ title: "DSH · 工作台", width: 1180, height: 800, minWidth: 800, minHeight: 580, show: false,
      autoHideMenuBar: true, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, partition: "persist:bigfish-dsh" } });
    this.dshWindow = win;
    const origin = new URL(this.url!).origin;
    const openExternal = (value: string) => {
      try { if (new URL(value).protocol === "https:") void this.electron.shell.openExternal(value).catch(() => {}); } catch {}
    };
    win.webContents.setWindowOpenHandler((details?: { url: string }) => { if (details) openExternal(details.url); return { action: "deny" }; });
    win.webContents.on("will-navigate", (event: { preventDefault(): void }, url?: string) => {
      try { if (url && new URL(url).origin === origin) return; } catch {}
      event.preventDefault(); if (url) openExternal(url);
    });
    win.webContents.session.setPermissionRequestHandler((_c, _p, callback) => callback(false));
    win.once("closed", () => { if (this.dshWindow === win) this.dshWindow = null; });
    try { await win.loadURL(this.url!); if (!win.isDestroyed()) win.show(); }
    catch { if (!win.isDestroyed()) win.close(); throw new Error("DSH window load failed."); }
  }

  private scheduleRefresh(): void {
    if (this.closed || !this.client) return;
    clearTimeout(this.timer);
    if (this.refreshing) { this.refreshAgain = true; return; }
    void this.refresh();
  }

  private refresh(): Promise<void> {
    clearTimeout(this.timer);
    return this.refreshing ??= (async () => {
      const client = this.client;
      if (!client || this.closed) return;
      try {
        const agents = await readDshCatalog(client, this.catalogEvents?.rootOrder());
        if (this.closed || this.client !== client) return;
        this.connected = true;
        this.agents = agents;
        this.reconcile();
      } catch {
        // Preserve existing windows during transient outages; do not invent completion.
        if (this.closed || this.client !== client) return;
        this.connected = false;
        for (const helper of this.helpers.values()) this.push(helper);
      }
    })().finally(() => {
      this.refreshing = null;
      if (!this.closed && this.client) {
        const delay = this.refreshAgain ? 0 : 2000;
        this.refreshAgain = false;
        this.timer = setTimeout(() => { void this.refresh(); }, delay);
      }
    });
  }

  private reconcile(): void {
    if (this.closed || !this.server) return;
    const visible = visibleAgents(this.agents, this.preferences);
    const ids = new Set(visible.map((a) => a.id));
    for (const [id, helper] of this.helpers) if (!ids.has(id)) { helper.win.close(); this.helpers.delete(id); }
    visible.forEach((agent, index) => {
      const existing = this.helpers.get(agent.id);
      if (existing) { existing.agent = agent; this.push(existing); return; }
      const area = this.electron.screen.getPrimaryDisplay().workArea;
      const width = 360, height = 440;
      const columns = Math.max(1, Math.floor(area.width / 240));
      const win = new this.electron.BrowserWindow({ title: "DSH 子代理", width, height,
        x: Math.max(area.x, area.x + area.width - 400 - (index % columns + 1) * 230),
        y: Math.max(area.y, area.y + area.height - height - 24 - Math.floor(index / columns) * 200),
        frame: false, transparent: true, alwaysOnTop: true, skipTaskbar: true, resizable: false, hasShadow: false, show: false,
        webPreferences: { preload: resolve(directory, "../agent-pet/preload.cjs"), partition: `neko-agent-${agent.id}`, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
      let geometry: PetGeometry;
      try { geometry = managePetGeometry(win, this.electron.screen, { width, height }); }
      catch (error) { win.close(); throw error; }
      const helper = { agent, win, geometry, url: this.server!.url, lastMessage: "", busy: false, error: null };
      this.helpers.set(agent.id, helper);
      try {
      win.setIgnoreMouseEvents(true, { forward: true });
      win.setAlwaysOnTop(true, "screen-saver");
      win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      for (const name of ["will-navigate", "will-frame-navigate", "will-redirect"]) win.webContents.on(name, (e) => e.preventDefault());
      win.webContents.session.setPermissionRequestHandler((_c, _p, callback) => callback(false));
      win.webContents.on("context-menu", (event) => { event.preventDefault(); this.menu(helper); });
      win.webContents.once("did-finish-load", () => { geometry.refresh(); this.push(helper); });
      win.once("closed", () => { geometry.dispose(); if (this.helpers.get(agent.id) === helper) this.helpers.delete(agent.id); });
      void win.loadURL(helper.url).then(() => { if (!this.closed && !win.isDestroyed()) win.showInactive(); }).catch(() => { win.close(); });
      } catch (error) {
        geometry.dispose(); this.helpers.delete(agent.id); win.close(); throw error;
      }
    });
  }

  private menu(helper: Helper): void {
    const id = helper.agent.id;
    const pinned = this.preferences.pinned.includes(id);
    this.electron.Menu.buildFromTemplate([
      { label: "打开 DSH 工作台 / 成果", click: () => { void this.open(); } },
      { label: pinned ? "取消常驻桌面" : "常驻桌面", click: () => this.savePreferences({ ...this.preferences, pinned: pinned ? this.preferences.pinned.filter((v) => v !== id) : [...this.preferences.pinned, id] }) },
      { label: "修改本地昵称", click: () => helper.win.webContents.send(SNAPSHOT, { rename: true }) },
      { label: "恢复 DSH 名称", click: () => { const names = { ...this.preferences.nicknames }; delete names[id]; this.savePreferences({ ...this.preferences, nicknames: names }); } },
      { label: "停止任务", click: () => { void this.perform(helper, "cancel"); } },
    ]).popup({ window: helper.win });
  }

  showLimitMenu(window: AgentWindow): void {
    this.electron.Menu.buildFromTemplate([1, 3, 5, 10].map((limit) => ({ label: `${limit === this.preferences.limit ? "✓ " : ""}最多 ${limit} 个子代理`, click: () => this.savePreferences({ ...this.preferences, limit }) }))).popup({ window });
  }

  private savePreferences(next: AgentPreferences): void {
    try { atomicJson(this.preferencesFile, next); this.preferences = next; this.reconcile(); }
    catch { this.electron.dialog.showErrorBox("设置未保存", "无法保存子代理桌面设置，请检查用户数据目录。"); }
  }

  private push(helper: Helper): void {
    if (this.closed || helper.win.isDestroyed() || helper.win.webContents.mainFrame.url !== helper.url) return;
    helper.win.webContents.send(SNAPSHOT, { agent: helper.agent, connected: this.connected, busy: helper.busy, lastMessage: helper.lastMessage, error: helper.error,
      pinned: this.preferences.pinned.includes(helper.agent.id) });
  }

  private async perform(helper: Helper, operation: "send" | "cancel", text?: string): Promise<{ ok: boolean }> {
    if (helper.busy || !this.client || !this.connected || this.closed) return { ok: false };
    helper.busy = true; helper.error = null; this.push(helper);
    try {
      if (helper.agent.mode !== "continuable") {
        helper.error = "此类子代理由 DSH 管理，请在工作台中操作。";
        return { ok: false };
      }
      if (operation === "send") { await sendSubagent(this.client, helper.agent.parentId, helper.agent.id, text!); helper.lastMessage = text!; }
      else await stopSubagent(this.client, helper.agent.parentId, helper.agent.id);
      this.push(helper);
      return { ok: true };
    } catch { helper.error = operation === "send" ? "DSH 未接受消息，请在工作台查看会话后重试。" : "停止请求失败，请在 DSH 工作台查看。"; return { ok: false }; }
    finally { helper.busy = false; this.push(helper); }
  }

  private command = async (event: { sender: unknown; senderFrame?: unknown }, raw: unknown): Promise<unknown> => {
    const helper = [...this.helpers.values()].find((h) => h.win.webContents === event.sender);
    if (!helper || this.closed || helper.win.isDestroyed() || event.senderFrame !== helper.win.webContents.mainFrame || helper.win.webContents.mainFrame.url !== helper.url) return { ok: false };
    const c = typeof raw === "object" && raw !== null ? raw as Record<string, unknown> : {};
    if (c.type === "snapshot") { this.push(helper); return { ok: true }; }
    if (c.type === "hit" && typeof c.inside === "boolean") helper.win.setIgnoreMouseEvents(!c.inside, { forward: true });
    if ((c.type === "drag-start" || c.type === "drag-move") && Number.isFinite(c.screen_x) && Number.isFinite(c.screen_y)) {
      const point = { x: Number(c.screen_x), y: Number(c.screen_y) };
      if (c.type === "drag-start") helper.geometry.begin(point);
      else helper.geometry.move(point);
    }
    if (c.type === "drag-end") helper.geometry.end();
    if (c.type === "send" && typeof c.text === "string" && c.text.trim() && c.text.length <= 8000) return this.perform(helper, "send", c.text.trim());
    if (c.type === "rename" && typeof c.name === "string" && c.name.trim() && c.name.trim().length <= 40) this.savePreferences({ ...this.preferences, nicknames: { ...this.preferences.nicknames, [helper.agent.id]: c.name.trim() } });
    if (c.type === "open") await this.open();
    return { ok: true };
  };

  stop(): Promise<void> {
    this.closed = true; clearTimeout(this.timer);
    return this.stopping ??= (async () => {
      await this.catalogEvents?.stop(); this.catalogEvents = null;
      this.electron.ipcMain.removeHandler(CHANNEL);
      this.dshWindow?.close(); this.dshWindow = null;
      for (const helper of this.helpers.values()) helper.win.close();
      this.helpers.clear();
      await this.host.stop();
      await this.pending?.catch(() => {});
      await this.refreshing?.catch(() => {});
      await this.server?.close(); this.server = null;
    })();
  }
}
