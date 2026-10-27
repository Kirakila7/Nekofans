// F09 default pet mode: overlay server + PetOverlay + pet window, no workbench window.
// The pet dialog talks to the main chat; DSH task notices are optional. The window can be closed and reopened at any
// time; the overlay, its tasks and its history outlive every window.

import type { MainChatPort, VideoRenderer } from "../../app-contracts/src/index.ts";
import type { AvatarRuntime } from "../../avatar-runtime/src/state-machine.ts";
import { createAvatarRuntime } from "../../avatar-runtime/src/state-machine.ts";
import type { ClipAvailable } from "../../avatar-runtime/src/clip-select.ts";
import type { PersonaMemory } from "../../memory-store/src/index.ts";
import type { PersonaSummaries } from "../../app-contracts/src/summary.ts";
import { PetOverlay, type OverlayTaskPort } from "./pet-overlay.ts";
import { JsonFileOverlayStore, type OverlayStore } from "./pet-history.ts";
import { startOverlayServer, type OverlayServer } from "./overlay-server.ts";
import { openPetWindow, type ElectronMainLike, type PetWindowHandle } from "./pet-window.ts";
import { fileURLToPath } from "node:url";

/** apps/pet-overlay/preload.cjs inside this repository. */
export const PET_OVERLAY_PRELOAD = fileURLToPath(new URL("../../../apps/pet-overlay/preload.cjs", import.meta.url));

export interface PetModeOptions {
  electron: ElectronMainLike;
  /** Main chat of the main character; dialog input goes here. */
  chat: MainChatPort;
  /** Memory controls are scoped to the main character. */
  memory?: PersonaMemory;
  summaries?: PersonaSummaries;
  /** DSH task status for completion notices; omit to run without DSH. */
  tasks?: OverlayTaskPort;
  /** JSON file for history and notice state; ignored when store is given. */
  store_path?: string;
  store?: OverlayStore;
  avatar?: AvatarRuntime;
  /** Appearance pack root served under /assets/. */
  assets_dir?: string;
  video?: VideoRenderer;
  clip_available?: ClipAvailable;
  /** Overlay server port; 0 or omitted picks a free one. */
  port?: number;
  partition?: string;
  toast_ms?: number;
  bubble_ms?: number;
}

export interface PetMode {
  overlay: PetOverlay;
  avatar: AvatarRuntime;
  server: OverlayServer;
  /** Current window, or null when closed. */
  window(): PetWindowHandle | null;
  /** Opens the pet window if none is open; returns the open one. */
  openWindow(): PetWindowHandle;
  /** Closes the window only; the running reply and tasks keep going. */
  closeWindow(): void;
  /** Closes the window, disposes the overlay and stops the server. */
  stop(): Promise<void>;
}

export async function startPetMode(opts: PetModeOptions): Promise<PetMode> {
  const store = opts.store ?? (opts.store_path ? new JsonFileOverlayStore(opts.store_path) : undefined);
  const avatar = opts.avatar ?? createAvatarRuntime();
  const server = await startOverlayServer({ port: opts.port, assets_dir: opts.assets_dir });
  let overlay: PetOverlay | undefined;
  let current: PetWindowHandle | null = null;
  let stopping: Promise<void> | undefined;
  const closeWindow = () => {
    const previous = current;
    current = null;
    previous?.close();
  };
  const stop = (): Promise<void> => stopping ??= (async () => {
    // Every resource gets its cleanup attempt even if an earlier disposer fails.
    try {
      closeWindow();
    } finally {
      try {
        overlay?.dispose();
      } finally {
        await server.close();
      }
    }
  })();

  try {
    overlay = new PetOverlay({
      chat: opts.chat,
      memory: opts.memory,
      summaries: opts.summaries,
      tasks: opts.tasks,
      avatar,
      store,
      video: opts.video,
      clip_available: opts.clip_available,
      toast_ms: opts.toast_ms,
      bubble_ms: opts.bubble_ms,
    });
    const initializedOverlay = overlay;
    const openWindow = (): PetWindowHandle => {
      if (stopping) throw new Error("pet mode is stopped");
      if (current && !current.isClosed()) return current;
      current = openPetWindow({
        electron: opts.electron,
        overlay: initializedOverlay,
        url: server.url,
        preload: PET_OVERLAY_PRELOAD,
        partition: opts.partition,
      });
      return current;
    };
    openWindow();

    return {
      overlay,
      avatar,
      server,
      window: () => (current && !current.isClosed() ? current : null),
      openWindow,
      closeWindow,
      stop,
    };
  } catch (error) {
    // Preserve the startup failure while still releasing the already-bound server.
    await stop().catch(() => {});
    throw error;
  }
}
