// Framework v1 step 2: config parsing and openMainChat end-to-end with a local mock OpenAI-compatible server.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { MemorySecretStore } from "../../packages/chat-api/src/index.ts";
import { openMainChat, parseMainChatConfig } from "../../packages/chat-service/src/index.ts";
import type { MainChatState } from "../../packages/app-contracts/src/chat.ts";

test("parseMainChatConfig: defaults and type errors", () => {
  const defaults = parseMainChatConfig({});
  assert.equal(defaults.personaId, "bigfish");
  assert.equal(defaults.protocol, "openai-compatible");
  assert.equal(defaults.requestTimeoutMs, 60_000);
  assert.equal(defaults.maxOutputTokens, 1024);
  assert.equal(defaults.baseUrl, "");
  assert.equal(defaults.model, "");

  const explicit = parseMainChatConfig({
    personaId: "other",
    protocol: "anthropic",
    baseUrl: " https://api.example.com/ ",
    model: " gpt-4 ",
    requestTimeoutMs: 15_000,
    maxOutputTokens: 2048,
  });
  assert.equal(explicit.personaId, "other");
  assert.equal(explicit.protocol, "anthropic");
  assert.equal(explicit.baseUrl, "https://api.example.com/");
  assert.equal(explicit.model, "gpt-4");
  assert.equal(explicit.requestTimeoutMs, 15_000);
  assert.equal(explicit.maxOutputTokens, 2048);

  assert.throws(() => parseMainChatConfig("string"), /mainChat must be an object/);
  assert.throws(() => parseMainChatConfig({ protocol: "unknown" }), /protocol/);
  assert.throws(() => parseMainChatConfig({ personaId: 123 }), /personaId must be a string/);
  assert.throws(() => parseMainChatConfig({ requestTimeoutMs: "1000" }), /requestTimeoutMs must be an integer/);
  assert.throws(() => parseMainChatConfig({ requestTimeoutMs: 500 }), /requestTimeoutMs must be between 1000/);
  assert.throws(() => parseMainChatConfig({ maxOutputTokens: 50_000 }), /maxOutputTokens must be between/);
});

// Minimal OpenAI-compatible SSE mock.
type Handler = (req: IncomingMessage, body: string, res: ServerResponse) => void;
let handler: Handler = (_req, _body, res) => res.end();
const server = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => handler(req, body, res));
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
after(() => {
  server.closeAllConnections();
  server.close();
});

function tempPersonas(personaJson: unknown): { dir: string; personasDir: string; dataDir: string } {
  const dir = mkdtempSync(join(tmpdir(), "chat-service-config-"));
  const personasDir = join(dir, "personas");
  mkdirSync(personasDir);
  writeFileSync(join(personasDir, "bigfish.json"), JSON.stringify(personaJson), "utf8");
  return { dir, personasDir, dataDir: join(dir, "data") };
}

const BIGFISH = {
  id: "bigfish",
  name: "大肥鱼",
  persona: "你是大肥鱼。",
  boundaries: ["不编造事实"],
  memoryNamespace: "bigfish",
};

function sseReply(res: ServerResponse, parts: string[]) {
  res.writeHead(200, { "content-type": "text/event-stream" });
  for (const p of parts) res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: p } }] })}\n\n`);
  res.write("data: [DONE]\n\n");
  res.end();
}

test("openMainChat end-to-end: reply streams, restart continues conversation and provider sees history", async () => {
  const { dir, personasDir, dataDir } = tempPersonas(BIGFISH);
  const reqs: Array<{ url: string; headers: IncomingMessage["headers"]; body: any }> = [];
  let replies = [["你", "好呀"], ["回"]];
  handler = (req, body, res) => {
    reqs.push({ url: req.url ?? "", headers: req.headers, body: JSON.parse(body) });
    sseReply(res, replies.shift() ?? []);
  };
  const secretStore = new MemorySecretStore("sk-test-key-999");
  const settings = parseMainChatConfig({
    provider: "chat-api",
    apiKeyStorage: "system-keychain",
    stream: true,
    personaId: "bigfish",
    baseUrl: `${baseUrl}/v1`,
    model: "test-model",
    requestTimeoutMs: 2000,
    maxOutputTokens: 256,
  });
  let opened: ReturnType<typeof openMainChat> | null = null;
  try {
    opened = openMainChat({ settings, personasDir, dataDir, secretStore });
    const firstId = opened.service.conversationId;
    assert.match(firstId, /^main-[0-9a-f-]{36}$/);
    const states: MainChatState[] = [];
    const unsubscribe = opened.service.subscribe((s) => states.push(s));
    const result = await opened.service.send("第一句");
    unsubscribe();
    assert.deepEqual(result.status === "completed" && result.text, "你好呀");
    assert.deepEqual(
      states.map((s) => [s.phase, s.reply]),
      [
        ["idle", undefined],
        ["connecting", ""],
        ["replying", "你"],
        ["replying", "你好呀"],
        ["idle", "你好呀"],
      ],
    );
    opened.close();
    opened.close(); // idempotent

    // Restart against the same dataDir.
    opened = openMainChat({ settings, personasDir, dataDir, secretStore });
    assert.equal(opened.service.conversationId, firstId, "same conversation id after restart");
    const result2 = await opened.service.send("第二句");
    assert.equal(result2.status === "completed" && result2.text, "回");

    assert.equal(reqs.length, 2);
    assert.equal(reqs[1].url, "/v1/chat/completions");
    assert.equal(reqs[1].headers.authorization, "Bearer sk-test-key-999");
    const sent = reqs[1].body;
    assert.equal(sent.model, "test-model");
    assert.equal(sent.max_tokens, 256);
    assert.equal(sent.messages[0].role, "system");
    assert.match(sent.messages[0].content, /你是大肥鱼/);
    assert.match(sent.messages[0].content, /不编造事实/);
    assert.deepEqual(sent.messages.slice(1), [
      { role: "user", content: "第一句" },
      { role: "assistant", content: "你好呀" },
      { role: "user", content: "第二句" },
    ]);
  } finally {
    opened?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("openMainChat: an unconfigured app starts and reports not_configured at send time", async () => {
  const { dir, personasDir, dataDir } = tempPersonas(BIGFISH);
  const opened = openMainChat({ settings: parseMainChatConfig({}), personasDir, dataDir, secretStore: new MemorySecretStore() });
  try {
    const result = await opened.service.send("在吗");
    assert.deepEqual(result, { status: "error", code: "not_configured", message: "聊天 API 还没配置好（地址、模型或密钥）" });
    assert.equal(opened.service.state().phase, "error");
  } finally {
    opened.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("openMainChat validates the persona file before the first turn", () => {
  const { dir, personasDir, dataDir } = tempPersonas({ id: "bigfish", name: "缺 persona 字段" });
  try {
    assert.throws(
      () => openMainChat({ settings: parseMainChatConfig({}), personasDir, dataDir, secretStore: new MemorySecretStore() }),
      /persona/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
