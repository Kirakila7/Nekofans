// F09 pet overlay controller, framework v1 step 2. Dialog input goes to the main chat
// (fake MainChatPort), never to DSH. DSH tasks are started on the real TaskBridge directly
// and only produce completion notices. Covers: streaming reply in snapshot and bubble,
// one turn at a time, error and cancel, hiding the dialog keeps the reply running,
// notices fire once, history restores after hide/reopen and after a restart.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskBridge, type DshTaskPort } from "../../packages/dsh-bridge/src/task-bridge.ts";
import { createAvatarRuntime, type Clock } from "../../packages/avatar-runtime/src/state-machine.ts";
import type { MainChatPort, MainChatState, MainChatTurnResult, VideoRenderer } from "../../packages/app-contracts/src/index.ts";
import { PetOverlay, taskTitle } from "../../packages/app-coordinator/src/pet-overlay.ts";
import { InMemoryOverlayStore, JsonFileOverlayStore } from "../../packages/app-coordinator/src/pet-history.ts";
import type { OverlaySnapshot } from "../../packages/app-coordinator/src/overlay-protocol.ts";

const dirs: string[] = [];
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/** Deterministic clock: timers run only when advance() passes their due time. */
function fakeClock(): Clock & { advance(ms: number): void; pending(): number } {
  let now = 0;
  let seq = 0;
  const timers = new Map<number, { due: number; fn: () => void }>();
  return {
    setTimer(fn, ms) {
      const id = ++seq;
      timers.set(id, { due: now + ms, fn });
      return id;
    },
    clearTimer(handle) {
      timers.delete(handle as number);
    },
    advance(ms) {
      now += ms;
      for (const [id, t] of [...timers].sort((a, b) => a[1].due - b[1].due)) {
        if (t.due <= now && timers.has(id)) {
          timers.delete(id);
          t.fn();
        }
      }
    },
    pending: () => timers.size,
  };
}

/** Fake DSH: records calls; cancel() is tracked so tests can prove it never ran. */
function fakeDsh(): DshTaskPort & { sent: string[]; cancelled: string[]; sessions: number } {
  const port = {
    sent: [] as string[],
    cancelled: [] as string[],
    sessions: 0,
    async createSession() {
      port.sessions += 1;
      return `session-${port.sessions}`;
    },
    async send(_session_id: string, text: string) {
      port.sent.push(text);
    },
    async cancel(session_id: string) {
      port.cancelled.push(session_id);
    },
  };
  return port;
}

/**
 * Fake main chat. send() starts a turn the test drives with delta()/finish()/fail();
 * with auto set, send() completes at once with "回复：<text>".
 */
function fakeChat(opts: { auto?: boolean } = {}) {
  let state: MainChatState = { personaId: "bigfish", phase: "idle" };
  const listeners = new Set<(s: MainChatState) => void>();
  let settle: ((r: MainChatTurnResult) => void) | null = null;
  let n = 0;
  const sent: string[] = [];
  const set = (next: MainChatState) => {
    state = next;
    for (const fn of listeners) fn({ ...state });
  };
  const end = (r: MainChatTurnResult) => {
    const fn = settle;
    settle = null;
    fn?.(r);
  };
  const chat = {
    sent,
    state: () => ({ ...state }),
    subscribe(fn: (s: MainChatState) => void) {
      listeners.add(fn);
      fn({ ...state });
      return () => listeners.delete(fn);
    },
    async send(text: string): Promise<MainChatTurnResult> {
      if (text.trim().length === 0) throw new Error("empty input");
      if (settle) throw new Error("busy");
      sent.push(text);
      set({ personaId: "bigfish", phase: "connecting", lastUserMessage: text, reply: "" });
      const done = new Promise<MainChatTurnResult>((resolve) => (settle = resolve));
      if (opts.auto) chat.finish(`回复：${text}`);
      return done;
    },
    cancel(): boolean {
      if (!settle) return false;
      const partial = state.reply ?? "";
      set({ personaId: "bigfish", phase: "idle", lastUserMessage: state.lastUserMessage, reply: "" });
      end({ status: "cancelled", partial });
      return true;
    },
    delta(text: string) {
      set({ ...state, phase: "replying", reply: (state.reply ?? "") + text });
    },
    finish(text?: string) {
      const full = text ?? state.reply ?? "";
      set({ personaId: "bigfish", phase: "idle", lastUserMessage: state.lastUserMessage, reply: full });
      end({ status: "completed", messageId: `m-${++n}`, text: full });
    },
    fail(code: string, message: string) {
      set({ ...state, phase: "error", errorMessage: message });
      end({ status: "error", code, message });
    },
    running: () => settle !== null,
  };
  return chat satisfies MainChatPort & Record<string, unknown>;
}

const flush = () => new Promise<void>((r) => setImmediate(r));

function setup(opts: { store?: InMemoryOverlayStore | JsonFileOverlayStore; video?: VideoRenderer; auto?: boolean } = {}) {
  const dsh = fakeDsh();
  const bridge = new TaskBridge({ dsh });
  const chat = fakeChat({ auto: opts.auto ?? true });
  const clock = fakeClock();
  const avatar = createAvatarRuntime({ clock });
  let n = 0;
  const overlay = new PetOverlay({
    chat,
    tasks: bridge,
    avatar,
    clock,
    store: opts.store,
    video: opts.video,
    new_id: () => `id-${++n}`,
    toast_ms: 8000,
    bubble_ms: 12000,
  });
  const snaps: OverlaySnapshot[] = [];
  overlay.subscribe((s) => snaps.push(s));
  /** Starts a DSH task outside the dialog, as the coordinator would. */
  const startTask = async (user_input: string) => {
    const { task_id } = await bridge.start({ character_id: "char-1", user_input, artifacts_needed: [] });
    overlay.trackTask(task_id, user_input);
    return task_id;
  };
  return { dsh, bridge, chat, clock, avatar, overlay, snaps, startTask };
}

test("pet mode is the default: dialog starts hidden, nothing is open", () => {
  const { overlay } = setup();
  const snap = overlay.snapshot();
  assert.equal(snap.dialog_visible, false);
  assert.deepEqual(snap.toasts, []);
  assert.equal(snap.bubble, null);
  assert.deepEqual(snap.chat, { phase: "idle", streaming: "", error: null });
  overlay.dispose();
});

test("dialog input goes to the main chat, never to DSH", async () => {
  const { dsh, chat, overlay } = setup();
  overlay.showDialog();
  const result = await overlay.submit("  你好  ");
  assert.deepEqual(chat.sent, ["你好"]);
  assert.equal(dsh.sessions, 0, "no DSH session is created");
  assert.deepEqual(dsh.sent, []);
  assert.equal(result.status, "completed");
  assert.deepEqual(
    overlay.snapshot().history.map((e) => [e.role, e.text]),
    [
      ["user", "你好"],
      ["assistant", "回复：你好"],
    ],
  );
  assert.deepEqual(overlay.snapshot().tasks, []);
  await assert.rejects(overlay.submit("   "), /empty input/);
  overlay.dispose();
});

test("streaming reply shows in the snapshot and the bubble, then lingers", async () => {
  const { chat, overlay, clock } = setup({ auto: false });
  const pending = overlay.submit("讲个笑话");
  let snap = overlay.snapshot();
  assert.equal(snap.chat.phase, "connecting");
  assert.equal(snap.bubble, "…", "placeholder before the first token");

  chat.delta("从前");
  chat.delta("有条鱼");
  snap = overlay.snapshot();
  assert.equal(snap.chat.phase, "replying");
  assert.equal(snap.chat.streaming, "从前有条鱼");
  assert.equal(snap.bubble, "从前有条鱼");
  assert.equal(snap.history.length, 1, "the partial reply is not in history yet");

  chat.finish();
  await pending;
  snap = overlay.snapshot();
  assert.equal(snap.chat.phase, "idle");
  assert.equal(snap.chat.streaming, "");
  assert.equal(snap.history.at(-1)?.text, "从前有条鱼");
  assert.equal(snap.bubble, "从前有条鱼", "finished reply stays in the bubble");
  clock.advance(11_999);
  assert.equal(overlay.snapshot().bubble, "从前有条鱼");
  clock.advance(1);
  assert.equal(overlay.snapshot().bubble, null);
  overlay.dispose();
});

test("one turn at a time: a second submit while replying is rejected", async () => {
  const { chat, overlay } = setup({ auto: false });
  const first = overlay.submit("第一句");
  await assert.rejects(overlay.submit("第二句"), /busy/);
  assert.deepEqual(chat.sent, ["第一句"]);
  assert.deepEqual(
    overlay.snapshot().history.map((e) => e.text),
    ["第一句"],
    "the rejected input is not recorded",
  );
  chat.finish("好的");
  await first;
  const third = overlay.submit("第三句");
  chat.finish("收到");
  await third;
  assert.deepEqual(chat.sent, ["第一句", "第三句"]);
  overlay.dispose();
});

test("an API error is shown in history and the bubble, and the next turn works", async () => {
  const { chat, overlay } = setup({ auto: false });
  const pending = overlay.submit("在吗");
  chat.fail("auth", "API 密钥无效，请检查设置");
  const result = await pending;
  assert.equal(result.status, "error");
  let snap = overlay.snapshot();
  assert.equal(snap.chat.phase, "error");
  assert.equal(snap.chat.error, "API 密钥无效，请检查设置");
  assert.equal(snap.history.at(-1)?.role, "system");
  assert.equal(snap.history.at(-1)?.text, "API 密钥无效，请检查设置");
  assert.equal(snap.bubble, "API 密钥无效，请检查设置");

  const next = overlay.submit("现在呢");
  chat.finish("在的");
  await next;
  snap = overlay.snapshot();
  assert.equal(snap.chat.phase, "idle");
  assert.equal(snap.history.at(-1)?.text, "在的");
  overlay.dispose();
});

test("cancel-reply stops the turn and records it; partial text is not saved as a reply", async () => {
  const { chat, overlay } = setup({ auto: false });
  const pending = overlay.submit("写首长诗");
  chat.delta("床前");
  await overlay.handleCommand({ type: "cancel-reply" });
  const result = await pending;
  assert.deepEqual(result, { status: "cancelled", partial: "床前" });
  const snap = overlay.snapshot();
  assert.equal(snap.chat.phase, "idle");
  assert.deepEqual(
    snap.history.map((e) => [e.role, e.text]),
    [
      ["user", "写首长诗"],
      ["system", "已停止回复"],
    ],
  );
  assert.equal(overlay.cancelReply(), false, "nothing left to cancel");
  overlay.dispose();
});

test("a rejected send is recorded and rethrown", async () => {
  const chat = fakeChat();
  chat.send = async () => {
    throw new Error("store closed");
  };
  const overlay = new PetOverlay({ chat });
  await assert.rejects(overlay.submit("hello"), /store closed/);
  assert.deepEqual(
    overlay.snapshot().history.map((e) => e.role),
    ["user", "system"],
  );
  overlay.dispose();
});

test("hiding the dialog keeps the reply running and shows it in the bubble", async () => {
  const { chat, overlay } = setup({ auto: false });
  overlay.showDialog();
  const pending = overlay.submit("你在干嘛");
  overlay.hideDialog();
  assert.equal(chat.running(), true, "hide must not cancel the turn");
  chat.delta("在发呆");
  assert.equal(overlay.snapshot().bubble, "在发呆");
  chat.finish();
  await pending;
  overlay.showDialog();
  assert.equal(overlay.snapshot().history.at(-1)?.text, "在发呆");
  overlay.dispose();
});
test("DSH tasks started elsewhere still notify once: toast when hidden, inline when visible", async () => {
  const { bridge, dsh, overlay, startTask } = setup();
  const t1 = await startTask("任务一");
  bridge.transition(t1, "succeeded");
  let snap = overlay.snapshot();
  assert.equal(snap.toasts.length, 1);
  assert.equal(snap.toasts[0].task_id, t1);
  assert.equal(snap.toasts[0].shown_as, "toast");
  assert.equal(snap.toasts[0].text, "任务完成：任务一");

  // The same terminal status delivered again (event replay) must not notify again.
  (bridge as unknown as { emit(id: string): void }).emit(t1);
  snap = overlay.snapshot();
  assert.equal(snap.toasts.length, 1);
  assert.equal(snap.history.filter((e) => e.role === "system" && e.task_id === t1).length, 1);

  overlay.showDialog();
  assert.equal(overlay.snapshot().toasts.length, 0);
  const t2 = await startTask("任务二");
  bridge.transition(t2, "failed");
  snap = overlay.snapshot();
  assert.equal(snap.toasts.length, 0, "dialog visible: no toast");
  assert.deepEqual(
    snap.history.filter((e) => e.task_id === t2).map((e) => e.text),
    ["任务失败：任务二"],
  );

  overlay.hideDialog();
  assert.deepEqual(dsh.cancelled, [], "hiding never cancels DSH work");
  const t3 = await startTask("不用了");
  await bridge.cancel(t3);
  assert.equal(overlay.snapshot().toasts.length, 0, "cancelled tasks do not notify");
  overlay.dispose();
});

test("toast auto-dismisses; dismiss and open-notice commands work", async () => {
  const { bridge, overlay, clock, startTask } = setup();
  const t1 = await startTask("a");
  bridge.transition(t1, "succeeded");
  clock.advance(7999);
  assert.equal(overlay.snapshot().toasts.length, 1);
  clock.advance(1);
  assert.equal(overlay.snapshot().toasts.length, 0);

  const t2 = await startTask("b");
  bridge.transition(t2, "succeeded");
  await overlay.handleCommand({ type: "dismiss-notice", notice_id: overlay.snapshot().toasts[0].notice_id });
  assert.equal(overlay.snapshot().toasts.length, 0);

  const t3 = await startTask("c");
  bridge.transition(t3, "succeeded");
  await overlay.handleCommand({ type: "open-notice", notice_id: overlay.snapshot().toasts[0].notice_id });
  const snap = overlay.snapshot();
  assert.equal(snap.dialog_visible, true);
  assert.equal(snap.focus_task_id, t3);
  assert.equal(snap.toasts.length, 0);
  overlay.dispose();
});

test("runs without DSH at all", async () => {
  const overlay = new PetOverlay({ chat: fakeChat({ auto: true }) });
  await overlay.submit("hi");
  assert.equal(overlay.snapshot().history.length, 2);
  overlay.dispose();
});

test("history and draft are kept across hide/reopen", async () => {
  const { overlay } = setup();
  overlay.showDialog();
  await overlay.submit("第一句");
  await overlay.submit("第二句");
  await overlay.handleCommand({ type: "set-draft", text: "还没写完" });
  const before = overlay.snapshot();
  overlay.hideDialog();
  overlay.showDialog();
  const afterReopen = overlay.snapshot();
  assert.deepEqual(afterReopen.history, before.history);
  assert.equal(afterReopen.draft, "还没写完");
  assert.deepEqual(
    afterReopen.history.map((e) => e.text),
    ["第一句", "回复：第一句", "第二句", "回复：第二句"],
  );
  overlay.dispose();
});

test("history and fired notices survive a restart (JSON store)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "f09-pet-overlay-"));
  dirs.push(dir);
  const file = join(dir, "overlay.json");
  const a = setup({ store: new JsonFileOverlayStore(file) });
  await a.overlay.submit("跨重启");
  const t1 = await a.startTask("跨重启的任务");
  a.bridge.transition(t1, "succeeded");
  a.overlay.dispose();

  const b = setup({ store: new JsonFileOverlayStore(file) });
  const snap = b.overlay.snapshot();
  assert.equal(snap.dialog_visible, false);
  assert.equal(snap.toasts.length, 0, "toasts are transient");
  assert.equal(snap.bubble, null, "the bubble does not come back after restart");
  assert.deepEqual(
    snap.history.map((e) => [e.role, e.text]),
    [
      ["user", "跨重启"],
      ["assistant", "回复：跨重启"],
      ["system", "任务完成：跨重启的任务"],
    ],
  );
  // A replayed terminal status after restart must not notify again.
  const handlers: Array<(s: { task_id: string; status: "succeeded"; artifacts: [] }) => void> = [];
  const c = new PetOverlay({
    chat: fakeChat(),
    store: new JsonFileOverlayStore(file),
    tasks: { onStatusChange: (h) => (handlers.push(h as never), () => {}) },
  });
  handlers[0]({ task_id: t1, status: "succeeded", artifacts: [] });
  assert.equal(c.snapshot().toasts.length, 0);
  b.overlay.dispose();
  c.dispose();
});

test("framework v1: only its own chat and drag change the main character, never DSH tasks", async () => {
  const video: VideoRenderer = {
    clips: { idle: ["idle.webm"], thinking: ["thinking.webm"], working: ["working.webm"], success: ["success.webm"] },
  };
  const { bridge, chat, overlay, avatar, clock, startTask } = setup({ video, auto: false });
  const seen = new Set<string>();
  const off = avatar.subscribe((r) => seen.add(r.state));

  const turn = overlay.submit("聊聊");
  assert.equal(avatar.resolve().state, "thinking");
  assert.equal(overlay.snapshot().avatar?.clip, "thinking.webm");
  await overlay.handleCommand({ type: "drag-start", screen_x: 1, screen_y: 1 });
  assert.equal(avatar.resolve().state, "dragging", "drag still overrides the active chat");
  await overlay.handleCommand({ type: "drag-end" });
  assert.equal(avatar.resolve().state, "thinking");
  chat.delta("好");
  chat.finish();
  await turn;
  assert.equal(avatar.resolve().state, "idle");
  seen.clear();
  seen.add("idle");
  const t1 = await startTask("a");
  for (const status of ["waiting_user", "running", "succeeded"] as const) bridge.transition(t1, status);
  clock.advance(20_000);
  await overlay.handleCommand({ type: "clip-ended" });
  assert.deepEqual([...seen], ["idle"], "DSH events never leave idle");
  assert.equal(overlay.snapshot().avatar?.clip, "idle.webm");

  await overlay.handleCommand({ type: "drag-start", screen_x: 1, screen_y: 1 });
  assert.equal(avatar.resolve().state, "dragging");
  await overlay.handleCommand({ type: "drag-end" });
  assert.equal(avatar.resolve().state, "idle");
  off();
  overlay.dispose();
});

test("helpers: taskTitle", () => {
  assert.equal(taskTitle("  第一行\n第二行"), "第一行");
  assert.equal(taskTitle("x".repeat(50)), `${"x".repeat(40)}…`);
});

test("snapshots carry increasing revisions", async () => {
  const { overlay, snaps } = setup();
  overlay.showDialog();
  await overlay.submit("r");
  overlay.hideDialog();
  await flush();
  const revs = snaps.map((s) => s.revision);
  for (let i = 1; i < revs.length; i++) assert.ok(revs[i] > revs[i - 1], `revisions ${revs.join(",")}`);
  overlay.dispose();
});
