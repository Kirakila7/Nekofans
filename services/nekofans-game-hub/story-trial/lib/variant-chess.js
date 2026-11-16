'use strict';

/*
 * 剧情变体规则（服务端权威）。
 *
 * 只实现“共享走法池”需要的几何/路径/吃子/王安全/升变/易位权清理，
 * 不执行任何规则文本或模型生成代码；所有动作由房间层校验后调用。
 *
 * 池中的走法类型是棋子“原始普通走法”：
 *   n 马 / b 象 / r 车 / q 后 / p 兵（单步前进或斜吃，不含起始双步与吃过路兵）
 * 王不入池；使用共享走法占用本回合的普通走子。
 */

const Chess = require('./chess.js');

const CASTLE_WK = 1;
const CASTLE_WQ = 2;
const CASTLE_BK = 4;
const CASTLE_BQ = 8;

const PATTERN_TYPES = ['p', 'n', 'b', 'r', 'q'];
const PATTERN_NAMES = { p: '兵', n: '马', b: '象', r: '车', q: '后' };
const PATTERN_GLYPHS = { p: '♟', n: '♞', b: '♝', r: '♜', q: '♛' };
const PROMOTION_TYPES = ['q', 'r', 'b', 'n'];

const KNIGHT_DELTAS = [
  [1, 2], [2, 1], [2, -1], [1, -2],
  [-1, -2], [-2, -1], [-2, 1], [-1, 2],
];
const BISHOP_DIRS = [[1, 1], [1, -1], [-1, 1], [-1, -1]];
const ROOK_DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];

class PoolMoveError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'PoolMoveError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new PoolMoveError(code, message);
}

function fileOf(index) { return index & 7; }
function rankOf(index) { return index >> 3; }
function inside(file, rank) { return file >= 0 && file < 8 && rank >= 0 && rank < 8; }
function colorOfChar(ch) { return ch === ch.toUpperCase() ? 'w' : 'b'; }
function otherColor(color) { return color === 'w' ? 'b' : 'w'; }

function validPattern(type) {
  return PATTERN_TYPES.includes(String(type || '').toLowerCase());
}

function patternTargets(state, from, patternType) {
  const type = String(patternType || '').toLowerCase();
  if (!validPattern(type)) fail('bad_pattern', '共享走法类型只能是 p/n/b/r/q');
  const fromIndex = typeof from === 'number' ? from : Chess.squareIndex(from);
  if (!Number.isInteger(fromIndex) || fromIndex < 0 || fromIndex > 63) fail('bad_square', '起点格无效');
  const piece = state.board[fromIndex];
  if (!piece) fail('empty_square', '起点格没有棋子');
  const color = colorOfChar(piece);
  const opp = otherColor(color);
  const fromFile = fileOf(fromIndex);
  const fromRank = rankOf(fromIndex);
  const targets = [];

  if (type === 'n') {
    for (const [df, dr] of KNIGHT_DELTAS) {
      const file = fromFile + df;
      const rank = fromRank + dr;
      if (!inside(file, rank)) continue;
      const to = rank * 8 + file;
      const target = state.board[to];
      if (target && colorOfChar(target) === color) continue;
      targets.push({ to, capture: Boolean(target) });
    }
    return targets;
  }

  if (type === 'p') {
    const direction = color === 'w' ? 1 : -1;
    const oneRank = fromRank + direction;
    if (inside(fromFile, oneRank)) {
      const one = oneRank * 8 + fromFile;
      if (!state.board[one]) targets.push({ to: one, capture: false });
    }
    for (const df of [-1, 1]) {
      const file = fromFile + df;
      const rank = fromRank + direction;
      if (!inside(file, rank)) continue;
      const to = rank * 8 + file;
      const target = state.board[to];
      if (target && colorOfChar(target) === opp) targets.push({ to, capture: true });
    }
    return targets;
  }

  const dirs = type === 'b' ? BISHOP_DIRS : type === 'r' ? ROOK_DIRS : BISHOP_DIRS.concat(ROOK_DIRS);
  for (const [df, dr] of dirs) {
    let file = fromFile + df;
    let rank = fromRank + dr;
    while (inside(file, rank)) {
      const to = rank * 8 + file;
      const target = state.board[to];
      if (target && colorOfChar(target) === color) break;
      targets.push({ to, capture: Boolean(target) });
      if (target) break;
      file += df;
      rank += dr;
    }
  }
  return targets;
}

function promotionNeededFor(state, from, to) {
  const piece = state.board[typeof from === 'number' ? from : Chess.squareIndex(from)];
  if (!piece || piece.toLowerCase() !== 'p') return false;
  const rank = rankOf(typeof to === 'number' ? to : Chess.squareIndex(to));
  return rank === 0 || rank === 7;
}

function applyPoolMove(state, { from, to, patternType, promotion = null } = {}) {
  const fromIndex = typeof from === 'number' ? from : Chess.squareIndex(from);
  const toIndex = typeof to === 'number' ? to : Chess.squareIndex(to);
  if (!Number.isInteger(fromIndex) || fromIndex < 0 || fromIndex > 63) fail('bad_square', '起点格无效');
  if (!Number.isInteger(toIndex) || toIndex < 0 || toIndex > 63) fail('bad_square', '目标格无效');
  const type = String(patternType || '').toLowerCase();
  const piece = state.board[fromIndex];
  if (!piece) fail('empty_square', '起点格没有棋子');
  const color = colorOfChar(piece);
  if (color !== state.turn) fail('not_your_piece', '只能移动当前行棋方的棋子');
  const target = state.board[toIndex];
  if (target && colorOfChar(target) === color) fail('own_piece', '不能吃自己的棋子');
  if (target && target.toLowerCase() === 'k') fail('king_capture', '不允许直接吃王');

  const candidates = patternTargets(state, fromIndex, type);
  if (!candidates.some((item) => item.to === toIndex)) {
    fail('illegal_pattern_move', '这枚棋子不能按该共享走法到达目标格');
  }

  const needsPromotion = promotionNeededFor(state, fromIndex, toIndex);
  let promo = null;
  if (needsPromotion) {
    if (typeof promotion !== 'string' || !PROMOTION_TYPES.includes(promotion.toLowerCase())) {
      fail('promotion_required', '兵到达底线必须选择升变棋子');
    }
    promo = promotion.toLowerCase();
  } else if (promotion !== null && promotion !== undefined) {
    fail('bad_promotion', '该走法不需要升变');
  }

  const board = state.board.slice();
  const captured = board[toIndex] || null;
  board[fromIndex] = null;
  board[toIndex] = promo ? (color === 'w' ? promo.toUpperCase() : promo) : piece;

  let castling = state.castling;
  if (piece === 'K') castling &= ~(CASTLE_WK | CASTLE_WQ);
  if (piece === 'k') castling &= ~(CASTLE_BK | CASTLE_BQ);
  if (fromIndex === 7 || toIndex === 7) castling &= ~CASTLE_WK;
  if (fromIndex === 0 || toIndex === 0) castling &= ~CASTLE_WQ;
  if (fromIndex === 63 || toIndex === 63) castling &= ~CASTLE_BK;
  if (fromIndex === 56 || toIndex === 56) castling &= ~CASTLE_BQ;

  const next = {
    board,
    turn: otherColor(color),
    castling,
    ep: -1,
    halfmove: piece.toLowerCase() === 'p' || captured ? 0 : (state.halfmove || 0) + 1,
    fullmove: (state.fullmove || 1) + (color === 'b' ? 1 : 0),
    history: (state.history || []).concat([Chess.positionKey(state)]),
  };

  const ownKing = Chess.kingSquare(next.board, color);
  if (ownKing < 0) fail('missing_king', '移动后本方王不存在');
  if (Chess.isSquareAttacked(next.board, ownKing, otherColor(color))) {
    fail('self_check', '该走法会让本方王处于被将军状态');
  }

  return {
    state: next,
    captured,
    promotion: promo,
    from: Chess.squareName(fromIndex),
    to: Chess.squareName(toIndex),
    patternType: type,
  };
}

function isPoolMoveLegal(state, move) {
  try {
    applyPoolMove(state, move);
    return true;
  } catch {
    return false;
  }
}

/**
 * 当前行棋方所有合法的共享池动作。返回的动作只由服务端生成，
 * 用于 UI 提示 / AI 队友视图 / 将死判定，不包含任何真名。
 */
function generatePoolActions(state, poolTypes) {
  const types = Array.from(new Set((poolTypes || []).filter(validPattern)));
  if (!types.length) return [];
  const turnColor = state.turn;
  const ownKing = Chess.kingSquare(state.board, turnColor);
  if (ownKing < 0) return [];
  const actions = [];
  const seen = new Set();
  for (let fromIndex = 0; fromIndex < 64; fromIndex += 1) {
    const piece = state.board[fromIndex];
    if (!piece || colorOfChar(piece) !== turnColor) continue;
    const from = Chess.squareName(fromIndex);
    for (const type of types) {
      let targets;
      try {
        targets = patternTargets(state, fromIndex, type);
      } catch {
        continue;
      }
      for (const target of targets) {
        const toIndex = target.to;
        const targetPiece = state.board[toIndex];
        if (targetPiece && targetPiece.toLowerCase() === 'k') continue;
        const needsPromotion = promotionNeededFor(state, fromIndex, toIndex);
        const promos = needsPromotion ? PROMOTION_TYPES : [null];
        for (const promotion of promos) {
          const key = type + ':' + from + ':' + Chess.squareName(toIndex) + ':' + (promotion || '');
          if (seen.has(key)) continue;
          if (!isPoolMoveLegal(state, { from, to: Chess.squareName(toIndex), patternType: type, promotion })) continue;
          seen.add(key);
          actions.push({
            patternType: type,
            from,
            to: Chess.squareName(toIndex),
            capture: Boolean(targetPiece),
            promotion: promotion || null,
          });
          if (actions.length >= 2000) return actions;
        }
      }
    }
  }
  return actions;
}

/**
 * 标准评估 + 共享池逃生：如果标准规则判将死/逼和，但当前方有合法共享走法，
 * 则不终局，由玩家选择共享走法。和棋（子力不足/重复/五十回合等）不改变。
 */
function evaluateStory(state, poolTypes) {
  const legalMoves = Chess.legalMoves(state);
  const base = Chess.evaluate(state, legalMoves);
  if (base.result === 'checkmate' || base.result === 'stalemate') {
    const actions = generatePoolActions(state, poolTypes);
    if (actions.length > 0) {
      return {
        ...base,
        over: false,
        result: null,
        reason: null,
        winner: null,
        variantEscape: true,
        poolActions: actions.length,
      };
    }
  }
  return { ...base, variantEscape: false };
}

function poolTypeName(type) {
  return PATTERN_NAMES[String(type || '').toLowerCase()] || String(type || '');
}

function poolTypeGlyph(type) {
  return PATTERN_GLYPHS[String(type || '').toLowerCase()] || '';
}

function poolMoveLabel({ from, to, patternType, capture }) {
  const name = poolTypeName(patternType);
  return '共享走法·' + name + ' ' + from + (capture ? '×' : '–') + to;
}

// 公开棋谱/SSE 只显示中性走法标签，不命名任何一方的能力或走法类型。
function publicPoolMoveLabel({ from, to, capture }) {
  return '特殊走法 ' + from + (capture ? '×' : '–') + to;
}

module.exports = {
  PATTERN_TYPES,
  PATTERN_NAMES,
  PROMOTION_TYPES,
  PoolMoveError,
  patternTargets,
  applyPoolMove,
  isPoolMoveLegal,
  generatePoolActions,
  evaluateStory,
  poolTypeName,
  poolTypeGlyph,
  poolMoveLabel,
  publicPoolMoveLabel,
  validPattern,
  promotionNeededFor,
};
