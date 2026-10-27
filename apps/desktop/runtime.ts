import { join } from "node:path";
import { existsSync } from "node:fs";
import { openMainChat, type OpenedMainChat, type MainChatSettings } from "../../packages/chat-service/src/config.ts";
import { startPetMode, type PetMode, type PetModeOptions } from "../../packages/app-coordinator/src/pet-mode.ts";
import { DEFAULT_PERSONA_ID, PersonaStore } from "../../packages/persona-store/src/index.ts";
import type { ElectronMainLike } from "../../packages/app-coordinator/src/pet-window.ts";
import type { VideoRenderer } from "../../packages/app-contracts/src/index.ts";
import { atomicJson, initializeData, parseApiChange, parsePersonaChange, readPersona, readSettings } from "./settings.ts";

const CLIPS: VideoRenderer = { clips: {
  idle: ["dsh-pet/待机呼吸休闲.webm", "idle.webm"],
  thinking: ["dsh-pet/工作状态-思考冒泡.webm", "thinking.webm"],
  speaking: ["dsh-pet/碎碎念-对屏碎碎念.webm", "speaking.webm"],
  dragging: ["dsh-pet/被鼠标拖拽悬空反馈.webm", "dragging.webm"],
  error: ["dsh-pet/工作状态-垂头叹气冒汗.webm"],
} };

export interface DesktopRuntimeOptions {
  electron: ElectronMainLike;
  dataDir: string;
  repositoryRoot: string;
  assetsDir?: string;
  onPetReady?: (mode: PetMode) => void;
  openChat?: typeof openMainChat;
  startPet?: (options: PetModeOptions) => Promise<PetMode>;
  onStop?: () => Promise<void>;
}

/** Serializes saves/restarts/exit so an old request or memory subscription cannot outlive its DB. */
export class DesktopRuntime {
  readonly configFile: string;
  readonly personasDir: string;
  private readonly options: DesktopRuntimeOptions;
  private opened: OpenedMainChat | null = null;
  private mode: PetMode | null = null;
  private tail: Promise<unknown> = Promise.resolve();
  private closed = false;

  constructor(options: DesktopRuntimeOptions) {
    this.options = options;
    ({ configFile: this.configFile, personasDir: this.personasDir } = initializeData(options.dataDir, options.repositoryRoot));
  }

  pet(): PetMode | null { return this.mode; }

  start(): Promise<void> { return this.enqueue(() => this.startNow()); }

  /** Contains only editable non-secret fields and whether a key exists, never its contents. */
  read() {
    const persona = readPersona(this.personasDir);
    return {
      mainChat: readSettings(this.configFile),
      hasKey: this.opened?.secretStore.has() ?? false,
      persona: { id: persona.id, name: persona.name, persona: persona.persona, boundaries: persona.boundaries },
    };
  }

  saveApi(input: unknown): Promise<void> {
    return this.enqueue(async () => {
      const change = parseApiChange(input);
      const previousSettings = readSettings(this.configFile);
      const secrets = this.opened?.secretStore;
      if (!secrets) throw new Error("Desktop is not running.");
      // DPAPI snapshots retain encrypted bytes without decrypting them: replacing or
      // clearing an unreadable old key must remain possible from the settings page.
      let restoreSecret: (() => Promise<void>) | null = null;
      if (change.key.action !== "keep") {
        try {
          if (secrets.prepareRollback) restoreSecret = await secrets.prepareRollback();
          else {
            // Compatibility for an injected store with no opaque rollback capability.
            const previousKey = await secrets.get();
            restoreSecret = () => previousKey === null ? secrets.clear() : secrets.set(previousKey);
          }
        } catch { throw new Error("Settings save failed."); }
      }
      try {
        await this.stopNow();
        if (change.key.action === "replace") await secrets.set(change.key.value);
        else if (change.key.action === "clear") await secrets.clear();
        this.writeSettings(change.settings);
        await this.startNow();
      } catch {
        // Retain a usable previous configuration whenever storage permits it.
        try {
          await restoreSecret?.();
          this.writeSettings(previousSettings);
          await this.startNow();
        } catch { /* The settings page remains available to repair configuration. */ }
        throw new Error("Settings save failed.");
      }
    });
  }

  savePersona(input: unknown): Promise<void> {
    return this.enqueue(async () => {
      const store = new PersonaStore(this.personasDir);
      const previous = readPersona(this.personasDir);
      const next = parsePersonaChange(input, previous);
      try {
        await this.stopNow();
        store.save(next);
        await this.startNow();
      } catch {
        try { store.save(previous); await this.startNow(); } catch { /* Fixed IPC error below. */ }
        throw new Error("Persona save failed.");
      }
    });
  }

  stop(): Promise<void> {
    this.closed = true;
    return this.enqueue(async () => { try { await this.stopNow(); } finally { await this.options.onStop?.(); } }, true);
  }

  private enqueue<T>(action: () => Promise<T>, allowClosed = false): Promise<T> {
    const next = this.tail.then(() => {
      if (this.closed && !allowClosed) throw new Error("Desktop is closing.");
      return action();
    });
    this.tail = next.catch(() => {});
    return next;
  }

  private writeSettings(settings: MainChatSettings): void {
    atomicJson(this.configFile, { schemaVersion: 1, mainChat: settings });
  }

  private async startNow(): Promise<void> {
    if (this.mode || this.opened || this.closed) return;
    const settings = readSettings(this.configFile);
    const opened = (this.options.openChat ?? openMainChat)({
      settings,
      personasDir: this.personasDir,
      dataDir: this.options.dataDir,
    });
    this.opened = opened;
    try {
      const assetsDir = this.options.assetsDir;
      this.mode = await (this.options.startPet ?? startPetMode)({
        electron: this.options.electron,
        chat: opened.service,
        memory: opened.memory,
        summaries: opened.summaries,
        store_path: join(this.options.dataDir, `overlay-${DEFAULT_PERSONA_ID}.json`),
        assets_dir: assetsDir,
        video: assetsDir ? CLIPS : undefined,
        clip_available: (clip) => !!assetsDir && existsSync(join(assetsDir, clip)),
        port: 0,
      });
      await this.mode.window()?.ready;
      this.options.onPetReady?.(this.mode);
    } catch (error) {
      await this.stopNow();
      throw error;
    }
  }

  private async stopNow(): Promise<void> {
    const opened = this.opened;
    const mode = this.mode;
    this.opened = null;
    this.mode = null;
    // Cancellation happens before closing renderers, the loopback listener and database handles.
    opened?.service.cancel();
    try { await mode?.stop(); } finally { opened?.close(); }
  }
}
