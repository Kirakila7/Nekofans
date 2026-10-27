import { test } from "node:test";
import assert from "node:assert/strict";
import { clientFixture } from "./fixture.ts";
import { readDshCatalog, visibleAgents, type DshAgent } from "../../packages/dsh-bridge/src/catalog.ts";
import { sendSubagent, stopSubagent } from "../../packages/dsh-bridge/src/subagent.ts";
import type { DshClient } from "../../packages/dsh-bridge/src/session.ts";

test("catalog uses DSH order and names, excludes external entries, and reads actual child work", async () => {
  const f = await clientFixture();
  const agents = await readDshCatalog(f.client);
  assert.deepEqual(agents.map((a) => a.id), ["child-b", "child-a"]);
  assert.deepEqual(agents[0], { id: "child-b", parentId: "parent", mode: "continuable", name: "Real DSH title", task: "calculate totals", status: "running" });
  assert.equal(agents[1].status, "stopped");
  assert.equal(f.calls.filter((c) => c.method === "session/projections" && (c.args.request as { sessionId: string }).sessionId === "child-b").length, 1);
});

test("an old unfinished turn without a running Agent is stopped, never projected as working", async () => {
  const f = await clientFixture(); f.state.running = false; f.state.incomplete = true;
  assert.equal((await readDshCatalog(f.client))[0].status, "stopped");
  f.state.incomplete = false;
  assert.equal((await readDshCatalog(f.client))[0].status, "success");
});

test("nested children absent from session/list are discovered from their real parent catalog", async () => {
  const f = await clientFixture(); f.state.nested = true;
  const agents = await readDshCatalog(f.client);
  assert.deepEqual(agents.map((a) => a.id), ["child-b", "grandchild", "child-a"]);
  assert.equal(agents[1].parentId, "child-b");
});

test("workspace registry root ordering takes precedence while sibling catalogs remain authoritative", async () => {
  const client = { async call(method: string, args: { request: { sessionId: string } }) {
    if (method === "session/list") return { items: ["root-a", "root-b"].map((sessionId) => ({ sessionId, running: false })) };
    const id = args.request.sessionId;
    return { kind: "sequenced", values: { subagentCatalog: ["root-a", "root-b"].includes(id)
      ? ["second", "first"].map((suffix) => ({ id: `${id}-${suffix}`, mode: "continuable" })) : [] } };
  } } as unknown as DshClient;
  const agents = await readDshCatalog(client, ["missing", "root-b", "root-b", "root-a"]);
  assert.deepEqual(agents.map((agent) => agent.id), ["root-b-second", "root-b-first", "root-a-second", "root-a-first"]);
});

test("pinned entries occupy the limit first, preserve DSH order, and local nicknames never mutate DSH", async () => {
  const f = await clientFixture(); const agents = await readDshCatalog(f.client);
  const before = structuredClone(agents);
  assert.deepEqual(visibleAgents(agents, { limit: 1, pinned: ["missing", "child-a"], nicknames: { "child-a": "local only" } }).map((a) => [a.id, a.name]), [["child-a", "local only"]]);
  assert.deepEqual(agents, before);
  assert.deepEqual(visibleAgents([] as DshAgent[], { limit: 5, pinned: ["old-id"], nicknames: {} }), []);
});

test("subagent send and stop use parent-addressed DSH control, never ordinary session/prompt", async () => {
  const f = await clientFixture();
  await sendSubagent(f.client, "parent", "child-b", "continue");
  await stopSubagent(f.client, "parent", "child-b");
  assert.deepEqual(f.calls.map((c) => c.method), ["subagents/prompt", "subagents/interruptByParent"]);
  const request = f.calls[0].args.request as Record<string, unknown>;
  assert.equal(request.parentSessionId, "parent"); assert.equal(request.childSessionId, "child-b");
  assert.equal(request.mode, "continuable"); assert.equal(request.delivery, "queue");
  assert.deepEqual(request.content, [{ type: "text", text: "continue" }]);
  assert.deepEqual(f.calls[1].args, { parentSessionId: "parent", childSessionId: "child-b", mode: "continuable" });
});
