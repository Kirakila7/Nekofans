const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { migrateChatRouting } = require('../../apps/neko-workbench/chat-routing.cjs');
const { companionSnapshot } = require('../../apps/neko-workbench/workspace-controller.cjs');
const plugin = '../../apps/neko-workbench/vendor/dsh-bili-whale/lib/';

test('an existing plugin role keeps its session and accepts only its own reply', async t => {
  const { createRoleChat } = await import(plugin + 'role-chat.js');
  const { createSessionDelivery } = await import(plugin + 'session-delivery.js');
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'neko-role-test-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(profile)), path.resolve(os.tmpdir()));
    fs.rmSync(profile, { recursive: true, force: true });
  });
  const sessionId = 'original-plugin-role';
  fs.writeFileSync(path.join(profile, 'whale-session.json'), JSON.stringify({ id: sessionId, startedAt: 1 }));
  const events = new EventEmitter();
  let turn = 0, creates = 0;
  const controller = {
    async resolveAgent(id) { assert.equal(id, sessionId); return { agent: {} }; },
    async create() { creates++; },
    async selectModel(route) { assert.equal(route.sessionId, sessionId); },
    async prompt(request) {
      assert.equal(request.sessionId, sessionId);
      assert.match(request.content[0].text, /原角色人设/);
      const send = (id, type, data) => events.emit('event', { header: { id } }, { type, data });
      const message = text => ({ content: [{ type: 'text', text }] });
      const number = ++turn;
      send(sessionId, 'turn/start', { turn: number });
      send(sessionId, 'user/message', { source: { rpcId: request.requestId }, turn: number });
      send('unrelated-session', 'assistant/message', { turn: number, message: message('其他角色') });
      send(sessionId, 'assistant/message', { turn: number - 1, message: message('之前的任务') });
      send(sessionId, 'assistant/message', { turn: number, message: message('记得蓝色灯塔') });
      send(sessionId, 'turn/end', { turn: number, reason: { kind: 'completed' } });
    },
  };
  function open() {
    const delivery = createSessionDelivery({
      controller, dshHome: profile, cwd: profile, sessionId: 'unused-default',
      config: () => ({ personaOncePerSession: true }), persona: () => '原角色人设',
      route: { provider: 'fixture', model: 'fixture' },
    });
    return createRoleChat({
      signal: new AbortController().signal,
      subscribe(handler) { events.on('event', handler); return () => events.off('event', handler); },
      deliver: (request, signal, beforePrompt) => delivery.send(request, signal, { beforePrompt, requireExisting: true }),
    });
  }
  assert.deepEqual(await open()('记得什么？'), { text: '记得蓝色灯塔' });
  assert.deepEqual(await open()('重启后还记得吗？'), { text: '记得蓝色灯塔' });
  assert.equal(creates, 0);
  assert.equal(events.listenerCount('event'), 0);
  controller.resolveAgent = async () => ({ error: { code: 'session/not-found' } });
  await assert.rejects(open()('重新连接'), error => error.code === 'SESSION_UNAVAILABLE');
  assert.equal(creates, 0);
});

test('a persisted DSH role stays selected and waits for its plugin when stopped', () => {
  const state = { connection: 'ready', fish: { phase: 'paused' },
    dshRole: { id: 'original', name: '旧角色' }, actors: [{ id: 'main', chatBackend: 'dsh-role', messages: [] }] };
  migrateChatRouting(state);
  assert.equal(companionSnapshot(state).backend, 'dsh-role');
  assert.equal(companionSnapshot(state).name, '旧角色');
  assert.equal(companionSnapshot(state).ready, false);
  state.fish.phase = 'running';
  assert.equal(companionSnapshot(state).ready, true);
});
