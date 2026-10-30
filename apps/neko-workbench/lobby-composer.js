// Renderer-only lobby draft state: text, reply target, the 人＋AI marker and the
// replace undo snapshot. Nothing here leaves the renderer except the payload
// returned by sendPayload(). Pure functions over plain objects; usable from the
// embedded shell (globalThis.WorkbenchLobbyComposer) and from node tests.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.WorkbenchLobbyComposer = api;
})(globalThis, function () {
  'use strict';
  const MAX = 2000;
  const cut = text => Array.from(String(text ?? '')).slice(0, MAX).join('');

  function create() {
    return Object.freeze({ text: '', replyToId: null, assistCatId: null, draftEpoch: 0, undo: null, pendingAdopt: null });
  }
  const next = (state, patch) => Object.freeze({ ...state, ...patch });

  /** User typing. Clearing the draft removes the marker, undo and pending choice, and starts a new epoch. */
  function edit(state, text) {
    const value = cut(text);
    if (!value.trim()) return next(state, { text: value, assistCatId: null, undo: null, pendingAdopt: null, draftEpoch: state.draftEpoch + 1 });
    return next(state, { text: value, undo: null });
  }
  /** Change the reply target. A new target is a new draft epoch, voiding unadopted cards. */
  function setReplyTarget(state, messageId) {
    const id = typeof messageId === 'string' && messageId ? messageId : null;
    if (id === state.replyToId) return state;
    return next(state, { replyToId: id, draftEpoch: state.draftEpoch + 1 });
  }
  /**
   * Adopt a ready suggestion card ({text, targetId}) from a cat with catId.
   * Empty draft: fill it in. Non-empty: wait for chooseAdopt('replace' | 'append').
   */
  function adopt(state, card, catId) {
    if (!card || typeof card.text !== 'string' || !card.text.trim() || typeof catId !== 'string' || !catId) return state;
    const offer = { text: card.text, targetId: typeof card.targetId === 'string' ? card.targetId : null, catId };
    if (!state.text.trim()) return apply(state, offer, cut(offer.text), null);
    return next(state, { pendingAdopt: offer });
  }
  function apply(state, offer, text, undo) {
    return next(state, { text, assistCatId: offer.catId, replyToId: offer.targetId ?? state.replyToId, undo, pendingAdopt: null });
  }
  function chooseAdopt(state, choice) {
    const offer = state.pendingAdopt;
    if (!offer) return state;
    if (choice === 'replace') return apply(state, offer, cut(offer.text), { text: state.text, assistCatId: state.assistCatId, replyToId: state.replyToId });
    if (choice === 'append') return apply(state, offer, cut(state.text.replace(/\s+$/, '') + '\n' + offer.text), null);
    return next(state, { pendingAdopt: null });
  }
  function undoReplace(state) {
    if (!state.undo) return state;
    return next(state, { text: state.undo.text, assistCatId: state.undo.assistCatId, replyToId: state.undo.replyToId, undo: null });
  }
  /** Mode changes void cards in the main process; the user's adopted draft stays as is. */
  function modeChanged(state) { return next(state, { pendingAdopt: null }); }

  /** Origin is decided here, at send time, from the marker alone. */
  function sendPayload(state) {
    const text = state.text.trim();
    if (!text) return null;
    return { text: cut(text), replyToId: state.replyToId,
      ...(state.assistCatId ? { origin: 'human_ai', assistCatId: state.assistCatId } : { origin: 'human' }) };
  }
  /** After the outbox accepted the message. */
  function sent(state) { return next(create(), { draftEpoch: state.draftEpoch + 1 }); }

  return Object.freeze({ MAX, create, edit, setReplyTarget, adopt, chooseAdopt, undoReplace, modeChanged, sendPayload, sent });
});
