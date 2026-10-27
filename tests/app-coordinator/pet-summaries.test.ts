import { test } from "node:test";
import assert from "node:assert/strict";
import { SummaryPanel } from "../../packages/app-coordinator/src/summary-panel.ts";
import type { ConversationSummary, PersonaSummaries } from "../../packages/app-contracts/src/summary.ts";
import type { ChatMessage } from "../../packages/app-contracts/src/chat.ts";

const flush = () => new Promise<void>((yes) => setImmediate(yes));
const item = (id: string): ConversationSummary => ({ id, personaId: "p", conversationId: "c", method: "extractive-v1", text: id, sourceMessageIds: ["m"], updatedAt: 1 });
function deferred<T>() { let resolve!: (v: T) => void, reject!: (e: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }

test("only the newest summary refresh is published, and disposal ignores pending source reads", async () => {
  const reads: ReturnType<typeof deferred<ConversationSummary[]>>[] = [], sources = deferred<ChatMessage[]>();
  let unsubscribed = false, changes = 0;
  const port: PersonaSummaries = { list: () => { const read = deferred<ConversationSummary[]>(); reads.push(read); return read.promise; },
    sources: () => sources.promise, remove: async () => {}, subscribe: () => () => { unsubscribed = true; } };
  const panel = new SummaryPanel(port, () => changes++);
  const second = panel.refresh(); reads[1].resolve([item("new")]); await second;
  reads[0].resolve([item("old")]); await flush(); assert.deepEqual(panel.view.items.map((s) => s.id), ["new"]);
  const sourceRead = panel.handle({ type: "summary-sources", id: "new" });
  panel.dispose(); const before = changes;
  sources.resolve([{ id: "m", personaId: "p", conversationId: "c", role: "user", text: "late", createdAt: 1 }]); await sourceRead;
  assert.equal(changes, before); assert.equal(panel.view.source, null); assert.equal(unsubscribed, true);
});

test("deleting a summary invalidates a source request that resolves later", async () => {
  let items = [item("one")]; const sources = deferred<ChatMessage[]>();
  const listeners = new Set<() => void>();
  const panel = new SummaryPanel({ list: async () => items, sources: () => sources.promise,
    remove: async () => { items = []; for (const listener of listeners) listener(); },
    subscribe: (fn) => { listeners.add(fn); return () => { listeners.delete(fn); }; } }, () => {});
  await flush();
  const reading = panel.handle({ type: "summary-sources", id: "one" });
  await panel.handle({ type: "summary-remove", id: "one" });
  sources.resolve([{ id: "m", personaId: "p", conversationId: "c", role: "user", text: "deleted context", createdAt: 1 }]); await reading;
  assert.deepEqual(panel.view.items, []); assert.equal(panel.view.source, null);
  panel.dispose(); assert.equal(listeners.size, 0);
});

test("source errors remain fixed through background refreshes, recover, and source previews are bounded", async () => {
  let fail = true;
  const panel = new SummaryPanel({ list: async () => [item("one")], sources: async () => {
    if (fail) throw new Error("private source and api key");
    return [{ id: "m", personaId: "p", conversationId: "c", role: "assistant", text: "x".repeat(6000), createdAt: 1 }];
  }, remove: async () => {}, subscribe: () => () => {} }, () => {});
  await flush(); await panel.handle({ type: "summary-sources", id: "one" });
  assert.equal(panel.view.error, "原始消息读取失败，请稍后重试");
  await panel.refresh(); assert.equal(panel.view.error, "原始消息读取失败，请稍后重试");
  fail = false; await panel.handle({ type: "summary-sources", id: "one" });
  assert.equal(panel.view.error, null); assert.equal(panel.view.source!.messages[0].text.length, 4000); assert.equal(panel.view.source!.messages[0].truncated, true);
  panel.dispose();
});
