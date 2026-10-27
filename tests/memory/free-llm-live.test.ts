// Opt-in live check: memory extraction through the upstream N.E.K.O free text
// service (lanlan.tech free-model). Skipped unless NEKO_LIVE_FREE=1. Only a
// synthetic test dialogue is sent; no real user data.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const LIVE = process.env.NEKO_LIVE_FREE === "1";
const LAUNCHER_PORT = 59080;
const BASE_URL = `http://127.0.0.1:${LAUNCHER_PORT}`;

const DIALOGUE: Array<[string, string]> = [
  ["我叫阿鲤，平时在杭州做后端开发。", "记住啦，阿鲤是杭州的后端工程师。"],
  ["我最喜欢喝无糖乌龙茶，咖啡一喝就睡不着。", "那以后给你推荐乌龙茶，不提咖啡。"],
  ["我养了一只橘猫叫团子，三岁了。", "团子三岁啦，一定很圆。"],
];

async function waitForHealth(timeoutMs: number): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try {
      if ((await fetch(`${BASE_URL}/health`)).ok) return true;
    } catch {
      // Not ready yet.
    }
    await sleep(200);
  }
  return false;
}

test("free-llm-live: upstream free-model extracts real facts", { skip: !LIVE && "set NEKO_LIVE_FREE=1" }, async () => {
  const repoRoot = join(import.meta.dirname, "../..");
  const venvPython = join(repoRoot, "services/neko-memory/.venv/Scripts/python.exe");
  const launcherScript = join(repoRoot, "services/neko-memory/launcher.py");
  const dataDir = mkdtempSync(join(tmpdir(), "free-llm-live-"));
  const configDir = join(dataDir, "N.E.K.O/config");

  // Per-turn extraction (OFF mode); launcher merges coreApi/assistApi=free into this file.
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, "core_config.json"), JSON.stringify({ powerful_memory_enabled: false }), "utf8");

  let proc: ChildProcess | null = null;
  let stdout = "";
  let stderr = "";
  const exitPromise = new Promise<number>((resolve) => {
    proc = spawn(venvPython, [launcherScript, "--enable-shutdown"], {
      cwd: join(repoRoot, "services/neko-memory"),
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        PYTHONIOENCODING: "utf-8",
        NEKO_MEMORY_LLM: "free",
        NEKO_MEMORY_SERVER_PORT: String(LAUNCHER_PORT),
        NEKO_MAIN_SERVER_PORT: "59081",
        NEKO_TOOL_SERVER_PORT: "59082",
        NEKO_MONITOR_SERVER_PORT: "59083",
        NEKO_COMMENTER_SERVER_PORT: "59084",
        NEKO_USER_PLUGIN_SERVER_PORT: "59086",
        NEKO_DATA_ROOT: dataDir,
      },
    });
    proc.stdout!.on("data", (d) => (stdout += d.toString()));
    proc.stderr!.on("data", (d) => (stderr += d.toString()));
    proc.on("exit", (code) => resolve(code ?? 1));
  });

  let characters: any;
  let client: any;
  try {
    assert.ok(await waitForHealth(40_000), "launcher did not become ready within 40s");
    assert.match(stdout, /model layer=upstream free-model/);

    const cont = await fetch(`${BASE_URL}/internal/storage/startup/continue`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason: "test" }),
    });
    assert.ok(cont.ok, `startup/continue failed: ${await cont.text()}`);
    await sleep(1000);
    assert.ok((await fetch(`${BASE_URL}/reload`, { method: "POST" })).ok, "reload failed");

    const { Character } = await import("../../packages/character-runtime/src/index.ts");
    const { MemoryClient } = await import("../../packages/memory-adapter/src/index.ts");
    const dbPath = join(dataDir, "app.sqlite");
    characters = Character.open({ dbPath, memoryServiceUrl: BASE_URL });
    client = new MemoryClient({ db_path: dbPath, base_url: BASE_URL, language: "zh" });

    const fish = characters.create("LiveFish");
    const reg = await (
      await fetch(`${BASE_URL}/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ character_id: fish.character_id, name: fish.upstream_name }),
      })
    ).json();
    assert.ok(reg.success, `register failed: ${reg.message}`);

    const started = Date.now();
    for (const [i, [user_text, assistant_text]] of DIALOGUE.entries()) {
      const receipt = await client.commitTurn({
        schema_version: "0.1-draft",
        character_id: fish.character_id,
        turn_id: `free-live-${i}`,
        source_kind: "text",
        created_at: new Date().toISOString(),
        scope: "user",
        user_text,
        assistant_text,
        assistant_delivery: "text_only",
      });
      assert.equal(receipt.kind, "submitted");
    }

    // Extraction runs in the background after /cache; poll facts.json.
    const factsUrl = `${BASE_URL}/f07/facts/${encodeURIComponent(fish.upstream_name)}`;
    let facts: Array<{ text?: string }> = [];
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      const body = await (await fetch(factsUrl)).json();
      facts = Array.isArray(body.facts) ? body.facts : Object.values(body.facts ?? {});
      if (facts.length > 0) break;
      await sleep(2000);
    }
    const texts = facts.map((f) => String(f.text ?? ""));
    console.log(`[free-llm-live] ${texts.length} facts after ${Date.now() - started}ms:`);
    for (const t of texts) console.log(`  - ${t}`);

    assert.ok(texts.length > 0, "free-model produced no facts within 120s");
    assert.ok(!texts.some((t) => t.includes("离线桩")), "stub fact leaked into free mode");
    assert.ok(
      texts.some((t) => /乌龙|团子|橘猫|杭州|后端|阿鲤/.test(t)),
      "facts do not reflect the dialogue content",
    );

    assert.ok((await fetch(`${BASE_URL}/shutdown`, { method: "POST" })).ok, "shutdown failed");
    const code = await Promise.race([exitPromise, sleep(10_000).then(() => -1)]);
    assert.notEqual(code, -1, "launcher did not exit within 10s");
  } catch (err) {
    proc?.kill();
    console.log("=== STDOUT (tail) ===\n", stdout.slice(-4000));
    console.log("=== STDERR (tail) ===\n", stderr.slice(-4000));
    throw err;
  } finally {
    characters?.close();
    client?.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});
