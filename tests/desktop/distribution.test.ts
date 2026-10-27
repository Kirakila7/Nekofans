import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { inspectDistribution } from "../../scripts/check-distribution.mjs";

function fixture() {
  const base = mkdtempSync(join(tmpdir(), "bigfish-distribution-"));
  const root = join(base, "app");
  mkdirSync(root);
  const put = (path: string, content = "fixture") => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, content); };
  put(join(root, "package.json"), JSON.stringify({ name: "fixture", main: "apps/desktop/main.cjs" }));
  put(join(root, "apps/desktop/main.cjs"));
  put(join(root, "config/upstream-lock.json"), JSON.stringify({ purpose: "source_review_snapshot_not_release_lock" }));
  const env = {
    NEKO_FISH_ELECTRON: join(root, "runtime/electron.exe"),
    NEKO_FISH_ASSETS_DIR: join(root, "assets/webm"),
    NEKO_FISH_DSH_RUNTIME: join(root, "runtime/dsh"),
    NEKO_FISH_DSH_PRIMARY_RUNTIME: join(root, "runtime/primary-runtime"),
  };
  put(env.NEKO_FISH_ELECTRON);
  put(join(env.NEKO_FISH_DSH_RUNTIME, "node_modules/@deepseek-ai/dsh-desktop-host/lib/index.js"));
  mkdirSync(env.NEKO_FISH_DSH_PRIMARY_RUNTIME, { recursive: true });
  return { base, root, env, put, close: () => rmSync(base, { recursive: true, force: true }) };
}
const status = (report: ReturnType<typeof inspectDistribution>, id: string) => report.checks.find((c: { id: string }) => c.id === id)?.status;

test("Host file presence never certifies an empty primary runtime or release", () => {
  const f = fixture();
  try {
    const report = inspectDistribution(f);
    assert.equal(status(report, "dsh-host"), "present");
    assert.equal(status(report, "primary-runtime"), "blocked");
    assert.equal(status(report, "runtime-release-lock"), "blocked");
    assert.equal(report.releaseReady, false);
    assert.equal(status(report, "real-chat"), "manual");
    assert.equal(status(report, "real-dsh"), "manual");
    assert.ok(report.blocked > 0);
    assert.equal(readdirSync(f.env.NEKO_FISH_DSH_PRIMARY_RUNTIME).length, 0);
  } finally { f.close(); }
});

test("payload inside a known stub remains blocked; ordinary payload is only present evidence", () => {
  const f = fixture();
  try {
    f.put(join(f.env.NEKO_FISH_DSH_PRIMARY_RUNTIME, "bin/python.exe"));
    assert.equal(status(inspectDistribution(f), "primary-runtime"), "present");
    f.env.NEKO_FISH_DSH_PRIMARY_RUNTIME = join(f.root, "primary-runtime-stub/primary-runtime");
    f.put(join(f.env.NEKO_FISH_DSH_PRIMARY_RUNTIME, "bin/python.exe"));
    assert.equal(status(inspectDistribution(f), "primary-runtime"), "blocked");
  } finally { f.close(); }
});

test("runtime linked outside the source root is not self-contained", () => {
  const f = fixture();
  try {
    const external = join(f.base, "outside");
    f.put(join(external, "bin/python.exe"));
    const linked = join(f.root, "linked-runtime");
    symlinkSync(external, linked, process.platform === "win32" ? "junction" : "dir");
    f.env.NEKO_FISH_DSH_PRIMARY_RUNTIME = linked;
    assert.equal(status(inspectDistribution(f), "self-contained-primary"), "blocked");
  } finally { f.close(); }
});

test("sensitive names block packaging without emitting content, filenames, or environment secrets", () => {
  const f = fixture();
  try {
    const marker = "synthetic-private-marker";
    f.put(join(f.root, "config/secrets/chat-api-key.dpapi"), marker);
    f.put(join(f.root, `.env.${marker}`), marker);
    const before = readFileSync(join(f.root, "config/secrets/chat-api-key.dpapi"), "utf8");
    const report = inspectDistribution({ root: f.root, env: { ...f.env, UNRELATED_TOKEN: marker } });
    assert.equal(status(report, "source-data-names"), "blocked");
    assert.equal(JSON.stringify(report).includes(marker), false);
    assert.equal(readFileSync(join(f.root, "config/secrets/chat-api-key.dpapi"), "utf8"), before);
  } finally { f.close(); }
});

test("malformed manifests and missing entry cannot look ready or leak parse content", () => {
  const f = fixture();
  try {
    f.put(join(f.root, "package.json"), "private malformed marker");
    const report = inspectDistribution(f);
    assert.equal(status(report, "source-manifest"), "blocked");
    assert.equal(status(report, "packaged-entry"), "blocked");
    assert.equal(JSON.stringify(report).includes("private malformed marker"), false);
  } finally { f.close(); }
});

test("preflight CLI emits parseable blocked JSON and help starts no runtime", () => {
  const script = fileURLToPath(new URL("../../scripts/check-distribution.mjs", import.meta.url));
  const result = spawnSync(process.execPath, [script, "--json"], { encoding: "utf8", windowsHide: true });
  assert.ok(result.status === 1 || result.status === 2);
  assert.equal(JSON.parse(result.stdout).releaseReady, false);
  assert.equal(result.stderr, "");
  const help = spawnSync(process.execPath, [script, "--help"], { encoding: "utf8", windowsHide: true });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /不启动程序/);
});
