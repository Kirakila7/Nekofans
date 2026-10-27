import { test } from "node:test";
import assert from "node:assert/strict";

import type { ChatMessage } from "../../packages/app-contracts/src/chat.ts";
import { extractMemoryProposals } from "../../packages/memory-store/src/extract.ts";

function message(text: string, extra: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: "source-user-message",
    personaId: "bigfish",
    conversationId: "conversation-1",
    role: "user",
    text,
    createdAt: 1000,
    ...extra,
  };
}

function extract(text: string) {
  let nextId = 0;
  return extractMemoryProposals(message(text), { newId: () => `proposal-${++nextId}`, now: () => 2000 });
}

test("direct user facts and preferences produce only pending proposals with source ids", () => {
  const proposals = extract("我叫小鱼。我喜欢猫。我不喜欢香菜。我怕打雷。请记住我的生日是六月一日。");
  assert.deepEqual(proposals.map((p) => [p.kind, p.text]), [
    ["fact", "用户叫小鱼"],
    ["preference", "用户喜欢猫"],
    ["preference", "用户不喜欢香菜"],
    ["preference", "用户害怕打雷"],
    ["fact", "我的生日是六月一日"],
  ]);
  assert.deepEqual(proposals.map((p) => p.id), ["proposal-1", "proposal-2", "proposal-3", "proposal-4", "proposal-5"]);
  for (const proposal of proposals) {
    assert.equal(proposal.confirmation, "pending");
    assert.equal(proposal.personaId, "bigfish");
    assert.deepEqual(proposal.sourceMessageIds, ["source-user-message"]);
    assert.equal(proposal.updatedAt, 2000);
  }
});

test("assistant messages never generate memory proposals or allocate ids", () => {
  assert.deepEqual(extractMemoryProposals(message("记住用户叫小鱼。我喜欢猫。", { role: "assistant" }), {
    newId: () => { throw new Error("must not allocate"); },
    now: () => { throw new Error("must not timestamp"); },
  }), []);
});

test("different personas and source messages retain their own provenance", () => {
  const [proposal] = extractMemoryProposals(message("我喜欢猫。", { id: "other-source", personaId: "other" }), {
    newId: () => "other-proposal",
    now: () => 3000,
  });
  assert.equal(proposal.personaId, "other");
  assert.deepEqual(proposal.sourceMessageIds, ["other-source"]);
  assert.equal(proposal.confirmation, "pending");
});

test("questions do not become assertions even without a question mark", () => {
  for (const text of [
    "我喜欢猫吗？", "我喜欢猫?", "我喜欢什么", "我叫什么", "我喜欢猫是不是", "我喜欢猫呢",
    "你要记得什么", "我喜欢谁", "我喜欢哪里", "我喜欢猫是否正常", "我喜欢猫么",
  ]) {
    assert.deepEqual(extract(text), [], text);
  }
  assert.deepEqual(extract("我喜欢猫？我叫小鱼。").map((p) => p.text), ["用户叫小鱼"]);
});

test("negated, retracted and indirect phrases cannot become positive facts", () => {
  for (const text of [
    "不要记住我喜欢猫。", "别记住我叫小鱼。", "不是我喜欢猫。", "我并不喜欢猫。",
    "我喜欢的不是猫。", "我叫的不是小鱼。", "我喜欢猫才怪。", "我喜欢猫是假的。",
    "我不喜欢猫是开玩笑。", "我喜欢猫是说错了。", "他说我喜欢猫。", "你觉得我喜欢猫。",
  ]) {
    assert.deepEqual(extract(text), [], text);
  }
});

test("quoted text and code are conservatively excluded across sentence boundaries", () => {
  for (const text of [
    "他说：我喜欢猫。", "他说：\"我叫小鱼。我喜欢猫。\"", "“我叫小鱼。我喜欢猫。”",
    "‘我喜欢猫’是例句。", "「我喜欢猫」", "『我叫小鱼』", "'我喜欢猫'",
    "`我喜欢猫`", "```\n我叫小鱼。\n我喜欢猫。\n```", "> 我喜欢猫\n我叫小鱼。",
    "她引用了这句话：\"我喜欢猫。", // Unclosed quotation must not leak a later sentence.
  ]) {
    assert.deepEqual(extract(text), [], text);
  }
});

test("hypothetical, example and uncertain statements are not proposed", () => {
  for (const text of [
    "如果我喜欢猫。", "假设我叫小鱼。", "我喜欢猫的话会养一只。", "我喜欢猫可能只是暂时。",
    "我叫小鱼只是举例。", "我喜欢猫是假装的。", "我喜欢猫好像也喜欢狗。", "我喜欢猫也许吧。",
  ]) {
    assert.deepEqual(extract(text), [], text);
  }
});

test("empty, oversized and duplicate proposals are discarded without consuming ids", () => {
  assert.deepEqual(extract("我喜欢。记住。我的名字是。"), []);
  assert.deepEqual(extract(`我喜欢${"猫".repeat(201)}。`), []);
  assert.equal(extract(`我喜欢${"猫".repeat(200)}。`).length, 1);
  assert.deepEqual(extract("我喜欢猫。我喜欢猫！我叫小鱼。").map((p) => [p.id, p.text]), [
    ["proposal-1", "用户喜欢猫"], ["proposal-2", "用户叫小鱼"],
  ]);
});

test("supported variants clean punctuation and keep names separate from a greeting", () => {
  assert.deepEqual(extract("我的名字是大肥鱼，很高兴见到你。叫我小鱼。你要记得：周末休息。别忘了：喝水。\n我最喜欢海边。\n我讨厌噪音。").map((p) => p.text), [
    "用户叫大肥鱼", "用户叫小鱼", "周末休息", "喝水", "用户最喜欢海边", "用户讨厌噪音",
  ]);
});
