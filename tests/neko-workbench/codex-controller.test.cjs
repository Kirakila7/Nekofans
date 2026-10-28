'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createCodexController } = require('../../apps/neko-workbench/codex-controller.cjs');

function setup() {
  let onEvent, created = 0; const calls = [], events = [];
  const adapter = {
    createSession: async ({ cwd }) => { calls.push(['create', cwd]); return { threadId: 'thread-' + ++created }; },
    sendMessage: async p => { calls.push(['send', p]); return { turnId: 'turn-1' }; },
    cancel: async p => calls.push(['cancel', p]),
    respondApproval: p => calls.push(['approval', p]),
    dispose: () => calls.push(['dispose'])
  };
  const controller = createCodexController({
    resolveWorkspace: async id => id === 'registered' ? { workspaceId: id, path: '/private/tmp' } : null,
    adapterFactory: options => { onEvent = options.onEvent; return adapter; },
    publish: event => events.push(event)
  });
  return { controller, calls, events, emit: event => onEvent(event) };
}

test('only the DSH registry grants a project directory', async () => {
  const { controller, calls } = setup();
  await assert.rejects(controller.start({ workspaceId: 'unknown', path: '/' }), /无法验证/);
  await assert.rejects(controller.start({ workspaceId: 'registered', path: '/' }), /不匹配/);
  assert.equal(calls.length, 0);
  assert.deepEqual(await controller.start({ workspaceId: 'registered', path: '/private/tmp' }), { threadId: 'thread-1' });
  assert.equal(calls[0][1], '/private/tmp');
  assert.deepEqual(await controller.start({ workspaceId: 'registered' }), { threadId: 'thread-1' });
  assert.equal(calls.length, 1);
  controller.dispose();
});

test('sends and cancels the selected session and routes only its events', async () => {
  const { controller, calls, events, emit } = setup();
  await controller.start({ workspaceId: 'registered' });
  assert.deepEqual(await controller.send({ text: 'hello' }), { turnId: 'turn-1' });
  emit({ type: 'delta', threadId: 'other', delta: 'private' });
  emit({ type: 'delta', threadId: 'thread-1', turnId: 'turn-1', delta: 'hello' });
  assert.equal(events.length, 1);
  assert.equal(events[0].workspaceId, 'registered');
  await assert.rejects(controller.start({ workspaceId: 'registered' }), /正在处理/);
  await controller.cancel();
  assert.deepEqual(calls.at(-1), ['cancel', { threadId: 'thread-1', turnId: 'turn-1' }]);
  emit({ type: 'turn-completed', threadId: 'thread-1', turnId: 'turn-1', status: 'interrupted' });
  await assert.rejects(controller.cancel(), /没有可停止/);
  controller.dispose();
});

test('only a real approval for the active thread can be answered', async () => {
  const { controller, calls, emit } = setup();
  await controller.start({ workspaceId: 'registered' });
  assert.throws(() => controller.approval({ requestId: 'x', decision: 'accept' }), /不存在/);
  emit({ type: 'approval-request', threadId: 'thread-1', turnId: 'turn-1', requestId: 'x' });
  assert.deepEqual(controller.approval({ requestId: 'x', decision: 'decline' }), { accepted: true });
  assert.deepEqual(calls.at(-1), ['approval', { requestId: 'x', decision: 'decline' }]);
  assert.throws(() => controller.approval({ requestId: 'x', decision: 'accept' }), /不存在/);
  controller.dispose();
});
