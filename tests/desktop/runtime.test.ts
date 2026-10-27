import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DesktopRuntime } from "../../apps/desktop/runtime.ts";
import { readPersona, readSettings } from "../../apps/desktop/settings.ts";
import { DpapiSecretStore, MemorySecretStore, type SecretStore } from "../../packages/chat-api/src/index.ts";
import type { OpenedMainChat, OpenMainChatOptions } from "../../packages/chat-service/src/config.ts";
import type { PetMode, PetModeOptions } from "../../packages/app-coordinator/src/pet-mode.ts";
import type { ElectronMainLike } from "../../packages/app-coordinator/src/pet-window.ts";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
const validApi = {
  protocol: "openai-compatible", baseUrl: "https://example.invalid/v1", model: "configured-model",
  requestTimeoutMs: 25_000, maxOutputTokens: 512, key: { action: "keep" },
};

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((yes) => { resolve = yes; });
  return { promise, resolve };
}

function fixture(t: TestContext, createSecrets: (dataDir: string) => SecretStore = () => new MemorySecretStore()) {
  const dataDir = mkdtempSync(join(tmpdir(), "desktop-runtime-"));
  const events: string[] = [];
  const chats: Array<{ options: OpenMainChatOptions; opened: OpenedMainChat }> = [];
  const pets: Array<{ options: PetModeOptions; mode: PetMode }> = [];
  const secrets = createSecrets(dataDir);
  const behavior: {
    failPet?: number;
    failStop?: number;
    stopGate?: ReturnType<typeof deferred>;
    startGate?: ReturnType<typeof deferred>;
  } = {};
  let petAttempts = 0;
  const runtime = new DesktopRuntime({
    electron: {} as ElectronMainLike,
    dataDir,
    repositoryRoot,
    openChat(options) {
      const id = chats.length + 1;
      events.push(`open:${id}`);
      const opened = {
        service: { cancel: () => { events.push(`cancel:${id}`); return true; } },
        memory: { list: async () => [], subscribe: () => () => {}, confirm: async () => {}, update: async () => {}, remove: async () => {} },
        secretStore: secrets,
        close: () => { events.push(`close:${id}`); },
      } as unknown as OpenedMainChat;
      chats.push({ options, opened });
      return opened;
    },
    async startPet(options) {
      const id = ++petAttempts;
      events.push(`pet:${id}`);
      if (behavior.failPet === id) throw new Error("private startup detail");
      const gate = behavior.startGate;
      if (gate) await gate.promise;
      const mode = {
        window: () => null,
        stop: async () => {
          events.push(`stop:${id}`);
          if (behavior.stopGate) await behavior.stopGate.promise;
          if (behavior.failStop === id) throw new Error("private teardown detail");
          events.push(`stopped:${id}`);
        },
      } as unknown as PetMode;
      pets.push({ options, mode });
      return mode;
    },
    onPetReady: () => { events.push(`ready:${petAttempts}`); },
  });
  t.after(async () => {
    behavior.startGate?.resolve();
    behavior.stopGate?.resolve();
    await runtime.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });
  return { runtime, dataDir, events, chats, pets, secrets, behavior };
}

test("first start uses unconfigured defaults and passes the current chat and memory into the pet", async (t) => {
  const f = fixture(t);
  await f.runtime.start();
  await f.runtime.start();
  assert.equal(f.chats.length, 1, "starting twice does not reopen databases");
  assert.equal(f.chats[0].options.settings.baseUrl, "");
  assert.equal(f.chats[0].options.settings.model, "");
  assert.equal(f.chats[0].options.settings.personaId, "bigfish");
  assert.equal(f.pets[0].options.chat, f.chats[0].opened.service);
  assert.equal(f.pets[0].options.memory, f.chats[0].opened.memory);
  assert.equal(f.pets[0].options.port, 0);
  assert.equal(f.pets[0].options.store_path, join(f.dataDir, "overlay-bigfish.json"));
  assert.equal(f.pets[0].options.tasks, undefined);
  assert.equal(f.pets[0].options.video, undefined);
  assert.equal(f.runtime.pet(), f.pets[0].mode);
  assert.equal(f.runtime.read().hasKey, false);
  assert.equal(existsSync(f.runtime.configFile), false);
});

test("API save cancels chat, stops the old pet, closes databases and starts fresh instances", async (t) => {
  const f = fixture(t);
  await f.runtime.start();
  f.events.length = 0;
  await f.runtime.saveApi({ ...validApi, apiKey: "discard-me", key: { action: "replace", value: "synthetic-private-key" } });
  assert.deepEqual(f.events, ["cancel:1", "stop:1", "stopped:1", "close:1", "open:2", "pet:2", "ready:2"]);
  assert.notEqual(f.chats[0].opened, f.chats[1].opened);
  assert.notEqual(f.pets[0].mode, f.pets[1].mode);
  assert.equal(f.pets[1].options.memory, f.chats[1].opened.memory);
  assert.equal(f.runtime.pet(), f.pets[1].mode);
  assert.equal(f.chats[1].options.settings.model, "configured-model");
  assert.equal(await f.secrets.get(), "synthetic-private-key");
  const persisted = readFileSync(f.runtime.configFile, "utf8");
  assert.equal(persisted.includes("synthetic-private-key"), false);
  assert.equal(persisted.includes("discard-me"), false);
  assert.deepEqual(JSON.parse(persisted), { schemaVersion: 1, mainChat: f.runtime.read().mainChat });
  assert.equal(f.runtime.read().hasKey, true);
  assert.equal(JSON.stringify(f.runtime.read()).includes("synthetic-private-key"), false);
});

test("keep and clear key actions preserve or remove the secret without exposing it", async (t) => {
  const f = fixture(t);
  await f.secrets.set("original-key");
  await f.runtime.start();
  await f.runtime.saveApi(validApi);
  assert.equal(await f.secrets.get(), "original-key");
  await f.runtime.saveApi({ ...validApi, key: { action: "clear" } });
  assert.equal(await f.secrets.get(), null);
  assert.equal(f.runtime.read().hasKey, false);
});

test("invalid renderer settings reject before cancellation or persisted changes", async (t) => {
  const f = fixture(t);
  await f.runtime.start();
  const before = f.runtime.read();
  f.events.length = 0;
  await assert.rejects(f.runtime.saveApi({ ...validApi, baseUrl: "https://example.invalid/?token=secret" }));
  await assert.rejects(f.runtime.savePersona({ name: "", persona: "text", boundaries: [] }));
  assert.deepEqual(f.events, []);
  assert.deepEqual(f.runtime.read(), before);
  assert.equal(existsSync(f.runtime.configFile), false);
  await f.runtime.saveApi(validApi);
  assert.equal(f.runtime.read().mainChat.model, "configured-model", "a rejected save does not poison the queue");
});

test("a failed API restart restores prior settings and secret and closes the failed instance", async (t) => {
  const f = fixture(t);
  await f.secrets.set("prior-key");
  await f.runtime.start();
  const previous = f.runtime.read().mainChat;
  f.events.length = 0;
  f.behavior.failPet = 2;
  await assert.rejects(
    f.runtime.saveApi({ ...validApi, key: { action: "replace", value: "replacement-key" } }),
    { message: "Settings save failed." },
  );
  assert.deepEqual(f.events, [
    "cancel:1", "stop:1", "stopped:1", "close:1", "open:2", "pet:2", "cancel:2", "close:2",
    "open:3", "pet:3", "ready:3",
  ]);
  assert.deepEqual(readSettings(f.runtime.configFile), previous);
  assert.equal(await f.secrets.get(), "prior-key");
  assert.equal(f.runtime.pet(), f.pets[1].mode);
  assert.deepEqual(f.chats[2].options.settings, previous);
});

test("failed API restart restores the absence of a previous key", async (t) => {
  const f = fixture(t);
  await f.runtime.start();
  f.behavior.failPet = 2;
  await assert.rejects(f.runtime.saveApi({ ...validApi, key: { action: "replace", value: "new-key" } }));
  assert.equal(await f.secrets.get(), null);
  assert.equal(f.runtime.read().hasKey, false);
  assert.equal(f.runtime.read().mainChat.model, "");
});

test("API and persona saves recover the prior runtime when old pet teardown fails", async (t) => {
  for (const kind of ["api", "persona"] as const) {
    const f = fixture(t);
    await f.secrets.set("prior-key");
    await f.runtime.start();
    const previous = f.runtime.read();
    const previousPersona = readPersona(f.runtime.personasDir);
    f.behavior.failStop = 1;
    f.events.length = 0;
    const saving = kind === "api"
      ? f.runtime.saveApi({ ...validApi, key: { action: "replace", value: "new-key" } })
      : f.runtime.savePersona({ name: "New name", persona: "New prompt", boundaries: [] });
    await assert.rejects(saving, { message: kind === "api" ? "Settings save failed." : "Persona save failed." });
    assert.deepEqual(f.events, ["cancel:1", "stop:1", "close:1", "open:2", "pet:2", "ready:2"]);
    assert.deepEqual(f.runtime.read(), previous);
    assert.deepEqual(readPersona(f.runtime.personasDir), previousPersona);
    assert.equal(await f.secrets.get(), "prior-key");
    assert.equal(f.runtime.pet(), f.pets[1].mode);
  }
});

test("persona saves retain namespace and appearance; failed restart restores the previous persona", async (t) => {
  const f = fixture(t);
  await f.runtime.start();
  const previous = readPersona(f.runtime.personasDir);
  const edit = { name: "Custom name", persona: "Custom prompt", boundaries: ["Custom boundary"], id: "other", memoryNamespace: "other" };
  await f.runtime.savePersona(edit);
  const saved = readPersona(f.runtime.personasDir);
  assert.deepEqual(saved, { ...previous, name: edit.name, persona: edit.persona, boundaries: edit.boundaries });
  f.behavior.failPet = 3;
  await assert.rejects(f.runtime.savePersona({ ...edit, name: "Should roll back" }), { message: "Persona save failed." });
  assert.deepEqual(readPersona(f.runtime.personasDir), saved);
  assert.equal(f.chats.length, 4);
  assert.ok(f.runtime.pet());
});

test("concurrent saves serialize resource teardown and read the latest persisted settings", async (t) => {
  const f = fixture(t);
  await f.runtime.start();
  f.events.length = 0;
  f.behavior.stopGate = deferred();
  const first = f.runtime.saveApi({ ...validApi, model: "first-model" });
  const second = f.runtime.saveApi({ ...validApi, model: "second-model" });
  await flush();
  assert.deepEqual(f.events, ["cancel:1", "stop:1"]);
  assert.equal(f.chats.length, 1, "new DB is not opened before the old pet has stopped");
  f.behavior.stopGate.resolve();
  await Promise.all([first, second]);
  assert.deepEqual(f.chats.map((chat) => chat.options.settings.model), ["", "first-model", "second-model"]);
  assert.equal(f.runtime.read().mainChat.model, "second-model");
  assert.deepEqual(f.events, [
    "cancel:1", "stop:1", "stopped:1", "close:1", "open:2", "pet:2", "ready:2",
    "cancel:2", "stop:2", "stopped:2", "close:2", "open:3", "pet:3", "ready:3",
  ]);
});

test("concurrent stop calls wait for teardown, close once, and prohibit later restart or saves", async (t) => {
  const f = fixture(t);
  await f.runtime.start();
  f.events.length = 0;
  f.behavior.stopGate = deferred();
  const first = f.runtime.stop();
  const second = f.runtime.stop();
  await flush();
  assert.deepEqual(f.events, ["cancel:1", "stop:1"]);
  assert.equal(f.runtime.pet(), null);
  f.behavior.stopGate.resolve();
  await Promise.all([first, second]);
  assert.deepEqual(f.events, ["cancel:1", "stop:1", "stopped:1", "close:1"]);
  await assert.rejects(f.runtime.start(), /Desktop is closing/);
  await assert.rejects(f.runtime.saveApi(validApi), /Desktop is closing/);
  await assert.rejects(f.runtime.savePersona({ name: "n", persona: "p", boundaries: [] }), /Desktop is closing/);
});

test("stop during an in-flight save prevents a replacement runtime from being started", async (t) => {
  const f = fixture(t);
  await f.runtime.start();
  f.events.length = 0;
  f.behavior.stopGate = deferred();
  const saving = f.runtime.saveApi(validApi);
  await flush();
  const stopping = f.runtime.stop();
  f.behavior.stopGate.resolve();
  await Promise.all([saving, stopping]);
  assert.deepEqual(f.events, ["cancel:1", "stop:1", "stopped:1", "close:1"]);
  assert.equal(f.chats.length, 1);
  assert.equal(f.runtime.pet(), null);
});

test("stop during initial startup waits until the acquired pet is stopped and database closed", async (t) => {
  const f = fixture(t);
  f.behavior.startGate = deferred();
  const starting = f.runtime.start();
  await flush();
  const stopping = f.runtime.stop();
  assert.deepEqual(f.events, ["open:1", "pet:1"]);
  f.behavior.startGate.resolve();
  await Promise.all([starting, stopping]);
  assert.deepEqual(f.events, ["open:1", "pet:1", "ready:1", "cancel:1", "stop:1", "stopped:1", "close:1"]);
  assert.equal(f.runtime.pet(), null);
});

test("settings can replace a corrupted DPAPI key without decrypting its previous value", { skip: process.platform !== "win32" }, async (t) => {
  const f = fixture(t, (directory) => new DpapiSecretStore(join(directory, "synthetic-key.dpapi")));
  const file = join(f.dataDir, "synthetic-key.dpapi");
  writeFileSync(file, "unreadable-synthetic-ciphertext");
  await assert.rejects(f.secrets.get(), { message: "DPAPI call failed." });
  const reads = t.mock.method(f.secrets, "get");
  await f.runtime.start();
  await f.runtime.saveApi({ ...validApi, key: { action: "replace", value: "repaired-synthetic-key" } });
  assert.equal(reads.mock.callCount(), 0, "saving never decrypts the old key");
  assert.equal(await new DpapiSecretStore(file).get(), "repaired-synthetic-key");
  assert.equal(f.runtime.read().hasKey, true);
  assert.equal(readFileSync(f.runtime.configFile, "utf8").includes("repaired-synthetic-key"), false);
});

test("settings can clear a corrupted DPAPI key without reading it", { skip: process.platform !== "win32" }, async (t) => {
  const f = fixture(t, (directory) => new DpapiSecretStore(join(directory, "synthetic-key.dpapi")));
  const file = join(f.dataDir, "synthetic-key.dpapi");
  writeFileSync(file, Buffer.from([255, 0, 13, 10, 128]));
  const reads = t.mock.method(f.secrets, "get");
  await f.runtime.start();
  await f.runtime.saveApi({ ...validApi, key: { action: "clear" } });
  assert.equal(reads.mock.callCount(), 0);
  assert.equal(existsSync(file), false);
  assert.equal(f.runtime.read().hasKey, false);
  assert.equal(await f.secrets.get(), null);
});

test("failed replacement or clear restores exact unreadable DPAPI bytes and resets the secret cache", { skip: process.platform !== "win32" }, async (t) => {
  for (const action of ["replace", "clear"] as const) {
    const f = fixture(t, (directory) => new DpapiSecretStore(join(directory, "synthetic-key.dpapi")));
    const file = join(f.dataDir, "synthetic-key.dpapi");
    const original = Buffer.from([255, 0, 13, 10, 128]);
    writeFileSync(file, original);
    const reads = t.mock.method(f.secrets, "get");
    await f.runtime.start();
    const previous = f.runtime.read().mainChat;
    f.behavior.failPet = 2;
    await assert.rejects(f.runtime.saveApi({ ...validApi, key: { action, value: "temporary-synthetic-key" } }), { message: "Settings save failed." });
    assert.equal(reads.mock.callCount(), 0, "neither saving nor rollback decrypts the old key");
    assert.deepEqual(readFileSync(file), original, "rollback preserves even non-UTF8 bytes");
    assert.deepEqual(f.runtime.read().mainChat, previous);
    assert.equal(f.runtime.read().hasKey, true);
    assert.ok(f.runtime.pet(), "the prior runtime restarts for another repair attempt");
    await assert.rejects(f.secrets.get(), { message: "DPAPI call failed." });
    assert.equal(JSON.stringify(f.runtime.read()).includes("temporary-synthetic-key"), false);
  }
});
