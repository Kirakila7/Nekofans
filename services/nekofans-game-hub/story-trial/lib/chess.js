/*
 * Nekofans 双人国际象棋 · 规则内核（v0.1.0）
 *
 * 纯函数、无 DOM、无网络、无文件系统访问。浏览器构建会把本文件原样内联进
 * nekofans-chess.html，因此这里刻意使用经典脚本 + UMD 包装：
 *   - 浏览器内联：挂到 globalThis.NekofansChess
 *   - node:test：通过 createRequire 加载
 *
 * 公开行动日志的确定性重放是本游戏“双端一致”的唯一依据：
 * 双方都从空棋盘开始，按相同顺序重放公共行动，任何非法/越序/格式错误的
 * 行动都被同样地忽略。规则内核不保存任何私密数据。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  else root.NekofansChess = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
  const FILES = 'abcdefgh';
  const UCI_PATTERN = /^[a-h][1-8][a-h][1-8][qrbn]?$/;

  // 王车易位权利位：白王翼、白后翼、黑王翼、黑后翼
  const CASTLE_WK = 1;
  const CASTLE_WQ = 2;
  const CASTLE_BK = 4;
  const CASTLE_BQ = 8;

  const KNIGHT_DELTAS = [
    [1, 2], [2, 1], [2, -1], [1, -2],
    [-1, -2], [-2, -1], [-2, 1], [-1, 2],
  ];
  const BISHOP_DIRS = [[1, 1], [1, -1], [-1, 1], [-1, -1]];
  const ROOK_DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  const KING_DIRS = [[1, 1], [1, 0], [1, -1], [0, 1], [0, -1], [-1, 1], [-1, 0], [-1, -1]];

  const PIECE_NAMES = {
    P: '兵', N: '马', B: '象', R: '车', Q: '后', K: '王',
    p: '兵', n: '马', b: '象', r: '车', q: '后', k: '王',
  };

  function fileOf(index) { return index & 7; }
  function rankOf(index) { return index >> 3; }
  function squareIndex(name) {
    if (typeof name !== 'string' || !/^[a-h][1-8]$/.test(name)) return -1;
    return (Number(name[1]) - 1) * 8 + FILES.indexOf(name[0]);
  }
  function squareName(index) {
    if (!Number.isInteger(index) || index < 0 || index > 63) return null;
    return FILES[fileOf(index)] + String(rankOf(index) + 1);
  }
  function colorOf(piece) { return piece === piece.toUpperCase() ? 'w' : 'b'; }
  function otherColor(color) { return color === 'w' ? 'b' : 'w'; }
  function inside(file, rank) { return file >= 0 && file < 8 && rank >= 0 && rank < 8; }

  function emptyBoard() { return new Array(64).fill(null); }

  function createInitialState() { return parseFen(START_FEN); }

  function parseFen(fen) {
    if (typeof fen !== 'string') throw new Error('FEN must be a string');
    const fields = fen.trim().split(/\s+/);
    if (fields.length < 4) throw new Error('FEN must have at least 4 fields');
    const [placement, turn, castlingText, epText, halfmoveText, fullmoveText] = fields;
    if (turn !== 'w' && turn !== 'b') throw new Error('invalid FEN turn');
    const board = emptyBoard();
    let rank = 7;
    let file = 0;
    for (const ch of placement) {
      if (ch === '/') { rank -= 1; file = 0; continue; }
      if (/[1-8]/.test(ch)) { file += Number(ch); continue; }
      if (!/[pnbrqkPNBRQK]/.test(ch)) throw new Error('invalid FEN piece');
      if (!inside(file, rank)) throw new Error('invalid FEN placement');
      board[rank * 8 + file] = ch;
      file += 1;
    }
    let castling = 0;
    if (castlingText.includes('K')) castling |= CASTLE_WK;
    if (castlingText.includes('Q')) castling |= CASTLE_WQ;
    if (castlingText.includes('k')) castling |= CASTLE_BK;
    if (castlingText.includes('q')) castling |= CASTLE_BQ;
    const ep = epText && epText !== '-' ? squareIndex(epText) : -1;
    if (epText && epText !== '-' && ep < 0) throw new Error('invalid FEN en passant');
    return {
      board,
      turn,
      castling,
      ep,
      halfmove: Math.max(0, Number(halfmoveText) || 0),
      fullmove: Math.max(1, Number(fullmoveText) || 1),
      // 之前出现过的局面键（不含当前局面）；用于三次/五次重复判定。
      history: [],
    };
  }

  function toFen(state) {
    const rows = [];
    for (let rank = 7; rank >= 0; rank -= 1) {
      let row = '';
      let gap = 0;
      for (let file = 0; file < 8; file += 1) {
        const piece = state.board[rank * 8 + file];
        if (!piece) { gap += 1; continue; }
        if (gap) { row += String(gap); gap = 0; }
        row += piece;
      }
      if (gap) row += String(gap);
      rows.push(row);
    }
    let castling = '';
    if (state.castling & CASTLE_WK) castling += 'K';
    if (state.castling & CASTLE_WQ) castling += 'Q';
    if (state.castling & CASTLE_BK) castling += 'k';
    if (state.castling & CASTLE_BQ) castling += 'q';
    return [
      rows.join('/'),
      state.turn,
      castling || '-',
      state.ep >= 0 ? squareName(state.ep) : '-',
      String(state.halfmove),
      String(state.fullmove),
    ].join(' ');
  }

  function positionKey(state) {
    return state.board.map((piece) => piece || '.').join('') +
      '|' + state.turn + '|' + state.castling + '|' + state.ep;
  }

  function repetitionCount(state) {
    const key = positionKey(state);
    let count = 1;
    for (const previous of state.history) if (previous === key) count += 1;
    return count;
  }

  function kingSquare(board, color) {
    const king = color === 'w' ? 'K' : 'k';
    for (let index = 0; index < 64; index += 1) if (board[index] === king) return index;
    return -1;
  }

  function isSquareAttacked(board, target, byColor) {
    if (target < 0) return false;
    const tf = fileOf(target);
    const tr = rankOf(target);

    // 兵（白兵向上攻击 rank+1，所以攻击者位于目标 rank-1）
    const pawn = byColor === 'w' ? 'P' : 'p';
    const pawnRank = byColor === 'w' ? tr - 1 : tr + 1;
    if (pawnRank >= 0 && pawnRank < 8) {
      for (const df of [-1, 1]) {
        const file = tf + df;
        if (file >= 0 && file < 8 && board[pawnRank * 8 + file] === pawn) return true;
      }
    }

    // 马
    const knight = byColor === 'w' ? 'N' : 'n';
    for (const [df, dr] of KNIGHT_DELTAS) {
      const file = tf + df;
      const rank = tr + dr;
      if (inside(file, rank) && board[rank * 8 + file] === knight) return true;
    }

    // 王
    const king = byColor === 'w' ? 'K' : 'k';
    for (const [df, dr] of KING_DIRS) {
      const file = tf + df;
      const rank = tr + dr;
      if (inside(file, rank) && board[rank * 8 + file] === king) return true;
    }

    // 车 / 后（直线）
    const rook = byColor === 'w' ? 'R' : 'r';
    const queen = byColor === 'w' ? 'Q' : 'q';
    for (const [df, dr] of ROOK_DIRS) {
      let file = tf + df;
      let rank = tr + dr;
      while (inside(file, rank)) {
        const piece = board[rank * 8 + file];
        if (piece) {
          if (piece === rook || piece === queen) return true;
          break;
        }
        file += df;
        rank += dr;
      }
    }

    // 象 / 后（斜线）
    const bishop = byColor === 'w' ? 'B' : 'b';
    for (const [df, dr] of BISHOP_DIRS) {
      let file = tf + df;
      let rank = tr + dr;
      while (inside(file, rank)) {
        const piece = board[rank * 8 + file];
        if (piece) {
          if (piece === bishop || piece === queen) return true;
          break;
        }
        file += df;
        rank += dr;
      }
    }

    return false;
  }

  function pushMove(moves, move) { moves.push(move); }

  function addPawnMoves(moves, state, from, to, color, promotionRank, extra) {
    const move = {
      from,
      to,
      piece: color === 'w' ? 'P' : 'p',
      captured: extra && extra.captured ? extra.captured : null,
      promotion: null,
      flags: (extra && extra.flags) || {},
    };
    if (rankOf(to) === promotionRank) {
      for (const promotion of ['q', 'r', 'b', 'n']) pushMove(moves, { ...move, promotion });
    } else {
      pushMove(moves, move);
    }
  }

  function pseudoMoves(state, color) {
    const moves = [];
    const board = state.board;
    const direction = color === 'w' ? 1 : -1;
    const startRank = color === 'w' ? 1 : 6;
    const promotionRank = color === 'w' ? 7 : 0;

    for (let from = 0; from < 64; from += 1) {
      const piece = board[from];
      if (!piece || colorOf(piece) !== color) continue;
      const type = piece.toUpperCase();
      const file = fileOf(from);
      const rank = rankOf(from);

      if (type === 'P') {
        const oneRank = rank + direction;
        const one = oneRank * 8 + file;
        if (inside(file, oneRank) && !board[one]) {
          addPawnMoves(moves, state, from, one, color, promotionRank);
          const twoRank = rank + direction * 2;
          const two = twoRank * 8 + file;
          if (rank === startRank && !board[two]) {
            addPawnMoves(moves, state, from, two, color, promotionRank, {
              flags: { doublePush: true },
            });
          }
        }
        for (const df of [-1, 1]) {
          const targetFile = file + df;
          if (!inside(targetFile, oneRank)) continue;
          const to = oneRank * 8 + targetFile;
          const target = board[to];
          if (target && colorOf(target) !== color) {
            addPawnMoves(moves, state, from, to, color, promotionRank, { captured: target });
          } else if (!target && to === state.ep) {
            const captured = color === 'w' ? 'p' : 'P';
            addPawnMoves(moves, state, from, to, color, promotionRank, {
              captured,
              flags: { enPassant: true },
            });
          }
        }
        continue;
      }

      if (type === 'N') {
        for (const [df, dr] of KNIGHT_DELTAS) {
          const targetFile = file + df;
          const targetRank = rank + dr;
          if (!inside(targetFile, targetRank)) continue;
          const to = targetRank * 8 + targetFile;
          const target = board[to];
          if (target && colorOf(target) === color) continue;
          pushMove(moves, { from, to, piece, captured: target || null, promotion: null, flags: {} });
        }
        continue;
      }

      if (type === 'B' || type === 'R' || type === 'Q') {
        const dirs = type === 'B' ? BISHOP_DIRS : type === 'R' ? ROOK_DIRS : BISHOP_DIRS.concat(ROOK_DIRS);
        for (const [df, dr] of dirs) {
          let targetFile = file + df;
          let targetRank = rank + dr;
          while (inside(targetFile, targetRank)) {
            const to = targetRank * 8 + targetFile;
            const target = board[to];
            if (target && colorOf(target) === color) break;
            pushMove(moves, { from, to, piece, captured: target || null, promotion: null, flags: {} });
            if (target) break;
            targetFile += df;
            targetRank += dr;
          }
        }
        continue;
      }

      if (type === 'K') {
        for (const [df, dr] of KING_DIRS) {
          const targetFile = file + df;
          const targetRank = rank + dr;
          if (!inside(targetFile, targetRank)) continue;
          const to = targetRank * 8 + targetFile;
          const target = board[to];
          if (target && colorOf(target) === color) continue;
          pushMove(moves, { from, to, piece, captured: target || null, promotion: null, flags: {} });
        }

        const opponent = otherColor(color);
        if (color === 'w' && from === 4) {
          if ((state.castling & CASTLE_WK) && board[7] === 'R' && !board[5] && !board[6] &&
              !isSquareAttacked(board, 4, opponent) && !isSquareAttacked(board, 5, opponent) &&
              !isSquareAttacked(board, 6, opponent)) {
            pushMove(moves, { from: 4, to: 6, piece, captured: null, promotion: null, flags: { castle: 'K' } });
          }
          if ((state.castling & CASTLE_WQ) && board[0] === 'R' && !board[1] && !board[2] && !board[3] &&
              !isSquareAttacked(board, 4, opponent) && !isSquareAttacked(board, 3, opponent) &&
              !isSquareAttacked(board, 2, opponent)) {
            pushMove(moves, { from: 4, to: 2, piece, captured: null, promotion: null, flags: { castle: 'Q' } });
          }
        }
        if (color === 'b' && from === 60) {
          if ((state.castling & CASTLE_BK) && board[63] === 'r' && !board[61] && !board[62] &&
              !isSquareAttacked(board, 60, opponent) && !isSquareAttacked(board, 61, opponent) &&
              !isSquareAttacked(board, 62, opponent)) {
            pushMove(moves, { from: 60, to: 62, piece, captured: null, promotion: null, flags: { castle: 'K' } });
          }
          if ((state.castling & CASTLE_BQ) && board[56] === 'r' && !board[57] && !board[58] && !board[59] &&
              !isSquareAttacked(board, 60, opponent) && !isSquareAttacked(board, 59, opponent) &&
              !isSquareAttacked(board, 58, opponent)) {
            pushMove(moves, { from: 60, to: 58, piece, captured: null, promotion: null, flags: { castle: 'Q' } });
          }
        }
      }
    }

    return moves;
  }

  function applyMoveRaw(state, move) {
    const board = state.board.slice();
    const color = state.turn;
    const piece = board[move.from];
    const target = board[move.to];
    let captured = target;
    let castling = state.castling;
    let ep = -1;
    let halfmove = state.halfmove + 1;

    board[move.from] = null;
    if (move.flags && move.flags.enPassant) {
      const capturedSquare = move.to - (color === 'w' ? 8 : -8);
      captured = board[capturedSquare];
      board[capturedSquare] = null;
    }
    board[move.to] = move.promotion
      ? (color === 'w' ? move.promotion.toUpperCase() : move.promotion)
      : piece;

    if (piece.toUpperCase() === 'P' || captured) halfmove = 0;
    if (move.flags && move.flags.doublePush) ep = (move.from + move.to) / 2;

    if (move.flags && move.flags.castle === 'K') {
      const rookFrom = color === 'w' ? 7 : 63;
      const rookTo = color === 'w' ? 5 : 61;
      board[rookTo] = board[rookFrom];
      board[rookFrom] = null;
    } else if (move.flags && move.flags.castle === 'Q') {
      const rookFrom = color === 'w' ? 0 : 56;
      const rookTo = color === 'w' ? 3 : 59;
      board[rookTo] = board[rookFrom];
      board[rookFrom] = null;
    }

    if (piece === 'K') castling &= ~(CASTLE_WK | CASTLE_WQ);
    if (piece === 'k') castling &= ~(CASTLE_BK | CASTLE_BQ);
    if (move.from === 7 || move.to === 7) castling &= ~CASTLE_WK;
    if (move.from === 0 || move.to === 0) castling &= ~CASTLE_WQ;
    if (move.from === 63 || move.to === 63) castling &= ~CASTLE_BK;
    if (move.from === 56 || move.to === 56) castling &= ~CASTLE_BQ;

    return {
      board,
      turn: otherColor(color),
      castling,
      ep,
      halfmove,
      fullmove: state.fullmove + (color === 'b' ? 1 : 0),
      history: state.history,
    };
  }

  function applyMove(state, move) {
    const next = applyMoveRaw(state, move);
    next.history = state.history.concat([positionKey(state)]);
    return next;
  }

  function legalMoves(state) {
    const color = state.turn;
    const opponent = otherColor(color);
    const result = [];
    for (const move of pseudoMoves(state, color)) {
      const next = applyMoveRaw(state, move);
      const king = kingSquare(next.board, color);
      if (king < 0) continue;
      if (!isSquareAttacked(next.board, king, opponent)) result.push(move);
    }
    return result;
  }

  function insufficientMaterial(board) {
    let pieces = 0;
    const minors = [];
    for (let index = 0; index < 64; index += 1) {
      const piece = board[index];
      if (!piece) continue;
      const type = piece.toUpperCase();
      if (type === 'K') continue;
      if (type === 'P' || type === 'R' || type === 'Q') return false;
      pieces += 1;
      minors.push({
        color: colorOf(piece),
        type,
        squareColor: (fileOf(index) + rankOf(index)) % 2,
      });
    }
    if (pieces === 0) return true;
    if (pieces === 1) return true;
    if (pieces === 2 && minors[0].type === 'B' && minors[1].type === 'B' &&
        minors[0].color !== minors[1].color && minors[0].squareColor === minors[1].squareColor) {
      return true;
    }
    return false;
  }

  function evaluate(state, precomputedMoves) {
    const color = state.turn;
    const opponent = otherColor(color);
    const king = kingSquare(state.board, color);
    const inCheck = king >= 0 && isSquareAttacked(state.board, king, opponent);
    const moves = precomputedMoves || legalMoves(state);

    if (moves.length === 0) {
      return {
        over: true,
        result: inCheck ? 'checkmate' : 'stalemate',
        winner: inCheck ? opponent : null,
        reason: inCheck ? 'checkmate' : 'stalemate',
        inCheck,
        legalMoves: moves,
        repetition: repetitionCount(state),
      };
    }

    const repetition = repetitionCount(state);
    let drawReason = null;
    if (insufficientMaterial(state.board)) drawReason = 'insufficient-material';
    else if (state.halfmove >= 150) drawReason = 'seventy-five-move';
    else if (repetition >= 5) drawReason = 'fivefold-repetition';
    else if (state.halfmove >= 100) drawReason = 'fifty-move';
    else if (repetition >= 3) drawReason = 'threefold-repetition';

    return {
      over: Boolean(drawReason),
      result: drawReason ? 'draw' : null,
      winner: null,
      reason: drawReason,
      inCheck,
      legalMoves: moves,
      repetition,
    };
  }

  function moveToUci(move) {
    return squareName(move.from) + squareName(move.to) + (move.promotion || '');
  }

  function moveLabel(move) {
    if (move.flags && move.flags.castle === 'K') return 'O-O';
    if (move.flags && move.flags.castle === 'Q') return 'O-O-O';
    const separator = move.captured ? 'x' : '-';
    return squareName(move.from) + separator + squareName(move.to) +
      (move.promotion ? '=' + move.promotion.toUpperCase() : '');
  }

  function normalizeActionEntry(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const seat = raw.seat;
    if (seat !== 0 && seat !== 1) return null;
    if (typeof raw.action !== 'string') return null;
    const action = raw.action.trim().toLowerCase();
    if (!action || action.length > 128 || !UCI_PATTERN.test(action)) return null;
    return { seat, action, version: Number.isInteger(raw.version) ? raw.version : null };
  }

  /**
   * 根据完整公开行动序列确定性重放。
   * entries: [{seat, action, version?}, ...]，seat 由房间服务端标注。
   * 任何格式错误、越序、非法的行动都会被双方同样跳过，不改变棋盘。
   */
  function replayActions(entries, options) {
    const maxActions = Math.min((options && options.maxActions) || 1000, 1000);
    let state = createInitialState();
    let moves = legalMoves(state);
    let status = evaluate(state, moves);
    const applied = [];
    const rejected = [];

    if (entries !== undefined && entries !== null && !Array.isArray(entries)) {
      return { state, status, applied, rejected: [{ index: -1, reason: 'invalid-action-list' }] };
    }
    const list = Array.isArray(entries) ? entries : [];

    for (let index = 0; index < list.length; index += 1) {
      if (applied.length >= maxActions) {
        rejected.push({ index, reason: 'action-limit' });
        continue;
      }
      if (status.over) { rejected.push({ index, reason: 'game-over' }); continue; }
      const entry = normalizeActionEntry(list[index]);
      if (!entry) { rejected.push({ index, reason: 'malformed' }); continue; }
      const expectedSeat = state.turn === 'w' ? 0 : 1;
      if (entry.seat !== expectedSeat) { rejected.push({ index, reason: 'out-of-turn' }); continue; }
      const move = moves.find((candidate) => moveToUci(candidate) === entry.action);
      if (!move) { rejected.push({ index, reason: 'illegal-move' }); continue; }
      const next = applyMove(state, move);
      applied.push({
        index,
        seat: entry.seat,
        action: entry.action,
        move,
        label: moveLabel(move),
        ply: applied.length + 1,
      });
      state = next;
      moves = legalMoves(state);
      status = evaluate(state, moves);
    }

    return { state, status, applied, rejected };
  }

  function perft(state, depth) {
    if (depth <= 0) return 1;
    const moves = legalMoves(state);
    if (depth === 1) return moves.length;
    let total = 0;
    for (const move of moves) {
      total += perft(applyMoveRaw(state, move), depth - 1);
    }
    return total;
  }

  function describePiece(piece) {
    if (!piece) return '';
    return (colorOf(piece) === 'w' ? '白' : '黑') + PIECE_NAMES[piece];
  }

  return {
    START_FEN,
    createInitialState,
    parseFen,
    toFen,
    positionKey,
    repetitionCount,
    squareIndex,
    squareName,
    fileOf,
    rankOf,
    kingSquare,
    isSquareAttacked,
    legalMoves,
    applyMove,
    evaluate,
    insufficientMaterial,
    moveToUci,
    moveLabel,
    replayActions,
    perft,
    describePiece,
  };
});
