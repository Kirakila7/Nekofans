// Public entry for dsh-bridge. Each bridge lives in its own module; this file only re-exports.

export { DshClient, DshSession, DshRpcError } from "./session.ts";
export type {
  FetchLike,
  DshErrorKind,
  DshClientOptions,
  DshSessionOptions,
  DshSessionSummary,
  DshSessionCreateRequest,
  DshSessionCreateValue,
  DshEvent,
  DshEventHandler,
} from "./session.ts";

export {
  TaskBridge,
  InMemoryTaskStore,
  TaskTransitionError,
  TASK_TRANSITIONS,
  canTransition,
  dshClientPort,
} from "./task-bridge.ts";
export type {
  TaskStatusKind,
  ArtifactKind,
  ArtifactRef,
  TaskRequest,
  TaskStatus,
  TaskStartResult,
  TaskStatusHandler,
  TaskRecord,
  TaskStore,
  DshTaskPort,
  TaskBridgeOptions,
} from "./task-bridge.ts";

export { VideoTaskBridge } from "./video-task.ts";
export type { VideoGenerationOpts, VideoSubmitResult, JobStatus } from "./video-task.ts";

export { CodeTaskBridge } from "./code-task.ts";
export type { DiffResult, CheckKind, CheckResult } from "./code-task.ts";
