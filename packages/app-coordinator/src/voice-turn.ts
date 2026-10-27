// F10 glue: final voice transcript -> MemoryTurn -> MemoryClient.commitTurn.
// Interim transcripts only reach the caption callback and are never stored.
// Text and voice turns go through the same ConversationTurns.commit path, so
// both are deduplicated by turn_id (receipts in app.sqlite plus an in-flight
// guard for concurrent duplicates within this process).

import type {
  AssistantDelivery,
  CharacterId,
  MemoryTurn,
  MemoryTurnScope,
} from "../../app-contracts/src/index.ts";
import type { Receipt } from "../../memory-adapter/src/memory-client.ts";
import type { TranscriptFinalHandler, TranscriptInterimHandler } from "../../voice-adapter/src/asr.ts";

/** The part of MemoryClient this module uses. */
export interface TurnMemory {
  commitTurn(turn: MemoryTurn): Promise<Receipt>;
  replayCheck?(turn_id: string): boolean;
}

export interface TurnContext {
  character_id: CharacterId;
  scope: MemoryTurnScope;
  project_id?: string;
  session_id?: string;
}

export interface AssistantReply {
  assistant_text: string;
  assistant_delivery: AssistantDelivery;
}

/** turn_id of a voice turn; stable across replays of the same utterance. */
export function voiceTurnId(utterance_id: string): string {
  return `voice:${utterance_id}`;
}

export class ConversationTurns {
  #memory: TurnMemory;
  #context: TurnContext;
  #inflight = new Map<string, Promise<Receipt>>();

  constructor(memory: TurnMemory, context: TurnContext) {
    this.#memory = memory;
    this.#context = context;
  }

  /** True when turn_id already has a receipt (persisted) or is being committed. */
  isCommitted(turn_id: string): boolean {
    return this.#inflight.has(turn_id) || (this.#memory.replayCheck?.(turn_id) ?? false);
  }

  commitText(turn_id: string, user_text: string, reply: AssistantReply): Promise<Receipt> {
    return this.commit(this.#build(turn_id, "text", user_text, reply, null));
  }

  commitVoice(utterance_id: string, user_text: string, reply: AssistantReply): Promise<Receipt> {
    return this.commit(this.#build(voiceTurnId(utterance_id), "voice", user_text, reply, utterance_id));
  }

  /** Single write path for every turn kind. */
  commit(turn: MemoryTurn): Promise<Receipt> {
    const existing = this.#inflight.get(turn.turn_id);
    if (existing) return existing.then(() => ({ kind: "already_submitted", turn_id: turn.turn_id }));
    const pending = this.#memory.commitTurn(turn).finally(() => this.#inflight.delete(turn.turn_id));
    this.#inflight.set(turn.turn_id, pending);
    return pending;
  }

  #build(
    turn_id: string,
    source_kind: "text" | "voice",
    user_text: string,
    reply: AssistantReply,
    utterance_id: string | null,
  ): MemoryTurn {
    const c = this.#context;
    return {
      schema_version: "0.1-draft",
      character_id: c.character_id,
      turn_id,
      source_kind,
      created_at: new Date().toISOString(),
      scope: c.scope,
      ...(c.project_id ? { project_id: c.project_id } : {}),
      ...(c.session_id ? { session_id: c.session_id } : {}),
      ...(utterance_id ? { utterance_id } : {}),
      user_text,
      assistant_text: reply.assistant_text,
      assistant_delivery: reply.assistant_delivery,
    };
  }
}

/** The part of AsrInput this module subscribes to. */
export interface TranscriptSource {
  onTranscriptInterim(handler: TranscriptInterimHandler): () => void;
  onTranscriptFinal(handler: TranscriptFinalHandler): () => void;
}

export interface VoiceTurnOptions {
  asr: TranscriptSource;
  turns: ConversationTurns;
  /** Produce the assistant reply for a confirmed user utterance. */
  respond(user_text: string, utterance_id: string): Promise<AssistantReply>;
  onCaption?(caption: { utterance_id: string; text: string; final: boolean }): void;
  onCommitted?(utterance_id: string, receipt: Receipt): void;
  onError?(utterance_id: string, error: unknown): void;
}

export interface VoiceTurnBinding {
  /** Outcome of the first delivery of utterance_id's final, if seen. */
  settled(utterance_id: string): Promise<Receipt> | undefined;
  detach(): void;
}

/** Subscribe to an ASR input: interim -> caption, final -> reply -> commit once. */
export function attachVoiceTurns(options: VoiceTurnOptions): VoiceTurnBinding {
  const { asr, turns } = options;
  const handled = new Map<string, Promise<Receipt>>();

  const offInterim = asr.onTranscriptInterim(({ utterance_id, text }) => {
    options.onCaption?.({ utterance_id, text, final: false });
  });

  const offFinal = asr.onTranscriptFinal(({ utterance_id, text }) => {
    // A replayed final must not produce a second reply or a second write.
    if (handled.has(utterance_id)) return;
    const turn_id = voiceTurnId(utterance_id);
    if (turns.isCommitted(turn_id)) {
      handled.set(utterance_id, Promise.resolve({ kind: "already_submitted", turn_id }));
      return;
    }
    options.onCaption?.({ utterance_id, text, final: true });
    const outcome = (async (): Promise<Receipt> => {
      const reply = await options.respond(text, utterance_id);
      return turns.commitVoice(utterance_id, text, reply);
    })();
    handled.set(utterance_id, outcome);
    outcome.then(
      (receipt) => {
        // A failed write may be retried by a later replay of the same final.
        if (receipt.kind === "error") handled.delete(utterance_id);
        options.onCommitted?.(utterance_id, receipt);
      },
      (err) => {
        handled.delete(utterance_id);
        options.onError?.(utterance_id, err);
      },
    );
  });

  return {
    settled: (utterance_id) => handled.get(utterance_id),
    detach() {
      offInterim();
      offFinal();
    },
  };
}
