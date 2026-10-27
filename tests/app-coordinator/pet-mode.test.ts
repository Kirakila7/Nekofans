import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type AddressInfo, type Server } from "node:net";
import type { MainChatPort, MainChatState } from "../../packages/app-contracts/src/index.ts";
import type { PersonaMemory } from "../../packages/memory-store/src/index.ts";
import type { OverlayTaskPort } from "../../packages/app-coordinator/src/pet-overlay.ts";
import { startPetMode } from "../../packages/app-coordinator/src/pet-mode.ts";
import type { ElectronMainLike } from "../../packages/app-coordinator/src/pet-window.ts";

async function bind(port: number): Promise<Server> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => { server.off("error", reject); resolve(); });
  });
  return server;
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function freePort(): Promise<number> {
  const probe = await bind(0);
  const port = (probe.address() as AddressInfo).port;
  await close(probe);
  return port;
}

async function assertPortReleased(port: number): Promise<void> {
  const probe = await bind(port);
  await close(probe);
}

function ports(opts: { subscribeError?: Error; unsubscribeError?: Error } = {}) {
  const active = { chat: 0, memory: 0, tasks: 0 };
  const state: MainChatState = { personaId: "bigfish", phase: "idle" };
  const chat: MainChatPort = {
    state: () => ({ ...state }),
    subscribe: (listener) => {
      if (opts.subscribeError) throw opts.subscribeError;
      active.chat++;
      listener({ ...state });
      return () => {
        active.chat--;
        if (opts.unsubscribeError) throw opts.unsubscribeError;
      };
    },
    send: async () => ({ status: "completed", messageId: "m-1", text: "test reply" }),
    cancel: () => false,
  };
  const memory: PersonaMemory = {
    list: async () => [],
    confirm: async () => {}, update: async () => {}, remove: async () => {},
    subscribe: () => { active.memory++; return () => { active.memory--; }; },
  };
  const tasks: OverlayTaskPort = {
    onStatusChange: () => { active.tasks++; return () => { active.tasks--; }; },
  };
  return { chat, memory, tasks, active };
}

function fakeElectron(opts: { constructorError?: Error; topmostError?: Error; closeError?: Error; deferLoad?: boolean } = {}) {
  type Listener = (...args: unknown[]) => void;
  const handlers = new Map<string, unknown>();
  const listeners = new Map<string, Set<unknown>>();
  const windows: FakeWindow[] = [];
  class FakeWindow {
    readonly id = windows.length + 1;
    readonly events = new Map<string, Listener>();
    readonly wcEvents = new Map<string, Listener>();
    destroyed = false;
    closeCalls = 0;
    readonly webContents = {
      mainFrame: { url: "" },
      send: () => {},
      isDestroyed: () => this.destroyed,
      once: (event: string, listener: Listener) => this.wcEvents.set(event, listener),
      on: (event: string, listener: Listener) => this.wcEvents.set(event, listener),
      setWindowOpenHandler: () => {},
    };
    constructor() {
      if (opts.constructorError) throw opts.constructorError;
      windows.push(this);
    }
    async loadURL(url: string) {
      this.webContents.mainFrame.url = url;
      if (!opts.deferLoad) this.finishLoad();
    }
    finishLoad() { this.wcEvents.get("did-finish-load")?.(); }
    showInactive() {}
    close() {
      this.closeCalls++;
      this.destroyed = true;
      this.events.get("closed")?.();
      if (opts.closeError) throw opts.closeError;
    }
    isDestroyed() { return this.destroyed; }
    getPosition() { return [0, 0]; }
    setPosition() {}
    setAlwaysOnTop() { if (opts.topmostError) throw opts.topmostError; }
    setIgnoreMouseEvents() {}
    once(event: string, listener: Listener) { this.events.set(event, listener); }
  }
  const electron: ElectronMainLike = {
    BrowserWindow: FakeWindow as unknown as ElectronMainLike["BrowserWindow"],
    ipcMain: {
      handle: (channel, handler) => { handlers.set(channel, handler); },
      removeHandler: (channel) => { handlers.delete(channel); },
      on: (channel, listener) => {
        if (!listeners.has(channel)) listeners.set(channel, new Set());
        listeners.get(channel)!.add(listener);
      },
      removeListener: (channel, listener) => { listeners.get(channel)?.delete(listener); },
    },
    screen: { getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }) },
  };
  return {
    electron, windows,
    registered: () => handlers.size + [...listeners.values()].reduce((n, items) => n + items.size, 0),
  };
}

test("BrowserWindow construction failure releases the overlay and already-bound server", async () => {
  const port = await freePort();
  const failure = new Error("window construction failed");
  const fx = fakeElectron({ constructorError: failure });
  const deps = ports();
  await assert.rejects(startPetMode({ electron: fx.electron, ...deps, port }), (error) => error === failure);
  assert.deepEqual(deps.active, { chat: 0, memory: 0, tasks: 0 });
  assert.equal(fx.windows.length, 0);
  assert.equal(fx.registered(), 0);
  await assertPortReleased(port);
});

test("overlay construction failure releases its partial subscriptions and the server", async () => {
  const port = await freePort();
  const failure = new Error("chat subscription failed");
  const fx = fakeElectron();
  const deps = ports({ subscribeError: failure });
  await assert.rejects(startPetMode({ electron: fx.electron, ...deps, port }), (error) => error === failure);
  assert.deepEqual(deps.active, { chat: 0, memory: 0, tasks: 0 });
  assert.equal(fx.windows.length, 0);
  await assertPortReleased(port);
});

test("failure after window allocation closes the window, overlay and server", async () => {
  const port = await freePort();
  const failure = new Error("window initialization failed");
  const fx = fakeElectron({ topmostError: failure });
  const deps = ports();
  await assert.rejects(startPetMode({ electron: fx.electron, ...deps, port }), (error) => error === failure);
  assert.equal(fx.windows[0].destroyed, true);
  assert.equal(fx.windows[0].closeCalls, 1);
  assert.equal(fx.registered(), 0);
  assert.deepEqual(deps.active, { chat: 0, memory: 0, tasks: 0 });
  await assertPortReleased(port);
});

test("startup keeps the original error and releases the server even when overlay disposal throws", async () => {
  const port = await freePort();
  const failure = new Error("window construction failed");
  const fx = fakeElectron({ constructorError: failure });
  const deps = ports({ unsubscribeError: new Error("unsubscribe failed") });
  await assert.rejects(startPetMode({ electron: fx.electron, ...deps, port }), (error) => error === failure);
  assert.deepEqual(deps.active, { chat: 0, memory: 0, tasks: 0 });
  await assertPortReleased(port);
});

test("normal startup preserves the separate ready promise, passes memory and stops every resource once", async () => {
  const fx = fakeElectron({ deferLoad: true });
  const deps = ports();
  const mode = await startPetMode({ electron: fx.electron, ...deps, port: 0 });
  try {
    const handle = mode.window()!;
    let ready = false;
    void handle.ready.then(() => { ready = true; });
    await Promise.resolve();
    assert.equal(ready, false, "startPetMode still returns before page readiness");
    assert.notEqual(mode.overlay.snapshot().memory, null, "memory reaches the overlay");
    assert.deepEqual(deps.active, { chat: 1, memory: 1, tasks: 1 });
    assert.equal((await fetch(mode.server.url)).status, 200);
    fx.windows[0].finishLoad();
    await handle.ready;
    assert.equal(mode.openWindow(), handle);
  } finally {
    const stopping = mode.stop();
    assert.equal(mode.stop(), stopping);
    await stopping;
  }
  assert.equal(mode.window(), null);
  assert.throws(() => mode.openWindow(), /pet mode is stopped/);
  assert.equal(fx.windows[0].closeCalls, 1);
  assert.equal(fx.registered(), 0);
  assert.deepEqual(deps.active, { chat: 0, memory: 0, tasks: 0 });
  await assertPortReleased(mode.server.port);
});

test("a window close error cannot skip overlay disposal or server shutdown", async () => {
  const failure = new Error("window close failed");
  const fx = fakeElectron({ closeError: failure });
  const deps = ports();
  const mode = await startPetMode({ electron: fx.electron, ...deps, port: 0 });
  await assert.rejects(mode.stop(), (error) => error === failure);
  assert.equal(mode.window(), null);
  assert.equal(fx.windows[0].destroyed, true);
  assert.equal(fx.registered(), 0);
  assert.deepEqual(deps.active, { chat: 0, memory: 0, tasks: 0 });
  await assertPortReleased(mode.server.port);
});
