import { test } from "node:test";
import assert from "node:assert/strict";
import { ArtifactService } from "../../packages/artifact-service/src/index.ts";

test("createVersion throws Not implemented", () => {
  assert.throws(() => ArtifactService.createVersion("art-1", "out/v2.mp4"), /Not implemented \(F16 stub\)/);
});

test("listVersions throws Not implemented", () => {
  assert.throws(() => ArtifactService.listVersions("art-1"), /Not implemented \(F16 stub\)/);
});

test("checkIdempotency throws Not implemented", () => {
  assert.throws(() => ArtifactService.checkIdempotency("key-1"), /Not implemented \(F16 stub\)/);
});
