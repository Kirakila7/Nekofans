import { DatabaseSync, type SQLOutputValue } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import type { ConversationArchive, ConversationSummary, SummaryProvider, PersonaSummaries } from "../../app-contracts/src/summary.ts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS conversation_summaries (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE, persona_id TEXT NOT NULL, conversation_id TEXT NOT NULL,
  text TEXT NOT NULL, source_ids TEXT NOT NULL, updated_at INTEGER NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS summaries_by_conversation ON conversation_summaries(persona_id, conversation_id, seq);
CREATE TABLE IF NOT EXISTS summary_progress (
  persona_id TEXT NOT NULL, conversation_id TEXT NOT NULL, last_message_id TEXT NOT NULL,
  PRIMARY KEY(persona_id, conversation_id)
) STRICT;
`;
type Row = Record<string, SQLOutputValue>;
const fromRow = (row: Row): ConversationSummary => ({ id: String(row.id), personaId: String(row.persona_id), conversationId: String(row.conversation_id),
  method: "extractive-v1", text: String(row.text), sourceMessageIds: JSON.parse(String(row.source_ids)), updatedAt: Number(row.updated_at) });

function excerpt(text: string): string {
  const chars = Array.from(text.trim().replace(/\s+/g, " "));
  return chars.length <= 160 ? chars.join("") : `${chars.slice(0, 112).join("")} … ${chars.slice(-40).join("")}`;
}
function keywords(text: string): Set<string> {
  const out = new Set<string>();
  for (const [run] of text.toLowerCase().matchAll(/[\p{Script=Han}]+|[a-z0-9]{2,}/gu)) {
    if (/^[a-z0-9]/.test(run)) out.add(run);
    else for (let i = 0; i < run.length - 1; i++) out.add(run.slice(i, i + 2));
  }
  return out;
}

/** Source-preserving extractive summaries. The cursor survives deletion so deleted context stays deleted. */
export class SqliteSummaryStore implements SummaryProvider {
  private readonly db: DatabaseSync;
  private readonly archive: ConversationArchive;
  private readonly now: () => number;
  private readonly listeners = new Set<(persona: string, conversation: string) => void>();
  private closed = false;

  constructor(path: string, archive: ConversationArchive, options: { now?: () => number } = {}) {
    this.archive = archive; this.now = options.now ?? Date.now;
    this.db = new DatabaseSync(path);
    try { this.db.exec(SCHEMA); } catch (error) { this.db.close(); throw error; }
  }

  async context(input: Parameters<SummaryProvider["context"]>[0]): Promise<ConversationSummary[]> {
    const { personaId, conversationId, beforeId, query, budgetChars, signal } = input;
    const active = () => { if (this.closed || signal.aborted) throw new Error("Summary operation stopped."); };
    active();
    if (!Number.isInteger(budgetChars) || budgetChars <= 0) return [];
    // Bound initial catch-up to 256 messages per turn; subsequent turns continue from the durable cursor.
    for (let page = 0; page < 32; page++) {
      active();
      const cursor = this.cursor(personaId, conversationId);
      const messages = await this.archive.before(personaId, conversationId, beforeId, cursor, 8);
      active();
      if (!messages.length) break;
      if (messages.some((m) => m.personaId !== personaId || m.conversationId !== conversationId)) throw new Error("Invalid summary sources.");
      const text = messages.map((m) => `${m.role === "user" ? "用户原话" : "角色回复"}：${JSON.stringify(excerpt(m.text))}`).join("\n");
      this.db.exec("BEGIN IMMEDIATE");
      let committed = false;
      try {
        if (this.cursor(personaId, conversationId) === cursor) {
          this.db.prepare("INSERT INTO conversation_summaries(id,persona_id,conversation_id,text,source_ids,updated_at) VALUES(?,?,?,?,?,?)")
            .run(randomUUID(), personaId, conversationId, text, JSON.stringify(messages.map((m) => m.id)), this.now());
          this.db.prepare(`INSERT INTO summary_progress VALUES(?,?,?) ON CONFLICT(persona_id,conversation_id) DO UPDATE SET last_message_id=excluded.last_message_id`)
            .run(personaId, conversationId, messages.at(-1)!.id);
          committed = true;
        }
        this.db.exec("COMMIT");
      } catch (error) { this.db.exec("ROLLBACK"); throw error; }
      if (committed) this.emit(personaId, conversationId);
      if (messages.length < 8) break;
      await yieldToEventLoop();
    }
    active();
    const tokens = keywords(query);
    // Page existing history separately from generation. Loading/ranking every
    // excerpt synchronously would prevent the caller's timeout from firing.
    // Keep only identities/costs while ranking, not every historical excerpt.
    const buckets = new Map<number, Array<{ id: string; seq: number; cost: number }>>();
    const pageQuery = this.db.prepare(`SELECT * FROM conversation_summaries
      WHERE persona_id=? AND conversation_id=? AND seq < ? ORDER BY seq DESC LIMIT 64`);
    let beforeSeq = Number.MAX_SAFE_INTEGER;
    while (true) {
      active();
      const rows = pageQuery.all(personaId, conversationId, beforeSeq);
      if (!rows.length) break;
      for (const row of rows) {
        const item = fromRow(row);
        const cost = JSON.stringify(item).length;
        if (cost > budgetChars) continue;
        const lower = item.text.toLowerCase();
        let score = 0;
        for (const token of tokens) if (lower.includes(token)) score++;
        let bucket = buckets.get(score);
        if (!bucket) { bucket = []; buckets.set(score, bucket); }
        bucket.push({ id: item.id, seq: Number(row.seq), cost });
      }
      beforeSeq = Number(rows.at(-1)!.seq);
      await yieldToEventLoop();
      active();
      if (rows.length < 64) break;
    }
    const selected: Array<{ item: ConversationSummary; seq: number }> = [];
    const selectedQuery = this.db.prepare("SELECT * FROM conversation_summaries WHERE persona_id=? AND conversation_id=? AND id=?");
    let used = 0;
    let visited = 0;
    // Buckets retain newest-first order; only the small set of score keys needs
    // sorting. Yield while skipping candidates too, including a full budget.
    for (const score of [...buckets.keys()].sort((a, b) => b - a)) {
      for (const candidate of buckets.get(score)!) {
        if (++visited % 64 === 0) { await yieldToEventLoop(); active(); }
        if (used + candidate.cost > budgetChars) continue;
        const row = selectedQuery.get(personaId, conversationId, candidate.id);
        // A user may delete a summary while a later page is being ranked.
        if (!row) continue;
        selected.push({ item: fromRow(row), seq: candidate.seq }); used += candidate.cost;
      }
    }
    active();
    // Recheck after the final yield so deletion during ranking cannot reinsert
    // removed context. Restore original chunk order for the model.
    return selected.sort((a, b) => a.seq - b.seq).flatMap(({ item }) => {
      const row = selectedQuery.get(personaId, conversationId, item.id);
      return row ? [fromRow(row)] : [];
    });
  }

  private cursor(persona: string, conversation: string): string | null {
    this.assertOpen();
    const row = this.db.prepare("SELECT last_message_id FROM summary_progress WHERE persona_id=? AND conversation_id=?").get(persona, conversation);
    return row ? String(row.last_message_id) : null;
  }

  async list(persona: string, conversation: string): Promise<ConversationSummary[]> {
    this.assertOpen();
    return this.db.prepare("SELECT * FROM conversation_summaries WHERE persona_id=? AND conversation_id=? ORDER BY seq DESC").all(persona, conversation).map(fromRow);
  }

  private get(persona: string, conversation: string, id: string): ConversationSummary {
    this.assertOpen();
    const row = this.db.prepare("SELECT * FROM conversation_summaries WHERE persona_id=? AND conversation_id=? AND id=?").get(persona, conversation, id);
    if (!row) throw new Error("Summary not found in this conversation.");
    return fromRow(row);
  }

  forConversation(persona: string, conversation: string): PersonaSummaries {
    return {
      list: () => this.list(persona, conversation),
      sources: async (id) => {
        const summary = this.get(persona, conversation, id);
        const sources = await this.archive.byIds(persona, conversation, summary.sourceMessageIds);
        this.assertOpen();
        if (sources.length !== summary.sourceMessageIds.length || sources.some((m, i) => m.personaId !== persona || m.conversationId !== conversation || m.id !== summary.sourceMessageIds[i])) throw new Error("Summary sources are incomplete.");
        return sources;
      },
      remove: async (id) => {
        this.get(persona, conversation, id);
        this.db.prepare("DELETE FROM conversation_summaries WHERE persona_id=? AND conversation_id=? AND id=?").run(persona, conversation, id);
        this.emit(persona, conversation);
      },
      subscribe: (listener) => {
        this.assertOpen();
        const notify = (p: string, c: string) => { if (p === persona && c === conversation) listener(); };
        this.listeners.add(notify); return () => { this.listeners.delete(notify); };
      },
    };
  }

  close(): void { if (!this.closed) { this.closed = true; this.listeners.clear(); this.db.close(); } }
  private assertOpen(): void { if (this.closed) throw new Error("Summary store is closed."); }
  private emit(persona: string, conversation: string): void { for (const listener of [...this.listeners]) { try { listener(persona, conversation); } catch {} } }
}
