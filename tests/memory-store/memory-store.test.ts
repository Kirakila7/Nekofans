// Memory store tests: pending/confirmed lifecycle, persona isolation (step-4
// acceptance), validation, dedupe, recall ranking and budget, restart recovery
// and change notifications. Each test gets its own database in a temp dir.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { MemoryItem } from "../../packages/app-contracts/src/chat.ts";
import {
  MemoryNotFoundError,
  SqliteMemoryStore,
  estimateTokens,
} from "../../packages/memory-store/src/index.ts";

let tempDir: string;
let dbCount = 0;
const open: SqliteMemoryStore[] = [];

/** Fresh store with a controllable clock. */
function fresh(start = 10_000): { store: SqliteMemoryStore; path: string; clock: { t: number } } {
  const clock = { t: start };
  const path = join(tempDir, `memories-${++dbCount}.sqlite`);
  const store = new SqliteMemoryStore(path, { now: () => clock.t });
  open.push(store);
  return { store, path, clock };
}

function item(id: string, personaId: string, text: string, extra: Partial<MemoryItem> = {}): MemoryItem {
  return {
    id,
    personaId,
    kind: "fact",
    text,
    sourceMessageIds: [`msg-${id}`],
    confirmation: "pending",
    updatedAt: 1000,
    ...extra,
  };
}

before(() => {
  tempDir = mkdtempSync(join(tmpdir(), "memory-store-"));
});

after(() => {
  for (const s of open) {
    try {
      s.close();
    } catch {
      // already closed
    }
  }
  rmSync(tempDir, { recursive: true, force: true });
});

test("propose stores pending; confirm makes it recallable", async () => {
  const { store, clock } = fresh();
  await store.propose(item("m1", "bigfish", "用户喜欢猫"));
  const pending = await store.list("bigfish", "pending");
  assert.deepEqual(pending, [item("m1", "bigfish", "用户喜欢猫")]);
  assert.deepEqual(await store.recall("bigfish", "猫", 100), []);

  clock.t = 20_000;
  await store.confirm("bigfish", "m1");
  const recalled = await store.recall("bigfish", "猫", 100);
  assert.deepEqual(recalled, [item("m1", "bigfish", "用户喜欢猫", { confirmation: "confirmed", updatedAt: 20_000 })]);
  assert.equal("audioRef" in recalled[0], false);
  assert.deepEqual(await store.list("bigfish", "pending"), []);

  // Confirming again changes nothing.
  clock.t = 30_000;
  await store.confirm("bigfish", "m1");
  assert.equal((await store.list("bigfish"))[0].updatedAt, 20_000);
});

test("propose forces pending even when the item claims confirmed", async () => {
  const { store } = fresh();
  await store.propose(item("m1", "bigfish", "用户叫小鱼", { confirmation: "confirmed", audioRef: "a.wav" }));
  const [stored] = await store.list("bigfish");
  assert.equal(stored.confirmation, "pending");
  assert.equal(stored.audioRef, "a.wav");
  assert.deepEqual(await store.recall("bigfish", "小鱼", 100), []);
});

test("pending items are never recalled", async () => {
  const { store } = fresh();
  await store.propose(item("p1", "bigfish", "用户害怕打雷"));
  await store.propose(item("p2", "bigfish", "用户住在杭州"));
  await store.confirm("bigfish", "p2");
  const recalled = await store.recall("bigfish", "打雷 杭州", 1000);
  assert.deepEqual(recalled.map((m) => m.id), ["p2"]);
});

test("persona isolation: same ids and texts never cross personas (step-4 acceptance)", async () => {
  const { store } = fresh();
  await store.propose(item("a1", "bigfish", "用户喜欢猫"));
  await store.propose(item("b1", "other", "用户喜欢猫"));
  await store.propose(item("b2", "other", "other secret"));
  await store.confirm("other", "b1");
  await store.confirm("other", "b2");

  // Same id under another persona is rejected, not merged or overwritten.
  await assert.rejects(store.propose(item("a1", "other", "hijack")), /another persona/);
  // Same text under another persona is not deduped away.
  assert.deepEqual((await store.list("bigfish")).map((m) => m.id), ["a1"]);

  // recall / list only see the caller's persona.
  assert.deepEqual(await store.recall("bigfish", "猫 other secret", 1000), []);
  assert.deepEqual((await store.recall("other", "猫", 1000)).map((m) => m.id).sort(), ["b1", "b2"]);
  assert.ok((await store.list("bigfish")).every((m) => m.personaId === "bigfish"));
  assert.ok((await store.list("other")).every((m) => m.personaId === "other"));

  // confirm / update / remove on another persona's id are "not found" and change nothing.
  await assert.rejects(store.confirm("bigfish", "b1"), MemoryNotFoundError);
  await assert.rejects(store.update("bigfish", "b2", "changed"), MemoryNotFoundError);
  await assert.rejects(store.remove("bigfish", "b2"), MemoryNotFoundError);
  await assert.rejects(store.confirm("other", "a1"), MemoryNotFoundError);
  await assert.rejects(store.update("other", "a1", "changed"), MemoryNotFoundError);
  await assert.rejects(store.remove("other", "a1"), MemoryNotFoundError);

  const other = await store.list("other");
  assert.deepEqual(other.map((m) => [m.id, m.text, m.confirmation]).sort(), [
    ["b1", "用户喜欢猫", "confirmed"],
    ["b2", "other secret", "confirmed"],
  ]);
  const bigfish = await store.list("bigfish");
  assert.deepEqual(bigfish.map((m) => [m.id, m.text, m.confirmation]), [["a1", "用户喜欢猫", "pending"]]);
});

test("update trims, keeps confirmation state and bumps updatedAt", async () => {
  const { store, clock } = fresh();
  await store.propose(item("p", "bigfish", "用户喜欢狗"));
  await store.propose(item("c", "bigfish", "用户叫小鱼"));
  await store.confirm("bigfish", "c");

  clock.t = 50_000;
  await store.update("bigfish", "p", "  用户喜欢柴犬  ");
  await store.update("bigfish", "c", "用户叫大肥鱼");
  const byId = new Map((await store.list("bigfish")).map((m) => [m.id, m]));
  assert.equal(byId.get("p")?.text, "用户喜欢柴犬");
  assert.equal(byId.get("p")?.confirmation, "pending");
  assert.equal(byId.get("p")?.updatedAt, 50_000);
  assert.equal(byId.get("c")?.text, "用户叫大肥鱼");
  assert.equal(byId.get("c")?.confirmation, "confirmed");
  assert.equal(byId.get("c")?.updatedAt, 50_000);

  await assert.rejects(store.update("bigfish", "p", "   "), /empty/);
  await assert.rejects(store.update("bigfish", "p", "x".repeat(501)), /500/);
  assert.equal((await store.list("bigfish", "pending"))[0].text, "用户喜欢柴犬");
});

test("remove deletes; missing ids throw MemoryNotFoundError", async () => {
  const { store } = fresh();
  await store.propose(item("r1", "bigfish", "用户住在杭州"));
  await store.remove("bigfish", "r1");
  assert.deepEqual(await store.list("bigfish"), []);

  const err = await store.remove("bigfish", "r1").catch((e: unknown) => e);
  assert.ok(err instanceof MemoryNotFoundError);
  assert.equal(err.name, "MemoryNotFoundError");
  await assert.rejects(store.confirm("bigfish", "nope"), MemoryNotFoundError);
  await assert.rejects(store.update("bigfish", "nope", "x"), MemoryNotFoundError);
});

test("propose validation", async () => {
  const { store } = fresh();
  await assert.rejects(store.propose(item("v1", "", "x")), /personaId/);
  await assert.rejects(store.propose(item("v2", "bigfish", "   ")), /empty/);
  await assert.rejects(store.propose(item("v3", "bigfish", "x".repeat(501))), /500/);
  await assert.rejects(store.propose(item("v4", "bigfish", "x", { kind: "rumor" as "fact" })), /kind/);
  await assert.rejects(store.propose(item("v5", "bigfish", "x", { updatedAt: 1.5 })), /updatedAt/);
  await store.propose(item("v6", "bigfish", "x".repeat(500)));
  assert.deepEqual((await store.list("bigfish")).map((m) => m.id), ["v6"]);
});

test("dedupe: same id is a no-op, same normalized text is skipped", async () => {
  const { store } = fresh();
  let events = 0;
  store.subscribe(() => events++);
  await store.propose(item("d1", "bigfish", "用户 喜欢  猫"));
  await store.propose(item("d1", "bigfish", "different text"));
  await store.confirm("bigfish", "d1");
  await store.propose(item("d2", "bigfish", "  用户 喜欢 猫 "));
  await store.propose(item("d3", "bigfish", "用户\t喜欢\n猫"));
  const all = await store.list("bigfish");
  assert.deepEqual(all.map((m) => [m.id, m.text]), [["d1", "用户 喜欢  猫"]]);
  assert.equal(events, 2); // first propose + confirm only
});

test("recall ranks keyword matches ahead of recency and uses recency for ties", async () => {
  const { store, clock } = fresh();
  await store.propose(item("best", "bigfish", "用户喜欢蓝色猫咪"));
  await store.confirm("bigfish", "best");
  clock.t++;
  await store.propose(item("older-match", "bigfish", "用户喜欢蓝色"));
  await store.confirm("bigfish", "older-match");
  clock.t++;
  await store.propose(item("newer-match", "bigfish", "用户有蓝色帽子"));
  await store.confirm("bigfish", "newer-match");
  clock.t++;
  await store.propose(item("newest", "bigfish", "用户喜欢喝茶"));
  await store.confirm("bigfish", "newest");

  assert.deepEqual((await store.recall("bigfish", "蓝色 猫咪", 100)).map((m) => m.id), [
    "best", "newer-match", "older-match", "newest",
  ]);
  assert.deepEqual((await store.recall("bigfish", "", 100)).map((m) => m.id), [
    "newest", "newer-match", "older-match", "best",
  ]);
});

test("recall matches Latin words without case sensitivity and handles equal timestamps", async () => {
  const { store } = fresh();
  for (const [id, text] of [["first", "Enjoys TypeScript"], ["second", "Writes typescript"], ["third", "Likes tea"]]) {
    await store.propose(item(id, "bigfish", text));
    await store.confirm("bigfish", id);
  }
  assert.deepEqual((await store.recall("bigfish", "TYPESCRIPT", 100)).map((m) => m.id), [
    "second", "first", "third",
  ]);
});

test("recall respects the whole-item budget and still considers smaller candidates", async () => {
  const { store } = fresh();
  await store.propose(item("small", "bigfish", "茶"));
  await store.propose(item("large", "bigfish", "用户喜欢喝茶和阅读长篇小说"));
  await store.confirm("bigfish", "small");
  await store.confirm("bigfish", "large");
  // The larger item wins by keyword overlap but cannot consume a partial budget.
  assert.deepEqual((await store.recall("bigfish", "阅读 长篇 小说", 5)).map((m) => m.id), ["small"]);
  assert.deepEqual(await store.recall("bigfish", "茶", 4), []);
  const totalCost = estimateTokens("茶") + estimateTokens("用户喜欢喝茶和阅读长篇小说") + 8;
  assert.equal((await store.recall("bigfish", "阅读", totalCost)).length, 2);
  assert.equal((await store.recall("bigfish", "阅读", totalCost - 1)).length, 1);

  for (const budget of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.deepEqual(await store.recall("bigfish", "茶", budget), []);
  }
});

test("token estimates count CJK characters and Unicode code points conservatively", () => {
  assert.equal(estimateTokens(""), 0);
  assert.equal(estimateTokens("猫咪"), 2);
  assert.equal(estimateTokens("abcd"), 1);
  assert.equal(estimateTokens("abcde"), 2);
  assert.equal(estimateTokens("猫abcd"), 2);
  assert.equal(estimateTokens("😀😀😀😀"), 1);
  assert.equal(estimateTokens("かな한글"), 4);
});

test("restart restores pending and confirmed memories, edits, deletions and provenance", async () => {
  const { store, path, clock } = fresh();
  const pending = item("pending", "bigfish", "用户喜欢猫", { sourceMessageIds: ["u1", "u2"], audioRef: "voice.wav" });
  await store.propose(pending);
  await store.propose(item("confirmed", "bigfish", "用户叫小鱼"));
  await store.propose(item("removed", "bigfish", "旧记忆"));
  await store.propose(item("other", "other", "另一个角色的记忆"));
  await store.confirm("bigfish", "confirmed");
  clock.t = 25_000;
  await store.update("bigfish", "confirmed", "用户叫大肥鱼");
  await store.remove("bigfish", "removed");
  store.close();

  const restored = new SqliteMemoryStore(path);
  open.push(restored);
  assert.deepEqual(await restored.list("bigfish", "pending"), [pending]);
  assert.deepEqual(await restored.recall("bigfish", "", 100), [
    item("confirmed", "bigfish", "用户叫大肥鱼", { confirmation: "confirmed", updatedAt: 25_000 }),
  ]);
  assert.deepEqual((await restored.list("other")).map((m) => m.id), ["other"]);
  assert.deepEqual((await restored.list("bigfish")).map((m) => m.id), ["confirmed", "pending"]);
});

test("forPersona confines user confirmation, editing and deletion to its own memories", async () => {
  const { store } = fresh();
  const fish = store.forPersona("bigfish");
  const other = store.forPersona("other");
  await store.propose(item("fish", "bigfish", "用户喜欢猫"));
  await store.propose(item("other", "other", "用户喜欢猫"));

  await fish.update("fish", "用户喜欢橘猫");
  await fish.confirm("fish");
  assert.deepEqual((await fish.list()).map((m) => [m.id, m.text, m.confirmation]), [
    ["fish", "用户喜欢橘猫", "confirmed"],
  ]);
  assert.deepEqual((await other.list()).map((m) => [m.id, m.text, m.confirmation]), [
    ["other", "用户喜欢猫", "pending"],
  ]);
  await assert.rejects(fish.confirm("other"), MemoryNotFoundError);
  await assert.rejects(fish.update("other", "不应写入"), MemoryNotFoundError);
  await assert.rejects(fish.remove("other"), MemoryNotFoundError);
  await fish.remove("fish");
  assert.deepEqual(await fish.list(), []);
  assert.deepEqual((await other.list()).map((m) => m.id), ["other"]);
});

test("subscriptions report only successful mutations and persona views isolate notifications", async () => {
  const { store } = fresh();
  const globalEvents: string[] = [];
  let fishEvents = 0;
  let otherEvents = 0;
  store.subscribe(() => { throw new Error("broken UI listener"); });
  const stopGlobal = store.subscribe((personaId) => globalEvents.push(personaId));
  const stopFish = store.forPersona("bigfish").subscribe(() => fishEvents++);
  store.forPersona("other").subscribe(() => otherEvents++);
  assert.equal(fishEvents, 0);

  await store.propose(item("fish", "bigfish", "用户喜欢猫"));
  await store.propose(item("other", "other", "用户喜欢猫"));
  assert.deepEqual(globalEvents, ["bigfish", "other"]);
  assert.equal(fishEvents, 1);
  assert.equal(otherEvents, 1);
  await store.confirm("bigfish", "fish");
  await store.confirm("bigfish", "fish"); // no state change
  await store.propose(item("duplicate", "bigfish", "用户喜欢猫"));
  await assert.rejects(store.remove("bigfish", "other"), MemoryNotFoundError);
  await assert.rejects(store.update("bigfish", "fish", " "), /empty/);
  await store.update("bigfish", "fish", "用户喜欢橘猫");
  await store.remove("bigfish", "fish");
  assert.equal(fishEvents, 4);
  assert.equal(otherEvents, 1);
  assert.deepEqual(globalEvents, ["bigfish", "other", "bigfish", "bigfish", "bigfish"]);

  stopGlobal();
  stopFish();
  stopFish(); // Unsubscription is safe to repeat.
  await store.propose(item("later", "bigfish", "用户喜欢狗"));
  await store.confirm("other", "other");
  assert.equal(fishEvents, 4);
  assert.equal(otherEvents, 2);
  assert.equal(globalEvents.length, 5);
});
