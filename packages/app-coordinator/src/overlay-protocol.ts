// F09 pet overlay: data shapes shared by the coordinator (Electron main) and the
// pet-overlay renderer. Renderer code imports these with `import type` only.

import type { MemoryItem, TaskStatusKind } from "../../app-contracts/src/index.ts";
import type { AvatarStateKind, StateSource } from "../../avatar-runtime/src/state-machine.ts";
import type { ConversationSummary } from "../../app-contracts/src/summary.ts";

export interface OverlaySummaryView {
  items: ConversationSummary[];
  source: { summaryId: string; messages: Array<{ id: string; role: "user" | "assistant"; text: string; createdAt: number; truncated: boolean }> } | null;
  error: string | null;
}

export type HistoryRole = "user" | "assistant" | "system";

/** One line of the dialog history. */
export interface HistoryEntry {
  entry_id: string;
  role: HistoryRole;
  text: string;
  task_id: string | null;
  /** ISO 8601 timestamp. */
  at: string;
}

/** Task as the overlay shows it. */
export interface OverlayTaskView {
  task_id: string;
  title: string;
  status: TaskStatusKind;
  /** ISO 8601 timestamp of the last status change seen by the overlay. */
  updated_at: string;
}

/** Light completion notice, shown once per task. */
export interface OverlayNotice {
  notice_id: string;
  task_id: string;
  status: "succeeded" | "failed";
  text: string;
  /** "toast" when the dialog was hidden at completion, otherwise "inline" (history only). */
  shown_as: "toast" | "inline";
  at: string;
}

/** Avatar state plus the clip the pet renderer should play. */
export interface OverlayAvatarView {
  state: AvatarStateKind;
  source: StateSource;
  /** Clip path relative to the appearance pack root, or null when nothing is playable. */
  clip: string | null;
  loop: boolean;
}

/** Main chat turn as the dialog shows it. Mirrors MainChatState without the persona id. */
export interface OverlayChatView {
  phase: "idle" | "connecting" | "replying" | "error";
  /** Reply text streamed so far in the running turn; empty when idle. */
  streaming: string;
  /** User-facing failure text while phase is "error", otherwise null. */
  error: string | null;
}

/** One memory of the main character as the memory panel shows it. */
export interface OverlayMemoryItem {
  id: string;
  kind: MemoryItem["kind"];
  text: string;
  /** ISO 8601 timestamp of the last change. */
  updated_at: string;
}

/** Memory panel state. Pending items are proposals, not facts, until the user confirms them. */
export interface OverlayMemoryView {
  panel_open: boolean;
  /** Proposals waiting for the user, newest first. */
  pending: OverlayMemoryItem[];
  /** Confirmed memories, newest first. */
  confirmed: OverlayMemoryItem[];
  /** User-facing text of the last failed memory command, cleared by the next success. */
  error: string | null;
}

/** Full overlay state. Renderers rebuild their view from this alone. */
export interface OverlaySnapshot {
  /** Increases on every change; renderers drop snapshots older than the one shown. */
  revision: number;
  dialog_visible: boolean;
  history: HistoryEntry[];
  tasks: OverlayTaskView[];
  /** Main chat turn: phase, streamed reply and failure text. */
  chat: OverlayChatView;
  /** Speech bubble above the pet: the main character's current or last reply, or null. */
  bubble: string | null;
  /** Toasts currently on screen. */
  toasts: OverlayNotice[];
  /** Text typed in the dialog input; kept while the dialog is hidden. */
  draft: string;
  /** Task the dialog should scroll to after a notice was opened. */
  focus_task_id: string | null;
  avatar: OverlayAvatarView | null;
  /** Memory panel, or null when the overlay has no memory port. */
  memory: OverlayMemoryView | null;
  summaries?: OverlaySummaryView;
}

/** Commands a renderer may send to the coordinator. Validated in the main process. */
export type OverlayCommand =
  | { type: "submit"; text: string }
  /** Stop the running main-chat reply. */
  | { type: "cancel-reply" }
  | { type: "show-dialog" }
  | { type: "hide-dialog" }
  | { type: "toggle-dialog" }
  | { type: "set-draft"; text: string }
  | { type: "open-notice"; notice_id: string }
  | { type: "dismiss-notice"; notice_id: string }
  /** A one-shot avatar clip (success/error) finished playing. */
  | { type: "clip-ended" }
  | { type: "drag-start"; screen_x: number; screen_y: number }
  | { type: "drag-move"; screen_x: number; screen_y: number }
  | { type: "drag-end" }
  /** Pointer is over an interactive part of the pet window (false = let clicks through). */
  | { type: "hit"; inside: boolean }
  /** Open the memory panel (also shows the dialog). */
  | { type: "show-memories" }
  | { type: "hide-memories" }
  | { type: "memory-confirm"; id: string }
  | { type: "memory-update"; id: string; text: string }
  | { type: "memory-remove"; id: string }
  | { type: "summary-sources"; id: string }
  | { type: "summary-remove"; id: string };

/** IPC channel names. */
export const OVERLAY_CHANNELS = Object.freeze({
  getSnapshot: "neko-pet:get-snapshot",
  command: "neko-pet:command",
  snapshot: "neko-pet:snapshot",
} as const);

/** Upper bound for user text sent through IPC. */
export const MAX_TEXT_LENGTH = 8000;

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function isText(v: unknown): v is string {
  return typeof v === "string" && v.length <= MAX_TEXT_LENGTH;
}

function isId(v: unknown): v is string {
  return typeof v === "string" && v.length > 0 && v.length <= 200;
}

/** Parse untrusted renderer input into an OverlayCommand, or null when invalid. */
export function parseOverlayCommand(raw: unknown): OverlayCommand | null {
  if (typeof raw !== "object" || raw === null) return null;
  const c = raw as Record<string, unknown>;
  switch (c.type) {
    case "submit":
      return isText(c.text) && c.text.trim().length > 0 ? { type: "submit", text: c.text } : null;
    case "set-draft":
      return isText(c.text) ? { type: "set-draft", text: c.text } : null;
    case "show-dialog":
    case "hide-dialog":
    case "toggle-dialog":
    case "cancel-reply":
    case "clip-ended":
    case "drag-end":
    case "show-memories":
    case "hide-memories":
      return { type: c.type };
    case "open-notice":
    case "dismiss-notice":
      return isId(c.notice_id) ? { type: c.type, notice_id: c.notice_id } : null;
    case "memory-confirm":
    case "memory-remove":
    case "summary-sources":
    case "summary-remove":
      return isId(c.id) ? { type: c.type, id: c.id } : null;
    case "memory-update": {
      if (!isId(c.id) || !isText(c.text)) return null;
      const text = c.text.trim();
      return text.length > 0 && text.length <= 500 ? { type: "memory-update", id: c.id, text } : null;
    }
    case "drag-start":
    case "drag-move":
      return isFiniteNumber(c.screen_x) && isFiniteNumber(c.screen_y)
        ? { type: c.type, screen_x: c.screen_x, screen_y: c.screen_y }
        : null;
    case "hit":
      return typeof c.inside === "boolean" ? { type: "hit", inside: c.inside } : null;
    default:
      return null;
  }
}
