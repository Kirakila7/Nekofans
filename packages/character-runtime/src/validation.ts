// Input validation for character identifiers and upstream memory names.
// Name rules mirror the N.E.K.O upstream checks in
// services/neko-memory/vendor/utils/character_name.py so that a name accepted
// here is not rejected later by the memory service.

import type { CharacterId } from "../../app-contracts/src/index.ts";

export type CharacterErrorCode =
  | "invalid_id"
  | "invalid_name"
  | "invalid_appearance"
  | "not_found"
  | "name_taken"
  | "rename_failed";

/** Single error type for the runtime; `code` is stable and safe to branch on. */
export class CharacterError extends Error {
  readonly code: CharacterErrorCode;

  constructor(code: CharacterErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CharacterError";
    this.code = code;
  }
}

export const UPSTREAM_NAME_MAX_LENGTH = 50;
export const APPEARANCE_ID_MAX_LENGTH = 200;

const CHARACTER_ID_PATTERN = /^character_[0-9a-f]{32}$/;
// Windows forbidden filename characters: < > : " / \ | ? *
const FORBIDDEN_NAME_CHARS = /[<>:"/\\|?*]/;
// C0/C1 control characters, including the NUL byte.
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/;
const RESERVED_DEVICE_NAMES = /^(CON|PRN|AUX|NUL|CLOCK\$|COM[1-9]|LPT[1-9])$/i;

export function isCharacterId(value: unknown): value is CharacterId {
  return typeof value === "string" && CHARACTER_ID_PATTERN.test(value);
}

export function assertCharacterId(value: unknown): asserts value is CharacterId {
  if (!isCharacterId(value)) {
    throw new CharacterError("invalid_id", `character_id must match ${CHARACTER_ID_PATTERN.source}`);
  }
}

/**
 * Returns null when the name is a valid upstream memory name, otherwise a
 * short reason. Names are not normalized: surrounding whitespace is rejected
 * instead of trimmed, so the stored value is exactly what upstream receives.
 */
export function upstreamNameProblem(value: unknown): string | null {
  if (typeof value !== "string") return "must be a string";
  const length = [...value].length;
  if (length < 1 || length > UPSTREAM_NAME_MAX_LENGTH) {
    return `length must be 1-${UPSTREAM_NAME_MAX_LENGTH} characters`;
  }
  if (value.trim() !== value) return "must not start or end with whitespace";
  if (CONTROL_CHARS.test(value)) return "must not contain control characters or NUL";
  if (FORBIDDEN_NAME_CHARS.test(value)) return 'must not contain any of < > : " / \\ | ? *';
  if (value.includes("..")) return 'must not contain ".."';
  if (value.endsWith(".")) return "must not end with a dot";
  // Upstream compares the part before the first dot, so "CON.txt" is reserved too.
  const baseName = value.split(".", 1)[0] ?? "";
  if (RESERVED_DEVICE_NAMES.test(baseName)) return "must not be a Windows reserved device name";
  return null;
}

export function assertUpstreamName(value: unknown): asserts value is string {
  const problem = upstreamNameProblem(value);
  if (problem !== null) {
    throw new CharacterError("invalid_name", `upstream_name ${problem}`);
  }
}

export function assertAppearanceId(value: unknown): asserts value is string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > APPEARANCE_ID_MAX_LENGTH ||
    CONTROL_CHARS.test(value)
  ) {
    throw new CharacterError(
      "invalid_appearance",
      `appearance_id must be a non-empty string of at most ${APPEARANCE_ID_MAX_LENGTH} characters without control characters`,
    );
  }
}
