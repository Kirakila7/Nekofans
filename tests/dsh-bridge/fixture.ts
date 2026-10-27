import { DshClient, type FetchLike } from "../../packages/dsh-bridge/src/session.ts";
export async function clientFixture() {
  const calls: Array<{ method: string; args: Record<string, unknown> }> = [];
  const state = { fail: false, children: [{ id: "child-b", mode: "continuable", label: "B" }, { id: "child-a", mode: "one-shot", label: "A" }, { id: "external", mode: "external" }], running: true, incomplete: false, nested: false };
  const fetch: FetchLike = async (_url, init) => {
    if (!init?.body) return new Response(null, { status: 302, headers: { "set-cookie": "dsh-api=synthetic; HttpOnly" } });
    const { method, rpcId, payload: { args } } = JSON.parse(String(init.body));
    calls.push({ method, args });
    if (state.fail) return new Response("offline", { status: 503 });
    let value: unknown;
    if (method === "session/list") value = { items: [{ sessionId: "parent", running: false }, { sessionId: "child-b", running: state.running }, { sessionId: "child-a", running: false }] };
    else if (method === "session/projections") {
      const id = args.request.sessionId;
      value = { kind: "sequenced", values: id === "parent" ? { subagentCatalog: state.children }
        : id === "child-b" ? { title: "Real DSH title", subagentCatalog: state.nested ? [{ id: "grandchild", mode: "continuable", label: "nested worker" }] : [], todos: [{ content: "calculate totals", status: "in_progress" }], subagentTiming: state.incomplete ? { active: { since: 123 } } : { lastTurnCompleted: true } }
        : { subagentTiming: { lastTurnCompleted: false } } };
    } else if (method === "subagents/prompt") value = { messageId: "message-1" };
    else if (method === "subagents/interruptByParent") value = { accepted: true };
    else throw new Error("Unexpected RPC method");
    return Response.json({ rpcId, result: { ok: true, value } });
  };
  return { client: await DshClient.connect({ launch_url: "http://127.0.0.1:59090/?token=synthetic", fetch }), calls, state };
}
