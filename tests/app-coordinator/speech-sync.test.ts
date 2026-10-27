// F11 speech-sync: playback lifecycle -> avatar-runtime speaking state.

import { test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";

import { createAvatarRuntime, type ResolvedState } from "../../packages/avatar-runtime/src/index.ts";
import { createSpeechSync } from "../../packages/app-coordinator/src/speech-sync.ts";
import { TtsPlayer } from "../../packages/voice-adapter/src/tts.ts";
import { FakeTtsEngine } from "../../packages/voice-adapter/src/tts-fake.ts";
import { ClockSink } from "../../packages/voice-adapter/src/tts-clock-sink.ts";

function setup(opts: ConstructorParameters<typeof FakeTtsEngine>[0] = {}) {
  const engine = new FakeTtsEngine({ first_audio_delay_ms: 80, ms_per_char: 60, min_ms: 200, chunk_ms: 50, speed: 4, ...opts });
  const player = new TtsPlayer(engine, new ClockSink({ lead_ms: 20 }));
  const runtime = createAvatarRuntime();
  const states: Array<{ state: string; playback_id: string | null; at: number }> = [];
  runtime.subscribe((r: ResolvedState) => states.push({ state: r.state, playback_id: r.playback_id, at: Date.now() }));
  const sync = createSpeechSync(player, runtime);
  return { engine, player, runtime, states, sync };
}

const seq = (states: Array<{ state: string }>) => states.map((s) => s.state);

test("delay before start: avatar stays idle until audio is audible", async () => {
  const { runtime, states, sync } = setup({ first_audio_delay_ms: 150 });
  const h = sync.speak("你好", "default");
  await sleep(100);
  assert.equal(runtime.resolve().state, "idle", "queued playback must not show speaking");
  await sleep(120);
  assert.equal(runtime.resolve().state, "speaking");
  assert.equal(runtime.resolve().playback_id, h.playback_id);
  await h.done;
  assert.deepEqual(seq(states), ["idle", "speaking", "idle"]);
});

test("normal end: speaking -> idle after the audio duration", async () => {
  const { states, sync } = setup();
  const h = sync.speak("一二三四五", "default");
  const final = await h.done;
  assert.equal(final.type, "ended");
  assert.deepEqual(seq(states), ["idle", "speaking", "idle"]);
  const spoken = states[2].at - states[1].at;
  assert.ok(spoken >= 280, `speaking lasted ${spoken}ms for 300ms of audio`);
});

test("interrupt mid-play: speaking clears immediately", async () => {
  const { runtime, states, sync } = setup({ ms_per_char: 150, speed: 1 });
  const h = sync.speak("这句话会被打断的", "default");
  await sleep(250);
  assert.equal(runtime.resolve().state, "speaking");
  const t = Date.now();
  assert.equal(sync.interrupt(), true);
  assert.equal(runtime.resolve().state, "idle");
  assert.ok(states.at(-1)!.at - t < 20);
  assert.equal((await h.done).type, "interrupted");
  assert.equal(sync.interrupt(), false, "nothing left to interrupt");
});

test("stale end of an interrupted playback does not clear the new speaking state", async () => {
  const { engine, runtime, states, sync } = setup({ ms_per_char: 150, speed: 1 });
  const a = sync.speak("第一句很长很长", "default");
  await sleep(200);
  const b = sync.speak("第二句也挺长的", "default");
  assert.equal((await a.done).type, "interrupted");
  await sleep(200);
  assert.equal(runtime.resolve().playback_id, b.playback_id);
  // Late done marker and audio from the interrupted speech.
  engine.inject({ kind: "ended", speech_id: a.playback_id });
  engine.inject({ kind: "interrupted", speech_id: a.playback_id });
  // And a direct stale call on the runtime, as a misbehaving bridge would do.
  runtime.playbackEnded(a.playback_id);
  assert.equal(runtime.resolve().state, "speaking");
  assert.equal(runtime.resolve().playback_id, b.playback_id);
  assert.equal((await b.done).type, "ended");
  assert.deepEqual(
    states.map((s) => `${s.state}:${s.playback_id === a.playback_id ? "a" : s.playback_id === b.playback_id ? "b" : "-"}`),
    ["idle:-", "speaking:a", "idle:-", "speaking:b", "idle:-"],
  );
});

test("interrupt also stops an action bound to the playback", async () => {
  const { player, runtime, sync } = setup({ ms_per_char: 150, speed: 1 });
  const h = sync.speak("边说边做动作", "default");
  runtime.playAction("wave", { playback_id: h.playback_id, state: "happy", duration_ms: 10_000 });
  assert.equal(runtime.resolve().source, "action");
  sync.interrupt();
  assert.equal(runtime.resolve().state, "idle");
  assert.equal(runtime.currentAction(), null);
  await player.close();
});

test("dispose stops following playback events", async () => {
  const { runtime, sync } = setup();
  sync.dispose();
  const h = sync.speak("不同步", "default");
  await h.done;
  assert.equal(runtime.resolve().state, "idle");
});
