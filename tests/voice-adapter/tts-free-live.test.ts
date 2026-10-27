// Opt-in live smoke of the N.E.K.O free TTS worker (wss://www.lanlan.tech/tts).
// Run: NEKO_LIVE_FREE=1 node --experimental-strip-types --test tests/voice-adapter/tts-free-live.test.ts
// Sends fixed test sentences only.

import { test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";

import { TtsPlayer, type PlaybackEvent } from "../../packages/voice-adapter/src/tts.ts";
import { SidecarTtsEngine } from "../../packages/voice-adapter/src/tts-sidecar.ts";
import { startTtsSidecar } from "../../packages/voice-adapter/src/tts-sidecar-process.ts";
import { ClockSink } from "../../packages/voice-adapter/src/tts-clock-sink.ts";

const LIVE = process.env.NEKO_LIVE_FREE === "1";
const PORT = 59079;

test("free worker: PCM, started/ended, interrupt drops late frames", { skip: !LIVE && "set NEKO_LIVE_FREE=1", timeout: 90_000 }, async () => {
  const sidecar = await startTtsSidecar({ port: PORT, provider: "free" });
  try {
    const engine = new SidecarTtsEngine({ url: sidecar.ws_url, provider: "free", connect_timeout_ms: 20_000 });
    let pcmBytes = 0;
    let firstAudioAt: number | null = null;
    engine.onEvent((e) => {
      if (e.kind === "audio") {
        pcmBytes += e.pcm.byteLength;
        firstAudioAt ??= Date.now();
      }
    });
    const tConnect = Date.now();
    await engine.connect();
    const connectMs = Date.now() - tConnect;

    const sink = new ClockSink({ lead_ms: 20 });
    const player = new TtsPlayer(engine, sink);
    const events: PlaybackEvent[] = [];
    player.onPlaybackEvent((e) => events.push(e));

    const t0 = Date.now();
    const h1 = player.speak("你好，这是一条语音合成测试。", "default");
    const f1 = await h1.done;
    const firstAudioMs = firstAudioAt! - t0;
    const bytes1 = pcmBytes;
    assert.equal(f1.type, "ended", JSON.stringify(f1));
    assert.ok(bytes1 > 48000, `PCM arrived (${bytes1} bytes)`);
    assert.deepEqual(events.map((e) => e.type), ["queued", "started", "ended"]);

    events.length = 0;
    const h2 = player.speak("这是第二条测试语音，它会在播放中途被打断，后面的内容不应该再播放出来。", "default");
    const deadline = Date.now() + 20_000;
    while (!events.some((e) => e.type === "started") && Date.now() < deadline) await sleep(20);
    await sleep(500);
    const bytesAtStop = pcmBytes;
    h2.stop();
    assert.equal((await h2.done).type, "interrupted");
    await sleep(3_000);
    const stats = await engine.stats();
    const lateToPlayer = player.dropped.audio_bytes;
    assert.equal(sink.records[1].writes_after_stop, 0, "no audio written to the stopped stream");
    assert.equal(stats.dropped_late_bytes, 0, `late frames after landing window: ${stats.dropped_late_bytes}`);

    const report = {
      connect_ms: connectMs,
      first_audio_ms: firstAudioMs,
      utterance1_bytes: bytes1,
      utterance1_audio_ms: f1.audio_ms,
      utterance1_total_ms: f1.at - t0,
      interrupt: {
        bytes_before_stop: bytesAtStop - bytes1,
        engine_bytes_after_stop: pcmBytes - bytesAtStop,
        dropped_by_player_bytes: lateToPlayer,
        sidecar_stats: stats,
      },
    };
    console.log("FREE_TTS_LIVE " + JSON.stringify(report));
    await player.close();
  } finally {
    await sidecar.stop();
  }
});
