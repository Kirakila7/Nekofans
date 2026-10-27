import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SqliteConversationStore } from "../../packages/conversation-store/src/index.ts";
import { SqliteSummaryStore } from "../../packages/memory-store/src/summaries.ts";
import { SqliteMemoryStore } from "../../packages/memory-store/src/index.ts";
import type { ChatMessage } from "../../packages/app-contracts/src/chat.ts";

function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "summary-store-"));
  const archive = new SqliteConversationStore(join(dir, "conversations.sqlite"));
  let store = new SqliteSummaryStore(join(dir, "memories.sqlite"), archive);
  t.after(() => { store.close(); archive.close(); rmSync(dir, { recursive: true, force: true }); });
  return { archive, get store() { return store; }, dir,
    restart() { store.close(); store = new SqliteSummaryStore(join(dir, "memories.sqlite"), archive); },
    input(extra = {}) { return { personaId: "bigfish", conversationId: "chat", beforeId: "m-20", query: "", budgetChars: 4000, signal: new AbortController().signal, ...extra }; },
  };
}

async function seed(archive: SqliteConversationStore, count = 21, personaId = "bigfish", conversationId = "chat"): Promise<ChatMessage[]> {
  const messages = Array.from({ length: count }, (_, i): ChatMessage => ({ id: `${personaId === "bigfish" && conversationId === "chat" ? "m" : personaId + conversationId}-${i}`, personaId, conversationId,
    role: i % 2 ? "assistant" : "user", text: i % 2 ? `角色回复 ${i}` : `用户提问 ${i}，这是问题，不是确认事实？`, createdAt: 1000 }));
  for (const message of messages) await archive.append(message);
  return messages;
}

test("summaries retain source identities and roles, cover only the discarded prefix, and preserve all raw messages", async (t) => {
  const f = fixture(t); const original = await seed(f.archive);
  await f.store.context(f.input());
  const port = f.store.forConversation("bigfish", "chat");
  const items = await port.list();
  assert.deepEqual(items.map((s) => s.sourceMessageIds.length), [4, 8, 8]);
  assert.equal(new Set(items.flatMap((s) => s.sourceMessageIds)).size, 20);
  assert.ok(items.every((s) => !s.sourceMessageIds.includes("m-20")));
  assert.match(items.at(-1)!.text, /用户原话.*用户提问 0/); assert.match(items.at(-1)!.text, /角色回复.*角色回复 1/);
  assert.deepEqual(await port.sources(items.at(-1)!.id), original.slice(0, 8));
  assert.deepEqual(await f.archive.recent("bigfish", "chat", 100), original);
  const memories = new SqliteMemoryStore(join(f.dir, "memories.sqlite"));
  try { assert.deepEqual(await memories.recall("bigfish", "用户提问", 1000), []); } finally { memories.close(); }
});

test("repeated refresh and restart do not duplicate chunks; deleted summaries remain deleted", async (t) => {
  const f = fixture(t); await seed(f.archive);
  await f.store.context(f.input());
  const before = await f.store.forConversation("bigfish", "chat").list();
  await f.store.context(f.input()); f.restart();
  const port = f.store.forConversation("bigfish", "chat");
  assert.deepEqual(await port.list(), before);
  await port.remove(before[1].id);
  await f.store.context(f.input()); f.restart();
  assert.equal((await f.store.forConversation("bigfish", "chat").list()).length, 2);
  assert.ok(!(await f.store.context(f.input())).some((s) => s.id === before[1].id));
  assert.equal((await f.archive.recent("bigfish", "chat", 100)).length, 21);
});

test("source reads, deletes and archive cursors are isolated by both persona and conversation", async (t) => {
  const f = fixture(t); await seed(f.archive); await seed(f.archive, 2, "other"); await seed(f.archive, 2, "bigfish", "other-chat");
  await f.store.context(f.input());
  const id = (await f.store.forConversation("bigfish", "chat").list())[0].id;
  for (const port of [f.store.forConversation("other", "chat"), f.store.forConversation("bigfish", "other-chat")]) {
    assert.deepEqual(await port.list(), []); await assert.rejects(port.sources(id)); await assert.rejects(port.remove(id));
  }
  await assert.rejects(f.archive.before("other", "chat", "m-20", null, 8));
  assert.deepEqual(await f.archive.byIds("other", "chat", ["m-0"]), []);
  assert.deepEqual(await f.archive.byIds("bigfish", "other-chat", ["m-0"]), []);
});

test("summary context is budgeted, retains source links, and long excerpts never replace full originals", async (t) => {
  const f = fixture(t); const original = await seed(f.archive);
  await f.archive.append({ ...original[0], id: "large", text: "首部" + "猫".repeat(2000) + "尾部" });
  await f.archive.append({ ...original[0], id: "boundary", text: "new" });
  const summaries = await f.store.context(f.input({ beforeId: "boundary", budgetChars: 1700 }));
  assert.ok(summaries.reduce((sum, s) => sum + JSON.stringify(s).length, 0) <= 1700);
  const all = await f.store.forConversation("bigfish", "chat").list();
  const large = all.find((s) => s.sourceMessageIds.includes("large"))!;
  assert.ok(large.text.includes("首部") && large.text.includes("尾部") && large.text.includes(" … "));
  assert.equal((await f.store.forConversation("bigfish", "chat").sources(large.id)).at(-1)!.text.length, 2004);
  assert.deepEqual(await f.store.context(f.input({ beforeId: "boundary", budgetChars: 1 })), []);
});

test("cancellation and disposal while source reads are pending prohibit later database writes", async () => {
  let resolve!: (messages: ChatMessage[]) => void;
  const pending = new Promise<ChatMessage[]>((yes) => { resolve = yes; });
  const archive = { append: async () => {}, recent: async () => [], byIds: async () => [], before: () => pending };
  for (const close of [false, true]) {
    const store = new SqliteSummaryStore(":memory:", archive);
    const controller = new AbortController();
    const context = store.context({ personaId: "p", conversationId: "c", beforeId: "new", query: "", budgetChars: 4000, signal: controller.signal });
    if (close) store.close(); else controller.abort();
    resolve([{ id: "old", personaId: "p", conversationId: "c", role: "user", text: "private", createdAt: 1 }]);
    await assert.rejects(context);
    if (!close) { assert.deepEqual(await store.forConversation("p", "c").list(), []); store.close(); }
  }
});

test("ranking an existing archive yields to cancellation and disposal without changing saved summaries", async (t) => {
  const f = fixture(t); await seed(f.archive);
  await f.store.context(f.input());
  // Populate persisted summaries directly so this regression isolates retrieval
  // of existing history, not the already-yielding summary-generation loop.
  const db = new DatabaseSync(join(f.dir, "memories.sqlite"));
  try {
    db.exec("BEGIN");
    const insert = db.prepare("INSERT INTO conversation_summaries(id,persona_id,conversation_id,text,source_ids,updated_at) VALUES(?,?,?,?,?,?)");
    for (let i = 0; i < 200; i++) insert.run(`rank-${i}`, "bigfish", "chat", "用户原话：历史示例".repeat(80), JSON.stringify(["m-0"]), i);
    db.exec("COMMIT");
  } finally { db.close(); }
  const saved = await f.store.forConversation("bigfish", "chat").list();
  for (const close of [false, true]) {
    const controller = new AbortController();
    const pending = f.store.context(f.input({ query: "历史示例", signal: controller.signal }));
    // No wall-clock speed assertion: an event-loop callback must run before
    // retrieval completes, even when there is no new raw history to summarize.
    const stop = setImmediate(() => { if (close) f.store.close(); else controller.abort(); });
    try { await assert.rejects(pending, /Summary operation stopped/); }
    finally { clearImmediate(stop); }
    f.restart();
    assert.deepEqual(await f.store.forConversation("bigfish", "chat").list(), saved);
  }
});

test("paged ranking preserves relevance, recency ties and chronological output under a small budget", async (t) => {
  const f = fixture(t); await seed(f.archive);
  await f.store.context(f.input());
  const db = new DatabaseSync(join(f.dir, "memories.sqlite"));
  try {
    db.exec("BEGIN");
    const insert = db.prepare("INSERT INTO conversation_summaries(id,persona_id,conversation_id,text,source_ids,updated_at) VALUES(?,?,?,?,?,?)");
    for (let i = 0; i < 140; i++) insert.run(`page-${i}`, "bigfish", "chat", i === 0 || i === 139 ? "needle route" : "unrelated text", JSON.stringify(["m-0"]), i);
    db.exec("COMMIT");
  } finally { db.close(); }
  const all = await f.store.forConversation("bigfish", "chat").list();
  const expected = [all.find((s) => s.id === "page-0")!, all.find((s) => s.id === "page-139")!];
  const budget = expected.reduce((sum, s) => sum + JSON.stringify(s).length, 0);
  assert.deepEqual(await f.store.context(f.input({ query: "needle route", budgetChars: budget })), expected);
  assert.deepEqual((await f.store.context(f.input({ query: "needle route", budgetChars: JSON.stringify(expected[1]).length }))).map((s) => s.id), ["page-139"]);
});
