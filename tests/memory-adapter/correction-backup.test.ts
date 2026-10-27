// F08 unit tests: correctFact, forgetFact, exportBackup, restoreBackup with mock server.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  correctFact,
  forgetFact,
  exportBackup,
  restoreBackup,
} from "../../packages/memory-adapter/src/correction-backup.ts";
import { Character } from "../../packages/character-runtime/src/index.ts";

const PORT = 59041;
const BASE_URL = `http://127.0.0.1:${PORT}`;

let server: Server | null = null;
let workDir: string;
let dbPath: string;

before(() => {
  workDir = mkdtempSync(join(tmpdir(), "f08-unit-"));
  dbPath = join(workDir, "app.sqlite");

  const characters = Character.open({ dbPath });
  const record = characters.create("TestCat", "TestCat");
  characters.close();

  // Mock server: return success for correctFact, forgetFact, exportBackup, and restoreBackup.
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.url?.startsWith("/correct_fact/")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "ok", old_text: "old", new_fact_id: "fact_20250101120000_abcdef12" }));
    } else if (req.url?.startsWith("/forget_fact/")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "ok", removed: true }));
    } else if (req.url?.startsWith("/export_backup/")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "ok", backup_file: join(workDir, "backup.tar.gz"), size: 1024 }));
    } else if (req.url?.startsWith("/restore_backup/")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "ok", character_id: record.character_id, restored_files: ["facts.json"] }));
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  server.listen(PORT);
});

after(() => {
  server?.close();
  rmSync(workDir, { recursive: true, force: true });
});

test("correctFact succeeds when the upstream responds ok", async () => {
  const characters = Character.open({ dbPath });
  const record = characters.load(characters.characterIdForMemoryKey("TestCat"));
  characters.close();

  const result = await correctFact({
    memoryServiceUrl: BASE_URL,
    dbPath,
    character_id: record.character_id,
    fact_id: "fact_001",
    corrected_text: "corrected text喵",
  });
  assert.equal(result.status, "ok");
  assert.equal(result.old_text, "old");
  assert.ok(result.new_fact_id);
});

test("forgetFact succeeds when the upstream responds ok", async () => {
  const characters = Character.open({ dbPath });
  const record = characters.load(characters.characterIdForMemoryKey("TestCat"));
  characters.close();

  const result = await forgetFact({
    memoryServiceUrl: BASE_URL,
    dbPath,
    character_id: record.character_id,
    fact_id: "fact_001",
  });
  assert.equal(result.status, "ok");
  assert.ok(result.removed);
});

test("exportBackup succeeds when the upstream responds ok", async () => {
  const characters = Character.open({ dbPath });
  const record = characters.load(characters.characterIdForMemoryKey("TestCat"));
  characters.close();

  const result = await exportBackup({
    memoryServiceUrl: BASE_URL,
    dbPath,
    character_id: record.character_id,
  });
  assert.equal(result.status, "ok");
  assert.ok(result.backup_file);
  assert.ok(result.size && result.size > 0);
});

test("restoreBackup succeeds when the upstream responds ok", async () => {
  const characters = Character.open({ dbPath });
  const record = characters.load(characters.characterIdForMemoryKey("TestCat"));
  characters.close();

  const result = await restoreBackup({
    memoryServiceUrl: BASE_URL,
    dbPath,
    character_id: record.character_id,
    backup_file: join(workDir, "backup.tar.gz"),
  });
  assert.equal(result.status, "ok");
  assert.equal(result.character_id, record.character_id);
  assert.ok(result.restored_files.length > 0);
});
