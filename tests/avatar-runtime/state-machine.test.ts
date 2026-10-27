import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createAvatarRuntime,
  AVATAR_STATES,
  TASK_STATES,
  isAvatarState,
  isTaskState,
  DEFAULT_ACTION_DURATION_MS,
} from "../../packages/avatar-runtime/src/index.ts";
import type { Clock, TimerHandle } from "../../packages/avatar-runtime/src/index.ts";

function fakeClock(): Clock & { fireAll(): void; pending(): number; delays: number[] } {
  const queue = new Map<number, () => void>();
  const delays: number[] = [];
  let id = 0;
  return {
    delays,
    pending: () => queue.size,
    setTimer(fn: () => void, ms: number): TimerHandle {
      delays.push(ms);
      id++;
      queue.set(id, fn);
      return id;
    },
    clearTimer(handle: TimerHandle): void {
      queue.delete(handle as number);
    },
    fireAll(): void {
      const entries = [...queue.entries()];
      queue.clear();
      for (const [, fn] of entries) fn();
    },
  };
}

test("contract lists exactly the 9 states", () => {
  assert.deepEqual(AVATAR_STATES, [
    "idle",
    "listening",
    "thinking",
    "working",
    "speaking",
    "waiting_user",
    "success",
    "error",
    "dragging",
  ]);
});

test("contract lists exactly the 6 task states", () => {
  assert.deepEqual(TASK_STATES, ["listening", "thinking", "working", "waiting_user", "success", "error"]);
});

test("isAvatarState and isTaskState", () => {
  assert.ok(isAvatarState("idle"));
  assert.ok(!isAvatarState("bogus"));
  assert.ok(isTaskState("thinking"));
  assert.ok(!isTaskState("idle"));
  assert.ok(!isTaskState("dragging"));
});

test("priority: dragging > action > speaking > task > idle", () => {
  const clock = fakeClock();
  const rt = createAvatarRuntime({ clock });

  assert.equal(rt.resolve().state, "idle");
  assert.equal(rt.resolve().source, "idle");

  rt.setTaskState("working");
  assert.equal(rt.resolve().state, "working");
  assert.equal(rt.resolve().source, "task");

  rt.playbackStarted("pb1");
  assert.equal(rt.resolve().state, "speaking");
  assert.equal(rt.resolve().source, "speaking");
  assert.equal(rt.resolve().playback_id, "pb1");

  rt.playAction("celebrate", { state: "success" });
  assert.equal(rt.resolve().state, "success");
  assert.equal(rt.resolve().source, "action");
  assert.equal(rt.resolve().action, "celebrate");

  rt.setDragging(true);
  assert.equal(rt.resolve().state, "dragging");
  assert.equal(rt.resolve().source, "drag");

  rt.setDragging(false);
  assert.equal(rt.resolve().state, "success");

  clock.fireAll(); // action timeout
  assert.equal(rt.resolve().state, "speaking");

  rt.playbackEnded("pb1");
  assert.equal(rt.resolve().state, "working");

  rt.setTaskState(null);
  assert.equal(rt.resolve().state, "idle");
  assert.equal(rt.resolve().source, "idle");
});

test("stale playbackEnded does not cut a newer playback", () => {
  const rt = createAvatarRuntime({ clock: fakeClock() });

  rt.playbackStarted("pb1");
  assert.equal(rt.resolve().state, "speaking");
  assert.equal(rt.resolve().playback_id, "pb1");

  rt.playbackStarted("pb2");
  assert.equal(rt.resolve().state, "speaking");
  assert.equal(rt.resolve().playback_id, "pb2");

  rt.playbackEnded("pb1");
  assert.equal(rt.resolve().state, "speaking", "stale end should not clear speaking");
  assert.equal(rt.resolve().playback_id, "pb2");

  rt.playbackEnded("pb2");
  assert.equal(rt.resolve().state, "idle");
});

test("interruptPlayback stops both speaking and bound action", () => {
  const rt = createAvatarRuntime({ clock: fakeClock() });

  rt.playbackStarted("pb1");
  rt.playAction("celebrate", { state: "success", playback_id: "pb1" });
  assert.equal(rt.resolve().state, "success");
  assert.equal(rt.resolve().source, "action");

  const stopped = rt.interruptPlayback("pb1");
  assert.ok(stopped);
  assert.equal(rt.resolve().state, "idle", "interrupt should clear both");
  assert.equal(rt.currentAction(), null);
});

test("interruptPlayback returns false when nothing was bound to that playback", () => {
  const rt = createAvatarRuntime({ clock: fakeClock() });
  rt.playbackStarted("pb1");
  assert.equal(rt.interruptPlayback("pb2"), false);
  assert.equal(rt.resolve().state, "speaking", "unrelated interrupt does not stop speaking");
});

test("stale action endAction is ignored", () => {
  const rt = createAvatarRuntime({ clock: fakeClock() });
  const a = rt.playAction("a", { state: "success" });
  rt.playAction("b", { state: "error" });
  assert.equal(rt.resolve().action, "b");
  assert.equal(rt.endAction(a), false, "stale token should be ignored");
  assert.equal(rt.resolve().action, "b");
});

test("action expiry calls endAction with the right token", () => {
  const clock = fakeClock();
  const rt = createAvatarRuntime({ clock });
  const token = rt.playAction("temp", { state: "success", duration_ms: 1000 });
  assert.equal(rt.resolve().state, "success");
  clock.fireAll();
  assert.equal(rt.resolve().state, "idle");
  assert.equal(rt.currentAction(), null);
  assert.equal(rt.endAction(token), false, "already ended by expiry");
});

test("non-positive or missing duration falls back to the default bound", () => {
  for (const duration_ms of [undefined, 0, -10, Number.NaN]) {
    const clock = fakeClock();
    const rt = createAvatarRuntime({ clock });
    rt.playAction("a", { state: "success", duration_ms });
    assert.deepEqual(clock.delays, [DEFAULT_ACTION_DURATION_MS], `duration_ms=${duration_ms}`);
    assert.equal(rt.resolve().state, "success");
    clock.fireAll();
    assert.equal(rt.resolve().state, "idle");
  }
});

test("a new action replaces the old one and cancels its timer", () => {
  const clock = fakeClock();
  const rt = createAvatarRuntime({ clock });
  rt.playAction("a", { state: "success", duration_ms: 100 });
  rt.playAction("b", { state: "error", duration_ms: 200 });
  assert.equal(clock.pending(), 1);
  clock.fireAll();
  assert.equal(rt.resolve().state, "idle");
});

test("unknown action state shows idle while the action holds", () => {
  const rt = createAvatarRuntime({ clock: fakeClock() });
  rt.setTaskState("working");
  rt.playAction("wave", { state: "bogus" as never });
  assert.deepEqual([rt.resolve().state, rt.resolve().source, rt.resolve().action], ["idle", "action", "wave"]);
});

test("unknown task state falls back to idle", () => {
  const rt = createAvatarRuntime({ clock: fakeClock() });
  const warn = console.warn;
  const warnings: unknown[][] = [];
  console.warn = (...args: unknown[]) => warnings.push(args);
  rt.setTaskState("dancing" as never);
  console.warn = warn;
  assert.equal(rt.resolve().state, "idle");
  assert.ok(warnings.some((w) => w.some((m) => String(m).includes("unknown task state"))));
});

test("setTaskState with 'idle' clears the task state", () => {
  const rt = createAvatarRuntime({ clock: fakeClock() });
  rt.setTaskState("thinking");
  assert.equal(rt.resolve().state, "thinking");
  rt.setTaskState("idle");
  assert.equal(rt.resolve().state, "idle");
});

test("random idle only changes the idle variant", () => {
  const rt = createAvatarRuntime({
    clock: fakeClock(),
    idle_variants: ["idle", "idle_yawn"],
    random: () => 0.9,
  });

  rt.setTaskState("thinking");
  const variant = rt.rollIdle();
  assert.equal(variant, "idle_yawn");
  assert.equal(rt.resolve().state, "thinking", "rollIdle does not change the resolved state");

  rt.setTaskState(null);
  assert.equal(rt.resolve().state, "idle");
  assert.equal(rt.resolve().idle_variant, variant);
});

test("subscribe emits immediately, then only on change", () => {
  const rt = createAvatarRuntime({ clock: fakeClock() });
  const seen: string[] = [];
  const unsub = rt.subscribe((r) => seen.push(r.state));

  rt.setTaskState("thinking");
  rt.setTaskState("thinking");
  rt.setDragging(false);

  assert.deepEqual(seen, ["idle", "thinking"]);
  unsub();

  rt.setTaskState("working");
  assert.deepEqual(seen, ["idle", "thinking"], "unsubscribed listener should not be called");
});

test("subscribe passes prev on change", () => {
  const rt = createAvatarRuntime({ clock: fakeClock() });
  const history: Array<{ next: string; prev: string | null }> = [];
  rt.subscribe((next, prev) => history.push({ next: next.state, prev: prev?.state ?? null }));

  rt.setTaskState("working");
  rt.setDragging(true);

  assert.deepEqual(history, [
    { next: "idle", prev: null },
    { next: "working", prev: "idle" },
    { next: "dragging", prev: "working" },
  ]);
});

test("drag override interrupts everything", () => {
  const rt = createAvatarRuntime({ clock: fakeClock() });
  rt.setTaskState("thinking");
  rt.playbackStarted("pb1");
  rt.playAction("celebrate", { state: "success" });
  assert.equal(rt.resolve().state, "success");

  rt.setDragging(true);
  assert.equal(rt.resolve().state, "dragging");
  assert.equal(rt.resolve().source, "drag");

  rt.setDragging(false);
  assert.equal(rt.resolve().state, "success", "action should still be running");
});

test("drag during speaking keeps the playback; end while dragging still applies", () => {
  const rt = createAvatarRuntime({ clock: fakeClock() });
  rt.playbackStarted("pb1");
  rt.setDragging(true);
  rt.playbackEnded("pb1");
  assert.equal(rt.resolve().state, "dragging");
  rt.setDragging(false);
  assert.equal(rt.resolve().state, "idle");
});

test("interrupt of the current playback leaves an unbound action running", () => {
  const rt = createAvatarRuntime({ clock: fakeClock() });
  rt.playbackStarted("pb1");
  rt.playAction("menu-wave", { state: "success" });
  assert.equal(rt.interruptPlayback("pb1"), true);
  assert.equal(rt.resolve().action, "menu-wave");
  rt.endAction();
  assert.equal(rt.resolve().state, "idle");
});

test("interrupt of an old playback does not stop a newer one", () => {
  const rt = createAvatarRuntime({ clock: fakeClock() });
  rt.playbackStarted("pb1");
  rt.playbackStarted("pb2");
  assert.equal(rt.interruptPlayback("pb1"), false);
  assert.equal(rt.resolve().playback_id, "pb2");
});

test("a failing listener does not block other listeners", () => {
  const rt = createAvatarRuntime({ clock: fakeClock() });
  const err = console.error;
  console.error = () => {};
  const seen: string[] = [];
  rt.subscribe((r) => {
    if (r.state !== "idle") throw new Error("boom");
  });
  rt.subscribe((r) => seen.push(r.state));
  rt.setTaskState("error");
  console.error = err;
  assert.deepEqual(seen, ["idle", "error"]);
});
