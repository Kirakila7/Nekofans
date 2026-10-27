// Persona store: loads and saves independent character personas from
// personas/<id>.json. Each persona keeps its own id and memoryNamespace so chat
// history and memory never mix between characters.

import { readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { Persona, PersonaId } from "../../app-contracts/src/chat.ts";

export const DEFAULT_PERSONA_ID: PersonaId = "bigfish";

const PERSONA_ID_RE = /^[a-z0-9_-]{1,64}$/;

/** On-disk persona shape (config/personas/<id>.json). Extra fields are kept as-is. */
export interface PersonaFile {
  id: string;
  name: string;
  persona: string;
  boundaries: string[];
  memoryNamespace?: string;
  [extra: string]: unknown;
}

export class PersonaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PersonaError";
  }
}

export function assertPersonaId(id: unknown): asserts id is PersonaId {
  if (typeof id !== "string" || !PERSONA_ID_RE.test(id)) {
    throw new PersonaError(`invalid persona id: ${JSON.stringify(id)}`);
  }
}

function nonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new PersonaError(`persona ${field} must be a non-empty string`);
  }
  return value;
}

/** Validates a parsed persona JSON value and returns it typed. */
export function validatePersonaFile(value: unknown): PersonaFile {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new PersonaError("persona must be a JSON object");
  }
  const raw = value as Record<string, unknown>;
  assertPersonaId(raw.id);
  nonEmptyString(raw.name, "name");
  nonEmptyString(raw.persona, "persona");
  if (!Array.isArray(raw.boundaries) || !raw.boundaries.every((b) => typeof b === "string")) {
    throw new PersonaError("persona boundaries must be a string array");
  }
  if (raw.memoryNamespace !== undefined) {
    nonEmptyString(raw.memoryNamespace, "memoryNamespace");
  }
  return raw as PersonaFile;
}

/** Builds the runtime Persona; prompt = persona text plus the boundary list. */
export function toPersona(file: PersonaFile): Persona {
  const lines = [file.persona.trim()];
  if (file.boundaries.length > 0) {
    lines.push("", "边界：", ...file.boundaries.map((b) => `- ${b}`));
  }
  return {
    id: file.id,
    name: file.name,
    prompt: lines.join("\n"),
    memoryNamespace: file.memoryNamespace ?? file.id,
  };
}

function readPersonaFile(file: string): PersonaFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new PersonaError(`cannot read persona ${file}: ${(error as Error).message}`);
  }
  return validatePersonaFile(parsed);
}

export function loadPersona(file: string): Persona {
  return toPersona(readPersonaFile(file));
}

/** Directory-backed persona store: <dir>/<id>.json. */
export class PersonaStore {
  readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
  }

  private pathOf(id: PersonaId): string {
    assertPersonaId(id);
    return join(this.dir, `${id}.json`);
  }

  get(id: PersonaId): Persona {
    const file = readPersonaFile(this.pathOf(id));
    if (file.id !== id) {
      throw new PersonaError(`persona file ${id}.json declares id ${JSON.stringify(file.id)}`);
    }
    return toPersona(file);
  }

  /** Raw editable JSON for a persona. */
  getFile(id: PersonaId): PersonaFile {
    return readPersonaFile(this.pathOf(id));
  }

  list(): PersonaId[] {
    return readdirSync(this.dir)
      .filter((name) => name.endsWith(".json"))
      .map((name) => name.slice(0, -".json".length))
      .filter((id) => PERSONA_ID_RE.test(id))
      .sort();
  }

  /** Validates and writes atomically (tmp file then rename). */
  save(personaJson: unknown): Persona {
    const file = validatePersonaFile(personaJson);
    const target = this.pathOf(file.id);
    const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(file, null, 2)}\n`, "utf8");
    renameSync(tmp, target);
    return toPersona(file);
  }
}
