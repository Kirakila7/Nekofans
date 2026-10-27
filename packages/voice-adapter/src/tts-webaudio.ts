// AudioSink that plays PCM16 through Web Audio (browser / Electron renderer).
// Chunks are scheduled back to back; "started" fires when the first chunk's
// start time is reached on the audio clock, "drained" when the last scheduled
// source ends after end().

import type { AudioSink, PlaybackId, SinkCallbacks, SinkStream } from "./tts.ts";

export interface WebAudioSinkOptions {
  /** Lead time before the first chunk plays, absorbs network jitter. */
  lead_ms?: number;
  /** Output node (e.g. a gain or analyser chain). Default: ctx.destination. */
  destination?: AudioNode;
}

export class WebAudioSink implements AudioSink {
  readonly ctx: AudioContext;
  #leadS: number;
  #out: AudioNode;

  constructor(ctx: AudioContext, options: WebAudioSinkOptions = {}) {
    this.ctx = ctx;
    this.#leadS = (options.lead_ms ?? 60) / 1000;
    this.#out = options.destination ?? ctx.destination;
  }

  open(_playback_id: PlaybackId, cb: SinkCallbacks): SinkStream {
    const ctx = this.ctx;
    const leadS = this.#leadS;
    const out = this.#out;
    if (ctx.state === "suspended") void ctx.resume();
    const sources = new Set<AudioBufferSourceNode>();
    let nextAt = 0;
    let ended = false;
    let stopped = false;
    let startedTimer: ReturnType<typeof setTimeout> | null = null;
    let started = false;

    const maybeDrained = () => {
      if (!stopped && ended && sources.size === 0) {
        stopped = true;
        cb.onDrained();
      }
    };

    return {
      write(pcm, sample_rate) {
        if (stopped || pcm.byteLength < 2) return;
        const n = pcm.byteLength >> 1;
        const view = new DataView(pcm.buffer, pcm.byteOffset, n * 2);
        const buf = ctx.createBuffer(1, n, sample_rate);
        const ch = buf.getChannelData(0);
        for (let i = 0; i < n; i++) ch[i] = view.getInt16(i * 2, true) / 32768;
        const src = ctx.createBufferSource();
        src.buffer = buf;
        src.connect(out);
        // First chunk gets the lead time; later chunks queue back to back, or
        // restart with a short lead after an underrun.
        const startAt = nextAt === 0 ? ctx.currentTime + leadS : Math.max(nextAt, ctx.currentTime + 0.005);
        src.start(startAt);
        nextAt = startAt + buf.duration;
        sources.add(src);
        src.onended = () => {
          sources.delete(src);
          maybeDrained();
        };
        if (!started && !startedTimer) {
          const delayMs = Math.max(0, (startAt - ctx.currentTime) * 1000);
          startedTimer = setTimeout(() => {
            startedTimer = null;
            if (stopped) return;
            started = true;
            cb.onStarted();
          }, delayMs);
        }
      },
      end() {
        ended = true;
        maybeDrained();
      },
      stop() {
        if (stopped) return;
        stopped = true;
        if (startedTimer) clearTimeout(startedTimer);
        for (const s of sources) {
          s.onended = null;
          try {
            s.stop();
          } catch {
            // Already stopped.
          }
        }
        sources.clear();
      },
    };
  }
}
