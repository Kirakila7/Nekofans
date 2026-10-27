import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DshDesktop, readAgentPreferences, type DshElectron } from "../../apps/desktop/dsh.ts";
import { clientFixture } from "../dsh-bridge/fixture.ts";

async function fixture(t: TestContext) {
  const dataDir = mkdtempSync(join(tmpdir(), "dsh-desktop-test-"));
  const f = await clientFixture();
  const windows: Window[] = [];
  const handlers = new Map<string, (...args: any[]) => any>();
  const errors: string[] = [];
  let hostStarts = 0, hostStops = 0;
  let menu: Array<{ label?: string; click?: () => void }> = [];
  class Window extends EventEmitter {
    id = windows.length + 1; destroyed = false; ignored = true; position = [0, 0];
    webContents = Object.assign(new EventEmitter(), {
      mainFrame: { url: "" }, isDestroyed: () => this.destroyed,
      send: (_channel: string, snapshot: unknown) => { this.messages.push(snapshot); },
      setWindowOpenHandler: () => {}, session: { setPermissionRequestHandler: () => {} },
    });
    messages: any[] = [];
    options: Record<string, unknown>;
    constructor(options: Record<string, unknown>) { super(); this.options = options; windows.push(this); }
    async loadURL(url: string) { this.webContents.mainFrame.url = url; this.webContents.emit("did-finish-load"); }
    setAlwaysOnTop() {} setIgnoreMouseEvents(ignore: boolean) { this.ignored = ignore; }
    showInactive() {} show() {} focus() {}
    getPosition() { return this.position; } setPosition(x: number, y: number) { this.position = [x, y]; }
    isDestroyed() { return this.destroyed; }
    close() { if (this.destroyed) return; this.destroyed = true; this.emit("closed"); }
  }
  let cursor = { x: 100, y: 100 };
  const screen = Object.assign(new EventEmitter(), { getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }), getCursorScreenPoint: () => cursor });
  const desktop = new DshDesktop({ dataDir, repositoryRoot: fileURLToPath(new URL("../../", import.meta.url)),
    electron: { BrowserWindow: Window, screen,
      ipcMain: { handle: (channel: string, fn: (...args: any[]) => any) => handlers.set(channel, fn), removeHandler: (channel: string) => handlers.delete(channel) },
      Menu: { buildFromTemplate: (items: typeof menu) => { menu = items; return { popup: () => {} }; } },
      dialog: { showErrorBox: (_title: string, message: string) => errors.push(message) }, shell: { openExternal: async () => {} },
    } as unknown as DshElectron,
    host: { start: async () => { hostStarts++; return { client: f.client, url: f.client.origin + "/?token=synthetic" }; }, stop: async () => { hostStops++; }, pid: () => undefined },
  });
  const command = (win: Window, value: unknown, overrides = {}) => handlers.get("bigfish-dsh:command")!({ sender: win.webContents, senderFrame: win.webContents.mainFrame, ...overrides }, value);
  t.after(async () => { await desktop.stop(); rmSync(dataDir, { recursive: true, force: true }); });
  return { ...f, desktop, windows, handlers, errors, dataDir, command, screen, cursor: (point: typeof cursor) => { cursor = point; }, hostStarts: () => hostStarts, hostStops: () => hostStops, menu: () => menu };
}

test("DSH starts lazily, reuses its Host and window, and closing the workbench leaves tasks and companions alive", async (t) => {
  const f = await fixture(t); assert.equal(f.hostStarts(), 0);
  await Promise.all([f.desktop.open(), f.desktop.open()]);
  assert.equal(f.hostStarts(), 1); assert.equal(f.windows.length, 3);
  const workbench = f.windows.find((w) => w.options.title === "DSH · 工作台")!;
  workbench.close(); assert.equal(f.hostStops(), 0);
  assert.equal(f.windows.filter((w) => !w.destroyed).length, 2);
  await f.desktop.open(); assert.equal(f.hostStarts(), 1);
  assert.equal(f.windows.length, 4);
  await f.desktop.stop(); await f.desktop.stop();
  assert.equal(f.hostStops(), 1); assert.ok(f.windows.every((w) => w.destroyed)); assert.equal(f.handlers.size, 0);
});

test("only the matching helper and exact main frame can send; routing uses the real parent and child", async (t) => {
  const f = await fixture(t); await f.desktop.open();
  const helper = f.windows.find((w) => w.messages.at(-1)?.agent?.id === "child-b")!;
  const before = f.calls.length;
  assert.deepEqual(await f.command(helper, { type: "send", text: "spoofed" }, { sender: {} }), { ok: false });
  assert.deepEqual(await f.command(helper, { type: "send", text: "spoofed" }, { senderFrame: { url: helper.webContents.mainFrame.url } }), { ok: false });
  assert.equal(f.calls.length, before);
  assert.deepEqual(await f.command(helper, { type: "send", text: "continue real child" }), { ok: true });
  assert.equal(f.calls.at(-1)?.method, "subagents/prompt");
  assert.equal(helper.messages.at(-1).lastMessage, "continue real child");
  assert.equal(helper.messages.at(-1).busy, false);
  helper.webContents.mainFrame.url = "https://untrusted.invalid/";
  assert.deepEqual(await f.command(helper, { type: "send", text: "spoofed" }), { ok: false });
});

test("one-shot children remain view-only, errors preserve the last accepted message, and names remain local", async (t) => {
  const f = await fixture(t); await f.desktop.open();
  const single = f.windows.find((w) => w.messages.at(-1)?.agent?.id === "child-a")!;
  const before = f.calls.length;
  assert.deepEqual(await f.command(single, { type: "send", text: "do not dispatch" }), { ok: false });
  assert.equal(f.calls.length, before);
  const helper = f.windows.find((w) => w.messages.at(-1)?.agent?.id === "child-b")!;
  f.state.fail = true;
  assert.deepEqual(await f.command(helper, { type: "send", text: "not accepted" }), { ok: false });
  assert.equal(helper.messages.at(-1).lastMessage, ""); assert.ok(helper.messages.at(-1).error); assert.equal(helper.messages.at(-1).busy, false);
  await f.command(helper, { type: "rename", name: "本地昵称" });
  assert.equal(helper.messages.at(-1).agent.name, "本地昵称");
  assert.equal(JSON.parse(readFileSync(join(f.dataDir, "dsh-pets.json"), "utf8")).nicknames["child-b"], "本地昵称");
  assert.equal(f.calls.at(-1)?.method, "subagents/prompt");
  single.webContents.emit("context-menu", { preventDefault() {} });
  f.menu().find((i) => i.label === "常驻桌面")!.click!();
  assert.ok(readAgentPreferences(join(f.dataDir, "dsh-pets.json")).pinned.includes("child-a"));
});

test("preferences reject malformed data and retain the default limit of five", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-preferences-")); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "prefs.json");
  for (const raw of ["null", "[]", "broken", '{"limit":999}']) { writeFileSync(file, raw); assert.equal(readAgentPreferences(file).limit, 5); }
});

test("helper drag uses DIP cursor, guards the screen edge, and releases display subscriptions", async (t) => {
  const f = await fixture(t); await f.desktop.open();
  const helper = f.windows.find((w) => w.messages.at(-1)?.agent?.id === "child-b")!;
  const other = f.windows.find((w) => w.messages.at(-1)?.agent?.id === "child-a")!;
  assert.notEqual((helper.options.webPreferences as any).partition, (other.options.webPreferences as any).partition);
  assert.equal(f.screen.listenerCount("display-removed"), 2);
  await f.command(helper, { type: "drag-start", screen_x: 9999, screen_y: 9999 });
  f.cursor({ x: 500, y: 500 });
  await f.command(helper, { type: "drag-move", screen_x: -9999, screen_y: -9999 });
  assert.deepEqual(helper.position, [400, 400]);
  f.cursor({ x: 50000, y: 50000 });
  await f.command(helper, { type: "drag-move", screen_x: 0, screen_y: 0 });
  assert.deepEqual(helper.position, [1560, 640]);
  await f.command(helper, { type: "drag-end" });
  helper.setPosition(-50000, -50000); f.desktop.ensureHelpersVisible();
  assert.deepEqual(helper.position, [0, 0]);
  await f.desktop.stop(); assert.equal(f.screen.listenerCount("display-removed"), 0);
});

test("read-only catalog events refresh helper state promptly and stop with the desktop", async (t) => {
  const f = await fixture(t);
  const queues = new Map<string, unknown[]>();
  const wakes = new Map<string, () => void>();
  let stopped = 0;
  f.client.stream = async function* (endpoint, _args, signal) {
    const queue: unknown[] = []; queues.set(endpoint, queue);
    const wake = () => wakes.get(endpoint)?.();
    signal.addEventListener("abort", wake);
    try {
      yield endpoint === "workspace/follow"
        ? { type: "baseline", value: { items: [{ workspaceId: "workspace", sessionIds: ["parent"] }] } }
        : { type: "baseline", value: { projections: {} } };
      while (!signal.aborted) {
        if (queue.length) yield queue.shift();
        else await new Promise<void>((resolve) => wakes.set(endpoint, resolve));
      }
    } finally { signal.removeEventListener("abort", wake); stopped++; }
  };
  await f.desktop.open();
  const helper = f.windows.find((w) => w.messages.at(-1)?.agent?.id === "child-b")!;
  assert.equal(helper.messages.at(-1).agent.status, "running");
  f.state.running = false;
  queues.get("session/control")!.push({ type: "projection", sessionId: "child-b", key: "subagentTiming", seq: 2 });
  wakes.get("session/control")?.();
  // Deadline is shorter than the 2s fallback poll: this must arrive via the event path.
  const deadline = Date.now() + 1000;
  while (helper.messages.at(-1).agent.status !== "success" && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(helper.messages.at(-1).agent.status, "success");
  await f.desktop.stop(); assert.equal(stopped, 2);
  const count = f.calls.length;
  queues.get("session/control")!.push({ type: "projection", sessionId: "child-b", key: "title", seq: 3 });
  wakes.get("session/control")?.();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(f.calls.length, count);
});
