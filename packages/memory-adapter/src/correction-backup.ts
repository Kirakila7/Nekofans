/**
 * F08: fact correction, forgetting, backup, and restore for the memory-adapter.
 *
 * correctFact: POST /correct_fact/{name} — replaces the text of one fact by id.
 * forgetFact: POST /forget_fact/{name} — marks a fact suppressed so it no longer participates in recall.
 * exportBackup: POST /export_backup/{name} — packs the character's memory directory plus app.sqlite
 *   character row and appearance bindings into a tarball.
 * restoreBackup: POST /restore_backup/{name} — restores the tarball, verifying character_id, and
 *   evicting caches.
 *
 * Routes are in `services/neko-memory/routes_f08.py`. Client calls the routes, but does not edit vendor code.
 */

import { Character, isCharacterId } from "../../character-runtime/src/index.ts";
import type { CharacterId } from "../../app-contracts/src/index.ts";

/** Files and manifest packed by export_backup. */
export interface BackupManifest {
  version: string;
  character_id: string;
  character_name: string;
  backup_date: string;
  files: Record<string, string>;
}

/** Result of restoring a backup. */
export interface RestoreResult {
  status: "ok" | "error";
  character_id: string;
  restored_files: string[];
  conflicts: string[];
  error?: string;
}

/**
 * F08: exported files list (memory/ directory + app.sqlite character row + manifest).
 */
export interface BackupFiles {
  manifest: BackupManifest;
  memory_files: string[];
  app_sqlite_character_row: object | null;
}

function isError(code: string, v: unknown): v is { status: "error"; error_code?: string } {
  return (
    typeof v === "object" &&
    v !== null &&
    ((v as any).status === "error" || typeof (v as any).error_code === "string")
  );
}

function toMemoryServiceError(message: string, res: unknown): { status: "error"; error: string } {
  const body = res as any;
  if (isError("", body)) {
    const code = typeof body.error_code === "string" ? body.error_code : "service_error";
    const detail = body.message || body.error || code;
    return { status: "error", error: `${message}: ${detail}` };
  }
  return { status: "error", error: message };
}

/**
 * Replace the text of one fact by id. The old fact is marked suppressed so it stops being recalled,
 * and a new fact with the corrected text is written with source="user_correction".
 */
export async function correctFact(opts: {
  memoryServiceUrl: string;
  dbPath: string;
  character_id: string;
  fact_id: string;
  corrected_text: string;
}): Promise<{ status: "ok" | "error"; old_text?: string; new_fact_id?: string; error?: string }> {
  if (typeof opts.dbPath !== "string" || opts.dbPath.length === 0) {
    return { status: "error", error: "dbPath is required" };
  }
  if (!isCharacterId(opts.character_id)) {
    return { status: "error", error: "character_id is not a valid CharacterId" };
  }
  let characters: Character | null = null;
  try {
    characters = Character.open({ dbPath: opts.dbPath });
    const upstream_name = characters.memoryKey(opts.character_id);
    const url = `${opts.memoryServiceUrl}/correct_fact/${encodeURIComponent(upstream_name)}`;
    const body = {
      fact_id: opts.fact_id,
      corrected_text: opts.corrected_text,
    };

    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const err = await res.text();
      return { status: "error", error: `HTTP ${res.status}: ${err}` };
    }

    const data = await res.json();
    if (data.status === "error" || typeof data.error_code === "string") {
      return toMemoryServiceError("correctFact failed", data);
    }

    return {
      status: "ok",
      old_text: data.old_text,
      new_fact_id: data.new_fact_id,
    };
  } finally {
    characters?.close();
  }
}

/**
 * Remove one fact by id from memory. The fact is marked suppressed so it no longer participates in recall
 * (hybrid_recall, recall_by_time, and new_dialog persona render).
 */
export async function forgetFact(opts: {
  memoryServiceUrl: string;
  dbPath: string;
  character_id: string;
  fact_id: string;
}): Promise<{ status: "ok" | "error"; removed?: boolean; error?: string }> {
  if (typeof opts.dbPath !== "string" || opts.dbPath.length === 0) {
    return { status: "error", error: "dbPath is required" };
  }
  if (!isCharacterId(opts.character_id)) {
    return { status: "error", error: "character_id is not a valid CharacterId" };
  }
  let characters: Character | null = null;
  try {
    characters = Character.open({ dbPath: opts.dbPath });
    const upstream_name = characters.memoryKey(opts.character_id);
    const url = `${opts.memoryServiceUrl}/forget_fact/${encodeURIComponent(upstream_name)}`;
    const body_req = { fact_id: opts.fact_id };

    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body_req),
    });

    if (!res.ok) {
      const err = await res.text();
      return { status: "error", error: `HTTP ${res.status}: ${err}` };
    }

    const data = await res.json();
    if (data.status === "error" || typeof data.error_code === "string") {
      return toMemoryServiceError("forgetFact failed", data);
    }

    return {
      status: "ok",
      removed: data.removed,
    };
  } finally {
    characters?.close();
  }
}

/**
 * Export a tarball backup of the character's memory (the whole memory/<name>/ directory, plus the app.sqlite
 * character row and appearance bindings). The tarball is written to <NEKO_DATA_ROOT>/N.E.K.O/backups/<name>_backup_<timestamp>.tar.gz.
 */
export async function exportBackup(opts: {
  memoryServiceUrl: string;
  dbPath: string;
  character_id: string;
}): Promise<{ status: "ok" | "error"; backup_file?: string; size?: number; error?: string }> {
  if (typeof opts.dbPath !== "string" || opts.dbPath.length === 0) {
    return { status: "error", error: "dbPath is required" };
  }
  if (!isCharacterId(opts.character_id)) {
    return { status: "error", error: "character_id is not a valid CharacterId" };
  }
  let characters: Character | null = null;
  try {
    characters = Character.open({ dbPath: opts.dbPath });
    const upstream_name = characters.memoryKey(opts.character_id);
    const url = `${opts.memoryServiceUrl}/export_backup/${encodeURIComponent(upstream_name)}`;

    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    if (!res.ok) {
      const err = await res.text();
      return { status: "error", error: `HTTP ${res.status}: ${err}` };
    }

    const data = await res.json();
    if (data.status === "error" || typeof data.error_code === "string") {
      return toMemoryServiceError("exportBackup failed", data);
    }

    return {
      status: "ok",
      backup_file: data.backup_file,
      size: data.size,
    };
  } finally {
    characters?.close();
  }
}

/**
 * Restore a character's memory from a tarball backup. Verifies character_id consistency and evicts caches.
 * If the character already has a different character_id, the restore returns 409 and does not overwrite.
 */
export async function restoreBackup(opts: {
  memoryServiceUrl: string;
  dbPath: string;
  character_id: string;
  backup_file: string;
}): Promise<RestoreResult> {
  if (typeof opts.dbPath !== "string" || opts.dbPath.length === 0) {
    return {
      status: "error",
      character_id: "",
      restored_files: [],
      conflicts: [],
      error: "dbPath is required",
    };
  }
  if (!isCharacterId(opts.character_id)) {
    return {
      status: "error",
      character_id: "",
      restored_files: [],
      conflicts: [],
      error: "character_id is not a valid CharacterId",
    };
  }
  let characters: Character | null = null;
  try {
    characters = Character.open({ dbPath: opts.dbPath });
    const upstream_name = characters.memoryKey(opts.character_id);
    const url = `${opts.memoryServiceUrl}/restore_backup/${encodeURIComponent(upstream_name)}`;
    const body = { backup_file: opts.backup_file };

    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const err = await res.text();
      return {
        status: "error",
        character_id: "",
        restored_files: [],
        conflicts: [],
        error: `HTTP ${res.status}: ${err}`,
      };
    }

    const data = await res.json();
    if (data.status === "error" || typeof data.error_code === "string") {
      const msg = data.message || data.error || data.error_code || "unknown error";
      return {
        status: "error",
        character_id: data.character_id || "",
        restored_files: data.restored_files || [],
        conflicts: data.conflicts || [],
        error: msg,
      };
    }

    return {
      status: "ok",
      character_id: data.character_id,
      restored_files: data.restored_files || [],
      conflicts: data.conflicts || [],
    };
  } finally {
    characters?.close();
  }
}
