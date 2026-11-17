'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const {
  PURPOSE_PLAYER,
  PURPOSE_GODDESS,
  createTeammateAdapter,
  createGoddessAdapter,
} = require('../lib/teammate-adapter.js');

const CTX = {
  protocol: 'nekofans.game-player.v1',
  roomVersion: 3,
  actions: { normal: [{ id: 'normal:1' }] },
};

async function listen(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  return {
    server,
    endpoint: 'http://127.0.0.1:' + address.port + '/decide',
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

test('默认适配器未接入；A/Goddess 用途独立', async () => {
  const a = createTeammateAdapter();
  assert.equal(a.purpose, PURPOSE_PLAYER);
  assert.equal(a.status().available, false);
  assert.equal(a.status().mode, 'unavailable');
  assert.match(a.status().label, /未接入真实模型/);
  await assert.rejects(() => a.decide(CTX), /未接入真实模型/);

  const g = createGoddessAdapter();
  assert.equal(g.purpose, PURPOSE_GODDESS);
  assert.equal(g.status().available, false);
  assert.match(g.status().label, /女神决策适配器未接入/);
  assert.notEqual(g.purpose, a.purpose);
});

test('合成适配器可用，但明确标注未接真实模型；超时可中断', async () => {
  const a = createTeammateAdapter({
    mode: 'synthetic',
    decision: { kind: 'move', actionId: 'normal:1' },
  });
  assert.equal(a.status().available, true);
  assert.match(a.status().label, /合成适配器/);
  assert.match(a.status().label, /未接真实模型/);
  assert.deepEqual(await a.decide(CTX), { kind: 'move', actionId: 'normal:1' });

  const never = createTeammateAdapter({
    mode: 'synthetic',
    decision: ({ signal }) => new Promise((resolve, reject) => {
      if (signal.aborted) return reject(new Error('aborted'));
      signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    }),
  });
  const controller = new AbortController();
  const pending = never.decide(CTX, { signal: controller.signal });
  controller.abort();
  await assert.rejects(() => pending, /中断/);
});

test('合成适配器并发/调用次数限制', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const a = createTeammateAdapter({
    mode: 'synthetic',
    maxConcurrent: 1,
    maxCalls: 2,
    decision: async () => { await gate; return { kind: 'move', actionId: 'normal:1' }; },
  });
  const first = a.decide(CTX);
  await assert.rejects(() => a.decide(CTX), /正在处理/);
  release();
  await first;
  await a.decide(CTX);
  await assert.rejects(() => a.decide(CTX), /调用次数/);
});

test('真实本地 HTTP 适配器：成功、上下文、未验证账号和异常', async () => {
  let received = null;
  let callCount = 0;
  const fake = await listen((req, res) => {
    callCount += 1;
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      received = JSON.parse(body);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ decision: { kind: 'move', actionId: 'normal:1' } }));
    });
  });
  try {
    const a = createTeammateAdapter({
      mode: 'http',
      endpoint: fake.endpoint,
      accountConnected: true,
      timeoutMs: 1000,
    });
    assert.equal(a.status().available, true);
    assert.deepEqual(await a.decide(CTX, { requestId: 'req-1' }), { kind: 'move', actionId: 'normal:1' });
    assert.equal(received.protocol, 'nekofans.model-adapter.v1');
    assert.equal(received.purpose, PURPOSE_PLAYER);
    assert.equal(received.requestId, 'req-1');
    assert.equal(received.context.roomVersion, 3);
    assert.equal(callCount, 1);

    const unverified = createTeammateAdapter({
      mode: 'http',
      endpoint: fake.endpoint,
      accountConnected: false,
    });
    assert.equal(unverified.status().available, false);
    assert.match(unverified.status().label, /未接入真实账号/);
    await assert.rejects(() => unverified.decide(CTX), /未接入真实账号/);
    assert.equal(callCount, 1, '未验证账号时不得真实发请求');
  } finally {
    await fake.close();
  }
});

test('HTTP 适配器拒绝非本机 endpoint，默认不访问外网', () => {
  const external = createTeammateAdapter({
    mode: 'http',
    endpoint: 'https://example.com/decide',
    accountConnected: true,
  });
  assert.equal(external.status().available, false);
  assert.match(external.status().label, /配置无效/);

  const badHost = createTeammateAdapter({
    mode: 'http',
    endpoint: 'http://192.168.1.10:9000/decide',
    accountConnected: true,
  });
  assert.equal(badHost.status().available, false);
});

test('HTTP 适配器超时与错误响应不产生决策', async () => {
  const slow = await listen((_req, res) => {
    setTimeout(() => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"decision":{"kind":"move","actionId":"normal:1"}}');
    }, 250);
  });
  try {
    const a = createTeammateAdapter({
      mode: 'http',
      endpoint: slow.endpoint,
      accountConnected: true,
      timeoutMs: 50,
    });
    await assert.rejects(() => a.decide(CTX), /超时/);
  } finally {
    await slow.close();
  }

  const broken = await listen((_req, res) => {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end('{"error":"bridge down"}');
  });
  try {
    const a = createTeammateAdapter({
      mode: 'http',
      endpoint: broken.endpoint,
      accountConnected: true,
      timeoutMs: 500,
    });
    await assert.rejects(() => a.decide(CTX), /HTTP 500/);
  } finally {
    await broken.close();
  }
});
