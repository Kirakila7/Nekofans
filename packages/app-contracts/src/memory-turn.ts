// TypeScript mirror of contracts/memory-turn.schema.json (schema_version "0.1-draft").
// Keep this file in sync with the JSON schema; the schema is the source of truth.

/** Stable character identifier: "character_" followed by 32 lowercase hex chars. */
export type CharacterId = `character_${string}`;

export type MemoryTurnSourceKind = "text" | "voice" | "task_feedback";
export type MemoryTurnScope = "user" | "character" | "project";
export type AssistantDelivery = "text_only" | "audio_complete" | "audio_partial" | "audio_not_played";

/** One conversation turn submitted to the memory service. */
export interface MemoryTurn {
  schema_version: "0.1-draft";
  sample_only?: boolean;
  character_id: CharacterId;
  turn_id: string;
  source_kind: MemoryTurnSourceKind;
  /** ISO 8601 date-time. */
  created_at: string;
  scope: MemoryTurnScope;
  /** Required when scope is "project". */
  project_id?: string | null;
  session_id?: string | null;
  task_id?: string | null;
  /** Required when source_kind is "voice". */
  utterance_id?: string | null;
  audio_ref?: string | null;
  user_text: string;
  assistant_text: string;
  assistant_delivery: AssistantDelivery;
  user_explicit_confirmation?: boolean;
  supersedes_turn_id?: string | null;
}
