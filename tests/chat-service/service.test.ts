// Framework v1 step 2: MainChatService send pipeline with a fake provider and a real
// SqliteConversationStore in a temp dir.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  ChatEvent,
  ChatStreamInput,
  MainChatState,
  MemoryItem,
  MemoryProvider,
  Persona,
} from "../../packages/app-contracts/src/chat.ts";
import { ChatApiError } from "../../packages/chat-api/src/index.ts";
import { SqliteConversationStore } from "../../packages/conversation-store/src/index.ts";
import { MainChatService, chatErrorText } from "../../packages/chat-service/src/index.ts";

const persona: Persona = { id: "bigfish", name: "大肥鱼", prompt: "你是大肥鱼。", memoryNamespace: "bigfish" };

let dir: string;
let store: SqliteConversationStore;
let convSeq = 0;
const warnings: string[] = [];

before(() => {
  dir = mkdtempSync(join(tmpdir(), "chat-service-"));
  store = new SqliteConversationStore(join(dir, "conversations.sqlite"));
});
after(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

function gate() {
  let open!: () => void;
  const promise = new Promise<void>((r) => (open = r));
  return { promise, open };
}

type Step = { delta: string } | { wait: Promise<void> } | { throw: unknown } | { complete: string };

/** Fake provider: each stream() call plays the next script and records its input. */
function fakeProvider(scripts: Step[][]) {
  const inputs: ChatStreamInput[] = [];
  let call = 0;
  return {
    inputs,
    stream(input: ChatStreamInput): AsyncIterable<ChatEvent> {
      inputs.push({ ...input, messages: [...input.messages], memories: [...input.memories] });
      const script = scripts[call++] ?? [];
      return (async function* () {
        for (const step of script) {
          if ("delta" in step) yield { type: "delta", text: step.delta };
          else if ("wait" in step) await step.wait;
          else if ("throw" in step) throw step.throw;
          else yield { type: "complete", messageId: step.complete };
        }
      })();
    },
  };
}

function service(provider: ReturnType<typeof fakeProvider>, extra: Partial<ConstructorParameters<typeof MainChatService>[0]> = {}) {
  let id = 0;
  const seq = ++convSeq;
  let clock = 1000;
  return new MainChatService({
    persona,
    provider,
    conversations: store,
    conversationId: `conv-${seq}`,
    newId: () => `id-${seq}-${++id}`,
    now: () => ++clock,
    warn: (m) => warnings.push(m),
    ...extra,
  });
}

test("streams connecting -> replying -> idle and saves both messages", async () => {
  const p = fakeProvider([[{ delta: "你" }, { delta: "好呀" }, { complete: "reply-1" }]]);
  const svc = service(p);
  const states: MainChatState[] = [];
  const unsubscribe = svc.subscribe((s) => states.push(s));
  const result = await svc.send("  你好  ");
  unsubscribe();

  assert.deepEqual(result, { status: "completed", messageId: "reply-1", text: "你好呀" });
  assert.deepEqual(states, [
    { personaId: "bigfish", phase: "idle" },
    { personaId: "bigfish", phase: "connecting", lastUserMessage: "你好", reply: "" },
    { personaId: "bigfish", phase: "replying", lastUserMessage: "你好", reply: "你" },
    { personaId: "bigfish", phase: "replying", lastUserMessage: "你好", reply: "你好呀" },
    { personaId: "bigfish", phase: "idle", lastUserMessage: "你好", reply: "你好呀" },
  ]);
  assert.ok(states.every((s) => !("errorMessage" in s)));

  const saved = await store.recent("bigfish", svc.conversationId, 10);
  assert.deepEqual(
    saved.map((m) => [m.role, m.text, m.id]),
    [
      ["user", "你好", saved[0].id],
      ["assistant", "你好呀", "reply-1"],
    ],
  );
  assert.ok(saved[0].createdAt < saved[1].createdAt);
  assert.equal(p.inputs[0].maxOutputTokens, 1024);
  assert.deepEqual(p.inputs[0].messages.map((m) => m.text), ["你好"]);
});

test("stalled native memory handoff does not delay completion of a saved reply", { timeout: 2000 }, async () => {
  const entered = gate(), stalled = gate();
  const svc = service(fakeProvider([[{ delta: "saved" }, { complete: "native-handoff" }]]), {
    onTurnSaved: async () => { entered.open(); await stalled.promise; },
  });
  try {
    const pending = svc.send("remember this");
    await entered.promise;
    assert.equal((await pending).status, "completed");
    assert.equal(svc.state().phase, "idle");
    assert.deepEqual((await store.recent("bigfish", svc.conversationId, 10)).map(m => m.role), ["user", "assistant"]);
  } finally { stalled.open(); svc.dispose(); }
});

test("state() returns a copy", () => {
  const svc = service(fakeProvider([]));
  const s = svc.state();
  s.phase = "error";
  assert.equal(svc.state().phase, "idle");
});

test("history includes earlier turns and respects historyLimit", async () => {
  const p = fakeProvider([
    [{ delta: "一" }, { complete: "a1" }],
    [{ delta: "二" }, { complete: "a2" }],
    [{ delta: "三" }, { complete: "a3" }],
  ]);
  const svc = service(p, { historyLimit: 3, maxOutputTokens: 77 });
  await svc.send("u1");
  await svc.send("u2");
  await svc.send("u3");
  assert.deepEqual(p.inputs[1].messages.map((m) => m.text), ["u1", "一", "u2"]);
  assert.deepEqual(p.inputs[2].messages.map((m) => m.text), ["u2", "二", "u3"]);
  assert.equal(p.inputs[2].messages.at(-1)?.role, "user");
  assert.equal(p.inputs[2].maxOutputTokens, 77);
  assert.ok(p.inputs.every((i) => i.persona.id === "bigfish"));
});

test("history character budget keeps the latest message and all raw messages remain saved", async () => {
  const p = fakeProvider([
    [{ delta: "a".repeat(1000) }, { complete: "budget-a1" }],
    [{ delta: "b".repeat(1000) }, { complete: "budget-a2" }],
    [{ delta: "c".repeat(1000) }, { complete: "budget-a3" }],
    [{ delta: "done" }, { complete: "budget-a4" }],
  ]);
  const svc = service(p, { historyBudgetChars: 8000 });
  await svc.send("一".repeat(3000));
  await svc.send("二".repeat(3000));
  await svc.send("三".repeat(3000));
  assert.deepEqual(p.inputs[2].messages.map((m) => m.text), [
    "二".repeat(3000), "b".repeat(1000), "三".repeat(3000),
  ]);
  await svc.send("四".repeat(8000));
  assert.deepEqual(p.inputs[3].messages.map((m) => m.text), ["四".repeat(8000)]);
  assert.ok(p.inputs.every((input) => input.messages.reduce((n, m) => n + m.text.length, 0) <= 8000));
  const saved = await store.recent("bigfish", svc.conversationId, 20);
  assert.deepEqual(saved.map((m) => m.text.length), [3000, 1000, 3000, 1000, 3000, 1000, 8000, 4]);
});

test("history always ends with the saved current user message, even when recent is empty", async () => {
  const p = fakeProvider([[{ delta: "好" }, { complete: "stale-history" }]]);
  const svc = service(p, {
    conversations: { append: store.append.bind(store), recent: async () => [] },
  });
  await svc.send("最新一条");
  const saved = await store.recent("bigfish", svc.conversationId, 10);
  assert.deepEqual(p.inputs[0].messages, [saved[0]]);
});

test("input exceeding the IPC limit is rejected before storage and provider work", async () => {
  const p = fakeProvider([]);
  const svc = service(p);
  await assert.rejects(svc.send("x".repeat(8001)), /input too long/);
  await assert.rejects(svc.send(" ".repeat(8000) + "x"), /input too long/, "check before trimming like IPC");
  assert.deepEqual(await store.recent("bigfish", svc.conversationId, 10), []);
  assert.equal(p.inputs.length, 0);
  assert.equal(svc.state().phase, "idle");
  assert.throws(() => service(p, { historyBudgetChars: 7999 }), /historyBudgetChars/);
});

test("busy while a turn runs; empty input rejected", async () => {
  const g = gate();
  const p = fakeProvider([[{ delta: "x" }, { wait: g.promise }, { complete: "r" }], [{ delta: "y" }, { complete: "r2" }]]);
  const svc = service(p);
  await assert.rejects(svc.send("   "), /empty input/);
  await assert.rejects(svc.send(""), /empty input/);
  const first = svc.send("一");
  await assert.rejects(svc.send("二"), /busy/);
  g.open();
  assert.equal((await first).status, "completed");
  assert.equal((await svc.send("三")).status, "completed");
  assert.equal(p.inputs.length, 2);
});

test("API errors resolve with fixed text, keep the user message, save no reply", async () => {
  const raw = "upstream said sk-secret-123";
  const cases: Array<[unknown, string, string]> = [
    [new ChatApiError("auth", raw, 401), "auth", "API 密钥无效或没有权限"],
    [new ChatApiError("insufficient_balance", raw, 402), "insufficient_balance", "DeepSeek API 余额不足，请检查 API 平台余额"],
    [new ChatApiError("timeout", raw), "timeout", "聊天 API 响应超时"],
    [new Error(raw), "internal", "聊天 API 出错了"],
  ];
  for (const [error, code, text] of cases) {
    const p = fakeProvider([[{ delta: "半" }, { throw: error }]]);
    const svc = service(p);
    const states: MainChatState[] = [];
    svc.subscribe((s) => states.push(s));
    const result = await svc.send("问");
    assert.deepEqual(result, { status: "error", code, message: text });
    assert.equal(chatErrorText(code), text);
    assert.deepEqual(svc.state(), {
      personaId: "bigfish",
      phase: "error",
      lastUserMessage: "问",
      reply: "半",
      errorMessage: text,
    });
    for (const s of states) assert.ok(!JSON.stringify(s).includes("sk-secret"), "raw text never in state");
    const saved = await store.recent("bigfish", svc.conversationId, 10);
    assert.deepEqual(saved.map((m) => m.role), ["user"]);
  }
  // A following successful turn clears errorMessage.
  const p = fakeProvider([[{ throw: new ChatApiError("not_configured", "x") }], [{ delta: "好" }, { complete: "ok" }]]);
  const svc = service(p);
  assert.equal((await svc.send("a")).status, "error");
  assert.equal(svc.state().errorMessage, "聊天 API 还没配置好（地址、模型或密钥）");
  svc.subscribe(() => {});
  assert.equal((await svc.send("b")).status, "completed");
  assert.equal(svc.state().errorMessage, undefined);
  assert.equal(chatErrorText("whatever"), "聊天 API 出错了");
});

test("empty completion is an error; storage failure on the reply is reported", async () => {
  const svc = service(fakeProvider([[{ complete: "r" }]]));
  assert.deepEqual(await svc.send("hi"), { status: "error", code: "empty", message: "模型没有返回内容" });

  let appends = 0;
  const flaky = {
    append: async (m: Parameters<SqliteConversationStore["append"]>[0]) => {
      if (++appends === 2) throw new Error("disk full");
      await store.append(m);
    },
    recent: store.recent.bind(store),
  };
  const svc2 = service(fakeProvider([[{ delta: "回" }, { complete: "r-storage" }]]), { conversations: flaky });
  const result = await svc2.send("hi");
  assert.equal(result.status, "error");
  assert.equal(result.status === "error" && result.code, "storage");
  assert.equal(svc2.state().phase, "error");
  assert.equal(svc2.state().reply, "回");
});

test("cancel mid-stream: cancelled result, no reply saved, idle; false when idle", async () => {
  const g = gate();
  const p = fakeProvider([[{ delta: "一半" }, { wait: g.promise }, { delta: "不该出现" }, { complete: "r" }]]);
  const svc = service(p);
  assert.equal(svc.cancel(), false);
  const replying = gate();
  svc.subscribe((s) => {
    if (s.phase === "replying") replying.open();
  });
  const pending = svc.send("讲个故事");
  await replying.promise;
  assert.equal(p.inputs[0].signal.aborted, false);
  assert.equal(svc.cancel(), true);
  // Resolves without the provider ever continuing.
  const result = await pending;
  assert.deepEqual(result, { status: "cancelled", partial: "一半" });
  assert.equal(p.inputs[0].signal.aborted, true);
  assert.deepEqual(svc.state(), { personaId: "bigfish", phase: "idle", lastUserMessage: "讲个故事", reply: "" });
  assert.equal(svc.cancel(), false);
  g.open();
  const saved = await store.recent("bigfish", svc.conversationId, 10);
  assert.deepEqual(saved.map((m) => m.role), ["user"]);
});

test("cancel wins even when the provider then throws a different error", async () => {
  const g = gate();
  let svcRef!: MainChatService;
  const p = {
    stream(input: ChatStreamInput): AsyncIterable<ChatEvent> {
      return (async function* () {
        yield { type: "delta" as const, text: "a" };
        await g.promise;
        if (input.signal.aborted) throw new ChatApiError("network", "socket closed");
      })();
    },
  };
  svcRef = service(p as never);
  const replying = gate();
  svcRef.subscribe((s) => s.phase === "replying" && replying.open());
  const pending = svcRef.send("x");
  await replying.promise;
  svcRef.cancel();
  g.open();
  assert.equal((await pending).status, "cancelled");
});

test("memory recall failure does not fail the turn; recalled memories reach the provider", async () => {
  const confirmed: MemoryItem = {
    id: "m1",
    personaId: "bigfish",
    kind: "preference",
    text: "喜欢吃鱼",
    sourceMessageIds: [],
    confirmation: "confirmed",
    updatedAt: 1,
  };
  const calls: Array<[string, string, number]> = [];
  let fail = true;
  const memory: MemoryProvider = {
    async recall(personaId, query, budget) {
      calls.push([personaId, query, budget]);
      if (fail) throw new Error("memory service down");
      return [confirmed];
    },
    async propose() {},
    async confirm() {},
    async update() {},
    async remove() {},
  };
  const p = fakeProvider([
    [{ delta: "好" }, { complete: "mem-r1" }],
    [{ delta: "好" }, { complete: "mem-r2" }],
  ]);
  const svc = service(p, { memory, memoryBudgetTokens: 300 });
  const before = warnings.length;
  assert.equal((await svc.send("第一句")).status, "completed");
  assert.deepEqual(p.inputs[0].memories, []);
  assert.ok(warnings.slice(before).some((w) => /recall failed/.test(w)));
  fail = false;
  assert.equal((await svc.send("第二句")).status, "completed");
  assert.deepEqual(p.inputs[1].memories, [confirmed]);
  assert.deepEqual(calls, [
    ["bigfish", "第一句", 300],
    ["bigfish", "第二句", 300],
  ]);
});

test("persona getter is re-evaluated per turn", async () => {
  let prompt = "第一版";
  const p = fakeProvider([
    [{ delta: "a" }, { complete: "g1" }],
    [{ delta: "b" }, { complete: "g2" }],
  ]);
  const svc = service(p, { persona: () => ({ ...persona, prompt }) });
  await svc.send("1");
  prompt = "第二版";
  await svc.send("2");
  assert.deepEqual(p.inputs.map((i) => i.persona.prompt), ["第一版", "第二版"]);
});

test("listener exceptions are caught; dispose cancels and drops listeners", async () => {
  const g = gate();
  const p = fakeProvider([[{ delta: "a" }, { wait: g.promise }, { complete: "d1" }]]);
  const svc = service(p);
  const before = warnings.length;
  svc.subscribe(() => {
    throw new Error("listener boom");
  });
  assert.ok(warnings.slice(before).some((w) => /listener threw/.test(w)));
  const seen: string[] = [];
  svc.subscribe((s) => seen.push(s.phase));
  const pending = svc.send("x");
  await new Promise((r) => setImmediate(r));
  svc.dispose();
  const result = await pending;
  assert.equal(result.status, "cancelled");
  assert.deepEqual(seen, ["idle", "connecting", "replying"], "no state after dispose");
  g.open();
  await assert.rejects(svc.send("y"), /disposed/);
});

function item(id: string, text: string, personaId = "bigfish"): MemoryItem {
  return { id, personaId, kind: "fact", text, sourceMessageIds: [], confirmation: "pending", updatedAt: 1 };
}

/** Fake memory: recall returns nothing, propose records items and can be made to reject. */
function recordingMemory(rejectOn: (item: MemoryItem) => boolean = () => false) {
  const proposed: MemoryItem[] = [];
  const memory: MemoryProvider = {
    async recall() {
      return [];
    },
    async propose(i) {
      if (rejectOn(i)) throw new Error("memory write failed");
      proposed.push(i);
    },
    async confirm() {},
    async update() {},
    async remove() {},
  };
  return { memory, proposed };
}

test("completed turn: proposals from the saved user message are stored before idle", async () => {
  const { memory, proposed } = recordingMemory();
  const seen: string[] = [];
  const p = fakeProvider([[{ delta: "好" }, { complete: "prop-r1" }]]);
  const svc = service(p, {
    memory,
    proposeMemories: (m) => {
      seen.push(`${m.role}:${m.text}:${m.id}`);
      return [item("p1", "早上喝咖啡"), item("p2", "叫小明")];
    },
  });
  let proposedAtIdle = -1;
  svc.subscribe((s) => {
    if (s.phase === "idle" && s.reply === "好") proposedAtIdle = proposed.length;
  });
  assert.equal((await svc.send("记住我每天早上喝咖啡")).status, "completed");
  const saved = await store.recent("bigfish", svc.conversationId, 10);
  assert.deepEqual(seen, [`user:记住我每天早上喝咖啡:${saved[0].id}`]);
  assert.deepEqual(proposed.map((i) => i.id), ["p1", "p2"]);
  assert.equal(proposedAtIdle, 2, "proposals stored before the idle state");
});

test("proposals: items for another persona are dropped; nothing without memory", async () => {
  const { memory, proposed } = recordingMemory();
  const extract = () => [item("own", "a"), item("other", "b", "someone-else")];
  const svc = service(fakeProvider([[{ delta: "好" }, { complete: "prop-r2" }]]), { memory, proposeMemories: extract });
  assert.equal((await svc.send("x")).status, "completed");
  assert.deepEqual(proposed.map((i) => i.id), ["own"]);

  let called = false;
  const noMemory = service(fakeProvider([[{ delta: "好" }, { complete: "prop-r3" }]]), {
    proposeMemories: () => {
      called = true;
      return [];
    },
  });
  assert.equal((await noMemory.send("x")).status, "completed");
  assert.equal(called, false);
});

test("proposals: none on cancelled or failed turns", async () => {
  const { memory, proposed } = recordingMemory();
  let calls = 0;
  const proposeMemories = () => {
    calls++;
    return [item("never", "x")];
  };
  const g = gate();
  const p = fakeProvider([[{ delta: "半" }, { wait: g.promise }, { complete: "r" }], [{ delta: "半" }, { throw: new ChatApiError("network", "x") }]]);
  const svc = service(p, { memory, proposeMemories });
  const replying = gate();
  svc.subscribe((s) => s.phase === "replying" && replying.open());
  const pending = svc.send("记住这个");
  await replying.promise;
  svc.cancel();
  assert.equal((await pending).status, "cancelled");
  g.open();
  assert.equal((await svc.send("记住那个")).status, "error");
  assert.equal(calls, 0);
  assert.deepEqual(proposed, []);
});

test("proposals: extractor throw or propose rejection only warns", async () => {
  const { memory, proposed } = recordingMemory((i) => i.id === "bad");
  const p = fakeProvider([
    [{ delta: "一" }, { complete: "prop-w1" }],
    [{ delta: "二" }, { complete: "prop-w2" }],
  ]);
  let mode: "throw" | "reject" = "throw";
  const svc = service(p, {
    memory,
    proposeMemories: () => {
      if (mode === "throw") throw new Error("extractor boom");
      return [item("bad", "x"), item("good", "y")];
    },
  });
  const before = warnings.length;
  assert.deepEqual(await svc.send("1"), { status: "completed", messageId: "prop-w1", text: "一" });
  assert.equal(svc.state().phase, "idle");
  assert.ok(warnings.slice(before).includes("main chat: extracting memory proposals failed"));
  mode = "reject";
  assert.deepEqual(await svc.send("2"), { status: "completed", messageId: "prop-w2", text: "二" });
  assert.equal(svc.state().phase, "idle");
  assert.ok(warnings.slice(before).includes("main chat: storing a memory proposal failed"));
  assert.deepEqual(proposed.map((i) => i.id), ["good"], "a rejected item does not stop the rest");
});

test("warnings never include exception text from any failure boundary", async () => {
  const sensitive = "private user conversation; sk-secret-do-not-log";
  const failure = new Error(sensitive);
  const warningLog: string[] = [];
  const make = (extra: Partial<ConstructorParameters<typeof MainChatService>[0]> = {}, providerError?: unknown) => {
    const p = fakeProvider([providerError
      ? [{ throw: providerError }]
      : [{ delta: "ok" }, { complete: `privacy-${++convSeq}` }]]);
    return service(p, { warn: (m) => warningLog.push(m), ...extra });
  };
  let personaReads = 0;
  await make({ persona: () => { if (personaReads++) throw failure; return persona; } }).send("x");
  await make({ conversations: { append: async () => { throw failure; }, recent: store.recent.bind(store) } }).send("x");
  await make({ conversations: { append: store.append.bind(store), recent: async () => { throw failure; } } }).send("x");
  await make({ conversations: {
    append: async (m) => { if (m.role === "assistant") throw failure; await store.append(m); },
    recent: store.recent.bind(store),
  } }).send("x");
  const { memory } = recordingMemory();
  await make({ memory: { ...memory, recall: async () => { throw failure; } } }).send("x");
  await make({ memory, proposeMemories: () => { throw failure; } }).send("x");
  await make({ memory: { ...memory, propose: async () => { throw failure; } }, proposeMemories: () => [item("privacy", "x")] }).send("x");
  await make({}, failure).send("x");
  await make({}, new ChatApiError("auth", sensitive)).send("x");
  await make({}, new ChatApiError(sensitive as never, sensitive)).send("x");
  const listenerService = make();
  listenerService.subscribe(() => { throw failure; });
  await listenerService.send("x");

  assert.ok(warningLog.length >= 11);
  assert.ok(warningLog.every((message) => !message.includes(sensitive) && !message.includes("sk-secret") && !message.includes("private user")));
  assert.ok(warningLog.includes("main chat: turn failed with internal"));
  assert.ok(warningLog.includes("main chat: turn failed with auth"));
});

test("stalled proposals time out without blocking the completed reply or later turns", { timeout: 2000 }, async () => {
  const entered = gate();
  const stalled = gate();
  const calls: string[] = [];
  const { memory } = recordingMemory();
  memory.propose = async (proposal) => {
    calls.push(proposal.id);
    entered.open();
    await stalled.promise;
    throw new Error("late sk-secret failure");
  };
  const p = fakeProvider([
    [{ delta: "first" }, { complete: "timeout-first" }],
    [{ delta: "next" }, { complete: "timeout-next" }],
  ]);
  let extractCalls = 0;
  const svc = service(p, {
    memory, proposalTimeoutMs: 20,
    proposeMemories: () => extractCalls++ === 0 ? [item("slow", "x"), item("never-start", "y")] : [],
  });
  const before = warnings.length;
  const pending = svc.send("first question");
  await entered.promise;
  assert.deepEqual(await pending, { status: "completed", messageId: "timeout-first", text: "first" });
  assert.equal(svc.state().phase, "idle");
  assert.ok(warnings.slice(before).includes("main chat: memory proposals timed out"));
  assert.equal((await svc.send("next question")).status, "completed");
  const state = svc.state();
  stalled.open();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, ["slow"], "late settlement never starts another proposal");
  assert.deepEqual(svc.state(), state, "late failure cannot overwrite a newer turn");
  assert.deepEqual((await store.recent("bigfish", svc.conversationId, 10)).map((m) => m.role), ["user", "assistant", "user", "assistant"]);
});

test("cancel while storing proposals immediately ends optional work and preserves the saved reply", { timeout: 2000 }, async () => {
  const entered = gate();
  const stalled = gate();
  const { memory } = recordingMemory();
  const calls: string[] = [];
  memory.propose = async (proposal) => {
    calls.push(proposal.id);
    entered.open();
    await stalled.promise;
  };
  const svc = service(fakeProvider([[{ delta: "saved" }, { complete: "cancel-proposal" }]]), {
    memory, proposalTimeoutMs: 10000,
    proposeMemories: () => [item("slow", "x"), item("never-start", "y")],
  });
  const pending = svc.send("remember this");
  await entered.promise;
  assert.equal(svc.cancel(), true);
  assert.deepEqual(await pending, { status: "completed", messageId: "cancel-proposal", text: "saved" });
  assert.equal(svc.state().reply, "saved");
  assert.equal(svc.cancel(), false);
  stalled.open();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, ["slow"]);
  assert.deepEqual((await store.recent("bigfish", svc.conversationId, 10)).map((m) => m.role), ["user", "assistant"]);
});

test("dispose during a proposal never permits asynchronous state writes or later proposals", { timeout: 2000 }, async () => {
  const entered = gate();
  const stalled = gate();
  const { memory } = recordingMemory();
  const calls: string[] = [];
  memory.propose = async (proposal) => {
    calls.push(proposal.id);
    entered.open();
    await stalled.promise;
  };
  const svc = service(fakeProvider([[{ delta: "saved" }, { complete: "dispose-proposal" }]]), {
    memory, proposalTimeoutMs: 10000,
    proposeMemories: () => [item("slow", "x"), item("never-start", "y")],
  });
  const states: MainChatState[] = [];
  svc.subscribe((state) => states.push(state));
  const pending = svc.send("remember this");
  await entered.promise;
  const stateAtDispose = svc.state();
  const stateCount = states.length;
  svc.dispose();
  assert.equal((await pending).status, "completed");
  stalled.open();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(svc.state(), stateAtDispose);
  assert.equal(states.length, stateCount);
  assert.deepEqual(calls, ["slow"]);
});
