// F11 neko-tts sidecar (tone worker, offline) through SidecarTtsEngine + TtsPlayer.

import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";

import { TtsPlayer, type EngineEvent, type PlaybackEvent } from "../../packages/voice-adapter/src/tts.ts";
import { SidecarTtsEngine } from "../../packages/voice-adapter/src/tts-sidecar.ts";
import { startTtsSidecar, type TtsSidecarProcess } from "../../packages/voice-adapter/src/tts-sidecar-process.ts";
import { ClockSink } from "../../packages/voice-adapter/src/tts-clock-sink.ts";

// Tests in one file run sequentially and share one sidecar.
const PORT = 59078;
let sidecar: TtsSidecarProcess;

before(async () => {
  sidecar = await startTtsSidecar({ port: PORT, provider: "tone" });
});

after(async () => {
  const code = await sidecar.stop();
  assert.ok(code === 0 || code === null, `sidecar exit ${code}\n${sidecar.output()}`);
});

function engineFor(options: Record<string, number> = {}) {
  return new SidecarTtsEngine({
    url: sidecar.ws_url,
    provider: "tone",
    options: { first_audio_delay_ms: 100, ms_per_char: 60, min_ms: 200, chunk_ms: 50, speed: 4, ...options },
  });
}

test("health lists providers and marks keyed ones not verified", async () => {
  const res = await fetch(`${sidecar.http_url}/health`);
  const body = (await res.json()) as { provider: string; providers_not_verified: string[]; sample_rate: number };
  assert.equal(body.provider, "tone");
  assert.equal(body.sample_rate, 48000);
  assert.ok(body.providers_not_verified.includes("step"));
});

test("engine events: started, PCM, ended for one speech", async () => {
  const engine = engineFor();
  const events: EngineEvent[] = [];
  engine.onEvent((e) => events.push(e));
  await engine.connect();
  assert.equal(engine.worker, "tone");
  await engine.speak("s1", "一二三四五", "default");
  const deadline = Date.now() + 5_000;
  while (!events.some((e) => e.kind === "ended") && Date.now() < deadline) await sleep(20);
  const audio = events.filter((e) => e.kind === "audio");
  const bytes = audio.reduce((n, e) => n + (e.kind === "audio" ? e.pcm.byteLength : 0), 0);
  assert.equal(bytes, 48000 * 2 * 0.3, "5 chars * 60ms = 300ms of 48 kHz PCM16");
  assert.deepEqual(
    events.filter((e) => e.kind !== "audio").map((e) => e.kind),
    ["synth_started", "ended"],
  );
  await engine.close();
});

test("player over sidecar: delayed start, normal end", async () => {
  const player = new TtsPlayer(engineFor(), new ClockSink({ lead_ms: 20 }));
  const events: PlaybackEvent[] = [];
  player.onPlaybackEvent((e) => events.push(e));
  const t0 = Date.now();
  const h = player.speak("你好世界", "default");
  const final = await h.done;
  assert.equal(final.type, "ended");
  assert.equal(final.audio_ms, 240);
  const started = events.find((e) => e.type === "started")!;
  assert.ok(started.at - t0 >= 100, `started after synthesis delay (${started.at - t0}ms)`);
  assert.ok(final.at - started.at >= 220);
  assert.deepEqual(events.map((e) => e.type), ["queued", "started", "ended"]);
  await player.close();
});

test("interrupt mid-play stops audio; next speech is not cleared by stale events", async () => {
  const engine = engineFor({ ms_per_char: 150, speed: 1 });
  const sink = new ClockSink({ lead_ms: 20 });
  const player = new TtsPlayer(engine, sink);
  const events: PlaybackEvent[] = [];
  player.onPlaybackEvent((e) => events.push(e));
  const a = player.speak("第一句话会被下一句打断", "default");
  await sleep(400);
  const b = player.speak("第二句", "default");
  assert.equal((await a.done).type, "interrupted");
  assert.equal((await b.done).type, "ended");
  const seq = events.map((e) => `${e.type}:${e.playback_id === a.playback_id ? "a" : "b"}`);
  assert.deepEqual(seq, ["queued:a", "started:a", "interrupted:a", "queued:b", "started:b", "ended:b"]);
  assert.equal(sink.records[0].writes_after_stop, 0);
  const stats = await engine.stats();
  assert.equal(stats.interrupts, 1);
  assert.equal(stats.dropped_late_bytes, 0, "no PCM after the landing window");
  await player.close();
});

test("unknown provider is rejected before ready", async () => {
  const engine = new SidecarTtsEngine({ url: sidecar.ws_url, provider: "nope" });
  await assert.rejects(engine.connect(), /PROVIDER_UNAVAILABLE/);
});

test("step provider without key is rejected (config path only, not called)", async () => {
  const engine = new SidecarTtsEngine({ url: sidecar.ws_url, provider: "step" });
  await assert.rejects(engine.connect(), /API key not configured/);
});

test("browser origins other than localhost are rejected", async () => {
  const bad = await fetch(`${sidecar.http_url}/shutdown`, { method: "POST", headers: { origin: "https://evil.example" } });
  assert.equal(bad.status, 403);
  const ws = new WebSocket(sidecar.ws_url, { headers: { origin: "https://evil.example" } } as unknown as string[]);
  const closed = await new Promise<string>((resolve) => {
    ws.addEventListener("open", () => resolve("open"));
    ws.addEventListener("error", () => resolve("error"));
    ws.addEventListener("close", () => resolve("close"));
  });
  assert.notEqual(closed, "open");
  const ok = await fetch(`${sidecar.http_url}/health`, { headers: { origin: "http://127.0.0.1:59070" } });
  assert.equal(ok.status, 200);
});
