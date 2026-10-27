// F10 offline: services/neko-asr sidecar with the test-only scripted worker and
// the upstream dummy worker. No model, no network beyond 127.0.0.1.
import { test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";

import { SidecarAsrProvider, startAsrSidecar } from "../../packages/voice-adapter/src/asr-sidecar.ts";
import { AsrInput } from "../../packages/voice-adapter/src/asr.ts";

// Tests in one file run sequentially, so they reuse one port.
const PORT = 59068;

async function withSidecar(
  provider: string,
  env: Record<string, string>,
  fn: (asr: AsrInput, sidecar: SidecarAsrProvider) => Promise<void>,
) {
  const proc = await startAsrSidecar({ port: PORT, provider, env });
  const sidecar = new SidecarAsrProvider({ url: proc.ws_url, language: "zh" });
  const asr = new AsrInput(sidecar, { final_timeout_ms: 10_000 });
  try {
    await fn(asr, sidecar);
  } catch (err) {
    console.log("=== neko-asr output ===\n", proc.output());
    throw err;
  } finally {
    await asr.close();
    const code = await proc.stop();
    assert.equal(code, 0, `sidecar exit code ${code}`);
  }
}

test("health reports provider and unverified cloud routes", async () => {
  const proc = await startAsrSidecar({ port: PORT, provider: "scripted" });
  try {
    const health = (await (await fetch(`${proc.http_url}/health`)).json()) as Record<string, unknown>;
    assert.equal(health.provider, "scripted");
    assert.ok((health.cloud_providers_not_verified as string[]).includes("qwen"));
    assert.equal(health.whisper_model, "base");
  } finally {
    assert.equal(await proc.stop(), 0);
  }
});

test("scripted worker: interims then one final, keyed by utterance_id", async () => {
  await withSidecar("scripted", { NEKO_ASR_SCRIPT: "测|测试|测试识别|测试识别文本" }, async (asr, sidecar) => {
    const interims: Array<[string, string]> = [];
    const finals: Array<[string, string]> = [];
    asr.onTranscriptInterim(({ utterance_id, text }) => interims.push([utterance_id, text]));
    asr.onTranscriptFinal(({ utterance_id, text }) => finals.push([utterance_id, text]));

    const h = asr.startRecording("sc-1");
    for (let i = 0; i < 4; i++) h.pushAudio(new Uint8Array(3200));
    const result = await h.stop();
    assert.equal(sidecar.worker, "scripted");
    assert.deepEqual(result, { kind: "final", utterance_id: "sc-1", text: "测试识别文本" });
    assert.deepEqual(interims, [["sc-1", "测"], ["sc-1", "测试"], ["sc-1", "测试识别"]]);
    assert.deepEqual(finals, [["sc-1", "测试识别文本"]]);

    // Second push-to-talk on the same connection gets its own utterance_id.
    const h2 = asr.startRecording("sc-2");
    h2.pushAudio(new Uint8Array(3200));
    const r2 = await h2.stop();
    assert.equal(r2.utterance_id, "sc-2");
    assert.equal(r2.kind, "final");
  });
});

test("scripted worker: stop without audio is empty", async () => {
  await withSidecar("scripted", {}, async (asr) => {
    const finals: string[] = [];
    asr.onTranscriptFinal(({ text }) => finals.push(text));
    const result = await asr.startRecording("sc-empty").stop();
    assert.equal(result.kind, "empty");
    await sleep(50);
    assert.deepEqual(finals, []);
  });
});

test("scripted worker: duplicate final is forwarded for downstream dedup", async () => {
  await withSidecar("scripted", { NEKO_ASR_SCRIPT: "部分|最终", NEKO_ASR_SCRIPT_DUPLICATE_FINAL: "1" }, async (asr) => {
    const finals: string[] = [];
    asr.onTranscriptFinal(({ text }) => finals.push(text));
    const h = asr.startRecording("sc-dup");
    h.pushAudio(new Uint8Array(3200));
    await h.stop();
    await sleep(100);
    assert.deepEqual(finals, ["最终", "最终"]);
  });
});

test("upstream dummy worker: final per commit", async () => {
  await withSidecar("dummy", {}, async (asr, sidecar) => {
    const h = asr.startRecording("dm-1");
    h.pushAudio(new Uint8Array(3200));
    const result = await h.stop();
    assert.equal(sidecar.worker, "dummy");
    assert.equal(result.kind, "final");
    if (result.kind === "final") assert.ok(result.text.length > 0);
  });
});

test("cloud provider is refused as not verified", async () => {
  const proc = await startAsrSidecar({ port: PORT, provider: "qwen" });
  const sidecar = new SidecarAsrProvider({ url: proc.ws_url });
  try {
    await assert.rejects(sidecar.start("x"), /ASR_PROVIDER_NOT_VERIFIED/);
  } finally {
    await sidecar.close();
    assert.equal(await proc.stop(), 0);
  }
});
