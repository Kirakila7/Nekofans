import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DshClient } from "./session.ts";

export interface DshHostOptions {
  runtimeDir: string;
  primaryRuntimeDir: string;
  dataDir: string;
  executable?: string;
  startupTimeoutMs?: number;
  shutdownTimeoutMs?: number;
  onExit?: () => void;
}

/** One app-owned Host, with a private profile and no inherited user DSH home. */
export class DshHost {
  private child: ChildProcess | null = null;
  private opening: Promise<{ url: string; client: DshClient }> | null = null;
  private stopping: Promise<void> | null = null;
  private exited: Promise<void> = Promise.resolve();
  private closed = false;
  private readonly options: DshHostOptions;

  constructor(options: DshHostOptions) { this.options = options; }
  pid(): number | undefined { return this.child?.pid; }

  start(): Promise<{ url: string; client: DshClient }> {
    if (this.closed) return Promise.reject(new Error("DSH is closing."));
    return this.opening ??= this.startNow().catch((error) => { this.opening = null; throw error; });
  }

  private async startNow(): Promise<{ url: string; client: DshClient }> {
    const o = this.options;
    const entry = join(o.runtimeDir, "node_modules/@deepseek-ai/dsh-desktop-host/lib/index.js");
    if (!existsSync(entry) || !existsSync(o.primaryRuntimeDir)) throw new Error("DSH runtime is unavailable.");
    const home = resolve(o.dataDir, "dsh");
    const profile = join(home, "profiles/desktop");
    const documents = join(o.dataDir, "workspaces");
    for (const dir of [profile, documents, join(home, "agents")]) mkdirSync(dir, { recursive: true });
    const seed = (name: string, value: string) => {
      const file = join(profile, name);
      if (!existsSync(file)) writeFileSync(file, value, { flag: "wx" });
    };
    seed("package.json", JSON.stringify({ name: "bigfish-dsh-profile", private: true, dependencies: {}, dsh: { profile: { bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"] } } }));
    seed("cordis.yml", "[]\n");
    seed("cordis.patch.yml", [
      "- id: desktop-product-telemetry", "  disabled: true",
      "- id: product-analytics", "  disabled: true",
      "- id: workspace-controller", "  config:", `    documentsDirectory: ${JSON.stringify(documents)}`,
    ].join("\n") + "\n");
    const child = spawn(o.executable ?? process.execPath, ["--expose-internals", entry, o.runtimeDir, profile, o.primaryRuntimeDir], {
      cwd: documents,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", DSH_HOME: home, DSH_AGENTS_HOME: join(home, "agents"), DSH_CLIENT_VERSION: "0.2.1-rc.3" },
      // Upstream diagnostics may contain credentials or conversation content. Never forward/persist them.
      stdio: ["ignore", "ignore", "ignore", "ipc"], windowsHide: true,
    });
    this.child = child;
    this.exited = new Promise<void>((yes) => {
      child.once("close", () => {
        if (this.child === child) { this.child = null; this.opening = null; }
        o.onExit?.();
        yes();
      });
    });
    const ready = new Promise<string>((yes, no) => {
      child.once("error", () => no(new Error("DSH process could not start.")));
      child.once("close", () => no(new Error("DSH process stopped before ready.")));
      child.on("message", (raw) => {
        const message = raw as { type?: unknown; url?: unknown };
        if (message?.type === "fatal") no(new Error("DSH startup failed."));
        if (message?.type !== "ready" || typeof message.url !== "string") return;
        try {
          const url = new URL(message.url);
          if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.searchParams.get("token")) throw new Error();
          yes(url.href);
        } catch { no(new Error("DSH returned an invalid local address.")); }
      });
    });
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const url = await Promise.race([ready, new Promise<never>((_yes, no) => {
        timeout = setTimeout(() => no(new Error("DSH startup timed out.")), o.startupTimeoutMs ?? 40_000);
      })]);
      const client = await DshClient.connect({ launch_url: url });
      if (this.closed || this.child !== child) throw new Error("DSH is closing.");
      return { url, client };
    } catch {
      await this.stopChild(child);
      throw new Error("DSH could not start. Check the local runtime.");
    } finally { clearTimeout(timeout); }
  }

  stop(): Promise<void> {
    this.closed = true;
    return this.stopping ??= (async () => {
      const child = this.child;
      if (child) await this.stopChild(child);
      await this.opening?.catch(() => {});
    })();
  }

  private async stopChild(child: ChildProcess): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const timer = setTimeout(() => child.kill(), this.options.shutdownTimeoutMs ?? 4000);
    try {
      if (child.connected) child.send({ type: "shutdown" }, () => {});
      else child.kill();
      await this.exited;
    } finally { clearTimeout(timer); }
  }
}
