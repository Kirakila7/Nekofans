// Raw chat history backed by conversations.sqlite (node:sqlite).
// Every query is keyed by persona_id so one persona never sees another's
// messages, even when conversation ids collide. append is idempotent on id.

import { DatabaseSync } from "node:sqlite";
import type { SQLOutputValue } from "node:sqlite";

import type {
  ChatMessage,
  ConversationStore,
  PersonaId,
} from "../../app-contracts/src/chat.ts";
import { SCHEMA_SQL } from "./schema.ts";

type Row = Record<string, SQLOutputValue>;

function toMessage(row: Row): ChatMessage {
  return {
    id: row["id"] as string,
    personaId: row["persona_id"] as string,
    conversationId: row["conversation_id"] as string,
    role: row["role"] as ChatMessage["role"],
    text: row["text"] as string,
    createdAt: Number(row["created_at"]),
  };
}

function sameMessage(a: ChatMessage, b: ChatMessage): boolean {
  return (
    a.personaId === b.personaId &&
    a.conversationId === b.conversationId &&
    a.role === b.role &&
    a.text === b.text &&
    a.createdAt === b.createdAt
  );
}

const SELECT_COLUMNS = "id, persona_id, conversation_id, role, text, created_at";

export class SqliteConversationStore implements ConversationStore {
  private readonly db: DatabaseSync;

  /** dbPath is required so the database never lands in an implicit cwd. */
  constructor(dbPath: string) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec(SCHEMA_SQL);
  }

  async append(message: ChatMessage): Promise<void> {
    if (!Number.isSafeInteger(message.createdAt)) {
      throw new Error(`message ${message.id}: createdAt must be an integer epoch ms`);
    }
    const existing = this.db
      .prepare(`SELECT ${SELECT_COLUMNS} FROM messages WHERE id = ?`)
      .get(message.id);
    if (existing !== undefined) {
      if (sameMessage(toMessage(existing), message)) return;
      throw new Error(`message id ${message.id} already exists with different content`);
    }
    this.db
      .prepare(
        `INSERT INTO messages (id, persona_id, conversation_id, role, text, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        message.id,
        message.personaId,
        message.conversationId,
        message.role,
        message.text,
        message.createdAt,
      );
  }

  async recent(personaId: PersonaId, conversationId: string, limit: number): Promise<ChatMessage[]> {
    if (!Number.isInteger(limit) || limit <= 0) return [];
    const rows = this.db
      .prepare(
        `SELECT ${SELECT_COLUMNS} FROM messages
         WHERE persona_id = ? AND conversation_id = ?
         ORDER BY seq DESC LIMIT ?`,
      )
      .all(personaId, conversationId, limit);
    return rows.reverse().map(toMessage);
  }

  async pageBefore(personaId: string, conversationId: string, beforeId: string, limit: number): Promise<ChatMessage[]> {
    if(!Number.isInteger(limit)||limit<1||limit>200)throw new Error('Invalid page size');
    const position=this.db.prepare('SELECT seq FROM messages WHERE persona_id = ? AND conversation_id = ? AND id = ?').get(personaId,conversationId,beforeId);
    if(!position)throw new Error('Message is not in this conversation');
    return this.db.prepare(`SELECT ${SELECT_COLUMNS} FROM messages WHERE persona_id = ? AND conversation_id = ? AND seq < ? ORDER BY seq DESC LIMIT ?`).all(personaId,conversationId,position.seq,limit).reverse().map(toMessage);
  }
  async before(personaId: string, conversationId: string, beforeId: string, afterId: string | null, limit: number): Promise<ChatMessage[]> {
    if (!Number.isInteger(limit) || limit <= 0 || limit > 256) throw new Error("Invalid archive page size.");
    const position = (id: string): number => {
      const row = this.db.prepare("SELECT seq FROM messages WHERE persona_id = ? AND conversation_id = ? AND id = ?").get(personaId, conversationId, id);
      if (!row) throw new Error("Message is not in this conversation.");
      return Number(row.seq);
    };
    const before = position(beforeId), after = afterId === null ? 0 : position(afterId);
    return this.db.prepare(`SELECT ${SELECT_COLUMNS} FROM messages
      WHERE persona_id = ? AND conversation_id = ? AND seq > ? AND seq < ? ORDER BY seq LIMIT ?`)
      .all(personaId, conversationId, after, before, limit).map(toMessage);
  }

  async byIds(personaId: string, conversationId: string, ids: readonly string[]): Promise<ChatMessage[]> {
    if (ids.length > 256) throw new Error("Too many message identities.");
    const statement = this.db.prepare(`SELECT ${SELECT_COLUMNS} FROM messages WHERE persona_id = ? AND conversation_id = ? AND id = ?`);
    return ids.flatMap((id) => {
      const row = statement.get(personaId, conversationId, id);
      return row ? [toMessage(row)] : [];
    });
  }

  /** Conversation of the most recently appended message for this persona. */
  latestConversationId(personaId: PersonaId): string | null {
    const row = this.db
      .prepare("SELECT conversation_id FROM messages WHERE persona_id = ? ORDER BY seq DESC LIMIT 1")
      .get(personaId);
    return row === undefined ? null : (row["conversation_id"] as string);
  }

  close(): void {
    this.db.close();
  }
}
