import { DshSession, type DshClient } from "./session.ts";

export interface DshAgent {
  id: string;
  parentId: string;
  name: string;
  mode: string;
  status: "running" | "idle" | "success" | "stopped" | "unavailable";
  task: string;
}
type Projection = { kind?: string; values?: Record<string, unknown> } | null;
type Row = Record<string, unknown>;
const row = (v: unknown): Row => typeof v === "object" && v !== null ? v as Row : {};

/** Read DSH's session list and ordered direct-child catalogs, including cold nested children. */
export async function readDshCatalog(client: DshClient, rootOrder: readonly string[] = []): Promise<DshAgent[]> {
  const sessions = await DshSession.list(client);
  const summaries = new Map(sessions.map((s) => [s.sessionId, s]));
  const projections = new Map<string, Projection>();
  const read = async (id: string) => {
    if (!projections.has(id)) projections.set(id, await client.call<Projection>("session/projections", { request: { sessionId: id } }));
    return projections.get(id);
  };
  const result: DshAgent[] = [];
  const seen = new Set<string>();
  const visited = new Set<string>();
  // Workspace manual order when streamed; otherwise session/list. Siblings use their parent catalog.
  const visit = async (parentId: string): Promise<void> => {
    if (visited.has(parentId)) return;
    visited.add(parentId);
    const values = (await read(parentId))?.values ?? {};
    const children = Array.isArray(values.subagentCatalog) ? values.subagentCatalog : [];
    for (const raw of children) {
      const child = row(raw);
      if (typeof child.id !== "string" || !child.id || child.id.length > 200 || child.mode === "external" || seen.has(child.id)) continue;
      seen.add(child.id);
      const projection = await read(child.id);
      const own = projection?.values ?? {};
      const summary = summaries.get(child.id);
      const timing = row(own.subagentTiming);
      const active = row(timing.active);
      const todos = Array.isArray(own.todos) ? own.todos.map(row) : [];
      const todo = todos.find((t) => t.status === "in_progress") ?? todos.find((t) => t.status === "pending");
      const status = projection == null || projection.kind === "migration-required" ? "unavailable"
        : summary?.running ? "running"
        : typeof active.since === "number" ? "stopped"
        : timing.lastTurnCompleted === true ? "success" : timing.lastTurnCompleted === false ? "stopped" : "idle";
      result.push({ id: child.id, parentId,
        name: typeof own.title === "string" && own.title ? own.title : typeof child.label === "string" && child.label ? child.label : "DSH 子代理",
        mode: typeof child.mode === "string" ? child.mode : "unknown", status,
        task: typeof todo?.content === "string" ? todo.content : typeof own.title === "string" ? own.title : "",
      });
      await visit(child.id);
    }
  };
  const roots = sessions.filter((s) => !s.parentSessionId && s.origin !== "subagent");
  const rootIds = new Set(roots.map((s) => s.sessionId));
  for (const id of rootOrder) if (rootIds.has(id)) await visit(id);
  for (const parent of roots) await visit(parent.sessionId);
  for (const parent of sessions) await visit(parent.sessionId);
  return result;
}

export interface AgentPreferences { limit: number; pinned: string[]; nicknames: Record<string, string> }
export function visibleAgents(agents: DshAgent[], preferences: AgentPreferences): DshAgent[] {
  const pinned = new Set(preferences.pinned);
  return [...agents.filter((a) => pinned.has(a.id)), ...agents.filter((a) => !pinned.has(a.id))]
    .slice(0, preferences.limit).map((a) => ({ ...a, name: preferences.nicknames[a.id] || a.name }));
}
