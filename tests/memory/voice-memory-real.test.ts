// F10 real stack: neko-asr sidecar (scripted worker, emits interims then a
// final) -> AsrInput -> voice-turn -> MemoryClient.commitTurn -> real
// neko-memory launcher. Interims must never reach upstream history; the final
// is stored once; a replayed final does not duplicate; a later text turn uses
// the same write path and sees the voice memory.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { SidecarAsrProvider, startAsrSidecar, type AsrSidecarProcess } from "../../packages/voice-adapter/src/asr-sidecar.ts";
import { AsrInput } from "../../packages/voice-adapter/src/asr.ts";
import { ConversationTurns, attachVoiceTurns, voiceTurnId } from "../../packages/app-coordinator/src/voice-turn.ts";

const LAUNCHER_PORT = 59060;
const ASR_PORT = 59067;
const BASE_URL = `http://127.0.0.1:${LAUNCHER_PORT}`;
const INTERIMS = ["F10临时甲", "F10临时乙"];
const FINAL = "F10最终语音MARK7731 我喜欢吃草莓";
const TEXT_MARK = "F10文本MARK7731";

function countOf(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

test("voice-memory-real: final transcript stored once, interims never", async () => {
  const repoRoot = join(import.meta.dirname, "../..");
  const venvPython = join(repoRoot, "services/neko-memory/.venv/Scripts/python.exe");
  const launcherScript = join(repoRoot, "services/neko-memory/launcher.py");
  const dataDir = mkdtempSync(join(tmpdir(), "f10-voice-memory-"));

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
        NEKO_MEMORY_SERVER_PORT: String(LAUNCHER_PORT),
        NEKO_MAIN_SERVER_PORT: "59061",
        NEKO_TOOL_SERVER_PORT: "59062",
        NEKO_MONITOR_SERVER_PORT: "59063",
        NEKO_COMMENTER_SERVER_PORT: "59064",
        NEKO_USER_PLUGIN_SERVER_PORT: "59066",
        NEKO_DATA_ROOT: dataDir,
      },
    });
    proc.stdout!.on("data", (d) => (stdout += d.toString()));
    proc.stderr!.on("data", (d) => (stderr += d.toString()));
    proc.on("exit", (code) => resolve(code ?? 1));
  });

  let asrProc: AsrSidecarProcess | null = null;
  let asr: AsrInput | null = null;
  let characters: any;
  let client: any;
  try {
    asrProc = await startAsrSidecar({
      port: ASR_PORT,
      provider: "scripted",
      env: { NEKO_ASR_SCRIPT: [...INTERIMS, FINAL].join("|"), NEKO_ASR_SCRIPT_DUPLICATE_FINAL: "1" },
    });

    assert.ok(await waitForHealth(30_000), "launcher did not become ready within 30s");
    const cont = await fetch(`${BASE_URL}/internal/storage/startup/continue`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason: "test" }),
    });
    assert.ok(cont.ok, `startup/continue failed: ${await cont.text()}`);
    await sleep(1000);
    assert.ok((await fetch(`${BASE_URL}/reload`, { method: "POST" })).ok, "reload failed");

    const dbPath = join(dataDir, "app.sqlite");
    const { Character } = await import("../../packages/character-runtime/src/index.ts");
    const { MemoryClient } = await import("../../packages/memory-adapter/src/index.ts");
    characters = Character.open({ dbPath, memoryServiceUrl: BASE_URL });
    client = new MemoryClient({ db_path: dbPath, base_url: BASE_URL, language: "zh" });
    const fish = characters.create("VoiceFish");
    const reg = await fetch(`${BASE_URL}/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ character_id: fish.character_id, name: fish.upstream_name }),
    });
    assert.equal((await reg.json()).success, true, "register failed");

    const turns = new ConversationTurns(client, { character_id: fish.character_id, scope: "user", session_id: "f10" });
    asr = new AsrInput(new SidecarAsrProvider({ url: asrProc.ws_url }), { final_timeout_ms: 10_000 });
    const captions: string[] = [];
    const receipts: string[] = [];
    const finalsSeen: string[] = [];
    asr.onTranscriptFinal(({ text }) => finalsSeen.push(text));
    const binding = attachVoiceTurns({
      asr,
      turns,
      respond: async () => ({ assistant_text: "好的，记住你喜欢草莓了", assistant_delivery: "text_only" }),
      onCaption: (c) => captions.push(`${c.final ? "final" : "interim"}:${c.text}`),
      onCommitted: (_id, r) => receipts.push(r.kind),
    });

    // Push-to-talk: hotkey down, three audio frames, hotkey up.
    const handle = asr.startRecording("utt-f10-real");
    for (let i = 0; i < 3; i++) handle.pushAudio(new Uint8Array(3200));
    const result = await handle.stop();
    assert.equal(result.kind, "final");
    const first = await binding.settled("utt-f10-real");
    assert.equal(first?.kind, "submitted", `commit failed: ${JSON.stringify(first)}`);
    await sleep(300); // sidecar duplicate final arrives

    assert.deepEqual(captions, [...INTERIMS.map((t) => `interim:${t}`), `final:${FINAL}`]);
    assert.deepEqual(finalsSeen, [FINAL, FINAL], "sidecar replayed the final");
    assert.deepEqual(receipts, ["submitted"], "replay produced no second commit");
    assert.ok(client.replayCheck(voiceTurnId("utt-f10-real")));

    // Replay through the write path itself (e.g. after an app restart).
    const replay = await turns.commitVoice("utt-f10-real", FINAL, {
      assistant_text: "好的，记住你喜欢草莓了",
      assistant_delivery: "text_only",
    });
    assert.equal(replay.kind, "already_submitted");

    const name = encodeURIComponent(fish.upstream_name);
    const recent = await (await fetch(`${BASE_URL}/get_recent_history/${name}?language=zh`)).text();
    assert.equal(countOf(recent, FINAL), 1, `final must appear exactly once in recent:\n${recent.slice(0, 600)}`);
    for (const interim of INTERIMS) assert.equal(countOf(recent, interim), 0, `interim ${interim} leaked`);

    // A text turn afterwards goes through the same path and sees the voice memory.
    const text = await turns.commitText("text-f10-after", `${TEXT_MARK} 我刚才说喜欢什么？`, {
      assistant_text: "你说喜欢草莓",
      assistant_delivery: "text_only",
    });
    assert.equal(text.kind, "submitted");
    const ctx = await client.buildContext(fish.character_id, "user", undefined, 8_000);
    const lines = ctx.recent.map((l: { text: string }) => l.text).join("\n");
    assert.equal(countOf(lines, FINAL), 1, `buildContext must show the voice turn once:\n${lines}`);
    assert.ok(lines.includes(TEXT_MARK), "buildContext must show the text turn");
    for (const interim of INTERIMS) assert.ok(!lines.includes(interim), `interim ${interim} in context`);
    console.log(`voice-memory-real: ${ctx.recent.length} recent lines, final once, interims absent`);

    binding.detach();
    assert.ok((await fetch(`${BASE_URL}/shutdown`, { method: "POST" })).ok, "shutdown failed");
    const code = await Promise.race([exitPromise, sleep(10_000).then(() => -1)]);
    assert.notEqual(code, -1, "launcher did not exit within 10s");
  } catch (err) {
    proc?.kill();
    console.log("=== launcher STDOUT ===\n", stdout.slice(-4000));
    console.log("=== launcher STDERR ===\n", stderr.slice(-4000));
    if (asrProc) console.log("=== neko-asr ===\n", asrProc.output().slice(-2000));
    throw err;
  } finally {
    await asr?.close();
    await asrProc?.stop();
    characters?.close();
    client?.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

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
