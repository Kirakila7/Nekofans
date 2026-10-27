import type { ChatMessage, ConversationStore } from "./chat.ts";

/** Automatically derived context, never a user-confirmed fact. */
export interface ConversationSummary {
  id: string;
  personaId: string;
  conversationId: string;
  method: "extractive-v1";
  text: string;
  sourceMessageIds: string[];
  updatedAt: number;
}

export interface ConversationArchive extends ConversationStore {
  /** Oldest-first page strictly between two scoped message identities. */
  before(personaId: string, conversationId: string, beforeId: string, afterId: string | null, limit: number): Promise<ChatMessage[]>;
  byIds(personaId: string, conversationId: string, ids: readonly string[]): Promise<ChatMessage[]>;
}

export interface SummaryProvider {
  context(input: { personaId: string; conversationId: string; beforeId: string; query: string; budgetChars: number; signal: AbortSignal }): Promise<ConversationSummary[]>;
}

/** UI capability fixed to one persona and conversation by the main process. */
export interface PersonaSummaries {
  list(): Promise<ConversationSummary[]>;
  sources(id: string): Promise<ChatMessage[]>;
  remove(id: string): Promise<void>;
  subscribe(listener: () => void): () => void;
}
