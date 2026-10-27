// F05 identity test: create, bind appearance, rename through a mock memory
// service, then reload by character_id. The database lives in a temp dir so
// nothing is written to the current working directory.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Character, CharacterError } from "../../packages/character-runtime/src/index.ts";

const MOCK_PORT = 59005;
// The mock rejects this name so the rollback path can be exercised.
const REJECTED_NAME = "upstream-refuses";

interface LoggedRequest {
  method: string;
  url: string;
  body: unknown;
}

const requestLog: LoggedRequest[] = [];
let server: Server;
let tempDir: string;
let characters: Character;

function startMockMemoryService(): Promise<Server> {
  const mock = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      let body: unknown = null;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        body = null;
      }
      const entry: LoggedRequest = { method: req.method ?? "", url: req.url ?? "", body };
      requestLog.push(entry);
      console.log(`[mock-memory-service] ${entry.method} ${entry.url} ${JSON.stringify(entry.body)}`);

      res.setHeader("content-type", "application/json");
      if (req.method !== "POST" || req.url !== "/rename") {
        res.statusCode = 404;
        res.end(JSON.stringify({ success: false, message: "not found" }));
        return;
      }
      const newName = (body as { new_name?: unknown } | null)?.new_name;
      const ok = newName !== REJECTED_NAME;
      res.end(JSON.stringify({ success: ok, message: ok ? "renamed" : "rejected by mock" }));
    });
  });
  return new Promise((resolve, reject) => {
    mock.once("error", reject);
    mock.listen(MOCK_PORT, "127.0.0.1", () => resolve(mock));
  });
}

before(async () => {
  server = await startMockMemoryService();
  tempDir = mkdtempSync(join(tmpdir(), "neko-fish-f05-"));
  characters = Character.open({ dbPath: join(tempDir, "app.sqlite") });
});

after(async () => {
  characters.close();
  rmSync(tempDir, { recursive: true, force: true });
  await new Promise<void>((resolve) => server.close(() => resolve()));
  console.log(`[mock-memory-service] request log (${requestLog.length}):`);
  console.log(JSON.stringify(requestLog, null, 2));
});

test("create, bind appearance, rename, and reload keep one character_id", async () => {
  const created = characters.create("大肥鱼");
  assert.match(created.character_id, /^character_[0-9a-f]{32}$/);
  assert.equal(created.upstream_name, "大肥鱼");
  assert.equal(created.display_name, "大肥鱼");
  assert.equal(created.status, "active");

  const binding = characters.bindAppearance(created.character_id, "demo-blue-fish-look");
  assert.equal(binding.appearance_id, "demo-blue-fish-look");
  assert.equal(binding.is_active, true);

  const renamed = await characters.rename(created.character_id, "鱼酱");
  assert.equal(renamed.character_id, created.character_id);

  const loaded = characters.load(created.character_id);
  assert.equal(loaded.upstream_name, "鱼酱");
  assert.equal(loaded.display_name, "鱼酱");
  assert.equal(loaded.status, "active");
  assert.equal(characters.memoryKey(created.character_id), "鱼酱");
  assert.equal(characters.characterIdForMemoryKey("鱼酱"), created.character_id);
  assert.equal(characters.activeAppearance(created.character_id)?.appearance_id, "demo-blue-fish-look");

  const renameCalls = requestLog.filter((r) => r.url === "/rename");
  assert.equal(renameCalls.length, 1);
  assert.deepEqual(renameCalls[0]?.body, {
    character_id: created.character_id,
    old_name: "大肥鱼",
    new_name: "鱼酱",
  });
});

test("failed upstream rename rolls back the local name", async () => {
  const created = characters.create("Rollback Fish");
  await assert.rejects(
    characters.rename(created.character_id, REJECTED_NAME),
    (error: unknown) => error instanceof CharacterError && error.code === "rename_failed",
  );
  const loaded = characters.load(created.character_id);
  assert.equal(loaded.upstream_name, "Rollback Fish");
  assert.equal(loaded.display_name, "Rollback Fish");
  assert.equal(loaded.status, "active");
});

test("rebinding keeps a single active appearance", () => {
  const created = characters.create("Switch Fish");
  characters.bindAppearance(created.character_id, "pngtuber-look");
  characters.bindAppearance(created.character_id, "video-look");
  assert.equal(characters.activeAppearance(created.character_id)?.appearance_id, "video-look");
  assert.equal(characters.memoryKey(created.character_id), "Switch Fish");
});

test("invalid upstream names are rejected", () => {
  const invalid = ["", "a".repeat(51), "a..b", "fish.", "CON", "nul", "LPT1.txt", "a<b", "a\\b", "a\u0000b", " fish"];
  for (const name of invalid) {
    assert.throws(
      () => characters.create(name),
      (error: unknown) => error instanceof CharacterError && error.code === "invalid_name",
      `expected rejection for ${JSON.stringify(name)}`,
    );
  }
});

test("names colliding case-insensitively are rejected", () => {
  characters.create("Fish");
  assert.throws(
    () => characters.create("fish"),
    (error: unknown) => error instanceof CharacterError && error.code === "name_taken",
  );
});

test("memory keys only resolve with the registered casing", () => {
  const created = characters.create("BigFish");
  assert.equal(characters.characterIdForMemoryKey("BigFish"), created.character_id);
  assert.throws(
    () => characters.characterIdForMemoryKey("bigfish"),
    (error: unknown) => error instanceof CharacterError && error.code === "not_found",
  );
});

test("unknown or malformed character ids are rejected", () => {
  assert.throws(
    () => characters.load("character_" + "0".repeat(32)),
    (error: unknown) => error instanceof CharacterError && error.code === "not_found",
  );
  assert.throws(
    () => characters.load("大肥鱼"),
    (error: unknown) => error instanceof CharacterError && error.code === "invalid_id",
  );
});
