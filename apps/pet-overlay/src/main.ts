// F09 pet overlay renderer. A pure view of OverlaySnapshot pushed by the main process;
// every user action goes back as an OverlayCommand. Served type-stripped, so only
// erasable TypeScript syntax is allowed here (no enums, namespaces or parameter properties).

import type {
  HistoryEntry,
  OverlayAvatarView,
  OverlayChatView,
  OverlayCommand,
  OverlayNotice,
  OverlaySnapshot,
  OverlayTaskView,
} from "../../../packages/app-coordinator/src/overlay-protocol.ts";
import { mountMemoryPanel } from "./memory-panel.ts";
import { mountSummaryPanel } from "./summary-panel.ts";

interface NekoPetBridge {
  getSnapshot(): Promise<OverlaySnapshot | null>;
  send(command: OverlayCommand): void;
  onSnapshot(fn: (snapshot: OverlaySnapshot) => void): () => void;
  /** Native menu opens the reading panel without adding a persisted domain command. */
  onShowHistory?(fn: () => void): () => void;
}

declare global {
  interface Window {
    nekoPet?: NekoPetBridge;
    __nekoPetView?: { revision: number; clip: string | null; clipEnded: number; renders: number };
  }
}

const STATUS_TEXT: Readonly<Record<string, string>> = {
  queued: "排队中",
  running: "进行中",
  waiting_user: "等你回复",
  waiting_approval: "等你批准",
  waiting_quota: "额度不足",
  waiting_external: "等待外部结果",
  succeeded: "已完成",
  failed: "失败",
  cancelled: "已取消",
  interrupted: "已中断",
};
const CHAT_STATUS_TEXT: Readonly<Record<OverlayChatView["phase"], string>> = {
  idle: "",
  connecting: "正在连接…",
  replying: "正在回复…",
  error: "出错了",
};
const DRAG_THRESHOLD_PX = 4;

function byId<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} missing`);
  return el as T;
}

const bridge = window.nekoPet;
const root = byId<HTMLElement>("root");
const dialog = byId<HTMLElement>("dialog");
const historyPanel = byId<HTMLElement>("history-panel");
const historyList = byId<HTMLOListElement>("history");
const historyBtn = byId<HTMLButtonElement>("show-history");
const closeHistoryBtn = byId<HTMLButtonElement>("close-history");
const memoriesBtn = byId<HTMLButtonElement>("show-memories");
const memoryCount = byId<HTMLElement>("memory-count");
const chatStatus = byId<HTMLElement>("chat-status");
const composer = byId<HTMLFormElement>("composer");
const input = byId<HTMLInputElement>("input");
const sendBtn = byId<HTMLButtonElement>("send");
const stopBtn = byId<HTMLButtonElement>("stop");
const hideBtn = byId<HTMLButtonElement>("hide");
const toastsBox = byId<HTMLElement>("toasts");
const bubble = byId<HTMLElement>("bubble");
const pet = byId<HTMLButtonElement>("pet");
const fallback = byId<HTMLElement>("pet-fallback");
const videos = [byId<HTMLVideoElement>("clip-a"), byId<HTMLVideoElement>("clip-b")];

const view = { revision: -1, clip: null as string | null, clipEnded: 0, renders: 0 };
window.__nekoPetView = view;

function send(command: OverlayCommand): void {
  bridge?.send(command);
}

const memoryPanel = mountMemoryPanel({
  panel: byId<HTMLElement>("memory-panel"),
  pending: byId<HTMLElement>("pending-memories"),
  confirmed: byId<HTMLElement>("confirmed-memories"),
  error: byId<HTMLElement>("memory-error"),
  close: byId<HTMLButtonElement>("close-memories"),
  send,
});
const summaryPanel = mountSummaryPanel({ section: byId<HTMLElement>("summary-section"), list: byId<HTMLElement>("conversation-summaries"),
  error: byId<HTMLElement>("summary-error"), send });

// ---- render ----

let last: OverlaySnapshot | null = null;
let historyOpen = false;

function render(snap: OverlaySnapshot): void {
  if (snap.revision <= view.revision) return;
  const wasVisible = last?.dialog_visible ?? false;
  view.revision = snap.revision;
  view.renders += 1;

  if (!snap.dialog_visible && wasVisible) historyOpen = false;
  // Task notices still lead to the complete history, even though opening the pet
  // itself now shows only the small composer.
  if (snap.focus_task_id !== null && snap.focus_task_id !== last?.focus_task_id) historyOpen = true;
  if (snap.memory?.panel_open && !last?.memory?.panel_open) historyOpen = false;
  dialog.hidden = !snap.dialog_visible;
  root.classList.toggle("has-dialog", snap.dialog_visible);
  pet.setAttribute("aria-expanded", String(snap.dialog_visible));
  memoryPanel.render(snap.memory);
  summaryPanel.render(snap.summaries);
  memoriesBtn.hidden = snap.memory === null;
  memoriesBtn.setAttribute("aria-expanded", String(snap.memory?.panel_open ?? false));
  const pendingCount = snap.memory?.pending.length ?? 0;
  memoryCount.hidden = pendingCount === 0;
  memoryCount.textContent = String(pendingCount);
  memoriesBtn.title = pendingCount > 0 ? `${pendingCount} 条记忆待确认` : "查看和管理记忆";
  renderPanels(snap);
  renderHistory(snap.history, snap.tasks, snap.focus_task_id, snap.chat);
  renderChat(snap.chat);
  const bubbleAtBottom = bubble.scrollHeight - bubble.scrollTop - bubble.clientHeight < 24;
  if (bubble.textContent !== (snap.bubble ?? "")) {
    bubble.textContent = snap.bubble ?? "";
    if (bubbleAtBottom) bubble.scrollTop = bubble.scrollHeight;
  }
  bubble.classList.toggle("is-error", snap.chat.phase === "error");
  renderToasts(snap.toasts);
  renderAvatar(snap.avatar);

  if (snap.dialog_visible && !wasVisible) {
    input.value = snap.draft;
    if (!snap.memory?.panel_open && !historyOpen) input.focus();
  } else if (document.activeElement !== input) {
    input.value = snap.draft;
  }
  last = snap;
  // Elements may have appeared under a resting pointer; re-evaluate the hit region.
  if (lastPointer) updateHit(lastPointer.x, lastPointer.y);
}

function renderPanels(snap: OverlaySnapshot): void {
  const showHistory = historyOpen && snap.dialog_visible && !snap.memory?.panel_open;
  historyPanel.hidden = !showHistory;
  historyBtn.setAttribute("aria-expanded", String(showHistory));
  bubble.hidden = snap.bubble === null || showHistory || Boolean(snap.memory?.panel_open);
}

function isBusy(chat: OverlayChatView): boolean {
  return chat.phase === "connecting" || chat.phase === "replying";
}

function renderChat(chat: OverlayChatView): void {
  const busy = isBusy(chat);
  chatStatus.textContent = CHAT_STATUS_TEXT[chat.phase] || "Enter 发送 · Esc 收起";
  chatStatus.title = chat.error ?? "";
  chatStatus.classList.toggle("is-error", chat.phase === "error");
  sendBtn.hidden = busy;
  stopBtn.hidden = !busy;
  dialog.setAttribute("aria-busy", String(busy));
}

function renderHistory(
  entries: HistoryEntry[],
  tasks: OverlayTaskView[],
  focusTask: string | null,
  chat: OverlayChatView,
): void {
  const status = new Map(tasks.map((t) => [t.task_id, t.status]));
  const atBottom = historyList.scrollHeight - historyList.scrollTop - historyList.clientHeight < 24;
  const frag = document.createDocumentFragment();
  let focusEl: HTMLElement | null = null;
  for (const e of entries) {
    const li = document.createElement("li");
    li.className = `msg msg-${e.role}`;
    li.dataset.entryId = e.entry_id;
    if (e.task_id) li.dataset.taskId = e.task_id;
    li.textContent = e.text;
    if (e.role === "user" && e.task_id && status.has(e.task_id)) {
      const tag = document.createElement("span");
      tag.className = "msg-status";
      tag.textContent = STATUS_TEXT[status.get(e.task_id) ?? ""] ?? "";
      li.appendChild(tag);
    }
    if (focusTask && e.task_id === focusTask && e.role === "system") {
      li.classList.add("is-focus");
      focusEl = li;
    }
    frag.appendChild(li);
  }
  // The running reply is not in history yet; show it as a pending assistant line.
  if (isBusy(chat)) {
    const li = document.createElement("li");
    li.className = "msg msg-assistant is-streaming";
    li.textContent = chat.streaming.length > 0 ? chat.streaming : "…";
    frag.appendChild(li);
  }
  if (entries.length === 0 && !isBusy(chat)) {
    const empty = document.createElement("li");
    empty.className = "history-empty";
    empty.textContent = "还没有对话，先和大肥鱼打个招呼吧。";
    frag.appendChild(empty);
  }
  historyList.replaceChildren(frag);
  if (focusEl && focusTask !== last?.focus_task_id) focusEl.scrollIntoView({ block: "nearest" });
  else if (atBottom || !last?.dialog_visible) historyList.scrollTop = historyList.scrollHeight;
}

function renderToasts(toasts: OverlayNotice[]): void {
  const frag = document.createDocumentFragment();
  for (const t of toasts) {
    const box = document.createElement("div");
    box.className = `toast${t.status === "failed" ? " is-failed" : ""}`;
    box.dataset.hit = "";
    box.dataset.noticeId = t.notice_id;
    const open = document.createElement("button");
    open.type = "button";
    open.className = "toast-open";
    open.textContent = t.text;
    open.title = "打开对话查看";
    open.addEventListener("click", () => send({ type: "open-notice", notice_id: t.notice_id }));
    const close = document.createElement("button");
    close.type = "button";
    close.className = "icon-btn";
    close.textContent = "×";
    close.setAttribute("aria-label", "关闭提示");
    close.addEventListener("click", () => send({ type: "dismiss-notice", notice_id: t.notice_id }));
    box.append(open, close);
    frag.appendChild(box);
  }
  toastsBox.replaceChildren(frag);
}

// ---- avatar clips (A/B crossfade, same mechanism as the F04 video renderer) ----

let front = 0;
let clipGen = 0;

function clipUrl(clip: string): string {
  return "/assets/" + clip.split("/").map(encodeURIComponent).join("/");
}

function renderAvatar(avatar: OverlayAvatarView | null): void {
  const clip = avatar?.clip ?? null;
  fallback.hidden = clip !== null;
  pet.dataset.state = avatar?.state ?? "idle";
  if (clip === null) {
    if (view.clip !== null) clipGen += 1;
    videos.forEach((v) => {
      v.pause();
      v.hidden = true;
      v.onended = null;
    });
    view.clip = null;
    return;
  }
  videos.forEach((v) => { v.hidden = false; });
  const loop = avatar?.loop ?? true;
  if (clip === view.clip && videos[front].loop === loop) return;
  view.clip = clip;
  const gen = ++clipGen;
  const slot = front === 0 ? 1 : 0;
  const el = videos[slot];
  el.loop = loop;
  el.onended = loop
    ? null
    : () => {
        if (gen !== clipGen) return;
        view.clipEnded += 1;
        send({ type: "clip-ended" });
      };
  const onReady = () => {
    el.removeEventListener("loadeddata", onReady);
    if (gen !== clipGen) return;
    const old = videos[front];
    el.classList.add("is-front");
    if (old !== el) {
      old.classList.remove("is-front");
      old.onended = null;
      old.pause();
    }
    front = slot;
    el.play().catch(() => {});
  };
  el.addEventListener("loadeddata", onReady);
  el.src = clipUrl(clip);
  el.load();
}

// ---- click-through: only [data-hit] elements take the pointer ----

let hitInside = false;
let lastPointer: { x: number; y: number } | null = null;

function updateHit(x: number, y: number): void {
  const el = document.elementFromPoint(x, y);
  const inside = dragging !== null || (el instanceof Element && el.closest("[data-hit]") !== null);
  if (inside !== hitInside) {
    hitInside = inside;
    send({ type: "hit", inside });
  }
}

document.addEventListener("mousemove", (e) => {
  lastPointer = { x: e.clientX, y: e.clientY };
  updateHit(e.clientX, e.clientY);
});
document.addEventListener("mouseleave", () => {
  lastPointer = null;
  if (dragging === null && hitInside) {
    hitInside = false;
    send({ type: "hit", inside: false });
  }
});

// ---- pet: click toggles the dialog, drag moves the window ----

let dragging: { id: number; x: number; y: number; moved: boolean } | null = null;

pet.addEventListener("pointerdown", (e) => {
  if (e.button !== 0) return;
  dragging = { id: e.pointerId, x: e.screenX, y: e.screenY, moved: false };
  pet.setPointerCapture(e.pointerId);
});
pet.addEventListener("pointermove", (e) => {
  if (!dragging || e.pointerId !== dragging.id) return;
  if (!dragging.moved) {
    if (Math.hypot(e.screenX - dragging.x, e.screenY - dragging.y) < DRAG_THRESHOLD_PX) return;
    dragging.moved = true;
    pet.classList.add("is-dragging");
    send({ type: "drag-start", screen_x: dragging.x, screen_y: dragging.y });
  }
  send({ type: "drag-move", screen_x: e.screenX, screen_y: e.screenY });
});
function endPointer(e: PointerEvent, cancelled: boolean): void {
  if (!dragging || e.pointerId !== dragging.id) return;
  const moved = dragging.moved;
  dragging = null;
  pet.classList.remove("is-dragging");
  if (moved) send({ type: "drag-end" });
  else if (!cancelled) send({ type: "toggle-dialog" });
}
pet.addEventListener("pointerup", (e) => endPointer(e, false));
pet.addEventListener("pointercancel", (e) => endPointer(e, true));
// Keyboard activation (Enter/Space) arrives as a click with detail 0; pointer clicks are handled above.
pet.addEventListener("click", (e) => {
  if (e.detail === 0) send({ type: "toggle-dialog" });
});

// ---- dialog ----

function hideDialog(): void {
  flushDraft();
  send({ type: "hide-dialog" });
}

function refreshLocalPanels(): void {
  if (last) renderPanels(last);
  if (lastPointer) updateHit(lastPointer.x, lastPointer.y);
}

function openHistory(): void {
  historyOpen = true;
  send({ type: "hide-memories" });
  send({ type: "show-dialog" });
  refreshLocalPanels();
  historyList.scrollTop = historyList.scrollHeight;
}

function closeHistory(): void {
  historyOpen = false;
  refreshLocalPanels();
  if (last?.dialog_visible) input.focus();
}

hideBtn.addEventListener("click", hideDialog);
stopBtn.addEventListener("click", () => send({ type: "cancel-reply" }));
historyBtn.addEventListener("click", () => {
  if (historyOpen && !last?.memory?.panel_open) closeHistory();
  else openHistory();
});
closeHistoryBtn.addEventListener("click", closeHistory);
memoriesBtn.addEventListener("click", () => {
  historyOpen = false;
  send({ type: last?.memory?.panel_open ? "hide-memories" : "show-memories" });
  refreshLocalPanels();
});
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape" || e.defaultPrevented || e.isComposing) return;
  if (last?.memory?.panel_open) {
    memoryPanel.close();
    input.focus();
  } else if (historyOpen) closeHistory();
  else if (last?.dialog_visible) hideDialog();
});

let draftTimer: ReturnType<typeof setTimeout> | undefined;
function flushDraft(): void {
  clearTimeout(draftTimer);
  if (input.value !== last?.draft) send({ type: "set-draft", text: input.value });
}
input.addEventListener("input", () => {
  clearTimeout(draftTimer);
  draftTimer = setTimeout(flushDraft, 150);
});
input.addEventListener("blur", flushDraft);
input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.isComposing) {
    e.preventDefault();
    composer.requestSubmit();
  }
});
composer.addEventListener("submit", (e) => {
  e.preventDefault();
  const text = input.value.trim();
  if (text.length === 0) return;
  // One reply at a time; keep the text in the box until the current reply ends.
  if (last && isBusy(last.chat)) return;
  clearTimeout(draftTimer);
  input.value = "";
  send({ type: "submit", text });
});

// ---- boot ----

if (!bridge) {
  fallback.hidden = false;
  console.error("[pet-overlay] preload bridge missing");
} else {
  bridge.onShowHistory?.(openHistory);
  bridge.onSnapshot(render);
  bridge.getSnapshot().then((snap) => {
    if (snap) render(snap);
  });
}

export {};
