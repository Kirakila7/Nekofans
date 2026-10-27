// Public entry for avatar-runtime: coordination-layer avatar state and clip selection.
// Renderers subscribe to resolved states and only display them.

export {
  AVATAR_STATES,
  TASK_STATES,
  SOURCES,
  DEFAULT_ACTION_DURATION_MS,
  isAvatarState,
  isTaskState,
  createAvatarRuntime,
} from "./state-machine.ts";

export type {
  AvatarStateKind,
  TaskStateKind,
  StateSource,
  PlaybackId,
  ResolvedState,
  StateListener,
  TimerHandle,
  Clock,
  AvatarRuntimeOptions,
  PlayActionOptions,
  AvatarRuntime,
} from "./state-machine.ts";

export { DEFAULT_ONCE_STATES, resolveWithFallback, videoRendererOf, selectClip } from "./clip-select.ts";

export type { ClipAvailable, FallbackResult, ClipSelection, SelectClipOptions } from "./clip-select.ts";
