// F10 speech input (ASR). Push-to-talk: startRecording() when the hotkey goes
// down, handle.stop() when it is released. Interim text is display-only and is
// delivered to onTranscriptInterim subscribers. Final transcripts go to
// onTranscriptFinal subscribers (app-coordinator voice-turn.ts commits them).
//
// Delivery of finals is at-least-once: a provider may replay a final (for
// example after a reconnect), so consumers deduplicate by utterance_id.

import { randomUUID } from "node:crypto";

import { SidecarAsrProvider } from "./asr-sidecar.ts";

export type AsrEvent =
  | { kind: "partial"; utterance_id: string; text: string }
  | { kind: "final"; utterance_id: string; text: string }
  | { kind: "empty"; utterance_id: string }
  | { kind: "error"; utterance_id: string | null; error_code: string; error_message: string };

/** Pluggable ASR engine. Audio is PCM16LE, mono, 16 kHz. */
export interface AsrProvider {
  readonly name: string;
  start(utterance_id: string): Promise<void>;
  pushAudio(utterance_id: string, pcm16: Uint8Array): void;
  /** Commit the utterance; its outcome arrives later as a final/empty/error event. */
  stop(utterance_id: string): Promise<void>;
  onEvent(handler: (event: AsrEvent) => void): () => void;
  close(): Promise<void>;
}

export type TranscriptResult =
  | { kind: "final"; utterance_id: string; text: string }
  | { kind: "empty"; utterance_id: string }
  | { kind: "error"; utterance_id: string; error_code: string; error_message: string };

export interface RecordingHandle {
  utterance_id: string;
  pushAudio(pcm16: Uint8Array): void;
  /** Release the hotkey: resolves with the final, empty or error outcome. */
  stop(): Promise<TranscriptResult>;
}

export type TranscriptInterimHandler = (event: { utterance_id: string; text: string }) => void;
export type TranscriptFinalHandler = (event: { utterance_id: string; text: string }) => void;

export interface AsrInputOptions {
  /** Max wait between stop() and the final event. */
  final_timeout_ms?: number;
}

const DEFAULT_FINAL_TIMEOUT_MS = 30_000;

/** Push-to-talk session over one AsrProvider. */
export class AsrInput {
  readonly provider: AsrProvider;
  #interim = new Set<TranscriptInterimHandler>();
  #final = new Set<TranscriptFinalHandler>();
  #pending = new Map<string, (result: TranscriptResult) => void>();
  #finalTimeoutMs: number;
  #unsubscribe: () => void;

  constructor(provider: AsrProvider, options: AsrInputOptions = {}) {
    this.provider = provider;
    this.#finalTimeoutMs = options.final_timeout_ms ?? DEFAULT_FINAL_TIMEOUT_MS;
    this.#unsubscribe = provider.onEvent((event) => this.#onEvent(event));
  }

  startRecording(utterance_id: string = randomUUID()): RecordingHandle {
    if (this.#pending.has(utterance_id)) throw new Error(`utterance ${utterance_id} is already recording`);
    const provider = this.provider;
    let timer: NodeJS.Timeout | undefined;
    const result = new Promise<TranscriptResult>((resolve) => {
      this.#pending.set(utterance_id, (r) => {
        clearTimeout(timer);
        resolve(r);
      });
    });
    const fail = (code: string, err: unknown) =>
      this.#settle({ kind: "error", utterance_id, error_code: code, error_message: (err as Error)?.message ?? String(err) });

    // Every provider call is chained after start() so audio never overtakes it.
    // The chain never rejects: failures settle the handle instead.
    let failed = false;
    let chain: Promise<void> = provider.start(utterance_id).catch((err) => {
      failed = true;
      fail("ASR_START_FAILED", err);
    });
    let stopped = false;

    return {
      utterance_id,
      pushAudio: (pcm16) => {
        if (stopped) return;
        chain = chain.then(() => {
          if (!failed) provider.pushAudio(utterance_id, pcm16);
        });
      },
      stop: () => {
        if (!stopped) {
          stopped = true;
          chain = chain.then(async () => {
            if (failed) return;
            try {
              await provider.stop(utterance_id);
            } catch (err) {
              fail("ASR_STOP_FAILED", err);
              return;
            }
            timer = setTimeout(
              () => fail("ASR_FINAL_TIMEOUT", new Error(`no final within ${this.#finalTimeoutMs}ms`)),
              this.#finalTimeoutMs,
            );
          });
        }
        return result;
      },
    };
  }

  /** Display-only captions. Never stored. */
  onTranscriptInterim(handler: TranscriptInterimHandler): () => void {
    this.#interim.add(handler);
    return () => this.#interim.delete(handler);
  }

  /** Final transcripts (at-least-once; deduplicate by utterance_id). */
  onTranscriptFinal(handler: TranscriptFinalHandler): () => void {
    this.#final.add(handler);
    return () => this.#final.delete(handler);
  }

  async close(): Promise<void> {
    this.#unsubscribe();
    for (const id of [...this.#pending.keys()]) {
      this.#settle({ kind: "error", utterance_id: id, error_code: "ASR_CLOSED", error_message: "ASR input closed" });
    }
    await this.provider.close();
  }

  #settle(result: TranscriptResult): void {
    const resolve = this.#pending.get(result.utterance_id);
    if (!resolve) return;
    this.#pending.delete(result.utterance_id);
    resolve(result);
  }

  #onEvent(event: AsrEvent): void {
    switch (event.kind) {
      case "partial":
        // Captions only while the utterance is still open.
        if (!this.#pending.has(event.utterance_id)) return;
        for (const h of this.#interim) h({ utterance_id: event.utterance_id, text: event.text });
        return;
      case "final":
        this.#settle(event);
        for (const h of this.#final) h({ utterance_id: event.utterance_id, text: event.text });
        return;
      case "empty":
        this.#settle(event);
        return;
      case "error":
        if (event.utterance_id !== null) {
          this.#settle({ ...event, utterance_id: event.utterance_id });
        } else {
          // Connection-level failure: every open utterance is lost.
          for (const id of [...this.#pending.keys()]) this.#settle({ ...event, utterance_id: id });
        }
        return;
    }
  }
}

// ---- Module-level default (VoiceService) ----

let defaultInput: AsrInput | null = null;

/** Replace the default ASR input. Call before subscribing. */
export function configureAsr(provider: AsrProvider, options?: AsrInputOptions): AsrInput {
  defaultInput = new AsrInput(provider, options);
  return defaultInput;
}

/** Default input: the local neko-asr sidecar (services/neko-asr, port 59067). */
export function defaultAsrInput(): AsrInput {
  defaultInput ??= new AsrInput(new SidecarAsrProvider());
  return defaultInput;
}

export function startRecording(): RecordingHandle {
  return defaultAsrInput().startRecording();
}

export function onTranscriptInterim(handler: TranscriptInterimHandler): () => void {
  return defaultAsrInput().onTranscriptInterim(handler);
}

export function onTranscriptFinal(handler: TranscriptFinalHandler): () => void {
  return defaultAsrInput().onTranscriptFinal(handler);
}
