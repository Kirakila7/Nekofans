// Lightweight per-persona memory backed by memories.sqlite (node:sqlite).
// Every query is keyed by persona_id; an id owned by another persona is treated
// as not found. propose always stores pending; only confirmed items are recalled.
// recall ranks by keyword overlap (latin words + CJK bigrams) under a token budget.

import { DatabaseSync } from "node:sqlite";
import type { SQLOutputValue } from "node:sqlite";

import type { MemoryItem, MemoryProvider, PersonaId } from "../../app-contracts/src/chat.ts";
import { SCHEMA_SQL } from "./schema.ts";

export { extractMemoryProposals } from "./extract.ts";

type Row = Record<string, SQLOutputValue>;
type Confirmation = MemoryItem["confirmation"];

const KINDS: ReadonlySet<string> = new Set(["fact", "preference", "episode", "summary"]);
const MAX_TEXT_CHARS = 500;
/** Per-item overhead in recall budgeting (list marker, newline). */
const ITEM_OVERHEAD_TOKENS = 4;
const CJK_CHAR = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const TOKEN_RUN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+|[a-z0-9]+/gu;

export class MemoryNotFoundError extends Error {
  constructor(personaId: PersonaId, id: string) {
    super(`memory ${id} not found for persona ${personaId}`);
    this.name = "MemoryNotFoundError";
  }
}

/** Rough token count: each CJK char is 1, other chars count ceil(n/4); non-empty text is at least 1. */
export function estimateTokens(text: string): number {
  if (text.length === 0) return 0;
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    if (CJK_CHAR.test(ch)) cjk++;
    else other++;
  }
  return Math.max(1, cjk + Math.ceil(other / 4));
}

/** Lowercased latin/digit words of 2+ chars, CJK runs as overlapping bigrams (single char kept). */
function tokenize(text: string): Set<string> {
  const tokens = new Set<string>();
  for (const [run] of text.toLowerCase().matchAll(TOKEN_RUN)) {
    const chars = Array.from(run);
    if (CJK_CHAR.test(chars[0])) {
      if (chars.length === 1) tokens.add(run);
      for (let i = 0; i + 1 < chars.length; i++) tokens.add(chars[i] + chars[i + 1]);
    } else if (chars.length >= 2) {
      tokens.add(run);
    }
  }
  return tokens;
}

function normalize(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}

function cleanText(text: string): string {
  if (typeof text !== "string") throw new Error("memory text must be a string");
  const trimmed = text.trim();
  if (trimmed.length === 0) throw new Error("memory text must not be empty");
  if (trimmed.length > MAX_TEXT_CHARS) {
    throw new Error(`memory text must be at most ${MAX_TEXT_CHARS} chars`);
  }
  return trimmed;
}

function toItem(row: Row): MemoryItem {
  const item: MemoryItem = {
    id: row["id"] as string,
    personaId: row["persona_id"] as string,
    kind: row["kind"] as MemoryItem["kind"],
    text: row["text"] as string,
    sourceMessageIds: JSON.parse(row["source_message_ids"] as string) as string[],
    confirmation: row["confirmation"] as Confirmation,
    updatedAt: Number(row["updated_at"]),
  };
  if (row["audio_ref"] !== null) item.audioRef = row["audio_ref"] as string;
  return item;
}

const SELECT_COLUMNS =
  "id, persona_id, kind, text, source_message_ids, confirmation, updated_at, audio_ref";

/** One persona's view of the store, for the pet UI. */
export interface PersonaMemory {
  /** Pending and confirmed items, updatedAt desc. */
  list(): Promise<MemoryItem[]>;
  confirm(id: string): Promise<void>;
  update(id: string, text: string): Promise<void>;
  remove(id: string): Promise<void>;
  /** Fires after any mutation of this persona's memories. */
  subscribe(listener: () => void): () => void;
}

export class SqliteMemoryStore implements MemoryProvider {
  private readonly db: DatabaseSync;
  private readonly now: () => number;
  private readonly listeners = new Set<(personaId: PersonaId) => void>();

  /** dbPath is required so the database never lands in an implicit cwd. */
  constructor(dbPath: string, opts: { now?: () => number } = {}) {
    this.now = opts.now ?? Date.now;
    this.db = new DatabaseSync(dbPath);
    this.db.exec(SCHEMA_SQL);
  }

  async recall(personaId: PersonaId, query: string, budgetTokens: number): Promise<MemoryItem[]> {
    if (!Number.isInteger(budgetTokens) || budgetTokens <= 0) return [];
    const items = await this.list(personaId, "confirmed");
    const queryTokens = tokenize(query);
    const scored = items.map((item, order) => {
      const itemTokens = tokenize(item.text);
      let score = 0;
      for (const t of queryTokens) if (itemTokens.has(t)) score++;
      return { item, score, order };
    });
    // items are already updatedAt desc; order keeps that as the tie-breaker.
    scored.sort((a, b) => b.score - a.score || a.order - b.order);
    const out: MemoryItem[] = [];
    let used = 0;
    for (const { item } of scored) {
      const cost = estimateTokens(item.text) + ITEM_OVERHEAD_TOKENS;
      if (used + cost > budgetTokens) continue;
      used += cost;
      out.push(item);
    }
    return out;
  }

  async propose(item: MemoryItem): Promise<void> {
    if (typeof item.personaId !== "string" || item.personaId.length === 0) {
      throw new Error("memory personaId must not be empty");
    }
    if (typeof item.id !== "string" || item.id.length === 0) {
      throw new Error("memory id must not be empty");
    }
    if (!KINDS.has(item.kind)) throw new Error(`memory ${item.id}: invalid kind ${String(item.kind)}`);
    if (!Number.isSafeInteger(item.updatedAt)) {
      throw new Error(`memory ${item.id}: updatedAt must be an integer epoch ms`);
    }
    if (!Array.isArray(item.sourceMessageIds) || !item.sourceMessageIds.every((s) => typeof s === "string")) {
      throw new Error(`memory ${item.id}: sourceMessageIds must be an array of strings`);
    }
    const text = cleanText(item.text);

    const existing = this.db.prepare("SELECT persona_id FROM memories WHERE id = ?").get(item.id);
    if (existing !== undefined) {
      if (existing["persona_id"] === item.personaId) return;
      throw new Error(`memory id ${item.id} already belongs to another persona`);
    }
    const key = normalize(text);
    const texts = this.db.prepare("SELECT text FROM memories WHERE persona_id = ?").all(item.personaId);
    if (texts.some((r) => normalize(r["text"] as string) === key)) return;

    this.db
      .prepare(
        `INSERT INTO memories
           (id, persona_id, kind, text, source_message_ids, confirmation, created_at, updated_at, audio_ref)
         VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
      )
      .run(
        item.id,
        item.personaId,
        item.kind,
        text,
        JSON.stringify(item.sourceMessageIds),
        this.now(),
        item.updatedAt,
        item.audioRef ?? null,
      );
    this.emit(item.personaId);
  }

  async confirm(personaId: PersonaId, id: string): Promise<void> {
    const row = this.db
      .prepare("SELECT confirmation FROM memories WHERE persona_id = ? AND id = ?")
      .get(personaId, id);
    if (row === undefined) throw new MemoryNotFoundError(personaId, id);
    if (row["confirmation"] === "confirmed") return;
    this.db
      .prepare("UPDATE memories SET confirmation = 'confirmed', updated_at = ? WHERE persona_id = ? AND id = ?")
      .run(this.now(), personaId, id);
    this.emit(personaId);
  }

  async update(personaId: PersonaId, id: string, text: string): Promise<void> {
    const cleaned = cleanText(text);
    const result = this.db
      .prepare("UPDATE memories SET text = ?, updated_at = ? WHERE persona_id = ? AND id = ?")
      .run(cleaned, this.now(), personaId, id);
    if (Number(result.changes) === 0) throw new MemoryNotFoundError(personaId, id);
    this.emit(personaId);
  }

  async remove(personaId: PersonaId, id: string): Promise<void> {
    const result = this.db.prepare("DELETE FROM memories WHERE persona_id = ? AND id = ?").run(personaId, id);
    if (Number(result.changes) === 0) throw new MemoryNotFoundError(personaId, id);
    this.emit(personaId);
  }

  /** This persona's items, updatedAt desc (latest insert first on ties). */
  async list(personaId: PersonaId, confirmation?: Confirmation): Promise<MemoryItem[]> {
    const rows =
      confirmation === undefined
        ? this.db
            .prepare(`SELECT ${SELECT_COLUMNS} FROM memories WHERE persona_id = ? ORDER BY updated_at DESC, seq DESC`)
            .all(personaId)
        : this.db
            .prepare(
              `SELECT ${SELECT_COLUMNS} FROM memories WHERE persona_id = ? AND confirmation = ?
               ORDER BY updated_at DESC, seq DESC`,
            )
            .all(personaId, confirmation);
    return rows.map(toItem);
  }

  /** Called synchronously after each successful mutation with the affected persona. */
  subscribe(listener: (personaId: PersonaId) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  forPersona(personaId: PersonaId): PersonaMemory {
    return {
      list: () => this.list(personaId),
      confirm: (id) => this.confirm(personaId, id),
      update: (id, text) => this.update(personaId, id, text),
      remove: (id) => this.remove(personaId, id),
      subscribe: (listener) =>
        this.subscribe((changed) => {
          if (changed === personaId) listener();
        }),
    };
  }

  close(): void {
    this.db.close();
  }

  private emit(personaId: PersonaId): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(personaId);
      } catch {
        // A broken listener must not undo or fail the mutation.
      }
    }
  }
}
