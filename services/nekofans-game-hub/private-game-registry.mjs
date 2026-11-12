import catalog from './game-catalog.cjs';
import {createPrivateChessRoom} from './private-chess-room.mjs';
import {privateChessBoard} from './private-chess-board.mjs';
import {createGridRoom, gridBoard} from './private-grid-room.mjs';
import {createStudioRoom, studioBoard, validateStudioGame} from './studio-game.mjs';

const engines = Object.freeze({
  chess: {createRules:createPrivateChessRoom, html:privateChessBoard, maxActions:300},
  'tic-tac-toe': {createRules:createGridRoom, html:gridBoard, maxActions:9},
});

export function gameAdapter(id = catalog.DEFAULT_GAME, definition) {
  const info = catalog.gameInfo(id);
  if (id === catalog.STUDIO_GAME) {
    const game = validateStudioGame(definition);
    if (!game) return null;
    return {info: {...info, title: game.title}, definition: game, html: studioBoard(game),
      maxActions: game.nodes.length - 1, createRules: () => createStudioRoom(game)};
  }
  return info ? {...engines[id], info} : null;
}
