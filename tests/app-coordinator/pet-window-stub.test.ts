// F09 pet window against a fake electron module: window options, IPC routing,
// click-through toggling, drag, and that closing the window leaves the reply and tasks running.
// (File name kept from the M0 stub test; it now covers the real openPetWindow.)

import { test } from "node:test";
import assert from "node:assert/strict";
import { TaskBridge, type DshTaskPort } from "../../packages/dsh-bridge/src/task-bridge.ts";
import { createAvatarRuntime } from "../../packages/avatar-runtime/src/state-machine.ts";
import type { MainChatPort, MainChatState, MainChatTurnResult } from "../../packages/app-contracts/src/index.ts";
import { PetOverlay } from "../../packages/app-coordinator/src/pet-overlay.ts";
import { openPetWindow, type ElectronMainLike } from "../../packages/app-coordinator/src/pet-window.ts";
import { OVERLAY_CHANNELS, parseOverlayCommand } from "../../packages/app-coordinator/src/overlay-protocol.ts";

type Listener = (...args: unknown[]) => unknown;

function fakeElectron(failAt?: "topmost" | "command-listener" | "ready-listener") {
  const handlers = new Map<string, Listener>();
  const listeners = new Map<string, Set<Listener>>();
  const windows: FakeWindow[] = [];

  class FakeWindow {
    static seq = 0;
    readonly id = ++FakeWindow.seq;
    readonly opts: Record<string, unknown>;
    readonly sent: Array<[string, unknown]> = [];
    readonly ignore: Array<[boolean, unknown]> = [];
    readonly events = new Map<string, Listener>();
    readonly wcEvents = new Map<string, Listener>();
    pos = [0, 0];
    destroyed = false;
    shown = false;
    url = "";
    windowOpenHandler: (() => { action: "deny" }) | null = null;
    readonly webContents = {
      mainFrame: { url: "" },
      send: (channel: string, payload: unknown) => this.sent.push([channel, payload]),
      isDestroyed: () => this.destroyed,
      once: (event: string, fn: Listener) => this.wcEvents.set(event, fn),
      on: (event: string, fn: Listener) => this.wcEvents.set(event, fn),
      setWindowOpenHandler: (fn: () => { action: "deny" }) => { this.windowOpenHandler = fn; },
    };
    constructor(opts: Record<string, unknown>) {
      this.opts = opts;
      this.pos = [opts.x as number, opts.y as number];
      windows.push(this);
    }
    async loadURL(url: string) {
      this.url = url;
      this.webContents.mainFrame.url = url;
      this.wcEvents.get("did-finish-load")?.();
      this.events.get("ready-to-show")?.();
    }
    showInactive() {
      this.shown = true;
    }
    close() {
      this.destroyed = true;
      this.events.get("closed")?.();
    }
    isDestroyed() {
      return this.destroyed;
    }
    getPosition() {
      return [...this.pos];
    }
    setPosition(x: number, y: number) {
      this.pos = [x, y];
    }
    setAlwaysOnTop() {
      if (failAt === "topmost") throw new Error("topmost initialization failed");
    }
    setIgnoreMouseEvents(ignore: boolean, opts?: unknown) {
      this.ignore.push([ignore, opts]);
    }
    once(event: string, fn: Listener) {
      this.events.set(event, fn);
      if (event === "ready-to-show" && failAt === "ready-listener") throw new Error("ready-listener initialization failed");
    }
  }

  const electron: ElectronMainLike = {
    BrowserWindow: FakeWindow as unknown as ElectronMainLike["BrowserWindow"],
    ipcMain: {
      handle: (channel, fn) => {
        if (handlers.has(channel)) throw new Error(`second handler for ${channel}`);
        handlers.set(channel, fn as Listener);
      },
      removeHandler: (channel) => {
        handlers.delete(channel);
      },
      on: (channel, fn) => {
        if (!listeners.has(channel)) listeners.set(channel, new Set());
        listeners.get(channel)!.add(fn as Listener);
        if (failAt === "command-listener") throw new Error("command-listener initialization failed");
      },
      removeListener: (channel, fn) => {
        listeners.get(channel)?.delete(fn as Listener);
      },
    },
    screen: { getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1040 } }) },
  };
  return {
    electron,
    windows,
    invoke: (channel: string, sender: unknown, senderFrame: unknown = (sender as { mainFrame?: unknown })?.mainFrame) =>
      handlers.get(channel)?.({ sender, senderFrame }),
    emit: (channel: string, sender: unknown, payload: unknown, senderFrame: unknown = (sender as { mainFrame?: unknown })?.mainFrame) => {
      for (const fn of listeners.get(channel) ?? []) fn({ sender, senderFrame }, payload);
    },
    listenerCount: (channel: string) => listeners.get(channel)?.size ?? 0,
    hasHandler: (channel: string) => handlers.has(channel),
  };
}

function fakeDsh(): DshTaskPort & { cancelled: string[] } {
  const port = {
    cancelled: [] as string[],
    createSession: async () => "session-1",
    send: async () => {},
    cancel: async (id: string) => {
      port.cancelled.push(id);
    },
  };
  return port;
}

/** Main chat whose turns end only when finish() is called. */
function fakeChat() {
  let state: MainChatState = { personaId: "bigfish", phase: "idle" };
  const listeners = new Set<(s: MainChatState) => void>();
  let settle: ((r: MainChatTurnResult) => void) | null = null;
  const set = (next: MainChatState) => {
    state = next;
    for (const fn of listeners) fn({ ...state });
  };
  const chat = {
    sent: [] as string[],
    state: () => ({ ...state }),
    subscribe(fn: (s: MainChatState) => void) {
      listeners.add(fn);
      fn({ ...state });
      return () => listeners.delete(fn);
    },
    async send(text: string) {
      if (settle) throw new Error("busy");
      chat.sent.push(text);
      set({ personaId: "bigfish", phase: "replying", lastUserMessage: text, reply: "" });
      return new Promise<MainChatTurnResult>((resolve) => (settle = resolve));
    },
    cancel: () => false,
    delta(text: string) {
      set({ ...state, reply: (state.reply ?? "") + text });
    },
    finish() {
      const text = state.reply ?? "";
      set({ personaId: "bigfish", phase: "idle", reply: text });
      const fn = settle;
      settle = null;
      fn?.({ status: "completed", messageId: "m-1", text });
    },
    running: () => settle !== null,
  };
  return chat satisfies MainChatPort & Record<string, unknown>;
}

const flush = () => new Promise((r) => setImmediate(r));

test("openPetWindow creates a transparent, frameless, click-through, sandboxed window", async () => {
  const fx = fakeElectron();
  const overlay = new PetOverlay({ chat: fakeChat(), tasks: new TaskBridge({ dsh: fakeDsh() }) });
  const handle = openPetWindow({ electron: fx.electron, overlay, url: "http://127.0.0.1:1/index.html", preload: "/p.cjs" });
  await handle.ready;
  const win = fx.windows[0];
  assert.equal(handle.windowId, `pet-${win.id}`);
  assert.equal(win.opts.transparent, true);
  assert.equal(win.opts.frame, false);
  assert.equal(win.opts.alwaysOnTop, true);
  assert.equal(win.opts.skipTaskbar, true);
  const prefs = win.opts.webPreferences as Record<string, unknown>;
  assert.equal(prefs.contextIsolation, true);
  assert.equal(prefs.sandbox, true);
  assert.equal(prefs.nodeIntegration, false);
  assert.equal(prefs.preload, "/p.cjs");
  assert.deepEqual(win.ignore[0], [true, { forward: true }], "starts click-through");
  assert.equal(win.shown, true);
  assert.equal(win.url, "http://127.0.0.1:1/index.html");
  // Bottom-right of the work area.
  assert.deepEqual(win.pos, [1920 - 420 - 24, 1040 - 640 - 24]);
  handle.close();
  overlay.dispose();
});

test("IPC: snapshot invoke, commands routed, other senders ignored, pushes on change", async () => {
  const fx = fakeElectron();
  const chat = fakeChat();
  const overlay = new PetOverlay({ chat });
  const handle = openPetWindow({ electron: fx.electron, overlay, url: "u", preload: "p" });
  const win = fx.windows[0];
  const me = win.webContents;

  assert.equal((fx.invoke(OVERLAY_CHANNELS.getSnapshot, me) as { dialog_visible: boolean }).dialog_visible, false);
  assert.equal(fx.invoke(OVERLAY_CHANNELS.getSnapshot, {}), null, "foreign sender gets nothing");

  fx.emit(OVERLAY_CHANNELS.command, {}, { type: "show-dialog" });
  await flush();
  assert.equal(overlay.isDialogVisible(), false, "foreign sender cannot drive the overlay");

  fx.emit(OVERLAY_CHANNELS.command, me, { type: "show-dialog" });
  await flush();
  assert.equal(overlay.isDialogVisible(), true);
  const last = win.sent.at(-1)!;
  assert.equal(last[0], OVERLAY_CHANNELS.snapshot);
  assert.equal((last[1] as { dialog_visible: boolean }).dialog_visible, true);

  const before = win.sent.length;
  fx.emit(OVERLAY_CHANNELS.command, me, { type: "submit", text: 42 });
  fx.emit(OVERLAY_CHANNELS.command, me, { type: "nope" });
  await flush();
  assert.equal(win.sent.length, before, "invalid commands are dropped");

  fx.emit(OVERLAY_CHANNELS.command, me, { type: "submit", text: "开始" });
  await flush();
  assert.deepEqual(chat.sent, ["开始"], "submit reaches the main chat");
  chat.delta("好");
  const pushed = win.sent.at(-1)![1] as { chat: { phase: string; streaming: string } };
  assert.deepEqual(pushed.chat, { phase: "replying", streaming: "好", error: null });
  chat.finish();
  await flush();
  handle.close();
  overlay.dispose();
});

test("IPC only trusts the exact overlay URL in the main frame, including snapshot pushes", async () => {
  const fx = fakeElectron();
  const overlay = new PetOverlay({ chat: fakeChat() });
  const url = "http://127.0.0.1:59050/index.html";
  const handle = openPetWindow({ electron: fx.electron, overlay, url, preload: "p" });
  const win = fx.windows[0];
  const me = win.webContents;
  try {
    for (const frame of [null, { url }, { url: "https://example.invalid/" }]) {
      assert.equal(fx.invoke(OVERLAY_CHANNELS.getSnapshot, me, frame), null, "missing frames and iframes cannot read state");
      fx.emit(OVERLAY_CHANNELS.command, me, { type: "show-dialog" }, frame);
      assert.equal(overlay.isDialogVisible(), false, "missing frames and iframes cannot send commands");
    }

    for (const foreignUrl of [url + "?other", url + "#other", "http://127.0.0.1:59050/other.html", "https://example.invalid/"]) {
      me.mainFrame.url = foreignUrl;
      assert.equal(fx.invoke(OVERLAY_CHANNELS.getSnapshot, me), null, "a navigated main frame cannot read state");
      fx.emit(OVERLAY_CHANNELS.command, me, { type: "show-dialog" });
      assert.equal(overlay.isDialogVisible(), false, "a navigated main frame cannot send commands");
      const before = win.sent.length;
      overlay.showDialog();
      overlay.hideDialog();
      assert.equal(win.sent.length, before, "a navigated page receives no chat or memory snapshots");
    }

    me.mainFrame.url = url;
    assert.notEqual(fx.invoke(OVERLAY_CHANNELS.getSnapshot, me), null);
    fx.emit(OVERLAY_CHANNELS.command, me, { type: "show-dialog" });
    assert.equal(overlay.isDialogVisible(), true);
    assert.ok(win.sent.length > 0, "trusted main frame receives updates");
    await flush();
  } finally {
    handle.close();
    overlay.dispose();
  }
});

test("pet window denies page navigation, redirects, frame navigation and new windows", () => {
  const fx = fakeElectron();
  const overlay = new PetOverlay({ chat: fakeChat() });
  const handle = openPetWindow({ electron: fx.electron, overlay, url: "http://127.0.0.1:59050/index.html", preload: "p" });
  const win = fx.windows[0];
  try {
    for (const event of ["will-navigate", "will-frame-navigate", "will-redirect"]) {
      let prevented = false;
      assert.ok(win.wcEvents.has(event), `listens for ${event}`);
      win.wcEvents.get(event)?.({ preventDefault: () => { prevented = true; } });
      assert.equal(prevented, true, `${event} is blocked`);
    }
    assert.deepEqual(win.windowOpenHandler?.(), { action: "deny" });
  } finally {
    handle.close();
    overlay.dispose();
  }
});

test("failed commands log only the command type, without exception or user content", async (t) => {
  const fx = fakeElectron();
  const overlay = new PetOverlay({ chat: fakeChat() });
  const handle = openPetWindow({ electron: fx.electron, overlay, url: "u", preload: "p" });
  const warn = t.mock.method(console, "warn", () => {});
  t.mock.method(overlay, "handleCommand", async () => { throw new Error("private chat and api-key fixture"); });
  try {
    fx.emit(OVERLAY_CHANNELS.command, fx.windows[0].webContents, { type: "memory-update", id: "m-1", text: "private memory fixture" });
    await flush();
    assert.deepEqual(warn.mock.calls.map((call) => call.arguments), [["[app-coordinator] pet command failed:", "memory-update"]]);
  } finally {
    handle.close();
    overlay.dispose();
  }
});

test("synchronous window initialization failures close the allocated window and undo registered resources", (t) => {
  for (const stage of ["topmost", "command-listener", "ready-listener"] as const) {
    const fx = fakeElectron(stage);
    const overlay = new PetOverlay({ chat: fakeChat() });
    let activeSubscriptions = 0;
    const subscribe = overlay.subscribe.bind(overlay);
    t.mock.method(overlay, "subscribe", (listener: Parameters<PetOverlay["subscribe"]>[0]) => {
      const unsubscribe = subscribe(listener);
      activeSubscriptions++;
      return () => { activeSubscriptions--; unsubscribe(); };
    });
    try {
      assert.throws(() => openPetWindow({ electron: fx.electron, overlay, url: "u", preload: "p" }), new RegExp(`${stage} initialization failed`));
      assert.equal(fx.windows.length, 1);
      assert.equal(fx.windows[0].destroyed, true, `${stage}: the allocated window closes`);
      assert.equal(fx.hasHandler(OVERLAY_CHANNELS.getSnapshot), false, `${stage}: snapshot handler is removed`);
      assert.equal(fx.listenerCount(OVERLAY_CHANNELS.command), 0, `${stage}: command listener is removed`);
      assert.equal(activeSubscriptions, 0, `${stage}: overlay subscription is removed`);
    } finally {
      overlay.dispose();
    }
  }
});

test("window failure cleanup continues through an unsubscribe error and keeps the original startup error", (t) => {
  const fx = fakeElectron("ready-listener");
  const overlay = new PetOverlay({ chat: fakeChat() });
  const subscribe = overlay.subscribe.bind(overlay);
  t.mock.method(overlay, "subscribe", (listener: Parameters<PetOverlay["subscribe"]>[0]) => {
    const unsubscribe = subscribe(listener);
    return () => { unsubscribe(); throw new Error("cleanup failed"); };
  });
  try {
    assert.throws(() => openPetWindow({ electron: fx.electron, overlay, url: "u", preload: "p" }), /ready-listener initialization failed/);
    assert.equal(fx.windows[0].destroyed, true);
    assert.equal(fx.hasHandler(OVERLAY_CHANNELS.getSnapshot), false);
    assert.equal(fx.listenerCount(OVERLAY_CHANNELS.command), 0);
  } finally {
    overlay.dispose();
  }
});

test("hit toggles click-through; drag moves the window and drives the avatar", async () => {
  const fx = fakeElectron();
  const avatar = createAvatarRuntime();
  const overlay = new PetOverlay({ chat: fakeChat(), avatar });
  const handle = openPetWindow({ electron: fx.electron, overlay, url: "u", preload: "p" });
  const win = fx.windows[0];
  const me = win.webContents;

  fx.emit(OVERLAY_CHANNELS.command, me, { type: "hit", inside: true });
  fx.emit(OVERLAY_CHANNELS.command, me, { type: "hit", inside: true });
  fx.emit(OVERLAY_CHANNELS.command, me, { type: "hit", inside: false });
  assert.deepEqual(
    win.ignore.map((x) => x[0]),
    [true, false, true],
    "only changes reach setIgnoreMouseEvents",
  );

  const [x0, y0] = win.getPosition();
  fx.emit(OVERLAY_CHANNELS.command, me, { type: "drag-start", screen_x: x0 + 100, screen_y: y0 + 500 });
  await flush();
  assert.equal(avatar.resolve().state, "dragging");
  fx.emit(OVERLAY_CHANNELS.command, me, { type: "drag-move", screen_x: x0 + 60, screen_y: y0 + 450 });
  assert.deepEqual(win.getPosition(), [x0 - 40, y0 - 50]);
  fx.emit(OVERLAY_CHANNELS.command, me, { type: "drag-end" });
  await flush();
  assert.equal(avatar.resolve().state, "idle");

  // Closing mid-drag releases the avatar.
  fx.emit(OVERLAY_CHANNELS.command, me, { type: "drag-start", screen_x: 0, screen_y: 0 });
  await flush();
  handle.close();
  await flush();
  assert.equal(avatar.resolve().state, "idle");
  overlay.dispose();
});

test("closing the window keeps the reply and tasks running; a new window restores history", async () => {
  const fx = fakeElectron();
  const dsh = fakeDsh();
  const bridge = new TaskBridge({ dsh });
  const chat = fakeChat();
  const overlay = new PetOverlay({ chat, tasks: bridge });
  const h1 = openPetWindow({ electron: fx.electron, overlay, url: "u", preload: "p" });
  overlay.showDialog();
  const turn = overlay.submit("在吗");
  const { task_id } = await bridge.start({ character_id: "c", user_input: "长任务", artifacts_needed: [] });
  overlay.trackTask(task_id, "长任务");
  h1.close();
  assert.equal(chat.running(), true, "closing the window does not cancel the reply");
  assert.equal(h1.isClosed(), true);
  assert.equal(fx.listenerCount(OVERLAY_CHANNELS.command), 0);
  assert.equal(fx.hasHandler(OVERLAY_CHANNELS.getSnapshot), false);

  const pushedBefore = fx.windows[0].sent.length;
  chat.delta("在的");
  chat.finish();
  await turn;
  bridge.transition(task_id, "succeeded");
  assert.equal(fx.windows[0].sent.length, pushedBefore, "closed window gets no pushes");
  assert.deepEqual(dsh.cancelled, []);

  const h2 = openPetWindow({ electron: fx.electron, overlay, url: "u", preload: "p" });
  const snap = fx.invoke(OVERLAY_CHANNELS.getSnapshot, fx.windows[1].webContents) as ReturnType<PetOverlay["snapshot"]>;
  assert.deepEqual(
    snap.history.map((e) => e.text),
    ["在吗", "在的", "任务完成：长任务"],
  );
  assert.equal(snap.tasks[0].status, "succeeded");
  h2.close();
  overlay.dispose();
});

test("pet window routes trusted drag through the DIP cursor and recovers off-screen placement", () => {
  const fx = fakeElectron();
  let cursor = { x: 1600, y: 800 };
  fx.electron.screen.getCursorScreenPoint = () => cursor;
  fx.electron.screen.getAllDisplays = () => [
    { workArea: { x: 0, y: 0, width: 1920, height: 1040 } },
    { workArea: { x: -1280, y: 0, width: 1280, height: 900 } },
  ];
  const overlay = new PetOverlay({ chat: fakeChat() });
  const handle = openPetWindow({ electron: fx.electron, overlay, url: "u", preload: "p" });
  const win = fx.windows[0];
  try {
    const [x, y] = win.getPosition();
    fx.emit(OVERLAY_CHANNELS.command, win.webContents, { type: "drag-start", screen_x: 0, screen_y: 0 });
    cursor = { x: -600, y: 500 };
    fx.emit(OVERLAY_CHANNELS.command, win.webContents, { type: "drag-move", screen_x: 99999, screen_y: 99999 });
    assert.deepEqual(win.getPosition(), [-600 - (1600 - x), 500 - (800 - y)]);
    win.setPosition(50000, -50000);
    handle.ensureVisible();
    assert.deepEqual(win.getPosition(), [1500, 0]);
  } finally { handle.close(); overlay.dispose(); }
});

test("parseOverlayCommand rejects malformed input", () => {
  assert.equal(parseOverlayCommand(null), null);
  assert.equal(parseOverlayCommand({ type: "submit", text: "   " }), null);
  assert.equal(parseOverlayCommand({ type: "submit", text: "x".repeat(8001) }), null);
  assert.equal(parseOverlayCommand({ type: "drag-move", screen_x: Number.NaN, screen_y: 0 }), null);
  assert.equal(parseOverlayCommand({ type: "hit", inside: "yes" }), null);
  assert.equal(parseOverlayCommand({ type: "open-notice", notice_id: "" }), null);
  assert.equal(parseOverlayCommand({ type: "memory-update", id: "m-1", text: " \t\n " }), null);
  assert.equal(parseOverlayCommand({ type: "memory-update", id: "m-1", text: "x".repeat(501) }), null);
  for (const id of ["", "x".repeat(201), 1, null]) {
    assert.equal(parseOverlayCommand({ type: "memory-update", id, text: "valid text" }), null);
  }
  assert.deepEqual(parseOverlayCommand({ type: "memory-update", id: "m-1", text: "  remembered fact \n" }), {
    type: "memory-update", id: "m-1", text: "remembered fact",
  });
  assert.deepEqual(parseOverlayCommand({ type: "memory-update", id: "m-1", text: ` ${"x".repeat(500)}\t` }), {
    type: "memory-update", id: "m-1", text: "x".repeat(500),
  });
  assert.deepEqual(parseOverlayCommand({ type: "hit", inside: true, extra: 1 }), { type: "hit", inside: true });
});
