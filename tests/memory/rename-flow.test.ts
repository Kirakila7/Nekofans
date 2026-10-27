import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const LAUNCHER_PORT = 59020;
const BASE_URL = `http://127.0.0.1:${LAUNCHER_PORT}`;
const MARKER = "F05-MANGO-8811";
const CHARACTER_ID = "character_0f05a000000000000000000000009999";
const OLD_NAME = "MANGOCAT";
const NEW_NAME = "MANGOCAT2";

test("rename MANGOCAT -> MANGOCAT2 and verify recent", async () => {
  const repoRoot = join(import.meta.dirname, "../..");
  const venvPython = join(repoRoot, "services/neko-memory/.venv/Scripts/python.exe");
  const launcherScript = join(repoRoot, "services/neko-memory/launcher.py");
  const testDataDir = mkdtempSync(join(tmpdir(), "f05-rename-"));

  let proc: ChildProcess | null = null;
  let stdout = "";
  let stderr = "";

  const exitPromise = new Promise<number>((resolve) => {
    proc = spawn(venvPython, [launcherScript, "--enable-shutdown"], {
      cwd: join(repoRoot, "services/neko-memory"),
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        NEKO_MEMORY_SERVER_PORT: LAUNCHER_PORT.toString(),
        NEKO_MAIN_SERVER_PORT: "59021",
        NEKO_MONITOR_SERVER_PORT: "59023",
        NEKO_COMMENTER_SERVER_PORT: "59024",
        NEKO_TOOL_SERVER_PORT: "59022",
        NEKO_USER_PLUGIN_SERVER_PORT: "59026",
        NEKO_DATA_ROOT: testDataDir,
      },
    });
    proc.stdout!.on("data", (d) => (stdout += d.toString()));
    proc.stderr!.on("data", (d) => (stderr += d.toString()));
    proc.on("exit", (code) => resolve(code ?? 1));
  });

  try {
    const ready = await waitForHealth(BASE_URL, 30_000);
    assert.ok(ready, "launcher did not become ready within 30s");

    const createResp = await fetch(`${BASE_URL}/internal/storage/startup/continue`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason: "test" }),
    });
    assert.ok(createResp.ok, `startup/continue failed: ${await createResp.text()}`);

    await sleep(1000);

    const reloadResp = await fetch(`${BASE_URL}/reload`, { method: "POST" });
    assert.ok(reloadResp.ok, `reload failed: ${await reloadResp.text()}`);

    // Register our own character so _reserved.character_id is known; the upstream
    // default characters.json already exists before the launcher seed runs.
    const registerResp = await fetch(`${BASE_URL}/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ character_id: CHARACTER_ID, name: OLD_NAME }),
    });
    const registerData = await registerResp.json();
    assert.equal(registerData.success, true, `register failed: ${registerData.message}`);

    const turn1 = JSON.stringify([
      { type: "human", content: `芒果好吃 ${MARKER}` },
      { type: "ai", content: "嗯嗯，芒果很甜" },
    ]);
    const turn2 = JSON.stringify([
      { type: "human", content: `再来一个芒果 ${MARKER}` },
      { type: "ai", content: "好的，马上" },
    ]);

    const cache1 = await fetch(`${BASE_URL}/cache/${OLD_NAME}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ input_history: turn1, language: "zh" }),
    });
    assert.ok(cache1.ok, `cache turn1 failed: ${await cache1.text()}`);

    const cache2 = await fetch(`${BASE_URL}/cache/${OLD_NAME}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ input_history: turn2, language: "zh" }),
    });
    assert.ok(cache2.ok, `cache turn2 failed: ${await cache2.text()}`);

    await sleep(500);

    const getRecentBefore = await fetch(`${BASE_URL}/get_recent_history/${OLD_NAME}?language=zh`);
    const recentBefore = await getRecentBefore.text();
    assert.ok(recentBefore.includes(MARKER), `marker not in old-name recent before rename`);

    const renameResp = await fetch(`${BASE_URL}/rename`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ character_id: CHARACTER_ID, old_name: OLD_NAME, new_name: NEW_NAME }),
    });
    const renameData = await renameResp.json();
    console.log("rename response:", renameData);
    assert.equal(renameData.success, true, `rename failed: ${renameData.message}`);

    await sleep(500);

    const getRecentAfter = await fetch(`${BASE_URL}/get_recent_history/${NEW_NAME}?language=zh`);
    const recentAfter = await getRecentAfter.text();
    console.log("recent_history new name (first 300):", recentAfter.slice(0, 300));
    assert.ok(recentAfter.includes(MARKER), `marker ${MARKER} not found in new-name recent`);

    const getRecentOld = await fetch(`${BASE_URL}/get_recent_history/${OLD_NAME}?language=zh`);
    const recentOld = await getRecentOld.text();
    console.log("old-name status:", getRecentOld.status, recentOld.slice(0, 200));
    assert.ok(!recentOld.includes(MARKER), "old name must not still serve the migrated history");

    const shutdownResp = await fetch(`${BASE_URL}/shutdown`, { method: "POST" });
    assert.ok(shutdownResp.ok, "shutdown failed");

    const exitCode = await Promise.race([exitPromise, sleep(5000).then(() => -1)]);
    assert.notEqual(exitCode, -1, "launcher did not exit within 5s");
    console.log("✅ Test passed: rename flow + recent history migration");
  } catch (err) {
    proc?.kill();
    console.log("=== STDOUT ===\n", stdout);
    console.log("=== STDERR ===\n", stderr);
    throw err;
  } finally {
    rmSync(testDataDir, { recursive: true, force: true });
  }
});

async function waitForHealth(baseUrl: string, timeoutMs: number): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try {
      const res = await fetch(`${baseUrl}/health`);
      if (res.ok) return true;
    } catch {
      // Launcher not up yet, retry.
    }
    await sleep(200);
  }
  return false;
}
