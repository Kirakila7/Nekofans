import { test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { DshCatalogEvents } from "../../packages/dsh-bridge/src/catalog-events.ts";
import { dshStream } from "../../packages/dsh-bridge/src/stream.ts";

async function until(check: () => boolean) {
  for (let i = 0; i < 100 && !check(); i++) await delay(2);
  assert.ok(check(), "expected stream state did not arrive");
}
class Socket extends EventTarget {
  readyState = 0;
  sent: Array<Record<string, unknown>> = [];
  send(text: string) { this.sent.push(JSON.parse(text)); }
  close() { this.readyState = 3; this.dispatchEvent(new Event("close")); }
  open() { this.readyState = 1; this.dispatchEvent(new Event("open")); }
  item(value: unknown) { this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "item", streamId: this.sent[0].streamId, value }) })); }
}

test("DSH Remote stream authenticates, uses actual mux envelope, and cancels its socket", async () => {
  const socket = new Socket();
  const abort = new AbortController();
  const stream = dshStream("http://127.0.0.1:59090", "dsh-api=synthetic", "workspace/follow", {}, abort.signal, (url, headers) => {
    assert.equal(url, "ws://127.0.0.1:59090/api/remote.mux");
    assert.deepEqual(headers, { cookie: "dsh-api=synthetic" });
    return socket as unknown as WebSocket;
  })[Symbol.asyncIterator]();
  const first = stream.next(); socket.open();
  assert.equal(socket.sent[0].endpoint, "workspace/follow");
  assert.deepEqual(socket.sent[0].payload, { args: {} });
  socket.item({ type: "baseline", value: { items: [] } });
  assert.deepEqual((await first).value, { type: "baseline", value: { items: [] } });
  const next = stream.next(); abort.abort();
  await assert.rejects(next, { name: "AbortError" });
  assert.equal(socket.readyState, 3);
  assert.equal(socket.sent.at(-1)?.type, "cancel");
});

test("DSH Remote stream rejects malformed/wrong correlation and suppresses remote error details", async () => {
  for (const frame of [{ type: "item", streamId: "wrong", value: 1 }, { type: "error", error: { message: "private user input" } }]) {
    const socket = new Socket();
    const stream = dshStream("http://localhost", "synthetic", "session/control", {}, new AbortController().signal, () => socket as unknown as WebSocket)[Symbol.asyncIterator]();
    const first = stream.next(); socket.open();
    socket.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ streamId: socket.sent[0].streamId, ...frame }) }));
    await assert.rejects(first, (error: Error) => error.message === "DSH event stream unavailable.");
    assert.equal(socket.readyState, 3);
  }
});

function streamsFixture() {
  const generations = new Map<string, Array<{ push(value: unknown): void; end(): void }>>();
  let active = 0;
  const client = {
    async *stream(endpoint: string, _args: Record<string, unknown>, signal: AbortSignal) {
      let wake = () => {}, done = false;
      const queue: unknown[] = [];
      const end = () => { done = true; wake(); };
      const source = { push(value: unknown) { queue.push(value); wake(); }, end };
      const rows = generations.get(endpoint) ?? [];
      generations.set(endpoint, [...rows, source]);
      signal.addEventListener("abort", end, { once: true }); active++;
      try {
        while (!done) {
          if (queue.length) yield queue.shift();
          else await new Promise<void>((resolve) => { wake = resolve; });
        }
      } finally { active--; signal.removeEventListener("abort", end); }
    },
  };
  return { client, generations, active: () => active };
}
const baseline = (items: unknown[]) => ({ type: "baseline", value: { items } });
const workspace = (workspaceId: string, sessionIds: string[]) => ({ workspaceId, sessionIds });

test("catalog events apply registry order/membership, reject stale projection frames, and clean up", async () => {
  const f = streamsFixture(); let changes = 0;
  const events = new DshCatalogEvents(f.client, () => changes++, { retryMs: 5 });
  try {
    const work = f.generations.get("workspace/follow")![0];
    const control = f.generations.get("session/control")![0];
    work.push(baseline([workspace("a", ["root-a"]), workspace("b", ["root-b", "root-c"])]));
    control.push({ type: "baseline", value: { projections: { "child-a": { asOfSeq: 10, values: { title: "old" } } } } });
    await until(() => changes === 2);
    assert.deepEqual(events.rootOrder(), ["root-a", "root-b", "root-c"]);
    work.push({ type: "order", workspaceIds: ["b", "a"] });
    work.push({ type: "upsert", workspace: workspace("b", ["root-c", "root-b"]) });
    control.push({ type: "projection", sessionId: "child-a", key: "title", value: "stale", seq: 10 });
    control.push({ type: "projection", sessionId: "child-a", key: "title", value: "new", seq: 11 });
    control.push({ type: "projection", sessionId: "child-a", key: "todos", value: [], seq: 11 });
    await until(() => changes === 6);
    assert.deepEqual(events.rootOrder(), ["root-c", "root-b", "root-a"]);
    work.push({ type: "replace", value: { items: [workspace("b", ["root-d"])] } });
    await until(() => changes === 7);
    assert.deepEqual(events.rootOrder(), ["root-d"]);
  } finally { await events.stop(); }
  assert.equal(f.active(), 0);
  const count = changes; await delay(15); assert.equal(changes, count);
});

test("catalog disconnect drops obsolete order and reconnect requires a fresh baseline", async () => {
  const f = streamsFixture(); let changes = 0;
  const events = new DshCatalogEvents(f.client, () => changes++, { retryMs: 5 });
  try {
    const work = f.generations.get("workspace/follow")![0];
    work.push(baseline([workspace("a", ["old"])]));
    await until(() => changes === 1); work.end();
    await until(() => events.rootOrder().length === 0);
    await until(() => f.generations.get("workspace/follow")!.length === 2);
    f.generations.get("workspace/follow")![1].push({ type: "upsert", workspace: workspace("bad", ["without-baseline"]) });
    await until(() => f.generations.get("workspace/follow")!.length === 3);
    f.generations.get("workspace/follow")![2].push(baseline([workspace("new", ["fresh"])]));
    await until(() => changes === 2);
    assert.deepEqual(events.rootOrder(), ["fresh"]);
  } finally { await events.stop(); }
  assert.equal(f.active(), 0);
});

test("catalog stop cancels reconnect delay and does not open a later generation", async () => {
  const f = streamsFixture();
  const events = new DshCatalogEvents(f.client, () => {}, { retryMs: 30 });
  f.generations.get("workspace/follow")![0].end();
  await delay(2); await events.stop(); await delay(40);
  assert.equal(f.generations.get("workspace/follow")!.length, 1);
  assert.equal(f.active(), 0);
});
