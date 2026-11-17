'use strict';

/*
 * 棋子身份层：把“棋子是谁”从 FEN 中独立出来。
 *
 * 剧情规则里的真名必须跟随棋子（移动、吃子、易位、升变、撤销、女神改盘），
 * 而 FEN 只有 64 格字符。这里维护：
 *   pieces: { [pieceId]: { id, color, type, originalType, trueName, alias, square } }
 *   squares: { e4: pieceId, ... }
 *
 * 本模块只处理数据，不读取规则文本、不执行任何内容。
 * 投影时绝不能把本对象原样发给玩家（只在女神视图/导出中出现）。
 */

const Chess = require('./chess.js');

function colorOfChar(ch) {
  return ch === ch.toUpperCase() ? 'w' : 'b';
}

function normalizeName(value) {
  if (typeof value !== 'string') return '';
  return value
    .normalize('NFC')
    .replace(/[\u0000-\u001F\u007F]/g, '')
    .trim()
    .slice(0, 40);
}

function createIdentity(fen, nameSeeds = []) {
  const state = Chess.parseFen(fen);
  const pieces = {};
  const squares = {};
  for (let index = 0; index < 64; index += 1) {
    const ch = state.board[index];
    if (!ch) continue;
    const square = Chess.squareName(index);
    const color = colorOfChar(ch);
    const type = ch.toLowerCase();
    const id = `${color}-${type}-${square}`;
    pieces[id] = {
      id,
      color,
      type,
      originalType: type,
      trueName: null,
      alias: null,
      square,
    };
    squares[square] = id;
  }
  const identity = { pieces, squares, nextId: 0 };
  for (const seed of Array.isArray(nameSeeds) ? nameSeeds : []) {
    if (!seed || typeof seed !== 'object') continue;
    const piece = pieceAt(identity, seed.square);
    if (!piece) continue;
    if (seed.color && seed.color !== piece.color) continue;
    if (seed.type && String(seed.type).toLowerCase() !== piece.type) continue;
    const name = normalizeName(seed.trueName);
    if (name) piece.trueName = name;
    const alias = normalizeName(seed.alias);
    if (alias) piece.alias = alias;
  }
  return identity;
}

function pieceAt(identity, square) {
  if (!identity || typeof square !== 'string') return null;
  const id = identity.squares[square];
  return id ? identity.pieces[id] || null : null;
}

function pieceById(identity, pieceId) {
  return identity && identity.pieces ? identity.pieces[pieceId] || null : null;
}

/**
 * 同步一步普通/共享走法。
 * options: { capturedSquare, castleRook: {from,to}, promotion }
 * 返回 { piece, capturedPiece }。
 */
function movePiece(identity, { from, to, capturedSquare = null, castleRook = null, promotion = null } = {}) {
  if (!identity || !identity.squares[from]) throw new Error('identity_from_missing');
  const pieceId = identity.squares[from];
  const piece = identity.pieces[pieceId];

  let capturedPiece = null;
  if (capturedSquare && identity.squares[capturedSquare]) {
    const capturedId = identity.squares[capturedSquare];
    capturedPiece = identity.pieces[capturedId] || null;
    delete identity.squares[capturedSquare];
    delete identity.pieces[capturedId];
  }

  delete identity.squares[from];
  piece.square = to;
  identity.squares[to] = pieceId;
  if (promotion) piece.type = String(promotion).toLowerCase();

  if (castleRook && identity.squares[castleRook.from]) {
    const rookId = identity.squares[castleRook.from];
    const rook = identity.pieces[rookId];
    delete identity.squares[castleRook.from];
    rook.square = castleRook.to;
    identity.squares[castleRook.to] = rookId;
  }
  return { piece, capturedPiece };
}

function erasePiece(identity, square) {
  const piece = pieceAt(identity, square);
  if (!piece) return null;
  delete identity.squares[square];
  delete identity.pieces[piece.id];
  return piece;
}

function placePiece(identity, { square, color, type, trueName = null, alias = null } = {}) {
  if (!identity) throw new Error('identity_required');
  if (identity.squares[square]) throw new Error('square_occupied');
  const lowerType = String(type || '').toLowerCase();
  if (!'pnbrqk'.includes(lowerType) || lowerType.length !== 1) throw new Error('bad_piece');
  if (color !== 'w' && color !== 'b') throw new Error('bad_color');
  identity.nextId = (identity.nextId || 0) + 1;
  const id = `${color}-${lowerType}-x${identity.nextId}`;
  const piece = {
    id,
    color,
    type: lowerType,
    originalType: lowerType,
    trueName: normalizeName(trueName) || null,
    alias: normalizeName(alias) || null,
    square,
  };
  identity.pieces[id] = piece;
  identity.squares[square] = id;
  return piece;
}

function setName(identity, square, trueName, alias = undefined) {
  const piece = pieceAt(identity, square);
  if (!piece) return null;
  const name = normalizeName(trueName);
  if (!name) throw new Error('empty_name');
  piece.trueName = name;
  if (alias !== undefined) {
    const cleanAlias = normalizeName(alias);
    piece.alias = cleanAlias || null;
  }
  return piece;
}

/** 女神/导出视图：包含真名，只允许女神读取。 */
function goddessView(identity) {
  if (!identity) return [];
  return Object.values(identity.pieces)
    .sort((a, b) => (a.square < b.square ? -1 : a.square > b.square ? 1 : 0))
    .map((piece) => ({
      pieceId: piece.id,
      square: piece.square,
      color: piece.color,
      type: piece.type,
      originalType: piece.originalType,
      trueName: piece.trueName,
      alias: piece.alias,
    }));
}

function cloneIdentity(identity) {
  return JSON.parse(JSON.stringify(identity));
}

function poolTypeOf(piece) {
  if (!piece) return null;
  return piece.originalType || piece.type || null;
}

module.exports = {
  createIdentity,
  pieceAt,
  pieceById,
  movePiece,
  erasePiece,
  placePiece,
  setName,
  goddessView,
  cloneIdentity,
  normalizeName,
  poolTypeOf,
};
