// F10 deterministic in-process ASR provider for tests: one partial per audio
// chunk (until the scripted partials run out), then the final on stop.

import type { AsrEvent, AsrProvider } from "./asr.ts";

export interface FakeAsrScript {
  partials: string[];
  final: string;
  /** Emit the final twice, as a provider replay would. */
  duplicate_final?: boolean;
}

export class FakeAsrProvider implements AsrProvider {
  readonly name = "fake";
  #script: FakeAsrScript;
  #handlers = new Set<(event: AsrEvent) => void>();
  #chunks = new Map<string, number>();
  readonly calls: string[] = [];

  constructor(script: FakeAsrScript) {
    this.#script = script;
  }

  onEvent(handler: (event: AsrEvent) => void): () => void {
    this.#handlers.add(handler);
    return () => this.#handlers.delete(handler);
  }

  async start(utterance_id: string): Promise<void> {
    this.calls.push(`start:${utterance_id}`);
    this.#chunks.set(utterance_id, 0);
  }

  pushAudio(utterance_id: string, _pcm16: Uint8Array): void {
    this.calls.push(`audio:${utterance_id}`);
    const index = this.#chunks.get(utterance_id);
    if (index === undefined) return;
    this.#chunks.set(utterance_id, index + 1);
    const text = this.#script.partials[index];
    if (text !== undefined) this.#emit({ kind: "partial", utterance_id, text });
  }

  async stop(utterance_id: string): Promise<void> {
    this.calls.push(`stop:${utterance_id}`);
    const count = this.#chunks.get(utterance_id) ?? 0;
    this.#chunks.delete(utterance_id);
    if (count === 0) {
      this.#emit({ kind: "empty", utterance_id });
      return;
    }
    const final: AsrEvent = { kind: "final", utterance_id, text: this.#script.final };
    this.#emit(final);
    if (this.#script.duplicate_final) this.#emit(final);
  }

  async close(): Promise<void> {
    this.#handlers.clear();
  }

  // Asynchronous like a real transport, in emission order.
  #emit(event: AsrEvent): void {
    setImmediate(() => {
      for (const h of this.#handlers) h(event);
    });
  }
}
