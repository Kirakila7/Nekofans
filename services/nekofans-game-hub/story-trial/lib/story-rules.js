'use strict';

/*
 * 剧情规则状态（服务端私有 + 公开投影）。
 *
 * 公开投影只包含：公开走法池、棋盘变化（无原因/无能力名/无真名/无座位归因）。
 * 公开事件不暴露「抹除」「真名」「共享走法」等能力命名；失败尝试没有任何公共事件。
 * 玩家私有投影只包含：本方能力、自己的抹除尝试（含名字，仅 B）、公开池合法动作。
 * 女神投影才包含：双方规则之外的真名表与全部尝试。
 */

const identityLib = require('./piece-identity.js');
const variant = require('./variant-chess.js');

const ABILITY_OPEN_SOURCE = 'open-source';
const ABILITY_ERASE = 'erase-note';
const ABILITIES = [ABILITY_OPEN_SOURCE, ABILITY_ERASE];
const DEFAULT_POOL_TYPES = ['p', 'n', 'b', 'r', 'q'];
const MAX_EVENTS = 200;

// 仅在服务端使用：玩家请求只返回自己席位对应的条目；公共静态 JS/HTML 不包含这些文本。
const ABILITY_TEXT = {
  [ABILITY_OPEN_SOURCE]: {
    label: '开源 · 公开行动池',
    help: '退场棋子的原始走法进入公开行动池，双方可用；使用会代替一次普通走子。',
  },
  [ABILITY_ERASE]: {
    label: '抹除笔记 · 私密名称行动',
    help: '每回合可额外尝试一次私密名称行动；成功或失败都不代替普通走子。',
  },
};

function createStoryState(scenario, fen) {
  if (!scenario) return { enabled: false };
  const poolTypes = (Array.isArray(scenario.poolTypes) ? scenario.poolTypes : DEFAULT_POOL_TYPES)
    .map((type) => String(type).toLowerCase())
    .filter((type) => variant.PATTERN_TYPES.includes(type));
  return {
    enabled: true,
    scenarioId: scenario.id || 'story',
    abilities: {
      white: scenario.abilities && scenario.abilities.white === ABILITY_ERASE ? ABILITY_ERASE : ABILITY_OPEN_SOURCE,
      black: scenario.abilities && scenario.abilities.black === ABILITY_OPEN_SOURCE ? ABILITY_OPEN_SOURCE : ABILITY_ERASE,
    },
    poolTypes,
    kingErasureWins: scenario.kingErasureWins !== false,
    identity: identityLib.createIdentity(fen, scenario.names || []),
    pool: [],
    events: [],
    attempts: [],
    lastAction: null,
    eraseUsedAtPly: null,
    eventSeq: 0,
  };
}

function cloneStory(story) {
  return JSON.parse(JSON.stringify(story));
}

function record(story, event) {
  story.eventSeq = (story.eventSeq || 0) + 1;
  const item = { seq: story.eventSeq, at: Date.now(), ...event };
  story.events.push(item);
  if (story.events.length > MAX_EVENTS) story.events.splice(0, story.events.length - MAX_EVENTS);
  story.lastAction = item;
  return item;
}

function sanitizeEvent(event) {
  if (!event) return null;
  const result = {
    seq: event.seq,
    at: event.at,
    kind: event.kind,
    outcome: event.outcome || null,
    seat: event.seat || null,
    patternType: event.patternType || null,
    from: event.from || null,
    to: event.to || null,
    capture: Boolean(event.capture),
  };
  return result;
}

function addPoolType(story, type) {
  const clean = String(type || '').toLowerCase();
  if (!story || !story.enabled || !story.poolTypes.includes(clean)) return false;
  if (story.pool.includes(clean)) return false;
  story.pool.push(clean);
  return true;
}

function retirePiece(story, piece, seat) {
  if (!story || !story.enabled || !piece) return null;
  if (piece.type === 'k' || piece.originalType === 'k') return null;
  addPoolType(story, identityLib.poolTypeOf(piece));
  return record(story, {
    kind: 'retire',
    seat: seat || null,
    square: piece.square || null,
    patternType: identityLib.poolTypeOf(piece),
  });
}

function recordPoolUse(story, { seat, patternType, from, to, capture }) {
  return record(story, {
    kind: 'pool-use',
    seat,
    patternType,
    from,
    to,
    capture: Boolean(capture),
  });
}

function recordEraseAttempt(story, { seat, targetSquare, targetPieceId, name, success }) {
  const attempt = {
    id: 'e' + (story.attempts.length + 1),
    seat,
    targetSquare,
    targetPieceId: targetPieceId || null,
    name: identityLib.normalizeName(name),
    success: Boolean(success),
    at: Date.now(),
  };
  story.attempts.push(attempt);
  record(story, {
    kind: 'erase-attempt',
    seat,
    outcome: attempt.success ? 'success' : 'failed',
  });
  return attempt;
}

function publicEvent(event) {
  if (!event) return null;
  // 只公开棋盘变化：不公开原因、能力名、座位归因、目标名字或走法类型。
  // pool-use 已在公开棋谱的 label 中体现为“特殊走法”，不再重复；
  // erase-attempt 的失败/成功细节只留在 B 本人和女神视图。
  if (event.kind === 'retire') {
    return {
      seq: event.seq,
      at: event.at,
      kind: 'board-change',
      change: 'piece-removed',
      square: event.square || null,
    };
  }
  return null;
}

function publicView(story) {
  if (!story || !story.enabled) return null;
  const events = story.events.slice(-100).map(publicEvent).filter(Boolean);
  return {
    enabled: true,
    special: story.pool.map((type) => ({
      type,
      label: variant.poolTypeName(type),
      glyph: variant.poolTypeGlyph(type),
    })),
    events,
    lastAction: events.length ? events[events.length - 1] : null,
  };
}

function playerView(story, seat, state, phase, movesLength) {
  if (!story || !story.enabled) return null;
  const color = seat === 'white' ? 'w' : 'b';
  const isTurn = state.turn === color;
  const poolActions = phase === 'playing' && isTurn
    ? variant.generatePoolActions(state, story.poolTypes)
    : [];
  const specialActions = poolActions.map((action) => ({
    type: action.patternType,
    label: variant.poolTypeName(action.patternType),
    glyph: variant.poolTypeGlyph(action.patternType),
    from: action.from,
    to: action.to,
    capture: Boolean(action.capture),
    promotion: action.promotion || null,
  }));
  const ability = ABILITY_TEXT[story.abilities[seat]] || { label: '私密能力', help: '' };
  const view = {
    abilityLabel: ability.label,
    abilityHelp: ability.help,
    canSpecial: specialActions.length > 0,
    specialActions,
  };
  // 私密行动只下发给拥有该能力的席位；A 的投影不携带任何 B 的字段/标签。
  if (story.abilities[seat] === ABILITY_ERASE) {
    const eraseUsedThisTurn = story.eraseUsedAtPly === movesLength;
    const canErase = phase === 'playing' && isTurn && !eraseUsedThisTurn;
    const attempts = story.attempts
      .filter((attempt) => attempt.seat === seat)
      .map((attempt) => ({
        id: attempt.id,
        targetSquare: attempt.targetSquare,
        name: attempt.name,
        success: attempt.success,
        at: attempt.at,
      }));
    view.privateAction = {
      endpoint: '/extra',
      label: '私密名称行动',
      help: '每回合一次；成功或失败都不代替普通走子。',
      targetPlaceholder: '目标格',
      valuePlaceholder: '名称',
      buttonLabel: '提交私密行动',
      confirm: '确认提交一次私密行动？结果只会写入本页与女神审计。',
      canUse: canErase,
      used: eraseUsedThisTurn,
      attempts,
    };
  }
  return view;
}

function goddessView(story, rules) {
  if (!story || !story.enabled) return null;
  const publicState = publicView(story);
  const abilityFor = (seat) => ABILITY_TEXT[story.abilities[seat]] || { label: '私密能力', help: '' };
  return {
    abilities: { ...story.abilities },
    abilityText: {
      white: abilityFor('white'),
      black: abilityFor('black'),
    },
    poolTypes: story.poolTypes.slice(),
    special: story.pool.slice(),
    kingErasureWins: story.kingErasureWins,
    names: identityLib.goddessView(story.identity).map((piece) => ({
      ...piece,
      privateValue: piece.trueName,
    })),
    attempts: story.attempts.map((attempt) => ({
      id: attempt.id,
      seat: attempt.seat,
      targetSquare: attempt.targetSquare,
      targetPieceId: attempt.targetPieceId,
      name: attempt.name,
      success: attempt.success,
      at: attempt.at,
    })),
    events: publicState.events,
    lastAction: publicState.lastAction,
    eraseUsedAtPly: story.eraseUsedAtPly,
    note: '私密名称表只允许女神读取；玩家与 AI 队友投影不得包含本字段。',
  };
}

function setName(story, square, trueName, alias) {
  if (!story || !story.enabled) return null;
  const piece = identityLib.pieceAt(story.identity, square);
  if (!piece) return null;
  return identityLib.setName(story.identity, square, trueName, alias);
}

function isEraseAbility(story, seat) {
  return Boolean(story && story.enabled && story.abilities[seat] === ABILITY_ERASE);
}

function nameMatches(piece, name) {
  if (!piece || !piece.trueName) return false;
  return identityLib.normalizeName(piece.trueName) === identityLib.normalizeName(name);
}

function normalizeName(value) {
  return identityLib.normalizeName(value);
}

module.exports = {
  ABILITY_OPEN_SOURCE,
  ABILITY_ERASE,
  ABILITIES,
  DEFAULT_POOL_TYPES,
  createStoryState,
  cloneStory,
  publicView,
  playerView,
  goddessView,
  setName,
  isEraseAbility,
  nameMatches,
  normalizeName,
  retirePiece,
  recordPoolUse,
  recordEraseAttempt,
  addPoolType,
};
