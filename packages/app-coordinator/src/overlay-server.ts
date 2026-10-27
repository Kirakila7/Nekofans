// F09: loopback static server for the pet-overlay renderer.
// Serves apps/pet-overlay/ at "/" and the active appearance pack at "/assets/".
// .ts files are served as JavaScript after type stripping (node:module stripTypeScriptTypes),
// so the renderer needs no build step. GET/HEAD only, bound to 127.0.0.1, no directory listing.
// The page holds no secrets; the only privileged surface is the preload bridge.

import { createServer, type Server } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { stripTypeScriptTypes } from "node:module";
import type { AddressInfo } from "node:net";

/** apps/pet-overlay inside this repository. */
export const PET_OVERLAY_APP_DIR = fileURLToPath(new URL("../../../apps/pet-overlay/", import.meta.url));

const TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".ts": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".webm": "video/webm",
  ".mp4": "video/mp4",
};

export interface OverlayServerOptions {
  /** Defaults to PET_OVERLAY_APP_DIR. */
  app_dir?: string;
  /** Appearance pack root served under /assets/; omitted means /assets/ is 404. */
  assets_dir?: string;
  /** 0 picks a free port. */
  port?: number;
}

export interface OverlayServer {
  origin: string;
  /** URL of index.html. */
  url: string;
  port: number;
  close(): Promise<void>;
}

/** Resolves a URL path inside root, or null when it escapes root. */
export function resolveInside(root: string, urlPath: string): string | null {
  const base = resolve(root);
  const file = resolve(base, "." + (urlPath.endsWith("/") ? `${urlPath}index.html` : urlPath));
  return file === base || file.startsWith(base + sep) ? file : null;
}

export async function startOverlayServer(opts: OverlayServerOptions = {}): Promise<OverlayServer> {
  const appDir = opts.app_dir ?? PET_OVERLAY_APP_DIR;
  const assetsDir = opts.assets_dir;
  const stripped = new Map<string, { mtime: number; code: string }>();

  async function load(file: string): Promise<Buffer | string | null> {
    let info;
    try {
      info = await stat(file);
    } catch {
      return null;
    }
    if (!info.isFile()) return null;
    if (extname(file) !== ".ts") return readFile(file);
    const hit = stripped.get(file);
    if (hit && hit.mtime === info.mtimeMs) return hit.code;
    const code = stripTypeScriptTypes(await readFile(file, "utf8"), { mode: "strip" });
    stripped.set(file, { mtime: info.mtimeMs, code });
    return code;
  }

  const server: Server = createServer((req, res) => {
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405).end();
      return;
    }
    let path: string;
    try {
      path = decodeURIComponent(new URL(req.url ?? "/", "http://127.0.0.1").pathname);
    } catch {
      res.writeHead(400).end();
      return;
    }
    let file: string | null;
    if (path.startsWith("/assets/")) {
      file = assetsDir ? resolveInside(assetsDir, path.slice("/assets".length)) : null;
    } else {
      file = resolveInside(appDir, path);
    }
    if (file === null) {
      res.writeHead(404).end();
      return;
    }
    load(file).then(
      (body) => {
        if (body === null) {
          res.writeHead(404).end();
          return;
        }
        res.writeHead(200, {
          "content-type": TYPES[extname(file).toLowerCase()] ?? "application/octet-stream",
          "content-length": Buffer.byteLength(body),
          "cache-control": "no-cache",
          "x-content-type-options": "nosniff",
        });
        res.end(req.method === "HEAD" ? undefined : body);
      },
      (error: unknown) => {
        console.warn("[app-coordinator] overlay server failed:", path, error instanceof Error ? error.message : error);
        if (!res.headersSent) res.writeHead(500);
        res.end();
      },
    );
  });

  await new Promise<void>((ok, fail) => {
    server.once("error", fail);
    server.listen(opts.port ?? 0, "127.0.0.1", () => {
      server.off("error", fail);
      ok();
    });
  });
  const port = (server.address() as AddressInfo).port;
  const origin = `http://127.0.0.1:${port}`;
  return {
    origin,
    url: `${origin}/index.html`,
    port,
    close: () =>
      new Promise<void>((ok) => {
        server.closeAllConnections();
        server.close(() => ok());
      }),
  };
}
