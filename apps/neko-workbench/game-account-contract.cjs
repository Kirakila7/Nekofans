'use strict';

// Two roles may use the same authenticated model owner, but never the same
// conversation, in-flight request lock or cancellation namespace. The trusted
// host supplies these bindings; a persona prompt cannot grant another role.
//
// Purposes are explicit: a conversation ID identifies exactly one job and one
// persona whitelist entry, so a caller cannot reuse the teammate route for the
// goddess job (or vice versa) by relabeling its prompt. The local prototype
// bridge has its own dedicated entries below instead of borrowing the room /
// rule-compiler / studio purposes.
const gameNamespaces = Object.freeze(['game', 'game-player', 'game-studio']);
const privateGamePurposes = Object.freeze({
  'private-game-rule-compiler': 'private-game-rules',
  'private-game-prototype-goddess': 'private-game-prototype-rules',
});
const goddessPersonas = Object.freeze(Object.keys(privateGamePurposes));
const gamePlayerConversations = Object.freeze(['private-game-turn', 'private-game-prototype-turn']);

function assertGameAccountInput(namespace, input) {
  if (!gameNamespaces.includes(namespace)) return;
  const messages = input.messages, persona = input.persona;
  const fail = () => { throw Error('Private game context is invalid'); };
  if (!Array.isArray(messages) || messages.length !== 1 || !persona || typeof persona.id !== 'string' || !persona.id.trim()) fail();
  const message = messages[0];
  if (!message || message.role !== 'user' || message.personaId !== persona.id || typeof message.text !== 'string') fail();
  if (message.images !== undefined && (!Array.isArray(message.images) || message.images.length)) fail();
  for (const key of ['memories', 'summaries', 'memoryContext']) {
    if (input[key] !== undefined && (!Array.isArray(input[key]) || input[key].length)) fail();
  }
  if (namespace === 'game-player') {
    if (!gamePlayerConversations.includes(message.conversationId) || goddessPersonas.includes(persona.id) || persona.id==='game-studio') fail();
  } else if (namespace === 'game-studio') {
    if (persona.id !== 'game-studio' || message.conversationId !== 'private-game-draft') fail();
  } else {
    const expected = Object.hasOwn(privateGamePurposes,persona.id) && privateGamePurposes[persona.id];
    if (!expected || message.conversationId !== expected) fail();
  }
}

module.exports = { gameNamespaces, privateGamePurposes, goddessPersonas, gamePlayerConversations, assertGameAccountInput };
