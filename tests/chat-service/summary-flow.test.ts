import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { openMainChat, parseMainChatConfig } from "../../packages/chat-service/src/config.ts";
import { MainChatService } from "../../packages/chat-service/src/service.ts";
import { MemorySecretStore, buildSystemPrompt } from "../../packages/chat-api/src/index.ts";
import { SqliteConversationStore } from "../../packages/conversation-store/src/index.ts";
import { PetOverlay } from "../../packages/app-coordinator/src/pet-overlay.ts";
import { parseOverlayCommand } from "../../packages/app-coordinator/src/overlay-protocol.ts";
import type { ChatStreamInput, ChatEvent } from "../../packages/app-contracts/src/chat.ts";
import type { ConversationSummary, SummaryProvider } from "../../packages/app-contracts/src/summary.ts";

const persona = { id: "bigfish", name: "大肥鱼", prompt: "你是大肥鱼。", memoryNamespace: "bigfish" };
const summary = (id: string, extra = {}): ConversationSummary => ({ id, personaId: "bigfish", conversationId: "chat", method: "extractive-v1", text: "未确认的原话摘录", sourceMessageIds: ["old-message"], updatedAt: 1, ...extra });

test("dispatcher -> summaries -> actual HTTP prompt -> sources/delete -> restart retains isolation and raw records", async () => {
  const dir = mkdtempSync(join(tmpdir(), "summary-flow-"));
  const personasDir = join(dir, "personas"), dataDir = join(dir, "data"); mkdirSync(personasDir); mkdirSync(dataDir);
  writeFileSync(join(personasDir, "bigfish.json"), JSON.stringify({ ...persona, persona: persona.prompt, boundaries: [] }));
  const archive = new SqliteConversationStore(join(dataDir, "conversations.sqlite"));
  for (let i = 0; i < 40; i++) await archive.append({ id: `old-${i}`, personaId: "bigfish", conversationId: "chat", role: i % 2 ? "assistant" : "user",
    text: i === 0 ? "旧聊天片段：雪山路线仍未确认？" : i === 21 ? "边界角色答复：渡船仍需预约。" : i % 2 ? `角色建议 ${i}，不是用户事实。` : `历史问题 ${i}？`, createdAt: i });
  await archive.append({ id: "foreign", personaId: "other", conversationId: "chat", role: "user", text: "另一个角色的私密经历", createdAt: 99 });
  archive.close();
  const requests: Array<{ messages: Array<{ role: string; content: string }> }> = [];
  const server = createServer((req, res) => {
    let raw = ""; req.on("data", (part) => raw += part); req.on("end", () => {
      requests.push(JSON.parse(raw)); res.writeHead(200, { "content-type": "text/event-stream" });
      res.end('data: {"choices":[{"delta":{"content":"摘要只是历史参考。"}}]}\n\ndata: [DONE]\n\n');
    });
  });
  await new Promise<void>((yes) => server.listen(0, "127.0.0.1", yes));
  const options = { personasDir, dataDir, secretStore: new MemorySecretStore("synthetic-local-only"),
    settings: parseMainChatConfig({ baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, model: "test" }) };
  let opened: ReturnType<typeof openMainChat> | undefined, overlay: PetOverlay | undefined;
  const command = async (raw: unknown) => { const parsed = parseOverlayCommand(raw); assert.ok(parsed); await overlay!.handleCommand(parsed); };
  try {
    opened = openMainChat(options); overlay = new PetOverlay({ chat: opened.service, memory: opened.memory, summaries: opened.summaries });
    await command({ type: "submit", text: "请看看更早的路线话题。" });
    await command({ type: "show-memories" });
    const system = requests[0].messages[0].content;
    assert.match(system, /自动原话摘录，未经用户确认/); assert.match(system, /雪山路线/); assert.match(system, /sourceMessageIds/);
    assert.doesNotMatch(system, /用户确认过的记忆|另一个角色的私密经历/);
    assert.ok(!requests[0].messages.slice(1).some((m) => m.content.includes("雪山路线")), "source is outside recent history");
    assert.match(system, /边界角色答复：渡船仍需预约/);
    assert.equal(requests[0].messages[1].role, "user");
    assert.ok(!requests[0].messages.slice(1).some((m) => m.content.includes("边界角色答复")), "trimmed assistant prefix is covered by summaries");
    const items = overlay.snapshot().summaries!.items;
    assert.equal(items.length, 3); assert.deepEqual(overlay.snapshot().memory!.confirmed, []);
    const oldest = items.at(-1)!;
    await command({ type: "summary-sources", id: oldest.id });
    assert.equal(overlay.snapshot().summaries!.source!.messages[0].id, "old-0");
    assert.equal(overlay.snapshot().summaries!.source!.messages[0].text, "旧聊天片段：雪山路线仍未确认？");
    await command({ type: "summary-sources", id: "foreign-summary" });
    assert.equal(overlay.snapshot().summaries!.error, "原始消息读取失败，请稍后重试");
    for (const item of items) await command({ type: "summary-remove", id: item.id });
    assert.deepEqual(overlay.snapshot().summaries!.items, []); assert.equal(overlay.snapshot().summaries!.source, null);
    await command({ type: "submit", text: "再检查旧话题。" });
    assert.doesNotMatch(requests.at(-1)!.messages[0].content, /雪山路线|另一个角色/);
    overlay.dispose(); opened.close();
    opened = openMainChat(options); overlay = new PetOverlay({ chat: opened.service, memory: opened.memory, summaries: opened.summaries });
    await command({ type: "submit", text: "重启之后继续。" });
    assert.doesNotMatch(requests.at(-1)!.messages[0].content, /雪山路线|另一个角色/);
    assert.equal(opened.service.conversationId, "chat");
    const raw = new SqliteConversationStore(join(dataDir, "conversations.sqlite"));
    try { assert.equal((await raw.byIds("bigfish", "chat", ["old-0"]))[0].text, "旧聊天片段：雪山路线仍未确认？"); } finally { raw.close(); }
  } finally { overlay?.dispose(); opened?.close(); server.closeAllConnections(); await new Promise<void>((yes) => server.close(() => yes())); rmSync(dir, { recursive: true, force: true }); }
});

test("prompt separates automatic summaries from facts and excludes other personas and conversations", () => {
  const prompt = buildSystemPrompt(persona, [{ id: "fact", personaId: "bigfish", kind: "preference", text: "已确认喜欢茉莉茶", sourceMessageIds: [], updatedAt: 1, confirmation: "confirmed" }],
    [summary("own"), summary("other", { personaId: "other", text: "foreign secret" }), summary("conversation", { conversationId: "other", text: "other chat" })], "chat");
  const [confirmed, derived] = prompt.split("历史对话摘要");
  assert.match(confirmed, /已确认喜欢茉莉茶/); assert.doesNotMatch(confirmed, /未确认的原话摘录/);
  assert.match(derived, /未经用户确认|自动原话摘录/); assert.match(derived, /未确认的原话摘录/);
  assert.doesNotMatch(prompt, /foreign secret|other chat/);
});

test("summary timeouts and errors are best effort, while cancellation discards late context", async () => {
  for (const mode of ["timeout", "error", "cancel", "scope"] as const) {
    const archive = new SqliteConversationStore(":memory:"); const inputs: ChatStreamInput[] = [], warnings: string[] = [];
    let release!: (value: ConversationSummary[]) => void; let began!: () => void;
    const started = new Promise<void>((yes) => { began = yes; });
    const pending = new Promise<ConversationSummary[]>((yes) => { release = yes; });
    let capturedSignal: AbortSignal | undefined;
    const summaries: SummaryProvider = { context: async (input) => {
      capturedSignal = input.signal; began();
      if (mode === "error") throw new Error("private conversation and key");
      if (mode === "scope") return [summary("foreign", { personaId: "other" }), summary("wrong-chat", { conversationId: "other" }), summary("oversized", { text: "x".repeat(6000) }), summary("own")];
      return pending;
    } };
    const service = new MainChatService({ persona, conversations: archive, conversationId: "chat", summaries, summaryTimeoutMs: 15, summaryBudgetChars: 600,
      provider: { stream: async function* (input): AsyncIterable<ChatEvent> { inputs.push(input); yield { type: "delta", text: "ok" }; yield { type: "complete", messageId: "reply" }; } }, warn: (m) => warnings.push(m) });
    try {
      const sending = service.send("new input"); await started;
      if (mode === "cancel") service.cancel();
      const result = await sending;
      if (mode === "cancel") { assert.equal(result.status, "cancelled"); assert.equal(inputs.length, 0); }
      else { assert.equal(result.status, "completed"); assert.deepEqual(inputs[0].summaries?.map((s) => s.id), mode === "scope" ? ["own"] : []); }
      if (mode === "timeout") assert.equal(capturedSignal?.aborted, true);
      assert.ok(!warnings.join(" ").includes("private conversation"));
      service.dispose(); release([summary("late")]); await new Promise<void>((yes) => setImmediate(yes));
      assert.equal(inputs.length, mode === "cancel" ? 0 : 1);
    } finally { service.dispose(); archive.close(); }
  }
});
