// F11 speech output: speak(text, character_id) -> PlaybackHandle.
//
// A TtsPlayer joins a TtsEngine (synthesis, e.g. the services/neko-tts sidecar)
// with an AudioSink (actual playback). Lifecycle per playback:
//   queued -> started (first audio is audible) -> ended | interrupted
// "started" comes from the sink, not from synthesis, so the avatar only shows
// speaking while audio really plays. One channel: a new speak() interrupts the
// previous playback. Events of finished playbacks are dropped, so a late done
// marker from an interrupted speech can never end a newer one.
// Refs: N.E.K.O docs/architecture/tts-pipeline.md (speech_id, interrupt lifecycle).
//
// This module and its engines/sinks (except tts-sidecar-process.ts) are
// browser-safe: no node: imports.

import { SidecarTtsEngine } from "./tts-sidecar.ts";
import { WebAudioSink } from "./tts-webaudio.ts";

export type PlaybackId = string;

export interface PlaybackHandle {
  playback_id: PlaybackId;
  /** Stop audio now. No-op once the playback has ended or was interrupted. */
  stop(): void;
  /** Resolves with the final event of this playback. */
  done: Promise<PlaybackFinalEvent>;
}

export type PlaybackEvent =
  | { type: "queued"; playback_id: PlaybackId; character_id: string; text_chars: number; at: number }
  | { type: "started"; playback_id: PlaybackId; at: number }
  | PlaybackFinalEvent;

export type PlaybackFinalEvent =
  | { type: "ended"; playback_id: PlaybackId; reason: "completed" | "no_audio" | "error"; error?: string; audio_ms: number; at: number }
  | { type: "interrupted"; playback_id: PlaybackId; reason: "stopped" | "preempted" | "engine"; audio_ms: number; at: number };

export type PlaybackEventHandler = (event: PlaybackEvent) => void;

/** Synthesis events. speech_id equals the playback_id. */
export type EngineEvent =
  | { kind: "synth_started"; speech_id: string }
  | { kind: "audio"; speech_id: string; pcm: Uint8Array; sample_rate: number }
  | { kind: "ended"; speech_id: string }
  | { kind: "interrupted"; speech_id: string }
  | { kind: "error"; speech_id: string | null; error_code: string; error_message: string };

export interface TtsEngine {
  readonly name: string;
  onEvent(handler: (event: EngineEvent) => void): () => void;
  /** Synthesize the whole text for speech_id (text + flush). */
  speak(speech_id: string, text: string, character_id: string): Promise<void>;
  /** Stop synthesis of speech_id; later audio for it must not be delivered as current. */
  interrupt(speech_id: string): Promise<void>;
  close(): Promise<void>;
}

export interface SinkCallbacks {
  /** First sample of this stream became audible. */
  onStarted(): void;
  /** end() was called and every written sample has played. */
  onDrained(): void;
}

export interface SinkStream {
  /** PCM16LE mono. */
  write(pcm: Uint8Array, sample_rate: number): void;
  end(): void;
  /** Silence immediately; no callbacks fire afterwards. */
  stop(): void;
}

export interface AudioSink {
  open(playback_id: PlaybackId, callbacks: SinkCallbacks): SinkStream;
}

export interface TtsPlayerOptions {
  /** Prefix of generated playback ids. */
  id_prefix?: string;
  now?: () => number;
}

interface Playback {
  id: PlaybackId;
  stream: SinkStream | null;
  audio_bytes: number;
  sample_rate: number;
  started: boolean;
  final: PlaybackFinalEvent | null;
  resolve: (event: PlaybackFinalEvent) => void;
}

let globalSeq = 0;

export class TtsPlayer {
  readonly engine: TtsEngine;
  readonly sink: AudioSink;
  #listeners = new Set<PlaybackEventHandler>();
  #current: Playback | null = null;
  #prefix: string;
  #now: () => number;
  #offEngine: () => void;
  /** Engine items for finished or unknown speech ids (late audio, stale done markers). */
  readonly dropped = { audio_bytes: 0, events: 0 };

  constructor(engine: TtsEngine, sink: AudioSink, options: TtsPlayerOptions = {}) {
    this.engine = engine;
    this.sink = sink;
    this.#prefix = options.id_prefix ?? "pb";
    this.#now = options.now ?? (() => Date.now());
    this.#offEngine = engine.onEvent((e) => this.#onEngine(e));
  }

  onPlaybackEvent(handler: PlaybackEventHandler): () => void {
    this.#listeners.add(handler);
    return () => this.#listeners.delete(handler);
  }

  get current(): PlaybackId | null {
    return this.#current && !this.#current.final ? this.#current.id : null;
  }

  speak(text: string, character_id: string): PlaybackHandle {
    if (!text.trim()) throw new Error("speak: empty text");
    const prev = this.#current;
    if (prev && !prev.final) this.#interrupt(prev, "preempted");
    let resolve!: (e: PlaybackFinalEvent) => void;
    const done = new Promise<PlaybackFinalEvent>((r) => (resolve = r));
    const pb: Playback = {
      id: `${this.#prefix}-${++globalSeq}-${Math.random().toString(36).slice(2, 8)}`,
      stream: null,
      audio_bytes: 0,
      sample_rate: 48000,
      started: false,
      final: null,
      resolve,
    };
    this.#current = pb;
    this.#emit({ type: "queued", playback_id: pb.id, character_id, text_chars: text.length, at: this.#now() });
    this.engine.speak(pb.id, text, character_id).catch((err: unknown) => {
      this.#fail(pb, err instanceof Error ? err.message : String(err));
    });
    return {
      playback_id: pb.id,
      stop: () => {
        if (!pb.final) this.#interrupt(pb, "stopped");
      },
      done,
    };
  }

  /** Stop the current playback, if any. */
  stopAll(): void {
    const pb = this.#current;
    if (pb && !pb.final) this.#interrupt(pb, "stopped");
  }

  async close(): Promise<void> {
    this.stopAll();
    this.#offEngine();
    await this.engine.close();
  }

  #active(speech_id: string | null): Playback | null {
    const pb = this.#current;
    return pb && !pb.final && pb.id === speech_id ? pb : null;
  }

  #onEngine(e: EngineEvent): void {
    const pb = this.#active(e.speech_id);
    if (!pb) {
      if (e.kind === "audio") this.dropped.audio_bytes += e.pcm.byteLength;
      else if (e.kind !== "error" || e.speech_id !== null) this.dropped.events++;
      if (e.kind === "error" && e.speech_id === null && this.#current && !this.#current.final) {
        this.#fail(this.#current, `${e.error_code}: ${e.error_message}`);
      }
      return;
    }
    switch (e.kind) {
      case "synth_started":
        return;
      case "audio": {
        pb.sample_rate = e.sample_rate;
        pb.audio_bytes += e.pcm.byteLength;
        pb.stream ??= this.sink.open(pb.id, {
          onStarted: () => {
            if (pb.final || pb.started) return;
            pb.started = true;
            this.#emit({ type: "started", playback_id: pb.id, at: this.#now() });
          },
          onDrained: () => this.#finish(pb, { type: "ended", playback_id: pb.id, reason: "completed", audio_ms: audioMs(pb), at: this.#now() }),
        });
        pb.stream.write(e.pcm, e.sample_rate);
        return;
      }
      case "ended":
        if (pb.stream) pb.stream.end();
        else this.#finish(pb, { type: "ended", playback_id: pb.id, reason: "no_audio", audio_ms: 0, at: this.#now() });
        return;
      case "interrupted":
        pb.stream?.stop();
        this.#finish(pb, { type: "interrupted", playback_id: pb.id, reason: "engine", audio_ms: audioMs(pb), at: this.#now() });
        return;
      case "error":
        this.#fail(pb, `${e.error_code}: ${e.error_message}`);
        return;
    }
  }

  #interrupt(pb: Playback, reason: "stopped" | "preempted"): void {
    pb.stream?.stop();
    this.#finish(pb, { type: "interrupted", playback_id: pb.id, reason, audio_ms: audioMs(pb), at: this.#now() });
    this.engine.interrupt(pb.id).catch(() => {
      // Engine gone: audio is already stopped locally and late items are dropped.
    });
  }

  #fail(pb: Playback, error: string): void {
    if (pb.final) return;
    pb.stream?.stop();
    this.#finish(pb, { type: "ended", playback_id: pb.id, reason: "error", error, audio_ms: audioMs(pb), at: this.#now() });
    this.engine.interrupt(pb.id).catch(() => {});
  }

  #finish(pb: Playback, event: PlaybackFinalEvent): void {
    if (pb.final) return;
    pb.final = event;
    this.#emit(event);
    pb.resolve(event);
  }

  #emit(event: PlaybackEvent): void {
    for (const h of this.#listeners) {
      try {
        h(event);
      } catch (err) {
        console.error("[voice-adapter] playback listener failed", err);
      }
    }
  }
}

function audioMs(pb: Playback): number {
  return Math.round((pb.audio_bytes / 2 / pb.sample_rate) * 1000);
}

// ---- Module-level default (VoiceService) ----

let defaultPlayer: TtsPlayer | null = null;

/** Replace the default player used by speak(). */
export function configureTts(engine: TtsEngine, sink: AudioSink, options?: TtsPlayerOptions): TtsPlayer {
  defaultPlayer = new TtsPlayer(engine, sink, options);
  return defaultPlayer;
}

/** Default: neko-tts sidecar (port 59077) played through Web Audio. */
export function defaultTtsPlayer(): TtsPlayer {
  if (!defaultPlayer) {
    const Ctx = (globalThis as { AudioContext?: new () => AudioContext }).AudioContext;
    if (!Ctx) throw new Error("speak: no audio output here; call configureTts(engine, sink) first");
    defaultPlayer = new TtsPlayer(new SidecarTtsEngine(), new WebAudioSink(new Ctx()));
  }
  return defaultPlayer;
}

export function speak(text: string, character_id: string): PlaybackHandle {
  return defaultTtsPlayer().speak(text, character_id);
}

export function onPlaybackEvent(handler: PlaybackEventHandler): () => void {
  return defaultTtsPlayer().onPlaybackEvent(handler);
}
