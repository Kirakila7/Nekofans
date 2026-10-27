// Coordination-layer avatar state machine. Renderers only display what it resolves.
// Ported from the M0 prototype (F04 avatar-state.js); see ARCHITECTURE.md section 4.
// Priority: drag > explicit action > speaking > task state > random idle.

export const AVATAR_STATES = Object.freeze([
  "idle",
  "listening",
  "thinking",
  "working",
  "speaking",
  "waiting_user",
  "success",
  "error",
  "dragging",
] as const);

export type AvatarStateKind = (typeof AVATAR_STATES)[number];

/** States the task layer is allowed to set. */
export const TASK_STATES = Object.freeze([
  "listening",
  "thinking",
  "working",
  "waiting_user",
  "success",
  "error",
] as const);

export type TaskStateKind = (typeof TASK_STATES)[number];

/** Resolution sources in priority order (highest first). */
export const SOURCES = Object.freeze(["drag", "action", "speaking", "task", "idle"] as const);

export type StateSource = (typeof SOURCES)[number];

/** Identifier of one TTS playback (N.E.K.O. playback id). */
export type PlaybackId = string;

export interface ResolvedState {
  state: AvatarStateKind;
  source: StateSource;
  /** Action name when source is "action". */
  action: string | null;
  /** Active playback when source is "speaking". */
  playback_id: PlaybackId | null;
  /** Idle variant when source is "idle". */
  idle_variant: string | null;
}

export type StateListener = (next: ResolvedState, prev: ResolvedState | null) => void;

export type TimerHandle = unknown;

/** Injected scheduler so action expiry is deterministic in tests. */
export interface Clock {
  setTimer(fn: () => void, ms: number): TimerHandle;
  clearTimer(handle: TimerHandle): void;
}

export interface AvatarRuntimeOptions {
  clock?: Clock;
  random?: () => number;
  /** Idle variant names for random idle; the first one is the initial variant. */
  idle_variants?: string[];
}

export interface PlayActionOptions {
  /** Upper bound of the occupation; non-positive or invalid values use the default. */
  duration_ms?: number;
  /** Avatar state shown while the action runs; unknown values become "idle". */
  state?: AvatarStateKind;
  /** Bind the action to a playback so interruptPlayback stops both together. */
  playback_id?: PlaybackId;
}

export const DEFAULT_ACTION_DURATION_MS = 4000;

interface ActionInput {
  name: string;
  state: AvatarStateKind;
  token: number;
  playback_id: PlaybackId | null;
  timer: TimerHandle;
}

export interface AvatarRuntime {
  resolve(): ResolvedState;
  /** Calls the listener immediately with (current, null), then on every change. Returns unsubscribe. */
  subscribe(listener: StateListener): () => void;
  setDragging(on: boolean): void;
  /** Start an explicit action. Returns a token for endAction. */
  playAction(name: string, opts?: PlayActionOptions): number;
  /** End the running action; with a token only that action ends, stale tokens are ignored. */
  endAction(token?: number): boolean;
  currentAction(): { name: string; token: number } | null;
  /** Real audio playback started. A newer playback replaces the current one. */
  playbackStarted(playback_id: PlaybackId): void;
  /** Real audio playback ended. Ignored unless it matches the current playback. */
  playbackEnded(playback_id: PlaybackId): void;
  /** User interrupt: stops speaking and any action bound to the same playback. */
  interruptPlayback(playback_id: PlaybackId): boolean;
  /** null, undefined or "idle" clears the task state; unknown values clear it with a warning. */
  setTaskState(state: TaskStateKind | "idle" | null | undefined): void;
  /** Pick a new idle variant; only visible when nothing with higher priority is active. */
  rollIdle(): string;
}

export function isAvatarState(value: unknown): value is AvatarStateKind {
  return typeof value === "string" && (AVATAR_STATES as readonly string[]).includes(value);
}

export function isTaskState(value: unknown): value is TaskStateKind {
  return typeof value === "string" && (TASK_STATES as readonly string[]).includes(value);
}

const systemClock: Clock = {
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

function keyOf(r: ResolvedState): string {
  return [r.state, r.source, r.action, r.playback_id, r.idle_variant].join("|");
}

export function createAvatarRuntime(opts: AvatarRuntimeOptions = {}): AvatarRuntime {
  const clock = opts.clock ?? systemClock;
  const random = opts.random ?? Math.random;
  const idleVariants = opts.idle_variants?.length ? opts.idle_variants.slice() : ["idle"];

  let dragging = false;
  let action: ActionInput | null = null;
  let speaking: PlaybackId | null = null;
  let task: TaskStateKind | null = null;
  let idleVariant = idleVariants[0];
  let actionSeq = 0;
  const listeners = new Set<StateListener>();

  function resolve(): ResolvedState {
    const base = { action: null, playback_id: null, idle_variant: null };
    if (dragging) return { ...base, state: "dragging", source: "drag" };
    if (action) return { ...base, state: action.state, source: "action", action: action.name };
    if (speaking !== null) return { ...base, state: "speaking", source: "speaking", playback_id: speaking };
    if (task) return { ...base, state: task, source: "task" };
    return { ...base, state: "idle", source: "idle", idle_variant: idleVariant };
  }

  let last = resolve();

  function emit(): void {
    const next = resolve();
    if (keyOf(last) === keyOf(next)) return;
    const prev = last;
    last = next;
    for (const fn of listeners) {
      try {
        fn(next, prev);
      } catch (err) {
        console.error("[avatar-runtime] listener failed", err);
      }
    }
  }

  function clearAction(): void {
    if (action && action.timer !== null) clock.clearTimer(action.timer);
    action = null;
  }

  const runtime: AvatarRuntime = {
    resolve,
    subscribe(listener) {
      listeners.add(listener);
      listener(resolve(), null);
      return () => {
        listeners.delete(listener);
      };
    },
    setDragging(on) {
      dragging = !!on;
      emit();
    },
    playAction(name, actionOpts = {}) {
      clearAction();
      const token = ++actionSeq;
      const raw = actionOpts.duration_ms;
      const duration = typeof raw === "number" && Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_ACTION_DURATION_MS;
      action = {
        name: String(name),
        state: isAvatarState(actionOpts.state) ? actionOpts.state : "idle",
        token,
        playback_id: actionOpts.playback_id ?? null,
        timer: clock.setTimer(() => runtime.endAction(token), duration),
      };
      emit();
      return token;
    },
    endAction(token) {
      if (!action) return false;
      if (token !== undefined && token !== action.token) return false;
      clearAction();
      emit();
      return true;
    },
    currentAction() {
      return action ? { name: action.name, token: action.token } : null;
    },
    playbackStarted(playback_id) {
      speaking = playback_id;
      emit();
    },
    playbackEnded(playback_id) {
      if (speaking === null || speaking !== playback_id) return;
      speaking = null;
      emit();
    },
    interruptPlayback(playback_id) {
      let stopped = false;
      if (speaking !== null && speaking === playback_id) {
        speaking = null;
        stopped = true;
      }
      if (action && action.playback_id === playback_id) {
        clearAction();
        stopped = true;
      }
      if (stopped) emit();
      return stopped;
    },
    setTaskState(state) {
      if (state === null || state === undefined || state === "idle") {
        task = null;
      } else if (isTaskState(state)) {
        task = state;
      } else {
        console.warn("[avatar-runtime] unknown task state, using idle:", state);
        task = null;
      }
      emit();
    },
    rollIdle() {
      idleVariant = idleVariants[Math.floor(random() * idleVariants.length) % idleVariants.length];
      emit();
      return idleVariant;
    },
  };

  return runtime;
}
