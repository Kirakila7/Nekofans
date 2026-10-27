// F10 ASR provider backed by the local Python sidecar (services/neko-asr).
// The sidecar runs upstream N.E.K.O ASR workers; see services/neko-asr/server.py
// for the WebSocket protocol.

import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import type { AsrEvent, AsrProvider } from "./asr.ts";

export const DEFAULT_ASR_SIDECAR_PORT = 59067;
export const DEFAULT_ASR_SIDECAR_URL = `ws://127.0.0.1:${DEFAULT_ASR_SIDECAR_PORT}/ws`;

export interface SidecarAsrProviderOptions {
  url?: string;
  language?: string;
  connect_timeout_ms?: number;
}

export class SidecarAsrProvider implements AsrProvider {
  readonly name = "sidecar";
  #url: string;
  #connectTimeoutMs: number;
  #ws: WebSocket | null = null;
  #connecting: Promise<WebSocket> | null = null;
  #closing = false;
  #handlers = new Set<(event: AsrEvent) => void>();
  /** Worker provider reported by the sidecar ("faster_whisper", "scripted", ...). */
  worker: string | null = null;

  constructor(options: SidecarAsrProviderOptions = {}) {
    const url = options.url ?? DEFAULT_ASR_SIDECAR_URL;
    this.#url = `${url}${url.includes("?") ? "&" : "?"}language=${encodeURIComponent(options.language ?? "zh")}`;
    this.#connectTimeoutMs = options.connect_timeout_ms ?? 5_000;
  }

  onEvent(handler: (event: AsrEvent) => void): () => void {
    this.#handlers.add(handler);
    return () => this.#handlers.delete(handler);
  }

  async start(utterance_id: string): Promise<void> {
    const ws = await this.#connect();
    ws.send(JSON.stringify({ kind: "start", utterance_id }));
  }

  pushAudio(utterance_id: string, pcm16: Uint8Array): void {
    if (this.#ws?.readyState !== WebSocket.OPEN) return;
    const data = Buffer.from(pcm16.buffer, pcm16.byteOffset, pcm16.byteLength).toString("base64");
    this.#ws.send(JSON.stringify({ kind: "audio", utterance_id, data }));
  }

  async stop(utterance_id: string): Promise<void> {
    // Never reconnect here: a new connection does not know this utterance.
    if (this.#ws?.readyState !== WebSocket.OPEN) throw new Error("ASR sidecar connection lost");
    this.#ws.send(JSON.stringify({ kind: "stop", utterance_id }));
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

  #emit(event: AsrEvent): void {
    for (const h of this.#handlers) h(event);
  }

  async #connect(): Promise<WebSocket> {
    if (this.#ws?.readyState === WebSocket.OPEN) return this.#ws;
    this.#closing = false;
    this.#connecting ??= new Promise<WebSocket>((resolve, reject) => {
      const ws = new WebSocket(this.#url);
      let ready = false;
      const timer = setTimeout(() => {
        reject(new Error(`ASR sidecar did not become ready within ${this.#connectTimeoutMs}ms`));
        ws.close();
      }, this.#connectTimeoutMs);

      ws.addEventListener("message", (ev) => {
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(String(ev.data)) as Record<string, unknown>;
        } catch {
          return;
        }
        if (!ready) {
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
          return;
        }
        const event = toEvent(msg);
        if (event) this.#emit(event);
      });
      ws.addEventListener("error", () => {
        if (!ready) {
          clearTimeout(timer);
          reject(new Error(`ASR sidecar connection to ${this.#url} failed`));
        }
      });
      ws.addEventListener("close", () => {
        clearTimeout(timer);
        if (!ready) {
          reject(new Error("ASR sidecar closed the connection before ready"));
          return;
        }
        if (this.#ws === ws) this.#ws = null;
        if (!this.#closing) {
          this.#emit({
            kind: "error",
            utterance_id: null,
            error_code: "ASR_SIDECAR_DISCONNECTED",
            error_message: "ASR sidecar connection closed",
          });
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

function toEvent(msg: Record<string, unknown>): AsrEvent | null {
  const id = typeof msg.utterance_id === "string" ? msg.utterance_id : null;
  const text = typeof msg.text === "string" ? msg.text : "";
  switch (msg.kind) {
    case "partial":
      return id ? { kind: "partial", utterance_id: id, text } : null;
    case "final":
      return id ? { kind: "final", utterance_id: id, text } : null;
    case "empty":
      return id ? { kind: "empty", utterance_id: id } : null;
    case "error":
      return {
        kind: "error",
        utterance_id: id,
        error_code: String(msg.error_code ?? "ASR_ERROR"),
        error_message: String(msg.error_message ?? ""),
      };
    default:
      return null;
  }
}

// ---- Sidecar process management ----

const REPO_ROOT = join(import.meta.dirname, "../../..");
export const ASR_SIDECAR_SCRIPT = join(REPO_ROOT, "services/neko-asr/server.py");
export const ASR_SIDECAR_PYTHON = join(REPO_ROOT, "services/neko-memory/.venv/Scripts/python.exe");

export interface AsrSidecarOptions {
  port?: number;
  /** faster_whisper (default) | dummy | scripted */
  provider?: string;
  env?: Record<string, string>;
  python?: string;
  ready_timeout_ms?: number;
}

export interface AsrSidecarProcess {
  port: number;
  ws_url: string;
  http_url: string;
  output(): string;
  stop(): Promise<number | null>;
}

/** Spawn services/neko-asr/server.py and wait for /health. */
export async function startAsrSidecar(options: AsrSidecarOptions = {}): Promise<AsrSidecarProcess> {
  const port = options.port ?? DEFAULT_ASR_SIDECAR_PORT;
  const http_url = `http://127.0.0.1:${port}`;
  let output = "";
  const proc: ChildProcess = spawn(options.python ?? ASR_SIDECAR_PYTHON, [ASR_SIDECAR_SCRIPT], {
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      PYTHONIOENCODING: "utf-8",
      NEKO_ASR_PORT: String(port),
      NEKO_ASR_PROVIDER: options.provider ?? "faster_whisper",
      ...options.env,
    },
  });
  proc.stdout!.on("data", (d) => (output += d.toString()));
  proc.stderr!.on("data", (d) => (output += d.toString()));
  const exited = new Promise<number | null>((resolve) => proc.on("exit", (code) => resolve(code)));

  const handle: AsrSidecarProcess = {
    port,
    http_url,
    ws_url: `ws://127.0.0.1:${port}/ws`,
    output: () => output,
    async stop() {
      if (proc.exitCode !== null) return proc.exitCode;
      try {
        await fetch(`${http_url}/shutdown`, { method: "POST", signal: AbortSignal.timeout(2_000) });
      } catch {
        // Fall through to kill.
      }
      const code = await Promise.race([exited, sleep(5_000).then(() => undefined)]);
      if (code !== undefined) return code;
      proc.kill();
      return exited;
    },
  };

  const deadline = Date.now() + (options.ready_timeout_ms ?? 30_000);
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) throw new Error(`neko-asr exited early (${proc.exitCode}):\n${output}`);
    try {
      const res = await fetch(`${http_url}/health`, { signal: AbortSignal.timeout(1_000) });
      if (res.ok) return handle;
    } catch {
      // Not up yet.
    }
    await sleep(200);
  }
  await handle.stop();
  throw new Error(`neko-asr did not become healthy on ${port}:\n${output}`);
}
