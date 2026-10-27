import { test } from "node:test";
import assert from "node:assert/strict";
import { VideoTaskBridge } from "../../packages/dsh-bridge/src/index.ts";

test("submitGenerationRequest throws Not implemented", () => {
  assert.throws(
    () =>
      VideoTaskBridge.submitGenerationRequest({
        task_id: "t1",
        provider: "stub",
        prompt: "wave",
        duration_sec: 3,
      }),
    /Not implemented/,
  );
});

test("pollStatus throws Not implemented", () => {
  assert.throws(() => VideoTaskBridge.pollStatus("job-1"), /Not implemented/);
});

test("downloadResult throws Not implemented", () => {
  assert.throws(() => VideoTaskBridge.downloadResult("job-1", "out.mp4"), /Not implemented/);
});
