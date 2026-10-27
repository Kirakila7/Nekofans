// AudioSink that simulates a real-time output device with timers (Node tests).
// Audio "plays" at 1x: started fires lead_ms after the first write, drained
// fires once the written duration has elapsed after end(). Every write is
// recorded so tests can check that no audio of a stopped stream is played.

import type { AudioSink, PlaybackId, SinkCallbacks, SinkStream } from "./tts.ts";

export interface ClockSinkRecord {
  playback_id: PlaybackId;
  opened_at: number;
  started_at: number | null;
  drained_at: number | null;
  stopped_at: number | null;
  written_ms: number;
  /** Bytes written after stop() (must stay 0). */
  writes_after_stop: number;
}

export interface ClockSinkOptions {
  lead_ms?: number;
  now?: () => number;
}

export class ClockSink implements AudioSink {
  readonly records: ClockSinkRecord[] = [];
  #leadMs: number;
  #now: () => number;

  constructor(options: ClockSinkOptions = {}) {
    this.#leadMs = options.lead_ms ?? 20;
    this.#now = options.now ?? (() => Date.now());
  }

  open(playback_id: PlaybackId, cb: SinkCallbacks): SinkStream {
    const now = this.#now;
    const leadMs = this.#leadMs;
    const rec: ClockSinkRecord = {
      playback_id,
      opened_at: now(),
      started_at: null,
      drained_at: null,
      stopped_at: null,
      written_ms: 0,
      writes_after_stop: 0,
    };
    this.records.push(rec);
    let playStart: number | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let done = false;
    let ended = false;

    const schedule = () => {
      if (timer) clearTimeout(timer);
      timer = null;
      if (done || playStart === null) return;
      if (rec.started_at === null) {
        timer = setTimeout(() => {
          timer = null;
          if (done) return;
          rec.started_at = now();
          cb.onStarted();
          schedule();
        }, Math.max(0, playStart - now()));
        return;
      }
      if (!ended) return;
      timer = setTimeout(() => {
        timer = null;
        if (done) return;
        done = true;
        rec.drained_at = now();
        cb.onDrained();
      }, Math.max(0, playStart + rec.written_ms - now()));
    };

    return {
      write(pcm, sample_rate) {
        if (done) {
          rec.writes_after_stop += pcm.byteLength;
          return;
        }
        rec.written_ms += (pcm.byteLength / 2 / sample_rate) * 1000;
        if (playStart === null) {
          playStart = now() + leadMs;
          schedule();
        }
      },
      end() {
        ended = true;
        schedule();
      },
      stop() {
        if (done) return;
        done = true;
        rec.stopped_at = now();
        if (timer) clearTimeout(timer);
        timer = null;
      },
    };
  }
}
