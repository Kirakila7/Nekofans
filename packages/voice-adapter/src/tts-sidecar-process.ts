// Spawn and stop services/neko-tts/server.py (Node only).

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { DEFAULT_TTS_SIDECAR_PORT } from "./tts-sidecar.ts";

const REPO_ROOT = join(import.meta.dirname, "../../..");
export const TTS_SIDECAR_SCRIPT = join(REPO_ROOT, "services/neko-tts/server.py");

// Shares the uv-managed venv of services/neko-memory; layout differs per
// platform and packaged builds ship their own interpreter, so resolve it at
// runtime instead of hardcoding a developer path.
export function ttsSidecarPython(): string {
  const override = process.env.NEKO_TTS_SIDECAR_PYTHON?.trim();
  if (override) return override;
  const venv = join(REPO_ROOT, "services/neko-memory/.venv");
  return join(venv, process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
}

export interface TtsSidecarOptions {
  port?: number;
  /** tone (default) | dummy | free | step */
  provider?: string;
  env?: Record<string, string>;
  python?: string;
  ready_timeout_ms?: number;
}

export interface TtsSidecarProcess {
  port: number;
  ws_url: string;
  http_url: string;
  output(): string;
  stop(): Promise<number | null>;
}

/** Spawn the sidecar and wait for /health. */
export async function startTtsSidecar(options: TtsSidecarOptions = {}): Promise<TtsSidecarProcess> {
  const port = options.port ?? DEFAULT_TTS_SIDECAR_PORT;
  const http_url = `http://127.0.0.1:${port}`;
  let output = "";
  const python = options.python ?? ttsSidecarPython();
  if (isAbsolute(python) && !existsSync(python)) {
    throw new Error(
      `Python for the neko-tts sidecar was not found at ${python}.\n` +
        `Run "npm run setup:neko-memory" once, or set NEKO_TTS_SIDECAR_PYTHON to an existing interpreter.`,
    );
  }
  const proc: ChildProcess = spawn(python, [TTS_SIDECAR_SCRIPT], {
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      PYTHONIOENCODING: "utf-8",
      PYTHONDONTWRITEBYTECODE: "1",
      NEKO_TTS_PORT: String(port),
      NEKO_TTS_PROVIDER: options.provider ?? "tone",
      ...options.env,
    },
  });
  proc.stdout!.on("data", (d) => (output += d.toString()));
  proc.stderr!.on("data", (d) => (output += d.toString()));
  const exited = new Promise<number | null>((resolve) => proc.on("exit", (code) => resolve(code)));

  const handle: TtsSidecarProcess = {
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
      const code = await Promise.race([exited, sleep(8_000).then(() => undefined)]);
      if (code !== undefined) return code;
      proc.kill();
      return exited;
    },
  };

  const deadline = Date.now() + (options.ready_timeout_ms ?? 30_000);
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) throw new Error(`neko-tts exited early (${proc.exitCode}):\n${output}`);
    try {
      const res = await fetch(`${http_url}/health`, { signal: AbortSignal.timeout(1_000) });
      if (res.ok) return handle;
    } catch {
      // Not up yet.
    }
    await sleep(200);
  }
  await handle.stop();
  throw new Error(`neko-tts did not become healthy on ${port}:\n${output}`);
}
