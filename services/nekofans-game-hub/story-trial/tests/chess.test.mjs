import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const chess = require('../lib/chess.js');

const seatEntries = (ucis) => ucis.map((action, index) => ({ seat: index % 2, action }));
const replay = (ucis) => chess.replayActions(seatEntries(ucis));

test('初始局面：白方 20 个合法走子，双方轮换正确', () => {
  const state = chess.createInitialState();
  assert.equal(chess.toFen(state), chess.START_FEN);
  const moves = chess.legalMoves(state);
  assert.equal(moves.length, 20);
  assert.ok(moves.every((move) => move.piece === move.piece.toUpperCase()));

  const result = replay(['e2e4']);
  assert.equal(result.rejected.length, 0);
  assert.equal(result.state.turn, 'b');
  assert.equal(chess.toFen(result.state).split(' ')[1], 'b');
  assert.equal(result.applied[0].label, 'e2-e4');
});

test('perft：起始局面 1-4 层与标准值一致', () => {
  const state = chess.createInitialState();
  assert.equal(chess.perft(state, 1), 20);
  assert.equal(chess.perft(state, 2), 400);
  assert.equal(chess.perft(state, 3), 8902);
  assert.equal(chess.perft(state, 4), 197281);
});

test('perft：Kiwipete 局面 1-3 层与标准值一致', () => {
  const state = chess.parseFen('r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1');
  assert.equal(chess.perft(state, 1), 48);
  assert.equal(chess.perft(state, 2), 2039);
  assert.equal(chess.perft(state, 3), 97862);
});

test('非法走子被拒绝，且双方重放结果一致', () => {
  for (const bad of ['e2e5', 'e2e3q', 'e7e5', 'a1a2', 'e1e2']) {
    const result = replay([bad]);
    assert.equal(result.applied.length, 0, bad);
    assert.ok(result.rejected.length > 0, bad);
    assert.equal(chess.toFen(result.state), chess.START_FEN);
  }
});

test('越序行动被拒绝：白方不能连走两步，黑方未到回合不能走', () => {
  const result = chess.replayActions([
    { seat: 0, action: 'e2e4' },
    { seat: 0, action: 'd2d4' },
    { seat: 1, action: 'e7e5' },
  ]);
  assert.equal(result.applied.length, 2);
  assert.deepEqual(result.applied.map((entry) => entry.action), ['e2e4', 'e7e5']);
  assert.deepEqual(result.rejected.map((entry) => entry.reason), ['out-of-turn']);
});

test('格式错误与超长行动被拒绝，不会污染对局', () => {
  const result = chess.replayActions([
    { seat: 0, action: 'e2e4<script>' },
    { seat: 0, action: '  ' },
    { seat: '0', action: 'e2e4' },
    { seat: 0, action: 'e2e4'.repeat(40) },
    { seat: 0, action: 'e2e4', version: 1 },
  ]);
  assert.equal(result.applied.length, 1);
  assert.equal(result.rejected.length, 4);
});

test('王车易位：合法性、执行后的棋子位置与权利更新', () => {
  const state = chess.parseFen('r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1');
  const moves = chess.legalMoves(state);
  const ucis = moves.map(chess.moveToUci);
  assert.ok(ucis.includes('e1g1'));
  assert.ok(ucis.includes('e1c1'));

  const kingside = moves.find((move) => chess.moveToUci(move) === 'e1g1');
  const castled = chess.applyMove(state, kingside);
  assert.equal(castled.board[6], 'K');
  assert.equal(castled.board[5], 'R');
  assert.equal(castled.board[7], null);
  assert.equal(castled.board[4], null);
  assert.equal(castled.castling & 1, 0);
  assert.equal(castled.castling & 2, 0);

  const queenside = moves.find((move) => chess.moveToUci(move) === 'e1c1');
  const castledQ = chess.applyMove(state, queenside);
  assert.equal(castledQ.board[2], 'K');
  assert.equal(castledQ.board[3], 'R');
  assert.equal(castledQ.board[0], null);
});

test('王车易位：不能穿过被攻击的格子，被将军时不能易位', () => {
  const throughCheck = chess.parseFen('r3k2r/8/8/8/5r2/8/8/R3K2R w KQkq - 0 1');
  const throughUcis = chess.legalMoves(throughCheck).map(chess.moveToUci);
  assert.ok(!throughUcis.includes('e1g1'), 'f1 被黑车攻击，王翼易位非法');

  const inCheck = chess.parseFen('r3k2r/8/8/8/4r3/8/8/R3K2R w KQkq - 0 1');
  const inCheckUcis = chess.legalMoves(inCheck).map(chess.moveToUci);
  assert.ok(!inCheckUcis.includes('e1g1'));
  assert.ok(!inCheckUcis.includes('e1c1'));
});

test('王车易位权利会因王或车移动而失效', () => {
  const state = chess.parseFen('r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1');
  const moves = chess.legalMoves(state);
  const kingMove = moves.find((move) => chess.moveToUci(move) === 'e1f1');
  assert.ok(kingMove);
  assert.equal(chess.applyMove(state, kingMove).castling & 3, 0);
});

test('吃过路兵：合法生成并正确移除被吃兵', () => {
  const state = chess.parseFen('4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 1');
  const moves = chess.legalMoves(state);
  const ep = moves.find((move) => chess.moveToUci(move) === 'e5d6');
  assert.ok(ep, 'e5xd6 吃过路兵应合法');
  const next = chess.applyMove(state, ep);
  assert.equal(next.board[chess.squareIndex('d6')], 'P');
  assert.equal(next.board[chess.squareIndex('d5')], null);
  assert.equal(next.board[chess.squareIndex('e5')], null);
});

test('升变：四个兵种、直进与吃子升变都可用', () => {
  const state = chess.parseFen('1n2k3/P7/8/8/8/8/8/4K3 w - - 0 1');
  const moves = chess.legalMoves(state);
  const promotions = moves.filter((move) => move.from === chess.squareIndex('a7'));
  assert.deepEqual(
    [...new Set(promotions.map((move) => move.promotion))].sort(),
    ['b', 'n', 'q', 'r'],
  );
  assert.ok(promotions.some((move) => chess.moveToUci(move) === 'a7a8q'));
  assert.ok(promotions.some((move) => chess.moveToUci(move) === 'a7b8n'));

  const queened = chess.applyMove(state, promotions.find((move) => chess.moveToUci(move) === 'a7a8q'));
  assert.equal(queened.board[chess.squareIndex('a8')], 'Q');

  const knighted = chess.applyMove(state, promotions.find((move) => chess.moveToUci(move) === 'a7b8n'));
  assert.equal(knighted.board[chess.squareIndex('b8')], 'N');
});

test('升变可以通过公开行动序列到达并重放', () => {
  const result = replay([
    'a2a4', 'b7b5',
    'a4b5', 'a7a6',
    'b5a6', 'c8b7',
    'a6b7', 'b8c6',
    'b7a8q',
  ]);
  assert.equal(result.rejected.length, 0, JSON.stringify(result.rejected));
  assert.equal(result.applied.length, 9);
  assert.equal(result.applied[8].action, 'b7a8q');
  assert.equal(result.state.board[chess.squareIndex('a8')], 'Q');
  assert.equal(result.state.board[chess.squareIndex('b7')], null);
});

test('将死：傻瓜将死被识别为白方被将死', () => {
  const result = replay(['f2f3', 'e7e5', 'g2g4', 'd8h4']);
  assert.equal(result.rejected.length, 0);
  assert.equal(result.status.over, true);
  assert.equal(result.status.result, 'checkmate');
  assert.equal(result.status.winner, 'b');
  assert.equal(result.status.inCheck, true);
  assert.equal(result.status.legalMoves.length, 0);

  // 将死之后的新行动不会改变对局
  const extended = chess.replayActions([
    ...seatEntries(['f2f3', 'e7e5', 'g2g4', 'd8h4']),
    { seat: 0, action: 'e2e4' },
  ]);
  assert.equal(extended.applied.length, 4);
  assert.equal(extended.rejected.at(-1).reason, 'game-over');
  assert.equal(extended.status.result, 'checkmate');
});

test('将死：学者将死同样识别', () => {
  const result = replay(['e2e4', 'e7e5', 'f1c4', 'b8c6', 'd1h5', 'g8f6', 'h5f7']);
  assert.equal(result.rejected.length, 0, JSON.stringify(result.rejected));
  assert.equal(result.status.result, 'checkmate');
  assert.equal(result.status.winner, 'w');
});

test('无子可动且未被将军为逼和', () => {
  const state = chess.parseFen('7k/5Q2/6K1/8/8/8/8/8 b - - 0 1');
  assert.equal(chess.legalMoves(state).length, 0);
  const status = chess.evaluate(state);
  assert.equal(status.over, true);
  assert.equal(status.result, 'stalemate');
  assert.equal(status.winner, null);
});

test('三次重复局面判和（自动执行）', () => {
  const result = replay(['g1f3', 'g8f6', 'f3g1', 'f6g8', 'g1f3', 'g8f6', 'f3g1', 'f6g8']);
  assert.equal(result.rejected.length, 0);
  assert.equal(result.status.over, true);
  assert.equal(result.status.result, 'draw');
  assert.equal(result.status.reason, 'threefold-repetition');
  assert.equal(result.status.repetition, 3);
});

test('五十回合规则判和（自动执行）', () => {
  const state = chess.parseFen('8/8/4k3/8/8/4K3/8/R7 w - - 99 60');
  const move = chess.legalMoves(state).find((candidate) => chess.moveToUci(candidate) === 'a1a2');
  assert.ok(move);
  const next = chess.applyMove(state, move);
  assert.equal(next.halfmove, 100);
  const status = chess.evaluate(next);
  assert.equal(status.over, true);
  assert.equal(status.result, 'draw');
  assert.equal(status.reason, 'fifty-move');
});

test('子力不足判和：K vs K、K+B vs K、同色格 K+B vs K+B；异色格与多子不是', () => {
  assert.equal(chess.insufficientMaterial(chess.parseFen('4k3/8/8/8/8/8/8/4K3 w - - 0 1').board), true);
  assert.equal(chess.insufficientMaterial(chess.parseFen('4k3/8/8/8/8/8/8/2B1K3 w - - 0 1').board), true);
  assert.equal(chess.insufficientMaterial(chess.parseFen('5b1k/8/8/8/8/8/8/2B1K3 w - - 0 1').board), true);
  assert.equal(chess.insufficientMaterial(chess.parseFen('2b1k3/8/8/8/8/8/8/2B1K3 w - - 0 1').board), false);
  assert.equal(chess.insufficientMaterial(chess.parseFen('4k3/8/8/8/8/8/8/1N2K3 w - - 0 1').board), true);
  assert.equal(chess.insufficientMaterial(chess.parseFen('n3k3/8/8/8/8/8/8/1N2K3 w - - 0 1').board), false);

  const drawState = chess.parseFen('5b1k/8/8/8/8/8/8/2B1K3 w - - 0 1');
  const status = chess.evaluate(drawState);
  assert.equal(status.result, 'draw');
  assert.equal(status.reason, 'insufficient-material');
});

test('被牵制的棋子不能暴露王，王不能走入被攻击格', () => {
  // 白王 e1，白车 e2 被黑车 e8 牵制；e2 车只能沿 e 线移动。
  const state = chess.parseFen('4r2k/8/8/8/8/8/4R3/4K3 w - - 0 1');
  const moves = chess.legalMoves(state);
  const ucis = moves.map(chess.moveToUci);
  assert.ok(!ucis.includes('e2a2'), '离开 e 线会暴露白王');
  assert.ok(ucis.includes('e2e3'));

  // 白王被黑车攻击时不能走到仍被攻击的格子
  const kingState = chess.parseFen('4r2k/8/8/8/8/8/8/4K3 w - - 0 1');
  const kingUcis = chess.legalMoves(kingState).map(chess.moveToUci);
  assert.ok(!kingUcis.includes('e1e2'));
  assert.ok(kingUcis.includes('e1d1') || kingUcis.includes('e1f1'));
});

test('evaluate 返回合法走子列表，供界面复用', () => {
  const state = chess.createInitialState();
  const status = chess.evaluate(state);
  assert.equal(status.over, false);
  assert.equal(status.legalMoves.length, 20);
  assert.equal(status.inCheck, false);
});

test('随机合法对局：重放结果确定、双方王唯一、行动格式合法', () => {
  let seed = 20261107;
  const rand = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  for (let game = 0; game < 20; game += 1) {
    let state = chess.createInitialState();
    const entries = [];
    for (let ply = 0; ply < 120; ply += 1) {
      const status = chess.evaluate(state);
      if (status.over) break;
      const move = status.legalMoves[Math.floor(rand() * status.legalMoves.length)];
      const action = chess.moveToUci(move);
      assert.match(action, /^[a-h][1-8][a-h][1-8][qrbn]?$/);
      entries.push({ seat: state.turn === 'w' ? 0 : 1, action });
      state = chess.applyMove(state, move);
    }
    const replayed = chess.replayActions(entries);
    assert.equal(replayed.rejected.length, 0);
    assert.equal(chess.toFen(replayed.state), chess.toFen(state));
    assert.ok(chess.kingSquare(replayed.state.board, 'w') >= 0);
    assert.ok(chess.kingSquare(replayed.state.board, 'b') >= 0);
    assert.ok(entries.length > 0);
  }
});
