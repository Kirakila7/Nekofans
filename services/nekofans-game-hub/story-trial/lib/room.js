'use strict';

/*
 * 房间模型：唯一权威状态。
 *
 * - 棋盘由 lib/chess.js（来自会话工作区既有原型、已通过 perft 测试的规则内核）驱动。
 * - 规则文本、猜测文本只保存在服务端内存/本地 data 目录中；stateFor() 按角色投影，
 *   玩家视角永远不含对手规则原文、备注与猜测原文。
 * - 女神只能调用下面这些结构化方法，每个方法都校验阶段、轮次、权限与棋盘合法性。
 */

const crypto = require('node:crypto');
const Chess = require('./chess.js');
const identityLib = require('./piece-identity.js');
const variantChess = require('./variant-chess.js');
const storyRules = require('./story-rules.js');
const teammateAdapter = require('./teammate-adapter.js');

const SEATS = ['white', 'black'];
const COLOR_OF_SEAT = { white: 'w', black: 'b' };
const SEAT_OF_COLOR = { w: 'white', b: 'black' };
const SIDE_NAMES = { white: '白方', black: '黑方' };

// lib/chess.js 中易位权的位定义（与引擎保持一致；引擎未导出，故在此固化）。
const CASTLE = { WK: 1, WQ: 2, BK: 4, BQ: 8 };

const LIMITS = {
  rule: 400,
  guess: 300,
  note: 300,
  announce: 300,
};

const AUTO_END_REASONS = new Set([
  'checkmate',
  'stalemate',
  'insufficient-material',
  'fifty-move',
  'threefold-repetition',
  'seventy-five-move',
  'fivefold-repetition',
  'erase-king',
]);

function publicGameResult(result) {
  if (!result) return null;
  const hiddenReason = result.reason === 'erase-king';
  return {
    winner: result.winner,
    reason: hiddenReason ? 'special' : result.reason,
    note: hiddenReason ? null : result.note,
    automatic: result.automatic,
    at: result.at,
  };
}

const RESULT_TEXT = {
  checkmate: '将死',
  stalemate: '逼和',
  'insufficient-material': '子力不足',
  'fifty-move': '五十回合规则',
  'threefold-repetition': '三次重复局面',
  'seventy-five-move': '七十五回合规则',
  'fivefold-repetition': '五次重复局面',
  guess: '猜中隐藏规则',
  resign: '认输',
  goddess: '女神裁定',
  agreement: '双方协议',
  abort: '对局中止',
  timeout: '超时',
  draw: '和棋',
  'erase-king': '真名抹除国王',
};

// 保留换行与制表符，去掉其余不可见控制字符（含 \r）。
const CONTROL_CHARS = /[\u0000-\u0008\u000B-\u001F\u007F]/g;

class RoomError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'RoomError';
    this.code = code;
    this.status = status;
  }
}

function fail(code, message, status) {
  throw new RoomError(code, message, status);
}

function now() {
  return Date.now();
}

function cleanText(value, maxLength) {
  if (typeof value !== 'string') return '';
  return value.replace(/\r\n?/g, '\n').replace(CONTROL_CHARS, '').trim().slice(0, maxLength);
}

function randomId(prefix, bytes = 4) {
  return prefix + crypto.randomBytes(bytes).toString('hex');
}

function newToken() {
  return crypto.randomBytes(24).toString('hex');
}

function emptyRule() {
  return {
    text: null,
    status: 'empty', // empty | submitted | active | returned | revealed
    note: null,
    updatedAt: null,
    revealedAt: null,
  };
}

function freshGame() {
  return {
    fen: Chess.START_FEN,
    positionKeys: [],
    moves: [],
    pending: null,
    lastMove: null,
    result: null,
    snapshots: [],
    rejections: [],
    lastEdit: null,
    startedAt: null,
    finishedAt: null,
  };
}

function wireFromEngine(st, move, options) {
  const color = st.turn;
  return {
    id: options && options.id ? options.id : null,
    ply: options && options.ply ? options.ply : null,
    color,
    seat: SEAT_OF_COLOR[color],
    from: Chess.squareName(move.from),
    to: Chess.squareName(move.to),
    promotion: move.promotion || null,
    piece: move.piece,
    captured: move.captured || null,
    flags: {
      castle: (move.flags && move.flags.castle) || null,
      enPassant: Boolean(move.flags && move.flags.enPassant),
      doublePush: Boolean(move.flags && move.flags.doublePush),
    },
    label: moveLabel(st, move),
    by: (options && options.by) || 'player',
    at: now(),
  };
}

function moveLabel(st, move) {
  if (move.flags && move.flags.castle === 'K') return 'O-O';
  if (move.flags && move.flags.castle === 'Q') return 'O-O-O';
  const from = Chess.squareName(move.from);
  const to = Chess.squareName(move.to);
  const cap = move.captured ? '×' : '–';
  const name = move.piece.toUpperCase();
  let label = (name === 'P' ? '' : name) + from + cap + to;
  if (move.promotion) label += '=' + move.promotion.toUpperCase();
  return label;
}

function fenFromBoard(board, turn, castling, halfmove, fullmove) {
  return [
    boardPlacement(board),
    turn,
    castlingText(board, castling),
    '-',
    String(Math.max(0, Number(halfmove) || 0)),
    String(Math.max(1, Number(fullmove) || 1)),
  ].join(' ');
}

function boardPlacement(board) {
  const rows = [];
  for (let rank = 7; rank >= 0; rank -= 1) {
    let row = '';
    let gap = 0;
    for (let file = 0; file < 8; file += 1) {
      const piece = board[rank * 8 + file];
      if (!piece) {
        gap += 1;
        continue;
      }
      if (gap) {
        row += String(gap);
        gap = 0;
      }
      row += piece;
    }
    if (gap) row += String(gap);
    rows.push(row);
  }
  return rows.join('/');
}

function castlingText(board, castling) {
  let text = '';
  if ((castling & CASTLE.WK) && board[4] === 'K' && board[7] === 'R') text += 'K';
  if ((castling & CASTLE.WQ) && board[4] === 'K' && board[0] === 'R') text += 'Q';
  if ((castling & CASTLE.BK) && board[60] === 'k' && board[63] === 'r') text += 'k';
  if ((castling & CASTLE.BQ) && board[60] === 'k' && board[56] === 'r') text += 'q';
  return text || '-';
}

function findLegalMove(st, from, to, promotion) {
  const fromIndex = Chess.squareIndex(from);
  const toIndex = Chess.squareIndex(to);
  if (fromIndex < 0 || toIndex < 0) {
    fail('bad_square', '走子坐标格式不正确（应形如 e2 → e4）');
  }
  const candidates = Chess.legalMoves(st).filter(
    (move) => move.from === fromIndex && move.to === toIndex,
  );
  if (!candidates.length) fail('illegal_move', '这一步不是当前局面的合法走法');
  const promo = typeof promotion === 'string' ? promotion.toLowerCase() : null;
  if (promo) {
    const found = candidates.find((move) => move.promotion === promo);
    if (!found) fail('bad_promotion', '升变棋子只能是后/车/象/马');
    return found;
  }
  if (candidates.some((move) => move.promotion)) {
    fail('promotion_required', '这一步需要选择升变棋子', 409);
  }
  return candidates[0];
}

function seatOfColor(color) {
  return SEAT_OF_COLOR[color] || null;
}

function normalizeWinner(value) {
  if (value === 'white' || value === 'black' || value === 'draw') return value;
  fail('bad_winner', '胜方只能是 white / black / draw');
}

class Room {
  constructor(data) {
    this.data = data;
    this.teammateStatus = null;
    this.goddessStatus = null;
  }

  static create(options = {}) {
    const createdAt = now();
    const guessLimit = clampGuessLimit(options.guessLimit);
    const scenario = options.scenario || null;
    const data = {
      id: options.id || randomId('r-', 4),
      createdAt,
      updatedAt: createdAt,
      version: 1,
      eventSeq: 0,
      tokens: options.tokens || {
        white: newToken(),
        black: newToken(),
        goddess: newToken(),
      },
      phase: 'lobby',
      settings: {
        reviewMode: options.reviewMode !== false,
        guessLimit,
      },
      scenario,
      story: storyRules.createStoryState(scenario, Chess.START_FEN),
      game: freshGame(),
      rules: { white: emptyRule(), black: emptyRule() },
      guesses: [],
      announcements: [],
      events: [],
    };
    const room = new Room(data);
    room.teammateStatus = options.teammateStatus || null;
    room.goddessStatus = options.goddessStatus || null;
    return room;
  }

  static fromJSON(raw) {
    const room = new Room(raw);
    room.upgrade();
    return room;
  }

  /** 兼容旧存档的最小修补。 */
  upgrade() {
    const data = this.data;
    data.tokens = data.tokens || {};
    data.settings = Object.assign({ reviewMode: true, guessLimit: 3 }, data.settings || {});
    data.rules = data.rules || { white: emptyRule(), black: emptyRule() };
    for (const seat of SEATS) {
      data.rules[seat] = Object.assign(emptyRule(), data.rules[seat] || {});
    }
    data.game = Object.assign(freshGame(), data.game || {});
    data.game.snapshots = data.game.snapshots || [];
    data.game.rejections = data.game.rejections || [];
    data.guesses = data.guesses || [];
    data.announcements = data.announcements || [];
    data.events = data.events || [];
    data.eventSeq = data.eventSeq || 0;
    data.version = data.version || 1;
    data.scenario = data.scenario || null;
    if (!data.story || typeof data.story !== 'object') data.story = { enabled: false };
    if (data.story.enabled) {
      data.story.pool = data.story.pool || [];
      data.story.events = data.story.events || [];
      data.story.attempts = data.story.attempts || [];
      data.story.poolTypes = data.story.poolTypes || ['p', 'n', 'b', 'r', 'q'];
      data.story.identity = data.story.identity || null;
      if (!data.story.identity) data.story.enabled = false;
    }
    return this;
  }

  get id() {
    return this.data.id;
  }

  toJSON() {
    return this.data;
  }

  get phase() {
    return this.data.phase;
  }

  touch() {
    this.data.updatedAt = now();
    this.data.version += 1;
  }

  log(type, text, extra) {
    const data = this.data;
    data.eventSeq += 1;
    const event = {
      id: data.eventSeq,
      seq: data.eventSeq,
      type,
      at: now(),
      text,
      ...(extra || {}),
    };
    data.events.push(event);
    if (data.events.length > 1000) data.events.splice(0, data.events.length - 1000);
    return event;
  }

  requirePhase(...phases) {
    if (!phases.includes(this.data.phase)) {
      const current = this.data.phase;
      const hint = current === 'lobby' ? '对局尚未开始' : current === 'finished' ? '对局已经结束' : '当前阶段不能执行该操作';
      fail('wrong_phase', hint, 409);
    }
  }

  requireSeat(seat) {
    if (!SEATS.includes(seat)) fail('bad_seat', '席位只能是 white 或 black');
    return seat;
  }

  requireNoPending() {
    if (this.data.game.pending) {
      fail('pending_move', '有一手棋正在等待女神裁决，请先处理', 409);
    }
  }

  /** 用房间数据重建引擎状态（含三次重复所需的局面历史）。 */
  chessState() {
    const game = this.data.game;
    let state;
    try {
      state = Chess.parseFen(game.fen);
    } catch (error) {
      fail('bad_fen', '当前棋盘状态损坏：' + error.message, 500);
    }
    state.history = Array.isArray(game.positionKeys) ? game.positionKeys.slice() : [];
    return state;
  }

  storyEnabled() {
    return Boolean(this.data.story && this.data.story.enabled);
  }

  evaluate() {
    const state = this.chessState();
    if (this.data.game.result && (
      Chess.kingSquare(state.board, 'w') < 0 ||
      Chess.kingSquare(state.board, 'b') < 0
    )) {
      // 国王被真名抹除后的终局：不再做标准将军/将死评估，保留结果。
      return {
        state,
        legalMoves: [],
        status: { over: true, result: null, reason: null, winner: null, inCheck: false, variantEscape: false },
      };
    }
    const legalMoves = Chess.legalMoves(state);
    const status = this.storyEnabled()
      ? variantChess.evaluateStory(state, this.data.story.poolTypes)
      : Chess.evaluate(state, legalMoves);
    return { state, legalMoves, status };
  }

  evaluateState(state) {
    const legalMoves = Chess.legalMoves(state);
    const status = this.storyEnabled()
      ? variantChess.evaluateStory(state, this.data.story.poolTypes)
      : Chess.evaluate(state, legalMoves);
    return { state, legalMoves, status };
  }

  snapshot(kind) {
    return {
      kind,
      fen: this.data.game.fen,
      keys: this.data.game.positionKeys.slice(),
      movesLen: this.data.game.moves.length,
      lastMove: this.data.game.lastMove,
      lastEdit: this.data.game.lastEdit,
      story: this.storyEnabled() ? storyRules.cloneStory(this.data.story) : null,
      at: now(),
    };
  }

  // ---------- 规则 ----------

  submitRule(seat, text) {
    this.requireSeat(seat);
    this.requirePhase('lobby');
    const rule = this.data.rules[seat];
    if (rule.status !== 'empty' && rule.status !== 'returned') {
      fail('rule_locked', '规则已经提交，等待女神处理', 409);
    }
    const clean = cleanText(text, LIMITS.rule);
    if (!clean) fail('empty_rule', '规则内容不能为空');
    rule.text = clean;
    rule.status = 'submitted';
    rule.note = null;
    rule.updatedAt = now();
    this.log('rule_submitted', `${SIDE_NAMES[seat]}提交了隐藏规则`, { seat });
  }

  goddessRule({ seat, action, text, note }) {
    const cleanNote = cleanText(note, LIMITS.note) || null;
    if (action === 'reveal') {
      this.reveal(seat);
      return;
    }
    this.requireSeat(seat);
    const rule = this.data.rules[seat];
    this.requirePhase('lobby');
    if (action === 'approve') {
      if (rule.status !== 'submitted') {
        fail('rule_not_submitted', `${SIDE_NAMES[seat]}还没有提交规则`, 409);
      }
      rule.status = 'active';
      rule.note = null;
      rule.updatedAt = now();
      this.log('rule_approved', `${SIDE_NAMES[seat]}的隐藏规则已生效`, { seat });
      return;
    }
    if (action === 'return') {
      if (rule.status !== 'submitted' && rule.status !== 'active') {
        fail('rule_not_submitted', `${SIDE_NAMES[seat]}还没有可退回的规则`, 409);
      }
      rule.status = 'returned';
      rule.note = cleanNote;
      rule.updatedAt = now();
      this.log('rule_returned', `女神退回了${SIDE_NAMES[seat]}的规则，等待修改`, { seat });
      return;
    }
    if (action === 'edit') {
      if (rule.status !== 'submitted' && rule.status !== 'active') {
        fail('rule_not_submitted', `只能在规则提交后修正文字`, 409);
      }
      const clean = cleanText(text, LIMITS.rule);
      if (!clean) fail('empty_rule', '规则内容不能为空');
      rule.text = clean;
      rule.updatedAt = now();
      this.log('rule_edited', `女神修正了${SIDE_NAMES[seat]}的规则文字`, { seat });
      return;
    }
    fail('bad_action', '未知的规则操作');
  }

  reveal(seat) {
    if (seat === 'both') {
      this.reveal('white');
      this.reveal('black');
      return;
    }
    this.requireSeat(seat);
    const rule = this.data.rules[seat];
    if (!rule.text) fail('rule_empty', `${SIDE_NAMES[seat]}还没有规则可揭晓`, 409);
    if (!rule.revealedAt) {
      rule.revealedAt = now();
      this.log('rule_revealed', `女神揭晓了${SIDE_NAMES[seat]}的隐藏规则`, { seat });
    }
  }

  revealAll() {
    if (this.data.rules.white.text) this.reveal('white');
    if (this.data.rules.black.text) this.reveal('black');
  }

  // ---------- 对局流程 ----------

  start() {
    this.requirePhase('lobby');
    for (const seat of SEATS) {
      if (this.data.rules[seat].status !== 'active') {
        fail('rules_not_ready', `${SIDE_NAMES[seat]}的规则还没有生效，不能开始`, 409);
      }
    }
    this.data.phase = 'playing';
    this.data.game.startedAt = now();
    this.log('game_started', '双方规则均已生效，对局开始');
  }

  setPaused(paused) {
    this.requirePhase('playing', 'paused');
    if (paused && this.data.phase === 'playing') {
      this.requireNoPending();
      this.data.phase = 'paused';
      this.log('game_paused', '女神暂停了对局');
    } else if (!paused && this.data.phase === 'paused') {
      this.data.phase = 'playing';
      this.log('game_resumed', '女神继续了对局');
    }
  }

  submitMove(seat, { from, to, promotion }) {
    this.requireSeat(seat);
    this.requirePhase('playing');
    this.requireNoPending();
    const { state, status } = this.evaluate();
    const color = COLOR_OF_SEAT[seat];
    if (state.turn !== color) fail('not_your_turn', '还没有轮到你走子', 409);
    if (status.over) fail('game_over', '对局已经结束', 409);
    const move = findLegalMove(state, from, to, promotion);
    const wire = wireFromEngine(state, move, { by: 'player' });
    if (this.data.settings.reviewMode) {
      wire.id = randomId('p-', 3);
      wire.ply = this.data.game.moves.length + 1;
      this.data.game.pending = wire;
      this.log('move_pending', `${SIDE_NAMES[seat]}提出走子 ${wire.label}，等待女神裁决`, { seat });
      return;
    }
    const outcome = this.applyMove(state, move, wire);
    this.log('move_played', `${SIDE_NAMES[seat]}走子 ${outcome.wire.label}`, { seat });
    this.finishIfOver(outcome.status);
  }

  cancelPending(seat) {
    this.requireSeat(seat);
    const pending = this.data.game.pending;
    if (!pending) fail('no_pending', '当前没有待裁决的走子', 409);
    if (pending.seat !== seat) fail('not_your_pending', '只能撤回自己的走子', 403);
    this.data.game.pending = null;
    this.log('move_cancelled', `${SIDE_NAMES[seat]}撤回了待裁决走子 ${pending.label}`, { seat });
  }

  goddessReview({ moveId, decision, note }) {
    this.requirePhase('playing');
    const pending = this.data.game.pending;
    if (!pending) fail('no_pending', '当前没有待裁决的走子', 409);
    if (moveId && moveId !== pending.id) {
      fail('stale_pending', '这一步已经变化，请刷新后再处理', 409);
    }
    if (decision === 'reject') {
      const reason = cleanText(note, LIMITS.note) || '女神驳回了这一步';
      this.data.game.rejections.push({
        seat: pending.seat,
        label: pending.label,
        reason,
        at: now(),
      });
      if (this.data.game.rejections.length > 20) this.data.game.rejections.shift();
      this.data.game.pending = null;
      this.log('move_rejected', `女神驳回了${SIDE_NAMES[pending.seat]}的走子 ${pending.label}`, {
        seat: pending.seat,
      });
      return;
    }
    if (decision !== 'approve') fail('bad_decision', '裁决只能是通过或驳回');
    const { state } = this.evaluate();
    if (state.turn !== pending.color) {
      fail('stale_pending', '局面已变化，待裁决走子已失效', 409);
    }
    const move = findLegalMove(state, pending.from, pending.to, pending.promotion);
    const wire = wireFromEngine(state, move, { by: 'player' });
    const outcome = this.applyMove(state, move, wire);
    this.log('move_approved', `女神核准${SIDE_NAMES[pending.seat]}走子 ${outcome.wire.label}`, {
      seat: pending.seat,
    });
    this.finishIfOver(outcome.status);
  }

  goddessForceMove({ from, to, promotion, note }) {
    this.requirePhase('playing');
    this.requireNoPending();
    const { state, status } = this.evaluate();
    if (status.over) fail('game_over', '对局已经结束', 409);
    const move = findLegalMove(state, from, to, promotion);
    const wire = wireFromEngine(state, move, { by: 'goddess' });
    const outcome = this.applyMove(state, move, wire);
    const cleanNote = cleanText(note, LIMITS.note);
    this.log('move_forced', `女神代走 ${outcome.wire.label}${cleanNote ? '（' + cleanNote + '）' : ''}`);
    this.finishIfOver(outcome.status);
  }

  updateIdentityAfterMove(state, move) {
    if (!this.storyEnabled()) return;
    const story = this.data.story;
    const moverColor = state.turn;
    const capturedSquare = move.flags && move.flags.enPassant
      ? Chess.squareName(move.to - (moverColor === 'w' ? 8 : -8))
      : (move.captured ? Chess.squareName(move.to) : null);
    let castleRook = null;
    if (move.flags && move.flags.castle === 'K') {
      castleRook = moverColor === 'w' ? { from: 'h1', to: 'f1' } : { from: 'h8', to: 'f8' };
    } else if (move.flags && move.flags.castle === 'Q') {
      castleRook = moverColor === 'w' ? { from: 'a1', to: 'd1' } : { from: 'a8', to: 'd8' };
    }
    const moved = identityLib.movePiece(story.identity, {
      from: Chess.squareName(move.from),
      to: Chess.squareName(move.to),
      capturedSquare,
      castleRook,
      promotion: move.promotion || null,
    });
    if (moved.capturedPiece) {
      storyRules.retirePiece(story, moved.capturedPiece, SEAT_OF_COLOR[moverColor]);
    }
  }

  applyMove(state, move, wire) {
    const game = this.data.game;
    game.snapshots.push(this.snapshot('move'));
    if (game.snapshots.length > 200) game.snapshots.shift();
    const next = Chess.applyMove(state, move);
    this.updateIdentityAfterMove(state, move);
    const { status } = this.evaluateState(next);
    wire.kind = 'move';
    wire.patternType = null;
    wire.id = wire.id || 'm' + (game.moves.length + 1);
    wire.ply = game.moves.length + 1;
    wire.label += status.inCheck ? (status.result === 'checkmate' ? '#' : '+') : '';
    wire.at = now();
    game.fen = Chess.toFen(next);
    game.positionKeys = next.history;
    game.moves.push(wire);
    game.lastMove = wire;
    game.pending = null;
    return { wire, status };
  }

  submitPoolMove(seat, { type, from, to, promotion } = {}) {
    this.requireSeat(seat);
    this.requireStory();
    this.requirePhase('playing');
    this.requireNoPending();
    const { state, status } = this.evaluate();
    const color = COLOR_OF_SEAT[seat];
    if (state.turn !== color) fail('not_your_turn', '还没有轮到你走子', 409);
    if (status.over || this.data.game.result) fail('game_over', '对局已经结束', 409);
    const patternType = String(type || '').toLowerCase();
    if (!this.data.story.pool.includes(patternType)) {
      fail('pattern_not_available', '共享走法池里没有这种走法', 409);
    }
    let result;
    try {
      result = variantChess.applyPoolMove(state, { from, to, patternType, promotion: promotion || null });
    } catch (error) {
      if (error instanceof variantChess.PoolMoveError) {
        fail(error.code, error.message, error.code === 'promotion_required' ? 409 : 400);
      }
      throw error;
    }
    const game = this.data.game;
    game.snapshots.push(this.snapshot('pool'));
    if (game.snapshots.length > 200) game.snapshots.shift();
    const moved = identityLib.movePiece(this.data.story.identity, {
      from: result.from,
      to: result.to,
      capturedSquare: result.captured ? result.to : null,
      promotion: result.promotion || null,
    });
    if (moved.capturedPiece) {
      storyRules.retirePiece(this.data.story, moved.capturedPiece, seat);
    }
    const wire = {
      id: 'm' + (game.moves.length + 1),
      ply: game.moves.length + 1,
      color,
      seat,
      from: result.from,
      to: result.to,
      promotion: result.promotion || null,
      piece: state.board[Chess.squareIndex(result.from)],
      captured: result.captured || null,
      flags: { castle: null, enPassant: false, doublePush: false },
      label: variantChess.publicPoolMoveLabel({
        from: result.from,
        to: result.to,
        capture: Boolean(result.captured),
      }),
      by: 'player',
      kind: 'special',
      patternType: null,
      at: now(),
    };
    const next = result.state;
    const nextEvaluation = this.evaluateState(next);
    wire.label += nextEvaluation.status.inCheck
      ? (nextEvaluation.status.result === 'checkmate' ? '#' : '+')
      : '';
    game.fen = Chess.toFen(next);
    game.positionKeys = next.history;
    game.moves.push(wire);
    game.lastMove = wire;
    game.pending = null;
    storyRules.recordPoolUse(this.data.story, {
      seat,
      patternType,
      from: result.from,
      to: result.to,
      capture: Boolean(result.captured),
    });
    this.log('pool_move', `${SIDE_NAMES[seat]}使用共享走法 ${wire.label}`, { seat });
    this.finishIfOver(nextEvaluation.status);
  }

  submitErase(seat, { target, name } = {}) {
    this.requireSeat(seat);
    this.requireStory();
    this.requirePhase('playing');
    this.requireNoPending();
    if (!storyRules.isEraseAbility(this.data.story, seat)) {
      fail('ability_not_available', '本方没有真名抹除能力', 403);
    }
    const game = this.data.game;
    if (game.result) fail('game_over', '对局已经结束', 409);
    const { state, status } = this.evaluate();
    if (status.over) fail('game_over', '对局已经结束', 409);
    const color = COLOR_OF_SEAT[seat];
    if (state.turn !== color) fail('not_your_turn', '只能在自己回合尝试抹除', 409);
    if (this.data.story.eraseUsedAtPly === game.moves.length) {
      fail('erase_already_used', '本回合已经尝试过一次抹除', 409);
    }
    if (typeof target !== 'string' || Chess.squareIndex(target) < 0) fail('bad_square', '目标格格式不正确');
    const targetPiece = identityLib.pieceAt(this.data.story.identity, target);
    if (!targetPiece) fail('empty_square', '目标格没有棋子');
    if (targetPiece.color === color) fail('own_piece', '不能抹除自己的棋子');
    const cleanName = storyRules.normalizeName(name);
    if (!cleanName) fail('empty_name', '必须提交一个名字');
    const isKing = targetPiece.type === 'k';
    if (isKing && !this.data.story.kingErasureWins) {
      fail('king_erase_disabled', '本局不允许抹除王', 409);
    }

    const matched = storyRules.nameMatches(targetPiece, cleanName);
    if (matched) {
      game.snapshots.push(this.snapshot('erase'));
      if (game.snapshots.length > 200) game.snapshots.shift();
    }
    this.data.story.eraseUsedAtPly = game.moves.length;
    storyRules.recordEraseAttempt(this.data.story, {
      seat,
      targetSquare: target,
      targetPieceId: targetPiece.id,
      name: cleanName,
      success: matched,
    });
    if (!matched) {
      this.log('erase_failed', `${SIDE_NAMES[seat]}的真名抹除尝试未生效`, { seat });
      return { result: 'failed' };
    }

    const board = state.board.slice();
    const targetIndex = Chess.squareIndex(target);
    board[targetIndex] = null;
    identityLib.erasePiece(this.data.story.identity, target);
    const nextFen = fenFromBoard(board, state.turn, state.castling, state.halfmove, state.fullmove);
    let next;
    try {
      next = Chess.parseFen(nextFen);
    } catch (error) {
      fail('bad_fen', '抹除后的棋盘不合法：' + error.message, 500);
    }
    next.history = (state.history || []).concat([Chess.positionKey(state)]);
    game.fen = nextFen;
    game.positionKeys = next.history;
    if (isKing) {
      this.finish(seat, 'erase-king', '真名抹除国王', false);
      this.log('erase_king', `${SIDE_NAMES[seat]}抹除了对方的王`, { seat });
      return { result: 'success' };
    }
    storyRules.retirePiece(this.data.story, targetPiece, seat);
    this.log('erase_success', `${SIDE_NAMES[seat]}的真名抹除生效`, { seat });
    const nextStatus = this.evaluateState(next).status;
    this.finishIfOver(nextStatus);
    return { result: 'success' };
  }

  goddessSetName({ square, name, alias } = {}) {
    this.requireStory();
    this.requirePhase('lobby', 'playing', 'paused');
    if (typeof square !== 'string' || Chess.squareIndex(square) < 0) fail('bad_square', '棋子位置格式不正确');
    const piece = identityLib.pieceAt(this.data.story.identity, square);
    if (!piece) fail('empty_square', '该格没有棋子');
    const clean = storyRules.normalizeName(name);
    if (!clean) fail('empty_name', '真名不能为空');
    storyRules.setName(this.data.story, square, clean, alias);
    this.log('name_set', '女神配置了一枚棋子的真名');
    return { square };
  }

  requireStory() {
    if (!this.storyEnabled()) fail('story_unavailable', '本房间没有启用剧情规则', 409);
  }

  teammateView(presence = {}, origin = null) {
    const base = this.stateFor('player', 'white', presence, origin);
    return {
      roomId: base.roomId,
      version: base.version,
      phase: base.phase,
      seat: 'white',
      team: 'A',
      turn: base.game.turn,
      public: {
        fen: base.game.fen,
        turn: base.game.turn,
        phase: base.phase,
        inCheck: base.game.inCheck,
        checkmate: base.game.checkmate,
        stalemate: base.game.stalemate,
        draw: base.game.draw,
        result: base.game.result,
        lastMove: base.game.lastMove,
        moves: base.game.moves,
        story: base.game.story || null,
      },
      own: {
        rule: base.me.rule,
        guesses: base.me.guesses,
        standardMoves: base.game.legalMoves,
        abilityLabel: base.me.story ? base.me.story.abilityLabel : null,
        abilityHelp: base.me.story ? base.me.story.abilityHelp : null,
        specialActions: base.me.story ? base.me.story.specialActions : [],
        canSpecial: Boolean(base.me.story && base.me.story.canSpecial),
        canMove: base.me.canMove,
        canGuess: base.me.canGuess,
        attemptsUsed: base.me.attemptsUsed,
        attemptsLeft: base.me.attemptsLeft,
        teammate: base.me.teammate || null,
      },
      announcements: base.announcements,
      revealed: base.revealed,
    };
  }

  finishIfOver(status) {
    if (!status.over) return;
    const winner = status.result === 'checkmate' && status.winner
      ? seatOfColor(status.winner)
      : 'draw';
    this.finish(winner, status.reason, null, true);
  }

  finish(winner, reason, note, automatic) {
    const game = this.data.game;
    if (this.data.phase === 'finished') return;
    this.data.phase = 'finished';
    game.pending = null;
    game.finishedAt = now();
    game.result = {
      winner,
      reason,
      note: cleanText(note, LIMITS.note) || null,
      automatic: Boolean(automatic),
      at: now(),
    };
    for (const guess of this.data.guesses) {
      if (guess.status === 'pending') guess.status = 'void';
    }
    const resultLabel = winner === 'draw' ? '和棋' : `${SIDE_NAMES[winner]}胜`;
    this.log('game_end', `对局结束：${resultLabel}（${RESULT_TEXT[reason] || reason}）`);
  }

  goddessEnd({ winner, reason, note }) {
    this.requirePhase('playing', 'paused');
    const safeWinner = normalizeWinner(winner);
    const allowed = new Set(['resign', 'goddess', 'agreement', 'abort', 'timeout']);
    const safeReason = allowed.has(reason) ? reason : 'goddess';
    this.finish(safeWinner, safeReason, note, false);
    this.log('game_ended_by_goddess', `女神结束了本局：${safeWinner === 'draw' ? '和棋' : SIDE_NAMES[safeWinner] + '胜'}`);
  }

  // ---------- 棋盘受控修改 ----------

  editBoard(op = {}) {
    this.requirePhase('playing', 'paused');
    this.requireNoPending();
    const state = this.chessState();
    const board = state.board.slice();
    let turn = state.turn;
    let castling = state.castling;
    const square = op.square;
    let description = '';

    if (op.op === 'remove') {
      const index = Chess.squareIndex(square);
      if (index < 0) fail('bad_square', '棋子位置格式不正确');
      const piece = board[index];
      if (!piece) fail('empty_square', '该格没有棋子', 409);
      if (piece.toUpperCase() === 'K') fail('cannot_remove_king', '原型不允许移除王', 409);
      board[index] = null;
      description = `移除 ${square} 上的${piece.toUpperCase() === piece ? '白' : '黑'}${pieceName(piece)}`;
    } else if (op.op === 'place') {
      const index = Chess.squareIndex(square);
      if (index < 0) fail('bad_square', '棋子位置格式不正确');
      if (board[index]) fail('occupied_square', '该格已经有棋子', 409);
      const type = String(op.type || '').toLowerCase();
      if (!'pnbrqk'.includes(type) || type.length !== 1) fail('bad_piece', '棋子类型只能是 p/n/b/r/q/k');
      const color = op.color;
      if (color !== 'w' && color !== 'b') fail('bad_color', '棋子颜色只能是 w 或 b');
      if (type === 'p' && (Math.floor(index / 8) === 0 || Math.floor(index / 8) === 7)) {
        fail('bad_pawn_rank', '兵不能放在第 1/8 横线', 409);
      }
      if (type === 'k' && board.some((piece) => piece === (color === 'w' ? 'K' : 'k'))) {
        fail('duplicate_king', '该方已经有王，不能放置第二枚', 409);
      }
      board[index] = color === 'w' ? type.toUpperCase() : type;
      description = `在 ${square} 放置${color === 'w' ? '白' : '黑'}${pieceName(type.toUpperCase())}`;
    } else if (op.op === 'setTurn') {
      turn = op.turn;
      if (turn !== 'w' && turn !== 'b') fail('bad_turn', '行棋方只能是 w 或 b');
      description = `将行棋方改为${turn === 'w' ? '白方' : '黑方'}`;
    } else {
      fail('bad_op', '未知的棋盘修改操作');
    }

    const placement = boardPlacement(board);
    const nextFen = [
      placement,
      turn,
      castlingText(board, castling),
      '-',
      '0',
      String(state.fullmove || 1),
    ].join(' ');

    let next;
    try {
      next = Chess.parseFen(nextFen);
    } catch (error) {
      fail('bad_fen', '修改后的棋盘不合法：' + error.message, 409);
    }
    if (Chess.kingSquare(next.board, 'w') < 0 || Chess.kingSquare(next.board, 'b') < 0) {
      fail('missing_king', '修改后双方都必须有一枚王', 409);
    }
    const nonTurn = turn === 'w' ? 'b' : 'w';
    const nonTurnKing = Chess.kingSquare(next.board, nonTurn);
    if (Chess.isSquareAttacked(next.board, nonTurnKing, turn)) {
      fail('illegal_position', '修改后非行棋方处于被将军状态，棋盘不合法', 409);
    }

    const game = this.data.game;
    game.snapshots.push(this.snapshot('edit'));
    if (game.snapshots.length > 200) game.snapshots.shift();
    if (this.storyEnabled()) {
      if (op.op === 'remove') identityLib.erasePiece(this.data.story.identity, square);
      else if (op.op === 'place') {
        try {
          identityLib.placePiece(this.data.story.identity, {
            square,
            color: op.color,
            type: op.type,
          });
        } catch (error) {
          fail('bad_place', '放置棋子后身份同步失败：' + error.message, 409);
        }
      }
    }
    game.fen = nextFen;
    game.positionKeys = [];
    game.pending = null;
    game.lastEdit = {
      op: op.op,
      square: square || null,
      syntax: description,
      note: cleanText(op.note, LIMITS.note) || null,
      at: now(),
    };
    this.log('board_edited', `女神修改了棋盘：${description}${game.lastEdit.note ? '（' + game.lastEdit.note + '）' : ''}`);
  }

  // ---------- 悔棋 ----------

  undo() {
    const game = this.data.game;
    if (!['playing', 'paused', 'finished'].includes(this.data.phase)) {
      fail('wrong_phase', '当前阶段不能撤销', 409);
    }
    if (game.pending) fail('pending_move', '请先处理待裁决走子', 409);
    if (this.data.phase === 'finished') {
      const reason = game.result && game.result.reason;
      const revealed = this.data.rules.white.revealedAt || this.data.rules.black.revealedAt;
      if (!AUTO_END_REASONS.has(reason) || revealed) {
        fail('cannot_undo_finish', '终局由裁定或揭晓产生，不能撤销；请重开一局', 409);
      }
    }
    const snapshot = game.snapshots.pop();
    if (!snapshot) fail('nothing_to_undo', '没有可以撤销的操作', 409);
    game.fen = snapshot.fen;
    game.positionKeys = snapshot.keys;
    game.moves.length = snapshot.movesLen;
    game.lastMove = snapshot.lastMove;
    game.lastEdit = snapshot.lastEdit || null;
    game.pending = null;
    if (snapshot.story && this.storyEnabled()) this.data.story = snapshot.story;
    if (snapshot.kind === 'move' || this.data.phase === 'finished') {
      game.result = null;
      game.finishedAt = null;
      if (this.data.phase === 'finished') this.data.phase = 'playing';
    }
    const undoText = snapshot.kind === 'move'
      ? '女神撤销了上一步走子'
      : snapshot.kind === 'pool'
        ? '女神撤销了上一次共享走法'
        : snapshot.kind === 'erase'
          ? '女神撤销了上一次真名抹除'
          : '女神撤销了上一次棋盘修改';
    this.log('undo', undoText);
  }

  // ---------- 猜测 ----------

  submitGuess(seat, text) {
    this.requireSeat(seat);
    this.requirePhase('playing');
    if (this.data.game.result) fail('game_over', '对局已经结束', 409);
    const guesses = this.data.guesses.filter((guess) => guess.seat === seat && guess.status !== 'void');
    if (guesses.some((guess) => guess.status === 'pending')) {
      fail('guess_pending', '已经有一条猜测等待女神裁定', 409);
    }
    const limit = this.data.settings.guessLimit;
    if (limit > 0 && guesses.length >= limit) {
      fail('guess_limit', '猜测次数已经用完', 409);
    }
    const clean = cleanText(text, LIMITS.guess);
    if (!clean) fail('empty_guess', '猜测内容不能为空');
    const guess = {
      id: 'g' + (this.data.guesses.length + 1),
      seat,
      text: clean,
      status: 'pending',
      note: null,
      at: now(),
      judgedAt: null,
    };
    this.data.guesses.push(guess);
    this.log('guess_submitted', `${SIDE_NAMES[seat]}提交了一条规则猜测`, { seat });
  }

  judgeGuess({ guessId, correct, note }) {
    const guess = this.data.guesses.find((item) => item.id === guessId);
    if (!guess) fail('guess_not_found', '没有找到这条猜测', 404);
    if (guess.status !== 'pending') fail('guess_judged', '这条猜测已经裁定过了', 409);
    const cleanNote = cleanText(note, LIMITS.note) || null;
    if (correct) {
      guess.status = 'correct';
      guess.note = cleanNote;
      guess.judgedAt = now();
      this.finish(guess.seat, 'guess', cleanNote, false);
      this.revealAll();
      this.log('guess_correct', `女神判定：${SIDE_NAMES[guess.seat]}猜中了隐藏规则，本局获胜`, {
        seat: guess.seat,
      });
    } else {
      guess.status = 'wrong';
      guess.note = cleanNote;
      guess.judgedAt = now();
      this.log('guess_wrong', `女神判定：${SIDE_NAMES[guess.seat]}的猜测未命中`, { seat: guess.seat });
    }
  }

  // ---------- 设置 / 公告 / 重开 ----------

  updateSettings({ reviewMode, guessLimit }) {
    if (reviewMode !== undefined) {
      if (typeof reviewMode !== 'boolean') fail('bad_setting', 'reviewMode 必须是布尔值');
      this.data.settings.reviewMode = reviewMode;
      this.log('settings_changed', `逐手审核已${reviewMode ? '开启' : '关闭'}`);
    }
    if (guessLimit !== undefined) {
      const limit = clampGuessLimit(guessLimit);
      this.data.settings.guessLimit = limit;
      this.log('settings_changed', `猜测次数上限改为 ${limit === 0 ? '不限' : limit}`);
    }
  }

  announce(text) {
    const clean = cleanText(text, LIMITS.announce);
    if (!clean) fail('empty_announce', '公告内容不能为空');
    this.data.announcements.push({ id: 'a' + (this.data.announcements.length + 1), text: clean, at: now() });
    if (this.data.announcements.length > 50) this.data.announcements.shift();
    this.log('announce', `女神公告：${clean}`);
  }

  reset() {
    const data = this.data;
    data.phase = 'lobby';
    data.game = freshGame();
    data.rules = { white: emptyRule(), black: emptyRule() };
    data.guesses = [];
    data.announcements = [];
    data.story = data.scenario
      ? storyRules.createStoryState(data.scenario, Chess.START_FEN)
      : { enabled: false };
    this.log('reset', '女神重开了一局：回到提交规则阶段');
  }

  // ---------- 导出 ----------

  exportData() {
    const clone = JSON.parse(JSON.stringify(this.data));
    delete clone.tokens;
    return {
      exportedAt: now(),
      notice: '女神导出的房间全量记录，包含双方隐藏规则与猜测原文；请勿公开。',
      room: clone,
    };
  }

  // ---------- 状态投影 ----------

  stateFor(role, seat, presence = {}, origin = null) {
    const data = this.data;
    const storyEnabled = this.storyEnabled();
    const { state, legalMoves, status } = this.evaluate();
    const isGoddess = role === 'goddess';
    const mySeat = isGoddess ? null : seat;
    const canMove = Boolean(
      mySeat &&
        data.phase === 'playing' &&
        !data.game.pending &&
        state.turn === COLOR_OF_SEAT[mySeat] &&
        !status.over,
    );
    const canGoddessMove = isGoddess && data.phase === 'playing' && !data.game.pending && !status.over;
    const includeMoves = canMove || canGoddessMove;
    const moveList = includeMoves
      ? legalMoves.map((move) => ({
          from: Chess.squareName(move.from),
          to: Chess.squareName(move.to),
          promotion: move.promotion || null,
        }))
      : [];

    const game = {
      fen: data.game.fen,
      turn: state.turn,
      ply: data.game.moves.length,
      inCheck: status.inCheck,
      checkmate: status.result === 'checkmate',
      stalemate: status.result === 'stalemate',
      draw: status.result === 'draw',
      legalMoves: moveList,
      lastMove: data.game.lastMove,
      pendingMove: data.game.pending,
      moves: data.game.moves,
      result: isGoddess ? data.game.result : publicGameResult(data.game.result),
      lastEdit: isGoddess ? data.game.lastEdit : null,
      reviewMode: data.settings.reviewMode,
      guessLimit: data.settings.guessLimit,
    };
    if (storyEnabled) game.story = storyRules.publicView(data.story);

    const players = {};
    for (const side of SEATS) {
      const own = data.guesses.filter((guess) => guess.seat === side && guess.status !== 'void');
      players[side] = {
        connected: Boolean(presence[side]),
        rule: {
          submitted: data.rules[side].status !== 'empty',
          status: data.rules[side].status,
        },
        guess: {
          used: own.length,
          pending: own.some((guess) => guess.status === 'pending'),
        },
      };
    }

    let me = null;
    if (!isGoddess && mySeat) {
      const rule = data.rules[mySeat];
      const ownGuesses = data.guesses
        .filter((guess) => guess.seat === mySeat && guess.status !== 'void')
        .map((guess) => ({
          id: guess.id,
          text: guess.text,
          status: guess.status,
          note: guess.note,
          at: guess.at,
        }));
      const used = ownGuesses.length;
      const limit = data.settings.guessLimit;
      const lastRejection = [...data.game.rejections]
        .reverse()
        .find((item) => item.seat === mySeat) || null;
      me = {
        seat: mySeat,
        color: COLOR_OF_SEAT[mySeat],
        rule: {
          status: rule.status,
          text: rule.text,
          note: rule.note,
          updatedAt: rule.updatedAt,
          revealed: Boolean(rule.revealedAt),
        },
        guesses: ownGuesses,
        attemptsUsed: used,
        attemptsLeft: limit > 0 ? Math.max(0, limit - used) : null,
        canMove,
        canGuess: Boolean(
          data.phase === 'playing' &&
            !data.game.result &&
            !ownGuesses.some((guess) => guess.status === 'pending') &&
            (limit === 0 || used < limit),
        ),
        canSubmitRule:
          data.phase === 'lobby' && (rule.status === 'empty' || rule.status === 'returned'),
        canCancelPending: Boolean(data.game.pending && data.game.pending.seat === mySeat),
        lastRejection: lastRejection
          ? { label: lastRejection.label, reason: lastRejection.reason, at: lastRejection.at }
          : null,
      };
      if (storyEnabled) {
        // 适配器状态只属于 A；B 始终显示对方由人操作。
        me.teammate = mySeat === 'black'
          ? teammateAdapter.getTeammateStatus('black')
          : (this.teammateStatus || teammateAdapter.getTeammateStatus(mySeat));
        me.story = storyRules.playerView(data.story, mySeat, state, data.phase, data.game.moves.length);
      }
    }

    let goddess = null;
    if (isGoddess) {
      goddess = {
        rules: {
          white: ruleView(data.rules.white),
          black: ruleView(data.rules.black),
        },
        guesses: data.guesses.map((guess) => ({
          id: guess.id,
          seat: guess.seat,
          text: guess.text,
          status: guess.status,
          note: guess.note,
          at: guess.at,
          judgedAt: guess.judgedAt,
        })),
        settings: { ...data.settings },
        events: data.events.slice(-100).map((event) => ({
          id: event.id,
          seq: event.seq,
          type: event.type,
          at: event.at,
          text: event.text,
        })),
        links: origin
          ? {
              white: `${origin}/room/${data.id}?token=${data.tokens.white}`,
              black: `${origin}/room/${data.id}?token=${data.tokens.black}`,
              goddess: `${origin}/room/${data.id}?token=${data.tokens.goddess}`,
            }
          : null,
      };
      goddess.adapter = this.goddessStatus || teammateAdapter.getGoddessStatus();
      if (storyEnabled) {
        goddess.story = storyRules.goddessView(data.story);
        goddess.resultLabel = data.game.result
          ? (RESULT_TEXT[data.game.result.reason] || data.game.result.reason)
          : null;
      }
    }

    const revealed = {
      white: data.rules.white.revealedAt
        ? { text: data.rules.white.text, revealedAt: data.rules.white.revealedAt }
        : null,
      black: data.rules.black.revealedAt
        ? { text: data.rules.black.text, revealedAt: data.rules.black.revealedAt }
        : null,
    };

    return {
      roomId: data.id,
      version: data.version,
      role,
      seat: mySeat,
      phase: data.phase,
      createdAt: data.createdAt,
      updatedAt: data.updatedAt,
      game,
      players,
      me,
      goddess,
      announcements: data.announcements.slice(-30),
      revealed,
    };
  }
}

function ruleView(rule) {
  return {
    text: rule.text,
    status: rule.status,
    note: rule.note,
    updatedAt: rule.updatedAt,
    revealedAt: rule.revealedAt,
  };
}

function pieceName(type) {
  return { P: '兵', N: '马', B: '象', R: '车', Q: '后', K: '王' }[type.toUpperCase()] || type;
}

function clampGuessLimit(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 3;
  return Math.max(0, Math.min(9, Math.floor(number)));
}

module.exports = {
  Room,
  RoomError,
  SEATS,
  SIDE_NAMES,
  LIMITS,
  RESULT_TEXT,
  AUTO_END_REASONS,
  publicGameResult,
  newToken,
  cleanText,
};
