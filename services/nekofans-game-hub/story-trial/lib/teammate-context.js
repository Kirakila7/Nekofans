'use strict';

/*
 * A 方大肥鱼的严格白名单上下文。
 *
 * 输入只能是 room.teammateView() 的 seat-safe 投影；本模块再显式挑选字段，
 * 不把 roomId/token/对手规则/真名/女神字段/私密尝试带进模型上下文。
 * 公开棋谱和事件必须已经是中性投影；这里只做字段级白名单，不做二次解释。
 */

const PROTOCOL = 'nekofans.game-player.v1';
const OUTPUT_SCHEMA = 'nekofans.game-player.decision.v1';

function clone(value) {
  return value === undefined ? null : JSON.parse(JSON.stringify(value));
}

function buildTeammateContext(view, requestId) {
  if (!view || !view.own || !view.public) throw new Error('seat-safe view required');
  const own = view.own;
  const pub = view.public;
  const normal = (Array.isArray(own.standardMoves) ? own.standardMoves : []).map((move, index) => ({
    id: 'normal:' + (index + 1),
    kind: 'move',
    from: move.from,
    to: move.to,
    promotion: move.promotion || null,
  }));
  const special = (Array.isArray(own.specialActions) ? own.specialActions : []).map((action, index) => ({
    id: 'special:' + (index + 1),
    kind: 'special',
    type: action.type,
    label: action.label || null,
    from: action.from,
    to: action.to,
    promotion: action.promotion || null,
  }));
  const publicResult = pub.result
    ? {
        winner: pub.result.winner,
        reason: pub.result.reason,
        automatic: Boolean(pub.result.automatic),
      }
    : null;
  const story = pub.story || null;
  return {
    protocol: PROTOCOL,
    requestId: requestId || null,
    roomVersion: view.version,
    seat: 'white',
    team: 'A',
    phase: view.phase,
    turn: view.turn,
    own: {
      rule: own.rule || null,
      guesses: clone(own.guesses || []),
      abilityLabel: own.abilityLabel || null,
      abilityHelp: own.abilityHelp || null,
    },
    public: {
      fen: pub.fen,
      turn: pub.turn,
      phase: pub.phase,
      inCheck: Boolean(pub.inCheck),
      checkmate: Boolean(pub.checkmate),
      stalemate: Boolean(pub.stalemate),
      draw: Boolean(pub.draw),
      result: publicResult,
      lastMove: clone(pub.lastMove),
      moves: clone(pub.moves || []),
      special: story ? clone(story.special || []) : [],
      events: story ? clone(story.events || []) : [],
    },
    actions: {
      normal,
      special,
      guess: {
        allowed: Boolean(own.canGuess),
        attemptsLeft: own.attemptsLeft,
        maxLength: 300,
      },
    },
    output: {
      schema: OUTPUT_SCHEMA,
      choices: [
        '{"kind":"move","actionId":"normal:N"}',
        '{"kind":"special","actionId":"special:N"}',
        '{"kind":"guess","text":"..."}',
      ],
      rule: '必须从 actions 选择 actionId，或提出不超过 300 字的猜测；不得输出其他字段/代码。',
    },
  };
}

function actionMap(context) {
  const map = new Map();
  for (const action of context.actions.normal) map.set(action.id, action);
  for (const action of context.actions.special) map.set(action.id, action);
  return map;
}

function validateDecision(decision, context) {
  if (!decision || typeof decision !== 'object' || Array.isArray(decision)) {
    return { ok: false, code: 'bad_decision', message: '模型输出必须是对象' };
  }
  if (decision.kind === 'guess') {
    if (!context.actions.guess.allowed) {
      return { ok: false, code: 'guess_not_allowed', message: '当前不允许猜测' };
    }
    const text = typeof decision.text === 'string' ? decision.text.trim() : '';
    if (!text || text.length > 300) {
      return { ok: false, code: 'bad_guess', message: '猜测必须为 1–300 字' };
    }
    return { ok: true, action: { kind: 'guess', text } };
  }
  if (decision.kind !== 'move' && decision.kind !== 'special') {
    return { ok: false, code: 'bad_decision_kind', message: '只允许 move/special/guess' };
  }
  if (typeof decision.actionId !== 'string') {
    return { ok: false, code: 'bad_action_id', message: '缺少合法 actionId' };
  }
  const action = actionMap(context).get(decision.actionId);
  if (!action || action.kind !== decision.kind) {
    return { ok: false, code: 'illegal_action', message: '动作不在服务端给出的合法列表' };
  }
  return { ok: true, action: { ...action } };
}

module.exports = { PROTOCOL, OUTPUT_SCHEMA, buildTeammateContext, validateDecision };
