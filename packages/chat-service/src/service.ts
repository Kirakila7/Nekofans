// Framework v1 main-chat send pipeline for the main character.
// user input -> persona -> (optional) memory recall -> recent history -> ChatProvider.stream
// -> streaming state -> raw messages saved -> pending memory proposals. One turn at a time.
// API failures resolve as { status: "error" } with fixed user-facing text; upstream text and
// keys never reach the UI.
// Main chat has no DSH dependency by design.

import { randomUUID } from "node:crypto";
import type {
  ChatMessage,
  ChatProvider,
  ConversationStore,
  MainChatPort,
  MainChatState,
  MainChatTurnResult,
  MemoryItem,
  MemoryProvider,
  Persona,
} from "../../app-contracts/src/chat.ts";
import { ChatApiError } from "../../chat-api/src/index.ts";
import type { ConversationSummary, SummaryProvider } from "../../app-contracts/src/summary.ts";

export interface MainChatServiceOptions {
  /** A getter is re-evaluated on every turn so persona edits apply without a restart. */
  persona: Persona | (() => Persona);
  provider: ChatProvider;
  conversations: ConversationStore;
  memory?: MemoryProvider;
  summaries?: SummaryProvider;
  memoryContext?: (personaId: string, query: string, budget: number, signal: AbortSignal) => Promise<import("../../app-contracts/src/chat.ts").RecalledMemory[]>;
  onTurnSaved?: (user: ChatMessage, assistant: ChatMessage) => Promise<void>;
  /** Separate budget for derived context, including metadata. Default 4000 characters. */
  summaryBudgetChars?: number;
  /** Summaries are optional context; never block a reply for longer than this. Default 1000 ms. */
  summaryTimeoutMs?: number;
  /**
   * Extracts memory proposals from the saved user message of a completed turn. Used only
   * together with memory; items for another persona are dropped, the rest go to
   * memory.propose (stored as pending). Failures only warn.
   */
  proposeMemories?: (message: ChatMessage) => MemoryItem[];
  conversationId: string;
  /** Messages of recent history sent with each turn, new user message included. Default 20. */
  historyLimit?: number;
  /** Maximum UTF-16 characters in recent message text. Default 16000; minimum 8000. */
  historyBudgetChars?: number;
  /** Default 1024. */
  maxOutputTokens?: number;
  /** Token budget passed to memory recall. Default 512. */
  memoryBudgetTokens?: number;
  /** Maximum wait for all memory proposals after saving a reply. Default 1000 ms. */
  proposalTimeoutMs?: number;
  newId?: () => string;
  now?: () => number;
  /** Internal warnings (recall or proposal failure, turn failure codes, listener errors). Default console.warn. */
  warn?: (message: string) => void;
}

const ERROR_TEXT: Readonly<Record<string, string>> = {
  not_configured: "聊天 API 还没配置好（地址、模型或密钥）",
  auth: "API 密钥无效或没有权限",
  rate_limit: "请求太频繁或额度不足，稍后再试",
  timeout: "聊天 API 响应超时",
  network: "连不上聊天 API",
  refusal: "模型没有回答这条消息",
  empty: "模型没有返回内容",
  storage: "聊天记录保存失败",
  persona: "角色设定读取失败",
};
const DEFAULT_ERROR_TEXT = "聊天 API 出错了";
// Matches the overlay IPC limit; enforce it here too for callers that bypass IPC.
const MAX_INPUT_CHARS = 8000;
const API_FAILURE_CODES = new Set([
  "not_configured", "auth", "rate_limit", "http", "network", "timeout", "refusal", "empty", "bad_response",
]);

/** Short user-facing text for an error code; unknown codes get the generic text. */
export function chatErrorText(code: string): string {
  return Object.hasOwn(ERROR_TEXT, code) ? ERROR_TEXT[code] : DEFAULT_ERROR_TEXT;
}

/** Rejection value used when a wait is interrupted by cancel(). */
const CANCELLED = Symbol("cancelled");
const PROPOSAL_TIMEOUT = Symbol("proposal timeout");

function positiveInt(value: number | undefined, fallback: number, field: string): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${field} must be a positive integer`);
  return value;
}

export class MainChatService implements MainChatPort {
  readonly conversationId: string;
  private readonly resolvePersona: () => Persona;
  private readonly provider: ChatProvider;
  private readonly conversations: ConversationStore;
  private readonly memory: MemoryProvider | undefined;
  private readonly memoryContext: MainChatServiceOptions["memoryContext"];
  private readonly onTurnSaved: MainChatServiceOptions["onTurnSaved"];
  private readonly summaries: SummaryProvider | undefined;
  private readonly summaryBudgetChars: number;
  private readonly summaryTimeoutMs: number;
  private readonly proposeMemories: ((message: ChatMessage) => MemoryItem[]) | undefined;
  private readonly historyLimit: number;
  private readonly historyBudgetChars: number;
  private readonly maxOutputTokens: number;
  private readonly memoryBudgetTokens: number;
  private readonly proposalTimeoutMs: number;
  private readonly newId: () => string;
  private readonly now: () => number;
  private readonly warn: (message: string) => void;
  private readonly listeners = new Set<(state: MainChatState) => void>();
  private current: MainChatState;
  private turn: AbortController | null = null;
  private disposed = false;

  constructor(opts: MainChatServiceOptions) {
    const persona = opts.persona;
    this.resolvePersona = typeof persona === "function" ? persona : () => persona;
    this.provider = opts.provider;
    this.conversations = opts.conversations;
    this.memory = opts.memory;
    this.memoryContext = opts.memoryContext;
    this.onTurnSaved = opts.onTurnSaved;
    this.summaries = opts.summaries;
    this.summaryBudgetChars = positiveInt(opts.summaryBudgetChars, 4000, "summaryBudgetChars");
    this.summaryTimeoutMs = positiveInt(opts.summaryTimeoutMs, 1000, "summaryTimeoutMs");
    this.proposeMemories = opts.proposeMemories;
    this.conversationId = opts.conversationId;
    this.historyLimit = positiveInt(opts.historyLimit, 20, "historyLimit");
    this.historyBudgetChars = positiveInt(opts.historyBudgetChars, 16000, "historyBudgetChars");
    if (this.historyBudgetChars < MAX_INPUT_CHARS) throw new Error("historyBudgetChars must be at least 8000");
    this.maxOutputTokens = positiveInt(opts.maxOutputTokens, 1024, "maxOutputTokens");
    this.memoryBudgetTokens = positiveInt(opts.memoryBudgetTokens, 512, "memoryBudgetTokens");
    this.proposalTimeoutMs = positiveInt(opts.proposalTimeoutMs, 1000, "proposalTimeoutMs");
    this.newId = opts.newId ?? randomUUID;
    this.now = opts.now ?? Date.now;
    this.warn = opts.warn ?? ((message) => console.warn(message));
    this.current = { personaId: this.resolvePersona().id, phase: "idle" };
  }

  state(): MainChatState {
    return { ...this.current };
  }

  subscribe(listener: (state: MainChatState) => void): () => void {
    this.listeners.add(listener);
    this.notify(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async send(text: string): Promise<MainChatTurnResult> {
    // Everything before the first await runs synchronously, so a second send() in the same
    // tick already sees this.turn.
    if (this.disposed) throw new Error("disposed");
    if (typeof text === "string" && text.length > MAX_INPUT_CHARS) throw new Error("input too long");
    const input = typeof text === "string" ? text.trim() : "";
    if (input.length === 0) throw new Error("empty input");
    if (this.turn) throw new Error("busy");
    const controller = new AbortController();
    this.turn = controller;
    try {
      return await this.runTurn(input, controller.signal);
    } finally {
      if (this.turn === controller) this.turn = null;
    }
  }

  cancel(): boolean {
    if (!this.turn || this.turn.signal.aborted) return false;
    this.turn.abort();
    return true;
  }

  dispose(): void {
    this.cancel();
    this.listeners.clear();
    this.disposed = true;
  }

  private async runTurn(input: string, signal: AbortSignal): Promise<MainChatTurnResult> {
    let persona: Persona;
    try {
      persona = this.resolvePersona();
    } catch {
      this.warn("main chat: persona unavailable");
      return this.fail(this.current.personaId, input, "", "persona");
    }
    const personaId = persona.id;
    const cancelled = (partial: string): MainChatTurnResult =>
      this.finish({ personaId, phase: "idle", lastUserMessage: input, reply: "" }, { status: "cancelled", partial });

    // Rejects with CANCELLED as soon as cancel() aborts, so a stalled step cannot block it.
    const abortWait = new Promise<never>((_, reject) => {
      if (signal.aborted) reject(CANCELLED);
      else signal.addEventListener("abort", () => reject(CANCELLED), { once: true });
    });
    abortWait.catch(() => {});
    const untilCancelled = <T>(p: Promise<T>): Promise<T> => Promise.race([p, abortWait]);

    const userMessage: ChatMessage = {
      id: this.newId(),
      personaId,
      conversationId: this.conversationId,
      role: "user",
      text: input,
      createdAt: this.now(),
    };
    try {
      await this.conversations.append(userMessage);
    } catch {
      this.warn("main chat: saving the user message failed");
      return this.fail(personaId, input, "", "storage");
    }
    if (signal.aborted) return cancelled("");
    this.setState({ personaId, phase: "connecting", lastUserMessage: input, reply: "" });

    let memories: MemoryItem[] = [];
    let summaries: ConversationSummary[] = [];
    let memoryContext: import("../../app-contracts/src/chat.ts").RecalledMemory[] | undefined;
    let messages: ChatMessage[];
    try {
      if (this.memoryContext) {
        const deadline = new AbortController();
        const combined = AbortSignal.any([signal, deadline.signal]);
        const timer = setTimeout(() => deadline.abort(), 2000);
        try {
          memoryContext = await untilCancelled(Promise.race([
            this.memoryContext(personaId, input, this.memoryBudgetTokens, combined),
            new Promise<never>((_, reject) => combined.addEventListener("abort", () => reject(CANCELLED), { once: true })),
          ]));
        } catch (error) {
          if (signal.aborted) throw error;
          this.warn("main chat: memory context unavailable, continuing without recalled context");
          memoryContext = [];
        } finally { clearTimeout(timer); }
      } else if (this.memory) {
        try {
          memories = await untilCancelled(this.memory.recall(personaId, input, this.memoryBudgetTokens));
        } catch (error) {
          if (error === CANCELLED) throw error;
          this.warn("main chat: memory recall failed, continuing without memories");
          memories = [];
        }
      }
      try {
        const recent = await untilCancelled(this.conversations.recent(personaId, this.conversationId, this.historyLimit));
        messages = this.boundedHistory(recent, userMessage);
      } catch (error) {
        if (error === CANCELLED) throw error;
        this.warn("main chat: loading history failed");
        return this.fail(personaId, input, "", "storage");
      }
      summaries = await untilCancelled(this.loadSummaries(personaId, input, messages, signal));
    } catch {
      return cancelled("");
    }

    let reply = "";
    let completedId: string | null = null;
    try {
      const iterator = this.provider
        .stream({ persona, messages, memories, summaries, memoryContext, maxOutputTokens: this.maxOutputTokens, signal })
        [Symbol.asyncIterator]();
      try {
        while (true) {
          const step = await untilCancelled(iterator.next());
          if (step.done) break;
          const event = step.value;
          if (event.type === "complete") {
            completedId = event.messageId;
            break;
          }
          if (event.type === "delta" && event.text.length > 0) {
            reply += event.text;
            this.setState({ personaId, phase: "replying", lastUserMessage: input, reply });
          }
        }
      } finally {
        // Release the provider; if a next() is still pending this settles after it.
        void Promise.resolve(iterator.return?.()).catch(() => {});
      }
    } catch (error) {
      if (signal.aborted || error === CANCELLED || (error instanceof ChatApiError && error.code === "cancelled")) {
        return cancelled(reply);
      }
      const code = error instanceof ChatApiError && API_FAILURE_CODES.has(error.code) ? error.code : "internal";
      this.warn(`main chat: turn failed with ${code}`);
      return this.fail(personaId, input, reply, code);
    }

    if (signal.aborted) return cancelled(reply);
    if (completedId === null || reply.length === 0) {
      const code = reply.length === 0 ? "empty" : "bad_response";
      this.warn(`main chat: turn failed with ${code}`);
      return this.fail(personaId, input, reply, code);
    }

    const assistantMessage: ChatMessage = {
      id: completedId,
      personaId,
      conversationId: this.conversationId,
      role: "assistant",
      text: reply,
      createdAt: this.now(),
    };
    try {
      await this.conversations.append(assistantMessage);
    } catch {
      this.warn("main chat: saving the reply failed");
      return this.fail(personaId, input, reply, "storage");
    }
    // The reply is committed now. Cancellation only skips optional proposal work; returning
    // completed preserves the contract that only completed turns have a saved assistant reply.
    await this.storeProposals(userMessage, signal);
    if (this.onTurnSaved) {
      // Older native extraction can hold the delivery queue for a model request.
      // The committed raw turn is the recovery source; do not hold completion
      // (or cancellation after the save) behind this optional handoff.
      void Promise.resolve().then(() => this.onTurnSaved!(userMessage, assistantMessage))
        .catch(() => this.warn("main chat: memory handoff pending; raw turn remains stored for recovery"));
    }
    return this.finish(
      { personaId, phase: "idle", lastUserMessage: input, reply },
      { status: "completed", messageId: completedId, text: reply },
    );
  }

  /** Keep a contiguous suffix without changing the raw messages stored on disk. */
  private boundedHistory(recent: ChatMessage[], latest: ChatMessage): ChatMessage[] {
    const history = recent.filter((m) => m.id !== latest.id && m.personaId === latest.personaId && m.conversationId === latest.conversationId);
    const selected = [latest];
    let chars = latest.text.length;
    for (let i = history.length - 1; i >= 0 && selected.length < this.historyLimit; i--) {
      const message = history[i];
      if (chars + message.text.length > this.historyBudgetChars) break;
      selected.unshift(message);
      chars += message.text.length;
    }
    // The HTTP adapter starts a request with a user turn. Drop the orphaned
    // assistant prefix here too, so summaries cover it instead of losing it
    // between the recent-context boundary and wire normalization.
    while (selected.length > 1 && selected[0].role === "assistant") selected.shift();
    return selected;
  }

  private async loadSummaries(personaId: string, query: string, messages: ChatMessage[], signal: AbortSignal): Promise<ConversationSummary[]> {
    if (!this.summaries || signal.aborted || this.disposed) return [];
    const deadline = new AbortController();
    const combined = AbortSignal.any([signal, deadline.signal]);
    const timer = setTimeout(() => deadline.abort(), this.summaryTimeoutMs);
    let onAbort = () => {};
    const stopped = new Promise<never>((_yes, no) => { onAbort = () => no(CANCELLED); combined.addEventListener("abort", onAbort, { once: true }); });
    try {
      const result = await Promise.race([this.summaries.context({ personaId, conversationId: this.conversationId,
        beforeId: messages[0].id, query, budgetChars: this.summaryBudgetChars, signal: combined }), stopped]);
      if (signal.aborted || this.disposed) return [];
      const recentIds = new Set(messages.map((m) => m.id));
      let used = 0;
      return result.filter((s) => {
        if (s.personaId !== personaId || s.conversationId !== this.conversationId || s.sourceMessageIds.some((id) => recentIds.has(id))) return false;
        const cost = JSON.stringify(s).length;
        if (used + cost > this.summaryBudgetChars) return false;
        used += cost; return true;
      });
    } catch {
      if (!signal.aborted && !this.disposed) this.warn("main chat: summary context unavailable, continuing without summaries");
      return [];
    } finally { clearTimeout(timer); combined.removeEventListener("abort", onAbort); }
  }

  /** Bounded best effort: one stalled proposal cannot keep the completed chat busy. */
  private async storeProposals(userMessage: ChatMessage, signal: AbortSignal): Promise<void> {
    const memory = this.memory;
    if (!memory || !this.proposeMemories || signal.aborted || this.disposed) return;
    let items: MemoryItem[];
    try {
      items = this.proposeMemories(userMessage);
    } catch {
      this.warn("main chat: extracting memory proposals failed");
      return;
    }
    if (!Array.isArray(items)) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort = () => {};
    const stopped = new Promise<never>((_, reject) => {
      onAbort = () => reject(CANCELLED);
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
      timer = setTimeout(() => reject(PROPOSAL_TIMEOUT), this.proposalTimeoutMs);
    });
    stopped.catch(() => {});
    try {
      for (const item of items) {
        if (signal.aborted || this.disposed) return;
        if (item?.personaId !== userMessage.personaId) continue;
        try {
          await Promise.race([memory.propose(item), stopped]);
        } catch (error) {
          if (error === CANCELLED || signal.aborted || this.disposed) return;
          if (error === PROPOSAL_TIMEOUT) {
            this.warn("main chat: memory proposals timed out");
            return;
          }
          this.warn("main chat: storing a memory proposal failed");
        }
      }
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    }
  }

  private fail(personaId: string, input: string, partial: string, code: string): MainChatTurnResult {
    const message = chatErrorText(code);
    return this.finish(
      { personaId, phase: "error", lastUserMessage: input, reply: partial, errorMessage: message },
      { status: "error", code, message },
    );
  }

  /** Ends the turn before announcing the final state, so listeners may send() again. */
  private finish(state: MainChatState, result: MainChatTurnResult): MainChatTurnResult {
    this.turn = null;
    this.setState(state);
    return result;
  }

  private setState(state: MainChatState): void {
    if (this.disposed) return;
    this.current = state;
    for (const listener of [...this.listeners]) this.notify(listener);
  }

  private notify(listener: (state: MainChatState) => void): void {
    try {
      listener(this.state());
    } catch {
      this.warn("main chat: state listener threw");
    }
  }
}
