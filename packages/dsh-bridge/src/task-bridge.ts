// F12 DSH task bridge: task status state machine, persistence seam, and DSH session driving.
// State rules follow ARCHITECTURE section 5. Contract types come from app-contracts
// (mirror of contracts/task.schema.json).

import { randomUUID } from "node:crypto";
import type { ArtifactKind, ArtifactRef, TaskStatusKind } from "../../app-contracts/src/index.ts";
import { DshSession, type DshClient } from "./session.ts";

export type { ArtifactKind, ArtifactRef, TaskStatusKind };

export interface TaskRequest {
  character_id: string;
  user_input: string;
  project_id?: string;
  artifacts_needed: ArtifactKind[];
}

export interface TaskStatus {
  task_id: string;
  status: TaskStatusKind;
  artifacts: ArtifactRef[];
}

export interface TaskStartResult {
  task_id: string;
  session_id: string;
}

export type TaskStatusHandler = (status: TaskStatus) => void;

/** Persisted task row. The coordinator backs TaskStore with app.sqlite. */
export interface TaskRecord extends TaskStatus {
  session_id: string;
  request: TaskRequest;
  /** ISO 8601 timestamp of the last status write. */
  updated_at: string;
}

/** Synchronous so it maps directly onto node:sqlite DatabaseSync. */
export interface TaskStore {
  get(task_id: string): TaskRecord | undefined;
  put(record: TaskRecord): void;
  list(): TaskRecord[];
}

export class InMemoryTaskStore implements TaskStore {
  private readonly rows = new Map<string, TaskRecord>();

  get(task_id: string): TaskRecord | undefined {
    const row = this.rows.get(task_id);
    return row === undefined ? undefined : structuredClone(row);
  }

  put(record: TaskRecord): void {
    this.rows.set(record.task_id, structuredClone(record));
  }

  list(): TaskRecord[] {
    return [...this.rows.values()].map((row) => structuredClone(row));
  }
}

const WAITING: readonly TaskStatusKind[] = [
  "waiting_user",
  "waiting_approval",
  "waiting_quota",
  "waiting_external",
];

/**
 * Allowed transitions. succeeded and cancelled are terminal; failed is terminal for this
 * task record. Waiting states resume to running. interrupted is entered from running on
 * restart and leaves only via resume (running), cancel, or an explicit failure.
 */
export const TASK_TRANSITIONS: Readonly<Record<TaskStatusKind, readonly TaskStatusKind[]>> = {
  queued: ["running", "cancelled", "failed"],
  running: [...WAITING, "succeeded", "failed", "cancelled", "interrupted"],
  waiting_user: ["running", "cancelled", "failed", "interrupted"],
  waiting_approval: ["running", "cancelled", "failed", "interrupted"],
  waiting_quota: ["running", "cancelled", "failed", "interrupted"],
  waiting_external: ["running", "cancelled", "failed", "interrupted"],
  succeeded: [],
  failed: [],
  cancelled: [],
  interrupted: ["running", "cancelled", "failed"],
};

export function canTransition(from: TaskStatusKind, to: TaskStatusKind): boolean {
  return TASK_TRANSITIONS[from].includes(to);
}

export class TaskTransitionError extends Error {
  readonly task_id: string;
  readonly from: TaskStatusKind;
  readonly to: TaskStatusKind;

  constructor(task_id: string, from: TaskStatusKind, to: TaskStatusKind, reason?: string) {
    super(`task ${task_id}: illegal transition ${from} -> ${to}${reason ? ` (${reason})` : ""}`);
    this.name = "TaskTransitionError";
    this.task_id = task_id;
    this.from = from;
    this.to = to;
  }
}

/** What the bridge needs from DSH. Injectable so the state machine is testable offline. */
export interface DshTaskPort {
  createSession(request: TaskRequest): Promise<string>;
  send(session_id: string, text: string): Promise<void>;
  cancel(session_id: string): Promise<void>;
}

/** Port backed by a live DshClient (session/create, session/prompt, session/cancel). */
export function dshClientPort(client: DshClient): DshTaskPort {
  return {
    async createSession() {
      return (await DshSession.create(client)).session_id;
    },
    send: (session_id, text) => DshSession.attach(client, session_id).send(text),
    cancel: (session_id) => DshSession.attach(client, session_id).cancel(),
  };
}

export interface TaskBridgeOptions {
  dsh: DshTaskPort;
  store?: TaskStore;
  now?: () => Date;
}

export class TaskBridge {
  private readonly dsh: DshTaskPort;
  private readonly store: TaskStore;
  private readonly now: () => Date;
  private readonly handlers = new Set<TaskStatusHandler>();

  constructor(opts: TaskBridgeOptions) {
    this.dsh = opts.dsh;
    this.store = opts.store ?? new InMemoryTaskStore();
    this.now = opts.now ?? (() => new Date());
  }

  get(task_id: string): TaskStatus | undefined {
    const record = this.store.get(task_id);
    return record === undefined ? undefined : toStatus(record);
  }

  /** Creates a DSH session, persists the task as queued, sends the input, then marks running. */
  async start(request: TaskRequest): Promise<TaskStartResult> {
    const session_id = await this.dsh.createSession(request);
    const task_id = randomUUID();
    this.store.put({
      task_id,
      session_id,
      request: structuredClone(request),
      status: "queued",
      artifacts: [],
      updated_at: this.now().toISOString(),
    });
    this.emit(task_id);
    try {
      await this.dsh.send(session_id, request.user_input);
    } catch (error) {
      this.transitionIfLegal(task_id, "failed");
      throw error;
    }
    // A cancel may have landed while the prompt was in flight; stop the turn DSH just accepted.
    if (this.store.get(task_id)?.status === "cancelled") {
      await this.dsh.cancel(session_id);
    } else {
      this.transitionIfLegal(task_id, "running");
    }
    return { task_id, session_id };
  }

  // TODO(M3): unverified. DSH routes question answers through its interaction mechanism
  // (/connect interactions=answer); until that is wired the answer is queued as a prompt.
  async answer(task_id: string, answer_text: string): Promise<void> {
    const record = this.require(task_id);
    if (record.status !== "waiting_user") {
      throw new TaskTransitionError(task_id, record.status, "running", "answer requires waiting_user");
    }
    await this.dsh.send(record.session_id, answer_text);
    this.transitionIfLegal(task_id, "running");
  }

  /** Stops the task. Live states ask DSH to cancel the active turn first. */
  async cancel(task_id: string): Promise<void> {
    const record = this.require(task_id);
    this.assertTransition(record, "cancelled");
    if (record.status === "running" || WAITING.includes(record.status)) {
      await this.dsh.cancel(record.session_id);
    }
    this.transition(task_id, "cancelled");
  }

  /** Continues an interrupted task on its original DSH session; never creates a new one. */
  async resume(task_id: string, message: string): Promise<void> {
    const record = this.require(task_id);
    if (record.status !== "interrupted") {
      throw new TaskTransitionError(task_id, record.status, "running", "resume requires interrupted");
    }
    await this.dsh.send(record.session_id, message);
    this.transitionIfLegal(task_id, "running");
  }

  /**
   * Run once at app start. Tasks persisted as running lost their live event stream, so they
   * become interrupted; nothing is promoted to succeeded from stored state.
   */
  recover(): TaskStatus[] {
    const interrupted: TaskStatus[] = [];
    for (const record of this.store.list()) {
      if (record.status === "running") {
        interrupted.push(this.transition(record.task_id, "interrupted"));
      }
    }
    return interrupted;
  }

  /**
   * Applies one status change driven by DSH events or the coordinator. Moving to succeeded
   * requires an artifact for every requested kind.
   */
  transition(task_id: string, to: TaskStatusKind, artifacts?: ArtifactRef[]): TaskStatus {
    const record = this.require(task_id);
    this.assertTransition(record, to);
    const next: TaskRecord = {
      ...record,
      status: to,
      artifacts: artifacts === undefined ? record.artifacts : structuredClone(artifacts),
      updated_at: this.now().toISOString(),
    };
    if (to === "succeeded") {
      const missing = next.request.artifacts_needed.filter(
        (kind) => !next.artifacts.some((artifact) => artifact.kind === kind),
      );
      if (missing.length > 0) {
        throw new TaskTransitionError(task_id, record.status, to, `missing artifacts: ${missing.join(", ")}`);
      }
    }
    this.store.put(next);
    this.emit(task_id);
    return toStatus(next);
  }

  onStatusChange(handler: TaskStatusHandler): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  private transitionIfLegal(task_id: string, to: TaskStatusKind): void {
    const record = this.store.get(task_id);
    if (record !== undefined && canTransition(record.status, to)) this.transition(task_id, to);
  }

  private assertTransition(record: TaskRecord, to: TaskStatusKind): void {
    if (!canTransition(record.status, to)) {
      throw new TaskTransitionError(record.task_id, record.status, to);
    }
  }

  private require(task_id: string): TaskRecord {
    const record = this.store.get(task_id);
    if (record === undefined) throw new Error(`task ${task_id} not found`);
    return record;
  }

  private emit(task_id: string): void {
    const record = this.store.get(task_id);
    if (record === undefined) return;
    const status = toStatus(record);
    for (const handler of this.handlers) handler(status);
  }
}

function toStatus(record: TaskRecord): TaskStatus {
  return { task_id: record.task_id, status: record.status, artifacts: structuredClone(record.artifacts) };
}
