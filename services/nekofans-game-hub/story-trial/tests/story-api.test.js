'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../server.js');
const Chess = require('../lib/chess.js');

const tmpDirs = [];

function makeDataDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'story-api-'));
  tmpDirs.push(dir);
  return dir;
}

test.after(() => {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

async function startApp(t, dataDir) {
  const app = createApp({ dataDir: dataDir || makeDataDir(), quiet: true });
  const address = await app.listen(0, '127.0.0.1');
  const base = 'http://127.0.0.1:' + address.port;
  if (t) {
    t.after(async () => {
      await app.close();
    });
  }
  return { app, base, dataDir: dataDir || null };
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
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { status: response.status, json, text, headers: response.headers };
}

async function createStoryRoom(base, options = {}) {
  const result = await call(base, 'POST', '/api/rooms', {
    body: { scenario: 'story-v1', reviewMode: false, guessLimit: 3, ...options },
  });
  assert.equal(result.status, 200, JSON.stringify(result.json));
  const token = (link) => new URL(link).searchParams.get('token');
  return {
    roomId: result.json.roomId,
    tokens: {
      white: token(result.json.links.white),
      black: token(result.json.links.black),
      goddess: token(result.json.links.goddess),
    },
    links: result.json.links,
  };
}

async function state(base, room, seat) {
  const token = seat === 'goddess' ? room.tokens.goddess : room.tokens[seat];
  const result = await call(base, 'GET', `/api/rooms/${room.roomId}/state`, { token });
  assert.equal(result.status, 200, JSON.stringify(result.json));
  return result.json.state;
}

async function posted(base, room, seat, pathname, body) {
  return call(base, 'POST', `/api/rooms/${room.roomId}/${pathname}`, { token: room.tokens[seat], body: body || {} });
}

async function submitAndStart(base, room, whiteRule = 'A-SECRET-RULE-开源-不可泄露', blackRule = 'B-SECRET-RULE-抹除-不可泄露') {
  assert.equal((await posted(base, room, 'white', 'rule', { text: whiteRule })).status, 200);
  assert.equal((await posted(base, room, 'black', 'rule', { text: blackRule })).status, 200);
  assert.equal((await posted(base, room, 'goddess', 'goddess/rule', { seat: 'white', action: 'approve' })).status, 200);
  assert.equal((await posted(base, room, 'goddess', 'goddess/rule', { seat: 'black', action: 'approve' })).status, 200);
  assert.equal((await posted(base, room, 'goddess', 'goddess/start', {})).status, 200);
}

async function move(base, room, seat, from, to) {
  return posted(base, room, seat, 'move', { from, to });
}

async function usePool(base, room, seat, type, from, to) {
  return posted(base, room, seat, 'special', { type, from, to });
}

async function erase(base, room, target, name) {
  return posted(base, room, 'black', 'extra', { target, name });
}

async function setGoddessName(base, room, square, name) {
  return posted(base, room, 'goddess', 'goddess/private-field', { square, name });
}

test('剧情房间：场景加载、公开投影、真名与规则隔离', async (t) => {
  const { base } = await startApp(t);
  const room = await createStoryRoom(base);
  const white = await state(base, room, 'white');
  const black = await state(base, room, 'black');
  const goddess = await state(base, room, 'goddess');

  assert.equal(white.game.story.enabled, true);
  assert.deepEqual(white.game.story.special, []);
  assert.match(white.me.story.abilityLabel, /开源/);
  assert.match(black.me.story.abilityLabel, /抹除/);
  assert.equal('privateAction' in white.me.story, false);
  assert.ok(black.me.story.privateAction && black.me.story.privateAction.endpoint);
  assert.ok(!JSON.stringify(white).includes('抹除'), 'A 端不能下载 B 的能力文本');
  assert.ok(!JSON.stringify(black).includes('开源'), 'B 端不能下载 A 的能力文本');
  assert.equal(goddess.goddess.story.abilityText.white.label.includes('开源'), true);
  assert.equal(goddess.goddess.story.abilityText.black.label.includes('抹除'), true);
  assert.equal(white.me.teammate.available, false);
  assert.equal(white.me.teammate.mode, 'unavailable');
  assert.match(white.me.teammate.label, /未接入真实模型/);
  assert.equal(black.me.teammate.label, '对方由人操作');
  assert.equal(goddess.goddess.adapter.purpose, 'game-goddess');
  assert.equal(goddess.goddess.adapter.available, false);
  assert.equal(JSON.stringify(white).includes('game-goddess'), false);
  assert.equal(JSON.stringify(black).includes('game-goddess'), false);
  assert.equal(goddess.goddess.story.names.find((piece) => piece.square === 'e1').trueName, '梁文峰');
  assert.equal(goddess.goddess.story.names.find((piece) => piece.square === 'e1').alias, '梁武帝');

  for (const snapshot of [white, black]) {
    const text = JSON.stringify(snapshot);
    assert.ok(!text.includes('梁文峰'), '玩家投影不得包含真名');
    assert.ok(!text.includes('梁武帝'), '玩家投影不得包含公开误称映射');
    assert.ok(!text.includes('A-SECRET-RULE'), '玩家投影不得包含规则');
    assert.equal(snapshot.goddess, null);
  }

  const teammate = await call(base, 'GET', `/api/rooms/${room.roomId}/teammate/view`, { token: room.tokens.white });
  assert.equal(teammate.status, 200, JSON.stringify(teammate.json));
  assert.ok(teammate.json.view.own.rule.text === null);
  assert.equal(teammate.json.view.own.teammate.available, false);
  assert.match(teammate.json.view.own.teammate.label, /未接入真实模型/);
  assert.ok(!JSON.stringify(teammate.json.view).includes('梁文峰'));
  assert.ok(!JSON.stringify(teammate.json.view).includes('梁武帝'));
  const bTeammate = await call(base, 'GET', `/api/rooms/${room.roomId}/teammate/view`, { token: room.tokens.black });
  assert.equal(bTeammate.status, 403);

  const configFetch = await call(base, 'GET', '/config/story-scenario.json');
  assert.notEqual(configFetch.status, 200, '场景配置不得作为静态资源暴露');
});

test('真名抹除：错误名字失败且不代替走子；正确名字才移除；每回合一次', async (t) => {
  const { base } = await startApp(t);
  const room = await createStoryRoom(base);
  await submitAndStart(base, room);

  assert.equal((await move(base, room, 'white', 'e2', 'e4')).status, 200);
  let black = await state(base, room, 'black');
  assert.equal(black.game.turn, 'b');
  assert.equal(black.me.story.privateAction.canUse, true);

  const beforeFen = black.game.fen;
  const failed = await erase(base, room, 'e1', '梁武帝');
  assert.equal(failed.status, 200, JSON.stringify(failed.json));
  assert.equal(failed.json.result, 'failed');
  black = await state(base, room, 'black');
  assert.equal(black.game.fen, beforeFen, '错误名字不得改变棋盘');
  assert.equal(black.game.turn, 'b', '抹除失败/成功都不代替正常走子');
  assert.equal(black.me.story.privateAction.used, true);
  assert.equal(black.me.story.privateAction.attempts.length, 1);
  assert.equal(black.me.story.privateAction.attempts[0].name, '梁武帝');

  const white = await state(base, room, 'white');
  assert.equal('privateAction' in white.me.story, false);
  assert.ok(!JSON.stringify(white).includes('梁武帝'));
  assert.equal(white.game.story.events.length, 0, '失败的抹除不应产生公开事件');
  assert.equal(white.game.turn, 'b');

  const second = await erase(base, room, 'e1', '梁文峰');
  assert.equal(second.status, 409);
  assert.equal(second.json.code, 'erase_already_used');

  // 仍可以正常走子
  assert.equal((await move(base, room, 'black', 'e7', 'e5')).status, 200);
  assert.equal((await move(base, room, 'white', 'g1', 'f3')).status, 200);

  await setGoddessName(base, room, 'b1', '小泡泡');
  const success = await erase(base, room, 'b1', '小泡泡');
  assert.equal(success.status, 200, JSON.stringify(success.json));
  assert.equal(success.json.result, 'success');
  black = await state(base, room, 'black');
  assert.equal(black.game.turn, 'b');
  assert.equal(Chess.parseFen(black.game.fen).board[Chess.squareIndex('b1')], null, 'b1 的马应被移除');
  assert.deepEqual(black.game.story.special.map((item) => item.type), ['n']);
  assert.equal(black.game.story.events.some((event) => event.kind === 'board-change' && event.square === 'b1'), true);
  assert.equal(black.me.story.privateAction.attempts.some((attempt) => attempt.name === '小泡泡'), true);
  assert.ok(!JSON.stringify(black.game.story).includes('抹除'));
  assert.ok(!JSON.stringify(black.game.story).includes('真名'));
  assert.ok(!JSON.stringify(black.game.story).includes('erase'));

  const whiteAfter = await state(base, room, 'white');
  assert.ok(!JSON.stringify(whiteAfter).includes('小泡泡'));
  assert.ok(!JSON.stringify(whiteAfter).includes('梁文峰'));

  assert.equal((await move(base, room, 'black', 'b8', 'c6')).status, 200);
  assert.equal((await state(base, room, 'white')).game.turn, 'w');
});

test('共享走法：双方可用、占用普通走子、非法动作与池外动作被拒', async (t) => {
  const { base } = await startApp(t);
  const room = await createStoryRoom(base);
  await submitAndStart(base, room);

  await move(base, room, 'white', 'e2', 'e4');
  await erase(base, room, 'e1', '梁武帝');
  await move(base, room, 'black', 'e7', 'e5');
  await move(base, room, 'white', 'g1', 'f3');
  await setGoddessName(base, room, 'b1', '小泡泡');
  await erase(base, room, 'b1', '小泡泡');
  await move(base, room, 'black', 'b8', 'c6');

  let white = await state(base, room, 'white');
  assert.deepEqual(white.game.story.special.map((item) => item.type), ['n']);
  assert.equal(white.me.story.specialActions.length > 0, true);
  assert.equal(white.me.story.specialActions.every((action) => !JSON.stringify(action).includes('小泡泡')), true);

  const poolUse = await usePool(base, room, 'white', 'n', 'a1', 'b3');
  assert.equal(poolUse.status, 200, JSON.stringify(poolUse.json));
  const after = await state(base, room, 'white');
  assert.equal(after.game.turn, 'b');
  assert.equal(after.game.moves.at(-1).kind, 'special');
  assert.equal(after.game.moves.at(-1).patternType, null);
  assert.ok(after.game.moves.at(-1).label.includes('特殊走法'));
  assert.ok(!JSON.stringify(after.game.moves.at(-1)).includes('共享'));
  assert.equal(after.game.story.special.length, 1, '使用公开走法不应消耗池条目');

  const bPool = await usePool(base, room, 'black', 'n', 'h8', 'g6');
  assert.equal(bPool.status, 200, JSON.stringify(bPool.json));
  assert.equal((await state(base, room, 'black')).game.turn, 'w');

  const badPattern = await usePool(base, room, 'white', 'b', 'a1', 'b2');
  assert.equal(badPattern.status, 409);
  assert.equal(badPattern.json.code, 'pattern_not_available');

  const badGeometry = await usePool(base, room, 'white', 'n', 'b3', 'b4');
  assert.equal(badGeometry.status, 400);
  assert.equal(badGeometry.json.code, 'illegal_pattern_move');

  assert.equal((await usePool(base, room, 'black', 'n', 'a8', 'b6')).status, 409, '未轮到 B');
  const aErase = await posted(base, room, 'white', 'extra', { target: 'd1', name: '随便' });
  assert.equal(aErase.status, 403, 'A 没有抹除能力');
});

test('真名梁文峰抹除国王：B 获胜且不泄露真名；女神可撤销', async (t) => {
  const { base } = await startApp(t);
  const room = await createStoryRoom(base);
  await submitAndStart(base, room);

  await move(base, room, 'white', 'e2', 'e4');
  const fail = await erase(base, room, 'e1', '梁武帝');
  assert.equal(fail.json.result, 'failed');
  await move(base, room, 'black', 'e7', 'e5');
  await move(base, room, 'white', 'a2', 'a3');

  const success = await erase(base, room, 'e1', '梁文峰');
  assert.equal(success.status, 200, JSON.stringify(success.json));
  assert.equal(success.json.result, 'success');
  let white = await state(base, room, 'white');
  assert.equal(white.phase, 'finished');
  assert.equal(white.game.result.winner, 'black');
  assert.equal(white.game.result.reason, 'special');
  assert.equal(white.game.result.note, null);
  assert.ok(!JSON.stringify(white).includes('梁文峰'));
  assert.ok(!JSON.stringify(white).includes('梁武帝'));

  const goddess = await state(base, room, 'goddess');
  assert.equal(goddess.game.result.reason, 'erase-king');
  assert.equal(goddess.goddess.story.attempts.some((attempt) => attempt.success && attempt.targetSquare === 'e1'), true);

  const undo = await postPostedGoddess(base, room, 'goddess/undo', {});
  assert.equal(undo.status, 200, JSON.stringify(undo.json));
  white = await state(base, room, 'white');
  assert.equal(white.phase, 'playing');
  assert.equal(white.game.result, null);
  assert.ok(white.game.fen.includes('K'), '撤销后白王应回到棋盘');
});

async function postPostedGoddess(base, room, pathname, body) {
  return posted(base, room, 'goddess', pathname, body);
}

test('A 队友视图与大肥鱼猜测：只含本方规则与脱敏公共状态；猜中判胜', async (t) => {
  const { base } = await startApp(t);
  const room = await createStoryRoom(base);
  await submitAndStart(base, room, 'A-队友可见规则-OPEN-1', 'B-不可见规则-ERASE-2');

  const view = await call(base, 'GET', `/api/rooms/${room.roomId}/teammate/view`, { token: room.tokens.white });
  assert.equal(view.status, 200);
  const payload = view.json.view;
  assert.equal(payload.own.rule.text, 'A-队友可见规则-OPEN-1');
  assert.ok(JSON.stringify(payload).includes('A-队友可见规则-OPEN-1'));
  assert.ok(!JSON.stringify(payload).includes('B-不可见规则-ERASE-2'));
  assert.ok(!JSON.stringify(payload).includes('梁文峰'));
  assert.ok(!JSON.stringify(payload).includes('梁武帝'));
  assert.equal(payload.own.standardMoves.length, 20);
  assert.equal(payload.public.story.enabled, true);
  assert.equal(payload.public.story.events.some((event) => event.kind === 'erase-attempt'), false);

  const guess = await call(base, 'POST', `/api/rooms/${room.roomId}/teammate/guess`, {
    token: room.tokens.white,
    body: { text: '我猜 B 能抹除知道真名的棋子' },
  });
  assert.equal(guess.status, 200, JSON.stringify(guess.json));
  const goddess = await state(base, room, 'goddess');
  const guessId = goddess.goddess.guesses.find((item) => item.status === 'pending').id;
  const judge = await posted(base, room, 'goddess', 'goddess/judge-guess', { guessId, correct: true });
  assert.equal(judge.status, 200);
  const final = await state(base, room, 'white');
  assert.equal(final.phase, 'finished');
  assert.equal(final.game.result.winner, 'white');
  assert.equal(final.game.result.reason, 'guess');
  assert.equal(final.revealed.black.text, 'B-不可见规则-ERASE-2');
  assert.ok(!JSON.stringify(final).includes('梁文峰'));
});

test('普通吃子也会把退场棋子的原始走法加入共享池', async (t) => {
  const { base } = await startApp(t);
  const room = await createStoryRoom(base);
  await submitAndStart(base, room);
  await move(base, room, 'white', 'e2', 'e4');
  await move(base, room, 'black', 'd7', 'd5');
  const capture = await posted(base, room, 'white', 'move', { from: 'e4', to: 'd5' });
  assert.equal(capture.status, 200, JSON.stringify(capture.json));
  const stateWhite = await state(base, room, 'white');
  assert.deepEqual(stateWhite.game.story.special.map((item) => item.type), ['p']);
  assert.equal(stateWhite.game.story.events.some((event) => event.kind === 'board-change' && event.square === 'd5'), true);
  assert.equal(stateWhite.game.turn, 'b');
});

test('真名跟随国王移动：改名后的位置仍可被正确真名抹除', async (t) => {
  const { base } = await startApp(t);
  const room = await createStoryRoom(base);
  await submitAndStart(base, room);
  await move(base, room, 'white', 'e2', 'e4');
  await move(base, room, 'black', 'e7', 'e5');
  const kingMove = await move(base, room, 'white', 'e1', 'e2');
  assert.equal(kingMove.status, 200, JSON.stringify(kingMove.json));
  const goddess = await state(base, room, 'goddess');
  assert.equal(goddess.goddess.story.names.find((piece) => piece.square === 'e2').trueName, '梁文峰');
  assert.equal(goddess.goddess.story.names.find((piece) => piece.square === 'e1'), undefined);

  const wrong = await erase(base, room, 'e2', '梁武帝');
  assert.equal(wrong.json.result, 'failed');
  // 错误尝试不代替走子：黑方仍需正常走一步，下一回合再试
  assert.equal((await move(base, room, 'black', 'g8', 'f6')).status, 200);
  assert.equal((await move(base, room, 'white', 'a2', 'a3')).status, 200);
  const success = await erase(base, room, 'e2', '梁文峰');
  assert.equal(success.json.result, 'success');
  const final = await state(base, room, 'white');
  assert.equal(final.phase, 'finished');
  assert.equal(final.game.result.winner, 'black');
  assert.equal(final.game.result.reason, 'special');
});

test('未知剧情场景被拒绝；基础房间不会意外启用剧情接口', async (t) => {
  const { base } = await startApp(t);
  const bad = await call(base, 'POST', '/api/rooms', { body: { scenario: 'no-such-story' } });
  assert.equal(bad.status, 400);
  assert.equal(bad.json.code, 'bad_scenario');

  const baseRoom = await call(base, 'POST', '/api/rooms', { body: { reviewMode: false } });
  assert.equal(baseRoom.status, 200);
  const token = (link) => new URL(link).searchParams.get('token');
  const baseTokens = {
    white: token(baseRoom.json.links.white),
    black: token(baseRoom.json.links.black),
    goddess: token(baseRoom.json.links.goddess),
  };
  const baseRoomId = baseRoom.json.roomId;
  const pool = await call(base, 'POST', `/api/rooms/${baseRoomId}/special`, {
    token: baseTokens.white,
    body: { type: 'n', from: 'a1', to: 'b3' },
  });
  assert.equal(pool.status, 409);
  assert.equal(pool.json.code, 'story_unavailable');
  const eraseAttempt = await call(base, 'POST', `/api/rooms/${baseRoomId}/extra`, {
    token: baseTokens.black,
    body: { target: 'e1', name: '随便' },
  });
  assert.equal(eraseAttempt.status, 409);
  assert.equal(eraseAttempt.json.code, 'story_unavailable');
  const teammate = await call(base, 'GET', `/api/rooms/${baseRoomId}/teammate/view`, { token: baseTokens.white });
  assert.equal(teammate.status, 200);
  assert.equal(teammate.json.view.public.story, null);
});

test('HTTP 公共静态资源不包含秘密能力文本/真名线索', async (t) => {
  const { base } = await startApp(t);
  const forbidden = ['真名', '抹除', '开源', '共享走法', 'pool', 'erase', 'open-source', 'erase-note', 'erase-king', 'erase-attempt', '梁文峰', '梁武帝', '小泡泡'];
  for (const pathname of ['/', '/room/test-room', '/app.js', '/landing.js', '/styles.css']) {
    const response = await fetch(base + pathname);
    assert.equal(response.status, 200, pathname);
    const text = await response.text();
    for (const bad of forbidden) assert.equal(text.includes(bad), false, pathname + ' 不应包含 ' + bad);
  }
});

test('A/大肥鱼公共接口不命名对方能力；B 与女神保留私密详情', async (t) => {
  const { base } = await startApp(t);
  const room = await createStoryRoom(base);
  await submitAndStart(base, room);
  await move(base, room, 'white', 'e2', 'e4');
  await move(base, room, 'black', 'e7', 'e5');
  await move(base, room, 'white', 'g1', 'f3');
  await setGoddessName(base, room, 'b1', '小泡泡');
  await erase(base, room, 'b1', '小泡泡');
  await move(base, room, 'black', 'b8', 'c6');
  await usePool(base, room, 'white', 'n', 'a1', 'b3');
  await usePool(base, room, 'black', 'n', 'h8', 'g6');

  const white = await state(base, room, 'white');
  const teammate = await call(base, 'GET', `/api/rooms/${room.roomId}/teammate/view`, { token: room.tokens.white });
  const black = await state(base, room, 'black');
  const goddess = await state(base, room, 'goddess');
  const forbidden = ['抹除', '真名', 'erase', 'erase-king', 'erase-attempt', 'pool-use', '共享走法', 'erase-note'];
  const assertClean = (label, value) => {
    const text = JSON.stringify(value);
    for (const bad of forbidden) assert.ok(!text.includes(bad), label + ' 不应包含 ' + bad);
  };
  assertClean('A 状态', white);
  assertClean('A 大肥鱼视图', teammate.json.view);
  assert.equal(white.game.story.events.every((event) => event.kind === 'board-change'), true);
  assert.ok(white.game.story.events.some((event) => event.square === 'b1'));
  assert.equal(white.game.moves.every((move) => move.kind !== 'pool'), true);
  assert.equal(white.game.moves.every((move) => !String(move.label).includes('共享')), true);
  assert.ok(!JSON.stringify(white).includes('梁文峰'));
  assert.ok(!JSON.stringify(white).includes('小泡泡'));
  assert.match(JSON.stringify(black), /抹除/, 'B 本人仍能看到自己的私密操作');
  assert.ok(black.me.story.privateAction && black.me.story.privateAction.attempts.length > 0);
  assert.ok(JSON.stringify(black).includes('小泡泡'));
  assert.ok(JSON.stringify(goddess).includes('梁文峰'), '女神仍能看到真名');
  assert.ok(JSON.stringify(goddess).includes('erase-king') === false); // 尚未抹王，只有正常尝试
});

test('抹王终局：玩家/大肥鱼只看到中性 special，女神保留 erase-king 详情', async (t) => {
  const { base } = await startApp(t);
  const room = await createStoryRoom(base);
  await submitAndStart(base, room);
  assert.equal((await move(base, room, 'white', 'e2', 'e4')).status, 200);
  const erased = await erase(base, room, 'e1', '梁文峰');
  assert.equal(erased.status, 200, JSON.stringify(erased.json));

  const white = await state(base, room, 'white');
  const teammate = await call(base, 'GET', `/api/rooms/${room.roomId}/teammate/view`, { token: room.tokens.white });
  const goddess = await state(base, room, 'goddess');
  assert.equal(white.game.result.reason, 'special');
  assert.equal(white.game.result.note, null);
  assert.equal(teammate.json.view.public.result.reason, 'special');
  for (const bad of ['抹除', '真名', 'erase']) assert.ok(!JSON.stringify(white).includes(bad));
  for (const bad of ['抹除', '真名', 'erase']) assert.ok(!JSON.stringify(teammate.json.view).includes(bad));
  assert.equal(goddess.game.result.reason, 'erase-king');
  assert.match(goddess.game.result.note, /真名抹除/);
});

test('A 的 SSE 在大肥鱼/公开走法后不推送对方能力命名', async (t) => {
  const { base } = await startApp(t);
  const room = await createStoryRoom(base);
  await submitAndStart(base, room);
  const controller = new AbortController();
  t.after(() => controller.abort());
  const response = await fetch(
    base + '/api/rooms/' + room.roomId + '/stream?token=' + room.tokens.white,
    { signal: controller.signal },
  );
  assert.equal(response.status, 200);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  async function nextState(predicate, timeoutMs = 5000) {
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
    throw new Error('等待 SSE 超时');
  }
  const initial = await nextState((value) => value.version >= 1);
  await move(base, room, 'white', 'e2', 'e4');
  await move(base, room, 'black', 'e7', 'e5');
  await move(base, room, 'white', 'g1', 'f3');
  await setGoddessName(base, room, 'b1', '小泡泡');
  await erase(base, room, 'b1', '小泡泡');
  await move(base, room, 'black', 'b8', 'c6');
  await usePool(base, room, 'white', 'n', 'a1', 'b3');
  await usePool(base, room, 'black', 'n', 'h8', 'g6');
  const latest = await nextState((value) => value.version > initial.version &&
    value.game.story.events.some((event) => event.kind === 'board-change') &&
    value.game.moves.some((entry) => entry.kind === 'special'));
  const text = JSON.stringify(latest);
  for (const bad of ['抹除', '真名', 'erase', 'erase-king', 'erase-attempt', 'pool-use', '共享走法', 'erase-note']) {
    assert.ok(!text.includes(bad), 'A 的 SSE 不应包含 ' + bad);
  }
  controller.abort();
  reader.cancel().catch(() => {});
});

test('B 的 SSE 不包含 A 的能力文案', async (t) => {
  const { base } = await startApp(t);
  const room = await createStoryRoom(base);
  await submitAndStart(base, room);
  const controller = new AbortController();
  t.after(() => controller.abort());
  const response = await fetch(
    base + '/api/rooms/' + room.roomId + '/stream?token=' + room.tokens.black,
    { signal: controller.signal },
  );
  assert.equal(response.status, 200);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  async function nextState(predicate, timeoutMs = 5000) {
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
    throw new Error('等待 SSE 超时');
  }
  const initial = await nextState((value) => value.version >= 1);
  await move(base, room, 'white', 'e2', 'e4');
  const latest = await nextState((value) => value.version > initial.version);
  const text = JSON.stringify(latest);
  assert.equal(text.includes('开源'), false, 'B 的 SSE 不应包含 A 的能力文案');
  assert.equal(text.includes('共享走法'), false);
  controller.abort();
  reader.cancel().catch(() => {});
});

test('剧情 SSE：按席位推送且不泄露真名/规则', async (t) => {
  const { base } = await startApp(t);
  const room = await createStoryRoom(base);
  await submitAndStart(base, room);
  const controller = new AbortController();
  t.after(() => controller.abort());
  const response = await fetch(
    base + '/api/rooms/' + room.roomId + '/stream?token=' + room.tokens.black,
    { signal: controller.signal },
  );
  assert.equal(response.status, 200);
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
    throw new Error('等待 SSE 超时');
  }
  const initial = await nextState((value) => value.version >= 1);
  assert.equal(initial.game.story.enabled, true);
  assert.ok(!JSON.stringify(initial).includes('梁文峰'));

  await setGoddessName(base, room, 'b1', '小泡泡');
  const updated = await nextState((value) => value.version > initial.version);
  assert.ok(!JSON.stringify(updated).includes('梁文峰'));
  assert.ok(!JSON.stringify(updated).includes('小泡泡'));
  controller.abort();
  reader.cancel().catch(() => {});
});

test('剧情房间持久化：重启后共享池、真名与抹除记录仍在，且仍不泄露给玩家', async (t) => {
  const dataDir = makeDataDir();
  const first = await startApp(t, dataDir);
  const room = await createStoryRoom(first.base);
  await submitAndStart(first.base, room);
  await move(first.base, room, 'white', 'e2', 'e4');
  await erase(first.base, room, 'e1', '梁武帝');
  await move(first.base, room, 'black', 'e7', 'e5');
  await move(first.base, room, 'white', 'g1', 'f3');
  await setGoddessName(first.base, room, 'b1', '小泡泡');
  await erase(first.base, room, 'b1', '小泡泡');
  await first.app.close();

  const second = createApp({ dataDir, quiet: true });
  const address = await second.listen(0, '127.0.0.1');
  t.after(async () => { await second.close(); });
  const base = 'http://127.0.0.1:' + address.port;
  const white = await state(base, room, 'white');
  const goddess = await state(base, room, 'goddess');
  assert.deepEqual(white.game.story.special.map((item) => item.type), ['n']);
  assert.equal(goddess.goddess.story.names.find((piece) => piece.square === 'e1').trueName, '梁文峰');
  assert.ok(!JSON.stringify(white).includes('梁文峰'));
  assert.ok(!JSON.stringify(white).includes('小泡泡'));
});
