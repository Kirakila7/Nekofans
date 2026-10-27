import { test } from "node:test";
import assert from "node:assert/strict";
import { UpdateService, BackupService } from "../../packages/app-coordinator/src/update-backup.ts";

test("UpdateService.checkForUpdates throws Not implemented", () => {
  assert.throws(() => UpdateService.checkForUpdates(), /Not implemented/);
});

test("BackupService.createManualBackup throws Not implemented", () => {
  assert.throws(() => BackupService.createManualBackup("./backup-out"), /Not implemented/);
});
