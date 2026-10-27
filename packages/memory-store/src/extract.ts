// Heuristic memory extraction from one user message, Chinese-first.
// This is keyword matching, not understanding: it misses a lot and can misread.
// Results are only pending proposals; the user must confirm them before they
// count as facts or reach the prompt.

import { randomUUID } from "node:crypto";

import type { ChatMessage, MemoryItem } from "../../app-contracts/src/chat.ts";

const MAX_PAYLOAD_CHARS = 200;

/** Sentences keep their terminator so questions can be detected. */
const SENTENCE = /[^。！？!?；;\n]+[。！？!?；;\n]*/gu;
const QUESTION_WORDS = /吗|么|呢|什么|谁|哪|是否|为何|为什么|怎么|如何|能否|可否|难道/u;
// A heuristic cannot reliably resolve attribution inside quotations, examples or
// code. Skip the whole message when these markers occur, including multi-sentence
// quotations, instead of accidentally turning quoted first-person text into facts.
const QUOTATION_OR_CODE = /["'“”‘’「」『』`]|(?:^|\n)\s*>/u;
const NON_ASSERTIVE = /如果|假如|假设|假定|假使|倘若|要是|的话|除非|即使|就算|假装|设想|比如|例如|比方|举例|可能|也许|大概|或许|似乎|好像|估计|说不定|不确定|不一定|据说|听说/u;
// Explicit negative preferences are handled by their own pattern. Negation or
// retraction inside the payload can change what a matched prefix means.
const RETRACTION = /不是|并非|并不|没有|不再|不曾|未曾|从不|不(?:太|喜欢|爱|叫|要|能|会|愿|想|确定|一定|算|对)|才怪|假的|开玩笑|骗你|反话|说错|误说/u;

const LEADING_JUNK = /^(?:\s|的|：|:|,|，|一下)+/u;
const TRAILING_JUNK = /(?:\s|哦|啊|呀|喔|啦|[。！？!?；;，,：:、.~～…])+$/u;
const NAME_END = /[，,、\s]/u;

interface Pattern {
  keywords: readonly string[];
  kind: MemoryItem["kind"];
  build: (keyword: string, payload: string) => string;
  /** Names stop at the first comma or space. */
  nameOnly?: boolean;
}

// Order matters: negative preferences before 喜欢, longer keywords before their substrings.
const PATTERNS: readonly Pattern[] = [
  { keywords: ["你要记得", "别忘了", "记住"], kind: "fact", build: (_k, p) => p },
  {
    keywords: ["我的名字是", "我叫", "叫我"],
    kind: "fact",
    build: (_k, p) => `用户叫${p}`,
    nameOnly: true,
  },
  {
    keywords: ["我不喜欢", "我讨厌", "我害怕", "我怕"],
    kind: "preference",
    build: (k, p) => `用户${k === "我怕" ? "害怕" : k.slice(1)}${p}`,
  },
  {
    keywords: ["我最喜欢", "我喜欢", "我爱"],
    kind: "preference",
    build: (k, p) => `用户${k.slice(1)}${p}`,
  },
];

function clean(payload: string): string {
  return payload.replace(LEADING_JUNK, "").replace(TRAILING_JUNK, "");
}

function isQuestion(sentence: string): boolean {
  return /[？?]/u.test(sentence) || QUESTION_WORDS.test(sentence);
}

function matchSentence(sentence: string): { kind: MemoryItem["kind"]; text: string } | null {
  if (NON_ASSERTIVE.test(sentence)) return null;
  // Only a direct assertion or a direct request to remember qualifies. Searching
  // arbitrary substrings misattributes text such as "他说我喜欢猫" or "不是我叫小鱼".
  const direct = sentence.replace(/^(?:请你|请|麻烦你|麻烦)(?=你要记得|别忘了|记住)/u, "");
  for (const pattern of PATTERNS) {
    for (const keyword of pattern.keywords) {
      if (!direct.startsWith(keyword)) continue;
      let payload = clean(direct.slice(keyword.length));
      if (RETRACTION.test(payload)) return null;
      if (pattern.nameOnly) {
        const end = payload.search(NAME_END);
        if (end >= 0) payload = clean(payload.slice(0, end));
      }
      if (payload.length === 0 || payload.length > MAX_PAYLOAD_CHARS) return null;
      return { kind: pattern.kind, text: pattern.build(keyword, payload) };
    }
  }
  return null;
}

/** Pending memory proposals found in a user message; assistant messages yield none. */
export function extractMemoryProposals(
  message: ChatMessage,
  opts: { newId?: () => string; now?: () => number } = {},
): MemoryItem[] {
  if (message.role !== "user" || QUOTATION_OR_CODE.test(message.text)) return [];
  const newId = opts.newId ?? randomUUID;
  const now = opts.now ?? Date.now;
  const seen = new Set<string>();
  const out: MemoryItem[] = [];
  for (const [sentence] of message.text.matchAll(SENTENCE)) {
    if (isQuestion(sentence)) continue;
    const found = matchSentence(sentence.trim());
    if (found === null || seen.has(found.text)) continue;
    seen.add(found.text);
    out.push({
      id: newId(),
      personaId: message.personaId,
      kind: found.kind,
      text: found.text,
      sourceMessageIds: [message.id],
      confirmation: "pending",
      updatedAt: now(),
    });
  }
  return out;
}
