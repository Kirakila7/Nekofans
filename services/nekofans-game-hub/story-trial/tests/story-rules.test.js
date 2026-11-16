'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const Chess = require('../lib/chess.js');
const identityLib = require('../lib/piece-identity.js');
const variant = require('../lib/variant-chess.js');
const storyRules = require('../lib/story-rules.js');

function freshState(fen = Chess.START_FEN) {
  const state = Chess.parseFen(fen);
  state.history = [];
  return state;
}

function applyUci(state, uci) {
  const move = Chess.legalMoves(state).find((candidate) => Chess.moveToUci(candidate) === uci);
  assert.ok(move, '缺少合法走法 ' + uci);
  return Chess.applyMove(state, move);
}

const SCENARIO = {
  id: 'test-story',
  abilities: { white: 'open-source', black: 'erase-note' },
  poolTypes: ['n', 'b', 'r', 'q', 'p'],
  kingErasureWins: true,
  names: [{ color: 'w', type: 'k', square: 'e1', trueName: '梁文峰', alias: '梁武帝' }],
};

test('棋子身份：真名跟随移动，原始类型保留，升变不改变 originalType', () => {
  const identity = identityLib.createIdentity(Chess.START_FEN, SCENARIO.names);
  assert.equal(Object.keys(identity.pieces).length, 32);
  const king = identityLib.pieceAt(identity, 'e1');
  assert.equal(king.trueName, '梁文峰');
  assert.equal(king.alias, '梁武帝');

  identityLib.movePiece(identity, { from: 'e1', to: 'e2' });
  assert.equal(identityLib.pieceAt(identity, 'e1'), null);
  const movedKing = identityLib.pieceAt(identity, 'e2');
  assert.equal(movedKing.trueName, '梁文峰');
  assert.equal(movedKing.id, king.id);

  identityLib.movePiece(identity, { from: 'b7', to: 'b8', promotion: 'q' });
  const promoted = identityLib.pieceAt(identity, 'b8');
  assert.equal(promoted.type, 'q');
  assert.equal(promoted.originalType, 'p');
});

test('棋子身份：吃子、易位、放置与抹除保持映射一致', () => {
  const identity = identityLib.createIdentity(Chess.START_FEN, SCENARIO.names);
  const captured = identityLib.movePiece(identity, { from: 'e2', to: 'e4' });
  assert.equal(captured.capturedPiece, null);
  identityLib.movePiece(identity, { from: 'd7', to: 'd5' });
  const capture = identityLib.movePiece(identity, { from: 'e4', to: 'd5', capturedSquare: 'd5' });
  assert.ok(capture.capturedPiece);
  assert.equal(capture.capturedPiece.color, 'b');
  assert.equal(identityLib.pieceAt(identity, 'd5').color, 'w');

  const castleIdentity = identityLib.createIdentity('r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1');
  identityLib.movePiece(castleIdentity, { from: 'e1', to: 'g1', castleRook: { from: 'h1', to: 'f1' } });
  assert.equal(identityLib.pieceAt(castleIdentity, 'g1').color, 'w');
  assert.equal(identityLib.pieceAt(castleIdentity, 'f1').color, 'w');
  assert.equal(identityLib.pieceAt(castleIdentity, 'h1'), null);

  const erased = identityLib.erasePiece(identity, 'e7');
  assert.equal(erased.color, 'b');
  assert.equal(identityLib.pieceAt(identity, 'e7'), null);
  const placed = identityLib.placePiece(identity, { square: 'e7', color: 'b', type: 'n', trueName: '小墨' });
  assert.equal(placed.trueName, '小墨');
  assert.equal(identityLib.pieceAt(identity, 'e7').type, 'n');
});

test('棋子身份：吃过路兵移除正确的兵', () => {
  const identity = identityLib.createIdentity(Chess.START_FEN);
  identityLib.movePiece(identity, { from: 'e2', to: 'e4' });
  identityLib.movePiece(identity, { from: 'a7', to: 'a6' });
  identityLib.movePiece(identity, { from: 'e4', to: 'e5' });
  identityLib.movePiece(identity, { from: 'd7', to: 'd5' });
  const capture = identityLib.movePiece(identity, { from: 'e5', to: 'd6', capturedSquare: 'd5' });
  assert.equal(capture.capturedPiece.type, 'p');
  assert.equal(identityLib.pieceAt(identity, 'd5'), null);
  assert.equal(identityLib.pieceAt(identity, 'd6').color, 'w');
});

test('共享走法：几何、阻挡、王安全与吃王限制', () => {
  const state = freshState();
  const knightTargets = variant.patternTargets(state, 'g1', 'n').map((item) => Chess.squareName(item.to));
  assert.deepEqual(new Set(knightTargets), new Set(['f3', 'h3']));

  const rookResult = variant.applyPoolMove(state, { from: 'a1', to: 'b3', patternType: 'n' });
  assert.equal(rookResult.state.turn, 'b');
  assert.equal(rookResult.state.board[Chess.squareIndex('b3')], 'R');
  assert.equal(rookResult.state.board[Chess.squareIndex('a1')], null);

  assert.throws(
    () => variant.applyPoolMove(state, { from: 'a1', to: 'b2', patternType: 'n' }),
    /共享走法|不能/,
    '不能吃自己的棋子',
  );
  assert.throws(
    () => variant.applyPoolMove(state, { from: 'a1', to: 'a4', patternType: 'r' }),
    /共享走法/,
    '路径被挡',
  );
  assert.throws(
    () => variant.applyPoolMove(state, { from: 'e1', to: 'e8', patternType: 'r' }),
    /王|将军/,
    '不能吃王',
  );

  const exposed = freshState('4r3/8/8/8/8/8/4R3/4K3 w - - 0 1');
  assert.throws(
    () => variant.applyPoolMove(exposed, { from: 'e2', to: 'c3', patternType: 'n' }),
    /将军/,
    '移动后不能暴露本方王',
  );
});

test('共享走法：池动作生成、升变与“将死但可用共享走法逃生”', () => {
  const replay = Chess.replayActions([
    { seat: 0, action: 'f2f3' },
    { seat: 1, action: 'e7e5' },
    { seat: 0, action: 'g2g4' },
    { seat: 1, action: 'd8h4' },
  ]);
  assert.equal(replay.status.result, 'checkmate');
  const base = variant.evaluateStory(replay.state, []);
  assert.equal(base.over, true);

  const actions = variant.generatePoolActions(replay.state, ['n']);
  assert.ok(actions.some((action) => action.from === 'f3' && action.to === 'h4' && action.capture));
  const escaped = variant.evaluateStory(replay.state, ['n']);
  assert.equal(escaped.over, false);
  assert.equal(escaped.variantEscape, true);

  const block = variant.applyPoolMove(replay.state, { from: 'f3', to: 'h4', patternType: 'n' });
  assert.equal(block.captured, 'q');
  assert.equal(Chess.evaluate(block.state, Chess.legalMoves(block.state)).result, null);
});

test('剧情状态：退场入池去重、公开事件无真名、玩家/女神投影隔离', () => {
  const story = storyRules.createStoryState(SCENARIO, Chess.START_FEN);
  const knight = identityLib.pieceAt(story.identity, 'b1');
  knight.trueName = '小泡泡';
  const pawn = identityLib.pieceAt(story.identity, 'a2');
  storyRules.retirePiece(story, knight, 'black');
  storyRules.retirePiece(story, identityLib.pieceAt(story.identity, 'h1'), 'black');
  storyRules.retirePiece(story, { ...knight, originalType: 'n' }, 'black');
  assert.deepEqual(story.pool, ['n', 'r']);
  assert.equal(story.events.length, 3);
  assert.ok(!JSON.stringify(storyRules.publicView(story)).includes('小泡泡'));
  assert.ok(!JSON.stringify(storyRules.publicView(story)).includes('梁文峰'));

  const state = applyUci(freshState(), 'e2e4');
  const publicView = storyRules.publicView(story);
  const playerView = storyRules.playerView(story, 'black', state, 'playing', 1);
  assert.equal(publicView.enabled, true);
  assert.equal(publicView.events.every((event) => event.kind === 'board-change'), true);
  assert.ok(!JSON.stringify(publicView).includes('抹除'));
  assert.ok(!JSON.stringify(publicView).includes('真名'));
  assert.ok(!JSON.stringify(publicView).includes('共享走法'));
  assert.match(playerView.abilityLabel, /抹除/);
  assert.equal(playerView.privateAction.canUse, true);
  assert.ok(!JSON.stringify(playerView).includes('梁文峰'));
  assert.ok(!JSON.stringify(playerView).includes('小泡泡'));

  const goddessView = storyRules.goddessView(story);
  assert.equal(goddessView.names.find((piece) => piece.square === 'e1').trueName, '梁文峰');
  assert.equal(goddessView.names.find((piece) => piece.square === 'b1').trueName, '小泡泡');
  assert.equal(goddessView.attempts.length, 0);

  // 名字匹配：梁武帝不是梁文峰的真名
  const king = identityLib.pieceAt(story.identity, 'e1');
  assert.equal(storyRules.nameMatches(king, '梁文峰'), true);
  assert.equal(storyRules.nameMatches(king, '梁武帝'), false);
  assert.equal(storyRules.nameMatches(king, ' 梁文峰 '), true);
});

test('剧情状态：B 的抹除尝试只出现在自己和女神视图；失败不会改变棋盘', () => {
  const story = storyRules.createStoryState(SCENARIO, Chess.START_FEN);
  storyRules.recordEraseAttempt(story, {
    seat: 'black',
    targetSquare: 'e1',
    targetPieceId: 'w-k-e1',
    name: '梁武帝',
    success: false,
  });
  const state = freshState();
  const blackView = storyRules.playerView(story, 'black', state, 'playing', 0);
  const whiteView = storyRules.playerView(story, 'white', state, 'playing', 0);
  assert.equal(blackView.privateAction.attempts.length, 1);
  assert.equal(blackView.privateAction.attempts[0].name, '梁武帝');
  assert.equal('privateAction' in whiteView, false);
  assert.ok(!JSON.stringify(storyRules.publicView(story)).includes('梁武帝'));
  assert.ok(!JSON.stringify(storyRules.publicView(story)).includes('抹除'));
  assert.ok(!JSON.stringify(storyRules.publicView(story)).includes('真名'));
  assert.ok(!JSON.stringify(storyRules.publicView(story)).includes('erase'));
  assert.equal(storyRules.goddessView(story).attempts[0].name, '梁武帝');
});

test('剧情状态：重置会恢复初始真名，抹除后不残留旧身份', () => {
  const story = storyRules.createStoryState(SCENARIO, Chess.START_FEN);
  identityLib.erasePiece(story.identity, 'e1');
  assert.equal(identityLib.pieceAt(story.identity, 'e1'), null);
  let next = storyRules.createStoryState(SCENARIO, Chess.START_FEN);
  assert.equal(identityLib.pieceAt(next.identity, 'e1').trueName, '梁文峰');
  storyRules.setName(next, 'b1', '小泡泡');
  assert.equal(identityLib.pieceAt(next.identity, 'b1').trueName, '小泡泡');
});

test('共享走法升变：兵到达底线需要升变棋子', () => {
  const state = freshState('8/P7/8/8/8/8/8/k6K w - - 0 1');
  assert.throws(
    () => variant.applyPoolMove(state, { from: 'a7', to: 'a8', patternType: 'p' }),
    /升变/,
  );
  const promoted = variant.applyPoolMove(state, { from: 'a7', to: 'a8', patternType: 'p', promotion: 'q' });
  assert.equal(promoted.state.board[Chess.squareIndex('a8')], 'Q');
  assert.equal(promoted.promotion, 'q');
});
