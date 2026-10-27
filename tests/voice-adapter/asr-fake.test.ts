import { test } from "node:test";
import assert from "node:assert/strict";

import { FakeAsrProvider } from "../../packages/voice-adapter/src/asr-fake.ts";
import { AsrInput } from "../../packages/voice-adapter/src/asr.ts";

test("asr-fake: interim partials, final on stop", async () => {
  const provider = new FakeAsrProvider({ partials: ["你", "你好"], final: "你好世界" });
  const asr = new AsrInput(provider, { final_timeout_ms: 1_000 });
  const interims: string[] = [];
  const finals: string[] = [];
  asr.onTranscriptInterim(({ text }) => interims.push(text));
  asr.onTranscriptFinal(({ text }) => finals.push(text));

  const h = asr.startRecording("u1");
  h.pushAudio(new Uint8Array(3200)); // partial[0]: "你"
  h.pushAudio(new Uint8Array(3200)); // partial[1]: "你好"
  h.pushAudio(new Uint8Array(3200)); // exhausted partials
  const result = await h.stop();

  assert.equal(result.kind, "final");
  if (result.kind === "final") assert.equal(result.text, "你好世界");
  assert.deepEqual(interims, ["你", "你好"]);
  assert.deepEqual(finals, ["你好世界"]);
  await asr.close();
});

test("asr-fake: duplicate final", async () => {
  const provider = new FakeAsrProvider({ partials: [], final: "重复", duplicate_final: true });
  const asr = new AsrInput(provider, { final_timeout_ms: 1_000 });
  const finals: string[] = [];
  asr.onTranscriptFinal(({ text }) => finals.push(text));

  const h = asr.startRecording("u2");
  h.pushAudio(new Uint8Array(3200));
  await h.stop();
  await new Promise((r) => setImmediate(r));
  // The provider emits final twice; onTranscriptFinal must see both deliveries.
  assert.deepEqual(finals, ["重复", "重复"]);
  await asr.close();
});

test("asr-fake: stop without audio -> empty", async () => {
  const provider = new FakeAsrProvider({ partials: [], final: "never" });
  const asr = new AsrInput(provider);
  const h = asr.startRecording("u3");
  const result = await h.stop();
  assert.equal(result.kind, "empty");
  await asr.close();
});
