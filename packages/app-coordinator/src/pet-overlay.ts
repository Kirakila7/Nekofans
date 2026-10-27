// F09 pet overlay controller. Pure state: no Electron, no DOM.
// - The dialog is a view. Hiding it never touches the chat turn or tasks.
// - Framework v1 step 2: dialog input goes to the main chat (MainChatPort), never to DSH.
//   The reply streams into the snapshot; the bubble shows it while the dialog is hidden.
// - The main character thinks while its own chat connects or replies; drag has priority.
//   DSH task status never touches the avatar runtime or the bubble.
// - Optional task port: DSH completion notices still fire once per task (toast when the
//   dialog is hidden, inline history line when visible). Fired task ids are persisted.
// - History, task views and the fired set live in an OverlayStore, so hiding,
//   re-creating the window or restarting the app restores them.

import { randomUUID } from "node:crypto";
import type { MainChatPort, MainChatState, MainChatTurnResult, TaskStatusKind, VideoRenderer } from "../../app-contracts/src/index.ts";
import type { AvatarRuntime, Clock, ResolvedState, TimerHandle } from "../../avatar-runtime/src/state-machine.ts";
import { selectClip, type ClipAvailable } from "../../avatar-runtime/src/clip-select.ts";
import type { TaskStatus } from "../../dsh-bridge/src/task-bridge.ts";
import type { PersonaMemory } from "../../memory-store/src/index.ts";
import type { PersonaSummaries } from "../../app-contracts/src/summary.ts";
import { SummaryPanel } from "./summary-panel.ts";
import type {
  HistoryEntry,
  OverlayAvatarView,
  OverlayChatView,
  OverlayCommand,
  OverlayMemoryView,
  OverlayNotice,
  OverlaySnapshot,
  OverlayTaskView,
} from "./overlay-protocol.ts";
import { InMemoryOverlayStore, type OverlayPersisted, type OverlayStore } from "./pet-history.ts";

/** Task status feed for completion notices. TaskBridge satisfies it structurally. */
export interface OverlayTaskPort {
  onStatusChange(handler: (status: TaskStatus) => void): () => void;
}

export type SnapshotListener = (snapshot: OverlaySnapshot) => void;

export interface PetOverlayOptions {
  /** Main chat of the main character. Dialog input goes here only. */
  chat: MainChatPort;
  /** Memory port already bound to the main character's persona. */
  memory?: PersonaMemory;
  summaries?: PersonaSummaries;
  tasks?: OverlayTaskPort;
  avatar?: AvatarRuntime;
  store?: OverlayStore;
  /** Video renderer of the active appearance; enables clip selection in snapshots. */
  video?: VideoRenderer;
  clip_available?: ClipAvailable;
  clock?: Clock;
  now?: () => Date;
  new_id?: () => string;
  /** How long a completion toast stays on screen. Default 8000 ms. */
  toast_ms?: number;
  /** How long a finished reply stays in the bubble. Default 12000 ms. */
  bubble_ms?: number;
}

const TERMINAL_NOTICE: ReadonlySet<TaskStatusKind> = new Set(["succeeded", "failed"]);
const BUSY_PHASES: ReadonlySet<MainChatState["phase"]> = new Set(["connecting", "replying"]);
const systemClock: Clock = {
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

/** Task title shown in lists and notices: first line of the input, trimmed. */
export function taskTitle(user_input: string): string {
  const line = user_input.trim().split(/\r?\n/, 1)[0] ?? "";
  return line.length > 40 ? `${line.slice(0, 40)}…` : line;
}

export class PetOverlay {
  private readonly opts: PetOverlayOptions;
  private readonly store: OverlayStore;
  private readonly clock: Clock;
  private readonly now: () => Date;
  private readonly newId: () => string;
  private readonly listeners = new Set<SnapshotListener>();
  private readonly unsubscribers: Array<() => void> = [];
  private readonly toastTimers = new Map<string, TimerHandle>();
  private readonly persisted: OverlayPersisted;
  private readonly notified: Set<string>;

  private dialogVisible = false;
  private draft = "";
  private focusTaskId: string | null = null;
  private toasts: OverlayNotice[] = [];
  private avatarView: OverlayAvatarView | null = null;
  private chatState: MainChatState;
  private memoryView: OverlayMemoryView | null = null;
  private summaryPanel?: SummaryPanel;
  private memoryRefresh = 0;
  private memoryCommand = 0;
  private memoryErrorSource: "load" | "command" | null = null;
  /** Set from submit until the turn settles; guards against double submits in one tick. */
  private turnActive = false;
  /** Finished reply (or failure text) kept in the bubble for bubble_ms. */
  private lingerBubble: string | null = null;
  private bubbleTimer: TimerHandle | undefined;
  private revision = 0;
  private disposed = false;

  constructor(opts: PetOverlayOptions) {
    this.opts = opts;
    this.store = opts.store ?? new InMemoryOverlayStore();
    this.clock = opts.clock ?? systemClock;
    this.now = opts.now ?? (() => new Date());
    this.newId = opts.new_id ?? randomUUID;
    this.persisted = this.store.load();
    this.notified = new Set(this.persisted.notified_task_ids);
    this.chatState = opts.chat.state();
    try {
      if (opts.summaries) {
        this.summaryPanel = new SummaryPanel(opts.summaries, () => this.changed());
        this.unsubscribers.push(() => this.summaryPanel?.dispose());
      }
      if (opts.memory) {
        this.memoryView = { panel_open: false, pending: [], confirmed: [], error: null };
        this.unsubscribers.push(opts.memory.subscribe(() => { void this.refreshMemories(); }));
        void this.refreshMemories();
      }

      if (opts.tasks) this.unsubscribers.push(opts.tasks.onStatusChange((status) => this.onTaskStatus(status)));
      if (opts.avatar) {
        this.unsubscribers.push(
          opts.avatar.subscribe((next) => {
            this.avatarView = this.viewOf(next);
            this.changed();
          }),
        );
      }
      this.unsubscribers.push(opts.chat.subscribe((state) => this.onChatState(state)));
    } catch (error) {
      // A failed constructor has no caller-owned instance to dispose later.
      this.dispose();
      throw error;
    }
  }

  snapshot(): OverlaySnapshot {
    return structuredClone({
      revision: this.revision,
      dialog_visible: this.dialogVisible,
      history: this.persisted.history,
      tasks: this.persisted.tasks,
      chat: this.chatView(),
      bubble: this.bubbleText(),
      toasts: this.toasts,
      draft: this.draft,
      focus_task_id: this.focusTaskId,
      avatar: this.avatarView,
      memory: this.memoryView,
      ...(this.summaryPanel ? { summaries: this.summaryPanel.view } : {}),
    });
  }

  /** Calls the listener immediately with the current snapshot, then on every change. */
  subscribe(listener: SnapshotListener): () => void {
    this.listeners.add(listener);
    listener(this.snapshot());
    return () => {
      this.listeners.delete(listener);
    };
  }

  // ---- dialog ----

  isDialogVisible(): boolean {
    return this.dialogVisible;
  }

  showDialog(): void {
    if (this.dialogVisible) return;
    this.dialogVisible = true;
    // Everything a toast said is already in history; the open dialog replaces the toasts.
    this.clearToasts();
    this.changed();
  }

  /** Hides the dialog only. The running reply, draft and history are untouched. */
  hideDialog(): void {
    if (!this.dialogVisible) return;
    this.dialogVisible = false;
    this.focusTaskId = null;
    if (this.memoryView) this.memoryView.panel_open = false;
    this.changed();
  }

  // ---- input ----

  /**
   * Sends one line to the main chat. Records the user line, then the reply or a system
   * line when the turn fails. Rejects with Error("busy") while a reply is running.
   */
  async submit(text: string): Promise<MainChatTurnResult> {
    const user_input = text.trim();
    if (user_input.length === 0) throw new Error("empty input");
    if (this.turnActive || BUSY_PHASES.has(this.chatState.phase)) throw new Error("busy");
    this.turnActive = true;
    this.draft = "";
    this.setLinger(null);
    this.appendHistory({ role: "user", text: user_input, task_id: null });
    let result: MainChatTurnResult;
    try {
      result = await this.opts.chat.send(user_input);
    } catch (error) {
      this.turnActive = false;
      // Rejections are programming or busy errors; API failures resolve with status "error".
      this.appendHistory({ role: "system", text: "消息没有发出去，请再试一次", task_id: null });
      throw error;
    }
    this.turnActive = false;
    if (this.disposed) return result;
    switch (result.status) {
      case "completed":
        this.appendHistory({ role: "assistant", text: result.text, task_id: null }, false);
        this.setLinger(result.text);
        break;
      case "error":
        this.appendHistory({ role: "system", text: result.message, task_id: null }, false);
        this.setLinger(result.message);
        break;
      case "cancelled":
        this.appendHistory({ role: "system", text: "已停止回复", task_id: null }, false);
        break;
    }
    this.save();
    this.changed();
    return result;
  }

  /** Stops the running reply. False when nothing is running. */
  cancelReply(): boolean {
    return this.opts.chat.cancel();
  }

  /** Registers a DSH task started elsewhere so its notice shows the input's first line as title. */
  trackTask(task_id: string, user_input: string): void {
    const title = taskTitle(user_input);
    // TaskBridge.start emits "queued" before it returns, so the row may already exist.
    const row = this.findTask(task_id);
    if (row) row.title = title;
    else this.upsertTask(task_id, title, "queued");
    this.save();
    this.changed();
  }

  /** Assistant text that arrives outside the main chat turn (DSH follow stream in M3). */
  appendAssistant(task_id: string | null, text: string): void {
    this.appendHistory({ role: "assistant", text, task_id });
  }

  /** Applies one validated renderer command. Window-level commands (drag, hit) only touch the avatar here. */
  async handleCommand(cmd: OverlayCommand): Promise<void> {
    if (this.disposed) return;
    switch (cmd.type) {
      case "submit":
        await this.submit(cmd.text);
        return;
      case "cancel-reply":
        this.cancelReply();
        return;
      case "show-dialog":
        this.showDialog();
        return;
      case "hide-dialog":
        this.hideDialog();
        return;
      case "toggle-dialog":
        if (this.dialogVisible) this.hideDialog();
        else this.showDialog();
        return;
      case "show-memories":
        if (!this.memoryView) return;
        this.memoryView.panel_open = true;
        if (this.dialogVisible) this.changed();
        else this.showDialog();
        await this.refreshMemories();
        await this.summaryPanel?.refresh();
        return;
      case "hide-memories":
        if (!this.memoryView?.panel_open) return;
        this.memoryView.panel_open = false;
        this.changed();
        return;
      case "memory-confirm":
      case "memory-update":
      case "memory-remove":
        await this.changeMemory(cmd);
        return;
      case "summary-sources":
      case "summary-remove":
        await this.summaryPanel?.handle(cmd);
        return;
      case "set-draft":
        this.draft = cmd.text;
        this.changed();
        return;
      case "open-notice": {
        const notice = this.toasts.find((t) => t.notice_id === cmd.notice_id);
        this.focusTaskId = notice?.task_id ?? null;
        this.dialogVisible = false;
        this.showDialog();
        return;
      }
      case "dismiss-notice":
        this.dismissToast(cmd.notice_id);
        return;
      case "clip-ended":
        return;
      case "drag-start":
        this.opts.avatar?.setDragging(true);
        return;
      case "drag-end":
        this.opts.avatar?.setDragging(false);
        return;
      case "drag-move":
      case "hit":
        return;
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const off of this.unsubscribers) off();
    this.clearToasts();
    if (this.bubbleTimer !== undefined) this.clock.clearTimer(this.bubbleTimer);
    this.bubbleTimer = undefined;
    this.listeners.clear();
  }

  // ---- memory panel ----

  /** Only the newest read may replace the panel; older async reads may resolve later. */
  private async refreshMemories(): Promise<void> {
    const memory = this.opts.memory;
    if (!memory || !this.memoryView || this.disposed) return;
    const request = ++this.memoryRefresh;
    try {
      const items = await memory.list();
      if (this.disposed || request !== this.memoryRefresh) return;
      const ordered = [...items].sort((a, b) => b.updatedAt - a.updatedAt);
      const view = (confirmation: "pending" | "confirmed") => ordered
        .filter((item) => item.confirmation === confirmation)
        .map((item) => ({ id: item.id, kind: item.kind, text: item.text, updated_at: new Date(item.updatedAt).toISOString() }));
      this.memoryView.pending = view("pending");
      this.memoryView.confirmed = view("confirmed");
      if (this.memoryErrorSource === "load") {
        this.memoryView.error = null;
        this.memoryErrorSource = null;
      }
    } catch {
      if (this.disposed || request !== this.memoryRefresh) return;
      // A background read cannot erase a failed command or expose storage exception details.
      if (this.memoryErrorSource !== "command") {
        this.memoryView.error = "记忆加载失败，请稍后重试";
        this.memoryErrorSource = "load";
      }
    }
    this.changed();
  }

  private async changeMemory(cmd: Extract<OverlayCommand, { type: "memory-confirm" | "memory-update" | "memory-remove" }>): Promise<void> {
    const memory = this.opts.memory;
    if (!memory || !this.memoryView || this.disposed) return;
    const command = ++this.memoryCommand;
    try {
      switch (cmd.type) {
        case "memory-confirm": await memory.confirm(cmd.id); break;
        case "memory-update": await memory.update(cmd.id, cmd.text); break;
        case "memory-remove": await memory.remove(cmd.id); break;
      }
    } catch {
      if (this.disposed || command !== this.memoryCommand) return;
      this.memoryView.error = cmd.type === "memory-confirm" ? "记忆确认失败，请稍后重试"
        : cmd.type === "memory-update" ? "记忆修改失败，请检查内容后重试"
        : "记忆删除失败，请稍后重试";
      this.memoryErrorSource = "command";
      this.changed();
      return;
    }
    if (this.disposed) return;
    if (command === this.memoryCommand) {
      this.memoryView.error = null;
      this.memoryErrorSource = null;
    }
    // Ports may suppress notifications for an idempotent command; always read its final state.
    await this.refreshMemories();
  }

  // ---- main chat ----

  private onChatState(state: MainChatState): void {
    if (this.disposed) return;
    this.chatState = state;
    // Only this character's chat owns the waiting state; DSH events never reach it.
    this.opts.avatar?.setTaskState(BUSY_PHASES.has(state.phase) ? "thinking" : null);
    this.changed();
  }

  private chatView(): OverlayChatView {
    const s = this.chatState;
    return {
      phase: s.phase,
      streaming: BUSY_PHASES.has(s.phase) ? (s.reply ?? "") : "",
      error: s.phase === "error" ? (s.errorMessage ?? null) : null,
    };
  }

  /** Streaming text while a reply runs, then the finished reply for bubble_ms. */
  private bubbleText(): string | null {
    const s = this.chatState;
    if (BUSY_PHASES.has(s.phase)) return s.reply && s.reply.length > 0 ? s.reply : "…";
    return this.lingerBubble;
  }

  private setLinger(text: string | null): void {
    if (this.bubbleTimer !== undefined) this.clock.clearTimer(this.bubbleTimer);
    this.bubbleTimer = undefined;
    this.lingerBubble = text;
    if (text === null) return;
    this.bubbleTimer = this.clock.setTimer(() => {
      this.bubbleTimer = undefined;
      this.lingerBubble = null;
      this.changed();
    }, this.opts.bubble_ms ?? 12000);
  }

  // ---- task events ----

  private onTaskStatus(status: TaskStatus): void {
    if (this.disposed) return;
    const title = this.findTask(status.task_id)?.title ?? status.task_id.slice(0, 8);
    this.upsertTask(status.task_id, title, status.status);

    if (TERMINAL_NOTICE.has(status.status) && !this.notified.has(status.task_id)) {
      this.notified.add(status.task_id);
      this.persisted.notified_task_ids.push(status.task_id);
      this.fireNotice(status, title);
    }
    this.save();
    this.changed();
  }

  private fireNotice(status: TaskStatus, title: string): void {
    const ok = status.status === "succeeded";
    const count = status.artifacts.length;
    const text = ok
      ? `任务完成：${title}${count > 0 ? `（${count} 个成果）` : ""}`
      : `任务失败：${title}`;
    const shown_as = this.dialogVisible ? "inline" : "toast";
    this.appendHistory({ role: "system", text, task_id: status.task_id }, false);
    if (shown_as === "toast") {
      const notice: OverlayNotice = {
        notice_id: this.newId(),
        task_id: status.task_id,
        status: ok ? "succeeded" : "failed",
        text,
        shown_as,
        at: this.now().toISOString(),
      };
      this.toasts.push(notice);
      const ms = this.opts.toast_ms ?? 8000;
      this.toastTimers.set(notice.notice_id, this.clock.setTimer(() => this.dismissToast(notice.notice_id), ms));
    }
  }

  // ---- avatar ----

  private viewOf(resolved: ResolvedState): OverlayAvatarView {
    if (!this.opts.video) return { state: resolved.state, source: resolved.source, clip: null, loop: true };
    const pick = selectClip(this.opts.video, resolved, { available: this.opts.clip_available });
    return { state: resolved.state, source: resolved.source, clip: pick.clip, loop: pick.loop };
  }

  // ---- state helpers ----

  private findTask(task_id: string): OverlayTaskView | undefined {
    return this.persisted.tasks.find((t) => t.task_id === task_id);
  }

  private upsertTask(task_id: string, title: string, status: TaskStatusKind): void {
    const at = this.now().toISOString();
    const row = this.findTask(task_id);
    if (row) {
      row.status = status;
      row.updated_at = at;
    } else {
      this.persisted.tasks.push({ task_id, title, status, updated_at: at });
    }
  }

  /** With persist=false the caller saves and emits once for a batch of changes. */
  private appendHistory(entry: Omit<HistoryEntry, "entry_id" | "at">, persist = true): HistoryEntry {
    const full: HistoryEntry = { ...entry, entry_id: this.newId(), at: this.now().toISOString() };
    this.persisted.history.push(full);
    if (persist) {
      this.save();
      this.changed();
    }
    return full;
  }

  private dismissToast(notice_id: string): void {
    const timer = this.toastTimers.get(notice_id);
    if (timer !== undefined) this.clock.clearTimer(timer);
    this.toastTimers.delete(notice_id);
    const before = this.toasts.length;
    this.toasts = this.toasts.filter((t) => t.notice_id !== notice_id);
    if (this.toasts.length !== before) this.changed();
  }

  private clearToasts(): void {
    for (const timer of this.toastTimers.values()) this.clock.clearTimer(timer);
    this.toastTimers.clear();
    this.toasts = [];
  }

  private save(): void {
    this.store.save(this.persisted);
  }

  private changed(): void {
    if (this.disposed) return;
    this.revision += 1;
    const snap = this.snapshot();
    for (const fn of this.listeners) {
      try {
        fn(snap);
      } catch {
        console.error("[app-coordinator] overlay listener failed");
      }
    }
  }
}
