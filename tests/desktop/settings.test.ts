import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  atomicJson, initializeData, isSettingsSender, parseApiChange, parsePersonaChange, readPersona, readSettings,
} from "../../apps/desktop/settings.ts";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const validApi = {
  protocol: "openai-compatible", baseUrl: "https://example.invalid/v1", model: "test-model",
  requestTimeoutMs: 30_000, maxOutputTokens: 2048, key: { action: "keep" },
};

test("API settings whitelist excludes renderer-supplied identity, keys and extras", () => {
  const change = parseApiChange({
    ...validApi, personaId: "other-persona", apiKey: "must-not-persist", secret: "must-not-persist",
    provider: "untrusted", apiKeyStorage: "plain", arbitrary: { nested: "field" },
    key: { action: "replace", value: "  synthetic-secret  ", extra: "discard" },
  });
  assert.deepEqual(change.settings, {
    personaId: "bigfish", protocol: "openai-compatible", baseUrl: validApi.baseUrl,
    model: validApi.model, requestTimeoutMs: 30_000, maxOutputTokens: 2048,
  });
  assert.deepEqual(change.key, { action: "replace", value: "synthetic-secret" });
  assert.equal(JSON.stringify(change.settings).includes("secret"), false);
});

test("API URL policy allows HTTPS and loopback HTTP, rejects credentials and URL secrets", () => {
  for (const baseUrl of ["https://example.invalid/v1", "http://127.0.0.1:12345/v1", "http://localhost:12345/v1", "http://[::1]:12345/v1"]) {
    assert.equal(parseApiChange({ ...validApi, baseUrl }).settings.baseUrl, baseUrl);
  }
  for (const baseUrl of [
    "http://example.invalid/v1", "file:///tmp/key", "javascript:alert(1)", "not a URL",
    "https://user:password@example.invalid/v1", "https://user@example.invalid/v1",
    "https://example.invalid/v1?key=secret", "https://example.invalid/v1#secret",
  ]) assert.throws(() => parseApiChange({ ...validApi, baseUrl }), baseUrl);
});

test("API settings can return to unconfigured state but reject partial configuration and invalid limits", () => {
  const empty = parseApiChange({ ...validApi, baseUrl: " ", model: " ", key: { action: "clear" } });
  assert.equal(empty.settings.baseUrl, "");
  assert.equal(empty.settings.model, "");
  assert.deepEqual(empty.key, { action: "clear" });
  for (const extra of [
    { baseUrl: "" }, { model: "" }, { protocol: "unknown" }, { model: "x".repeat(201) },
    { requestTimeoutMs: 300_001 }, { requestTimeoutMs: 999 }, { requestTimeoutMs: "1000" },
    { maxOutputTokens: 0 }, { maxOutputTokens: 32_001 }, { maxOutputTokens: 1.5 },
  ]) assert.throws(() => parseApiChange({ ...validApi, ...extra }));
  for (const value of [null, [], "invalid", 1]) assert.throws(() => parseApiChange(value));
});

test("API key actions require an explicit valid operation and omit ignored values", () => {
  for (const action of ["keep", "clear"]) {
    assert.deepEqual(parseApiChange({ ...validApi, key: { action, value: "discard-me" } }).key, { action });
  }
  for (const key of [undefined, null, [], {}, { action: "other" }, { action: "replace", value: " " },
    { action: "replace", value: "first\nsecond" }, { action: "replace", value: "first\rsecond" },
    { action: "replace", value: "x".repeat(16_385) }, { action: "replace", value: 123 }]) {
    assert.throws(() => parseApiChange({ ...validApi, key }));
  }
});

test("persona edits retain trusted identity, memory namespace, appearance and extension fields", () => {
  const current = {
    id: "bigfish", name: "Original", persona: "Original prompt", boundaries: ["old"],
    memoryNamespace: "independent-bigfish", appearance: "original-pack", extension: { version: 2 },
  };
  const next = parsePersonaChange({
    id: "other", memoryNamespace: "other", appearance: "remote-pack", extension: null,
    name: "  New name  ", persona: " New prompt ", boundaries: [" first ", " ", "second"],
  }, current);
  assert.deepEqual(next, { ...current, name: "New name", persona: "New prompt", boundaries: ["first", "second"] });
  assert.equal(current.name, "Original");
  assert.deepEqual(current.boundaries, ["old"]);
  for (const extra of [
    { name: " " }, { name: "x".repeat(81) }, { persona: "" }, { persona: "x".repeat(12_001) },
    { boundaries: null }, { boundaries: [1] }, { boundaries: ["x".repeat(1001)] },
    { boundaries: Array(31).fill("boundary") },
  ]) assert.throws(() => parsePersonaChange({ name: "n", persona: "p", boundaries: [], ...extra }, current));
});

test("first-run data initialization copies defaults without overwriting user persona or config", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "desktop-settings-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const paths = initializeData(dir, repositoryRoot);
  assert.equal(existsSync(paths.configFile), false);
  assert.equal(readSettings(paths.configFile).baseUrl, "");
  const initial = readPersona(paths.personasDir);
  const updated = { ...initial, name: "User-selected name", persona: "User-authored prompt" };
  writeFileSync(join(paths.personasDir, "bigfish.json"), JSON.stringify(updated));
  atomicJson(paths.configFile, { mainChat: { model: "preserved-model" } });
  assert.deepEqual(initializeData(dir, repositoryRoot), paths);
  assert.deepEqual(readPersona(paths.personasDir), updated);
  assert.equal(readSettings(paths.configFile).model, "preserved-model");
  assert.deepEqual(readdirSync(dir).filter((name) => name.endsWith(".tmp")), []);
});

test("readSettings refuses selecting a different desktop persona", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "desktop-settings-read-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "app-config.json");
  atomicJson(file, { mainChat: { personaId: "other" } });
  assert.throws(() => readSettings(file), /Unsupported desktop persona/);
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { mainChat: { personaId: "other" } });
});

test("upgrading the shipped DSH capability sentence preserves user persona and custom boundaries", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "desktop-persona-migration-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const paths = initializeData(dir, repositoryRoot);
  const persona = { ...readPersona(paths.personasDir), name: "User name", persona: "User-authored content", extension: 42,
    boundaries: ["A custom rule", "不能直接布置或执行 DSH 任务。当前开发版本尚未接入内置 DSH，用户需要执行任务时应如实说明。"] };
  writeFileSync(join(paths.personasDir, "bigfish.json"), JSON.stringify(persona));
  initializeData(dir, repositoryRoot);
  const updated = readPersona(paths.personasDir);
  assert.deepEqual({ ...updated, boundaries: persona.boundaries }, persona);
  assert.equal(updated.boundaries[0], "A custom rule");
  assert.ok(updated.boundaries[1].includes("右键菜单打开内置 DSH"));
});

test("settings IPC accepts only the exact window, main frame and current settings URL", () => {
  const url = "file:///app/apps/desktop/settings.html";
  const frame = { url };
  let currentUrl = url;
  let destroyed = false;
  const contents = { mainFrame: frame, getURL: () => currentUrl, isDestroyed: () => destroyed };
  const event = { sender: contents, senderFrame: frame };
  assert.equal(isSettingsSender(event, contents, url), true);
  assert.equal(isSettingsSender({ ...event, sender: {} }, contents, url), false);
  assert.equal(isSettingsSender({ ...event, senderFrame: { url } }, contents, url), false);
  assert.equal(isSettingsSender({ sender: contents }, contents, url), false);
  assert.equal(isSettingsSender({ ...event, senderFrame: null }, contents, url), false);
  currentUrl = "https://example.invalid/";
  assert.equal(isSettingsSender(event, contents, url), false);
  currentUrl = url;
  frame.url = "file:///app/apps/desktop/settings.html#other";
  assert.equal(isSettingsSender(event, contents, url), false);
  frame.url = url;
  destroyed = true;
  assert.equal(isSettingsSender(event, contents, url), false);
});
