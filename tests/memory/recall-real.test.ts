// F07: recall against the real vendored memory-server.
// Spawns the launcher on port 59030 with NEKO_F07_SCRIPTED_LLM=1, so fact
// extraction returns the 【记住:...】 markers found in each turn and reflection
// synthesis returns a fixed text. Everything else (dedup, storage, reflection
// bookkeeping, compression, /new_dialog rendering, keyword recall) is upstream.
// Persona promotion is age-driven, so the test backdates reflection timestamps
// on disk between /reflect calls.
// No embedding model is loaded, so only the keyword leg of hybrid recall runs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const PORT = 59030;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const DUMP = process.env.F07_DUMP === "1";

const FACTS = [
  "主人最喜欢的水果是芒果",
  "主人每天早上六点起床",
  "主人养了一只叫团子的橘猫",
  "主人周末喜欢去河边钓鱼",
  "主人正在学习弹尤克里里",
  "主人对花生过敏",
];
const REFLECTION_TEXT = "主人的生活节奏偏慢，喜欢安静的爱好";
// /settle compresses recent history once it holds more than 20 ordinary messages.
const TURNS = 11;

test("recall-real: summary, facts with sources, reflections and persona via MemoryClient", async () => {
  const repoRoot = join(import.meta.dirname, "../..");
  const python = join(repoRoot, "services/neko-memory/.venv/Scripts/python.exe");
  const launcher = join(repoRoot, "services/neko-memory/launcher.py");
  const dataDir = mkdtempSync(join(tmpdir(), "f07-recall-"));
  const configDir = join(dataDir, "N.E.K.O/config");
  mkdirSync(configDir, { recursive: true });
  // powerful_memory off: upstream runs Stage-1 fact extraction on every /cache.
  writeFileSync(join(configDir, "core_config.json"), JSON.stringify({ powerful_memory_enabled: false }), "utf8");

  let log = "";
  const proc: ChildProcess = spawn(python, [launcher, "--enable-shutdown"], {
    cwd: join(repoRoot, "services/neko-memory"),
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      NEKO_MEMORY_LLM: "stub",
      NEKO_F07_SCRIPTED_LLM: "1",
      NEKO_MEMORY_SERVER_PORT: String(PORT),
      NEKO_MAIN_SERVER_PORT: "59031",
      NEKO_TOOL_SERVER_PORT: "59032",
      NEKO_MONITOR_SERVER_PORT: "59033",
      NEKO_COMMENTER_SERVER_PORT: "59034",
      NEKO_USER_PLUGIN_SERVER_PORT: "59036",
      NEKO_DATA_ROOT: dataDir,
    },
  });
  proc.stdout!.on("data", (d) => (log += d.toString()));
  proc.stderr!.on("data", (d) => (log += d.toString()));
  const exited = new Promise<number>((resolve) => proc.on("exit", (code) => resolve(code ?? 1)));

  let characters: any;
  let client: any;
  try {
    assert.ok(await waitForHealth(BASE_URL, 30_000), "launcher did not become ready within 30s");
    const cont = await fetch(`${BASE_URL}/internal/storage/startup/continue`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason: "test" }),
    });
    assert.ok(cont.ok, `startup/continue failed: ${await cont.text()}`);
    await sleep(500);
    assert.ok((await fetch(`${BASE_URL}/reload`, { method: "POST" })).ok, "reload failed");

    const { Character } = await import("../../packages/character-runtime/src/index.ts");
    const { MemoryClient } = await import("../../packages/memory-adapter/src/memory-client.ts");
    const dbPath = join(dataDir, "app.sqlite");
    characters = Character.open({ dbPath, memoryServiceUrl: BASE_URL });
    client = new MemoryClient({ db_path: dbPath, base_url: BASE_URL, language: "zh" });

    const fish = characters.create("回忆鱼");
    const name = encodeURIComponent(fish.upstream_name);
    const reg = await (await fetch(`${BASE_URL}/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ character_id: fish.character_id, name: fish.upstream_name }),
    })).json();
    assert.ok(reg.success, `register failed: ${reg.message}`);

    for (let i = 0; i < TURNS; i++) {
      const fact = FACTS[i];
      const receipt = await client.commitTurn({
        schema_version: "0.1-draft",
        character_id: fish.character_id,
        turn_id: `f07-${i + 1}`,
        source_kind: "text",
        created_at: new Date().toISOString(),
        scope: "user",
        user_text: fact ? `第${i + 1}轮。【记住:${fact}】` : `第${i + 1}轮，随便聊聊天气。`,
        assistant_text: `好的，第${i + 1}轮我记下了。`,
        assistant_delivery: "text_only",
      });
      assert.equal(receipt.kind, "submitted", `turn ${i + 1}: ${JSON.stringify(receipt)}`);
    }

    // Facts: per-turn extraction runs in a background task after each /cache.
    const facts = await poll(() => client.listFacts(fish.character_id), (f: any[]) => f.length >= FACTS.length, 20_000);
    if (DUMP) console.log("FACTS", JSON.stringify(facts, null, 2));
    assert.deepEqual(new Set(facts.map((f: any) => f.text)), new Set(FACTS), "every marker became one stored fact");
    for (const f of facts) {
      assert.equal(f.source, "user_observation", `fact ${f.id} source`);
      assert.match(f.id, /^fact_\d{14}_[0-9a-f]{8}$/);
      assert.equal(f.entity, "master");
      assert.equal(f.archived, false);
      assert.ok(!Number.isNaN(Date.parse(f.created_at)), `fact ${f.id} created_at`);
    }

    // Keyword recall through the adapter: each query must return its own fact.
    for (const [query, expected] of [["芒果", FACTS[0]], ["团子", FACTS[2]], ["尤克里里", FACTS[4]]] as const) {
      const hits = await client.queryFacts(fish.character_id, query);
      if (DUMP) console.log("QUERY", query, JSON.stringify(hits));
      const hit = hits.find((h: any) => h.text === expected);
      assert.ok(hit, `queryFacts(${query}) must return "${expected}", got ${JSON.stringify(hits)}`);
      assert.ok(facts.some((f: any) => f.id === hit.id), "recalled id points at a stored fact");
    }

    // Recent summary: /settle compresses history above the threshold into a memo.
    const settle = await (await fetch(`${BASE_URL}/settle/${name}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input_history: "[]", language: "zh" }),
    })).json();
    assert.equal(settle.status, "settled", JSON.stringify(settle));

    // Reflection: >= 5 unabsorbed facts -> synthesis -> pending reflection.
    const reflect = await (await fetch(`${BASE_URL}/reflect/${name}`, { method: "POST" })).json();
    if (DUMP) console.log("REFLECT", JSON.stringify(reflect, null, 2));
    const reflections = await client.listReflections(fish.character_id);
    if (DUMP) console.log("REFLECTIONS", JSON.stringify(reflections, null, 2));
    assert.equal(reflections.length, 1, "one reflection synthesized");
    const refl = reflections[0];
    assert.equal(refl.text, REFLECTION_TEXT);
    assert.deepEqual([...refl.source_fact_ids].sort(), facts.map((f: any) => f.id).sort(), "reflection cites its facts");

    const absorbed = await client.listFacts(fish.character_id);
    assert.ok(absorbed.every((f: any) => f.absorbed === true), "synthesis marks its source facts absorbed");

    // /new_dialog: memo summary of the compressed turns, the latest turns verbatim,
    // and the pending reflection rendered as an uncertain impression.
    const ctx = await client.buildContext(fish.character_id, "user", undefined, 10_000);
    if (DUMP) console.log("CONTEXT", JSON.stringify(ctx, null, 2));
    assert.match(ctx.recent[0].text, /^先前对话的备忘录: \S+/, "first recent line is the summary memo");
    assert.ok(ctx.recent.some((l: any) => l.text.includes("第11轮")), "latest turn kept verbatim");
    assert.ok(!ctx.recent.some((l: any) => l.text.includes("第1轮。")), "oldest turns folded into the memo");
    assert.match(ctx.persona, /最近的印象（还不太确定）\n- 主人的生活节奏偏慢，喜欢安静的爱好/);

    // Persona promotion is age-driven with powerful_memory off: pending -> confirmed
    // after WEAK_MEMORY_AUTO_CONFIRM_DAYS (7) and confirmed -> persona after
    // WEAK_MEMORY_AUTO_PROMOTE_DAYS (7). Backdate the timestamps on disk and let
    // the background promotion started by /reflect do the transitions.
    const reflPath = findFile(dataDir, "reflections.json");
    const daysAgo = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString().replace("Z", "");
    backdate(reflPath, refl.id, "created_at", daysAgo(8));
    await fetch(`${BASE_URL}/reflect/${name}`, { method: "POST" });
    const confirmed = await poll(() => client.listReflections(fish.character_id), (r: any[]) => r[0]?.status === "confirmed", 10_000);
    assert.equal(confirmed[0].status, "confirmed", "pending reflection auto-confirmed after 7 days");
    backdate(reflPath, refl.id, "confirmed_at", daysAgo(8));
    await fetch(`${BASE_URL}/reflect/${name}`, { method: "POST" });
    const promotedEntry = (p: any) => p.master?.facts?.find((f: any) => f.source_id === refl.id);
    const persona = await poll(() => client.getPersona(fish.character_id), (p: any) => !!promotedEntry(p), 10_000);
    if (DUMP) console.log("PERSONA_MASTER", JSON.stringify(persona.master, null, 2));
    const entry = promotedEntry(persona);
    assert.ok(entry, "promoted reflection appears in persona.master");
    assert.equal(entry.text, REFLECTION_TEXT);
    assert.equal(entry.source, "reflection_time_driven");
    assert.ok(persona.neko.facts.every((f: any) => f.source === "character_card"), "card entries keep their source");
    const promoted = await client.listReflections(fish.character_id);
    assert.equal(promoted[0].status, "promoted");

    const ctx2 = await client.buildContext(fish.character_id, "user", undefined, 10_000);
    if (DUMP) console.log("PERSONA_TEXT", ctx2.persona);
    assert.match(ctx2.persona, /### 关于碳基生物[^#]*- 主人的生活节奏偏慢，喜欢安静的爱好/, "promoted entry rendered under the master section");

    assert.ok((await fetch(`${BASE_URL}/shutdown`, { method: "POST" })).ok, "shutdown failed");
    const code = await Promise.race([exited, sleep(15_000).then(() => -1)]);
    assert.notEqual(code, -1, "launcher did not exit within 15s");
  } catch (err) {
    console.log("=== launcher log (tail) ===\n" + log.slice(-6000));
    throw err;
  } finally {
    if (proc.exitCode === null) proc.kill();
    characters?.close();
    client?.close();
    await sleep(300);
    rmSync(dataDir, { recursive: true, force: true });
  }
});

function findFile(root: string, file: string): string {
  for (const entry of readdirSync(root, { withFileTypes: true, recursive: true })) {
    if (entry.isFile() && entry.name === file) return join(entry.parentPath, entry.name);
  }
  throw new Error(`${file} not found under ${root}`);
}

function backdate(path: string, id: string, field: string, value: string): void {
  const rows = JSON.parse(readFileSync(path, "utf8"));
  const row = rows.find((r: any) => r.id === id);
  assert.ok(row, `reflection ${id} not in ${path}`);
  row[field] = value;
  writeFileSync(path, JSON.stringify(rows, null, 2), "utf8");
}

async function poll<T>(fn: () => Promise<T>, ok: (v: T) => boolean, timeoutMs: number): Promise<T> {
  const end = Date.now() + timeoutMs;
  let last = await fn();
  while (!ok(last) && Date.now() < end) {
    await sleep(250);
    last = await fn();
  }
  return last;
}

async function waitForHealth(baseUrl: string, timeoutMs: number): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try {
      if ((await fetch(`${baseUrl}/health`)).ok) return true;
    } catch {
      // Not ready yet.
    }
    await sleep(200);
  }
  return false;
}
