// Clip selection for the video renderer: resolved state -> clip from an AppearancePack.
// Missing clips fall back to a generic clip for the state, then to idle (ARCHITECTURE.md section 4).

import type { AppearancePack, RelativePath, VideoRenderer } from "../../app-contracts/src/index.ts";
import type { AvatarStateKind, ResolvedState } from "./state-machine.ts";
import { isAvatarState } from "./state-machine.ts";

/** Availability check for a clip path; defaults to "everything is available". */
export type ClipAvailable = (clip: RelativePath) => boolean;

/** States whose clips play once and then report ended (dsh-pet terminal workStatus clips). */
export const DEFAULT_ONCE_STATES: readonly AvatarStateKind[] = Object.freeze(["success", "error"]);

export interface FallbackResult {
  name: RelativePath | null;
  state: AvatarStateKind;
  fell_back: boolean;
}

export interface ClipSelection {
  /** Chosen clip, or null when not even idle is available. */
  clip: RelativePath | null;
  /** Clip key that matched: action name, idle variant, state, or "idle". */
  key: string | null;
  /** State the clip represents after fallback. */
  state: AvatarStateKind;
  fell_back: boolean;
  /** false for one-shot clips that should report ended. */
  loop: boolean;
}

export interface SelectClipOptions {
  available?: ClipAvailable;
  once_states?: readonly AvatarStateKind[];
}

type ClipMap = Readonly<Record<string, RelativePath | readonly RelativePath[] | undefined>>;

const always: ClipAvailable = () => true;

function firstAvailable(map: ClipMap, key: string, has: ClipAvailable): RelativePath | null {
  if (!Object.hasOwn(map, key)) return null;
  const raw = map[key];
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  return list.find((n): n is string => typeof n === "string" && n.length > 0 && has(n)) ?? null;
}

/** Pick the asset for a state from a state-keyed mapping, falling back to idle. */
export function resolveWithFallback(map: ClipMap, state: string, has: ClipAvailable = always): FallbackResult {
  if (isAvatarState(state)) {
    const direct = firstAvailable(map, state, has);
    if (direct) return { name: direct, state, fell_back: false };
  }
  return { name: firstAvailable(map, "idle", has), state: "idle", fell_back: state !== "idle" };
}

/** The video renderer of a pack, or null when the pack has none. */
export function videoRendererOf(pack: AppearancePack): VideoRenderer | null {
  return pack.renderers.video ?? null;
}

/**
 * Select a clip for a resolved state. Lookup order: the action name (explicit
 * action) or idle variant (random idle), then the state itself, then idle.
 */
export function selectClip(
  renderer: VideoRenderer,
  resolved: ResolvedState,
  opts: SelectClipOptions = {},
): ClipSelection {
  const has = opts.available ?? always;
  const once = opts.once_states ?? DEFAULT_ONCE_STATES;
  const clips: ClipMap = renderer.clips;

  const specific = resolved.source === "action" ? resolved.action : resolved.source === "idle" ? resolved.idle_variant : null;
  if (specific) {
    const clip = firstAvailable(clips, specific, has);
    if (clip) return { clip, key: specific, state: resolved.state, fell_back: false, loop: !once.includes(resolved.state) };
  }

  const pick = resolveWithFallback(clips, resolved.state, has);
  return {
    clip: pick.name,
    key: pick.name ? pick.state : null,
    state: pick.state,
    fell_back: pick.fell_back,
    loop: !once.includes(pick.state),
  };
}
