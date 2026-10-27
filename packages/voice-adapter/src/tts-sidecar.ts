// F11 TtsEngine backed by the services/neko-tts sidecar (WebSocket, see
// services/neko-tts/server.py for the protocol). Browser-safe; process
// management lives in tts-sidecar-process.ts.

import type { EngineEvent, TtsEngine } from "./tts.ts";

export const DEFAULT_TTS_SIDECAR_PORT = 59077;
export const DEFAULT_TTS_SIDECAR_URL = `ws://127.0.0.1:${DEFAULT_TTS_SIDECAR_PORT}/ws`;

export interface SidecarTtsEngineOptions {
  url?: string;
  /** Worker on the sidecar: tone | dummy | free | step. Default: the sidecar's NEKO_TTS_PROVIDER. */
  provider?: string;
  voice_id?: string;
  /** Extra worker options sent as query parameters (tone: ms_per_char, min_ms, first_audio_delay_ms, chunk_ms, speed). */
  options?: Record<string, string | number>;
  connect_timeout_ms?: number;
}

export class SidecarTtsEngine implements TtsEngine {
  readonly name = "neko-tts";
  #url: string;
  #connectTimeoutMs: number;
  #ws: WebSocket | null = null;
  #connecting: Promise<WebSocket> | null = null;
  #closing = false;
  #handlers = new Set<(event: EngineEvent) => void>();
  #header: { speech_id: string; bytes: number; sample_rate: number } | null = null;
  /** Worker reported by the sidecar. */
  worker: string | null = null;

  constructor(options: SidecarTtsEngineOptions = {}) {
    const base = options.url ?? DEFAULT_TTS_SIDECAR_URL;
    const params = new URLSearchParams();
    if (options.provider) params.set("provider", options.provider);
    if (options.voice_id) params.set("voice", options.voice_id);
    for (const [k, v] of Object.entries(options.options ?? {})) params.set(k, String(v));
    const qs = params.toString();
    this.#url = qs ? `${base}${base.includes("?") ? "&" : "?"}${qs}` : base;
    this.#connectTimeoutMs = options.connect_timeout_ms ?? 10_000;
  }

  onEvent(handler: (event: EngineEvent) => void): () => void {
    this.#handlers.add(handler);
    return () => this.#handlers.delete(handler);
  }

  /** Open the connection and wait for the worker to be ready. */
  async connect(): Promise<void> {
    await this.#connect();
  }

  async speak(speech_id: string, text: string, _character_id: string): Promise<void> {
    const ws = await this.#connect();
    ws.send(JSON.stringify({ kind: "speak", speech_id, text }));
    ws.send(JSON.stringify({ kind: "flush", speech_id }));
  }

  async interrupt(speech_id: string): Promise<void> {
    if (this.#ws?.readyState !== WebSocket.OPEN) return;
    this.#ws.send(JSON.stringify({ kind: "interrupt", speech_id }));
  }

  /** Sidecar counters (dropped late audio, stale done markers, interrupts). */
  async stats(timeout_ms = 2_000): Promise<Record<string, number>> {
    const ws = await this.#connect();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("stats timeout")), timeout_ms);
      const onMsg = (ev: MessageEvent) => {
        if (typeof ev.data !== "string") return;
        const msg = JSON.parse(ev.data) as Record<string, unknown>;
        if (msg.kind !== "stats") return;
        clearTimeout(timer);
        ws.removeEventListener("message", onMsg);
        const { kind: _k, ...rest } = msg;
        resolve(rest as Record<string, number>);
      };
      ws.addEventListener("message", onMsg);
      ws.send(JSON.stringify({ kind: "stats" }));
    });
  }

  async close(): Promise<void> {
    this.#closing = true;
    const ws = this.#ws;
    this.#ws = null;
    if (!ws || ws.readyState === WebSocket.CLOSED) return;
    await new Promise<void>((resolve) => {
      ws.addEventListener("close", () => resolve(), { once: true });
      ws.close();
    });
  }

  #emit(event: EngineEvent): void {
    for (const h of this.#handlers) h(event);
  }

  #onMessage(data: unknown): void {
    if (typeof data !== "string") {
      const header = this.#header;
      this.#header = null;
      if (!header || !(data instanceof ArrayBuffer)) return;
      this.#emit({ kind: "audio", speech_id: header.speech_id, pcm: new Uint8Array(data), sample_rate: header.sample_rate });
      return;
    }
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(data) as Record<string, unknown>;
    } catch {
      return;
    }
    const sid = typeof msg.speech_id === "string" ? msg.speech_id : null;
    switch (msg.kind) {
      case "audio_chunk":
        if (sid) this.#header = { speech_id: sid, bytes: Number(msg.bytes), sample_rate: Number(msg.sample_rate) || 48000 };
        return;
      case "started":
        if (sid) this.#emit({ kind: "synth_started", speech_id: sid });
        return;
      case "ended":
        if (sid) this.#emit({ kind: "ended", speech_id: sid });
        return;
      case "interrupted":
        if (sid) this.#emit({ kind: "interrupted", speech_id: sid });
        return;
      case "error":
        this.#emit({
          kind: "error",
          speech_id: sid,
          error_code: String(msg.error_code ?? "TTS_ERROR"),
          error_message: String(msg.error_message ?? ""),
        });
        return;
    }
  }

  async #connect(): Promise<WebSocket> {
    if (this.#ws?.readyState === WebSocket.OPEN) return this.#ws;
    this.#closing = false;
    this.#connecting ??= new Promise<WebSocket>((resolve, reject) => {
      const ws = new WebSocket(this.#url);
      ws.binaryType = "arraybuffer";
      let ready = false;
      const timer = setTimeout(() => {
        reject(new Error(`TTS sidecar did not become ready within ${this.#connectTimeoutMs}ms`));
        ws.close();
      }, this.#connectTimeoutMs);
      ws.addEventListener("message", (ev) => {
        if (ready) {
          this.#onMessage(ev.data);
          return;
        }
        if (typeof ev.data !== "string") return;
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(ev.data) as Record<string, unknown>;
        } catch {
          return;
        }
        if (msg.kind === "ready") {
          ready = true;
          clearTimeout(timer);
          this.worker = typeof msg.provider === "string" ? msg.provider : null;
          this.#ws = ws;
          resolve(ws);
        } else if (msg.kind === "error") {
          clearTimeout(timer);
          reject(new Error(`${msg.error_code}: ${msg.error_message}`));
        }
      });
      ws.addEventListener("error", () => {
        if (!ready) {
          clearTimeout(timer);
          reject(new Error(`TTS sidecar connection to ${this.#url} failed`));
        }
      });
      ws.addEventListener("close", () => {
        clearTimeout(timer);
        if (!ready) {
          reject(new Error("TTS sidecar closed the connection before ready"));
          return;
        }
        if (this.#ws === ws) this.#ws = null;
        if (!this.#closing) {
          this.#emit({ kind: "error", speech_id: null, error_code: "TTS_SIDECAR_DISCONNECTED", error_message: "TTS sidecar connection closed" });
        }
      });
    });
    try {
      return await this.#connecting;
    } finally {
      this.#connecting = null;
    }
  }
}
