// F06: commit conversation turns to the N.E.K.O. memory-service with
// persistent receipts and replay dedup.
//
// Flow per turn: check memory_receipts by turn_id -> POST /cache/{upstream_name}
// -> on confirmed success insert one receipt row. The receipt is written only
// after the upstream confirms the write, because the upstream has no turn-level
// dedup and its write is not atomic.

import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

import type { MemoryTurn, MemoryTurnScope } from "../../app-contracts/src/index.ts";
import { Character, DEFAULT_MEMORY_SERVICE_URL } from "../../character-runtime/src/index.ts";

export { DEFAULT_MEMORY_SERVICE_URL };

export type ReceiptStatus = "pending" | "submitted";

export type CommitErrorCode =
  | "invalid_turn"
  | "unknown_character"
  | "network_error"
  | "http_error"
  | "service_error"
  | "storage_startup_blocked";

/** Upstream accepted the turn and a receipt row was written. */
export interface SubmittedReceipt {
  kind: "submitted";
  receipt_id: string;
  turn_id: string;
  character_id: string;
  submitted_at: string;
  status: ReceiptStatus;
}

/** The turn already has a receipt; no request was sent. */
export interface AlreadySubmitted {
  kind: "already_submitted";
  turn_id: string;
}

/** The turn was not stored; the caller keeps it pending and may retry. */
export interface CommitError {
  kind: "error";
  turn_id: string;
  code: CommitErrorCode;
  message: string;
  http_status?: number;
}

export type Receipt = SubmittedReceipt | AlreadySubmitted | CommitError;

export interface MemoryClientOptions {
  /** Path to app.sqlite (shared with character-runtime). */
  db_path: string;
  /** memory-service base URL, without trailing slash. */
  base_url?: string;
  /** Language hint forwarded to the upstream. */
  language?: string;
}

interface UpstreamMessage {
  role: "user" | "assistant";
  content: string;
}

/** Convert a MemoryTurn to the upstream input_history message list. */
export function toInputHistory(turn: MemoryTurn): UpstreamMessage[] {
  return [
    { role: "user", content: turn.user_text },
    { role: "assistant", content: turn.assistant_text },
  ];
}

function validateTurn(turn: MemoryTurn): string | null {
  if (typeof turn.turn_id !== "string" || turn.turn_id.length === 0) return "turn_id must be a non-empty string";
  if (typeof turn.character_id !== "string" || turn.character_id.length === 0) {
    return "character_id must be a non-empty string";
  }
  if (typeof turn.user_text !== "string" || turn.user_text.length === 0) return "user_text must be a non-empty string";
  if (typeof turn.assistant_text !== "string") return "assistant_text must be a string";
  return null;
}

export class MemoryClient {
  #db: DatabaseSync;
  #characters: Character;
  #base_url: string;
  #language: string;

  constructor(options: MemoryClientOptions) {
    // Character.open applies the shared app.sqlite schema, including memory_receipts.
    this.#characters = Character.open({ dbPath: options.db_path });
    this.#db = new DatabaseSync(options.db_path);
    this.#base_url = (options.base_url ?? DEFAULT_MEMORY_SERVICE_URL).replace(/\/+$/, "");
    this.#language = options.language ?? "zh";
  }

  /** True when a receipt for turn_id already exists. */
  replayCheck(turn_id: string): boolean {
    const row = this.#db.prepare("SELECT 1 FROM memory_receipts WHERE turn_id = ?").get(turn_id);
    return row !== undefined;
  }

  /** Mark a receipt as confirmed by the caller. Returns false if no row matched. */
  markSubmitted(receipt_id: string, turn_id: string): boolean {
    const result = this.#db
      .prepare("UPDATE memory_receipts SET status = 'submitted' WHERE receipt_id = ? AND turn_id = ?")
      .run(receipt_id, turn_id);
    return Number(result.changes) > 0;
  }

  async commitTurn(payload: MemoryTurn): Promise<Receipt> {
    const turn_id = payload.turn_id;
    const fail = (code: CommitErrorCode, message: string, http_status?: number): CommitError => ({
      kind: "error",
      turn_id,
      code,
      message,
      ...(http_status === undefined ? {} : { http_status }),
    });

    const invalid = validateTurn(payload);
    if (invalid) return fail("invalid_turn", invalid);

    if (this.replayCheck(turn_id)) return { kind: "already_submitted", turn_id };

    let upstream_name: string;
    try {
      upstream_name = this.#characters.memoryKey(payload.character_id);
    } catch (err) {
      return fail("unknown_character", (err as Error).message);
    }

    let response: Response;
    try {
      response = await fetch(`${this.#base_url}/cache/${encodeURIComponent(upstream_name)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          input_history: JSON.stringify(toInputHistory(payload)),
          language: this.#language,
        }),
      });
    } catch (err) {
      return fail("network_error", (err as Error).message);
    }

    let body: Record<string, unknown> | null = null;
    try {
      body = (await response.json()) as Record<string, unknown>;
    } catch {
      body = null;
    }

    if (response.status === 409 && body?.error_code === "storage_startup_blocked") {
      return fail("storage_startup_blocked", String(body.blocking_reason ?? "storage not ready"), 409);
    }
    if (response.status !== 200) {
      return fail("http_error", `memory-service returned HTTP ${response.status}`, response.status);
    }
    if (body?.status !== "cached") {
      const detail = body?.message ?? body?.status ?? "unexpected response body";
      return fail("service_error", String(detail), 200);
    }

    const receipt: SubmittedReceipt = {
      kind: "submitted",
      receipt_id: randomUUID(),
      turn_id,
      character_id: payload.character_id,
      submitted_at: new Date().toISOString(),
      status: "pending",
    };
    this.#db
      .prepare(
        "INSERT INTO memory_receipts (receipt_id, turn_id, character_id, submitted_at, status) VALUES (?, ?, ?, ?, ?)",
      )
      .run(receipt.receipt_id, receipt.turn_id, receipt.character_id, receipt.submitted_at, receipt.status);
    return receipt;
  }

  /**
   * F07: opening context for a new dialog (`GET /new_dialog/{upstream_name}`).
   * Upstream has no project scoping on this route; scope/project_id are checked
   * here so callers keep the contract, but are not forwarded.
   */
  async buildContext(
    character_id: string,
    scope: MemoryTurnScope,
    project_id: string | undefined,
    budget_ms: number,
  ): Promise<MemoryContext> {
    if (scope === "project" && !project_id) {
      throw new TypeError("project_id is required when scope is 'project'");
    }
    const name = encodeURIComponent(this.#characters.memoryKey(character_id));
    const path = `/new_dialog/${name}?language=${encodeURIComponent(this.#language)}`;
    const body = await this.#recallRequest("GET", path, budget_ms);
    if (typeof body !== "string") {
      throw new MemoryServiceError("bad_response", "new_dialog did not return text");
    }
    return parseNewDialog(body);
  }

  /**
   * F07: hybrid fact recall (`POST /query_memory/{upstream_name}`).
   * time_window uses upstream syntax: an ISO date/hour token or an `a/b` range.
   */
  async queryFacts(character_id: string, query_text: string, time_window?: string): Promise<Fact[]> {
    const name = encodeURIComponent(this.#characters.memoryKey(character_id));
    const payload: Record<string, string> = { query: query_text };
    if (time_window) payload.time = time_window;
    const body = await this.#recallRequest("POST", `/query_memory/${name}`, RECALL_TIMEOUT_MS, payload);
    if (!isRecord(body) || !Array.isArray(body.results)) {
      throw new MemoryServiceError("bad_response", "query_memory did not return results[]");
    }
    return body.results.map(toFact);
  }

  /**
   * F07: stored facts (active and archived) with their source fields
   * (`GET /f07/facts/{upstream_name}`, added by services/neko-memory/routes_f07.py).
   */
  async listFacts(character_id: string): Promise<StoredFact[]> {
    const name = encodeURIComponent(this.#characters.memoryKey(character_id));
    const body = await this.#recallRequest("GET", `/f07/facts/${name}`, RECALL_TIMEOUT_MS);
    if (!isRecord(body) || !Array.isArray(body.facts)) {
      throw new MemoryServiceError("bad_response", "f07/facts did not return facts[]");
    }
    return body.facts as StoredFact[];
  }

  /** F07: reflections with source_fact_ids (`GET /f07/reflections/{upstream_name}`). */
  async listReflections(character_id: string): Promise<Reflection[]> {
    const name = encodeURIComponent(this.#characters.memoryKey(character_id));
    const body = await this.#recallRequest("GET", `/f07/reflections/${name}`, RECALL_TIMEOUT_MS);
    if (!isRecord(body) || !Array.isArray(body.reflections)) {
      throw new MemoryServiceError("bad_response", "f07/reflections did not return reflections[]");
    }
    return body.reflections as Reflection[];
  }

  /** F07: upstream persona JSON (`GET /get_persona/{upstream_name}`), keyed by entity. */
  async getPersona(character_id: string): Promise<Record<string, unknown>> {
    const name = encodeURIComponent(this.#characters.memoryKey(character_id));
    const body = await this.#recallRequest("GET", `/get_persona/${name}`, RECALL_TIMEOUT_MS);
    if (!isRecord(body)) {
      throw new MemoryServiceError("bad_response", "get_persona did not return an object");
    }
    return body;
  }

  // Shared request path for the F07 read routes. Checks HTTP status and the
  // business-level error fields upstream returns with HTTP 200.
  async #recallRequest(method: "GET" | "POST", path: string, timeout_ms: number, json?: unknown): Promise<unknown> {
    let res: Response;
    try {
      res = await fetch(this.#base_url + path, {
        method,
        headers: json === undefined ? undefined : { "content-type": "application/json" },
        body: json === undefined ? undefined : JSON.stringify(json),
        signal: AbortSignal.timeout(timeout_ms),
      });
    } catch (err) {
      if ((err as Error).name === "TimeoutError") {
        throw new MemoryServiceError("timeout", `${method} ${path} exceeded ${timeout_ms}ms`);
      }
      throw new MemoryServiceError("network_error", `${method} ${path} failed: ${(err as Error).message}`);
    }
    const text = await res.text();
    const body = res.headers.get("content-type")?.includes("application/json") ? safeJson(text) : text;

    if (res.status === 409 && isRecord(body) && body.error_code === "storage_startup_blocked") {
      throw new MemoryServiceError("storage_startup_blocked", "memory-service storage is not ready");
    }
    if (!res.ok) {
      throw new MemoryServiceError("http_error", `${method} ${path} returned HTTP ${res.status}`);
    }
    if (isRecord(body) && (body.status === "error" || typeof body.error_code === "string")) {
      const code = typeof body.error_code === "string" ? body.error_code : "service_error";
      throw new MemoryServiceError(code, `${method} ${path} reported ${code}`);
    }
    return body;
  }

  close(): void {
    this.#db.close();
    this.#characters.close();
  }
}

// ---- F07: recall types and helpers ----

const RECALL_TIMEOUT_MS = 10_000;

/** One rendered line of recent dialog, e.g. `碳基生物 | 你好`. */
export interface RecentLine {
  speaker: string;
  text: string;
}

/** A fact returned by upstream hybrid recall. */
export interface Fact {
  id: string;
  text: string;
  tier: string;
  entity: string | null;
  /** RRF fused score; null on the time-only recall path. */
  score: number | null;
  created_at: string | null;
}

/** A fact row as stored upstream, with its source fields. */
export interface StoredFact {
  id: string;
  text: string;
  /** "user_observation" (from the user's words) or "ai_disclosure" (from the character's words). */
  source: string;
  importance: number;
  entity: string;
  created_at: string;
  absorbed: boolean;
  /** True for rows in facts_archive.json; upstream recall still searches them (tier "fact_archive"). */
  archived: boolean;
  speaker_id?: string;
  speaker_label?: string;
  speaker_trust?: string;
}

/** A reflection synthesized from facts; source_fact_ids point back to StoredFact.id. */
export interface Reflection {
  id: string;
  text: string;
  entity: string;
  status: string;
  source_fact_ids: string[];
  created_at: string;
}

export interface MemoryContext {
  /** Recent dialog lines (summary memo included), oldest first. */
  recent: RecentLine[];
  /** Bullet entries from the long-term memory section. */
  facts: string[];
  /** Long-term memory section as rendered by upstream. */
  persona: string;
}

export class MemoryServiceError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "MemoryServiceError";
    this.code = code;
  }
}

// Section headers of the zh `/new_dialog` render (vendor config/prompts/prompts_memory.py).
const PERSONA_HEADER = /^=+.*的长期记忆=+$/;
const INNER_THOUGHTS_HEADER = /^=+以下是.*的内心活动=+$/;

/** Split the zh `/new_dialog` plain-text render into persona, facts and recent lines. */
export function parseNewDialog(text: string): MemoryContext {
  const personaLines: string[] = [];
  const recent: RecentLine[] = [];
  let section: "none" | "persona" | "inner" = "none";
  let skippedPreamble = false;

  for (const line of text.split(/\r?\n/)) {
    if (PERSONA_HEADER.test(line)) { section = "persona"; continue; }
    if (INNER_THOUGHTS_HEADER.test(line)) { section = "inner"; continue; }
    if (section === "persona") {
      personaLines.push(line);
    } else if (section === "inner") {
      // First line of the section is the "现在时间是…" preamble.
      if (!skippedPreamble) { skippedPreamble = true; continue; }
      const sep = line.indexOf(" | ");
      if (sep > 0) recent.push({ speaker: line.slice(0, sep), text: line.slice(sep + 3) });
    }
  }

  const facts = personaLines
    .map((l) => l.trim())
    .filter((l) => l.startsWith("- "))
    .map((l) => l.slice(2));
  return { recent, facts, persona: personaLines.join("\n").trim() };
}

function toFact(raw: unknown): Fact {
  const r = isRecord(raw) ? raw : {};
  return {
    id: typeof r.id === "string" ? r.id : "",
    text: typeof r.text === "string" ? r.text : "",
    tier: typeof r.tier === "string" ? r.tier : "unknown",
    entity: typeof r.entity === "string" ? r.entity : null,
    score: typeof r.score === "number" ? r.score : null,
    created_at: typeof r.created_at === "string" ? r.created_at : null,
  };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
