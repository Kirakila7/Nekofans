// DshClient / DshSession against a local node:http fake of the DSH /connect + /api channel.
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { DshClient, DshRpcError, DshSession, type FetchLike } from "../../packages/dsh-bridge/src/index.ts";

const TOKEN = "launch-token";
const COOKIE = "dsh-api=abc123";

interface Seen {
  method: string;
  cookie?: string;
  body: { type: string; rpcId: string; method: string; payload: { args: Record<string, unknown> } };
}

const seen: Seen[] = [];
let server: Server;
let origin: string;

function readJson(req: IncomingMessage): Promise<Seen["body"]> {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => resolve(JSON.parse(raw)));
    req.on("error", reject);
  });
}

before(async () => {
  server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (req.method === "GET" && url.pathname === "/connect") {
      if (url.searchParams.get("token") !== TOKEN || url.searchParams.get("interactions") !== "none") {
        res.writeHead(401).end();
        return;
      }
      res.writeHead(302, { location: "./api/remote.mux", "set-cookie": `${COOKIE}; Path=/; HttpOnly` }).end();
      return;
    }
    if (req.method === "POST" && url.pathname.startsWith("/api/")) {
      const method = url.pathname.slice("/api/".length);
      const body = await readJson(req);
      seen.push({ method, cookie: req.headers.cookie, body });
      if (req.headers.cookie !== COOKIE) {
        res.writeHead(401).end();
        return;
      }
      const reply = (result: unknown) =>
        res.writeHead(200, { "content-type": "application/json" })
          .end(JSON.stringify({ type: "server-response", rpcId: body.rpcId, result }));
      if (method === "session/create") return reply({ ok: true, value: { sessionId: "s-1" } });
      if (method === "session/list") {
        return reply({ ok: true, value: { items: [{ sessionId: "s-1", agentAvailable: true, updatedAt: 1, running: false, blank: true }] } });
      }
      if (method === "session/prompt") return reply({ ok: true, value: { accepted: true } });
      if (method === "session/cancel") {
        return reply({ ok: false, error: { code: "session/agent-busy", message: "agent busy", details: { reason: "x" } } });
      }
      res.writeHead(500).end();
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => new Promise<void>((resolve) => server.close(() => resolve())));

test("connect exchanges the token and rpc calls carry the cookie and envelope", async () => {
  seen.length = 0;
  const client = await DshClient.connect({ launch_url: `${origin}/?token=${TOKEN}` });
  const session = await DshSession.create(client);
  assert.equal(session.session_id, "s-1");
  const items = await DshSession.list(client);
  assert.deepEqual(items.map((item) => item.sessionId), ["s-1"]);
  await session.send("hello");

  assert.deepEqual(seen.map((s) => s.method), ["session/create", "session/list", "session/prompt"]);
  for (const s of seen) {
    assert.equal(s.cookie, COOKIE);
    assert.equal(s.body.type, "client-request");
    assert.equal(s.body.method, s.method);
    assert.equal(typeof s.body.rpcId, "string");
  }
  assert.deepEqual(seen[0].body.payload.args, { request: {} });
  assert.deepEqual(seen[1].body.payload.args, { _request: {} });
  const prompt = seen[2].body.payload.args.request as Record<string, unknown>;
  assert.equal(prompt.sessionId, "s-1");
  assert.equal(prompt.mode, "queue");
  assert.deepEqual(prompt.content, [{ type: "text", text: "hello" }]);
});

test("result.ok === false surfaces as rpc_failed with DSH code and details", async () => {
  const client = await DshClient.connect({ launch_url: `${origin}/?token=${TOKEN}` });
  const session = DshSession.attach(client, "s-1");
  await assert.rejects(session.cancel(), (error: unknown) => {
    assert.ok(error instanceof DshRpcError);
    assert.equal(error.kind, "rpc_failed");
    assert.equal(error.method, "session/cancel");
    assert.equal(error.code, "session/agent-busy");
    assert.deepEqual(error.details, { reason: "x" });
    return true;
  });
});

test("wrong token is connect_failed with the HTTP status", async () => {
  await assert.rejects(DshClient.connect({ launch_url: `${origin}/?token=wrong` }), (error: unknown) => {
    assert.ok(error instanceof DshRpcError);
    assert.equal(error.kind, "connect_failed");
    assert.equal(error.http_status, 401);
    return true;
  });
});

test("launch URL without token is connect_failed", async () => {
  await assert.rejects(DshClient.connect({ launch_url: `${origin}/` }), { kind: "connect_failed" });
});

test("connect response without set-cookie is connect_failed", async () => {
  const fetch: FetchLike = async () => new Response(null, { status: 302, headers: { location: "./api/remote.mux" } });
  await assert.rejects(DshClient.connect({ launch_url: "http://127.0.0.1:1/?token=t", fetch }), (error: unknown) => {
    assert.ok(error instanceof DshRpcError);
    assert.equal(error.kind, "connect_failed");
    assert.match(error.message, /cookie/);
    return true;
  });
});

test("non-2xx from /api is http_failed", async () => {
  const fetch: FetchLike = async (input) =>
    input.includes("/connect")
      ? new Response(null, { status: 302, headers: { "set-cookie": "c=1; Path=/" } })
      : new Response("nope", { status: 403 });
  const client = await DshClient.connect({ launch_url: "http://127.0.0.1:1/?token=t", fetch });
  await assert.rejects(DshSession.list(client), { kind: "http_failed", http_status: 403 });
});

test("rpcId mismatch is rejected", async () => {
  const fetch: FetchLike = async (input) =>
    input.includes("/connect")
      ? new Response(null, { status: 302, headers: { "set-cookie": "c=1" } })
      : Response.json({ type: "server-response", rpcId: "other", result: { ok: true, value: { items: [] } } });
  const client = await DshClient.connect({ launch_url: "http://127.0.0.1:1/?token=t", fetch });
  await assert.rejects(DshSession.list(client), { kind: "http_failed" });
});

test("onEvent is not wired until the session/follow stream lands", async () => {
  const client = await DshClient.connect({ launch_url: `${origin}/?token=${TOKEN}` });
  assert.throws(() => DshSession.attach(client, "s-1").onEvent(() => {}), /session\/follow/);
});
