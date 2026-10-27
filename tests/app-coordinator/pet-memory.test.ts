// Memory panel acceptance: real persona-bound SQLite mutations plus controllable
// asynchronous reads to cover stale snapshots, failures and disposal.
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import type { MainChatPort, MainChatTurnResult, MemoryItem } from "../../packages/app-contracts/src/index.ts";
import { PetOverlay } from "../../packages/app-coordinator/src/pet-overlay.ts";
import { createAvatarRuntime } from "../../packages/avatar-runtime/src/state-machine.ts";
import { SqliteMemoryStore, type PersonaMemory } from "../../packages/memory-store/src/index.ts";

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

function item(id: string, text: string, extra: Partial<MemoryItem> = {}): MemoryItem {
  return {
    id, personaId: "bigfish", kind: "fact", text, sourceMessageIds: [`message-${id}`],
    confirmation: "pending", updatedAt: 1000, ...extra,
  };
}

function chat(): MainChatPort & { sent: string[] } {
  const sent: string[] = [];
  return {
    sent,
    state: () => ({ personaId: "bigfish", phase: "idle" }),
    subscribe(listener) {
      listener({ personaId: "bigfish", phase: "idle" });
      return () => {};
    },
    async send(text): Promise<MainChatTurnResult> {
      sent.push(text);
      return { status: "completed", messageId: "reply-1", text: "收到" };
    },
    cancel: () => false,
  };
}

function setup(t: TestContext) {
  let time = 2000;
  const store = new SqliteMemoryStore(":memory:", { now: () => time++ });
  const mainChat = chat();
  const overlay = new PetOverlay({ chat: mainChat, memory: store.forPersona("bigfish") });
  t.after(() => { overlay.dispose(); store.close(); });
  return { store, mainChat, overlay };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function deferredMemory() {
  const reads: ReturnType<typeof deferred<MemoryItem[]>>[] = [];
  const listeners = new Set<() => void>();
  const port: PersonaMemory = {
    list() {
      const read = deferred<MemoryItem[]>();
      reads.push(read);
      return read.promise;
    },
    async confirm() {},
    async update() {},
    async remove() {},
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
  return { port, reads, listeners, emit: () => { for (const listener of listeners) listener(); } };
}

test("initial load and subscribed proposals show only the bound persona's projected memories", async (t) => {
  const store = new SqliteMemoryStore(":memory:");
  await store.propose(item("old", "用户喜欢猫", { audioRef: "private.wav" }));
  const overlay = new PetOverlay({ chat: chat(), memory: store.forPersona("bigfish") });
  t.after(() => { overlay.dispose(); store.close(); });
  await flush();
  assert.deepEqual(overlay.snapshot().memory!.pending.map((m) => m.id), ["old"], "preexisting memories load without an event");
  await store.propose(item("new", "用户住在杭州", { updatedAt: 1500 }));
  await store.propose(item("foreign", "another persona secret", { personaId: "other" }));
  await flush();
  assert.deepEqual(overlay.snapshot().memory, {
    panel_open: false, error: null, confirmed: [],
    pending: [
      { id: "new", kind: "fact", text: "用户住在杭州", updated_at: new Date(1500).toISOString() },
      { id: "old", kind: "fact", text: "用户喜欢猫", updated_at: new Date(1000).toISOString() },
    ],
  });
  const copy = overlay.snapshot();
  copy.memory!.pending[0].text = "changed by a consumer";
  assert.equal(overlay.snapshot().memory!.pending[0].text, "用户住在杭州");
  const before = overlay.snapshot().revision;
  await store.update("other", "foreign", "private change");
  await flush();
  assert.equal(overlay.snapshot().revision, before, "another persona's event does not refresh this overlay");
});

test("confirm moves a proposal into confirmed memory and makes it recallable", async (t) => {
  const { store, overlay, mainChat } = setup(t);
  await store.propose(item("p", "用户喜欢猫"));
  await flush();
  assert.deepEqual(await store.recall("bigfish", "猫", 100), []);
  await overlay.handleCommand({ type: "memory-confirm", id: "p" });
  assert.deepEqual(overlay.snapshot().memory!.pending, []);
  assert.equal(overlay.snapshot().memory!.confirmed[0].id, "p");
  assert.equal((await store.recall("bigfish", "猫", 100))[0].id, "p");
  assert.deepEqual(mainChat.sent, [], "memory commands do not send chat turns");
  assert.deepEqual(overlay.snapshot().tasks, []);
  assert.deepEqual(overlay.snapshot().history, []);
});

test("editing preserves pending/confirmed state; deleting removes either kind", async (t) => {
  const { store, overlay } = setup(t);
  await store.propose(item("pending", "用户喜欢猫"));
  await store.propose(item("confirmed", "用户叫小鱼"));
  await store.confirm("bigfish", "confirmed");
  await flush();
  await overlay.handleCommand({ type: "memory-update", id: "pending", text: "  用户喜欢柴犬  " });
  await overlay.handleCommand({ type: "memory-update", id: "confirmed", text: "用户叫大肥鱼" });
  assert.equal(overlay.snapshot().memory!.pending[0].text, "用户喜欢柴犬");
  assert.equal(overlay.snapshot().memory!.confirmed[0].text, "用户叫大肥鱼");
  assert.deepEqual((await store.recall("bigfish", "用户", 100)).map((m) => m.id), ["confirmed"]);
  await overlay.handleCommand({ type: "memory-remove", id: "pending" });
  await overlay.handleCommand({ type: "memory-remove", id: "confirmed" });
  assert.deepEqual(overlay.snapshot().memory!.pending, []);
  assert.deepEqual(overlay.snapshot().memory!.confirmed, []);
  assert.deepEqual(await store.list("bigfish"), []);
});

test("forged foreign ids cannot confirm, edit or delete another persona's memory", async (t) => {
  const { store, overlay } = setup(t);
  await store.propose(item("own", "本人的记忆"));
  await store.propose(item("foreign", "私有记忆", { personaId: "other" }));
  await flush();
  const before = await store.list("other");
  for (const command of [
    { type: "memory-confirm", id: "foreign" },
    { type: "memory-update", id: "foreign", text: "hijack" },
    { type: "memory-remove", id: "foreign" },
  ] as const) {
    await overlay.handleCommand(command);
    assert.ok(overlay.snapshot().memory!.error);
    assert.equal(JSON.stringify(overlay.snapshot()).includes("foreign"), false);
    assert.deepEqual(await store.list("other"), before);
  }
  await overlay.handleCommand({ type: "memory-confirm", id: "own" });
  assert.equal(overlay.snapshot().memory!.error, null, "a successful command clears the failure");
});

test("opening memories shows the dialog; hiding the panel or dialog keeps its data and draft", async (t) => {
  const { store, overlay } = setup(t);
  await store.propose(item("p", "记忆"));
  await overlay.handleCommand({ type: "set-draft", text: "尚未发送" });
  await overlay.handleCommand({ type: "show-memories" });
  assert.equal(overlay.snapshot().dialog_visible, true);
  assert.equal(overlay.snapshot().memory!.panel_open, true);
  await overlay.handleCommand({ type: "hide-memories" });
  assert.equal(overlay.snapshot().dialog_visible, true);
  assert.equal(overlay.snapshot().memory!.panel_open, false);
  await overlay.handleCommand({ type: "show-memories" });
  overlay.hideDialog();
  overlay.showDialog();
  assert.equal(overlay.snapshot().memory!.panel_open, false);
  assert.equal(overlay.snapshot().memory!.pending[0].id, "p");
  assert.equal(overlay.snapshot().draft, "尚未发送");
});

test("memory commands are harmless when no memory port is configured", async (t) => {
  const overlay = new PetOverlay({ chat: chat() });
  t.after(() => overlay.dispose());
  const before = overlay.snapshot();
  for (const command of [
    { type: "show-memories" }, { type: "hide-memories" },
    { type: "memory-confirm", id: "x" }, { type: "memory-update", id: "x", text: "value" },
    { type: "memory-remove", id: "x" },
  ] as const) await overlay.handleCommand(command);
  assert.equal(overlay.snapshot().memory, null);
  assert.deepEqual(overlay.snapshot(), before);
});

test("older refresh success or failure cannot replace a newer snapshot", async (t) => {
  const memory = deferredMemory();
  const overlay = new PetOverlay({ chat: chat(), memory: memory.port });
  t.after(() => overlay.dispose());
  assert.equal(memory.reads.length, 1, "initial read starts automatically");
  memory.emit();
  memory.reads[1].resolve([item("new", "最新")]);
  await flush();
  memory.reads[0].resolve([item("old", "旧值")]);
  await flush();
  assert.deepEqual(overlay.snapshot().memory!.pending.map((m) => m.id), ["new"]);
  memory.emit();
  memory.emit();
  memory.reads[3].resolve([item("newer", "更新")]);
  await flush();
  memory.reads[2].reject(new Error("private stale database exception"));
  await flush();
  assert.deepEqual(overlay.snapshot().memory!.pending.map((m) => m.id), ["newer"]);
  assert.equal(overlay.snapshot().memory!.error, null);
});

test("a failed load shows fixed text and a later successful refresh recovers", async (t) => {
  const memory = deferredMemory();
  const overlay = new PetOverlay({ chat: chat(), memory: memory.port });
  t.after(() => overlay.dispose());
  memory.reads[0].reject(new Error("token=private database location"));
  await flush();
  assert.equal(overlay.snapshot().memory!.error, "记忆加载失败，请稍后重试");
  memory.emit();
  memory.reads[1].resolve([item("p", "恢复")]);
  await flush();
  assert.equal(overlay.snapshot().memory!.error, null);
  assert.equal(overlay.snapshot().memory!.pending[0].id, "p");
});

test("failed mutations retain data and fixed errors through background refreshes", async (t) => {
  const { store, overlay } = setup(t);
  await store.propose(item("p", "原来的内容"));
  await flush();
  await overlay.handleCommand({ type: "memory-update", id: "p", text: " ".repeat(10) });
  assert.equal(overlay.snapshot().memory!.error, "记忆修改失败，请检查内容后重试");
  assert.equal(overlay.snapshot().memory!.pending[0].text, "原来的内容");
  await store.propose(item("new", "订阅刷新"));
  await flush();
  assert.equal(overlay.snapshot().memory!.error, "记忆修改失败，请检查内容后重试");
  await overlay.handleCommand({ type: "memory-update", id: "p", text: "修改成功" });
  assert.equal(overlay.snapshot().memory!.error, null);
});

test("a late failed command cannot overwrite a newer successful command", async (t) => {
  const memory = deferredMemory();
  const first = deferred<void>();
  memory.port.confirm = () => first.promise;
  const overlay = new PetOverlay({ chat: chat(), memory: memory.port });
  t.after(() => overlay.dispose());
  memory.reads[0].resolve([]);
  await flush();
  const older = overlay.handleCommand({ type: "memory-confirm", id: "old" });
  const newer = overlay.handleCommand({ type: "memory-remove", id: "new" });
  await flush();
  memory.reads[1].resolve([]);
  await newer;
  first.reject(new Error("private old failure"));
  await older;
  assert.equal(overlay.snapshot().memory!.error, null);
});

test("dispose unsubscribes and ignores outstanding reads, mutations and later commands", async () => {
  const memory = deferredMemory();
  const mutation = deferred<void>();
  memory.port.confirm = () => mutation.promise;
  const overlay = new PetOverlay({ chat: chat(), memory: memory.port });
  const pending = overlay.handleCommand({ type: "memory-confirm", id: "p" });
  let notifications = 0;
  overlay.subscribe(() => { notifications++; });
  overlay.dispose();
  const before = overlay.snapshot();
  memory.reads[0].resolve([item("late", "must not appear")]);
  mutation.resolve();
  await pending;
  await flush();
  await overlay.handleCommand({ type: "show-memories" });
  assert.equal(memory.listeners.size, 0);
  assert.equal(memory.reads.length, 1, "the late mutation did not issue a new read");
  assert.equal(notifications, 1);
  assert.deepEqual(overlay.snapshot(), before);
});

test("a failed snapshot listener never logs raw exception text from a memory update", async (t) => {
  const { store, overlay } = setup(t);
  await flush();
  const logs: unknown[][] = [];
  t.mock.method(console, "error", (...args: unknown[]) => { logs.push(args); });
  let shouldThrow = false;
  overlay.subscribe(() => {
    if (shouldThrow) throw new Error("private conversation and sk-secret-do-not-log");
  });
  shouldThrow = true;
  await store.propose(item("p", "待确认内容"));
  await flush();
  assert.deepEqual(logs, [["[app-coordinator] overlay listener failed"]]);
  assert.equal(overlay.snapshot().memory!.pending[0].id, "p");
});

test("constructor failure releases earlier subscriptions and abandons pending memory reads", async (t) => {
  const memory = deferredMemory();
  const avatar = createAvatarRuntime();
  const released: string[] = [];
  const subscribeMemory = memory.port.subscribe;
  memory.port.subscribe = (listener) => {
    const off = subscribeMemory(listener);
    return () => { released.push("memory"); off(); };
  };
  const subscribeAvatar = avatar.subscribe;
  avatar.subscribe = (listener) => {
    const off = subscribeAvatar(listener);
    return () => { released.push("avatar"); off(); };
  };
  // Capture the partial instance from its initial avatar snapshot to observe its cleanup.
  let partial: PetOverlay | undefined;
  const snapshot = PetOverlay.prototype.snapshot;
  t.mock.method(PetOverlay.prototype, "snapshot", function (this: PetOverlay) {
    partial = this;
    return snapshot.call(this);
  });
  let notifications = 0;
  const failure = new Error("chat subscription failed");
  const mainChat = chat();
  mainChat.subscribe = () => {
    assert.ok(partial);
    partial.subscribe(() => { notifications++; });
    throw failure;
  };
  assert.throws(() => new PetOverlay({
    chat: mainChat, memory: memory.port, avatar,
    tasks: { onStatusChange: () => () => { released.push("tasks"); } },
  }), (error) => error === failure);
  assert.deepEqual(released, ["memory", "tasks", "avatar"]);
  assert.equal(memory.listeners.size, 0);
  assert.ok(partial);
  const before = partial.snapshot();
  memory.reads[0].resolve([item("late", "must never appear")]);
  await flush();
  memory.emit();
  avatar.setDragging(true);
  assert.equal(memory.reads.length, 1);
  assert.equal(notifications, 1, "only the synchronous initial notification was delivered");
  assert.deepEqual(partial.snapshot(), before);
});
