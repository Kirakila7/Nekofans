// F07: recall and fact lookup against a mock memory-service on 127.0.0.1:59007.
// The mock keeps per-character recent.json / facts.json in a temp dir using the
// upstream on-disk shapes, and renders /new_dialog and /query_memory like upstream.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { CharacterId, MemoryTurn } from "../../packages/app-contracts/src/index.ts";
import { Character } from "../../packages/character-runtime/src/index.ts";
import { MemoryClient } from "../../packages/memory-adapter/src/index.ts";

const PORT = 59007;
const MARKER = "F07-BANANA-9527";

interface RecentEntry { type: "human" | "ai" | "system"; data: { content: string } }
interface FactEntry { id: string; text: string; entity: string; created_at: string }

let workDir: string;
let server: Server;

function charDir(name: string): string {
  const dir = join(workDir, "memory", name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function readJson<T>(path: string, fallback: T): T {
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as T) : fallback;
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function startMock(): Promise<void> {
  server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${PORT}`);
    const [, route, rawName] = url.pathname.split("/");
    const name = decodeURIComponent(rawName ?? "");
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };

    if (req.method === "POST" && route === "cache") {
      const { input_history } = JSON.parse(await readBody(req)) as { input_history: string };
      const msgs = JSON.parse(input_history) as { role: string; content: string }[];
      const file = join(charDir(name), "recent.json");
      const recent = readJson<RecentEntry[]>(file, []);
      for (const m of msgs) recent.push({ type: m.role === "user" ? "human" : "ai", data: { content: m.content } });
      writeFileSync(file, JSON.stringify(recent, null, 2));
      // Simulate Stage-1 extraction: a turn mentioning the marker yields a fact.
      if (msgs.some((m) => m.content.includes(MARKER))) {
        const factsFile = join(charDir(name), "facts.json");
        const facts = readJson<FactEntry[]>(factsFile, []);
        if (facts.length === 0) {
          facts.push({
            id: "fact_f07_banana",
            text: `主人最喜欢的水果是香蕉（${MARKER}）`,
            entity: "master",
            created_at: new Date().toISOString(),
          });
          writeFileSync(factsFile, JSON.stringify(facts, null, 2));
        }
      }
      return json(200, { status: "cached", count: msgs.length });
    }

    if (req.method === "GET" && route === "new_dialog") {
      const recent = readJson<RecentEntry[]>(join(charDir(name), "recent.json"), []);
      const facts = readJson<FactEntry[]>(join(charDir(name), "facts.json"), []);
      const speaker = { human: "碳基生物", ai: name, system: "SYSTEM_MESSAGE" } as const;
      let text = `\n======${name}的长期记忆======\n### 关于碳基生物\n`;
      for (const f of facts) text += `- ${f.text}\n`;
      text += `\n\n======以下是${name}的内心活动======\n`;
      text += `现在时间是${new Date().toString()}。开始聊天前，${name}又在脑海内整理了近期发生的事情。\n`;
      for (const r of recent) text += `${speaker[r.type]} | ${r.data.content}\n`;
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      return res.end(text);
    }

    if (req.method === "POST" && route === "query_memory") {
      const { query = "" } = JSON.parse(await readBody(req)) as { query?: string; time?: string };
      const facts = readJson<FactEntry[]>(join(charDir(name), "facts.json"), []);
      const results = facts
        .filter((f) => query && f.text.includes(query))
        .map((f) => ({ id: f.id, text: f.text, tier: "fact", entity: f.entity, score: 0.016393, created_at: f.created_at }));
      return json(200, { results, query, candidates_total: facts.length, elapsed_ms: 1.0 });
    }

    json(404, { detail: "Not Found" });
  });
  return new Promise((resolve) => server.listen(PORT, "127.0.0.1", resolve));
}

function makeTurn(character_id: string, turn_id: string, user_text: string, assistant_text: string): MemoryTurn {
  return {
    schema_version: "0.1-draft",
    character_id: character_id as CharacterId,
    turn_id,
    source_kind: "text",
    created_at: new Date().toISOString(),
    scope: "character",
    user_text,
    assistant_text,
    assistant_delivery: "text_only",
  };
}

/** Register a character in a fresh app.sqlite and open an F06 client on it. */
function setup(display_name: string, db_file: string): { character_id: string; client: MemoryClient } {
  const db_path = join(workDir, db_file);
  const store = Character.open({ dbPath: db_path });
  const { character_id } = store.create(display_name);
  store.close();
  return { character_id, client: new MemoryClient({ db_path, base_url: `http://127.0.0.1:${PORT}` }) };
}

before(async () => {
  workDir = mkdtempSync(join(tmpdir(), "f07-recall-"));
  await startMock();
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  rmSync(workDir, { recursive: true, force: true });
});

test("buildContext returns committed marker; queryFacts finds the banana fact", async () => {
  const { character_id, client } = setup("小香", "app.sqlite");

  const turns = [
    makeTurn(character_id, "f07-t1", `F07 测试：我最喜欢的水果是香蕉，标记 ${MARKER}`, "记住啦，你最喜欢香蕉"),
    makeTurn(character_id, "f07-t2", "第2轮：今天在写召回测试", "第2轮收到"),
    makeTurn(character_id, "f07-t3", "第3轮：快写完了", "第3轮收到"),
  ];
  for (const turn of turns) {
    const receipt = await client.commitTurn(turn);
    assert.equal(receipt.kind, "submitted");
  }

  const ctx = await client.buildContext(character_id, "character", undefined, 2000);
  assert.equal(ctx.recent.length, 6);
  assert.ok(ctx.recent.some((l) => l.text.includes(MARKER)), "recent should contain marker");
  assert.ok(ctx.facts.some((f) => f.includes(MARKER)), "facts should contain marker");
  assert.match(ctx.persona, /香蕉/);

  const facts = await client.queryFacts(character_id, "香蕉");
  assert.ok(facts.length > 0, "queryFacts should return at least one fact");
  assert.ok(facts[0].text.includes(MARKER));
  assert.equal(typeof facts[0].score, "number");

  client.close();
});

test("buildContext requires project_id for project scope", async () => {
  const { character_id, client } = setup("小项", "app-scope.sqlite");
  await assert.rejects(client.buildContext(character_id, "project", undefined, 2000), TypeError);
  client.close();
});
