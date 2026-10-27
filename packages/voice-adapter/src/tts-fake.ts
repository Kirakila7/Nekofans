// Deterministic in-process TtsEngine for tests: a sine tone whose length is
// proportional to the text, streamed in real-time-sized chunks after a fixed
// synthesis delay. Mirrors the sidecar tone worker (services/neko-tts/workers/tone.py).

import type { EngineEvent, TtsEngine } from "./tts.ts";

export interface FakeTtsOptions {
  ms_per_char?: number;
  min_ms?: number;
  /** Synthesis latency before the first chunk. */
  first_audio_delay_ms?: number;
  chunk_ms?: number;
  /** >1 synthesizes faster than real time. */
  speed?: number;
  sample_rate?: number;
  frequency_hz?: number;
}

/** Duration the fake engine produces for this text. */
export function fakeToneMs(text: string, o: FakeTtsOptions = {}): number {
  return Math.max(o.min_ms ?? 300, [...text].length * (o.ms_per_char ?? 60));
}

/** PCM16LE mono sine tone with short fades (no clicks). */
export function tonePcm(duration_ms: number, sample_rate = 48000, frequency_hz = 440, phase_offset = 0): Uint8Array {
  const n = Math.round((duration_ms / 1000) * sample_rate);
  const out = new Uint8Array(n * 2);
  const view = new DataView(out.buffer);
  for (let i = 0; i < n; i++) {
    const t = (i + phase_offset) / sample_rate;
    view.setInt16(i * 2, Math.round(Math.sin(2 * Math.PI * frequency_hz * t) * 0.2 * 32767), true);
  }
  return out;
}

/** Wrap PCM16LE mono in a WAV container. */
export function pcmToWav(pcm: Uint8Array, sample_rate: number): Uint8Array {
  const out = new Uint8Array(44 + pcm.byteLength);
  const v = new DataView(out.buffer);
  const str = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, "RIFF");
  v.setUint32(4, 36 + pcm.byteLength, true);
  str(8, "WAVE");
  str(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, sample_rate, true);
  v.setUint32(28, sample_rate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  str(36, "data");
  v.setUint32(40, pcm.byteLength, true);
  out.set(pcm, 44);
  return out;
}

export class FakeTtsEngine implements TtsEngine {
  readonly name = "fake-tone";
  readonly calls: { speak: string[]; interrupt: string[] } = { speak: [], interrupt: [] };
  #o: Required<FakeTtsOptions>;
  #handlers = new Set<(event: EngineEvent) => void>();
  #jobs = new Map<string, () => void>();

  constructor(options: FakeTtsOptions = {}) {
    this.#o = {
      ms_per_char: options.ms_per_char ?? 60,
      min_ms: options.min_ms ?? 300,
      first_audio_delay_ms: options.first_audio_delay_ms ?? 150,
      chunk_ms: options.chunk_ms ?? 100,
      speed: options.speed ?? 2,
      sample_rate: options.sample_rate ?? 48000,
      frequency_hz: options.frequency_hz ?? 440,
    };
  }

  onEvent(handler: (event: EngineEvent) => void): () => void {
    this.#handlers.add(handler);
    return () => this.#handlers.delete(handler);
  }

  /** Inject an engine event (e.g. a stale done marker). */
  inject(event: EngineEvent): void {
    this.#emit(event);
  }

  async speak(speech_id: string, text: string): Promise<void> {
    this.calls.speak.push(speech_id);
    const o = this.#o;
    const total = fakeToneMs(text, o);
    let sent = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const cancel = () => {
      if (timer) clearTimeout(timer);
      this.#jobs.delete(speech_id);
    };
    this.#jobs.set(speech_id, cancel);
    const step = () => {
      const ms = Math.min(o.chunk_ms, total - sent);
      const samplesBefore = Math.round((sent / 1000) * o.sample_rate);
      this.#emit({ kind: "audio", speech_id, pcm: tonePcm(ms, o.sample_rate, o.frequency_hz, samplesBefore), sample_rate: o.sample_rate });
      sent += ms;
      if (sent >= total) {
        cancel();
        this.#emit({ kind: "ended", speech_id });
        return;
      }
      timer = setTimeout(step, o.chunk_ms / o.speed);
    };
    timer = setTimeout(() => {
      this.#emit({ kind: "synth_started", speech_id });
      step();
    }, o.first_audio_delay_ms);
  }

  async interrupt(speech_id: string): Promise<void> {
    this.calls.interrupt.push(speech_id);
    this.#jobs.get(speech_id)?.();
  }

  async close(): Promise<void> {
    for (const cancel of [...this.#jobs.values()]) cancel();
  }

  #emit(event: EngineEvent): void {
    for (const h of this.#handlers) h(event);
  }
}
