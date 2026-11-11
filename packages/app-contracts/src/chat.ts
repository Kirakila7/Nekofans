// Framework v1 main-chat contracts (mirrors 大肥鱼桌宠_项目框架_v1 src/contracts.ts).
// The main character chats through a ChatProvider and keeps its own persona, history and
// memory, all keyed by personaId. Nothing here depends on DSH: MainChatState has no task
// or sub-agent state by design.

export type PersonaId = string;

export interface Persona {
  id: PersonaId;
  name: string;
  /** Full system prompt for this persona, boundaries included. */
  prompt: string;
  memoryNamespace: string;
}

export interface ChatMessage {
  id: string;
  personaId: PersonaId;
  conversationId: string;
  role: "user" | "assistant";
  source?: "qq";
  text: string;
  /** Unix epoch milliseconds. */
  createdAt: number;
}

export interface MemoryItem {
  id: string;
  personaId: PersonaId;
  kind: "fact" | "preference" | "episode" | "summary";
  text: string;
  sourceMessageIds: string[];
  confirmation: "pending" | "confirmed";
  updatedAt: number;
  audioRef?: string;
}

export interface MemoryProvider {
  recall(personaId: PersonaId, query: string, budgetTokens: number): Promise<MemoryItem[]>;
  propose(item: MemoryItem): Promise<void>;
  confirm(personaId: PersonaId, id: string): Promise<void>;
  update(personaId: PersonaId, id: string, text: string): Promise<void>;
  remove(personaId: PersonaId, id: string): Promise<void>;
}

export interface ConversationStore {
  append(message: ChatMessage): Promise<void>;
  /** Most recent messages of one conversation, oldest first. */
  recent(personaId: PersonaId, conversationId: string, limit: number): Promise<ChatMessage[]>;
}

export type ChatEvent = { type: "delta"; text: string } | { type: "complete"; messageId: string };

export interface ChatStreamInput {
  persona: Persona;
  /** Conversation so far, oldest first; the last one is the new user message. */
  messages: ChatMessage[];
  memories: MemoryItem[];
  /** Derived historical context, separate from confirmed memories. */
  summaries?: import("./summary.ts").ConversationSummary[];
  /** Current memory backend only. Inferences remain distinct from user confirmation. */
  memoryContext?: RecalledMemory[];
  maxOutputTokens: number;
  signal: AbortSignal;
}

export interface RecalledMemory {
  kind: "fact" | "preference" | "episode" | "summary";
  text: string;
  visibility: "owner" | "private";
  certainty: "candidate" | "inferred" | "user-confirmed";
  evidenceRefs: string[];
  nativeRef?: { provider: "diary" | "neko"; id: string; nativeStatus?: string };
}

export interface ChatProvider {
  stream(input: ChatStreamInput): AsyncIterable<ChatEvent>;
}

export interface MainChatState {
  personaId: PersonaId;
  phase: "idle" | "connecting" | "replying" | "error";
  lastUserMessage?: string;
  /** Reply text of the current turn so far, or of the last finished turn. */
  reply?: string;
  /** User-facing text of the last failure; set only while phase is "error". */
  errorMessage?: string;
}

/** How one main-chat turn ended. Only "completed" saves an assistant message. */
export type MainChatTurnResult =
  | { status: "completed"; messageId: string; text: string }
  | { status: "error"; code: string; message: string }
  | { status: "cancelled"; partial: string };

/** What the pet overlay needs from the main chat. Main-chat input never reaches DSH. */
export interface MainChatPort {
  state(): MainChatState;
  /** Calls the listener immediately with the current state, then on every change. */
  subscribe(listener: (state: MainChatState) => void): () => void;
  /** One turn at a time: rejects with Error("busy") while a turn runs, Error("empty input") on blank text. */
  send(text: string): Promise<MainChatTurnResult>;
  /** Cancels the running turn; false when nothing is running. */
  cancel(): boolean;
}
