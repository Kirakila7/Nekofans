'use strict';

/*
 * 服务端 API / 隐私 / 裁决流程集成测试。
 *
 * 重点覆盖需求中的安全红线：
 * - 玩家视图（含 SSE）不出现对手规则原文、猜测原文、女神专属字段；
 * - 只有女神能读双方规则、导出房间记录；
 * - 非法走子、越序、越权、错误阶段全部拒绝；
 * - 女神受控操作（核准/驳回/代走/改棋盘/撤销/结束/猜中判胜）真实改变状态。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../server.js');

const tmpDirs = [];

function makeDataDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nekofans-test-'));
  tmpDirs.push(dir);
  return dir;
}

test.after(() => {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

async function startApp(t, dataDir) {
  const dir = dataDir || makeDataDir();
  const app = createApp({ dataDir: dir, quiet: true });
  const address = await app.listen(0, '127.0.0.1');
  const base = 'http://127.0.0.1:' + address.port;
  if (t) {
    t.after(async () => {
      await app.close();
    });
  }
  return { app, base, dataDir: dir };
}

async function call(base, method, pathname, options = {}) {
  const url = new URL(base + pathname);
  if (options.token) url.searchParams.set('token', options.token);
  const init = { method };
  if (options.body !== undefined) {
    init.headers = { 'Content-Type': 'application/json' };
    init.body = JSON.stringify(options.body);
  }
  const response = await fetch(url, init);
  const text = await response.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  return { status: response.status, json };
}

async function createRoom(base, body = {}) {
  const result = await call(base, 'POST', '/api/rooms', { body });
  assert.equal(result.status, 200);
  const { roomId, links } = result.json;
  const token = (link) => new URL(link).searchParams.get('token');
  return {
    roomId,
    links,
    tokens: {
      white: token(links.white),
      black: token(links.black),
      goddess: token(links.goddess),
    },
  };
}

async function getState(base, room, seat) {
  const token = seat === 'goddess' ? room.tokens.goddess : room.tokens[seat];
  const result = await call(base, 'GET', '/api/rooms/' + room.roomId + '/state', { token });
  assert.equal(result.status, 200, JSON.stringify(result.json));
  return result.json.state;
}

async function submitRules(base, room, whiteRule, blackRule) {
  let result = await call(base, 'POST', '/api/rooms/' + room.roomId + '/rule', {
    token: room.tokens.white,
    body: { text: whiteRule },
  });
  assert.equal(result.status, 200, JSON.stringify(result.json));
  result = await call(base, 'POST', '/api/rooms/' + room.roomId + '/rule', {
    token: room.tokens.black,
    body: { text: blackRule },
  });
  assert.equal(result.status, 200, JSON.stringify(result.json));
}

async function approveRules(base, room) {
  for (const seat of ['white', 'black']) {
    const result = await call(base, 'POST', '/api/rooms/' + room.roomId + '/goddess/rule', {
      token: room.tokens.goddess,
      body: { seat, action: 'approve' },
    });
    assert.equal(result.status, 200, JSON.stringify(result.json));
  }
}

async function startGame(base, room, opts = {}) {
  await submitRules(base, room, opts.whiteRule || '白方测试规则甲', opts.blackRule || '黑方测试规则乙');
  await approveRules(base, room);
  const result = await call(base, 'POST', '/api/rooms/' + room.roomId + '/goddess/start', {
    token: room.tokens.goddess,
    body: {},
  });
  assert.equal(result.status, 200, JSON.stringify(result.json));
  assert.equal(result.json.state.phase, 'playing');
}

async function move(base, room, seat, from, to, promotion, tokenOverride) {
  return call(base, 'POST', '/api/rooms/' + room.roomId + '/move', {
    token: tokenOverride || room.tokens[seat],
    body: { from, to, promotion: promotion || null },
  });
}

test('房间创建：三条链接、状态投影与令牌权限', async (t) => {
  const { base } = await startApp(t);
  const room = await createRoom(base, { guessLimit: 4 });
  assert.match(room.roomId, /^r-[0-9a-f]{8}$/);
  assert.equal(new URL(room.links.white).pathname, '/room/' + room.roomId);
  assert.notEqual(room.tokens.white, room.tokens.black);
  assert.notEqual(room.tokens.goddess, room.tokens.white);

  const whiteState = await getState(base, room, 'white');
  assert.equal(whiteState.role, 'player');
  assert.equal(whiteState.seat, 'white');
  assert.equal(whiteState.phase, 'lobby');
  assert.equal(whiteState.goddess, null);
  assert.equal(whiteState.me.rule.status, 'empty');
  assert.equal(whiteState.me.canSubmitRule, true);
  assert.equal(whiteState.game.turn, 'w');
  assert.equal(whiteState.game.ply, 0);

  const goddessState = await getState(base, room, 'goddess');
  assert.equal(goddessState.role, 'goddess');
  assert.equal(goddessState.goddess.rules.white.status, 'empty');
  assert.ok(goddessState.goddess.links.white.includes(room.tokens.white));

  assert.equal((await call(base, 'GET', '/api/rooms/' + room.roomId + '/state')).status, 401);
  assert.equal(
    (await call(base, 'GET', '/api/rooms/' + room.roomId + '/state', { token: 'deadbeef' })).status,
    401,
  );
  assert.equal(
    (await call(base, 'GET', '/api/rooms/r-00000000/state', { token: room.tokens.white })).status,
    404,
  );
  assert.equal(
    (await call(base, 'POST', '/api/rooms', { body: { guessLimit: 99 } })).status,
    200,
  );
});

test('规则隐私：对手令牌拿不到规则原文、备注、猜测原文与女神字段', async (t) => {
  const { base } = await startApp(t);
  const room = await createRoom(base);
  const secretWhite = '白方秘密规则·不可泄露-WX-7391';
  const secretBlack = '黑方秘密规则·不可泄露-BK-2846';

  let result = await call(base, 'POST', '/api/rooms/' + room.roomId + '/rule', {
    token: room.tokens.white,
    body: { text: secretWhite },
  });
  assert.equal(result.status, 200);
  // 玩家自己的视图可见自己的规则原文
  assert.equal(result.json.state.me.rule.text, secretWhite);

  const blackState = await getState(base, room, 'black');
  assert.equal(blackState.players.white.rule.submitted, true);
  assert.equal(blackState.players.white.rule.status, 'submitted');
  assert.equal(blackState.me.rule.text, null);
  const serialized = JSON.stringify(blackState);
  assert.ok(!serialized.includes(secretWhite), '黑方状态不应包含白方规则原文');
  assert.ok(!serialized.includes('WX-7391'));
  assert.ok(!serialized.includes(room.tokens.white));
  assert.ok(!serialized.includes(room.tokens.goddess));
  assert.equal(blackState.goddess, null);
  assert.equal(blackState.me.guesses.length, 0);

  // 白方提交后，黑方猜测原文也不能出现在白方视图
  await call(base, 'POST', '/api/rooms/' + room.roomId + '/rule', {
    token: room.tokens.black,
    body: { text: secretBlack },
  });
  await approveRules(base, room);
  await call(base, 'POST', '/api/rooms/' + room.roomId + '/goddess/start', {
    token: room.tokens.goddess,
    body: {},
  });
  const secretGuess = '黑方猜测：白方规则是「开源」；猜测原文-5521';
  await call(base, 'POST', '/api/rooms/' + room.roomId + '/guess', {
    token: room.tokens.black,
    body: { text: secretGuess },
  });
  const whiteAfterGuess = await getState(base, room, 'white');
  const whiteSerialized = JSON.stringify(whiteAfterGuess);
  assert.ok(!whiteSerialized.includes(secretGuess));
  assert.ok(!whiteSerialized.includes('5521'));
  assert.equal(whiteAfterGuess.players.black.guess.pending, true);

  // 女神能看到双方规则与全部猜测原文
  const goddessState = await getState(base, room, 'goddess');
  assert.equal(goddessState.goddess.rules.white.text, secretWhite);
  assert.equal(goddessState.goddess.rules.black.text, secretBlack);
  assert.equal(goddessState.goddess.guesses[0].text, secretGuess);

  // 玩家不能调用女神接口或导出
  assert.equal(
    (await call(base, 'POST', '/api/rooms/' + room.roomId + '/goddess/undo', {
      token: room.tokens.white,
      body: {},
    })).status,
    403,
  );
  assert.equal(
    (await call(base, 'GET', '/api/rooms/' + room.roomId + '/export', {
      token: room.tokens.white,
    })).status,
    403,
  );
  const exported = await call(base, 'GET', '/api/rooms/' + room.roomId + '/export', {
    token: room.tokens.goddess,
  });
  assert.equal(exported.status, 200);
  assert.equal(exported.json.room.rules.white.text, secretWhite);
  assert.equal(exported.json.room.tokens, undefined, '导出不应包含令牌');
});

test('规则生命周期：提交、退回修改、生效、开始对局', async (t) => {
  const { base } = await startApp(t);
  const room = await createRoom(base);

  // 未提交规则不能开始
  let result = await call(base, 'POST', '/api/rooms/' + room.roomId + '/goddess/start', {
    token: room.tokens.goddess,
    body: {},
  });
  assert.equal(result.status, 409);
  assert.equal(result.json.code, 'rules_not_ready');

  await submitRules(base, room, '规则A测试', '规则B测试');
  // 重复提交被拒绝
  result = await call(base, 'POST', '/api/rooms/' + room.roomId + '/rule', {
    token: room.tokens.white,
    body: { text: '再提交一次' },
  });
  assert.equal(result.status, 409);
  assert.equal(result.json.code, 'rule_locked');

  // 退回后可以修改再提交
  result = await call(base, 'POST', '/api/rooms/' + room.roomId + '/goddess/rule', {
    token: room.tokens.goddess,
    body: { seat: 'white', action: 'return', note: '请写得更具体' },
  });
  assert.equal(result.status, 200);
  const whiteState = await getState(base, room, 'white');
  assert.equal(whiteState.me.rule.status, 'returned');
  assert.equal(whiteState.me.rule.note, '请写得更具体');
  assert.equal(whiteState.me.canSubmitRule, true);

  result = await call(base, 'POST', '/api/rooms/' + room.roomId + '/rule', {
    token: room.tokens.white,
    body: { text: '规则A测试·第二版' },
  });
  assert.equal(result.status, 200);
  assert.equal(result.json.state.me.rule.status, 'submitted');

  // 女神修正文字（lobby 阶段）
  result = await call(base, 'POST', '/api/rooms/' + room.roomId + '/goddess/rule', {
    token: room.tokens.goddess,
    body: { seat: 'white', action: 'edit', text: '规则A测试·女神修正版' },
  });
  assert.equal(result.status, 200);
  const goddessState = await getState(base, room, 'goddess');
  assert.equal(goddessState.goddess.rules.white.text, '规则A测试·女神修正版');

  await approveRules(base, room);
  const lobbyGoddess = await getState(base, room, 'goddess');
  assert.equal(lobbyGoddess.goddess.rules.white.status, 'active');
  assert.equal(lobbyGoddess.goddess.rules.black.status, 'active');

  result = await call(base, 'POST', '/api/rooms/' + room.roomId + '/goddess/start', {
    token: room.tokens.goddess,
    body: {},
  });
  assert.equal(result.status, 200);
  assert.equal(result.json.state.phase, 'playing');
  assert.equal(result.json.state.game.legalMoves.length, 20);

  // 开始后不能改规则
  result = await call(base, 'POST', '/api/rooms/' + room.roomId + '/rule', {
    token: room.tokens.white,
    body: { text: '开始后改规则' },
  });
  assert.equal(result.status, 409);
});

test('走子：轮次、合法性、逐手审核、驳回与撤回', async (t) => {
  const { base } = await startApp(t);
  const room = await createRoom(base, { reviewMode: true });
  await startGame(base, room);

  // 黑方越序
  let result = await move(base, room, 'black', 'e7', 'e5');
  assert.equal(result.status, 409);
  assert.equal(result.json.code, 'not_your_turn');

  // 白方非法走子
  result = await move(base, room, 'white', 'e2', 'e5');
  assert.equal(result.status, 400);
  assert.equal(result.json.code, 'illegal_move');

  // 正常提交 → 待裁决，棋盘未变化
  result = await move(base, room, 'white', 'e2', 'e4');
  assert.equal(result.status, 200);
  assert.equal(result.json.state.game.turn, 'w');
  assert.equal(result.json.state.game.ply, 0);
  assert.ok(result.json.state.game.pendingMove);
  assert.equal(result.json.state.game.pendingMove.label, 'e2–e4');
  assert.equal(result.json.state.me.canMove, false);

  // 女神驳回
  const pendingId = result.json.state.game.pendingMove.id;
  result = await call(base, 'POST', '/api/rooms/' + room.roomId + '/goddess/review', {
    token: room.tokens.goddess,
    body: { moveId: pendingId, decision: 'reject', note: '这一步需要女神确认规则后再说' },
  });
  assert.equal(result.status, 200);
  assert.equal(result.json.state.game.pendingMove, null);
  assert.equal(result.json.state.game.ply, 0);

  const whiteAfterReject = await getState(base, room, 'white');
  assert.equal(whiteAfterReject.me.lastRejection.reason, '这一步需要女神确认规则后再说');
  assert.equal(whiteAfterReject.me.canMove, true);
  const blackState = await getState(base, room, 'black');
  assert.equal(blackState.me.lastRejection, null);

  // 重新提交并核准
  result = await move(base, room, 'white', 'e2', 'e4');
  const approveId = result.json.state.game.pendingMove.id;
  result = await call(base, 'POST', '/api/rooms/' + room.roomId + '/goddess/review', {
    token: room.tokens.goddess,
    body: { moveId: approveId, decision: 'approve' },
  });
  assert.equal(result.status, 200);
  assert.equal(result.json.state.game.ply, 1);
  assert.equal(result.json.state.game.turn, 'b');
  assert.equal(result.json.state.game.moves[0].label, 'e2–e4');
  assert.equal(result.json.state.game.moves[0].color, 'w');

  // 黑方提交后可以撤回
  result = await move(base, room, 'black', 'e7', 'e5');
  assert.equal(result.status, 200);
  result = await call(base, 'POST', '/api/rooms/' + room.roomId + '/move/cancel', {
    token: room.tokens.black,
    body: {},
  });
  assert.equal(result.status, 200);
  assert.equal(result.json.state.game.pendingMove, null);
  assert.equal(result.json.state.game.ply, 1);

  // 撤回了别人的待裁决走子
  const second = await move(base, room, 'black', 'e7', 'e5');
  assert.equal(second.status, 200);
  result = await call(base, 'POST', '/api/rooms/' + room.roomId + '/move/cancel', {
    token: room.tokens.white,
    body: {},
  });
  assert.equal(result.status, 403);
});

test('快速模式：走子立即生效；将死自动结束且不自动揭晓规则', async (t) => {
  const { base } = await startApp(t);
  const room = await createRoom(base, { reviewMode: false });
  await startGame(base, room, { whiteRule: '白方将死测试规则', blackRule: '黑方将死测试规则' });

  const sequence = [
    ['white', 'f2', 'f3'],
    ['black', 'e7', 'e5'],
    ['white', 'g2', 'g4'],
    ['black', 'd8', 'h4'],
  ];
  for (const [seat, from, to] of sequence) {
    const result = await move(base, room, seat, from, to);
    assert.equal(result.status, 200, JSON.stringify(result.json));
  }
  const blackState = await getState(base, room, 'black');
  assert.equal(blackState.phase, 'finished');
  assert.equal(blackState.game.result.winner, 'black');
  assert.equal(blackState.game.result.reason, 'checkmate');
  assert.equal(blackState.game.checkmate, true);
  assert.equal(blackState.game.moves.length, 4);
  assert.equal(blackState.game.moves[3].label, 'Qd8–h4#');
  assert.equal(blackState.revealed.white, null);
  assert.equal(blackState.revealed.black, null);

  // 终局后不能再走子
  const extra = await move(base, room, 'white', 'a2', 'a3');
  assert.equal(extra.status, 409);

  // 自动终局、规则未揭晓：女神可以撤销上一步，回到对局中
  let result = await call(base, 'POST', '/api/rooms/' + room.roomId + '/goddess/undo', {
    token: room.tokens.goddess,
    body: {},
  });
  assert.equal(result.status, 200);
  assert.equal(result.json.state.phase, 'playing');
  assert.equal(result.json.state.game.result, null);
  assert.equal(result.json.state.game.ply, 3);

  // 再重走将死
  result = await move(base, room, 'black', 'd8', 'h4');
  assert.equal(result.status, 200);
});

test('猜规则：错误消耗次数、正确判胜并自动揭晓双方规则', async (t) => {
  const { base } = await startApp(t);
  const room = await createRoom(base, { reviewMode: false, guessLimit: 2 });
  await startGame(base, room, { whiteRule: '白方隐藏规则-猜谜目标-3344', blackRule: '黑方隐藏规则-守方' });

  // 黑方猜错一次
  let result = await call(base, 'POST', '/api/rooms/' + room.roomId + '/guess', {
    token: room.tokens.black,
    body: { text: '我猜白方规则是随便写写' },
  });
  assert.equal(result.status, 200);
  assert.equal(result.json.state.me.attemptsLeft, 1);
  let goddessState = await getState(base, room, 'goddess');
  let guessId = goddessState.goddess.guesses[0].id;
  result = await call(base, 'POST', '/api/rooms/' + room.roomId + '/goddess/judge-guess', {
    token: room.tokens.goddess,
    body: { guessId, correct: false, note: '不中' },
  });
  assert.equal(result.status, 200);
  const whiteState = await getState(base, room, 'white');
  assert.ok(!JSON.stringify(whiteState).includes('随便写写'));
  assert.equal(whiteState.players.black.guess.used, 1);

  // 黑方猜中
  result = await call(base, 'POST', '/api/rooms/' + room.roomId + '/guess', {
    token: room.tokens.black,
    body: { text: '白方规则是 3344 相关' },
  });
  assert.equal(result.status, 200);
  assert.equal(result.json.state.me.attemptsLeft, 0);
  goddessState = await getState(base, room, 'goddess');
  guessId = goddessState.goddess.guesses.find((item) => item.status === 'pending').id;
  result = await call(base, 'POST', '/api/rooms/' + room.roomId + '/goddess/judge-guess', {
    token: room.tokens.goddess,
    body: { guessId, correct: true, note: '命中' },
  });
  assert.equal(result.status, 200);
  const finalBlack = await getState(base, room, 'black');
  const finalWhite = await getState(base, room, 'white');
  assert.equal(finalBlack.phase, 'finished');
  assert.equal(finalBlack.game.result.winner, 'black');
  assert.equal(finalBlack.game.result.reason, 'guess');
  assert.equal(finalBlack.revealed.white.text, '白方隐藏规则-猜谜目标-3344');
  assert.equal(finalWhite.revealed.black.text, '黑方隐藏规则-守方');
  assert.equal(finalBlack.me.guesses[1].status, 'correct');

  // 终局后不能猜/走
  assert.equal(
    (await call(base, 'POST', '/api/rooms/' + room.roomId + '/guess', {
      token: room.tokens.white,
      body: { text: '终局后猜' },
    })).status,
    409,
  );
  assert.equal((await move(base, room, 'white', 'a2', 'a3')).status, 409);
});

test('猜测次数上限 0 = 不限；错误猜测后仍可继续', async (t) => {
  const { base } = await startApp(t);
  const room = await createRoom(base, { reviewMode: false, guessLimit: 0 });
  await startGame(base, room);
  let result = await call(base, 'POST', '/api/rooms/' + room.roomId + '/guess', {
    token: room.tokens.white,
    body: { text: '猜测一' },
  });
  assert.equal(result.status, 200);
  assert.equal(result.json.state.me.attemptsLeft, null);
  const goddessState = await getState(base, room, 'goddess');
  await call(base, 'POST', '/api/rooms/' + room.roomId + '/goddess/judge-guess', {
    token: room.tokens.goddess,
    body: { guessId: goddessState.goddess.guesses[0].id, correct: false },
  });
  result = await call(base, 'POST', '/api/rooms/' + room.roomId + '/guess', {
    token: room.tokens.white,
    body: { text: '猜测二' },
  });
  assert.equal(result.status, 200);
  assert.equal(result.json.state.me.attemptsLeft, null);
});

test('女神受控操作：代走、棋盘修改、撤销、暂停、结束、重开', async (t) => {
  const { base } = await startApp(t);
  const room = await createRoom(base, { reviewMode: false });
  await startGame(base, room);

  // 代走一步（白方）
  let result = await call(base, 'POST', '/api/rooms/' + room.roomId + '/goddess/force-move', {
    token: room.tokens.goddess,
    body: { from: 'e2', to: 'e4', note: '女神代走' },
  });
  assert.equal(result.status, 200);
  assert.equal(result.json.state.game.moves[0].by, 'goddess');
  assert.equal(result.json.state.game.turn, 'b');

  // 移除 e5 上的黑兵（需要先放一个？黑兵本来在 e7，先移除 e7）
  result = await call(base, 'POST', '/api/rooms/' + room.roomId + '/goddess/edit-board', {
    token: room.tokens.goddess,
    body: { op: 'remove', square: 'e7', note: '抹除测试' },
  });
  assert.equal(result.status, 200);
  let state = await getState(base, room, 'goddess');
  assert.equal(state.game.fen.split(' ')[0].split('/')[1], 'pppp1ppp', 'e7 黑兵应已移除');
  assert.equal(state.game.lastEdit.syntax, '移除 e7 上的黑兵');

  // 撤销棋盘修改
  result = await call(base, 'POST', '/api/rooms/' + room.roomId + '/goddess/undo', {
    token: room.tokens.goddess,
    body: {},
  });
  assert.equal(result.status, 200);
  state = await getState(base, room, 'goddess');
  assert.equal(state.game.lastEdit, null);
  assert.equal(state.game.ply, 1);

  // 移除王被拒绝
  result = await call(base, 'POST', '/api/rooms/' + room.roomId + '/goddess/edit-board', {
    token: room.tokens.goddess,
    body: { op: 'remove', square: 'e8' },
  });
  assert.equal(result.status, 409);
  assert.equal(result.json.code, 'cannot_remove_king');

  // 放置棋子
  result = await call(base, 'POST', '/api/rooms/' + room.roomId + '/goddess/edit-board', {
    token: room.tokens.goddess,
    body: { op: 'place', square: 'e6', type: 'r', color: 'b' },
  });
  assert.equal(result.status, 200);

  // 设置行棋方
  result = await call(base, 'POST', '/api/rooms/' + room.roomId + '/goddess/edit-board', {
    token: room.tokens.goddess,
    body: { op: 'setTurn', turn: 'w' },
  });
  assert.equal(result.status, 200);
  state = await getState(base, room, 'goddess');
  assert.equal(state.game.turn, 'w');

  // 暂停后不能走子/猜测
  result = await call(base, 'POST', '/api/rooms/' + room.roomId + '/goddess/pause', {
    token: room.tokens.goddess,
    body: { paused: true },
  });
  assert.equal(result.status, 200);
  assert.equal((await move(base, room, 'white', 'd2', 'd4')).status, 409);
  assert.equal(
    (await call(base, 'POST', '/api/rooms/' + room.roomId + '/guess', {
      token: room.tokens.white,
      body: { text: '暂停时猜' },
    })).status,
    409,
  );
  await call(base, 'POST', '/api/rooms/' + room.roomId + '/goddess/pause', {
    token: room.tokens.goddess,
    body: { paused: false },
  });

  // 结束对局（黑方胜）
  result = await call(base, 'POST', '/api/rooms/' + room.roomId + '/goddess/end', {
    token: room.tokens.goddess,
    body: { winner: 'black', reason: 'goddess', note: '测试结束' },
  });
  assert.equal(result.status, 200);
  assert.equal(result.json.state.phase, 'finished');
  assert.equal(result.json.state.game.result.winner, 'black');

  // 重开
  result = await call(base, 'POST', '/api/rooms/' + room.roomId + '/goddess/reset', {
    token: room.tokens.goddess,
    body: {},
  });
  assert.equal(result.status, 200);
  assert.equal(result.json.state.phase, 'lobby');
  assert.equal(result.json.state.game.ply, 0);
  assert.equal(result.json.state.game.fen, 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1');
  const whiteReset = await getState(base, room, 'white');
  assert.equal(whiteReset.me.rule.status, 'empty');
  assert.equal(whiteReset.me.canSubmitRule, true);
});

test('女神控制台设置、公告与揭晓', async (t) => {
  const { base } = await startApp(t);
  const room = await createRoom(base, { reviewMode: false, guessLimit: 3 });
  await startGame(base, room, { whiteRule: '白方揭晓目标规则-771', blackRule: '黑方揭晓目标规则-882' });

  let result = await call(base, 'POST', '/api/rooms/' + room.roomId + '/goddess/settings', {
    token: room.tokens.goddess,
    body: { reviewMode: true, guessLimit: 1 },
  });
  assert.equal(result.status, 200);
  assert.equal(result.json.state.goddess.settings.reviewMode, true);
  assert.equal(result.json.state.goddess.settings.guessLimit, 1);

  result = await call(base, 'POST', '/api/rooms/' + room.roomId + '/goddess/announce', {
    token: room.tokens.goddess,
    body: { text: '女神公告：请双方确认棋盘。' },
  });
  assert.equal(result.status, 200);
  const whiteState = await getState(base, room, 'white');
  assert.equal(whiteState.announcements.at(-1).text, '女神公告：请双方确认棋盘。');

  // 揭晓白方规则，双方都能看到白方原文，但黑方仍隐藏
  result = await call(base, 'POST', '/api/rooms/' + room.roomId + '/goddess/rule', {
    token: room.tokens.goddess,
    body: { seat: 'white', action: 'reveal' },
  });
  assert.equal(result.status, 200);
  const blackState = await getState(base, room, 'black');
  assert.equal(blackState.revealed.white.text, '白方揭晓目标规则-771');
  assert.equal(blackState.revealed.black, null);
  const whiteAfterReveal = await getState(base, room, 'white');
  assert.equal(whiteAfterReveal.revealed.white.text, '白方揭晓目标规则-771');
  assert.ok(
    !JSON.stringify(whiteAfterReveal).includes('黑方揭晓目标规则-882'),
    '黑方规则尚未揭晓，白方视图不能出现',
  );
});

test('SSE：按席位推送、可继续收到后续变更', async (t) => {
  const { base } = await startApp(t);
  const room = await createRoom(base);
  const controller = new AbortController();
  t.after(() => controller.abort());

  const response = await fetch(
    base + '/api/rooms/' + room.roomId + '/stream?token=' + room.tokens.black,
    { signal: controller.signal },
  );
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/event-stream/);

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  async function nextState(predicate, timeoutMs = 4000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      while (true) {
        const boundary = buffer.indexOf('\n\n');
        if (boundary < 0) break;
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        if (!frame.startsWith('event: state')) continue;
        const dataLine = frame.split('\n').find((line) => line.startsWith('data: '));
        if (!dataLine) continue;
        const state = JSON.parse(dataLine.slice(6));
        if (predicate(state)) return state;
      }
      const { value, done } = await reader.read();
      if (done) throw new Error('SSE 提前结束');
      buffer += decoder.decode(value, { stream: true });
    }
    throw new Error('等待 SSE 状态超时');
  }

  const initial = await nextState((state) => state.version >= 1);
  assert.equal(initial.role, 'player');
  assert.equal(initial.seat, 'black');
  assert.equal(initial.phase, 'lobby');

  // 白方提交规则 → 黑方 SSE 收到新版本，但看不到规则原文
  const secret = '白方 SSE 隐私规则-9911';
  await call(base, 'POST', '/api/rooms/' + room.roomId + '/rule', {
    token: room.tokens.white,
    body: { text: secret },
  });
  const updated = await nextState((state) => state.version > initial.version);
  assert.equal(updated.players.white.rule.status, 'submitted');
  assert.ok(!JSON.stringify(updated).includes(secret));
  assert.ok(!JSON.stringify(updated).includes('9911'));

  controller.abort();
  reader.cancel().catch(() => {});
});

test('本地持久化：重启服务后房间、规则、走子记录仍在', async (t) => {
  const dataDir = makeDataDir();
  const first = await startApp(t, dataDir);
  const room = await createRoom(first.base, { reviewMode: false });
  await startGame(first.base, room, { whiteRule: '持久化测试规则-白', blackRule: '持久化测试规则-黑' });
  const moved = await move(first.base, room, 'white', 'e2', 'e4');
  assert.equal(moved.status, 200);
  await first.app.close();

  const second = createApp({ dataDir, quiet: true });
  const address = await second.listen(0, '127.0.0.1');
  t.after(async () => {
    await second.close();
  });
  const base = 'http://127.0.0.1:' + address.port;
  const state = await getState(base, room, 'white');
  assert.equal(state.phase, 'playing');
  assert.equal(state.game.ply, 1);
  assert.equal(state.me.rule.text, '持久化测试规则-白');
  assert.equal(state.game.moves[0].label, 'e2–e4');
});
