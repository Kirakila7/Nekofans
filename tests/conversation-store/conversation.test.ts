// Conversation store tests: ordering, limit, idempotent append, restart
// recovery and persona isolation. The database lives in a temp dir.
import { after, before, test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ChatMessage } from "../../packages/app-contracts/src/chat.ts";
import { SqliteConversationStore } from "../../packages/conversation-store/src/index.ts";

let tempDir: string;
let dbPath: string;
let store: SqliteConversationStore;

function msg(id: string, personaId: string, conversationId: string, text: string, createdAt = 1000): ChatMessage {
  return { id, personaId, conversationId, role: id.endsWith("u") ? "user" : "assistant", text, createdAt };
}

before(() => {
  tempDir = mkdtempSync(join(tmpdir(), "conversation-store-"));
  dbPath = join(tempDir, "conversations.sqlite");
  store = new SqliteConversationStore(dbPath);
});

after(() => {
  store.close();
  rmSync(tempDir, { recursive: true, force: true });
});

test("append + recent returns the last N oldest-first", async () => {
  // Same createdAt on purpose: ordering must come from insertion order.
  for (let i = 1; i <= 5; i++) {
    await store.append(msg(`m${i}${i % 2 ? "u" : "a"}`, "bigfish", "c1", `text ${i}`));
  }
  const all = await store.recent("bigfish", "c1", 10);
  assert.deepEqual(all.map((m) => m.text), ["text 1", "text 2", "text 3", "text 4", "text 5"]);
  assert.equal(all[0].role, "user");
  assert.equal(all[1].role, "assistant");
  const last2 = await store.recent("bigfish", "c1", 2);
  assert.deepEqual(last2.map((m) => m.text), ["text 4", "text 5"]);
  assert.deepEqual(await store.recent("bigfish", "c1", 0), []);
});

test("append is idempotent on id; conflicting content throws", async () => {
  const m = msg("dup-u", "bigfish", "c2", "hello", 2000);
  await store.append(m);
  await store.append({ ...m });
  assert.equal((await store.recent("bigfish", "c2", 10)).length, 1);
  await assert.rejects(store.append({ ...m, text: "changed" }), /different content/);
  await assert.rejects(store.append({ ...m, personaId: "other" }), /different content/);
});

test("rejects invalid role", async () => {
  await assert.rejects(store.append({ ...msg("bad-u", "bigfish", "c1", "x"), role: "system" as "user" }));
});

test("persona isolation even with the same conversationId", async () => {
  await store.append(msg("o1u", "other", "c1", "other secret"));
  const bigfish = await store.recent("bigfish", "c1", 100);
  assert.ok(bigfish.every((m) => m.personaId === "bigfish"));
  assert.ok(!bigfish.some((m) => m.text === "other secret"));
  const other = await store.recent("other", "c1", 100);
  assert.deepEqual(other.map((m) => m.text), ["other secret"]);
  assert.equal(store.latestConversationId("other"), "c1");
  assert.equal(store.latestConversationId("nobody"), null);
});

test("restart recovery: history and latest conversation survive reopen", async () => {
  await store.append(msg("r1u", "bigfish", "c3", "before restart", 3000));
  assert.equal(store.latestConversationId("bigfish"), "c3");
  const before = await store.recent("bigfish", "c1", 100);
  store.close();

  store = new SqliteConversationStore(dbPath);
  assert.equal(store.latestConversationId("bigfish"), "c3");
  assert.deepEqual(await store.recent("bigfish", "c1", 100), before);
  const c3 = await store.recent("bigfish", "c3", 10);
  assert.deepEqual(c3, [msg("r1u", "bigfish", "c3", "before restart", 3000)]);
  // Appends after reopen continue the order.
  await store.append(msg("r2a", "bigfish", "c3", "after restart", 1));
  assert.deepEqual((await store.recent("bigfish", "c3", 10)).map((m) => m.text), ["before restart", "after restart"]);
});

test("a legacy database opens in place and QQ pages exclude desktop messages", async () => {
  const legacyPath = join(tempDir, "legacy.sqlite");
  const legacy = new DatabaseSync(legacyPath);
  legacy.exec("CREATE TABLE messages (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, persona_id TEXT NOT NULL, conversation_id TEXT NOT NULL, role TEXT NOT NULL, text TEXT NOT NULL, created_at INTEGER NOT NULL) STRICT");
  legacy.prepare("INSERT INTO messages (id, persona_id, conversation_id, role, text, created_at) VALUES (?, ?, ?, ?, ?, ?)").run("old-u", "bigfish", "qq-view", "user", "旧桌面消息", 1000);
  legacy.close();
  const migrated = new SqliteConversationStore(legacyPath);
  try {
    for (const [id, text, source] of [
      ["qq-u", "手机消息", "qq"], ["desktop-u", "新桌面消息", undefined], ["qq-a", "大肥鱼回复", "qq"],
    ] as const) {
      await migrated.append({ ...msg(id, "bigfish", "qq-view", text), ...(source ? {source} : {}) });
    }
    assert.deepEqual((await migrated.recent("bigfish", "qq-view", 4)).map(row=>row.id),["old-u","qq-u","desktop-u","qq-a"]);
    assert.deepEqual((await migrated.recent("bigfish", "qq-view", 2, "qq")).map(row=>row.id),["qq-u","qq-a"]);
    assert.deepEqual((await migrated.pageBefore("bigfish","qq-view","qq-a",40,"qq")).map(row=>row.id),["qq-u"]);
    await assert.rejects(migrated.pageBefore("bigfish","qq-view","desktop-u",40,"qq"),/not in this conversation/);
  } finally { migrated.close(); }
});

test("QQ preview migration preserves both channel histories and pagination", async () => {
  const file = join(tempDir, "qq-preview.sqlite");
  const preview = new DatabaseSync(file);
  preview.exec(`
    CREATE TABLE messages (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
      persona_id TEXT NOT NULL, conversation_id TEXT NOT NULL,
      role TEXT NOT NULL, text TEXT NOT NULL, created_at INTEGER NOT NULL,
      source TEXT CHECK (source IS NULL OR source = 'qq')
    ) STRICT;
    CREATE INDEX messages_by_conversation ON messages (persona_id, conversation_id, seq);
    INSERT INTO messages VALUES (7, 'qq-legacy', 'bigfish', 'channels', 'user', 'QQ 旧消息', 1000, 'qq');
  `);
  preview.close();
  const migrated = new SqliteConversationStore(file);
  try {
    await migrated.append({ ...msg("wechat-new", "bigfish", "channels", "微信新消息"), source: "wechat" });
    assert.deepEqual((await migrated.recent("bigfish", "channels", 10, "qq")).map(row => row.id), ["qq-legacy"]);
    assert.deepEqual((await migrated.recent("bigfish", "channels", 10, "wechat")).map(row => row.id), ["wechat-new"]);
    assert.deepEqual((await migrated.pageBefore("bigfish", "channels", "wechat-new", 10)).map(row => row.id), ["qq-legacy"]);
  } finally { migrated.close(); }
});
