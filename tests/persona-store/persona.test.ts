// Persona store tests: load the shipped bigfish persona, validate ids, and
// round-trip edits through a temp personas/ directory.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_PERSONA_ID,
  PersonaError,
  PersonaStore,
  loadPersona,
} from "../../packages/persona-store/src/index.ts";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const BIGFISH_FILE = join(REPO_ROOT, "config", "personas", "bigfish.json");

let tempDir: string;
let store: PersonaStore;

const sample = {
  id: "other_char",
  name: "Other",
  persona: "You are another character.",
  boundaries: ["Never claim bigfish's memories."],
};

before(() => {
  tempDir = mkdtempSync(join(tmpdir(), "persona-store-"));
  store = new PersonaStore(tempDir);
});

after(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

test("loads the shipped bigfish persona", () => {
  const persona = loadPersona(BIGFISH_FILE);
  assert.equal(persona.id, DEFAULT_PERSONA_ID);
  assert.equal(persona.name, "大肥鱼");
  assert.equal(persona.memoryNamespace, "bigfish");
  assert.ok(persona.prompt.startsWith("你是大肥鱼"));
});

test("prompt contains every boundary as a list item", () => {
  const persona = loadPersona(BIGFISH_FILE);
  assert.ok(persona.prompt.includes("\n边界：\n"));
  assert.ok(persona.prompt.includes("- 不把其他角色的经历当成自己的记忆。"));
  assert.equal(persona.prompt.split("\n").filter((l) => l.startsWith("- ")).length, 4);
});

test("memoryNamespace defaults to id", () => {
  const persona = store.save(sample);
  assert.equal(persona.memoryNamespace, "other_char");
});

test("save then get round-trips and leaves no tmp file", () => {
  store.save({ ...sample, name: "Edited", boundaries: ["b1", "b2"], memoryNamespace: "ns" });
  const persona = store.get("other_char");
  assert.equal(persona.name, "Edited");
  assert.equal(persona.memoryNamespace, "ns");
  assert.ok(persona.prompt.endsWith("- b1\n- b2"));
  assert.deepEqual(store.getFile("other_char").boundaries, ["b1", "b2"]);
  assert.deepEqual(readdirSync(tempDir).filter((n) => n.endsWith(".tmp")), []);
  assert.ok(store.list().includes("other_char"));
});

test("invalid ids and path traversal are rejected", () => {
  for (const id of ["../evil", "..\\evil", "Upper", "", "a/b", "a.json", "x".repeat(65)]) {
    assert.throws(() => store.get(id), PersonaError, `get ${JSON.stringify(id)}`);
    assert.throws(() => store.save({ ...sample, id }), PersonaError, `save ${JSON.stringify(id)}`);
  }
  assert.equal(existsSync(join(tempDir, "..", "evil.json")), false);
});

test("invalid persona content is rejected", () => {
  assert.throws(() => store.save({ ...sample, name: "" }), PersonaError);
  assert.throws(() => store.save({ ...sample, persona: "  " }), PersonaError);
  assert.throws(() => store.save({ ...sample, boundaries: "nope" }), PersonaError);
  assert.throws(() => store.save({ ...sample, boundaries: [1] }), PersonaError);
  assert.throws(() => store.save(null), PersonaError);
});

test("get rejects a file whose id does not match its name", () => {
  writeFileSync(join(tempDir, "mismatch.json"), JSON.stringify({ ...sample, id: "someone_else" }));
  assert.throws(() => store.get("mismatch"), PersonaError);
  assert.throws(() => store.get("missing"), PersonaError);
});
