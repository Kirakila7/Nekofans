// Framework v1 step 2: DPAPI key store round-trip (Windows only).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DpapiSecretStore, MemorySecretStore } from "../../packages/chat-api/src/index.ts";

const dirs: string[] = [];
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

test("DPAPI store: set, get after reopen, ciphertext is not the plain key, clear", { skip: process.platform !== "win32" }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "chat-key-"));
  dirs.push(dir);
  const file = join(dir, "secrets", "chat-api-key.dpapi");
  const plain = "sk-测试-key-0123456789";

  const a = new DpapiSecretStore(file);
  assert.equal(a.has(), false);
  assert.equal(await a.get(), null);
  await a.set(`  ${plain}  `);
  assert.equal(a.has(), true);
  const onDisk = readFileSync(file, "utf8");
  assert.ok(!onDisk.includes(plain) && !onDisk.includes("sk-"), "file holds ciphertext only");
  assert.ok(!existsSync(`${file}.tmp`));

  const b = new DpapiSecretStore(file);
  assert.equal(await b.get(), plain, "a fresh store decrypts it");

  await b.clear();
  assert.equal(b.has(), false);
  assert.equal(await b.get(), null);
  await assert.rejects(b.set("   "), /empty/);
});

test("memory store", async () => {
  const s = new MemorySecretStore();
  assert.equal(await s.get(), null);
  await s.set(" k ");
  assert.equal(await s.get(), "k");
  await s.clear();
  assert.equal(s.has(), false);
});

test("DPAPI rollback restores a missing key without retaining the newly decrypted cache", { skip: process.platform !== "win32" }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "chat-key-")); dirs.push(dir);
  const file = join(dir, "key.dpapi");
  const store = new DpapiSecretStore(file);
  const rollback = await store.prepareRollback();
  await store.set("synthetic-transient-key");
  await rollback();
  assert.equal(store.has(), false);
  assert.equal(await store.get(), null);
});
