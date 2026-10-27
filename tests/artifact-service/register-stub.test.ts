import { test } from "node:test";
import assert from "node:assert/strict";
import { ArtifactService } from "../../packages/artifact-service/src/index.ts";

test("register stub throws Not implemented", () => {
  assert.throws(
    () =>
      ArtifactService.register({
        task_id: "task-demo",
        kind: "text",
        path: "artifacts/demo.md",
        production_method: "authored",
      }),
    /Not implemented/,
  );
});

test("validate stub throws Not implemented", () => {
  assert.throws(() => ArtifactService.validate("artifact-demo"), /Not implemented/);
});

test("openInViewer and listByTask stubs throw Not implemented", () => {
  assert.throws(() => ArtifactService.openInViewer("artifact-demo"), /Not implemented/);
  assert.throws(() => ArtifactService.listByTask("task-demo"), /Not implemented/);
});
