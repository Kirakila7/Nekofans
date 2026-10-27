// F09 pet window: one transparent, frameless, always-on-top window that holds the pet,
// the status bubble, the hideable dialog and completion toasts.
// - The window is only a view of a PetOverlay. Closing it, or hiding the dialog, leaves the
//   overlay (and every running task) alive; a new window rebuilds from the overlay snapshot.
// - Transparent regions let clicks through (setIgnoreMouseEvents with forward); the renderer
//   reports when the pointer is over an interactive element.
// - The electron module is injected so this file loads in plain Node for tests.

import { OVERLAY_CHANNELS, parseOverlayCommand, type OverlayCommand, type OverlaySnapshot } from "./overlay-protocol.ts";
import type { PetOverlay } from "./pet-overlay.ts";
import { managePetGeometry, type PetGeometry, type PetScreen, type Rectangle } from "./window-geometry.ts";

/** Subset of Electron's IpcMainEvent / IpcMainInvokeEvent the window reads. */
interface IpcEventLike {
  sender: unknown;
  senderFrame?: { readonly url: string } | null;
}

/** Subset of BrowserWindow used here. */
export interface BrowserWindowLike {
  readonly id: number;
  readonly webContents: {
    readonly mainFrame: { readonly url: string };
    send(channel: string, ...args: unknown[]): void;
    isDestroyed(): boolean;
    once(event: "did-finish-load", fn: () => void): unknown;
    on(event: "will-navigate" | "will-frame-navigate" | "will-redirect", fn: (event: { preventDefault(): void }) => void): unknown;
    setWindowOpenHandler(fn: () => { action: "deny" }): void;
    setZoomFactor?(factor: number): void;
  };
  loadURL(url: string): Promise<void>;
  showInactive(): void;
  close(): void;
  isDestroyed(): boolean;
  getPosition(): number[];
  setPosition(x: number, y: number): void;
  getBounds?(): Rectangle;
  setBounds?(bounds: Rectangle): void;
  setAlwaysOnTop(flag: boolean, level?: string): void;
  setIgnoreMouseEvents(ignore: boolean, opts?: { forward?: boolean }): void;
  once(event: "closed" | "ready-to-show", fn: () => void): unknown;
}

/** Subset of the electron main-process module used here. */
export interface ElectronMainLike {
  BrowserWindow: new (opts: Record<string, unknown>) => BrowserWindowLike;
  ipcMain: {
    handle(channel: string, fn: (event: IpcEventLike, ...args: unknown[]) => unknown): void;
    removeHandler(channel: string): void;
    on(channel: string, fn: (event: IpcEventLike, ...args: unknown[]) => void): unknown;
    removeListener(channel: string, fn: (event: IpcEventLike, ...args: unknown[]) => void): unknown;
  };
  screen: PetScreen;
}

export interface PetWindowOptions {
  electron: ElectronMainLike;
  overlay: PetOverlay;
  /** Renderer page, e.g. http://127.0.0.1:<port>/index.html from overlay-server. */
  url: string;
  /** Absolute path of apps/pet-overlay/preload.cjs. */
  preload: string;
  partition?: string;
  width?: number;
  height?: number;
  /** Distance from the work-area bottom-right corner. */
  margin?: number;
  title?: string;
}

export interface PetWindowHandle {
  windowId: string;
  window: BrowserWindowLike;
  /** Resolves once the renderer page finished loading. */
  ready: Promise<void>;
  /** Closes the window only; the overlay and its tasks keep running. */
  close: () => void;
  isClosed: () => boolean;
  /** Recover the window after monitor/work-area changes. */
  ensureVisible: () => void;
}

export const PET_WINDOW_DEFAULTS = Object.freeze({ width: 420, height: 640, margin: 24, partition: "neko-pet" });

/** Opens the pet window for an overlay. Only one window per overlay should be open at a time. */
export function openPetWindow(opts: PetWindowOptions): PetWindowHandle {
  const { electron, overlay } = opts;
  const width = opts.width ?? PET_WINDOW_DEFAULTS.width;
  const height = opts.height ?? PET_WINDOW_DEFAULTS.height;
  const margin = opts.margin ?? PET_WINDOW_DEFAULTS.margin;
  const wa = electron.screen.getPrimaryDisplay().workArea;

  const win = new electron.BrowserWindow({
    width,
    height,
    x: wa.x + wa.width - width - margin,
    y: wa.y + wa.height - height - margin,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    focusable: true,
    backgroundColor: "#00000000",
    show: false,
    title: opts.title ?? "neko pet",
    webPreferences: {
      partition: opts.partition ?? PET_WINDOW_DEFAULTS.partition,
      preload: opts.preload,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  let closed = false;
  let ignoring = true;
  let drag = false;
  let geometry: PetGeometry | undefined;
  let unsubscribe = () => {};
  let snapshotHandlerRegistered = false;
  let commandListenerRegistered = false;
  const hasTrustedPage = () => !closed && !win.isDestroyed() && !win.webContents.isDestroyed()
    && win.webContents.mainFrame.url === opts.url;
  const fromThisWindow = (event: IpcEventLike) => hasTrustedPage() && event.sender === win.webContents
    && event.senderFrame === win.webContents.mainFrame;

  const push = (snapshot: OverlaySnapshot) => {
    if (!hasTrustedPage()) return;
    win.webContents.send(OVERLAY_CHANNELS.snapshot, snapshot);
  };

  const onWindowCommand = (cmd: OverlayCommand) => {
    switch (cmd.type) {
      case "hit":
        if (ignoring === cmd.inside) {
          ignoring = !cmd.inside;
          win.setIgnoreMouseEvents(ignoring, { forward: true });
        }
        return;
      case "drag-start": {
        drag = true;
        geometry?.begin({ x: cmd.screen_x, y: cmd.screen_y });
        return;
      }
      case "drag-move":
        if (drag) geometry?.move({ x: cmd.screen_x, y: cmd.screen_y });
        return;
      case "drag-end":
        drag = false;
        geometry?.end();
        return;
      default:
        return;
    }
  };

  const onCommand = (event: IpcEventLike, raw: unknown) => {
    if (!fromThisWindow(event)) return;
    const cmd = parseOverlayCommand(raw);
    if (!cmd) {
      console.warn("[app-coordinator] pet window dropped an invalid command");
      return;
    }
    onWindowCommand(cmd);
    overlay.handleCommand(cmd).catch(() => {
      console.warn("[app-coordinator] pet command failed:", cmd.type);
    });
  };

  const cleanup = () => {
    if (closed) return;
    closed = true;
    geometry?.dispose();
    try {
      unsubscribe();
    } finally {
      try {
        if (commandListenerRegistered) electron.ipcMain.removeListener(OVERLAY_CHANNELS.command, onCommand);
      } finally {
        try {
          if (snapshotHandlerRegistered) electron.ipcMain.removeHandler(OVERLAY_CHANNELS.getSnapshot);
        } finally {
          // A drag that was cut off by closing must not leave the avatar in "dragging".
          if (drag) overlay.handleCommand({ type: "drag-end" }).catch(() => {});
          drag = false;
        }
      }
    }
  };
  const close = () => {
    try {
      cleanup();
    } finally {
      if (!win.isDestroyed()) win.close();
    }
  };

  try {
    geometry = managePetGeometry(win, electron.screen, { width, height });
    win.setAlwaysOnTop(true, "screen-saver");
    // This window is exclusively the local overlay. Links and redirects must not turn
    // its privileged preload into an entry point for another document.
    const preventNavigation = (event: { preventDefault(): void }) => event.preventDefault();
    win.webContents.on("will-navigate", preventNavigation);
    win.webContents.on("will-frame-navigate", preventNavigation);
    win.webContents.on("will-redirect", preventNavigation);
    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    // Start fully click-through; the renderer turns hits on over the pet, bubble, dialog and toasts.
    win.setIgnoreMouseEvents(true, { forward: true });

    // ipcMain.handle allows one handler per channel; a previous window must have been closed.
    electron.ipcMain.removeHandler(OVERLAY_CHANNELS.getSnapshot);
    snapshotHandlerRegistered = true;
    electron.ipcMain.handle(OVERLAY_CHANNELS.getSnapshot, (event) => (fromThisWindow(event) ? overlay.snapshot() : null));
    commandListenerRegistered = true;
    electron.ipcMain.on(OVERLAY_CHANNELS.command, onCommand);
    unsubscribe = overlay.subscribe(push);
    win.once("closed", cleanup);
    win.once("ready-to-show", () => {
      if (!closed && !win.isDestroyed()) win.showInactive();
    });

    const ready = new Promise<void>((resolve, reject) => {
      win.webContents.once("did-finish-load", () => { geometry?.refresh(); resolve(); });
      win.loadURL(opts.url).catch(reject);
    });

    return {
      windowId: `pet-${win.id}`,
      window: win,
      ready,
      close,
      isClosed: () => closed,
      ensureVisible: () => geometry?.refresh(),
    };
  } catch (error) {
    // An initializer can fail after BrowserWindow allocation but before a handle exists.
    // Keep the original failure; cleanup still attempts IPC, subscriptions and the window.
    try { close(); } catch {}
    throw error;
  }
}
