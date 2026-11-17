'use strict';

const DEFAULT_GAME = 'chess';
const STUDIO_GAME = 'studio';
const games = Object.freeze({
  chess: Object.freeze({
    id: 'chess', title: '双人国际象棋', sides: ['白方', '黑方'], teammate: true, customRules: true,
    preset: { choices: [['p', '兵'], ['n', '马'], ['b', '象'], ['r', '车'], ['q', '后']], turns: [1, 2, 3] },
    accepts: value => /^[a-h][1-8][a-h][1-8][qrbn]?$/.test(value),
  }),
  'tic-tac-toe': Object.freeze({
    id: 'tic-tac-toe', title: '井字棋', sides: ['X 方', 'O 方'], teammate: false, customRules: false,
    preset: { choices: [['center', '中央格'], ['corners', '角落格']], turns: [1] },
    accepts: value => /^[0-8]$/.test(value),
  }),
  [STUDIO_GAME]: Object.freeze({
    id: STUDIO_GAME, title: '创造台作品', sides: ['甲方', '乙方'], teammate: false, customRules: false,
    preset: {choices: [['none', '不追加限制'], ['first', '对方首回合不能选第一项'], ['last', '对方首回合不能选最后一项']], turns: [1]},
    accepts: value => /^[0-3]$/.test(value),
  }),
});

const getGame = id => typeof id === 'string' && Object.hasOwn(games, id) ? games[id] : null;
const gameInfo = id => {
  const game = getGame(id);
  if (!game) return null;
  const { accepts, ...info } = game;
  return info;
};
const acceptsAction = (id, value) => typeof value === 'string' && getGame(id)?.accepts(value) === true;

module.exports = { DEFAULT_GAME, STUDIO_GAME, getGame, gameInfo, acceptsAction,
  listGames: () => Object.keys(games).filter(id => id !== STUDIO_GAME).map(gameInfo) };
