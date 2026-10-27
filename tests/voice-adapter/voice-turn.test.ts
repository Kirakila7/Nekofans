// F10 offline: voice-turn glue over the deterministic fake ASR provider and an
// in-memory TurnMemory that mirrors MemoryClient's receipt dedup by turn_id.
import { test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";

import { FakeAsrProvider } from "../../packages/voice-adapter/src/asr-fake.ts";
import { AsrInput } from "../../packages/voice-adapter/src/asr.ts";
import type { Receipt } from "../../packages/memory-adapter/src/memory-client.ts";
import type { MemoryTurn } from "../../packages/app-contracts/src/index.ts";
import {
  ConversationTurns,
  attachVoiceTurns,
  voiceTurnId,
  type TurnMemory,
} from "../../packages/app-coordinator/src/voice-turn.ts";

const CHARACTER_ID = "character_0f10a000000000000000000000000001";

class RecordingMemory implements TurnMemory {
  /** Every commitTurn call, including deduplicated ones. */
  calls: MemoryTurn[] = [];
  /** Turns that reached the (simulated) upstream. */
  stored: MemoryTurn[] = [];
  #receipts = new Set<string>();

  replayCheck(turn_id: string): boolean {
    return this.#receipts.has(turn_id);
  }

  async commitTurn(turn: MemoryTurn): Promise<Receipt> {
    this.calls.push(turn);
    await sleep(5); // network latency, so concurrent duplicates overlap
    if (this.#receipts.has(turn.turn_id)) return { kind: "already_submitted", turn_id: turn.turn_id };
    this.stored.push(turn);
    this.#receipts.add(turn.turn_id);
    return {
      kind: "submitted",
      receipt_id: `r-${this.stored.length}`,
      turn_id: turn.turn_id,
      character_id: turn.character_id,
      submitted_at: new Date().toISOString(),
      status: "pending",
    };
  }
}

function setup(script: ConstructorParameters<typeof FakeAsrProvider>[0]) {
  const memory = new RecordingMemory();
  const turns = new ConversationTurns(memory, { character_id: CHARACTER_ID, scope: "user", session_id: "s-1" });
  const asr = new AsrInput(new FakeAsrProvider(script), { final_timeout_ms: 2_000 });
  const captions: Array<{ utterance_id: string; text: string; final: boolean }> = [];
  const replies: string[] = [];
  const binding = attachVoiceTurns({
    asr,
    turns,
    async respond(user_text) {
      replies.push(user_text);
      return { assistant_text: `收到：${user_text}`, assistant_delivery: "text_only" };
    },
    onCaption: (c) => captions.push(c),
  });
  return { memory, turns, asr, captions, replies, binding };
}

async function speak(asr: AsrInput, utterance_id: string, chunks: number) {
  const h = asr.startRecording(utterance_id);
  for (let i = 0; i < chunks; i++) h.pushAudio(new Uint8Array(3200));
  return h.stop();
}

test("interim captions are shown but never stored; final stored exactly once", async () => {
  const { memory, asr, captions, binding } = setup({ partials: ["今天", "今天天气"], final: "今天天气很好" });

  const result = await speak(asr, "utt-1", 3);
  assert.equal(result.kind, "final");
  const receipt = await binding.settled("utt-1");
  assert.equal(receipt?.kind, "submitted");

  assert.deepEqual(
    captions.map((c) => [c.text, c.final]),
    [["今天", false], ["今天天气", false], ["今天天气很好", true]],
  );
  assert.equal(memory.calls.length, 1, "exactly one commitTurn call");
  assert.equal(memory.stored.length, 1);
  const stored = memory.stored[0]!;
  assert.equal(stored.user_text, "今天天气很好");
  for (const interim of ["今天", "今天天气"]) {
    assert.ok(!memory.calls.some((t) => t.user_text === interim), `interim ${interim} must not be committed`);
  }
  await asr.close();
});

test("final turn is traceable: source_kind voice, utterance_id, turn_id derived from it", async () => {
  const { memory, asr, binding } = setup({ partials: ["喵"], final: "喵喵喵" });
  await speak(asr, "utt-trace", 1);
  await binding.settled("utt-trace");

  const turn = memory.stored[0]!;
  assert.equal(turn.source_kind, "voice");
  assert.equal(turn.utterance_id, "utt-trace");
  assert.equal(turn.turn_id, voiceTurnId("utt-trace"));
  assert.equal(turn.session_id, "s-1");
  assert.equal(turn.schema_version, "0.1-draft");
  assert.equal(turn.assistant_text, "收到：喵喵喵");
  await asr.close();
});

test("replayed final (provider duplicate) does not reply or store twice", async () => {
  const { memory, asr, replies, binding } = setup({ partials: [], final: "重复一次", duplicate_final: true });
  await speak(asr, "utt-dup", 1);
  await binding.settled("utt-dup");
  await sleep(30);

  assert.deepEqual(replies, ["重复一次"], "one assistant reply");
  assert.equal(memory.stored.length, 1, "stored once");
  assert.equal(memory.calls.length, 1, "duplicate final never reaches commitTurn");
  await asr.close();
});

test("replay after restart is deduplicated by the persisted receipt", async () => {
  const first = setup({ partials: [], final: "重启前" });
  await speak(first.asr, "utt-restart", 1);
  await first.binding.settled("utt-restart");
  await first.asr.close();

  // New binding (fresh in-process state) over the same receipt store.
  const turns = new ConversationTurns(first.memory, { character_id: CHARACTER_ID, scope: "user" });
  const asr = new AsrInput(new FakeAsrProvider({ partials: [], final: "重启前" }));
  const replies: string[] = [];
  const binding = attachVoiceTurns({
    asr,
    turns,
    async respond(t) {
      replies.push(t);
      return { assistant_text: "x", assistant_delivery: "text_only" };
    },
  });
  await speak(asr, "utt-restart", 1);
  const receipt = await binding.settled("utt-restart");
  assert.equal(receipt?.kind, "already_submitted");
  assert.deepEqual(replies, []);
  assert.equal(first.memory.stored.length, 1);
  await asr.close();
});

test("text and voice turns share one commit path and dedup by turn_id", async () => {
  const { memory, turns, asr, binding } = setup({ partials: ["你"], final: "你好" });

  const text = await turns.commitText("text-1", "打字输入", { assistant_text: "好", assistant_delivery: "text_only" });
  assert.equal(text.kind, "submitted");
  await speak(asr, "utt-mixed", 1);
  await binding.settled("utt-mixed");

  // Concurrent duplicates of one turn_id collapse into one upstream write.
  const [a, b] = await Promise.all([
    turns.commitText("text-2", "并发", { assistant_text: "嗯", assistant_delivery: "text_only" }),
    turns.commitText("text-2", "并发", { assistant_text: "嗯", assistant_delivery: "text_only" }),
  ]);
  assert.deepEqual([a.kind, b.kind].sort(), ["already_submitted", "submitted"]);
  const again = await turns.commitText("text-1", "打字输入", { assistant_text: "好", assistant_delivery: "text_only" });
  assert.equal(again.kind, "already_submitted");

  assert.deepEqual(
    memory.stored.map((t) => [t.turn_id, t.source_kind]),
    [["text-1", "text"], [voiceTurnId("utt-mixed"), "voice"], ["text-2", "text"]],
  );
  assert.equal(memory.stored.find((t) => t.source_kind === "text")?.utterance_id, undefined);
  await asr.close();
});

test("empty utterance (no audio) produces no turn", async () => {
  const { memory, asr, replies } = setup({ partials: [], final: "不应出现" });
  const result = await speak(asr, "utt-empty", 0);
  assert.equal(result.kind, "empty");
  await sleep(20);
  assert.deepEqual(replies, []);
  assert.equal(memory.calls.length, 0);
  await asr.close();
});

test("a failed write is retried by a later replay of the same final", async () => {
  const memory = new RecordingMemory();
  let failNext = true;
  const flaky: TurnMemory = {
    replayCheck: (id) => memory.replayCheck(id),
    async commitTurn(turn) {
      if (failNext) {
        failNext = false;
        return { kind: "error", turn_id: turn.turn_id, code: "network_error", message: "down" };
      }
      return memory.commitTurn(turn);
    },
  };
  const turns = new ConversationTurns(flaky, { character_id: CHARACTER_ID, scope: "user" });
  const asr = new AsrInput(new FakeAsrProvider({ partials: [], final: "重试", duplicate_final: true }));
  const outcomes: string[] = [];
  const binding = attachVoiceTurns({
    asr,
    turns,
    respond: async () => ({ assistant_text: "ok", assistant_delivery: "text_only" }),
    onCommitted: (_id, r) => outcomes.push(r.kind),
  });
  await speak(asr, "utt-retry", 1);
  await sleep(50);
  await binding.settled("utt-retry");
  assert.deepEqual(outcomes, ["error", "submitted"]);
  assert.equal(memory.stored.length, 1);
  await asr.close();
});
