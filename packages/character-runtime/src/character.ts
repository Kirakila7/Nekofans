// Character identity store backed by app.sqlite (node:sqlite).
// character_id is the stable key for every other module; upstream_name is the
// name the N.E.K.O memory service files memories under and may change on rename.

import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { SQLOutputValue } from "node:sqlite";

import type { CharacterId } from "../../app-contracts/src/index.ts";
import { SCHEMA_SQL } from "./schema.ts";
import {
  CharacterError,
  assertAppearanceId,
  assertCharacterId,
  assertUpstreamName,
} from "./validation.ts";

export type CharacterStatus = "active" | "renaming";

export interface CharacterRecord {
  character_id: CharacterId;
  upstream_name: string;
  display_name: string;
  created_at: string;
  updated_at: string;
  status: CharacterStatus;
}

export interface AppearanceBinding {
  character_id: CharacterId;
  appearance_id: string;
  bound_at: string;
  is_active: boolean;
}

export interface CharacterOptions {
  /** Path to app.sqlite. Required so the database never lands in an implicit cwd. */
  dbPath: string;
  /** Base URL of the memory-service adapter. */
  memoryServiceUrl?: string;
  /** Timeout for the rename request. */
  renameTimeoutMs?: number;
}

export const DEFAULT_MEMORY_SERVICE_URL = "http://127.0.0.1:59005";
const DEFAULT_RENAME_TIMEOUT_MS = 10_000;

type Row = Record<string, SQLOutputValue>;

function text(row: Row, column: string): string {
  const value = row[column];
  if (typeof value !== "string") throw new Error(`app.sqlite: column ${column} is not text`);
  return value;
}

function toCharacter(row: Row): CharacterRecord {
  const id = text(row, "character_id");
  assertCharacterId(id);
  return {
    character_id: id,
    upstream_name: text(row, "upstream_name"),
    display_name: text(row, "display_name"),
    created_at: text(row, "created_at"),
    updated_at: text(row, "updated_at"),
    status: text(row, "status") as CharacterStatus,
  };
}

function toBinding(row: Row): AppearanceBinding {
  const id = text(row, "character_id");
  assertCharacterId(id);
  return {
    character_id: id,
    appearance_id: text(row, "appearance_id"),
    bound_at: text(row, "bound_at"),
    is_active: row["is_active"] === 1,
  };
}

function newCharacterId(): CharacterId {
  return `character_${randomUUID().replaceAll("-", "")}`;
}

/** Shape returned by POST /rename on the memory-service adapter. */
interface RenameResponse {
  success: boolean;
  message: string;
}

function isRenameResponse(value: unknown): value is RenameResponse {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Record<string, unknown>)["success"] === "boolean" &&
    typeof (value as Record<string, unknown>)["message"] === "string"
  );
}

export class Character {
  readonly #db: DatabaseSync;
  readonly #memoryServiceUrl: string;
  readonly #renameTimeoutMs: number;

  private constructor(db: DatabaseSync, options: CharacterOptions) {
    this.#db = db;
    this.#memoryServiceUrl = (options.memoryServiceUrl ?? DEFAULT_MEMORY_SERVICE_URL).replace(/\/+$/, "");
    this.#renameTimeoutMs = options.renameTimeoutMs ?? DEFAULT_RENAME_TIMEOUT_MS;
  }

  /** Opens (or creates) app.sqlite and applies the schema. */
  static open(options: CharacterOptions): Character {
    if (typeof options.dbPath !== "string" || options.dbPath.length === 0) {
      throw new TypeError("dbPath is required");
    }
    const db = new DatabaseSync(options.dbPath);
    try {
      db.exec("PRAGMA foreign_keys = ON;");
      db.exec(SCHEMA_SQL);
    } catch (error) {
      db.close();
      throw error;
    }
    return new Character(db, options);
  }

  close(): void {
    this.#db.close();
  }

  /** Registers a new character. display_name defaults to the upstream name. */
  create(upstreamName: string, displayName: string = upstreamName): CharacterRecord {
    assertUpstreamName(upstreamName);
    if (typeof displayName !== "string" || displayName.trim().length === 0) {
      throw new CharacterError("invalid_name", "display_name must be a non-empty string");
    }
    this.#assertNameFree(upstreamName, null);

    const now = new Date().toISOString();
    const id = newCharacterId();
    this.#db
      .prepare(
        `INSERT INTO characters (character_id, upstream_name, display_name, created_at, updated_at, status)
         VALUES (?, ?, ?, ?, ?, 'active')`,
      )
      .run(id, upstreamName, displayName, now, now);
    return this.load(id);
  }

  /** Loads a character by id; throws not_found for unregistered ids. */
  load(characterId: string): CharacterRecord {
    assertCharacterId(characterId);
    const row = this.#db.prepare("SELECT * FROM characters WHERE character_id = ?").get(characterId);
    if (row === undefined) {
      throw new CharacterError("not_found", `character ${characterId} is not registered`);
    }
    return toCharacter(row);
  }

  /** Upstream memory key (lanlan_name) for a registered character. */
  memoryKey(characterId: string): string {
    const record = this.load(characterId);
    if (record.status !== "active") {
      throw new CharacterError("rename_failed", `character ${characterId} has an unfinished rename`);
    }
    return record.upstream_name;
  }

  /**
   * Maps an upstream memory key back to its character_id. The match is exact
   * and case-sensitive: upstream lowercases directory names of unregistered
   * characters, so a key that only matches case-insensitively is rejected.
   */
  characterIdForMemoryKey(upstreamName: string): CharacterId {
    assertUpstreamName(upstreamName);
    const row = this.#db
      .prepare("SELECT * FROM characters WHERE upstream_name = ? COLLATE BINARY")
      .get(upstreamName);
    if (row === undefined) {
      throw new CharacterError("not_found", `no registered character uses memory key "${upstreamName}"`);
    }
    return toCharacter(row).character_id;
  }

  /**
   * Renames the upstream memory key. The local row is switched to the new name
   * with status "renaming" first, so a concurrent rename of the same character
   * fails fast; the memory service is then asked to move its data. Any failure
   * restores the previous name and display name.
   *
   * display_name follows the new name unless a separate one is given.
   */
  async rename(characterId: string, newName: string, displayName: string = newName): Promise<CharacterRecord> {
    const before = this.load(characterId);
    assertUpstreamName(newName);
    if (typeof displayName !== "string" || displayName.trim().length === 0) {
      throw new CharacterError("invalid_name", "display_name must be a non-empty string");
    }
    if (before.status !== "active") {
      throw new CharacterError("rename_failed", `character ${before.character_id} already has a rename in progress`);
    }
    if (newName === before.upstream_name) {
      return this.#setDisplayName(before, displayName);
    }
    this.#assertNameFree(newName, before.character_id);

    const acquired = this.#db
      .prepare(
        `UPDATE characters
            SET upstream_name = ?, display_name = ?, status = 'renaming', updated_at = ?
          WHERE character_id = ? AND upstream_name = ? AND status = 'active'`,
      )
      .run(newName, displayName, new Date().toISOString(), before.character_id, before.upstream_name);
    if (acquired.changes !== 1) {
      throw new CharacterError("rename_failed", `character ${before.character_id} changed during rename; retry`);
    }

    try {
      await this.#requestUpstreamRename(before.character_id, before.upstream_name, newName);
    } catch (error) {
      this.#rollbackRename(before);
      throw error;
    }

    this.#db
      .prepare("UPDATE characters SET status = 'active', updated_at = ? WHERE character_id = ?")
      .run(new Date().toISOString(), before.character_id);
    return this.load(before.character_id);
  }

  /** Makes appearanceId the active appearance; earlier bindings are kept as history. */
  bindAppearance(characterId: string, appearanceId: string): AppearanceBinding {
    const record = this.load(characterId);
    assertAppearanceId(appearanceId);
    const boundAt = new Date().toISOString();

    this.#db.exec("BEGIN IMMEDIATE");
    try {
      this.#db
        .prepare("UPDATE appearance_bindings SET is_active = 0 WHERE character_id = ? AND is_active = 1")
        .run(record.character_id);
      this.#db
        .prepare(
          "INSERT INTO appearance_bindings (character_id, appearance_id, bound_at, is_active) VALUES (?, ?, ?, 1)",
        )
        .run(record.character_id, appearanceId, boundAt);
      this.#db.exec("COMMIT");
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
    return { character_id: record.character_id, appearance_id: appearanceId, bound_at: boundAt, is_active: true };
  }

  /** Current appearance, or null if none has been bound. */
  activeAppearance(characterId: string): AppearanceBinding | null {
    const record = this.load(characterId);
    const row = this.#db
      .prepare("SELECT * FROM appearance_bindings WHERE character_id = ? AND is_active = 1")
      .get(record.character_id);
    return row === undefined ? null : toBinding(row);
  }

  #assertNameFree(upstreamName: string, exceptId: CharacterId | null): void {
    // Column collation is NOCASE, so this also catches case-only collisions.
    const row = this.#db.prepare("SELECT character_id FROM characters WHERE upstream_name = ?").get(upstreamName);
    if (row !== undefined && row["character_id"] !== exceptId) {
      throw new CharacterError("name_taken", `upstream_name "${upstreamName}" is already used by another character`);
    }
  }

  #setDisplayName(record: CharacterRecord, displayName: string): CharacterRecord {
    this.#db
      .prepare("UPDATE characters SET display_name = ?, updated_at = ? WHERE character_id = ?")
      .run(displayName, new Date().toISOString(), record.character_id);
    return this.load(record.character_id);
  }

  #rollbackRename(before: CharacterRecord): void {
    this.#db
      .prepare(
        `UPDATE characters
            SET upstream_name = ?, display_name = ?, status = 'active', updated_at = ?
          WHERE character_id = ?`,
      )
      .run(before.upstream_name, before.display_name, before.updated_at, before.character_id);
  }

  async #requestUpstreamRename(characterId: CharacterId, oldName: string, newName: string): Promise<void> {
    let response: Response;
    try {
      response = await fetch(`${this.#memoryServiceUrl}/rename`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ character_id: characterId, old_name: oldName, new_name: newName }),
        signal: AbortSignal.timeout(this.#renameTimeoutMs),
      });
    } catch (error) {
      throw new CharacterError("rename_failed", "memory service rename request failed", { cause: error });
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch (error) {
      throw new CharacterError("rename_failed", `memory service returned HTTP ${response.status} without JSON`, {
        cause: error,
      });
    }
    // A 2xx response can still carry status:"error" upstream; only success:true counts.
    if (!response.ok || !isRenameResponse(body) || !body.success) {
      const detail = isRenameResponse(body) ? body.message : "unexpected response shape";
      throw new CharacterError("rename_failed", `memory service rejected rename (HTTP ${response.status}): ${detail}`);
    }
  }
}
