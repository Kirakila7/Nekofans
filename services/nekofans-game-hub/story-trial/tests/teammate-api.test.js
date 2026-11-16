'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../server.js');
const { createTeammateAdapter } = require('../lib/teammate-adapter.js');

const tmpDirs = [];
function makeDataDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'teammate-api-'));
  tmpDirs.push(dir);
  return dir;
}
test.after(() => { for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true }); });

async function startApp(t, options = {}) {
  const app = createApp({ dataDir: makeDataDir(), quiet: true, ...options });
  const address = await app.listen(0, '127.0.0.1');
  const base = 'http://127.0.0.1:' + address.port;
  t.after(async () => { await app.close(); });
  return { app, base };
}

async function call(base, method, pathname, options = {}) {
  const url = new URL(base + pathname);
  if (options.token) url.searchParams.set('token', options.token);
  const response = await fetch(url, {
    method,
    headers: options.body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  let json; try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { status: response.status, json, text };
}

async function createStoryRoom(base, options = {}) {
  const data = await call(base, 'POST', '/api/rooms', {
    body: { scenario: 'story-v1', reviewMode: false, guessLimit: 3, ...options },
  });
  assert.equal(data.status, 200, JSON.stringify(data.json));
  const token = (link) => new URL(link).searchParams.get('token');
  return {
    roomId: data.json.roomId,
    links: data.json.links,
    tokens: { white: token(data.json.links.white), black: token(data.json.links.black), goddess: token(data.json.links.goddess) },
  };
}

async function state(base, room, seat) {
  const data = await call(base, 'GET', `/api/rooms/${room.roomId}/state`, { token: room.tokens[seat] });
  assert.equal(data.status, 200, JSON.stringify(data.json));
  return data.json.state;
}
async function posted(base, room, seat, action, body = {}) {
  return call(base, 'POST', `/api/rooms/${room.roomId}/${action}`, { token: room.tokens[seat], body });
}
async function startStory(base, room, aRule = 'A-RULE-ONLY-OPEN', bRule = 'B-RULE-ONLY-PRIVATE') {
  assert.equal((await posted(base, room, 'white', 'rule', { text: aRule })).status, 200);
  assert.equal((await posted(base, room, 'black', 'rule', { text: bRule })).status, 200);
  assert.equal((await posted(base, room, 'goddess', 'goddess/rule', { seat: 'white', action: 'approve' })).status, 200);
  assert.equal((await posted(base, room, 'goddess', 'goddess/rule', { seat: 'black', action: 'approve' })).status, 200);
  assert.equal((await posted(base, room, 'goddess', 'goddess/start', {})).status, 200);
}
async function decide(base, room, token = room.tokens.white, body = {}) {
  return call(base, 'POST', `/api/rooms/${room.roomId}/teammate/decide`, { token, body });
}
async function move(base, room, seat, from, to) { return posted(base, room, seat, 'move', { from, to }); }
async function erase(base, room, target, name) { return posted(base, room, 'black', 'extra', { target, name }); }
async function setField(base, room, square, name) { return posted(base, room, 'goddess', 'goddess/private-field', { square, name }); }

function firstNormal(context) {
  return { kind: 'move', actionId: context.actions.normal[0].id };
}

test('受控决策：仅 A 可触发；严格白名单上下文；合法走子应用', async (t) => {
  let captured = null;
  const adapter = createTeammateAdapter({
    mode: 'synthetic',
    decision: ({ context }) => { captured = context; return firstNormal(context); },
  });
  const { base } = await startApp(t, { teammateAdapter: adapter });
  const room = await createStoryRoom(base);
  await startStory(base, room, 'A-ONLY-RULE-TEXT', 'B-ONLY-RULE-TEXT');
  const before = await state(base, room, 'white');
  assert.equal(before.me.teammate.available, true);
  assert.match(before.me.teammate.label, /合成适配器/);

  const result = await decide(base, room);
  assert.equal(result.status, 200, JSON.stringify(result.json));
  assert.equal(result.json.decision.kind, 'move');
  assert.equal(result.json.applied, true);
  const after = await state(base, room, 'white');
  assert.equal(after.game.moves.length, 1);
  assert.equal(after.game.turn, 'b');

  // 白名单上下文：本方规则、公开棋盘/历史、合法动作；不含对手规则/令牌/真名/女神字段。
  assert.ok(captured, '适配器应收到上下文');
  const text = JSON.stringify(captured);
  for (const forbidden of ['B-ONLY-RULE-TEXT', '梁文峰', '梁武帝', '小泡泡', room.tokens.white, room.tokens.black, room.tokens.goddess, 'goddess', 'privateAction']) {
    assert.equal(text.includes(forbidden), false, '上下文不应包含 ' + forbidden);
  }
  assert.match(text, /A-ONLY-RULE-TEXT/);
  assert.equal(captured.protocol, 'nekofans.game-player.v1');
  assert.equal(captured.seat, 'white');
  assert.equal(captured.team, 'A');
  assert.equal(captured.actions.normal.length, 20);
  assert.ok(captured.actions.special.length >= 0);
  assert.equal(captured.actions.guess.allowed, true);
});

test('受控决策：B/女神令牌 403；客户端不能注入上下文', async (t) => {
  let calls = 0;
  const adapter = createTeammateAdapter({
    mode: 'synthetic',
    decision: ({ context }) => { calls += 1; return firstNormal(context); },
  });
  const { base } = await startApp(t, { teammateAdapter: adapter });
  const room = await createStoryRoom(base);
  await startStory(base, room);

  const b = await decide(base, room, room.tokens.black);
  assert.equal(b.status, 403);
  const g = await decide(base, room, room.tokens.goddess);
  assert.equal(g.status, 403);
  const injected = await decide(base, room, room.tokens.white, { context: { evil: true } });
  assert.equal(injected.status, 400);
  assert.equal(calls, 0, '越权/注入请求不得调用适配器');
});

test('受控决策：非法 actionId 422，不自动走子；适配器不可用 503', async (t) => {
  const adapter = createTeammateAdapter({
    mode: 'synthetic',
    decision: { kind: 'move', actionId: 'normal:999' },
  });
  const { base } = await startApp(t, { teammateAdapter: adapter });
  const room = await createStoryRoom(base);
  await startStory(base, room);
  const before = await state(base, room, 'white');
  const bad = await decide(base, room);
  assert.equal(bad.status, 422, JSON.stringify(bad.json));
  const after = await state(base, room, 'white');
  assert.equal(after.game.fen, before.game.fen);
  assert.equal(after.game.moves.length, 0);

  const unavailableApp = await startApp(t);
  const unavailableRoom = await createStoryRoom(unavailableApp.base);
  await startStory(unavailableApp.base, unavailableRoom);
  const unavailable = await decide(unavailableApp.base, unavailableRoom);
  assert.equal(unavailable.status, 503);
  assert.equal(unavailable.json.code, 'teammate_unavailable');
});

test('受控决策：超时不走子；过期版本 409 不走子', async (t) => {
  const never = createTeammateAdapter({
    mode: 'synthetic',
    decision: () => new Promise(() => {}),
  });
  const { base } = await startApp(t, { teammateAdapter: never, teammateTimeoutMs: 120 });
  const room = await createStoryRoom(base);
  await startStory(base, room);
  const before = await state(base, room, 'white');
  const timeout = await decide(base, room);
  assert.equal(timeout.status, 504, JSON.stringify(timeout.json));
  const after = await state(base, room, 'white');
  assert.equal(after.game.fen, before.game.fen);
  assert.equal(after.game.moves.length, 0);

  let resolveDecision = null;
  const deferred = createTeammateAdapter({
    mode: 'synthetic',
    decision: () => new Promise((resolve) => { resolveDecision = resolve; }),
  });
  const second = await startApp(t, { teammateAdapter: deferred, teammateTimeoutMs: 5000 });
  const room2 = await createStoryRoom(second.base);
  await startStory(second.base, room2);
  const pending = decide(second.base, room2);
  for (let i = 0; i < 30 && !resolveDecision; i += 1) await new Promise((r) => setTimeout(r, 20));
  assert.ok(resolveDecision, '适配器应开始决策');
  const announce = await posted(second.base, room2, 'goddess', 'goddess/announce', { text: '状态变化' });
  assert.equal(announce.status, 200);
  resolveDecision({ kind: 'move', actionId: 'normal:1' });
  const stale = await pending;
  assert.equal(stale.status, 409, JSON.stringify(stale.json));
  assert.equal(stale.json.code, 'stale_state');
  const after2 = await state(second.base, room2, 'white');
  assert.equal(after2.game.moves.length, 0);
});

test('受控决策：并发锁与每房间调用上限', async (t) => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const adapter = createTeammateAdapter({
    mode: 'synthetic',
    decision: async ({ context }) => {
      await gate;
      if (context.actions.guess.allowed) return { kind: 'guess', text: '先提出一次猜测' };
      return firstNormal(context);
    },
  });
  const { base } = await startApp(t, { teammateAdapter: adapter, maxTeammateCallsPerRoom: 2 });
  const room = await createStoryRoom(base);
  await startStory(base, room);
  const first = decide(base, room);
  await new Promise((r) => setTimeout(r, 80));
  const second = await decide(base, room);
  assert.equal(second.status, 409, JSON.stringify(second.json));
  assert.equal(second.json.code, 'decision_in_progress');
  release();
  const ok = await first;
  assert.equal(ok.status, 200, JSON.stringify(ok.json));

  const third = await decide(base, room);
  assert.equal(third.status, 200, JSON.stringify(third.json));
  const fourth = await decide(base, room);
  assert.equal(fourth.status, 429, JSON.stringify(fourth.json));
  assert.equal(fourth.json.code, 'teammate_call_limit');
});

test('受控决策：合法 guess 由服务端校验次数并进入待裁', async (t) => {
  const adapter = createTeammateAdapter({
    mode: 'synthetic',
    decision: { kind: 'guess', text: '我猜 B 有一条私密规则' },
  });
  const { base } = await startApp(t, { teammateAdapter: adapter });
  const room = await createStoryRoom(base);
  await startStory(base, room);
  const result = await decide(base, room);
  assert.equal(result.status, 200, JSON.stringify(result.json));
  assert.equal(result.json.decision.kind, 'guess');
  const goddess = await state(base, room, 'goddess');
  assert.equal(goddess.goddess.guesses.filter((guess) => guess.status === 'pending').length, 1);
});

test('受控决策：从服务端合法列表选择特殊行动并应用', async (t) => {
  let captured = null;
  const adapter = createTeammateAdapter({
    mode: 'synthetic',
    decision: ({ context }) => {
      captured = context;
      assert.ok(context.actions.special.length > 0, '应有特殊行动');
      return { kind: 'special', actionId: context.actions.special[0].id };
    },
  });
  const { base } = await startApp(t, { teammateAdapter: adapter });
  const room = await createStoryRoom(base);
  await startStory(base, room);
  await move(base, room, 'white', 'e2', 'e4');
  await setField(base, room, 'b1', '私密值');
  await erase(base, room, 'b1', '私密值');
  await move(base, room, 'black', 'e7', 'e5');
  await move(base, room, 'white', 'g1', 'f3');
  await move(base, room, 'black', 'b8', 'c6');
  const result = await decide(base, room);
  assert.equal(result.status, 200, JSON.stringify(result.json));
  assert.equal(result.json.decision.kind, 'special');
  const after = await state(base, room, 'white');
  assert.equal(after.game.moves.at(-1).kind, 'special');
  assert.equal(after.game.story.special.some((item) => item.type === 'n'), true);
  assert.ok(captured.actions.special.some((action) => action.type === 'n'));
});

test('真实本地 HTTP 适配器：受控决策走本地 bridge，不访问外网', async (t) => {
  let received = null;
  const bridge = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      const payload = JSON.parse(body);
      received = payload;
      const action = payload.context.actions.normal[0];
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ decision: { kind: 'move', actionId: action.id } }));
    });
  });
  await new Promise((resolve) => bridge.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => bridge.close(resolve)));
  const endpoint = 'http://127.0.0.1:' + bridge.address().port + '/decide';
  const adapter = createTeammateAdapter({
    mode: 'http',
    endpoint,
    accountConnected: true,
    timeoutMs: 1000,
  });
  const { base } = await startApp(t, { teammateAdapter: adapter });
  const room = await createStoryRoom(base);
  await startStory(base, room);
  const result = await decide(base, room);
  assert.equal(result.status, 200, JSON.stringify(result.json));
  assert.ok(received);
  assert.equal(received.purpose, 'game-player');
  assert.equal(received.protocol, 'nekofans.model-adapter.v1');
  assert.ok(received.context.actions.normal.length > 0);
  const contextText = JSON.stringify(received.context);
  assert.equal(contextText.includes('B-RULE-ONLY-PRIVATE'), false);
  assert.equal(contextText.includes(room.tokens.white), false);
  const after = await state(base, room, 'white');
  assert.equal(after.game.moves.length, 1);
});
