import { createRequire } from 'node:module';
const chess = createRequire(import.meta.url)('./standard-trial/chess-core.cjs');

// Transport is supplied by the trusted host and must authenticate each seat.
// readState returns {ready,decisionRequired,actions}; submitMove must atomically enforce seat,
// legality and expectedVersion. This does not run a server or read credentials.
export function createChessMatchAdapter({ transport, getOwnPrivateContext } = {}) {
  if (!transport || typeof transport.readState !== 'function' || typeof transport.submitMove !== 'function') throw TypeError('seat-authenticated transport required');
  if (getOwnPrivateContext !== undefined && typeof getOwnPrivateContext !== 'function') throw TypeError('invalid private context provider');
  return Object.freeze({
    async readView({ seat, signal }) {
      const result = await transport.readState({ seat, signal });
      if (!result || !Array.isArray(result.actions) || result.actions.length > 300) throw Error('invalid chess room');
      const replay = chess.replayActions(result.actions);
      if (replay.rejected.length || replay.applied.length !== result.actions.length) throw Error('invalid chess history');
      const ownPrivateContext = getOwnPrivateContext ? await getOwnPrivateContext({ seat, signal }) : undefined;
      return { game: 'chess', version: result.actions.length,
        status: result.decisionRequired ? 'decision-required' : !result.ready ? 'waiting' : replay.status.over ? 'finished' : 'active',
        turn: replay.state.turn === 'w' ? 0 : 1,
        publicState: { fen: chess.toFen(replay.state), actions: result.actions.map(({ seat: player, action }) => ({ seat: player, action })), inCheck: replay.status.inCheck },
        legalActions: replay.status.legalMoves.map(chess.moveToUci), ownPrivateContext };
    },
    async submit({ seat, expectedVersion, action, signal }) {
      return transport.submitMove({ seat, expectedVersion, action, signal });
    },
  });
}
