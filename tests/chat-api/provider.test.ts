// Framework v1 step 2: ChatApiAdapter against a local mock endpoint (both protocols).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import {
  ChatApiError,
  buildSystemPrompt,
  createChatApiProvider,
  endpointUrl,
  toWireMessages,
  validateConfig,
  type ChatApiConfig,
} from "../../packages/chat-api/src/index.ts";
import type { ChatEvent, ChatMessage, MemoryItem, Persona } from "../../packages/app-contracts/src/index.ts";
import { MainChatService } from "../../packages/chat-service/src/index.ts";

const KEY = "sk-secret-value-123";
const persona: Persona = { id: "bigfish", name: "大肥鱼", prompt: "你是大肥鱼。", memoryNamespace: "bigfish" };

type Handler = (req: IncomingMessage, body: string, res: ServerResponse) => void;
let handler: Handler = (_req, _body, res) => res.end();
const seen: Array<{ url: string; headers: IncomingMessage["headers"]; body: any }> = [];

const server = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    seen.push({ url: req.url ?? "", headers: req.headers, body: body ? JSON.parse(body) : null });
    handler(req, body, res);
  });
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
after(() => {
  server.closeAllConnections();
  server.close();
});

function sse(res: ServerResponse, events: string[], opts: { end?: boolean } = {}) {
  res.writeHead(200, { "content-type": "text/event-stream" });
  for (const e of events) res.write(e);
  if (opts.end !== false) res.end();
}

function msg(role: "user" | "assistant", text: string, personaId = "bigfish"): ChatMessage {
  return { id: `${role}-${text}`, personaId, conversationId: "c1", role, text, createdAt: 1 };
}

function cfg(protocol: ChatApiConfig["protocol"], extra: Partial<ChatApiConfig> = {}): ChatApiConfig {
  return { protocol, baseUrl: protocol === "anthropic" ? base : `${base}/v1`, model: "m1", requestTimeoutMs: 2000, ...extra };
}

async function collect(it: AsyncIterable<ChatEvent>): Promise<ChatEvent[]> {
  const out: ChatEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

function provider(config: ChatApiConfig, key: string | null = KEY) {
  return createChatApiProvider({ config, getApiKey: async () => key, newId: () => "reply-1" });
}

function input(extra: { memories?: MemoryItem[]; messages?: ChatMessage[]; signal?: AbortSignal } = {}) {
  return {
    persona,
    messages: extra.messages ?? [msg("user", "你好")],
    memories: extra.memories ?? [],
    maxOutputTokens: 256,
    signal: extra.signal ?? new AbortController().signal,
  };
}

async function rejectsCode(p: Promise<unknown>, code: string) {
  await assert.rejects(p, (e: unknown) => {
    assert.ok(e instanceof ChatApiError, String(e));
    assert.equal(e.code, code);
    assert.ok(!e.message.includes(KEY), "key never in error text");
    return true;
  });
}

test("openai-compatible: streams deltas, then complete; request shape and auth header", async () => {
  seen.length = 0;
  handler = (_q, _b, res) =>
    sse(res, [
      'data: {"choices":[{"index":0,"delta":{"role":"assistant"}}]}\n\n',
      'data: {"choices":[{"index":0,"delta":{"content":"你"}}]}\n\n',
      ': keep-alive\n\n',
      'data: {"choices":[{"index":0,"delta":{"content":"好呀"}}]}\r\n\r\n',
      "data: [DONE]\n\n",
    ]);
  const memories: MemoryItem[] = [
    { id: "m1", personaId: "bigfish", kind: "preference", text: "喜欢 吃鱼", sourceMessageIds: [], confirmation: "confirmed", updatedAt: 1 },
    { id: "m2", personaId: "bigfish", kind: "fact", text: "待确认的事", sourceMessageIds: [], confirmation: "pending", updatedAt: 1 },
    { id: "m3", personaId: "other", kind: "fact", text: "别人的记忆", sourceMessageIds: [], confirmation: "confirmed", updatedAt: 1 },
  ];
  const events = await collect(provider(cfg("openai-compatible")).stream(input({ memories })));
  assert.deepEqual(events, [
    { type: "delta", text: "你" },
    { type: "delta", text: "好呀" },
    { type: "complete", messageId: "reply-1" },
  ]);
  const req = seen[0];
  assert.equal(req.url, "/v1/chat/completions");
  assert.equal(req.headers.authorization, `Bearer ${KEY}`);
  assert.equal(req.body.model, "m1");
  assert.equal(req.body.stream, true);
  assert.equal(req.body.max_tokens, 256);
  assert.equal(req.body.messages[0].role, "system");
  assert.match(req.body.messages[0].content, /你是大肥鱼/);
  assert.match(req.body.messages[0].content, /- 喜欢 吃鱼/);
  assert.doesNotMatch(req.body.messages[0].content, /待确认|别人的记忆/);
  assert.deepEqual(req.body.messages.slice(1), [{ role: "user", content: "你好" }]);
});

test("official DeepSeek chat disables thinking and consumes its normal streamed text", async () => {
  let requestUrl = "";
  let body: any;
  const p = createChatApiProvider({
    config: cfg("openai-compatible", { baseUrl: "https://api.deepseek.com/", model: "deepseek-flash" }),
    getApiKey: async () => KEY,
    newId: () => "deepseek-reply",
    fetch: async (url, init) => {
      requestUrl = String(url);
      body = JSON.parse(String(init?.body));
      return new Response(
        'data: {"choices":[{"index":0,"delta":{"role":"assistant","content":"你好"},"finish_reason":null}]}\n\n'
        + 'data: {"choices":[{"index":0,"delta":{"content":"呀"},"finish_reason":null}]}\n\n'
        + 'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"total_tokens":3}}\n\n'
        + 'data: [DONE]\n\n',
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  });
  assert.deepEqual(await collect(p.stream(input())), [
    { type: "delta", text: "你好" }, { type: "delta", text: "呀" }, { type: "complete", messageId: "deepseek-reply" },
  ]);
  assert.equal(requestUrl, "https://api.deepseek.com/chat/completions");
  assert.equal(body.model, "deepseek-flash");
  assert.deepEqual(body.thinking, { type: "disabled" });
  assert.equal(body.stream, true);
  assert.equal(body.max_tokens, 256);
});

test("DeepSeek-only request option is not sent to proxies, lookalikes or Anthropic protocol", async () => {
  const cases: Array<[ChatApiConfig["protocol"], string]> = [
    ["openai-compatible", "https://api.deepseek.com.evil.invalid"],
    ["openai-compatible", "https://api.deepseek.com:8443"],
    ["openai-compatible", "https://other.example/v1"],
    ["anthropic", "https://api.deepseek.com/anthropic"],
  ];
  for (const [protocol, baseUrl] of cases) {
    let body: any;
    const p = createChatApiProvider({
      config: cfg(protocol, { baseUrl }), getApiKey: async () => KEY,
      fetch: async (_url, init) => {
        body = JSON.parse(String(init?.body));
        return new Response(protocol === "anthropic"
          ? 'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"ok"}}\n\ndata: {"type":"message_stop"}\n\n'
          : 'data: {"choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\n',
        { headers: { "content-type": "text/event-stream" } });
      },
    });
    await collect(p.stream(input()));
    assert.equal(Object.hasOwn(body, "thinking"), false, `${protocol}: ${baseUrl}`);
  }
});

test("only official DeepSeek maps HTTP 402 to insufficient balance without leaking upstream error", async () => {
  for (const [baseUrl, expected] of [
    ["https://api.deepseek.com", "insufficient_balance"],
    ["https://api.deepseek.com.evil.invalid", "http"],
    ["https://other.example/v1", "http"],
  ] as const) {
    const p = createChatApiProvider({
      config: cfg("openai-compatible", { baseUrl }), getApiKey: async () => KEY,
      fetch: async () => new Response(JSON.stringify({ error: KEY }), { status: 402 }),
    });
    await rejectsCode(collect(p.stream(input())), expected);
  }
});

test("anthropic: streams text_delta events; x-api-key and version headers", async () => {
  seen.length = 0;
  handler = (_q, _b, res) =>
    sse(res, [
      'event: message_start\ndata: {"type":"message_start","message":{}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"嗨"}}\n\n',
      'event: ping\ndata: {"type":"ping"}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"～"}}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ]);
  const events = await collect(provider(cfg("anthropic")).stream(input()));
  assert.deepEqual(
    events.map((e) => (e.type === "delta" ? e.text : e.type)),
    ["嗨", "～", "complete"],
  );
  const req = seen[0];
  assert.equal(req.url, "/v1/messages");
  assert.equal(req.headers["x-api-key"], KEY);
  assert.equal(req.headers["anthropic-version"], "2023-06-01");
  assert.equal(req.headers.authorization, undefined);
  assert.equal(req.body.system, "你是大肥鱼。");
  assert.equal(req.body.max_tokens, 256);
  assert.deepEqual(req.body.messages, [{ role: "user", content: "你好" }]);
});

test("openai-compatible: valid finish_reason completes without DONE and preserves the final delta", async () => {
  for (const finishReason of ["stop", "length", "tool_calls", "function_call"]) {
    handler = (_q, _b, res) => sse(res, [
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "最后一段" }, finish_reason: finishReason }] })}\n\n`,
    ]);
    assert.deepEqual(await collect(provider(cfg("openai-compatible")).stream(input())), [
      { type: "delta", text: "最后一段" },
      { type: "complete", messageId: "reply-1" },
    ]);
  }
});

test("EOF without a protocol completion marker rejects and never emits complete", async () => {
  const partialOpenAi = 'data: {"choices":[{"index":0,"delta":{"content":"半条回复"}}]}\n\n';
  const partialAnthropic = 'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"半条回复"}}\n\n';
  const cases: Array<[ChatApiConfig["protocol"], string, string]> = [
    ["openai-compatible", partialOpenAi, ""],
    ["openai-compatible", partialOpenAi, 'data: {"choices":[{"delta":{"content":"lost'],
    ["openai-compatible", partialOpenAi, 'data: {"choices":\n\n'],
    ["openai-compatible", partialOpenAi, 'data: {"choices":[{"index":0,"finish_reason":null}]}\n\n'],
    ["openai-compatible", partialOpenAi, 'data: {"choices":[{"index":0,"finish_reason":"unknown"}]}\n\n'],
    ["openai-compatible", partialOpenAi, 'data: {"choices":[{"index":1,"finish_reason":"stop"}]}\n\n'],
    ["anthropic", partialAnthropic, ""],
    ["anthropic", partialAnthropic, 'data: {"type":"message_stop"'],
    ["anthropic", partialAnthropic, 'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n'],
  ];
  for (const [protocol, first, tail] of cases) {
    handler = (_q, _b, res) => sse(res, [first, tail]);
    const events: ChatEvent[] = [];
    await rejectsCode((async () => {
      for await (const event of provider(cfg(protocol)).stream(input())) events.push(event);
    })(), "bad_response");
    assert.deepEqual(events, [{ type: "delta", text: "半条回复" }], `${protocol}: no completion for tail ${tail}`);
  }
});

test("interrupted SSE cannot save an assistant reply or extract memory through MainChatService", async () => {
  for (const protocol of ["openai-compatible", "anthropic"] as const) {
    handler = (_q, _b, res) => sse(res, [protocol === "openai-compatible"
      ? 'data: {"choices":[{"index":0,"delta":{"content":"半条回复"}}]}\n\ndata: {"choices":'
      : 'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"半条回复"}}\n\ndata: {"type":"message_stop"',
    ]);
    const saved: ChatMessage[] = [];
    let extracted = 0;
    let proposed = 0;
    const service = new MainChatService({
      persona,
      provider: provider(cfg(protocol)),
      conversationId: `interrupted-${protocol}`,
      conversations: {
        append: async (message) => { saved.push(message); },
        recent: async () => [...saved],
      },
      memory: {
        recall: async () => [],
        propose: async () => { proposed++; },
        confirm: async () => {}, update: async () => {}, remove: async () => {},
      },
      proposeMemories: () => {
        extracted++;
        return [{ id: "never", personaId: persona.id, kind: "fact", text: "never", sourceMessageIds: [], confirmation: "pending", updatedAt: 1 }];
      },
      warn: () => {},
    });
    const result = await service.send("记住这件事");
    assert.equal(result.status, "error");
    assert.equal(result.status === "error" && result.code, "bad_response");
    assert.equal(service.state().reply, "半条回复");
    assert.deepEqual(saved.map((message) => message.role), ["user"]);
    assert.equal(extracted, 0);
    assert.equal(proposed, 0);
    service.dispose();
  }
});

test("HTTP errors map to fixed codes without echoing the body", async () => {
  for (const [status, code] of [
    [401, "auth"],
    [403, "auth"],
    [429, "rate_limit"],
    [500, "http"],
  ] as const) {
    handler = (_q, _b, res) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: `upstream said ${KEY}` } }));
    };
    await rejectsCode(collect(provider(cfg("openai-compatible")).stream(input())), code);
  }
});

test("mid-stream error, refusal and empty reply are errors", async () => {
  handler = (_q, _b, res) => sse(res, ['event: error\ndata: {"type":"error","error":{"type":"overloaded_error"}}\n\n']);
  await rejectsCode(collect(provider(cfg("anthropic")).stream(input())), "http");

  handler = (_q, _b, res) =>
    sse(res, ['data: {"type":"message_delta","delta":{"stop_reason":"refusal"}}\n\n', 'data: {"type":"message_stop"}\n\n']);
  await rejectsCode(collect(provider(cfg("anthropic")).stream(input())), "refusal");

  handler = (_q, _b, res) => sse(res, ['data: {"choices":[{"index":0,"delta":{"refusal":"no"}}]}\n\n']);
  await rejectsCode(collect(provider(cfg("openai-compatible")).stream(input())), "refusal");

  handler = (_q, _b, res) => sse(res, ['data: {"choices":[{"index":0,"delta":{},"finish_reason":"content_filter"}]}\n\n']);
  await rejectsCode(collect(provider(cfg("openai-compatible")).stream(input())), "refusal");

  handler = (_q, _b, res) => sse(res, ["data: [DONE]\n\n"]);
  await rejectsCode(collect(provider(cfg("openai-compatible")).stream(input())), "empty");

  handler = (_q, _b, res) => sse(res, ["data: not json\n\n"]);
  await rejectsCode(collect(provider(cfg("openai-compatible")).stream(input())), "bad_response");
});

test("timeout: no bytes within requestTimeoutMs aborts with timeout", async () => {
  handler = (_q, _b, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write('data: {"choices":[{"index":0,"delta":{"content":"一"}}]}\n\n');
    // then stall forever
  };
  const got: string[] = [];
  const started = Date.now();
  await rejectsCode(
    (async () => {
      for await (const e of provider(cfg("openai-compatible", { requestTimeoutMs: 1000 })).stream(input())) {
        if (e.type === "delta") got.push(e.text);
      }
    })(),
    "timeout",
  );
  assert.deepEqual(got, ["一"]);
  assert.ok(Date.now() - started < 4000);
});

test("cancel: aborting the caller signal stops the stream with cancelled", async () => {
  handler = (_q, _b, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write('data: {"choices":[{"index":0,"delta":{"content":"一"}}]}\n\n');
  };
  const ac = new AbortController();
  await rejectsCode(
    (async () => {
      for await (const e of provider(cfg("openai-compatible")).stream(input({ signal: ac.signal }))) {
        if (e.type === "delta") ac.abort();
      }
    })(),
    "cancelled",
  );
  const pre = new AbortController();
  pre.abort();
  await rejectsCode(collect(provider(cfg("openai-compatible")).stream(input({ signal: pre.signal }))), "cancelled");
});

test("cancel while awaiting the API key never sends a request after the key resolves", async () => {
  for (const protocol of ["openai-compatible", "anthropic"] as const) {
    for (const key of [KEY, null]) {
      let releaseKey!: (value: string | null) => void;
      const keyWait = new Promise<string | null>((resolve) => { releaseKey = resolve; });
      let requests = 0;
      const p = createChatApiProvider({
        config: cfg(protocol),
        getApiKey: () => keyWait,
        fetch: async () => { requests++; throw new Error("must not send after cancellation"); },
      });
      const controller = new AbortController();
      const pending = collect(p.stream(input({ signal: controller.signal })));
      controller.abort();
      releaseKey(key);
      await rejectsCode(pending, "cancelled");
      assert.equal(requests, 0);
    }
  }
});

test("network failure maps to network", async () => {
  const dead = createServer();
  await new Promise<void>((r) => dead.listen(0, "127.0.0.1", r));
  const port = (dead.address() as AddressInfo).port;
  await new Promise<void>((r) => dead.close(() => r()));
  await rejectsCode(
    collect(provider(cfg("openai-compatible", { baseUrl: `http://127.0.0.1:${port}/v1` })).stream(input())),
    "network",
  );
});

test("not configured: missing key, bad URL, plain http to a remote host, empty model", async () => {
  await rejectsCode(collect(provider(cfg("openai-compatible"), null).stream(input())), "not_configured");
  await rejectsCode(collect(provider(cfg("openai-compatible"), "  ").stream(input())), "not_configured");
  assert.throws(() => validateConfig(cfg("openai-compatible", { baseUrl: "nope" })), /invalid/);
  assert.throws(() => validateConfig(cfg("openai-compatible", { baseUrl: "http://example.com/v1" })), /https/);
  assert.throws(() => validateConfig(cfg("openai-compatible", { model: " " })), /model/);
  validateConfig(cfg("openai-compatible", { baseUrl: "https://example.com/v1" }));
});

test("helpers: endpoint URLs, wire messages, system prompt", () => {
  assert.equal(endpointUrl({ protocol: "anthropic", baseUrl: "https://api.anthropic.com" }), "https://api.anthropic.com/v1/messages");
  assert.equal(endpointUrl({ protocol: "anthropic", baseUrl: "https://x/v1/" }), "https://x/v1/messages");
  assert.equal(endpointUrl({ protocol: "openai-compatible", baseUrl: "https://x/v1/" }), "https://x/v1/chat/completions");

  const wire = toWireMessages(persona, [
    msg("assistant", "开场白"),
    msg("user", "一"),
    msg("user", "二"),
    msg("assistant", " "),
    msg("user", "别人", "other"),
    msg("assistant", "回"),
    msg("user", "三"),
  ]);
  assert.deepEqual(wire, [
    { role: "user", content: "一\n\n二" },
    { role: "assistant", content: "回" },
    { role: "user", content: "三" },
  ]);
  assert.equal(buildSystemPrompt(persona, []), "你是大肥鱼。");
});

test("a request that does not end with a user message is rejected before sending", async () => {
  seen.length = 0;
  await rejectsCode(
    collect(provider(cfg("openai-compatible")).stream(input({ messages: [msg("user", "a"), msg("assistant", "b")] }))),
    "bad_response",
  );
  assert.equal(seen.length, 0);
});
