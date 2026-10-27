import { test } from "node:test";
import assert from "node:assert/strict";
import { VoiceService } from "../../packages/voice-adapter/src/index.ts";
import { FakeAsrProvider } from "../../packages/voice-adapter/src/asr-fake.ts";
import { configureAsr } from "../../packages/voice-adapter/src/asr.ts";

test("VoiceService ASR: startRecording + onTranscriptFinal over the configured provider", async () => {
  const input = configureAsr(new FakeAsrProvider({ partials: ["喵"], final: "喵喵" }));
  const finals: Array<{ utterance_id: string; text: string }> = [];
  const off = VoiceService.onTranscriptFinal((e) => finals.push(e));

  const handle = VoiceService.startRecording();
  assert.equal(typeof handle.utterance_id, "string");
  handle.pushAudio(new Uint8Array(320));
  const result = await handle.stop();

  assert.deepEqual(result, { kind: "final", utterance_id: handle.utterance_id, text: "喵喵" });
  assert.deepEqual(finals, [{ utterance_id: handle.utterance_id, text: "喵喵" }]);
  off();
  await input.close();
});

test("VoiceService.speak returns a PlaybackHandle over the configured TTS", async () => {
  const { configureTts } = await import("../../packages/voice-adapter/src/tts.ts");
  const { FakeTtsEngine } = await import("../../packages/voice-adapter/src/tts-fake.ts");
  const { ClockSink } = await import("../../packages/voice-adapter/src/tts-clock-sink.ts");
  configureTts(new FakeTtsEngine({ first_audio_delay_ms: 10, min_ms: 50, speed: 10 }), new ClockSink({ lead_ms: 5 }));
  const handle = VoiceService.speak("hello", "default");
  assert.equal(typeof handle.playback_id, "string");
  assert.equal(typeof handle.stop, "function");
  handle.stop();
  assert.equal((await handle.done).type, "interrupted");
});
