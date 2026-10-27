// F09 overlay static server: serves apps/pet-overlay with .ts type-stripped, serves the
// appearance pack under /assets/, refuses traversal and non-GET methods. Port 59050 (COLLAB).

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { startOverlayServer, resolveInside, type OverlayServer } from "../../packages/app-coordinator/src/overlay-server.ts";

const PORT = 59050;
let server: OverlayServer;
let assets: string;

before(async () => {
  assets = mkdtempSync(join(tmpdir(), "f09-assets-"));
  mkdirSync(join(assets, "webm"));
  writeFileSync(join(assets, "webm", "待机.webm"), "webm-bytes");
  server = await startOverlayServer({ port: PORT, assets_dir: assets });
});

after(async () => {
  await server?.close();
  rmSync(assets, { recursive: true, force: true });
});

test("binds 127.0.0.1 on the requested port", () => {
  assert.equal(server.origin, `http://127.0.0.1:${PORT}`);
  assert.equal(server.url, `http://127.0.0.1:${PORT}/index.html`);
});

test("serves index.html with a CSP and the renderer entry as stripped JavaScript", async () => {
  const html = await fetch(server.url);
  assert.equal(html.status, 200);
  const text = await html.text();
  assert.match(text, /Content-Security-Policy/);
  assert.match(text, /src\/main\.ts/);

  const js = await fetch(`${server.origin}/src/main.ts`);
  assert.equal(js.status, 200);
  assert.match(js.headers.get("content-type") ?? "", /text\/javascript/);
  const code = await js.text();
  assert.doesNotMatch(code, /^import type/m, "type-only imports are erased");
  assert.doesNotMatch(code, /interface NekoPetBridge/);
  // The stripped module must parse as JavaScript.
  const parsed = spawnSync(process.execPath, ["--input-type=module", "--check"], { input: code, encoding: "utf8" });
  assert.equal(parsed.status, 0, parsed.stderr);
});

test("serves pack assets under /assets/ with unicode names", async () => {
  const r = await fetch(`${server.origin}/assets/webm/${encodeURIComponent("待机")}.webm`);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("content-type"), "video/webm");
  assert.equal(await r.text(), "webm-bytes");
  const head = await fetch(`${server.origin}/assets/webm/${encodeURIComponent("待机")}.webm`, { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get("content-length"), String("webm-bytes".length));
});

test("refuses traversal, missing files and non-GET methods", async () => {
  assert.equal((await fetch(`${server.origin}/%2e%2e/%2e%2e/package.json`)).status, 404);
  assert.equal((await fetch(`${server.origin}/assets/%2e%2e/%2e%2e/etc`)).status, 404);
  assert.equal((await fetch(`${server.origin}/nope.html`)).status, 404);
  assert.equal((await fetch(server.url, { method: "POST" })).status, 405);
  assert.equal(resolveInside("/a/b", "/../c"), null);
  assert.equal(resolveInside("/a/b", "/x/../../b2"), null);
});
