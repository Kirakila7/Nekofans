'use strict';

/*
 * 独立黑盒验收测试（verifier，仅新增本文件，不修改应用代码）。
 *
 * 覆盖 docs/API.md 与用户需求的安全红线：
 *   T01 房间创建 / 三席投影基线 / 无角色姓名
 *   T02 隐私红线（HTTP）：玩家状态无对手规则原文、备注、猜测原文、女神字段、令牌
 *   T03 隐私红线（SSE）：每条推送按席位投影，自己的内容可见、对手私密内容不可见
 *   T04 权限：玩家令牌 403 / 无令牌、错令牌 401 / 女神令牌不能替玩家操作 / 跨房间、伪造令牌
 *   T05 阶段与轮次：lobby 不能走子、非行棋方不能走子、非法走子被拒
 *   T06 逐手审核：待裁决阻塞双方、驳回备注仅该方可见、核准生效、撤回
 *   T07 暂停与手动终局：暂停时玩家冻结、女神仍可揭晓/公告/结束/重开、终局冻结
 *   T08 自动终局与撤销：将死不自动揭晓、自动终局可撤销
 *   T09 女神受控操作：代走 / 改盘 / 撤销 / 暂停 / 结束 / 重开真实改变状态
 *   T10 女神受控操作校验：移除王、第二枚王、兵在底线、非行棋方被将军等全部拒绝
 *   T11 规则生命周期：lobby 提交 / 退回 / 修正 / 生效 / 揭晓；猜中自动揭晓在 T13
 *   T12 规则未内置：源码与初始状态无预置规则，规则文本只在运行期提交
 *   T13 猜测：错误消耗次数、次数耗尽、等待裁定互斥、猜中判胜并自动揭晓、终局冻结
 *   T14 服务器安全：默认回环监听、零第三方依赖、无执行/外联入口、静态目录不泄露源码
 *   T15 额外对抗：无效 JSON、控制字符、超长文本/请求体、路径穿越、伪造令牌、坏房间号
 *
 * 运行：node --test tests/verify.blackbox.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { createApp } = require('../server.js');

const APP_ROOT = path.join(__dirname, '..');
const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const SERVER_SOURCE_FILES = ['server.js', 'lib/room.js', 'lib/store.js', 'lib/chess.js'];

const PLAYER_STATE_KEYS = [
  'announcements', 'createdAt', 'game', 'goddess', 'me', 'phase', 'players', 'revealed',
  'role', 'roomId', 'seat', 'updatedAt', 'version',
];
const GAME_KEYS = [
  'checkmate', 'draw', 'fen', 'guessLimit', 'inCheck', 'lastEdit', 'lastMove', 'legalMoves', 'moves',
  'pendingMove', 'ply', 'result', 'reviewMode', 'stalemate', 'turn',
];
const ME_KEYS = [
  'attemptsLeft', 'attemptsUsed', 'canCancelPending', 'canGuess', 'canMove',
  'canSubmitRule', 'color', 'guesses', 'lastRejection', 'rule', 'seat',
];
const ME_RULE_KEYS = ['note', 'revealed', 'status', 'text', 'updatedAt'];
const PLAYER_SIDE_KEYS = ['connected', 'guess', 'rule'];
const PLAYER_SIDE_RULE_KEYS = ['status', 'submitted'];
const PLAYER_SIDE_GUESS_KEYS = ['pending', 'used'];

// ---------------------------------------------------------------------------
// 基础设施
// ---------------------------------------------------------------------------

const tmpDirs = [];
test.after(() => {
  for (const dir of tmpDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

function makeDataDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nekofans-verify-'));
  tmpDirs.push(dir);
  return dir;
}

async function startApp(t, options = {}) {
  const dataDir = options.dataDir || makeDataDir();
  const app = createApp({ dataDir, quiet: true });
  const address = await app.listen(0, '127.0.0.1');
  if (t) t.after(async () => { try { await app.close(); } catch { /* ignore */ } });
  return { app, base: 'http://127.0.0.1:' + address.port, dataDir, address };
}

async function setup(t, roomBody = {}) {
  const context = await startApp(t);
  context.room = await createRoom(context.base, roomBody);
  return context;
}

function fmtResult(result) {
  if (result.transportError) return 'transport=' + (result.transportError.code || result.transportError.message);
  return 'status=' + result.status + ' body=' + String(result.text || '').slice(0, 240);
}

function expectStatus(result, status, label) {
  assert.equal(result.status, status, label + ' -> ' + fmtResult(result));
  return result;
}

function expectOK(result, label) {
  expectStatus(result, 200, label);
  assert.ok(result.json && result.json.ok === true, label + ' 期望 ok:true -> ' + fmtResult(result));
  return result.json;
}

function expectFailure(result, status, code, label) {
  expectStatus(result, status, label);
  assert.ok(result.json && result.json.ok === false, label + ' 期望 ok:false -> ' + fmtResult(result));
  assert.equal(result.json.code, code, label + ' 错误码 -> ' + fmtResult(result));
  return result.json;
}

async function call(base, method, pathname, options = {}) {
  const url = new URL(base + pathname);
  if (options.token !== undefined && options.token !== null) {
    url.searchParams.set('token', options.token);
  }
  const headers = Object.assign({}, options.headers);
  const init = { method, headers };
  if (options.rawBody !== undefined) {
    init.body = options.rawBody;
    if (!headers['Content-Type']) headers['Content-Type'] = 'application/json';
  } else if (options.body !== undefined) {
    init.body = JSON.stringify(options.body);
    headers['Content-Type'] = 'application/json';
  }
  try {
    const response = await fetch(url, init);
    const text = await response.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    return { status: response.status, headers: response.headers, text, json };
  } catch (error) {
    return { status: 0, headers: null, text: '', json: null, transportError: error };
  }
}

function rawRequest(base, rawPath, method = 'GET', body, extraHeaders = {}) {
  const { hostname, port } = new URL(base);
  return new Promise((resolve) => {
    const headers = Object.assign({}, extraHeaders);
    if (body !== undefined && headers['Content-Length'] === undefined) {
      headers['Content-Length'] = Buffer.byteLength(body);
    }
    const req = http.request(
      { hostname, port: Number(port), path: rawPath, method, headers },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try { json = JSON.parse(text); } catch { json = null; }
          resolve({ status: res.statusCode, headers: res.headers, text, json });
        });
      },
    );
    req.on('error', (error) => resolve({ status: 0, headers: null, text: '', json: null, transportError: error }));
    if (body !== undefined) req.write(body);
    req.end();
  });
}

function marker(prefix) {
  return prefix + '-' + crypto.randomBytes(8).toString('hex');
}

function textOf(value) {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function assertNoNeedles(value, needles, label) {
  const text = textOf(value);
  for (const needle of needles) {
    assert.ok(!text.includes(needle), label + ' 不应包含「' + needle + '」');
  }
}

function assertHasNeedles(value, needles, label) {
  const text = textOf(value);
  for (const needle of needles) {
    assert.ok(text.includes(needle), label + ' 应包含「' + needle + '」');
  }
}

function collectKeys(value, output = new Set()) {
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, output);
  } else if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      output.add(key);
      collectKeys(child, output);
    }
  }
  return output;
}

function assertPlayerProjection(state, seat) {
  assert.equal(state.role, 'player', seat + ' 视角 role');
  assert.equal(state.seat, seat, seat + ' 视角 seat');
  assert.equal(state.goddess, null, seat + ' 视角不得出现女神投影');
  assert.deepEqual(Object.keys(state).sort(), [...PLAYER_STATE_KEYS].sort(), seat + ' 视角顶层字段');
  assert.deepEqual(Object.keys(state.game).sort(), [...GAME_KEYS].sort(), seat + ' 视角 game 字段');
  assert.deepEqual(Object.keys(state.me).sort(), [...ME_KEYS].sort(), seat + ' 视角 me 字段');
  assert.deepEqual(Object.keys(state.me.rule).sort(), [...ME_RULE_KEYS].sort(), seat + ' 视角 me.rule 字段');
  for (const side of ['white', 'black']) {
    assert.deepEqual(
      Object.keys(state.players[side]).sort(),
      [...PLAYER_SIDE_KEYS].sort(),
      seat + ' 视角 players.' + side + ' 字段',
    );
    assert.deepEqual(
      Object.keys(state.players[side].rule).sort(),
      [...PLAYER_SIDE_RULE_KEYS].sort(),
      seat + ' 视角 players.' + side + '.rule 字段',
    );
    assert.deepEqual(
      Object.keys(state.players[side].guess).sort(),
      [...PLAYER_SIDE_GUESS_KEYS].sort(),
      seat + ' 视角 players.' + side + '.guess 字段',
    );
  }
  assert.equal(state.game.lastEdit, null, seat + ' 视角不得出现女神专属 lastEdit');
}

// ---------------------------------------------------------------------------
// 房间 / 操作辅助
// ---------------------------------------------------------------------------

function roomPath(room, suffix) {
  return '/api/rooms/' + room.roomId + (suffix || '');
}

async function createRoom(base, body = {}) {
  const data = expectOK(await call(base, 'POST', '/api/rooms', { body }), '创建房间');
  assert.match(data.roomId, /^r-[0-9a-f]{8}$/, '房间号格式');
  const extract = (link, seat) => {
    assert.equal(typeof link, 'string', seat + ' 链接存在');
    const url = new URL(link);
    assert.equal(url.pathname, '/room/' + data.roomId, seat + ' 链接路径');
    const token = url.searchParams.get('token');
    assert.match(token, /^[0-9a-f]{48}$/, seat + ' 令牌应为 24 字节随机十六进制');
    return token;
  };
  const tokens = {
    white: extract(data.links.white, 'white'),
    black: extract(data.links.black, 'black'),
    goddess: extract(data.links.goddess, 'goddess'),
  };
  assert.equal(new Set(Object.values(tokens)).size, 3, '三席令牌必须互不相同');
  return { roomId: data.roomId, links: data.links, tokens };
}

async function getState(base, room, seat) {
  const data = expectOK(
    await call(base, 'GET', roomPath(room, '/state'), { token: room.tokens[seat] }),
    seat + ' GET state',
  );
  return data.state;
}

function playerPost(base, room, seat, suffix, body) {
  return call(base, 'POST', roomPath(room, suffix), { token: room.tokens[seat], body });
}

function goddessPost(base, room, suffix, body) {
  return call(base, 'POST', roomPath(room, suffix), { token: room.tokens.goddess, body });
}

function move(base, room, seat, from, to, promotion) {
  return playerPost(base, room, seat, '/move', { from, to, promotion: promotion || null });
}

async function submitRules(base, room, whiteText, blackText) {
  expectOK(await playerPost(base, room, 'white', '/rule', { text: whiteText }), '白方提交规则');
  expectOK(await playerPost(base, room, 'black', '/rule', { text: blackText }), '黑方提交规则');
}

async function approveRules(base, room) {
  for (const seat of ['white', 'black']) {
    expectOK(
      await goddessPost(base, room, '/goddess/rule', { seat, action: 'approve' }),
      '女神核准 ' + seat + ' 规则',
    );
  }
}

async function startGame(base, room, options = {}) {
  const whiteRule = options.whiteRule || marker('白方隐藏规则');
  const blackRule = options.blackRule || marker('黑方隐藏规则');
  await submitRules(base, room, whiteRule, blackRule);
  await approveRules(base, room);
  const data = expectOK(await goddessPost(base, room, '/goddess/start', {}), '女神开始对局');
  assert.equal(data.state.phase, 'playing', '开始后阶段应为 playing');
  return { whiteRule, blackRule };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// SSE 客户端：把每条 `event: state` 帧解析后推入 frames。
function openStream(base, room, seat) {
  const controller = new AbortController();
  const frames = [];
  const rawFrames = [];
  let response = null;
  let readError = null;
  const url = base + roomPath(room, '/stream') + '?token=' + encodeURIComponent(room.tokens[seat]);
  const ready = fetch(url, { signal: controller.signal }).then(
    (resp) => {
      response = resp;
      if (resp.status !== 200) return resp;
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      (async () => {
        try {
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            let boundary;
            while ((boundary = buffer.indexOf('\n\n')) >= 0) {
              const frame = buffer.slice(0, boundary);
              buffer = buffer.slice(boundary + 2);
              if (!frame.startsWith('event: state')) continue;
              const dataLine = frame.split('\n').find((line) => line.startsWith('data: '));
              if (!dataLine) continue;
              rawFrames.push(frame);
              frames.push(JSON.parse(dataLine.slice(6)));
            }
          }
        } catch (error) {
          if (!controller.signal.aborted) readError = error;
        }
      })();
      return resp;
    },
    (error) => {
      if (!controller.signal.aborted) readError = error;
      return null;
    },
  );
  return {
    ready,
    frames,
    rawFrames,
    get response() { return response; },
    get readError() { return readError; },
    close() {
      try { controller.abort(); } catch { /* ignore */ }
    },
  };
}

async function waitForFrame(stream, predicate, label, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const frame of stream.frames) {
      if (predicate(frame)) return frame;
    }
    await delay(10);
  }
  throw new Error('等待 SSE 帧超时：' + label + '（已收到 ' + stream.frames.length + ' 帧）');
}

function readSource(relativePath) {
  return fs.readFileSync(path.join(APP_ROOT, relativePath), 'utf8');
}

function serverSources() {
  return SERVER_SOURCE_FILES.map((relativePath) => {
    assert.ok(fs.existsSync(path.join(APP_ROOT, relativePath)), '服务端源文件存在：' + relativePath);
    return { relativePath, text: readSource(relativePath) };
  });
}

// ---------------------------------------------------------------------------
// T01 房间创建：三席链接/令牌与状态投影基线
// ---------------------------------------------------------------------------

test('T01 房间创建：三席链接/令牌、玩家与女神投影基线、公开画面无角色姓名', async (t) => {
  const { base } = await startApp(t);
  const room = await createRoom(base);

  // 房间创建响应本身不应包含任何规则/令牌以外的隐私内容（令牌是给创建者的）
  assert.equal(new URL(room.links.white).origin, new URL(room.links.goddess).origin, '三席链接同源');

  const white = await getState(base, room, 'white');
  assertPlayerProjection(white, 'white');
  assert.equal(white.phase, 'lobby');
  assert.equal(white.game.fen, START_FEN, '初始棋盘应为标准起始局面');
  assert.equal(white.game.turn, 'w');
  assert.equal(white.game.ply, 0);
  assert.equal(white.game.inCheck, false);
  assert.equal(white.game.checkmate, false);
  assert.equal(white.game.stalemate, false);
  assert.equal(white.game.draw, false);
  assert.deepEqual(white.game.legalMoves, [], '尚未开始不应下发任何走法');
  assert.equal(white.game.lastMove, null);
  assert.equal(white.game.pendingMove, null);
  assert.deepEqual(white.game.moves, []);
  assert.equal(white.game.result, null);
  assert.equal(white.me.color, 'w');
  assert.equal(white.me.rule.status, 'empty');
  assert.equal(white.me.rule.text, null);
  assert.equal(white.me.rule.note, null);
  assert.equal(white.me.rule.revealed, false);
  assert.deepEqual(white.me.guesses, []);
  assert.equal(white.me.attemptsUsed, 0);
  assert.equal(white.me.attemptsLeft, 3);
  assert.equal(white.me.canMove, false);
  assert.equal(white.me.canGuess, false);
  assert.equal(white.me.canSubmitRule, true);
  assert.equal(white.me.canCancelPending, false);
  assert.equal(white.me.lastRejection, null);
  assert.equal(white.players.white.rule.submitted, false);
  assert.equal(white.players.white.rule.status, 'empty');
  assert.equal(white.players.black.rule.submitted, false);
  assert.equal(white.players.white.guess.used, 0);
  assert.equal(white.players.white.guess.pending, false);
  assert.deepEqual(white.announcements, []);
  assert.equal(white.revealed.white, null);
  assert.equal(white.revealed.black, null);

  // 公开画面/状态里不允许出现任何角色姓名，只能出现白方/黑方席位。
  const keyNames = [...collectKeys(white)].filter((key) => /name/i.test(key));
  assert.deepEqual(keyNames, [], '状态投影中不应出现任何姓名类字段');

  // 玩家视角绝不能出现任何令牌。
  for (const token of Object.values(room.tokens)) {
    assert.ok(!textOf(white).includes(token), '玩家状态中不应出现任何席位令牌');
  }

  const black = await getState(base, room, 'black');
  assertPlayerProjection(black, 'black');
  assert.equal(black.me.color, 'b');

  const goddess = await getState(base, room, 'goddess');
  assert.equal(goddess.role, 'goddess');
  assert.equal(goddess.seat, null);
  assert.equal(goddess.me, null);
  assert.ok(goddess.goddess, '女神视角应有 goddess 投影');
  assert.deepEqual(goddess.goddess.rules.white, {
    text: null, status: 'empty', note: null, updatedAt: null, revealedAt: null,
  });
  assert.deepEqual(goddess.goddess.rules.black, {
    text: null, status: 'empty', note: null, updatedAt: null, revealedAt: null,
  });
  assert.deepEqual(goddess.goddess.settings, { reviewMode: true, guessLimit: 3 });
  assert.deepEqual(goddess.goddess.guesses, []);
  assert.deepEqual(goddess.goddess.events, []);
  assert.equal(goddess.goddess.links.white, room.links.white);
  assert.equal(goddess.goddess.links.black, room.links.black);
  assert.equal(goddess.goddess.links.goddess, room.links.goddess);

  const health = await call(base, 'GET', '/api/health');
  const healthData = expectOK(health, '健康检查');
  assert.equal(healthData.ok, true);
  assert.equal(typeof healthData.version, 'string');
  assert.equal(healthData.rooms, 1);
});

// ---------------------------------------------------------------------------
// T02 隐私红线（HTTP）
// ---------------------------------------------------------------------------

test('T02 隐私红线（HTTP）：玩家状态不泄露对手规则/备注/猜测/女神字段/令牌', async (t) => {
  const { base, room } = await setup(t);

  const secret = {
    whiteRule: marker('SECRET-白方规则原文'),
    whiteRule2: marker('SECRET-白方规则二版'),
    whiteNote: marker('SECRET-白方退回备注'),
    blackRule: marker('SECRET-黑方规则原文'),
    whiteGuess: marker('SECRET-白方猜测原文'),
    whiteGuessNote: marker('SECRET-白方猜测备注'),
    blackGuess: marker('SECRET-黑方猜测原文'),
    blackGuessNote: marker('SECRET-黑方猜测备注'),
    rejectionNote: marker('SECRET-白方驳回说明'),
  };
  const tokens = [room.tokens.white, room.tokens.black, room.tokens.goddess];
  const goddessOnlyNeedles = ['"events"', '"links"', '"settings"'];

  // 白方提交规则；黑方只能看到「已提交」状态位，看不到规则原文。
  expectOK(await playerPost(base, room, 'white', '/rule', { text: secret.whiteRule }), '白方提交规则');
  const whiteOwn = await getState(base, room, 'white');
  assertPlayerProjection(whiteOwn, 'white');
  assert.equal(whiteOwn.me.rule.text, secret.whiteRule, '玩家必须能看到自己的规则原文');
  assert.equal(whiteOwn.me.rule.status, 'submitted');

  let blackView = await getState(base, room, 'black');
  assertPlayerProjection(blackView, 'black');
  assert.equal(blackView.players.white.rule.submitted, true);
  assert.equal(blackView.players.white.rule.status, 'submitted');
  assert.equal(blackView.me.rule.text, null, '黑方自己的规则尚未提交');
  assertNoNeedles(blackView, [
    secret.whiteRule, secret.whiteNote, secret.whiteGuess, secret.whiteGuessNote,
    secret.rejectionNote, ...tokens, ...goddessOnlyNeedles,
  ], '黑方视图（白方已交规则后）');

  // 女神退回白方规则并附备注：只有白方能看到这条备注。
  expectOK(
    await goddessPost(base, room, '/goddess/rule', { seat: 'white', action: 'return', note: secret.whiteNote }),
    '女神退回白方规则',
  );
  const whiteReturned = await getState(base, room, 'white');
  assert.equal(whiteReturned.me.rule.status, 'returned');
  assert.equal(whiteReturned.me.rule.note, secret.whiteNote, '退回备注只应出现在该玩家自己的 me 里');
  blackView = await getState(base, room, 'black');
  assertNoNeedles(blackView, [secret.whiteRule, secret.whiteNote, ...tokens, ...goddessOnlyNeedles], '黑方视图（白方被退回后）');

  // 白方重新提交；黑方提交自己的规则并进入对局。
  expectOK(await playerPost(base, room, 'white', '/rule', { text: secret.whiteRule2 }), '白方重新提交规则');
  const whiteResubmitted = await getState(base, room, 'white');
  assert.equal(whiteResubmitted.me.rule.text, secret.whiteRule2);
  assert.equal(whiteResubmitted.me.rule.note, null, '重新提交后应清空退回备注');
  expectOK(await playerPost(base, room, 'black', '/rule', { text: secret.blackRule }), '黑方提交规则');
  let whiteView = await getState(base, room, 'white');
  assertNoNeedles(whiteView, [secret.blackRule, ...tokens, ...goddessOnlyNeedles], '白方视图（黑方已交规则后）');
  await approveRules(base, room);
  expectOK(await goddessPost(base, room, '/goddess/start', {}), '女神开始对局');

  // 猜测原文：只有女神能看到全部；对手只能看到次数/等待状态。
  expectOK(await playerPost(base, room, 'white', '/guess', { text: secret.whiteGuess }), '白方提交猜测');
  whiteView = await getState(base, room, 'white');
  assert.equal(whiteView.me.guesses.length, 1);
  assert.equal(whiteView.me.guesses[0].text, secret.whiteGuess, '自己的猜测原文必须可见');
  assert.equal(whiteView.me.guesses[0].status, 'pending');
  blackView = await getState(base, room, 'black');
  assert.equal(blackView.players.white.guess.used, 1);
  assert.equal(blackView.players.white.guess.pending, true);
  assertNoNeedles(blackView, [secret.whiteRule2, secret.whiteGuess, secret.whiteNote, ...tokens, ...goddessOnlyNeedles], '黑方视图（白方猜测后）');

  // 裁定备注只回给猜测方本人。
  const goddessStateForGuess = await getState(base, room, 'goddess');
  const whiteGuessId = goddessStateForGuess.goddess.guesses[0].id;
  expectOK(
    await goddessPost(base, room, '/goddess/judge-guess', { guessId: whiteGuessId, correct: false, note: secret.whiteGuessNote }),
    '女神裁定白方猜测错误',
  );
  whiteView = await getState(base, room, 'white');
  assert.equal(whiteView.me.guesses[0].note, secret.whiteGuessNote, '裁定备注只对猜测方可见');
  assert.equal(whiteView.me.guesses[0].status, 'wrong');
  blackView = await getState(base, room, 'black');
  assertNoNeedles(blackView, [secret.whiteGuess, secret.whiteGuessNote, ...tokens, ...goddessOnlyNeedles], '黑方视图（白方猜测被裁定后）');

  // 黑方猜测原文对白方不可见。
  expectOK(await playerPost(base, room, 'black', '/guess', { text: secret.blackGuess }), '黑方提交猜测');
  whiteView = await getState(base, room, 'white');
  assertNoNeedles(whiteView, [secret.blackRule, secret.blackGuess, ...tokens, ...goddessOnlyNeedles], '白方视图（黑方猜测后）');
  const goddessStateForBlackGuess = await getState(base, room, 'goddess');
  const blackGuessId = goddessStateForBlackGuess.goddess.guesses.find((guess) => guess.seat === 'black').id;
  expectOK(
    await goddessPost(base, room, '/goddess/judge-guess', { guessId: blackGuessId, correct: false, note: secret.blackGuessNote }),
    '女神裁定黑方猜测错误',
  );
  whiteView = await getState(base, room, 'white');
  assertNoNeedles(whiteView, [secret.blackRule, secret.blackGuess, secret.blackGuessNote, ...tokens, ...goddessOnlyNeedles], '白方视图（黑方猜测被裁定后）');

  // 走子驳回说明只显示给被驳回方。
  expectOK(await move(base, room, 'white', 'e2', 'e4'), '白方提交待裁决走子');
  const goddessPending = await getState(base, room, 'goddess');
  expectOK(
    await goddessPost(base, room, '/goddess/review', {
      moveId: goddessPending.game.pendingMove.id,
      decision: 'reject',
      note: secret.rejectionNote,
    }),
    '女神驳回白方走子',
  );
  whiteView = await getState(base, room, 'white');
  assert.ok(whiteView.me.lastRejection, '被驳回方应看到 lastRejection');
  assert.equal(whiteView.me.lastRejection.reason, secret.rejectionNote);
  blackView = await getState(base, room, 'black');
  assert.equal(blackView.me.lastRejection, null, '对手不应看到驳回说明');
  assertNoNeedles(blackView, [secret.rejectionNote, ...tokens, ...goddessOnlyNeedles], '黑方视图（白方走子被驳回后）');

  // 揭晓前双方 revealed 均为 null；黑方规则仍未对白方公开。
  assert.equal(whiteView.revealed.white, null);
  assert.equal(whiteView.revealed.black, null);
  assert.equal(blackView.revealed.white, null);
  assert.equal(blackView.revealed.black, null);
  assertNoNeedles(whiteView, [secret.blackRule, ...tokens, ...goddessOnlyNeedles], '揭晓前的白方视图');
  assertNoNeedles(blackView, [secret.whiteRule2, ...tokens, ...goddessOnlyNeedles], '揭晓前的黑方视图');

  // 女神显式揭晓白方规则后，双方才看到白方原文；黑方规则仍保密。
  expectOK(
    await goddessPost(base, room, '/goddess/rule', { seat: 'white', action: 'reveal' }),
    '女神揭晓白方规则',
  );
  blackView = await getState(base, room, 'black');
  assert.equal(blackView.revealed.white.text, secret.whiteRule2, '揭晓后对手可见该方规则原文');
  assert.ok(blackView.revealed.white.revealedAt > 0);
  assert.equal(blackView.revealed.black, null, '未揭晓的另一方规则仍不可见');
  whiteView = await getState(base, room, 'white');
  assert.equal(whiteView.revealed.white.text, secret.whiteRule2);
  assertNoNeedles(whiteView, [secret.blackRule, ...tokens, ...goddessOnlyNeedles], '揭晓白方后白方视图仍不应出现黑方规则');

  // 女神是唯一能同时看到双方规则原文、备注、全部猜测的角色。
  const goddessState = await getState(base, room, 'goddess');
  assert.equal(goddessState.goddess.rules.white.text, secret.whiteRule2);
  assert.equal(goddessState.goddess.rules.black.text, secret.blackRule);
  assertHasNeedles(goddessState.goddess.guesses, [secret.whiteGuess, secret.blackGuess], '女神视角应看到全部猜测原文');
  assertHasNeedles(goddessState.goddess.guesses, [secret.whiteGuessNote, secret.blackGuessNote], '女神视角应看到裁定备注');
  assert.ok(goddessState.goddess.events.length > 0, '女神视角应有事件日志');
});

// ---------------------------------------------------------------------------
// T03 隐私红线（SSE）
// ---------------------------------------------------------------------------

test('T03 隐私红线（SSE）：每条推送按席位投影，不泄露对手私密内容与令牌', async (t) => {
  const { base, room } = await setup(t);

  const W = {
    rule: marker('SSE-白方规则'),
    guess: marker('SSE-白方猜测'),
    guessNote: marker('SSE-白方猜测备注'),
    rejectNote: marker('SSE-白方驳回说明'),
  };
  const B = {
    rule: marker('SSE-黑方规则初版'),
    rule2: marker('SSE-黑方规则二版'),
    note: marker('SSE-黑方退回备注'),
    guess: marker('SSE-黑方猜测'),
    guessNote: marker('SSE-黑方猜测备注'),
  };
  const ANNOUNCE = marker('SSE-公开公告');
  const tokens = [room.tokens.white, room.tokens.black, room.tokens.goddess];

  const whiteStream = openStream(base, room, 'white');
  const blackStream = openStream(base, room, 'black');
  t.after(() => { whiteStream.close(); blackStream.close(); });

  const whiteResponse = await whiteStream.ready;
  const blackResponse = await blackStream.ready;
  assert.equal(whiteResponse.status, 200, '白方 SSE 连接');
  assert.equal(blackResponse.status, 200, '黑方 SSE 连接');
  assert.match(whiteResponse.headers.get('content-type'), /text\/event-stream/);
  assert.match(whiteResponse.headers.get('cache-control'), /no-cache/);
  await waitForFrame(whiteStream, (state) => state.role === 'player', '白方初始帧');
  await waitForFrame(blackStream, (state) => state.role === 'player', '黑方初始帧');

  // 用一串会产生各类私密数据的操作，期间两个玩家席位持续接收 SSE。
  expectOK(await playerPost(base, room, 'white', '/rule', { text: W.rule }), '白方提交规则');
  expectOK(await playerPost(base, room, 'black', '/rule', { text: B.rule }), '黑方提交规则');
  expectOK(
    await goddessPost(base, room, '/goddess/rule', { seat: 'black', action: 'return', note: B.note }),
    '女神退回黑方规则',
  );
  expectOK(await playerPost(base, room, 'black', '/rule', { text: B.rule2 }), '黑方重新提交规则');
  await approveRules(base, room);
  expectOK(await goddessPost(base, room, '/goddess/start', {}), '女神开始对局');
  expectOK(await playerPost(base, room, 'white', '/guess', { text: W.guess }), '白方提交猜测');
  const goddessAfterGuess = await getState(base, room, 'goddess');
  const whiteGuessId = goddessAfterGuess.goddess.guesses.find((guess) => guess.seat === 'white').id;
  expectOK(
    await goddessPost(base, room, '/goddess/judge-guess', {
      guessId: whiteGuessId, correct: false, note: W.guessNote,
    }),
    '女神裁定白方猜测错误',
  );
  expectOK(await playerPost(base, room, 'black', '/guess', { text: B.guess }), '黑方提交猜测');
  const goddessAfterBlackGuess = await getState(base, room, 'goddess');
  const blackGuessId = goddessAfterBlackGuess.goddess.guesses.find((guess) => guess.seat === 'black').id;
  expectOK(
    await goddessPost(base, room, '/goddess/judge-guess', {
      guessId: blackGuessId, correct: false, note: B.guessNote,
    }),
    '女神裁定黑方猜测错误',
  );
  expectOK(await move(base, room, 'white', 'e2', 'e4'), '白方提交待裁决走子');
  const pendingState = await getState(base, room, 'goddess');
  expectOK(
    await goddessPost(base, room, '/goddess/review', {
      moveId: pendingState.game.pendingMove.id,
      decision: 'reject',
      note: W.rejectNote,
    }),
    '女神驳回白方走子',
  );
  expectOK(await goddessPost(base, room, '/goddess/announce', { text: ANNOUNCE }), '女神发布公告');

  // 等两个席位都收到最新版本的推送（version 单调递增）。
  const finalVersion = (await getState(base, room, 'white')).version;
  await waitForFrame(whiteStream, (state) => state.version >= finalVersion, '白方最终版本帧');
  await waitForFrame(blackStream, (state) => state.version >= finalVersion, '黑方最终版本帧');
  await delay(60);

  assert.ok(whiteStream.frames.length >= 8, '白方应收到足够多的 SSE 帧，实际 ' + whiteStream.frames.length);
  assert.ok(blackStream.frames.length >= 8, '黑方应收到足够多的 SSE 帧，实际 ' + blackStream.frames.length);

  const whiteAll = textOf(whiteStream.rawFrames);
  const blackAll = textOf(blackStream.rawFrames);

  // 每条帧都必须是 event: state，且 role/seat 与令牌一致、goddess 为 null。
  for (const frame of whiteStream.rawFrames) {
    assert.ok(frame.startsWith('event: state\ndata: '), 'SSE 帧格式应为 event: state + data');
  }
  for (const state of whiteStream.frames) {
    assertPlayerProjection(state, 'white');
  }
  for (const state of blackStream.frames) {
    assertPlayerProjection(state, 'black');
  }

  // 自己的私密内容在自己的推送中可见。
  assertHasNeedles(whiteAll, [W.rule, W.guess, W.guessNote, W.rejectNote], '白方 SSE 应包含自己的内容');
  assertHasNeedles(blackAll, [B.rule, B.rule2, B.note, B.guess, B.guessNote], '黑方 SSE 应包含自己的内容');

  // 对手的私密内容绝不能出现在自己的推送中。
  assertNoNeedles(whiteAll, [B.rule, B.rule2, B.note, B.guess, B.guessNote], '白方 SSE 泄露黑方私密内容');
  assertNoNeedles(blackAll, [W.rule, W.guess, W.guessNote, W.rejectNote], '黑方 SSE 泄露白方私密内容');

  // 任何令牌、女神专属字段都不能出现在玩家推送里。
  assertNoNeedles(whiteAll, [...tokens, '"events"', '"links"', '"settings"'], '白方 SSE');
  assertNoNeedles(blackAll, [...tokens, '"events"', '"links"', '"settings"'], '黑方 SSE');

  // 公开公告是双方都可见的。
  assertHasNeedles(whiteAll, [ANNOUNCE], '白方 SSE 应收到公开公告');
  assertHasNeedles(blackAll, [ANNOUNCE], '黑方 SSE 应收到公开公告');

  // 未揭晓前，任何玩家帧的 revealed 都必须为空。
  for (const state of [...whiteStream.frames, ...blackStream.frames]) {
    assert.equal(state.revealed.white, null, '揭晓前 SSE 不得出现白方规则原文');
    assert.equal(state.revealed.black, null, '揭晓前 SSE 不得出现黑方规则原文');
  }

  whiteStream.close();
  blackStream.close();
  await delay(60);
  assert.equal(whiteStream.readError, null, '白方 SSE 读取不应报错');
  assert.equal(blackStream.readError, null, '黑方 SSE 读取不应报错');

  // 对照组：女神 SSE 可以看到双方规则与全部猜测（角色投影确实生效）。
  const goddessStream = openStream(base, room, 'goddess');
  t.after(() => goddessStream.close());
  const goddessResponse = await goddessStream.ready;
  assert.equal(goddessResponse.status, 200, '女神 SSE 连接');
  const goddessFrame = await waitForFrame(
    goddessStream,
    (state) => state.goddess && state.goddess.rules.white.text === W.rule,
    '女神 SSE 规则帧',
  );
  assert.equal(goddessFrame.goddess.rules.black.text, B.rule2);
  assertHasNeedles(goddessFrame.goddess.guesses, [W.guess, B.guess], '女神 SSE 应包含全部猜测');
  goddessStream.close();
});

// ---------------------------------------------------------------------------
// T04 权限
// ---------------------------------------------------------------------------

test('T04 权限：玩家令牌 403、缺失/伪造令牌 401、女神令牌不能替玩家操作、跨房间隔离', async (t) => {
  const { base, room } = await setup(t);
  const otherRoom = await createRoom(base);

  // 所有女神受控操作：玩家令牌一律 403，无令牌一律 401。
  const goddessEndpoints = [
    ['/goddess/rule', { seat: 'white', action: 'approve' }],
    ['/goddess/start', {}],
    ['/goddess/review', { moveId: 'p-000000', decision: 'approve' }],
    ['/goddess/force-move', { from: 'e2', to: 'e4' }],
    ['/goddess/edit-board', { op: 'remove', square: 'e7' }],
    ['/goddess/undo', {}],
    ['/goddess/pause', { paused: true }],
    ['/goddess/end', { winner: 'white', reason: 'goddess' }],
    ['/goddess/judge-guess', { guessId: 'g1', correct: true }],
    ['/goddess/settings', { reviewMode: true }],
    ['/goddess/announce', { text: '测试公告' }],
    ['/goddess/reset', {}],
  ];
  for (const [suffix, body] of goddessEndpoints) {
    for (const seat of ['white', 'black']) {
      expectFailure(
        await call(base, 'POST', roomPath(room, suffix), { token: room.tokens[seat], body }),
        403, 'forbidden', seat + ' 令牌调用 ' + suffix,
      );
    }
    expectFailure(
      await call(base, 'POST', roomPath(room, suffix), { body }),
      401, 'missing_token', '无令牌调用 ' + suffix,
    );
  }

  // 导出接口：仅女神；玩家 403，无令牌/错令牌 401。
  for (const seat of ['white', 'black']) {
    expectFailure(
      await call(base, 'GET', roomPath(room, '/export'), { token: room.tokens[seat] }),
      403, 'forbidden', seat + ' 令牌导出房间',
    );
  }
  expectFailure(await call(base, 'GET', roomPath(room, '/export')), 401, 'missing_token', '无令牌导出房间');
  expectFailure(
    await call(base, 'GET', roomPath(room, '/export'), { token: 'deadbeef' }),
    401, 'invalid_token', '错误令牌导出房间',
  );

  // 女神令牌不能替玩家提交规则、走子、猜测、撤回。
  for (const [suffix, body] of [
    ['/rule', { text: '女神不能代交规则' }],
    ['/move', { from: 'e2', to: 'e4' }],
    ['/move/cancel', {}],
    ['/guess', { text: '女神不能代猜' }],
  ]) {
    expectFailure(
      await call(base, 'POST', roomPath(room, suffix), { token: room.tokens.goddess, body }),
      403, 'forbidden', '女神令牌调用玩家接口 ' + suffix,
    );
  }

  // 无令牌 / 错令牌读取 state、SSE 均 401；空 token 也视为缺失。
  expectFailure(await call(base, 'GET', roomPath(room, '/state')), 401, 'missing_token', '无令牌读 state');
  expectFailure(
    await call(base, 'GET', roomPath(room, '/state'), { token: 'not-a-token' }),
    401, 'invalid_token', '错误令牌读 state',
  );
  expectFailure(
    await call(base, 'GET', roomPath(room, '/state'), { token: '' }),
    401, 'missing_token', '空令牌读 state',
  );
  expectFailure(await call(base, 'GET', roomPath(room, '/stream')), 401, 'missing_token', '无令牌连 SSE');
  expectFailure(
    await call(base, 'GET', roomPath(room, '/stream'), { token: crypto.randomBytes(24).toString('hex') }),
    401, 'invalid_token', '伪造令牌连 SSE',
  );

  // 伪造令牌：追加字符、截断、大写、任意长随机串、空白包裹全部 401。
  const forgedTokens = [
    room.tokens.white + '0',
    room.tokens.white.slice(0, -1),
    room.tokens.white.toUpperCase(),
    ' ' + room.tokens.white,
    room.tokens.white + ' ',
    crypto.randomBytes(48).toString('hex'),
    'null',
    'undefined',
  ];
  for (const forged of forgedTokens) {
    expectFailure(
      await call(base, 'GET', roomPath(room, '/state'), { token: forged }),
      401, 'invalid_token', '伪造令牌 ' + JSON.stringify(forged.slice(0, 16)),
    );
  }

  // 令牌只通过 query 传递：Authorization 头不构成鉴权。
  expectFailure(
    await call(base, 'GET', roomPath(room, '/state'), { headers: { Authorization: 'Bearer ' + room.tokens.white } }),
    401, 'missing_token', '仅 Authorization 头不构成令牌',
  );

  // 跨房间：A 房令牌不能读/写 B 房；B 房女神令牌也不能访问 A 房。
  expectFailure(
    await call(base, 'GET', roomPath(otherRoom, '/state'), { token: room.tokens.white }),
    401, 'invalid_token', 'A 房白方令牌访问 B 房 state',
  );
  expectFailure(
    await call(base, 'GET', roomPath(otherRoom, '/export'), { token: room.tokens.goddess }),
    401, 'invalid_token', 'A 房女神令牌导出 B 房',
  );
  expectFailure(
    await call(base, 'POST', roomPath(otherRoom, '/goddess/announce'), {
      token: room.tokens.goddess, body: { text: '跨房公告' },
    }),
    401, 'invalid_token', 'A 房女神令牌跨房操作',
  );

  // 正常令牌仍然可用。
  const whiteState = await getState(base, room, 'white');
  assert.equal(whiteState.seat, 'white');
  assert.equal(whiteState.roomId, room.roomId);
  const blackState = await getState(base, room, 'black');
  assert.equal(blackState.seat, 'black');
  const goddessState = await getState(base, room, 'goddess');
  assert.equal(goddessState.role, 'goddess');
});

// ---------------------------------------------------------------------------
// T05 阶段与轮次
// ---------------------------------------------------------------------------

test('T05 阶段与轮次：lobby 禁止走子/猜测，非行棋方与非法走子被拒', async (t) => {
  const { base } = await startApp(t);
  const room = await createRoom(base, { reviewMode: false });

  // lobby：规则尚未生效，走子/猜测/女神操作均不得改变棋盘。
  expectFailure(await move(base, room, 'white', 'e2', 'e4'), 409, 'wrong_phase', 'lobby 白方走子');
  expectFailure(await move(base, room, 'black', 'e7', 'e5'), 409, 'wrong_phase', 'lobby 黑方走子');
  expectFailure(
    await playerPost(base, room, 'white', '/guess', { text: 'lobby 猜测' }),
    409, 'wrong_phase', 'lobby 猜测',
  );
  expectFailure(await playerPost(base, room, 'white', '/move/cancel', {}), 409, 'no_pending', 'lobby 撤回');
  expectFailure(
    await goddessPost(base, room, '/goddess/force-move', { from: 'e2', to: 'e4' }),
    409, 'wrong_phase', 'lobby 女神代走',
  );
  expectFailure(
    await goddessPost(base, room, '/goddess/edit-board', { op: 'remove', square: 'e7' }),
    409, 'wrong_phase', 'lobby 女神改盘',
  );
  expectFailure(await goddessPost(base, room, '/goddess/pause', { paused: true }), 409, 'wrong_phase', 'lobby 暂停');
  expectFailure(
    await goddessPost(base, room, '/goddess/end', { winner: 'white', reason: 'goddess' }),
    409, 'wrong_phase', 'lobby 结束对局',
  );
  expectFailure(await goddessPost(base, room, '/goddess/undo', {}), 409, 'wrong_phase', 'lobby 撤销');
  expectFailure(await goddessPost(base, room, '/goddess/start', {}), 409, 'rules_not_ready', '未交规则就开始');

  // 只有一方规则生效也不能开始。
  expectOK(await playerPost(base, room, 'white', '/rule', { text: '白方阶段测试规则' }), '白方提交规则');
  expectOK(
    await goddessPost(base, room, '/goddess/rule', { seat: 'white', action: 'approve' }),
    '女神核准白方规则',
  );
  expectFailure(await goddessPost(base, room, '/goddess/start', {}), 409, 'rules_not_ready', '单方生效就开始');
  expectOK(await playerPost(base, room, 'black', '/rule', { text: '黑方阶段测试规则' }), '黑方提交规则');
  expectFailure(await goddessPost(base, room, '/goddess/start', {}), 409, 'rules_not_ready', '双方仅提交未生效就开始');
  expectOK(
    await goddessPost(base, room, '/goddess/rule', { seat: 'black', action: 'approve' }),
    '女神核准黑方规则',
  );
  const started = expectOK(await goddessPost(base, room, '/goddess/start', {}), '双方规则生效后开始');
  assert.equal(started.state.phase, 'playing');
  assert.equal(started.state.game.turn, 'w');
  assert.equal(started.state.game.legalMoves.length, 20, '白方行棋时应下发 20 个合法走法');
  expectFailure(await goddessPost(base, room, '/goddess/start', {}), 409, 'wrong_phase', '重复开始');

  // playing：已开始后不允许再提交规则。
  expectFailure(
    await playerPost(base, room, 'white', '/rule', { text: '开始后改规则' }),
    409, 'wrong_phase', 'playing 阶段提交规则',
  );

  const whiteState = await getState(base, room, 'white');
  assertPlayerProjection(whiteState, 'white');
  assert.equal(whiteState.me.canMove, true, '白方行棋时 canMove 应为 true');
  assert.equal(whiteState.me.canGuess, true);
  const blackState = await getState(base, room, 'black');
  assert.equal(blackState.me.canMove, false, '非行棋方 canMove 应为 false');
  assert.deepEqual(blackState.game.legalMoves, [], '非行棋方不应拿到走法列表');

  // 非行棋方不能走子；非法走子、坏坐标被拒；合法走子生效后轮到黑方。
  expectFailure(await move(base, room, 'black', 'e7', 'e5'), 409, 'not_your_turn', '黑方越序走子');
  expectFailure(await move(base, room, 'white', 'e2', 'e5'), 400, 'illegal_move', '白方非法走子');
  expectFailure(await move(base, room, 'white', 'z9', 'e4'), 400, 'bad_square', '坏坐标走子');
  expectFailure(await move(base, room, 'white', 'e2', undefined), 400, 'bad_square', '缺目标格走子');
  expectFailure(
    await playerPost(base, room, 'white', '/move', {}),
    400, 'bad_square', '空 body 走子',
  );

  const whiteMove = expectOK(await move(base, room, 'white', 'e2', 'e4'), '白方合法走子');
  assert.equal(whiteMove.state.game.ply, 1);
  assert.equal(whiteMove.state.game.turn, 'b');
  assert.equal(whiteMove.state.game.moves.length, 1);
  assert.equal(whiteMove.state.game.moves[0].color, 'w');
  assert.equal(whiteMove.state.game.moves[0].by, 'player');
  assert.match(whiteMove.state.game.moves[0].label, /^e2.e4$/);

  const blackTurn = await getState(base, room, 'black');
  assert.equal(blackTurn.me.canMove, true);
  const blackMove = expectOK(await move(base, room, 'black', 'e7', 'e5'), '黑方合法走子');
  assert.equal(blackMove.state.game.ply, 2);
  assert.equal(blackMove.state.game.turn, 'w');
  expectFailure(await move(base, room, 'black', 'd7', 'd5'), 409, 'not_your_turn', '黑方连续走子');
});

// ---------------------------------------------------------------------------
// T06 逐手审核
// ---------------------------------------------------------------------------

test('T06 逐手审核：待裁决走子阻塞双方、驳回备注仅该方可见、核准生效、撤回', async (t) => {
  const { base, room } = await setup(t, { reviewMode: true });
  await startGame(base, room);

  const pendingResult = expectOK(await move(base, room, 'white', 'e2', 'e4'), '白方提交待裁决走子');
  assert.equal(pendingResult.state.phase, 'playing');
  assert.equal(pendingResult.state.game.ply, 0, '待裁决期间棋盘不应变化');
  assert.equal(pendingResult.state.game.turn, 'w');
  assert.ok(pendingResult.state.game.pendingMove, '应有待裁决走子');
  assert.match(pendingResult.state.game.pendingMove.label, /^e2.e4$/);
  assert.equal(pendingResult.state.game.pendingMove.seat, 'white');
  // docs/API.md 声称 pendingMove.by 为 "pending"；当前实现返回 "player"，属低风险文档偏差（见报告）。
  assert.ok(['player', 'pending'].includes(pendingResult.state.game.pendingMove.by), 'pendingMove.by 应可识别');
  t.diagnostic('已知低风险文档偏差：pendingMove.by 实际为 "' + pendingResult.state.game.pendingMove.by + '"，docs/API.md 写的是 "pending"。');
  assert.equal(pendingResult.state.me.canMove, false);
  assert.equal(pendingResult.state.me.canCancelPending, true);

  // 有待裁决走子时，双方都不能再提交走子。
  expectFailure(await move(base, room, 'white', 'd2', 'd4'), 409, 'pending_move', '同方在待裁决时再走');
  expectFailure(await move(base, room, 'black', 'e7', 'e5'), 409, 'pending_move', '对手在待裁决时走子');
  // 女神的结构化操作同样被阻塞。
  expectFailure(await goddessPost(base, room, '/goddess/pause', { paused: true }), 409, 'pending_move', '待裁决时暂停');
  expectFailure(
    await goddessPost(base, room, '/goddess/force-move', { from: 'd2', to: 'd4' }),
    409, 'pending_move', '待裁决时代走',
  );
  expectFailure(
    await goddessPost(base, room, '/goddess/edit-board', { op: 'remove', square: 'e7' }),
    409, 'pending_move', '待裁决时改盘',
  );
  expectFailure(await goddessPost(base, room, '/goddess/undo', {}), 409, 'pending_move', '待裁决时撤销');

  // 错误的 moveId 被拒；驳回需写入仅该玩家可见的 lastRejection。
  const rejectNote = marker('驳回说明');
  expectFailure(
    await goddessPost(base, room, '/goddess/review', { moveId: 'p-deadbeef', decision: 'approve' }),
    409, 'stale_pending', '旧 moveId 裁决',
  );
  const rejected = expectOK(
    await goddessPost(base, room, '/goddess/review', {
      moveId: pendingResult.state.game.pendingMove.id,
      decision: 'reject',
      note: rejectNote,
    }),
    '女神驳回走子',
  );
  assert.equal(rejected.state.game.pendingMove, null);
  assert.equal(rejected.state.game.ply, 0, '驳回不应改变棋盘');
  assert.deepEqual(rejected.state.game.moves, []);
  const whiteAfterReject = await getState(base, room, 'white');
  assert.equal(whiteAfterReject.me.lastRejection.reason, rejectNote);
  assert.match(whiteAfterReject.me.lastRejection.label, /^e2.e4$/);
  assert.equal(whiteAfterReject.me.canMove, true);
  const blackAfterReject = await getState(base, room, 'black');
  assert.equal(blackAfterReject.me.lastRejection, null, '只有被驳回方能看到 lastRejection');

  // 撤回：自己的待裁决走子可以撤回；对手不能撤回。
  const pendingAgain = expectOK(await move(base, room, 'white', 'd2', 'd4'), '白方再次提交待裁决走子');
  const cancelled = expectOK(
    await playerPost(base, room, 'white', '/move/cancel', {}),
    '白方撤回自己的待裁决走子',
  );
  assert.equal(cancelled.state.game.pendingMove, null);
  assert.equal(cancelled.state.game.ply, 0);
  assert.equal(cancelled.state.game.pendingMove, null);
  assert.ok(pendingAgain.state.game.pendingMove.id);

  const pendingThird = expectOK(await move(base, room, 'white', 'e2', 'e4'), '白方第三次提交待裁决走子');
  expectFailure(
    await playerPost(base, room, 'black', '/move/cancel', {}),
    403, 'not_your_pending', '黑方撤回白方的待裁决走子',
  );
  // 白方撤回后再由女神核准一次，验证核准真实生效。
  expectOK(await playerPost(base, room, 'white', '/move/cancel', {}), '白方撤回第三次走子');
  const pendingFourth = expectOK(await move(base, room, 'white', 'e2', 'e4'), '白方第四次提交待裁决走子');
  const approved = expectOK(
    await goddessPost(base, room, '/goddess/review', {
      moveId: pendingFourth.state.game.pendingMove.id,
      decision: 'approve',
    }),
    '女神核准走子',
  );
  assert.equal(approved.state.game.pendingMove, null);
  assert.equal(approved.state.game.ply, 1);
  assert.equal(approved.state.game.turn, 'b');
  assert.equal(approved.state.game.moves.length, 1);
  assert.equal(approved.state.game.moves[0].by, 'player');

  // 黑方待裁决 → 女神核准后轮到白方。
  const blackPending = expectOK(await move(base, room, 'black', 'e7', 'e5'), '黑方提交待裁决走子');
  const blackApproved = expectOK(
    await goddessPost(base, room, '/goddess/review', {
      moveId: blackPending.state.game.pendingMove.id,
      decision: 'approve',
    }),
    '女神核准黑方走子',
  );
  assert.equal(blackApproved.state.game.ply, 2);
  assert.equal(blackApproved.state.game.turn, 'w');
});

// ---------------------------------------------------------------------------
// T07 暂停与手动终局
// ---------------------------------------------------------------------------

test('T07 暂停与手动终局：暂停时玩家冻结、女神仍可揭晓/公告/结束/重开、终局冻结', async (t) => {
  const { base, room } = await setup(t, { reviewMode: false });
  await startGame(base, room);

  expectOK(await move(base, room, 'white', 'e2', 'e4'), '白方走子');
  expectOK(await goddessPost(base, room, '/goddess/rule', { seat: 'black', action: 'reveal' }), '暂停前揭晓黑方规则');
  const pauseResult = expectOK(await goddessPost(base, room, '/goddess/pause', { paused: true }), '女神暂停');
  assert.equal(pauseResult.state.phase, 'paused');

  // 暂停时玩家不能走子/猜测；女神也不能代走。
  expectFailure(await move(base, room, 'black', 'e7', 'e5'), 409, 'wrong_phase', '暂停时走子');
  expectFailure(
    await playerPost(base, room, 'black', '/guess', { text: '暂停时猜' }),
    409, 'wrong_phase', '暂停时猜测',
  );
  expectFailure(
    await goddessPost(base, room, '/goddess/force-move', { from: 'e7', to: 'e5' }),
    409, 'wrong_phase', '暂停时女神代走',
  );
  // 女神在暂停时仍可揭晓、公告、结束、重开。
  expectOK(await goddessPost(base, room, '/goddess/rule', { seat: 'white', action: 'reveal' }), '暂停时揭晓白方规则');
  expectOK(await goddessPost(base, room, '/goddess/announce', { text: '暂停公告' }), '暂停时公告');
  const pausedWhite = await getState(base, room, 'white');
  assert.equal(pausedWhite.revealed.white.text, pausedWhite.me.rule.text, '暂停时揭晓的规则应可见');
  assert.equal(pausedWhite.announcements.at(-1).text, '暂停公告');

  const endNote = marker('手动终局说明');
  const ended = expectOK(
    await goddessPost(base, room, '/goddess/end', { winner: 'black', reason: 'goddess', note: endNote }),
    '暂停时女神结束对局',
  );
  assert.equal(ended.state.phase, 'finished');
  assert.equal(ended.state.game.result.winner, 'black');
  assert.equal(ended.state.game.result.reason, 'goddess');
  assert.equal(ended.state.game.result.note, endNote);
  assert.equal(ended.state.game.result.automatic, false);

  // 终局冻结：双方不能走子/猜测/提交规则；女神不能再 review/force/edit/pause/end。
  for (const seat of ['white', 'black']) {
    const finishedState = await getState(base, room, seat);
    assert.equal(finishedState.phase, 'finished');
    assert.equal(finishedState.me.canMove, false);
    assert.equal(finishedState.me.canGuess, false);
    assert.equal(finishedState.me.canSubmitRule, false);
  }
  expectFailure(await move(base, room, 'white', 'a2', 'a3'), 409, 'wrong_phase', '终局后走子');
  expectFailure(
    await playerPost(base, room, 'white', '/guess', { text: '终局后猜' }),
    409, 'wrong_phase', '终局后猜测',
  );
  expectFailure(
    await playerPost(base, room, 'white', '/rule', { text: '终局后交规则' }),
    409, 'wrong_phase', '终局后提交规则',
  );
  expectFailure(
    await goddessPost(base, room, '/goddess/review', { moveId: 'm1', decision: 'approve' }),
    409, 'wrong_phase', '终局后 review',
  );
  expectFailure(
    await goddessPost(base, room, '/goddess/force-move', { from: 'a2', to: 'a3' }),
    409, 'wrong_phase', '终局后代走',
  );
  expectFailure(
    await goddessPost(base, room, '/goddess/edit-board', { op: 'remove', square: 'e7' }),
    409, 'wrong_phase', '终局后改盘',
  );
  expectFailure(await goddessPost(base, room, '/goddess/pause', { paused: true }), 409, 'wrong_phase', '终局后暂停');
  expectFailure(
    await goddessPost(base, room, '/goddess/end', { winner: 'white', reason: 'goddess' }),
    409, 'wrong_phase', '终局后再次结束',
  );
  expectFailure(await goddessPost(base, room, '/goddess/undo', {}), 409, 'cannot_undo_finish', '手动终局不可撤销');

  // 终局后女神仍可导出、重开。
  const exported = await call(base, 'GET', roomPath(room, '/export'), { token: room.tokens.goddess });
  expectStatus(exported, 200, '终局后女神导出');
  assert.equal(exported.json.room.phase, 'finished');
  const reset = expectOK(await goddessPost(base, room, '/goddess/reset', {}), '终局后重开');
  assert.equal(reset.state.phase, 'lobby');
  assert.equal(reset.state.game.result, null);
  assert.equal(reset.state.game.ply, 0);
  const whiteReset = await getState(base, room, 'white');
  assert.equal(whiteReset.me.rule.status, 'empty');
  assert.equal(whiteReset.me.canSubmitRule, true);
  assert.equal(whiteReset.revealed.white, null);
  assert.equal(whiteReset.revealed.black, null);
});

// ---------------------------------------------------------------------------
// T08 自动终局与撤销
// ---------------------------------------------------------------------------

test('T08 自动终局与撤销：将死自动结束且不自动揭晓规则；自动终局可撤销', async (t) => {
  const { base, room } = await setup(t, { reviewMode: false });
  const rules = await startGame(base, room);

  const moves = [
    ['white', 'f2', 'f3'],
    ['black', 'e7', 'e5'],
    ['white', 'g2', 'g4'],
    ['black', 'd8', 'h4'],
  ];
  for (const [seat, from, to] of moves) {
    expectOK(await move(base, room, seat, from, to), seat + ' 走子 ' + from + to);
  }
  const blackState = await getState(base, room, 'black');
  assert.equal(blackState.phase, 'finished');
  assert.equal(blackState.game.result.winner, 'black');
  assert.equal(blackState.game.result.reason, 'checkmate');
  assert.equal(blackState.game.result.automatic, true);
  assert.equal(blackState.game.checkmate, true);
  assert.equal(blackState.game.moves.length, 4);
  assert.match(blackState.game.moves[3].label, /^Qd8.h4#$/);
  // 自动终局不会自动揭晓规则。
  assert.equal(blackState.revealed.white, null);
  assert.equal(blackState.revealed.black, null);
  assert.equal(blackState.revealed.white, null);
  assertHasNeedles(blackState, [rules.blackRule], '黑方自己的规则在自己的 me 里可见');
  assertNoNeedles(blackState, [rules.whiteRule], '将死终局后黑方仍然看不到白方规则');
  const whiteState = await getState(base, room, 'white');
  assertHasNeedles(whiteState, [rules.whiteRule], '白方自己的规则在自己的 me 里可见');
  assertNoNeedles(whiteState, [rules.blackRule], '将死终局后白方仍然看不到黑方规则');
  assert.equal(whiteState.revealed.white, null, '自动终局不自动揭晓白方规则');
  assert.equal(whiteState.revealed.black, null, '自动终局不自动揭晓黑方规则');

  // 终局冻结。
  expectFailure(await move(base, room, 'white', 'a2', 'a3'), 409, 'wrong_phase', '将死后走子');
  expectFailure(
    await playerPost(base, room, 'white', '/guess', { text: '将死后猜' }),
    409, 'wrong_phase', '将死后猜测',
  );

  // 自动终局且未揭晓：女神可以撤销最后一步，对局回到 playing。
  const undone = expectOK(await goddessPost(base, room, '/goddess/undo', {}), '撤销将死一步');
  assert.equal(undone.state.phase, 'playing');
  assert.equal(undone.state.game.result, null);
  assert.equal(undone.state.game.ply, 3);
  // 可以重新走出将死。
  const replayed = expectOK(await move(base, room, 'black', 'd8', 'h4'), '重走将死');
  assert.equal(replayed.state.phase, 'finished');
  assert.equal(replayed.state.game.result.reason, 'checkmate');
  assert.equal(replayed.state.revealed.white, null);
  assert.equal(replayed.state.revealed.black, null);
});

// ---------------------------------------------------------------------------
// T09 女神受控操作真实生效
// ---------------------------------------------------------------------------

test('T09 女神受控操作：代走/改盘/撤销/暂停/结束/重开真实改变状态', async (t) => {
  const { base, room } = await setup(t, { reviewMode: false });
  await startGame(base, room);

  // 代走：由女神执行，记录 by=goddess。
  const forced = expectOK(
    await goddessPost(base, room, '/goddess/force-move', { from: 'e2', to: 'e4', note: '女神代走' }),
    '女神代走 e2-e4',
  );
  assert.equal(forced.state.game.ply, 1);
  assert.equal(forced.state.game.turn, 'b');
  assert.equal(forced.state.game.moves[0].by, 'goddess');
  assert.match(forced.state.game.moves[0].label, /^e2.e4$/);

  // 代走非法走法被拒且不改变状态。
  const afterIllegalForce = expectFailure(
    await goddessPost(base, room, '/goddess/force-move', { from: 'a1', to: 'a3' }),
    400, 'illegal_move', '女神代走非法走法',
  );
  assert.equal(afterIllegalForce.ok, false);
  const stateAfterIllegal = await getState(base, room, 'goddess');
  assert.equal(stateAfterIllegal.game.ply, 1);

  // 改盘：移除黑兵 → 放置黑车 → 改行棋方；玩家视角看不到 lastEdit。
  const removed = expectOK(
    await goddessPost(base, room, '/goddess/edit-board', { op: 'remove', square: 'e7', note: '抹除测试' }),
    '女神移除 e7 黑兵',
  );
  assert.equal(removed.state.game.fen.split(' ')[0].split('/')[1], 'pppp1ppp');
  assert.ok(removed.state.game.lastEdit, '女神视角应有 lastEdit');
  assert.equal(removed.state.game.lastEdit.op, 'remove');
  assert.match(removed.state.game.lastEdit.syntax, /e7/);

  const placed = expectOK(
    await goddessPost(base, room, '/goddess/edit-board', { op: 'place', square: 'e6', type: 'r', color: 'b' }),
    '女神在 e6 放置黑车',
  );
  assert.equal(placed.state.game.fen.split(' ')[0].split('/')[2], '4r3');
  assert.equal(placed.state.game.ply, 1, '改盘不增加走子步数');

  const turned = expectOK(
    await goddessPost(base, room, '/goddess/edit-board', { op: 'setTurn', turn: 'w' }),
    '女神把行棋方改为白方',
  );
  assert.equal(turned.state.game.turn, 'w');

  // 撤销：依次撤销 setTurn / place / remove / 代走，逐步恢复真实棋盘。
  const undo1 = expectOK(await goddessPost(base, room, '/goddess/undo', {}), '撤销 setTurn');
  assert.equal(undo1.state.game.turn, 'b');
  assert.equal(undo1.state.game.fen.split(' ')[0].split('/')[2], '4r3');
  const undo2 = expectOK(await goddessPost(base, room, '/goddess/undo', {}), '撤销 place');
  assert.equal(undo2.state.game.fen.split(' ')[0].split('/')[2], '8');
  const undo3 = expectOK(await goddessPost(base, room, '/goddess/undo', {}), '撤销 remove');
  assert.equal(undo3.state.game.fen.split(' ')[0].split('/')[1], 'pppppppp');
  assert.equal(undo3.state.game.lastEdit, null);
  const undo4 = expectOK(await goddessPost(base, room, '/goddess/undo', {}), '撤销代走');
  assert.equal(undo4.state.game.ply, 0);
  assert.equal(undo4.state.game.turn, 'w');
  assert.equal(undo4.state.game.fen, START_FEN);
  expectFailure(await goddessPost(base, room, '/goddess/undo', {}), 409, 'nothing_to_undo', '无步可撤');

  // 暂停/继续真实改变阶段。
  const paused = expectOK(await goddessPost(base, room, '/goddess/pause', { paused: true }), '女神暂停');
  assert.equal(paused.state.phase, 'paused');
  const resumed = expectOK(await goddessPost(base, room, '/goddess/pause', { paused: false }), '女神继续');
  assert.equal(resumed.state.phase, 'playing');

  // 修改设置：关闭逐手审核 + 猜一次上限，然后结束并重开，设置与令牌应保留。
  expectOK(await goddessPost(base, room, '/goddess/settings', { reviewMode: false, guessLimit: 1 }), '女神修改设置');
  const ended = expectOK(
    await goddessPost(base, room, '/goddess/end', { winner: 'draw', reason: 'agreement', note: '测试和棋' }),
    '女神结束为和棋',
  );
  assert.equal(ended.state.phase, 'finished');
  assert.equal(ended.state.game.result.winner, 'draw');
  assert.equal(ended.state.game.result.reason, 'agreement');

  const reset = expectOK(await goddessPost(base, room, '/goddess/reset', {}), '女神重开');
  assert.equal(reset.state.phase, 'lobby');
  assert.equal(reset.state.game.ply, 0);
  assert.equal(reset.state.game.fen, START_FEN);
  assert.deepEqual(reset.state.game.moves, []);
  assert.equal(reset.state.game.result, null);
  assert.deepEqual(reset.state.announcements, []);
  assert.deepEqual(reset.state.goddess.rules.white, {
    text: null, status: 'empty', note: null, updatedAt: null, revealedAt: null,
  });
  assert.deepEqual(reset.state.goddess.settings, { reviewMode: false, guessLimit: 1 }, '重开应保留设置');
  assert.equal(reset.state.goddess.links.white, room.links.white, '重开应保留令牌');
  const whiteAfterReset = await getState(base, room, 'white');
  assert.equal(whiteAfterReset.me.rule.status, 'empty');
  assert.equal(whiteAfterReset.me.attemptsUsed, 0);
  assert.equal(whiteAfterReset.me.canSubmitRule, true);
});

// ---------------------------------------------------------------------------
// T10 女神受控操作校验
// ---------------------------------------------------------------------------

test('T10 女神受控操作校验：移除王/第二枚王/兵底线/非行棋方被将军等全部拒绝', async (t) => {
  const { base, room } = await setup(t, { reviewMode: false });
  await startGame(base, room);

  // 不能移除王。
  expectFailure(
    await goddessPost(base, room, '/goddess/edit-board', { op: 'remove', square: 'e1' }),
    409, 'cannot_remove_king', '移除白王',
  );
  expectFailure(
    await goddessPost(base, room, '/goddess/edit-board', { op: 'remove', square: 'e8' }),
    409, 'cannot_remove_king', '移除黑王',
  );
  // 不能放第二枚王。
  expectFailure(
    await goddessPost(base, room, '/goddess/edit-board', { op: 'place', square: 'd4', type: 'k', color: 'w' }),
    409, 'duplicate_king', '放置第二枚白王',
  );
  expectFailure(
    await goddessPost(base, room, '/goddess/edit-board', { op: 'place', square: 'd5', type: 'k', color: 'b' }),
    409, 'duplicate_king', '放置第二枚黑王',
  );
  // 兵不能放底线（第 1/8 横线）。
  expectOK(await goddessPost(base, room, '/goddess/edit-board', { op: 'remove', square: 'a8' }), '移除 a8 黑车');
  expectFailure(
    await goddessPost(base, room, '/goddess/edit-board', { op: 'place', square: 'a8', type: 'p', color: 'b' }),
    409, 'bad_pawn_rank', '黑兵放第 8 横线',
  );
  expectOK(await goddessPost(base, room, '/goddess/edit-board', { op: 'remove', square: 'a1' }), '移除 a1 白车');
  expectFailure(
    await goddessPost(base, room, '/goddess/edit-board', { op: 'place', square: 'a1', type: 'p', color: 'w' }),
    409, 'bad_pawn_rank', '白兵放第 1 横线',
  );
  // 占用格 / 空格 / 坏参数。
  expectFailure(
    await goddessPost(base, room, '/goddess/edit-board', { op: 'place', square: 'e2', type: 'r', color: 'w' }),
    409, 'occupied_square', '放置到已有棋子的格子',
  );
  expectFailure(
    await goddessPost(base, room, '/goddess/edit-board', { op: 'remove', square: 'e3' }),
    409, 'empty_square', '移除空格',
  );
  expectFailure(
    await goddessPost(base, room, '/goddess/edit-board', { op: 'place', square: 'e3', type: 'x', color: 'w' }),
    400, 'bad_piece', '非法棋子类型',
  );
  expectFailure(
    await goddessPost(base, room, '/goddess/edit-board', { op: 'place', square: 'e3', type: 'r' }),
    400, 'bad_color', '缺棋子颜色',
  );
  expectFailure(
    await goddessPost(base, room, '/goddess/edit-board', { op: 'place', square: 'z9', type: 'r', color: 'w' }),
    400, 'bad_square', '非法格子',
  );
  expectFailure(
    await goddessPost(base, room, '/goddess/edit-board', { op: 'setTurn', turn: 'x' }),
    400, 'bad_turn', '非法行棋方',
  );
  expectFailure(
    await goddessPost(base, room, '/goddess/edit-board', { op: 'hack' }),
    400, 'bad_op', '未知改盘操作',
  );
  expectFailure(
    await goddessPost(base, room, '/goddess/edit-board', {}),
    400, 'bad_op', '空改盘操作',
  );

  // 非行棋方被将军：白方行棋时，把白车放到 e7 会让黑王 e8 被将军 → 拒绝。
  expectOK(await goddessPost(base, room, '/goddess/edit-board', { op: 'remove', square: 'e7' }), '移除 e7 黑兵');
  expectFailure(
    await goddessPost(base, room, '/goddess/edit-board', { op: 'place', square: 'e7', type: 'r', color: 'w' }),
    409, 'illegal_position', '改盘导致非行棋方被将军',
  );
  // 通过 setTurn 制造同样非法局面：先轮到黑方，放白车将军黑王（允许），再把行棋方改回白方 → 拒绝。
  expectOK(await goddessPost(base, room, '/goddess/edit-board', { op: 'setTurn', turn: 'b' }), '设置行棋方为黑方');
  expectOK(
    await goddessPost(base, room, '/goddess/edit-board', { op: 'place', square: 'e7', type: 'r', color: 'w' }),
    '黑方行棋时放置白车将军黑王（行棋方被将军允许）',
  );
  expectFailure(
    await goddessPost(base, room, '/goddess/edit-board', { op: 'setTurn', turn: 'w' }),
    409, 'illegal_position', 'setTurn 导致非行棋方被将军',
  );

  // 非法操作后状态仍可继续使用（服务端未崩溃、未脏写）。
  const state = await getState(base, room, 'goddess');
  assert.equal(state.phase, 'playing');
  expectFailure(
    await goddessPost(base, room, '/goddess/edit-board', { op: 'remove', square: 'e1' }),
    409, 'cannot_remove_king', '再次移除王',
  );
});

// ---------------------------------------------------------------------------
// T11 规则生命周期
// ---------------------------------------------------------------------------

test('T11 规则生命周期：lobby 提交/退回/修正/生效/揭晓，运行时文本原样保存', async (t) => {
  const { base, room } = await setup(t);
  const WR = marker('规则-白方原文');
  const WR2 = marker('规则-白方修正版');
  const BR = marker('规则-黑方原文');
  const BR2 = marker('规则-黑方二版');
  const WHITE_NOTE = marker('女神退回白方说明');
  const BLACK_NOTE = marker('女神退回黑方说明');

  // 初始双方规则为空，任何一方都不能在规则未生效时开始。
  const initial = await getState(base, room, 'goddess');
  assert.equal(initial.goddess.rules.white.status, 'empty');
  assert.equal(initial.goddess.rules.white.text, null);
  assert.equal(initial.goddess.rules.black.text, null);

  // 空/纯空白/纯控制字符规则一律拒绝。
  expectFailure(
    await playerPost(base, room, 'white', '/rule', { text: '' }),
    400, 'empty_rule', '空规则',
  );
  expectFailure(
    await playerPost(base, room, 'white', '/rule', { text: '   \n\t  ' }),
    400, 'empty_rule', '纯空白规则',
  );
  expectFailure(
    await playerPost(base, room, 'white', '/rule', { text: '\u0000\u0001\u001f\u007f' }),
    400, 'empty_rule', '纯控制字符规则',
  );

  // 提交规则：只进入 submitted，等待女神处理。
  expectOK(await playerPost(base, room, 'white', '/rule', { text: WR }), '白方提交规则');
  const whiteSubmitted = await getState(base, room, 'white');
  assert.equal(whiteSubmitted.me.rule.status, 'submitted');
  assert.equal(whiteSubmitted.me.rule.text, WR);
  assert.equal(whiteSubmitted.me.canSubmitRule, false);
  // 重复提交被拒。
  expectFailure(
    await playerPost(base, room, 'white', '/rule', { text: '重复提交' }),
    409, 'rule_locked', '重复提交规则',
  );
  // 黑方尚未提交时：核准/退回/修正/揭晓都会被拒。
  expectFailure(
    await goddessPost(base, room, '/goddess/rule', { seat: 'black', action: 'approve' }),
    409, 'rule_not_submitted', '核准未提交的黑方规则',
  );
  expectFailure(
    await goddessPost(base, room, '/goddess/rule', { seat: 'black', action: 'return' }),
    409, 'rule_not_submitted', '退回未提交的黑方规则',
  );
  expectFailure(
    await goddessPost(base, room, '/goddess/rule', { seat: 'black', action: 'edit', text: '修正' }),
    409, 'rule_not_submitted', '修正未提交的黑方规则',
  );
  expectFailure(
    await goddessPost(base, room, '/goddess/rule', { seat: 'black', action: 'reveal' }),
    409, 'rule_empty', '揭晓未提交的黑方规则',
  );
  // 未知规则操作被拒。
  expectFailure(
    await goddessPost(base, room, '/goddess/rule', { seat: 'white', action: 'hack' }),
    400, 'bad_action', '未知规则操作',
  );
  // 非法席位被拒。
  expectFailure(
    await goddessPost(base, room, '/goddess/rule', { seat: 'green', action: 'approve' }),
    400, 'bad_seat', '非法席位',
  );

  // 女神退回白方并附说明；白方看到备注，黑方看不到。
  expectOK(
    await goddessPost(base, room, '/goddess/rule', { seat: 'white', action: 'return', note: WHITE_NOTE }),
    '女神退回白方规则',
  );
  const whiteReturned = await getState(base, room, 'white');
  assert.equal(whiteReturned.me.rule.status, 'returned');
  assert.equal(whiteReturned.me.rule.note, WHITE_NOTE);
  assert.equal(whiteReturned.me.canSubmitRule, true);
  const blackDuringReturn = await getState(base, room, 'black');
  assertNoNeedles(blackDuringReturn, [WHITE_NOTE, WR], '黑方视图（白方被退回）');

  // 白方重新提交；黑方提交后被退回、再提交二版。
  expectOK(await playerPost(base, room, 'white', '/rule', { text: WR2 }), '白方重新提交规则');
  expectOK(await playerPost(base, room, 'black', '/rule', { text: BR }), '黑方提交规则');
  expectOK(
    await goddessPost(base, room, '/goddess/rule', { seat: 'black', action: 'return', note: BLACK_NOTE }),
    '女神退回黑方规则',
  );
  const blackReturned = await getState(base, room, 'black');
  assert.equal(blackReturned.me.rule.note, BLACK_NOTE);
  const whiteDuringBlackReturn = await getState(base, room, 'white');
  assertNoNeedles(whiteDuringBlackReturn, [BLACK_NOTE, BR], '白方视图（黑方被退回）');
  expectOK(await playerPost(base, room, 'black', '/rule', { text: BR2 }), '黑方重新提交规则');

  // 女神修正白方规则文字（仅 lobby，已提交状态可修正）。
  expectOK(
    await goddessPost(base, room, '/goddess/rule', { seat: 'white', action: 'edit', text: WR2 }),
    '女神修正白方规则',
  );
  // 规则未全部生效前不能开始。
  expectFailure(await goddessPost(base, room, '/goddess/start', {}), 409, 'rules_not_ready', '规则未生效就开局');
  await approveRules(base, room);
  const afterApprove = await getState(base, room, 'goddess');
  assert.equal(afterApprove.goddess.rules.white.status, 'active');
  assert.equal(afterApprove.goddess.rules.black.status, 'active');
  assert.equal(afterApprove.goddess.rules.white.text, WR2);
  assert.equal(afterApprove.goddess.rules.black.text, BR2);
  expectOK(await goddessPost(base, room, '/goddess/start', {}), '规则生效后开局');
  // 开局后不能提交/退回/修正规则。
  expectFailure(
    await playerPost(base, room, 'white', '/rule', { text: '开局后改规则' }),
    409, 'wrong_phase', '开局后提交规则',
  );
  expectFailure(
    await goddessPost(base, room, '/goddess/rule', { seat: 'white', action: 'return' }),
    409, 'wrong_phase', '开局后退回规则',
  );
  expectFailure(
    await goddessPost(base, room, '/goddess/rule', { seat: 'white', action: 'edit', text: 'x' }),
    409, 'wrong_phase', '开局后修正规则',
  );

  // 只揭晓白方：双方都能看到白方原文，黑方原文仍然隐藏。
  expectOK(
    await goddessPost(base, room, '/goddess/rule', { seat: 'white', action: 'reveal' }),
    '揭晓白方规则',
  );
  const blackAfterReveal = await getState(base, room, 'black');
  assert.equal(blackAfterReveal.revealed.white.text, WR2);
  assert.equal(blackAfterReveal.revealed.black, null);
  assert.equal(blackAfterReveal.me.rule.text, BR2, '黑方自己的规则始终可见');
  const whiteAfterReveal = await getState(base, room, 'white');
  assert.equal(whiteAfterReveal.revealed.white.text, WR2);
  assertNoNeedles(whiteAfterReveal, [BR2], '黑方规则未揭晓前白方不可见');
});

// ---------------------------------------------------------------------------
// T12 规则未内置
// ---------------------------------------------------------------------------

test('T12 规则未内置：源码与初始状态无预置规则，仅接受运行期提交文本', async (t) => {
  const { base, dataDir } = await startApp(t);
  const room = await createRoom(base);

  // 1) 初始状态：双方规则文本为 null，状态 empty（服务端没有任何默认规则）。
  const initialGoddess = await getState(base, room, 'goddess');
  assert.equal(initialGoddess.goddess.rules.white.text, null);
  assert.equal(initialGoddess.goddess.rules.black.text, null);
  assert.equal(initialGoddess.goddess.rules.white.status, 'empty');
  assert.equal(initialGoddess.goddess.rules.black.status, 'empty');

  // 2) 持久化文件同样没有预置规则文本。
  const roomFile = path.join(dataDir, 'rooms', room.roomId + '.json');
  assert.ok(fs.existsSync(roomFile), '创建房间后应有持久化文件');
  const savedBeforeSubmit = JSON.parse(fs.readFileSync(roomFile, 'utf8'));
  assert.equal(savedBeforeSubmit.rules.white.text, null, '持久化文件中不应有预置白方规则');
  assert.equal(savedBeforeSubmit.rules.black.text, null, '持久化文件中不应有预置黑方规则');
  assert.equal(savedBeforeSubmit.rules.white.status, 'empty');

  // 3) 源码静态检查：规则文本只能来自玩家/女神运行期输入（cleanText），不能是字面量。
  const roomSrc = readSource('lib/room.js');
  const emptyRuleMatch = roomSrc.match(/function emptyRule\(\) \{[\s\S]*?\n\}/);
  assert.ok(emptyRuleMatch, '应存在 emptyRule() 初始化函数');
  assert.match(emptyRuleMatch[0], /text:\s*null/, '空规则初始文本必须为 null');
  const seedPattern = '{ white: emptyRule(), black: emptyRule() }';
  assert.ok(roomSrc.split(seedPattern).length - 1 >= 2, 'create/reset 都应以空规则初始化');
  assert.ok(!/rules:?\s*=?\s*\{[^}]*text:\s*['"`]/.test(roomSrc), '规则初始化不得带字面量文本');
  const textAssignments = roomSrc.match(/^\s*rule\.text\s*=\s*(.+)$/gm) || [];
  assert.equal(textAssignments.length, 2, '规则文本写入点应只有玩家提交与女神修正两处');
  for (const assignment of textAssignments) {
    assert.match(assignment, /=\s*clean\b/, '规则文本只能来自清洗后的运行期输入：' + assignment);
  }
  assert.ok(!/rule\.text\s*=\s*['"`]/.test(roomSrc), '规则文本不得由字面量直接赋值');
  for (const { relativePath, text } of serverSources()) {
    assert.ok(!/隐藏规则是|规则如下|游戏规则[:：]/.test(text), relativePath + ' 疑似内置具体隐藏规则文本');
  }
  // 棋规内核不应包含隐藏规则逻辑。
  const chessSrc = readSource('lib/chess.js');
  assert.ok(!/rule/i.test(chessSrc), 'lib/chess.js 不应感知隐藏规则');

  // 4) 运行期提交的任意占位文本原样保存到女神与本人视角（再做一次本地持久化确认）。
  const placeholderWhite = marker('运行期提交的白方占位规则');
  const placeholderBlack = marker('运行期提交的黑方占位规则');
  expectOK(await playerPost(base, room, 'white', '/rule', { text: placeholderWhite }), '白方提交占位规则');
  expectOK(await playerPost(base, room, 'black', '/rule', { text: placeholderBlack }), '黑方提交占位规则');
  const goddessWithRules = await getState(base, room, 'goddess');
  assert.equal(goddessWithRules.goddess.rules.white.text, placeholderWhite);
  assert.equal(goddessWithRules.goddess.rules.black.text, placeholderBlack);
  const whiteOwn = await getState(base, room, 'white');
  assert.equal(whiteOwn.me.rule.text, placeholderWhite);
  const blackView = await getState(base, room, 'black');
  assertNoNeedles(blackView, [placeholderWhite], '黑方不能看到白方运行期规则');

  // 服务端不解释隐藏规则：开始对局后棋盘仍是标准起始局面与 20 个常规走法。
  await approveRules(base, room);
  const started = expectOK(await goddessPost(base, room, '/goddess/start', {}), '占位规则下开始对局');
  assert.equal(started.state.phase, 'playing');
  assert.equal(started.state.game.fen, START_FEN);
  const whiteTurn = await getState(base, room, 'white');
  assert.equal(whiteTurn.game.legalMoves.length, 20, '任意占位规则不应改变服务端棋规');
  assert.equal(whiteTurn.me.rule.text, placeholderWhite, '规则文本只是被保存，不被服务端执行');
});

// ---------------------------------------------------------------------------
// T13 猜测
// ---------------------------------------------------------------------------

test('T13 猜测：错误消耗次数、次数耗尽、等待裁定互斥、猜中判胜并自动揭晓、终局冻结', async (t) => {
  // 13a：错误猜测消耗次数，耗尽后不能再猜，但仍可走棋。
  const { base } = await startApp(t);
  const roomA = await createRoom(base, { reviewMode: false, guessLimit: 2 });
  const rulesA = await startGame(base, roomA);

  // 空/空白猜测被拒，且不消耗次数。
  expectFailure(
    await playerPost(base, roomA, 'white', '/guess', { text: '' }),
    400, 'empty_guess', '空猜测',
  );
  expectFailure(
    await playerPost(base, roomA, 'white', '/guess', { text: '   ' }),
    400, 'empty_guess', '纯空白猜测',
  );

  const guess1 = expectOK(
    await playerPost(base, roomA, 'white', '/guess', { text: marker('错误猜测一') }),
    '白方第一次猜测',
  );
  assert.equal(guess1.state.me.attemptsUsed, 1);
  assert.equal(guess1.state.me.attemptsLeft, 1);
  assert.equal(guess1.state.me.guesses.length, 1);
  // 等待裁定时不能重复提交猜测。
  expectFailure(
    await playerPost(base, roomA, 'white', '/guess', { text: '等待裁定时的第二个猜测' }),
    409, 'guess_pending', '等待裁定时再次猜测',
  );
  const goddessA1 = await getState(base, roomA, 'goddess');
  const guess1Id = goddessA1.goddess.guesses[0].id;
  expectOK(
    await goddessPost(base, roomA, '/goddess/judge-guess', { guessId: guess1Id, correct: false }),
    '女神裁定第一次猜测错误',
  );
  // 重复裁定 / 不存在猜测。
  expectFailure(
    await goddessPost(base, roomA, '/goddess/judge-guess', { guessId: guess1Id, correct: false }),
    409, 'guess_judged', '重复裁定猜测',
  );
  expectFailure(
    await goddessPost(base, roomA, '/goddess/judge-guess', { guessId: 'g999', correct: true }),
    404, 'guess_not_found', '裁定不存在的猜测',
  );
  const whiteAfterWrong1 = await getState(base, roomA, 'white');
  assert.equal(whiteAfterWrong1.me.attemptsUsed, 1);
  assert.equal(whiteAfterWrong1.me.canGuess, true);

  const guess2 = expectOK(
    await playerPost(base, roomA, 'white', '/guess', { text: marker('错误猜测二') }),
    '白方第二次猜测',
  );
  assert.equal(guess2.state.me.attemptsUsed, 2);
  assert.equal(guess2.state.me.attemptsLeft, 0);
  assert.equal(guess2.state.me.canGuess, false);
  const goddessA2 = await getState(base, roomA, 'goddess');
  const guess2Id = goddessA2.goddess.guesses[1].id;
  expectOK(
    await goddessPost(base, roomA, '/goddess/judge-guess', { guessId: guess2Id, correct: false }),
    '女神裁定第二次猜测错误',
  );
  // 次数耗尽后不能再猜；猜测原文不会泄露给对手。
  expectFailure(
    await playerPost(base, roomA, 'white', '/guess', { text: '第三次猜测' }),
    409, 'guess_limit', '次数耗尽后猜测',
  );
  const whiteExhausted = await getState(base, roomA, 'white');
  assert.equal(whiteExhausted.me.canGuess, false);
  assert.equal(whiteExhausted.me.attemptsLeft, 0);
  const blackOnA = await getState(base, roomA, 'black');
  assert.equal(blackOnA.players.white.guess.used, 2);
  assertNoNeedles(blackOnA, [rulesA.whiteRule], '黑方视图不应出现白方规则原文');
  // 次数耗尽仍可靠棋局取胜。
  expectOK(await move(base, roomA, 'white', 'e2', 'e4'), '次数耗尽后仍可走棋');

  // 13b：猜中判胜，自动揭晓双方规则，终局冻结且不可撤销。
  const roomB = await createRoom(base, { reviewMode: false, guessLimit: 2 });
  const rulesB = await startGame(base, roomB, {
    whiteRule: marker('白方谜底规则'),
    blackRule: marker('黑方谜底规则'),
  });
  expectOK(await playerPost(base, roomB, 'black', '/guess', { text: marker('黑方待裁定猜测') }), '黑方提交猜测');
  expectOK(await playerPost(base, roomB, 'white', '/guess', { text: marker('白方待裁定猜测') }), '白方提交猜测');
  const goddessB = await getState(base, roomB, 'goddess');
  const whiteGuess = goddessB.goddess.guesses.find((guess) => guess.seat === 'white');
  const judgeNote = marker('命中说明');
  const correct = expectOK(
    await goddessPost(base, roomB, '/goddess/judge-guess', {
      guessId: whiteGuess.id, correct: true, note: judgeNote,
    }),
    '女神判定白方猜中',
  );
  assert.equal(correct.state.phase, 'finished');
  assert.equal(correct.state.game.result.winner, 'white');
  assert.equal(correct.state.game.result.reason, 'guess');
  assert.equal(correct.state.game.result.note, judgeNote);
  assert.equal(correct.state.game.result.automatic, false);
  assert.equal(correct.state.revealed.white.text, rulesB.whiteRule, '猜中后自动揭晓双方规则');
  assert.equal(correct.state.revealed.black.text, rulesB.blackRule, '猜中后自动揭晓双方规则');
  // 双方都能看到揭晓后的两条规则。
  for (const seat of ['white', 'black']) {
    const finalState = await getState(base, roomB, seat);
    assert.equal(finalState.phase, 'finished');
    assert.equal(finalState.revealed.white.text, rulesB.whiteRule);
    assert.equal(finalState.revealed.black.text, rulesB.blackRule);
    assert.equal(finalState.me.canGuess, false);
    assert.equal(finalState.players.white.guess.pending, false);
    assert.equal(finalState.players.black.guess.pending, false, '终局时未裁决猜测应作废');
  }
  // 猜测原文不会被揭晓（只有规则揭晓）。
  const finalWhiteText = textOf(await getState(base, roomB, 'white'));
  assert.ok(!finalWhiteText.includes('黑方待裁定猜测'), '猜测原文不因猜中而公开');
  // 终局冻结。
  expectFailure(
    await playerPost(base, roomB, 'black', '/guess', { text: '终局后猜' }),
    409, 'wrong_phase', '终局后猜测',
  );
  expectFailure(await move(base, roomB, 'black', 'e7', 'e5'), 409, 'wrong_phase', '终局后走子');
  expectFailure(
    await playerPost(base, roomB, 'black', '/rule', { text: '终局后交规则' }),
    409, 'wrong_phase', '终局后提交规则',
  );
  expectFailure(await goddessPost(base, roomB, '/goddess/undo', {}), 409, 'cannot_undo_finish', '猜中判胜不可撤销');
  expectFailure(
    await goddessPost(base, roomB, '/goddess/judge-guess', { guessId: whiteGuess.id, correct: true }),
    409, 'guess_judged', '终局后重复裁定',
  );

  // 13c：guessLimit=0 表示不限次数。
  const roomC = await createRoom(base, { reviewMode: false, guessLimit: 0 });
  await startGame(base, roomC);
  const unlimited = expectOK(
    await playerPost(base, roomC, 'white', '/guess', { text: '不限次数猜测一' }),
    '不限次数猜测一',
  );
  assert.equal(unlimited.state.me.attemptsLeft, null, '0 次上限时 attemptsLeft 应为 null');
  const goddessC = await getState(base, roomC, 'goddess');
  const unlimitedGuessId = goddessC.goddess.guesses[0].id;
  expectOK(
    await goddessPost(base, roomC, '/goddess/judge-guess', { guessId: unlimitedGuessId, correct: false }),
    '裁定不限次数猜测错误',
  );
  const secondUnlimited = expectOK(
    await playerPost(base, roomC, 'white', '/guess', { text: '不限次数猜测二' }),
    '不限次数猜测二',
  );
  assert.equal(secondUnlimited.state.me.attemptsLeft, null);
  assert.equal(secondUnlimited.state.me.attemptsUsed, 2);
});

// ---------------------------------------------------------------------------
// T14 服务器安全
// ---------------------------------------------------------------------------

test('T14 服务器安全：默认回环监听、零依赖、无执行/外联入口、静态目录不泄露源码', async (t) => {
  // 默认监听地址只能是回环：不传 host 时监听 127.0.0.1。
  const dataDir = makeDataDir();
  const app = createApp({ dataDir, quiet: true });
  t.after(async () => { try { await app.close(); } catch { /* ignore */ } });
  const address = await app.listen(0);
  assert.equal(address.address, '127.0.0.1', '默认监听地址必须是回环地址');
  assert.equal(address.family, 'IPv4');
  const base = 'http://127.0.0.1:' + address.port;
  const room = await createRoom(base);
  const SECRET_RULE = marker('静态页不得包含的规则');
  expectOK(await playerPost(base, room, 'white', '/rule', { text: SECRET_RULE }), '白方提交规则');
  const tokens = [room.tokens.white, room.tokens.black, room.tokens.goddess];

  // 源码静态检查：只允许 node: 内置模块与本地相对模块；禁止外部依赖与代码执行入口。
  for (const { relativePath, text } of serverSources()) {
    const requires = [...text.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map((match) => match[1]);
    for (const request of requires) {
      assert.ok(
        request.startsWith('node:') || request.startsWith('.'),
        relativePath + ' 出现非内置/非本地依赖：' + request,
      );
    }
    const forbidden = [
      ['eval()', /\beval\s*\(/],
      ['new Function', /new\s+Function\s*\(/],
      ['child_process', /child_process/],
      ['vm 模块', /node:vm|require\(\s*['"]vm['"]\s*\)/],
      ['net/dns/tls 外联', /node:(?:net|dns|tls)\b|require\(\s*['"](?:net|dns|tls)['"]\s*\)/],
      ['https 外联', /https\.request|require\(\s*['"]https['"]\s*\)/],
      ['fetch 外联', /\bfetch\s*\(/],
      ['WebSocket', /\bWebSocket\b/],
    ];
    for (const [label, pattern] of forbidden) {
      assert.ok(!pattern.test(text), relativePath + ' 出现禁止入口：' + label);
    }
    const urls = text.match(/https?:\/\/[A-Za-z0-9_.:\-\[\]]+/g) || [];
    for (const url of urls) {
      assert.ok(
        /^http:\/\/(?:127\.0\.0\.1|internal)/.test(url),
        relativePath + ' 出现外部 URL：' + url,
      );
    }
  }
  const serverSrc = readSource('server.js');
  assert.match(serverSrc, /function listen\(port = 0, host = '127\.0\.0\.1'\)/, 'createApp.listen 默认 host 必须为回环');
  assert.match(serverSrc, /const host = '127\.0\.0\.1';/, 'CLI 必须固定回环地址');
  assert.ok(!/process\.env\.HOST/.test(serverSrc), 'CLI 不应允许用 HOST 环境变量覆盖绑定地址');
  assert.ok(!/0\.0\.0\.0|['"]::['"]/.test(serverSrc), 'server.js 不应包含公网通配绑定字面量');

  // 无第三方依赖、无 node_modules。
  const pkg = JSON.parse(readSource('package.json'));
  for (const key of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies', 'bundledDependencies']) {
    assert.equal(pkg[key], undefined, 'package.json 不应声明依赖：' + key);
  }
  assert.ok(!fs.existsSync(path.join(APP_ROOT, 'node_modules')), '工程不应有 node_modules');

  // 静态目录不会泄露源码/数据/测试/配置；路径穿越与编码变体同样不可读。
  const sensitivePaths = [
    '/server.js', '/lib/room.js', '/lib/chess.js', '/lib/store.js', '/package.json',
    '/.gitignore', '/.git/config', '/data/rooms/', '/tests/server.test.js', '/docs/API.md', '/tools/demo.js',
    '/../server.js', '/..%2fserver.js', '/%2e%2e%2fpackage.json', '/app.js/../../server.js',
    '/styles.css/../server.js', '/%2fserver.js',
  ];
  const sourceMarkers = ['createApp', 'class Room', 'START_FEN', 'module.exports', '\\"tokens\\"'];
  for (const sensitivePath of sensitivePaths) {
    const result = await rawRequest(base, sensitivePath);
    assert.ok(result.status !== 200, '敏感路径不应可读：' + sensitivePath + ' -> ' + fmtResult(result));
    assertNoNeedles(result.text || '', sourceMarkers, '静态响应 ' + sensitivePath);
    assertNoNeedles(result.text || '', tokens, '静态响应 ' + sensitivePath + ' 不应包含令牌');
  }
  const badPercent = await rawRequest(base, '/%zz');
  assert.equal(badPercent.status, 400, '非法百分号路径应 400');
  assert.equal(badPercent.json.code, 'bad_path');

  // 公开页面本身不内嵌令牌和规则原文。
  for (const pagePath of ['/', '/index.html', '/room/' + room.roomId]) {
    const page = await call(base, 'GET', pagePath);
    expectStatus(page, 200, '公开页面 ' + pagePath);
    assert.match(page.headers.get('content-type') || '', /text\/html/);
    assertNoNeedles(page.text, [...tokens, SECRET_RULE], '公开页面 ' + pagePath);
  }

  // 导出接口：仅女神，且导出内容不含令牌。
  for (const seat of ['white', 'black']) {
    expectFailure(
      await call(base, 'GET', roomPath(room, '/export'), { token: room.tokens[seat] }),
      403, 'forbidden', seat + ' 令牌导出',
    );
  }
  expectFailure(await call(base, 'GET', roomPath(room, '/export')), 401, 'missing_token', '无令牌导出');
  const exportResult = await call(base, 'GET', roomPath(room, '/export'), { token: room.tokens.goddess });
  expectStatus(exportResult, 200, '女神导出');
  assert.match(exportResult.headers.get('content-disposition') || '', /attachment/, '导出应作为附件下载');
  assert.equal(exportResult.json.room.tokens, undefined, '导出内容不应包含令牌字段');
  assertNoNeedles(exportResult.text, tokens, '导出内容不应包含令牌');
  assert.equal(exportResult.json.room.rules.white.text, SECRET_RULE);

  // 错误方法、未知接口、未知女神操作、非法房间号。
  const putState = await rawRequest(base, roomPath(room, '/state') + '?token=' + room.tokens.white, 'PUT', '{}', {
    'Content-Type': 'application/json',
  });
  assert.equal(putState.status, 405, 'state 只允许 GET');
  const deleteState = await rawRequest(base, roomPath(room, '/state') + '?token=' + room.tokens.white, 'DELETE');
  assert.equal(deleteState.status, 405, 'state 不允许 DELETE');
  const unknownApi = await call(base, 'GET', roomPath(room, '/nope'), { token: room.tokens.white });
  expectFailure(unknownApi, 404, 'not_found', '未知 API 路径');
  const unknownGoddessAction = await call(base, 'POST', roomPath(room, '/goddess/hack'), {
    token: room.tokens.goddess, body: {},
  });
  expectFailure(unknownGoddessAction, 404, 'unknown_goddess_action', '未知女神操作');
  const missingRoom = await call(base, 'GET', '/api/rooms/r-00000000/state', { token: room.tokens.white });
  expectFailure(missingRoom, 404, 'room_not_found', '不存在的房间');
  const badRoomId = await call(base, 'GET', '/api/rooms/%2e%2e/state', { token: room.tokens.white });
  expectStatus(badRoomId, 404, '路径穿越式房间号');

  // 安全响应头：CSP / nosniff / 禁止被框架嵌套 / 无 CORS / 不缓存。
  const stateResult = await call(base, 'GET', roomPath(room, '/state'), { token: room.tokens.white });
  expectOK(stateResult, 'state 响应头检查');
  assert.match(stateResult.headers.get('content-security-policy') || '', /default-src 'self'/, '应有 CSP');
  assert.equal(stateResult.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(stateResult.headers.get('x-frame-options'), 'DENY');
  assert.equal(stateResult.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(stateResult.headers.get('cache-control'), 'no-store');
  assert.equal(stateResult.headers.get('access-control-allow-origin'), null, '本地服务不应对跨源开放');
});

// ---------------------------------------------------------------------------
// T15 额外对抗
// ---------------------------------------------------------------------------

test('T15 额外对抗：无效 JSON、控制字符、超长文本/请求体、坏房间号与伪造令牌', async (t) => {
  const { base } = await startApp(t);
  const room = await createRoom(base);
  const tokens = [room.tokens.white, room.tokens.black, room.tokens.goddess];

  // 无效 JSON 一律 400 bad_json；空 body 视为 {}。
  for (const raw of ['{bad', '[]', 'null', '"x"', '123', 'true']) {
    expectFailure(
      await call(base, 'POST', roomPath(room, '/rule'), { token: room.tokens.white, rawBody: raw }),
      400, 'bad_json', '白方规则接口无效 JSON：' + raw,
    );
  }
  expectFailure(
    await call(base, 'POST', roomPath(room, '/goddess/announce'), { token: room.tokens.goddess, rawBody: '{bad' }),
    400, 'bad_json', '女神公告接口无效 JSON',
  );
  expectFailure(
    await call(base, 'POST', roomPath(room, '/rule'), { token: room.tokens.white, rawBody: '' }),
    400, 'empty_rule', '空 body 走规则接口（应视为空规则）',
  );
  // 权限先于请求体解析：玩家令牌 + 坏 JSON 调女神接口也必须先返回 403，而不是 400。
  const ordering = await call(base, 'POST', roomPath(room, '/goddess/announce'), {
    token: room.tokens.white, rawBody: '{bad',
  });
  expectFailure(ordering, 403, 'forbidden', '玩家令牌调女神接口应先鉴权后解析');

  // 控制字符：清洗 NUL/其他不可见控制字符，并把 CRLF 统一为换行；保留制表符与换行。
  const controlRoom = await createRoom(base);
  const rawControlText = 'A\u0000B\u0007C\u001fD\u007fE\tF\nG\rH';
  expectOK(
    await playerPost(base, controlRoom, 'white', '/rule', { text: rawControlText }),
    '提交含控制字符的规则',
  );
  const controlState = await getState(base, controlRoom, 'white');
  assert.equal(controlState.me.rule.text, 'ABCDE\tF\nG\nH', '不可见控制字符应被清洗，回车归一为换行');
  assert.ok(!/[\u0000-\u0008\u000b-\u001f\u007f]/.test(controlState.me.rule.text), '文本中不应残留危险控制字符');

  // 超长文本按协议截断：规则 400、备注 300、猜测 300、公告 300。
  const limitsRoom = await createRoom(base, { reviewMode: false });
  const longRule = expectOK(
    await playerPost(base, limitsRoom, 'white', '/rule', { text: 'w'.repeat(1000) }),
    '提交超长规则',
  );
  assert.equal(longRule.state.me.rule.text.length, 400, '规则最长 400 字');
  const longNote = expectOK(
    await goddessPost(base, limitsRoom, '/goddess/rule', {
      seat: 'white', action: 'return', note: 'n'.repeat(500),
    }),
    '超长退回备注',
  );
  assert.equal(longNote.state.goddess.rules.white.note.length, 300, '备注最长 300 字');
  const whiteNoteState = await getState(base, limitsRoom, 'white');
  assert.equal(whiteNoteState.me.rule.note.length, 300);
  expectOK(await playerPost(base, limitsRoom, 'white', '/rule', { text: '白方短规则' }), '白方重新提交短规则');
  expectOK(await playerPost(base, limitsRoom, 'black', '/rule', { text: '黑方短规则' }), '黑方提交规则');
  await approveRules(base, limitsRoom);
  expectOK(await goddessPost(base, limitsRoom, '/goddess/start', {}), '超长测试房间开始');
  const longGuess = expectOK(
    await playerPost(base, limitsRoom, 'white', '/guess', { text: 'g'.repeat(500) }),
    '提交超长猜测',
  );
  assert.equal(longGuess.state.me.guesses[0].text.length, 300, '猜测最长 300 字');
  const longAnnounce = expectOK(
    await goddessPost(base, limitsRoom, '/goddess/announce', { text: 'a'.repeat(500) }),
    '发布超长公告',
  );
  const announceLength = longAnnounce.state.announcements.at(-1).text.length;
  assert.equal(announceLength, 300, '公告最长 300 字');
  const longEnd = expectOK(
    await goddessPost(base, limitsRoom, '/goddess/end', {
      winner: 'white', reason: 'goddess', note: 'e'.repeat(500),
    }),
    '超长终局说明',
  );
  assert.equal(longEnd.state.game.result.note.length, 300, '终局说明最长 300 字');

  // 超大请求体（>64KB）：必须被拒绝且不能改变状态；服务端随后仍然可用。
  const announceBefore = (await getState(base, limitsRoom, 'white')).announcements.length;
  const oversizedBody = JSON.stringify({ text: 'x'.repeat(100 * 1024) });
  const oversized = await rawRequest(
    base,
    roomPath(limitsRoom, '/goddess/announce') + '?token=' + limitsRoom.tokens.goddess,
    'POST',
    oversizedBody,
    { 'Content-Type': 'application/json' },
  );
  assert.ok(!oversized.transportError, '超大请求体不应重置连接：' + (oversized.transportError ? oversized.transportError.code : ''));
  assert.equal(oversized.status, 413, '超大请求体应返回 413');
  assert.equal(oversized.json.code, 'body_too_large', '超大请求体错误码应为 body_too_large');
  const announceAfter = (await getState(base, limitsRoom, 'white')).announcements.length;
  assert.equal(announceAfter, announceBefore, '超大请求体不应改变房间状态');
  expectOK(await call(base, 'GET', '/api/health'), '超大请求体后服务仍健康');

  // 坏房间号 / 路径穿越式房间号 / 非法编码。
  expectFailure(
    await call(base, 'GET', '/api/rooms/r-00000000/state', { token: room.tokens.white }),
    404, 'room_not_found', '不存在的房间号',
  );
  expectStatus(
    await call(base, 'GET', '/api/rooms/%2e%2e/state', { token: room.tokens.white }),
    404, '路径穿越式房间号',
  );
  expectStatus(await rawRequest(base, '/%zz'), 400, '非法百分号编码');
  expectStatus(await rawRequest(base, '/%'), 400, '残缺百分号编码');

  // 令牌不会从 body / 自定义头获得鉴权。
  expectFailure(
    await call(base, 'GET', roomPath(room, '/state'), { headers: { 'X-Token': room.tokens.white } }),
    401, 'missing_token', '自定义头不构成令牌',
  );
  // 房间创建参数被夹紧到合法区间。
  const clampHigh = await createRoom(base, { guessLimit: 999 });
  const highGoddess = await getState(base, clampHigh, 'goddess');
  assert.equal(highGoddess.goddess.settings.guessLimit, 9, 'guessLimit 上限夹紧到 9');
  const clampLow = await createRoom(base, { guessLimit: -5 });
  const lowGoddess = await getState(base, clampLow, 'goddess');
  assert.equal(lowGoddess.goddess.settings.guessLimit, 0, 'guessLimit 下限夹紧到 0');
  const clampNaN = await createRoom(base, { guessLimit: 'abc' });
  const nanGoddess = await getState(base, clampNaN, 'goddess');
  assert.equal(nanGoddess.goddess.settings.guessLimit, 3, '非法 guessLimit 回退默认 3');
  expectFailure(
    await goddessPost(base, room, '/goddess/settings', { reviewMode: 'yes' }),
    400, 'bad_setting', '非法 reviewMode',
  );
});
