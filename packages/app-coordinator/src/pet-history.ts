// F09 overlay persistence: dialog history, task views and the set of tasks whose
// completion notice already fired. Survives dialog hide, window re-creation and restart.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { HistoryEntry, OverlayTaskView } from "./overlay-protocol.ts";

export interface OverlayPersisted {
  history: HistoryEntry[];
  tasks: OverlayTaskView[];
  /** Tasks whose completion notice has fired; a notice never fires twice for one task. */
  notified_task_ids: string[];
}

/** Synchronous like TaskStore, so it maps onto node:sqlite later. */
export interface OverlayStore {
  load(): OverlayPersisted;
  save(state: OverlayPersisted): void;
}

export function emptyPersisted(): OverlayPersisted {
  return { history: [], tasks: [], notified_task_ids: [] };
}

export class InMemoryOverlayStore implements OverlayStore {
  private state: OverlayPersisted = emptyPersisted();

  load(): OverlayPersisted {
    return structuredClone(this.state);
  }

  save(state: OverlayPersisted): void {
    this.state = structuredClone(state);
  }
}

export interface JsonFileOverlayStoreOptions {
  /** Oldest history entries beyond this count are dropped on save. */
  max_history?: number;
}

export const DEFAULT_MAX_HISTORY = 500;

/** JSON file store. Writes go to a temp file first, then rename, so a crash never leaves half a file. */
export class JsonFileOverlayStore implements OverlayStore {
  readonly path: string;
  private readonly maxHistory: number;

  constructor(path: string, opts: JsonFileOverlayStoreOptions = {}) {
    this.path = path;
    this.maxHistory = opts.max_history ?? DEFAULT_MAX_HISTORY;
  }

  load(): OverlayPersisted {
    let raw: string;
    try {
      raw = readFileSync(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyPersisted();
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      console.warn("[app-coordinator] overlay store is not valid JSON, starting empty:", this.path);
      return emptyPersisted();
    }
    return normalize(parsed);
  }

  save(state: OverlayPersisted): void {
    const trimmed: OverlayPersisted = {
      history: state.history.slice(-this.maxHistory),
      tasks: state.tasks,
      notified_task_ids: state.notified_task_ids,
    };
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(trimmed, null, 1), "utf8");
    renameSync(tmp, this.path);
  }
}

function normalize(value: unknown): OverlayPersisted {
  const out = emptyPersisted();
  if (typeof value !== "object" || value === null) return out;
  const v = value as Record<string, unknown>;
  if (Array.isArray(v.history)) {
    out.history = v.history.filter(
      (e): e is HistoryEntry =>
        typeof e === "object" && e !== null && typeof e.entry_id === "string" && typeof e.text === "string",
    );
  }
  if (Array.isArray(v.tasks)) {
    out.tasks = v.tasks.filter(
      (t): t is OverlayTaskView =>
        typeof t === "object" && t !== null && typeof t.task_id === "string" && typeof t.status === "string",
    );
  }
  if (Array.isArray(v.notified_task_ids)) {
    out.notified_task_ids = v.notified_task_ids.filter((id): id is string => typeof id === "string");
  }
  return out;
}
