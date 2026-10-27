// F11 TtsPlayer lifecycle over the in-process fake engine and clock sink.

import { test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";

import { TtsPlayer, type PlaybackEvent } from "../../packages/voice-adapter/src/tts.ts";
import { FakeTtsEngine, fakeToneMs, pcmToWav, tonePcm } from "../../packages/voice-adapter/src/tts-fake.ts";
import { ClockSink } from "../../packages/voice-adapter/src/tts-clock-sink.ts";

function setup(opts: ConstructorParameters<typeof FakeTtsEngine>[0] = {}) {
  const engine = new FakeTtsEngine({ first_audio_delay_ms: 80, ms_per_char: 40, min_ms: 200, chunk_ms: 50, speed: 4, ...opts });
  const sink = new ClockSink({ lead_ms: 20 });
  const player = new TtsPlayer(engine, sink);
  const events: PlaybackEvent[] = [];
  player.onPlaybackEvent((e) => events.push(e));
  return { engine, sink, player, events };
}

test("fake engine: text-proportional tone and WAV header", () => {
  assert.equal(fakeToneMs("ab", { ms_per_char: 50, min_ms: 10 }), 100);
  assert.equal(fakeToneMs("", { min_ms: 300 }), 300);
  const pcm = tonePcm(100, 48000);
  assert.equal(pcm.byteLength, 4800 * 2);
  const wav = pcmToWav(pcm, 48000);
  assert.equal(new TextDecoder().decode(wav.slice(0, 4)), "RIFF");
  assert.equal(new DataView(wav.buffer).getUint32(40, true), pcm.byteLength);
});

test("delayed start: queued first, started only once audio plays, then ended", async () => {
  const { player, events } = setup();
  const t0 = Date.now();
  const h = player.speak("你好呀世界", "default");
  assert.deepEqual(events.map((e) => e.type), ["queued"]);
  assert.equal(player.current, h.playback_id);
  await sleep(40);
  assert.deepEqual(events.map((e) => e.type), ["queued"], "no started before synthesis delay");
  const final = await h.done;
  assert.equal(final.type, "ended");
  assert.equal(final.type === "ended" && final.reason, "completed");
  const started = events.find((e) => e.type === "started")!;
  assert.ok(started.at - t0 >= 80, `started after delay (${started.at - t0}ms)`);
  // Audio is 5 chars * 40ms = 200ms; ended must not come before it played.
  assert.ok(final.at - started.at >= 180, `ended after audio played (${final.at - started.at}ms)`);
  assert.equal(final.audio_ms, 200);
  assert.deepEqual(events.map((e) => e.type), ["queued", "started", "ended"]);
  assert.equal(player.current, null);
});

test("stop() mid-play interrupts once; later engine audio is dropped", async () => {
  const { player, events, sink, engine } = setup({ ms_per_char: 100, speed: 1 });
  const h = player.speak("一二三四五六七八", "default");
  await sleep(200);
  assert.equal(events.at(-1)?.type, "started");
  h.stop();
  h.stop();
  const final = await h.done;
  assert.equal(final.type, "interrupted");
  assert.equal(final.type === "interrupted" && final.reason, "stopped");
  assert.deepEqual(engine.calls.interrupt, [h.playback_id]);
  // A late done marker and late audio for the interrupted id.
  engine.inject({ kind: "audio", speech_id: h.playback_id, pcm: tonePcm(50), sample_rate: 48000 });
  engine.inject({ kind: "ended", speech_id: h.playback_id });
  await sleep(50);
  assert.deepEqual(events.map((e) => e.type), ["queued", "started", "interrupted"]);
  assert.equal(sink.records[0].writes_after_stop, 0);
  assert.ok(player.dropped.audio_bytes > 0);
  assert.equal(player.dropped.events, 1);
});

test("new speak() preempts the current playback", async () => {
  const { player, events } = setup({ ms_per_char: 100, speed: 1 });
  const a = player.speak("第一句话比较长一些", "default");
  await sleep(150);
  const b = player.speak("第二句", "default");
  const fa = await a.done;
  assert.equal(fa.type, "interrupted");
  assert.equal(fa.type === "interrupted" && fa.reason, "preempted");
  const fb = await b.done;
  assert.equal(fb.type, "ended");
  const seq = events.map((e) => `${e.type}:${e.playback_id === a.playback_id ? "a" : "b"}`);
  assert.deepEqual(seq, ["queued:a", "started:a", "interrupted:a", "queued:b", "started:b", "ended:b"]);
});

test("stop() before audio starts: interrupted, never started", async () => {
  const { player, events, sink } = setup({ first_audio_delay_ms: 100 });
  const h = player.speak("还没开始", "default");
  await sleep(30);
  h.stop();
  await sleep(250);
  assert.deepEqual(events.map((e) => e.type), ["queued", "interrupted"]);
  assert.equal(sink.records.length, 0);
});

test("engine error ends the playback with reason error", async () => {
  const { player, engine } = setup({ first_audio_delay_ms: 500 });
  const h = player.speak("错误", "default");
  engine.inject({ kind: "error", speech_id: h.playback_id, error_code: "X", error_message: "boom" });
  const final = await h.done;
  assert.equal(final.type, "ended");
  assert.equal(final.type === "ended" && final.reason, "error");
  await player.close();
});

test("empty text is rejected", () => {
  const { player } = setup();
  assert.throws(() => player.speak("  ", "default"), /empty text/);
});
