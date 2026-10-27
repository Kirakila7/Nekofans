// Framework v1 acceptance through the actual dispatcher, chat service, HTTP adapter
// and SQLite stores. Only the upstream SSE server is a local test double.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { AddressInfo } from "node:net";
import { MemorySecretStore } from "../../packages/chat-api/src/index.ts";
import { openMainChat, parseMainChatConfig } from "../../packages/chat-service/src/index.ts";
import { PetOverlay } from "../../packages/app-coordinator/src/pet-overlay.ts";
import { parseOverlayCommand } from "../../packages/app-coordinator/src/overlay-protocol.ts";
import { SqliteConversationStore } from "../../packages/conversation-store/src/index.ts";
import { SqliteMemoryStore } from "../../packages/memory-store/src/index.ts";

test("v1: proposal -> confirmation -> edit -> restart -> recall -> delete, without crossing personas or DSH", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bigfish-memory-flow-"));
  const personasDir = join(dir, "personas");
  mkdirSync(personasDir);
  writeFileSync(join(personasDir, "bigfish.json"), JSON.stringify({
    id: "bigfish", name: "大肥鱼", persona: "你是大肥鱼。", boundaries: ["不执行 DSH 任务"], memoryNamespace: "bigfish",
  }));
  const requests: Array<{ messages: Array<{ role: string; content: string }> }> = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => body += chunk);
    req.on("end", () => {
      requests.push(JSON.parse(body));
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: "好，记忆可以在面板确认。" } }] })}\n\ndata: [DONE]\n\n`);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const dataDir = join(dir, "data");
  const options = {
    personasDir, dataDir, secretStore: new MemorySecretStore("test-only-key"),
    settings: parseMainChatConfig({ baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, model: "local-test" }),
  };
  let opened: ReturnType<typeof openMainChat> | undefined;
  let overlay: PetOverlay | undefined;
  const command = async (raw: unknown) => {
    const parsed = parseOverlayCommand(raw);
    assert.ok(parsed);
    await overlay!.handleCommand(parsed);
  };
  try {
    opened = openMainChat(options);
    overlay = new PetOverlay({ chat: opened.service, memory: opened.memory });
    assert.ok(opened.memory);
    await command({ type: "submit", text: "我喜欢乌龙茶" });
    await command({ type: "show-memories" });
    const proposal = overlay.snapshot().memory!.pending[0];
    assert.match(proposal.text, /乌龙茶/);
    assert.equal(overlay.snapshot().memory!.confirmed.length, 0);
    assert.deepEqual(overlay.snapshot().tasks, []);

    await command({ type: "submit", text: "我喝什么茶" });
    assert.doesNotMatch(requests.at(-1)!.messages[0].content, /乌龙茶/, "pending proposals cannot become system facts");
    await command({ type: "memory-confirm", id: proposal.id });
    await command({ type: "memory-update", id: proposal.id, text: "用户喜欢茉莉花茶" });
    await command({ type: "submit", text: "我的茶偏好是什么" });
    assert.match(requests.at(-1)!.messages[0].content, /用户喜欢茉莉花茶/);
    assert.doesNotMatch(requests.at(-1)!.messages[0].content, /乌龙茶/);

    const conversationId = opened.service.conversationId;
    overlay.dispose();
    opened.close();
    // Another persona in the same SQLite file still has no effect on bigfish.
    const memories = new SqliteMemoryStore(join(dataDir, "memories.sqlite"));
    try {
      await memories.propose({ id: "other-memory", personaId: "other", kind: "fact", text: "隔壁角色专属秘密", sourceMessageIds: [], confirmation: "pending", updatedAt: Date.now() });
      await memories.confirm("other", "other-memory");
      const own = await memories.list("bigfish");
      assert.equal(own[0].sourceMessageIds.length, 1, "source evidence is retained after editing");
    } finally { memories.close(); }

    opened = openMainChat(options);
    overlay = new PetOverlay({ chat: opened.service, memory: opened.memory });
    assert.equal(opened.service.conversationId, conversationId);
    await command({ type: "show-memories" });
    assert.equal(overlay.snapshot().memory!.confirmed[0].text, "用户喜欢茉莉花茶");
    await command({ type: "memory-remove", id: "other-memory" });
    assert.ok(overlay.snapshot().memory!.error);
    await command({ type: "submit", text: "还记得我的偏好吗" });
    assert.match(requests.at(-1)!.messages[0].content, /茉莉花茶/);
    assert.doesNotMatch(requests.at(-1)!.messages[0].content, /隔壁角色/);

    await command({ type: "memory-remove", id: proposal.id });
    assert.equal(overlay.snapshot().memory!.error, null);
    assert.deepEqual(overlay.snapshot().memory!.confirmed, []);
    await command({ type: "submit", text: "再检查一下" });
    assert.doesNotMatch(requests.at(-1)!.messages[0].content, /茉莉花茶|隔壁角色/);
    // Deleting a memory does not silently delete the original conversation.
    const conversations = new SqliteConversationStore(join(dataDir, "conversations.sqlite"));
    try {
      const history = await conversations.recent("bigfish", conversationId, 100);
      assert.equal(history[0].text, "我喜欢乌龙茶");
      assert.equal(history.length, 10);
    } finally { conversations.close(); }
  } finally {
    overlay?.dispose();
    opened?.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
});
