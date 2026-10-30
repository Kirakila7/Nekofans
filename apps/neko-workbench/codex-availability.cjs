'use strict';

// Re-enable only when the native Codex integration is ready for daily use.
const CODEX_AVAILABLE = false;
const CODEX_TESTING_MESSAGE = 'Codex 测试中，暂不可用';

function assertCodexActionAllowed(action, available = CODEX_AVAILABLE) {
  if (!available && (['codex-read', 'codex-send', 'codex-model-choice', 'choose-project'].includes(action))) {
    throw Error(CODEX_TESTING_MESSAGE);
  }
}

module.exports = { CODEX_AVAILABLE, CODEX_TESTING_MESSAGE, assertCodexActionAllowed };
