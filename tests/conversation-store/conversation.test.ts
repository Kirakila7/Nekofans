// Conversation store tests: ordering, limit, idempotent append, restart
// recovery and persona isolation. The database lives in a temp dir.
import { after, before, test } from "node:test";
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
