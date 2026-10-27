import { test } from "node:test";
import assert from "node:assert/strict";
import { CodeTaskBridge } from "../../packages/dsh-bridge/src/index.ts";

test("CodeTaskBridge.executeDiff throws Not implemented", () => {
  assert.throws(() => CodeTaskBridge.executeDiff("task-1", "/tmp/project"), /Not implemented/);
});

test("CodeTaskBridge.runChecks throws Not implemented", () => {
  assert.throws(() => CodeTaskBridge.runChecks("task-1", ["lint", "test", "build"]), /Not implemented/);
});
