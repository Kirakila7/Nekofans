// Public entry for character-runtime (F05). This file only re-exports.

export { Character, DEFAULT_MEMORY_SERVICE_URL } from "./character.ts";
export type { CharacterRecord, CharacterStatus, AppearanceBinding, CharacterOptions } from "./character.ts";

export {
  CharacterError,
  UPSTREAM_NAME_MAX_LENGTH,
  isCharacterId,
  assertCharacterId,
  upstreamNameProblem,
} from "./validation.ts";
export type { CharacterErrorCode } from "./validation.ts";

export type { CharacterId } from "../../app-contracts/src/index.ts";
