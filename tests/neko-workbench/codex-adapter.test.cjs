'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { PassThrough } = require('node:stream');
const { EventEmitter } = require('node:events');
const { createCodexAdapter, findCodexCommand } = require('../../apps/neko-workbench/codex-adapter.cjs');

test('finds Codex in the user installation for GUI launches and falls back to PATH', () => {
  const accessed = [], present = new Set(['/Users/example/.local/bin/codex']);
  const fsApi = {
    constants: { X_OK: 1 },
    accessSync: (candidate, mode) => { accessed.push(candidate); assert.equal(mode, 1); if (!present.has(candidate)) throw new Error('not executable'); },
    statSync: () => ({ isFile: () => true })
  };
  const options = { env: { PATH: '' }, homeDir: '/Users/example', platform: 'darwin', fsApi };
  assert.equal(findCodexCommand(options), '/Users/example/.local/bin/codex');
  present.clear(); present.add('/custom/bin/codex');
  assert.equal(findCodexCommand({ ...options, env: { PATH: '/custom/bin:relative/bin' } }), '/custom/bin/codex');
  present.clear(); present.add('relative/bin/codex');
  assert.equal(findCodexCommand({ ...options, env: { PATH: 'relative/bin' } }), '/Users/example/.local/bin/codex');
  assert(!accessed.some(candidate => candidate.includes('auth') || candidate.includes('credential')));
});

function fakeServer({ resumeCwd = '/private/tmp', failTurn = false, accountResult = { account: null, requiresOpenaiAuth: true } } = {}) {
  const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.stdin = new PassThrough(); child.kill = () => { child.emit('close', 0); return true; };
  const requests = [], responses = [];
  child.notify = message => child.stdout.write(JSON.stringify(message) + '\n');
  let buffer = '';
  child.stdin.on('data', data => {
    buffer += data;
    let end;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const msg = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
      if (!msg.method) { responses.push(msg); continue; }
      requests.push(msg);
      if (!Object.hasOwn(msg, 'id')) continue;
      let result = {};
      if (msg.method === 'thread/start') result = { thread: { id: 'test-thread' }, cwd: msg.params.cwd };
      if (msg.method === 'thread/read') result = { thread: { cwd: resumeCwd } };
      if (msg.method === 'thread/resume') result = { thread: { id: msg.params.threadId } };
      if (msg.method === 'turn/start') result = { turn: { id: 'test-turn' } };
      if (msg.method === 'account/read') result = accountResult;
      if (msg.method === 'turn/start' && failTurn) child.notify({ id: msg.id, error: { message: 'login required' } });
      else child.notify({ id: msg.id, result });
    }
  });
  return { child, requests, responses };
}

test('projects real account responses without leaking account data', async () => {
  for (const [input, expected] of [
    [{ account: { type: 'chatgpt', email: 'private@example.test', token: 'secret', planType: 'plus' }, requiresOpenaiAuth: true }, { status: 'signed-in', source: 'chatgpt' }],
    [{ account: null, requiresOpenaiAuth: true }, { status: 'signed-out', source: null }],
    [{ account: { type: 'apiKey', token: 'secret' }, requiresOpenaiAuth: true }, { status: 'unsupported', source: null, message: '当前 Codex 使用其他认证方式' }],
    [{ account: { type: 'amazonBedrock' }, requiresOpenaiAuth: false }, { status: 'unsupported', source: null, message: '当前 Codex 使用其他认证方式' }],
    [{ account: null, requiresOpenaiAuth: false }, { status: 'unknown', source: null, message: '无法确定 Codex 登录状态' }],
    [{ account: { type: 'other' }, requiresOpenaiAuth: false }, { status: 'unknown', source: null, message: '无法识别 Codex 认证方式' }],
  ]) {
    const server = fakeServer({ accountResult: input }); const events = [];
    const adapter = createCodexAdapter({ spawnProcess: () => server.child, onEvent: event => events.push(event) });
    assert.deepEqual(await adapter.readAccount(), expected);
    assert.deepEqual(server.requests.find(req => req.method === 'account/read').params, { refreshToken: false });
    server.child.notify({ method: 'account/updated', params: { authMode: 'chatgpt', email: 'private@example.test', token: 'secret' } });
    assert.deepEqual(events.at(-1), { type: 'account-changed' });
    assert(!JSON.stringify(events).includes('secret'));
    adapter.dispose();
  }
});

test('account refresh retries after an app-server exits', async () => {
  const first = fakeServer(), second = fakeServer({ accountResult: { account: { type: 'chatgpt' }, requiresOpenaiAuth: true } });
  let calls = 0;
  const adapter = createCodexAdapter({ spawnProcess: () => (++calls === 1 ? first.child : second.child) });
  assert.equal((await adapter.readAccount()).status, 'signed-out');
  first.child.emit('close', 0);
  assert.deepEqual(await adapter.readAccount(), { status: 'signed-in', source: 'chatgpt' });
  assert.equal(calls, 2);
  adapter.dispose();
});

test('real protocol routing, streaming, cancellation and explicit approval', async () => {
  const server = fakeServer(); const events = [];
  const adapter = createCodexAdapter({ spawnProcess: () => server.child, onEvent: e => events.push(e) });
  const { threadId } = await adapter.createSession({ cwd: '/private/tmp' });
  assert.equal(threadId, 'test-thread');
  assert.deepEqual(server.requests.map(r => r.method).slice(0, 3), ['initialize', 'initialized', 'thread/start']);
  assert.equal(server.requests[2].params.sandbox, 'workspace-write');
  assert.equal(server.requests[2].params.approvalPolicy, 'on-request');
  const { turnId } = await adapter.sendMessage({ threadId, text: 'hello' });
  assert.equal(turnId, 'test-turn');
  server.child.notify({ method: 'item/agentMessage/delta', params: { threadId, turnId, itemId: 'm1', delta: 'hi' } });
  server.child.notify({ method: 'item/agentMessage/delta', params: { threadId: 'another-thread', delta: 'private' } });
  server.child.notify({ id: 99, method: 'item/commandExecution/requestApproval', params: { threadId, turnId, command: 'ls', reason: 'needs access' } });
  assert.equal(events.find(e => e.type === 'delta').delta, 'hi');
  assert.equal(events.filter(e => e.type === 'delta').length, 1);
  assert.equal(events.find(e => e.type === 'approval-request').command, 'ls');
  adapter.respondApproval({ requestId: '99', decision: 'decline' });
  assert.deepEqual(server.responses.at(-1), { id: 99, result: { decision: 'decline' } });
  server.child.notify({ method: 'turn/completed', params: { threadId, turn: { id: turnId, status: 'failed', error: { message: 'login required' } } } });
  assert.equal(events.find(e => e.type === 'turn-completed').status, 'failed');
  await adapter.cancel({ threadId, turnId });
  assert.deepEqual(server.requests.at(-1).params, { threadId, turnId });
  assert.throws(() => adapter.respondApproval({ requestId: '99', decision: 'accept' }));
  adapter.dispose();
});

test('unhandled approval expires with decline and unknown requests are rejected', async () => {
  const server = fakeServer();
  const adapter = createCodexAdapter({ spawnProcess: () => server.child, approvalTimeoutMs: 10 });
  await adapter.createSession({ cwd: '/private/tmp' });
  server.child.notify({ id: 13, method: 'item/fileChange/requestApproval', params: { threadId: 'test-thread' } });
  server.child.notify({ id: 14, method: 'account/chatgptAuthTokens/refresh', params: {} });
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.deepEqual(server.responses.find(r => r.id === 13).result, { decision: 'decline' });
  assert.equal(server.responses.find(r => r.id === 14).error.code, -32601);
  adapter.dispose();
});

test('resume checks selected project; failure is not reported as success', async () => {
  const server = fakeServer({ resumeCwd: '/' });
  const adapter = createCodexAdapter({ spawnProcess: () => server.child });
  await assert.rejects(adapter.resumeSession({ cwd: '/private/tmp', threadId: 'other' }), /不匹配/);
  assert.equal(server.requests.some(r => r.method === 'thread/resume'), false);
  await assert.rejects(adapter.sendMessage({ threadId: 'other', text: 'hello' }), /不属于/);
  adapter.dispose();
  const failed = fakeServer({ failTurn: true });
  const adapter2 = createCodexAdapter({ spawnProcess: () => failed.child });
  await adapter2.createSession({ cwd: '/private/tmp' });
  await assert.rejects(adapter2.sendMessage({ threadId: 'test-thread', text: 'hello' }), /login required/);
  adapter2.dispose();
});
