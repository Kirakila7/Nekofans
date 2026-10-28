'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { chatReply, FORMAT_ERROR, CHAT_PROMPT } = require('../../apps/neko-workbench/vendor/dsh-qqbot-workbench/chat-policy.cjs');
test('QQ rejects protocol invocations while preserving ordinary chat and code explanations', () => {
  for (const text of ['<｜｜DSML｜｜ calls>payload','<||DSML|| invoke name="bash">payload','</｜｜DSML｜｜ parameter>','<tool_call>payload','<function_calls>payload']) assert.equal(chatReply(text),FORMAT_ERROR);
  for (const text of ['QQ连接成功','DSML 是一种内部标记。','命令示例：ls -la']) assert.equal(chatReply(text),text);
  assert(CHAT_PROMPT.includes('======以上为'));
});
