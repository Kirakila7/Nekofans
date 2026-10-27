import type { DshClient } from "./session.ts";

type Workspace = { workspaceId: string; sessionIds: string[] };
const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid DSH stream frame.");
  return value as Record<string, unknown>;
};
const ids = (value: unknown): string[] => {
  if (!Array.isArray(value) || !value.every((id) => typeof id === "string" && id.length > 0)) throw new Error("Invalid DSH order.");
  return [...new Set(value)];
};
const workspace = (value: unknown): Workspace => {
  const item = record(value);
  if (typeof item.workspaceId !== "string" || !item.workspaceId) throw new Error("Invalid DSH workspace.");
  return { workspaceId: item.workspaceId, sessionIds: ids(item.sessionIds) };
};

/**
 * Reconnectable read-only streams. Running-status events require an interaction-owner
 * credential, so callers retain unary polling for status and as an outage fallback.
 * Workspace registry order does not include the workbench's browser-local flat ordering.
 */
export class DshCatalogEvents {
  private readonly abort = new AbortController();
  private readonly tasks: Promise<void>[];
  private workspaces: Workspace[] = [];
  private orderReady = false;
  private stopped = false;
  private readonly changed: () => void;
  private readonly client: Pick<DshClient, "stream">;
  private readonly retryMs: number;

  constructor(client: Pick<DshClient, "stream">, changed: () => void, options: { retryMs?: number } = {}) {
    this.client = client;
    this.changed = changed;
    this.retryMs = options.retryMs ?? 2000;
    this.tasks = [this.follow("workspace/follow"), this.follow("session/control")];
  }

  rootOrder(): string[] { return this.orderReady ? [...new Set(this.workspaces.flatMap((w) => w.sessionIds))] : []; }

  /** Stop cancels both live sockets and pending retry timers, and awaits their cleanup. */
  async stop(): Promise<void> {
    if (!this.stopped) { this.stopped = true; this.abort.abort(); }
    await Promise.all(this.tasks);
  }

  private async follow(endpoint: string): Promise<void> {
    while (!this.stopped) {
      let baseline = false;
      const watermarks = new Map<string, number>();
      try {
        for await (const raw of this.client.stream(endpoint, {}, this.abort.signal)) {
          if (this.stopped) return;
          const frame = record(raw);
          if (!baseline && frame.type !== "baseline") throw new Error("Missing DSH baseline.");
          if (endpoint === "workspace/follow") {
            if (frame.type === "baseline" || frame.type === "replace") {
              const value = record(frame.value);
              if (!Array.isArray(value.items)) throw new Error("Invalid DSH baseline.");
              this.workspaces = value.items.map(workspace);
              this.orderReady = true;
            } else if (frame.type === "upsert") {
              const item = workspace(frame.workspace);
              const index = this.workspaces.findIndex((w) => w.workspaceId === item.workspaceId);
              if (index < 0) this.workspaces.push(item); else this.workspaces[index] = item;
            } else if (frame.type === "remove") {
              this.workspaces = this.workspaces.filter((w) => w.workspaceId !== frame.workspaceId);
            } else if (frame.type === "order") {
              const order = ids(frame.workspaceIds);
              const byId = new Map(this.workspaces.map((w) => [w.workspaceId, w]));
              if (order.length !== byId.size || order.some((id) => !byId.has(id))) throw new Error("Incomplete DSH order.");
              this.workspaces = order.map((id) => byId.get(id)!);
            } else if (frame.type !== "archived" && frame.type !== "pinned") throw new Error("Invalid DSH workspace change.");
          } else if (frame.type === "baseline") {
            const projections = record(record(frame.value).projections);
            for (const [id, rawProjection] of Object.entries(projections)) {
              const projection = record(rawProjection);
              if (typeof projection.asOfSeq !== "number") throw new Error("Invalid DSH projection baseline.");
              for (const key of Object.keys(record(projection.values))) watermarks.set(JSON.stringify([id, key]), projection.asOfSeq);
            }
          } else if (frame.type === "projection" && typeof frame.sessionId === "string" && typeof frame.key === "string" && Number.isSafeInteger(frame.seq)) {
            const key = JSON.stringify([frame.sessionId, frame.key]);
            const seq = frame.seq as number;
            if (seq <= (watermarks.get(key) ?? -1)) continue;
            watermarks.set(key, seq);
          } else throw new Error("Invalid DSH control change.");
          baseline = true;
          // Callers only schedule a snapshot refresh; no conversation content is exposed.
          this.changed();
        }
      } catch { /* A fresh baseline after reconnect replaces state; never log Host frames. */ }
      if (endpoint === "workspace/follow") this.orderReady = false;
      if (this.stopped) return;
      await new Promise<void>((resolve) => {
        const done = () => { clearTimeout(timer); this.abort.signal.removeEventListener("abort", done); resolve(); };
        const timer = setTimeout(done, this.retryMs);
        this.abort.signal.addEventListener("abort", done, { once: true });
      });
    }
  }
}
