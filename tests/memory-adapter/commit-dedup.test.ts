// F06: commit + replay dedup against a mock memory-service on port 59006.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";

import type { CharacterId, MemoryTurn } from "../../packages/app-contracts/src/index.ts";
import { Character } from "../../packages/character-runtime/src/index.ts";
import { MemoryClient } from "../../packages/memory-adapter/src/index.ts";

interface LoggedRequest {
  method: string;
  url: string;
  body: Record<string, unknown>;
}

const MOCK_PORT = 59006;
const requests: LoggedRequest[] = [];
const tmp = mkdtempSync(join(tmpdir(), "f06-"));
const cwdSqliteBefore = readdirSync(process.cwd()).filter((f) => f.endsWith(".sqlite"));

type Reply = { status: number; body: unknown };

function startServer(port: number, reply: () => Reply): Promise<Server> {
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      requests.push({ method: req.method ?? "", url: req.url ?? "", body: raw ? JSON.parse(raw) : {} });
      const r = reply();
      res.writeHead(r.status, { "content-type": "application/json" });
      res.end(JSON.stringify(r.body));
    });
  });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve(server)));
}

function makeTurn(character_id: string, turn_id: string): MemoryTurn {
  return {
    schema_version: "0.1-draft",
    character_id: character_id as CharacterId,
    turn_id,
    source_kind: "text",
    created_at: new Date().toISOString(),
    scope: "user",
    user_text: `user ${turn_id}`,
    assistant_text: `assistant ${turn_id}`,
    assistant_delivery: "text_only",
  };
}

let mock: Server;

before(async () => {
  mock = await startServer(MOCK_PORT, () => ({ status: 200, body: { status: "cached", count: 1 } }));
});

after(() => {
  mock.close();
  rmSync(tmp, { recursive: true, force: true });
  const cwdSqliteAfter = readdirSync(process.cwd()).filter((f) => f.endsWith(".sqlite"));
  assert.deepEqual(cwdSqliteAfter, cwdSqliteBefore, "no .sqlite left in cwd");
});

test("t001 twice -> second AlreadySubmitted; t002 once -> success", async () => {
  const db_path = join(tmp, "app.sqlite");
  const store = Character.open({ dbPath: db_path });
  const character = store.create("Test Character");
  store.close();

  const client = new MemoryClient({ db_path, base_url: `http://127.0.0.1:${MOCK_PORT}` });
  requests.length = 0;

  const first = await client.commitTurn(makeTurn(character.character_id, "t001"));
  assert.equal(first.kind, "submitted");
  assert.equal(first.kind === "submitted" && first.status, "pending");
  assert.equal(requests.length, 1);

  // Request path and payload shape.
  const req = requests[0];
  assert.equal(req.method, "POST");
  assert.equal(req.url, `/cache/${encodeURIComponent(character.upstream_name)}`);
  assert.equal(req.body.language, "zh");
  assert.equal(typeof req.body.input_history, "string");
  assert.deepEqual(JSON.parse(req.body.input_history as string), [
    { role: "user", content: "user t001" },
    { role: "assistant", content: "assistant t001" },
  ]);

  const replay = await client.commitTurn(makeTurn(character.character_id, "t001"));
  assert.deepEqual(replay, { kind: "already_submitted", turn_id: "t001" });
  assert.equal(requests.length, 1, "replay must not reach memory-service");

  const second = await client.commitTurn(makeTurn(character.character_id, "t002"));
  assert.equal(second.kind, "submitted");
  assert.equal(requests.length, 2);

  assert.equal(client.replayCheck("t001"), true);
  assert.equal(client.replayCheck("t002"), true);
  assert.equal(client.replayCheck("t003"), false);

  if (first.kind === "submitted") {
    assert.equal(client.markSubmitted(first.receipt_id, "t001"), true);
    assert.equal(client.markSubmitted(first.receipt_id, "t002"), false);
  }
  client.close();

  // Receipts survive a reopen (restart).
  const reopened = new MemoryClient({ db_path, base_url: `http://127.0.0.1:${MOCK_PORT}` });
  const afterRestart = await reopened.commitTurn(makeTurn(character.character_id, "t001"));
  assert.equal(afterRestart.kind, "already_submitted");
  assert.equal(requests.length, 2);
  reopened.close();
});

test("upstream errors return error and write no receipt", async () => {
  const db_path = join(tmp, "app-errors.sqlite");
  const store = Character.open({ dbPath: db_path });
  const character = store.create("Error Character");
  store.close();

  let next: Reply = { status: 200, body: {} };
  const errServer = await startServer(0, () => next);
  const port = (errServer.address() as AddressInfo).port;
  const client = new MemoryClient({ db_path, base_url: `http://127.0.0.1:${port}` });

  next = {
    status: 409,
    body: { ok: false, error_code: "storage_startup_blocked", blocking_reason: "runtime_initializing" },
  };
  const blocked = await client.commitTurn(makeTurn(character.character_id, "e001"));
  assert.equal(blocked.kind === "error" && blocked.code, "storage_startup_blocked");

  next = { status: 200, body: { status: "error", message: "boom" } };
  const bodyError = await client.commitTurn(makeTurn(character.character_id, "e001"));
  assert.equal(bodyError.kind === "error" && bodyError.code, "service_error");

  next = { status: 500, body: { detail: "internal" } };
  const httpError = await client.commitTurn(makeTurn(character.character_id, "e001"));
  assert.equal(httpError.kind === "error" && httpError.code, "http_error");

  assert.equal(client.replayCheck("e001"), false, "failed commits leave no receipt");

  // Service recovers: the same turn is written exactly once.
  next = { status: 200, body: { status: "cached", count: 1 } };
  const recovered = await client.commitTurn(makeTurn(character.character_id, "e001"));
  assert.equal(recovered.kind, "submitted");
  const again = await client.commitTurn(makeTurn(character.character_id, "e001"));
  assert.equal(again.kind, "already_submitted");

  const unknown = await client.commitTurn(makeTurn("character_missing", "e002"));
  assert.equal(unknown.kind === "error" && unknown.code, "unknown_character");

  client.close();
  await new Promise((resolve) => errServer.close(resolve));
});
