import { test } from "node:test";
import assert from "node:assert/strict";
import type { AppearancePack } from "../../packages/app-contracts/src/index.ts";
import {
  AVATAR_STATES,
  DEFAULT_ONCE_STATES,
  createAvatarRuntime,
  resolveWithFallback,
  selectClip,
  videoRendererOf,
} from "../../packages/avatar-runtime/src/index.ts";
import type { Clock, ResolvedState } from "../../packages/avatar-runtime/src/index.ts";

// Mirrors the F04 "dsh-pet" clip set; listening has no clip on purpose.
const dshPetPack: AppearancePack = {
  schema_version: "0.1-draft",
  sample_only: true,
  pack_id: "pack_sample",
  appearance_id: "appearance_sample",
  display_name: "Sample dsh-pet",
  character_template: { name: "Sample", persona: "sample persona" },
  default_renderer: "video",
  renderers: {
    video: {
      clips: {
        idle: ["webm/idle.webm"],
        idle_yawn: ["webm/idle-yawn.webm"],
        thinking: ["webm/thinking.webm"],
        working: ["webm/working.webm"],
        waiting_user: ["webm/waiting.webm"],
        success: ["webm/success.webm"],
        error: ["webm/error.webm"],
        dragging: ["webm/drag.webm"],
        speaking: ["webm/talk-a.webm", "webm/talk-b.webm", "webm/talk-c.webm"],
        celebrate: ["webm/celebrate.webm"],
      },
    },
  },
};

const video = videoRendererOf(dshPetPack)!;

const noTimers: Clock = { setTimer: () => 0, clearTimer: () => {} };

function resolved(partial: Partial<ResolvedState> & Pick<ResolvedState, "state" | "source">): ResolvedState {
  return { action: null, playback_id: null, idle_variant: null, ...partial };
}

test("resolveWithFallback: missing asset -> idle (F04)", () => {
  const map = { idle: "idle", speaking: ["speak_a", "speak_b"], error: "error" };
  assert.deepEqual(
    resolveWithFallback(map, "speaking", (n) => n === "speak_b" || n === "idle"),
    { name: "speak_b", state: "speaking", fell_back: false },
  );
  assert.deepEqual(resolveWithFallback(map, "error", (n) => n === "idle"), { name: "idle", state: "idle", fell_back: true });
  assert.deepEqual(resolveWithFallback(map, "listening"), { name: "idle", state: "idle", fell_back: true });
  assert.deepEqual(resolveWithFallback(map, "bogus"), { name: "idle", state: "idle", fell_back: true });
  assert.equal(resolveWithFallback({}, "idle").name, null);
});

test("resolveWithFallback ignores inherited keys", () => {
  assert.deepEqual(resolveWithFallback({ idle: "idle" }, "constructor"), { name: "idle", state: "idle", fell_back: true });
});

test("dsh-pet pack: every state resolves; only listening falls back to idle (F04)", () => {
  const fellBack = AVATAR_STATES.filter((state) => selectClip(video, resolved({ state, source: "task" })).fell_back);
  assert.deepEqual(fellBack, ["listening"]);
  for (const state of AVATAR_STATES) assert.ok(selectClip(video, resolved({ state, source: "task" })).clip, state);
});

test("terminal states play once by default (F04)", () => {
  assert.deepEqual(DEFAULT_ONCE_STATES.slice().sort(), ["error", "success"]);
  assert.equal(selectClip(video, resolved({ state: "success", source: "task" })).loop, false);
  assert.equal(selectClip(video, resolved({ state: "working", source: "task" })).loop, true);
  assert.equal(selectClip(video, resolved({ state: "success", source: "task" }), { once_states: [] }).loop, true);
});

test("speaking picks the first available clip", () => {
  const sel = selectClip(video, resolved({ state: "speaking", source: "speaking", playback_id: "pb1" }), {
    available: (c) => c !== "webm/talk-a.webm",
  });
  assert.equal(sel.clip, "webm/talk-b.webm");
  assert.equal(sel.fell_back, false);
});

test("missing clip falls back to idle; missing idle yields null", () => {
  const sel = selectClip(video, resolved({ state: "error", source: "task" }), { available: (c) => c !== "webm/error.webm" });
  assert.deepEqual(sel, { clip: "webm/idle.webm", key: "idle", state: "idle", fell_back: true, loop: true });

  const none = selectClip(video, resolved({ state: "error", source: "task" }), { available: () => false });
  assert.deepEqual(none, { clip: null, key: null, state: "idle", fell_back: true, loop: true });
});

test("explicit action uses its own clip, else the state clip, else idle", () => {
  const own = selectClip(video, resolved({ state: "success", source: "action", action: "celebrate" }));
  assert.deepEqual([own.clip, own.key, own.fell_back], ["webm/celebrate.webm", "celebrate", false]);

  const generic = selectClip(video, resolved({ state: "success", source: "action", action: "unknown-dance" }));
  assert.deepEqual([generic.clip, generic.key, generic.fell_back], ["webm/success.webm", "success", false]);

  const idle = selectClip(video, resolved({ state: "listening", source: "action", action: "unknown-dance" }));
  assert.deepEqual([idle.clip, idle.fell_back], ["webm/idle.webm", true]);
});

test("idle variant uses its clip when present, else plain idle", () => {
  const yawn = selectClip(video, resolved({ state: "idle", source: "idle", idle_variant: "idle_yawn" }));
  assert.deepEqual([yawn.clip, yawn.key, yawn.fell_back], ["webm/idle-yawn.webm", "idle_yawn", false]);

  const missing = selectClip(video, resolved({ state: "idle", source: "idle", idle_variant: "idle_stretch" }));
  assert.deepEqual([missing.clip, missing.key, missing.fell_back], ["webm/idle.webm", "idle", false]);
});

test("videoRendererOf returns null for a pngtuber-only pack", () => {
  const pack: AppearancePack = {
    ...dshPetPack,
    default_renderer: "pngtuber",
    renderers: { pngtuber: { model_path: "model/model.json" } },
  };
  assert.equal(videoRendererOf(pack), null);
});

test("renderer consumes runtime states through subscribe", () => {
  const rt = createAvatarRuntime({ clock: noTimers });
  const shown: Array<string | null> = [];
  rt.subscribe((r) => shown.push(selectClip(video, r).clip));
  rt.setTaskState("listening");
  rt.playbackStarted("pb1");
  rt.setDragging(true);
  assert.deepEqual(shown, ["webm/idle.webm", "webm/idle.webm", "webm/talk-a.webm", "webm/drag.webm"]);
});
