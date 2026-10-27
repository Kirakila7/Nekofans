import { randomUUID } from "node:crypto";
import type { DshClient } from "./session.ts";

/** Parent-addressed control, matching DSH's own subagent composer. */
export async function sendSubagent(client: DshClient, parentId: string, childId: string, text: string): Promise<void> {
  await client.call("subagents/prompt", { request: { requestId: randomUUID(), parentSessionId: parentId, childSessionId: childId,
    mode: "continuable", delivery: "queue", content: [{ type: "text", text }] } });
}

export async function stopSubagent(client: DshClient, parentId: string, childId: string): Promise<void> {
  await client.call("subagents/interruptByParent", { parentSessionId: parentId, childSessionId: childId, mode: "continuable" });
}
